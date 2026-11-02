"""Voicebox's GPU on Cerebrium: the same worker as Colab and Modal, behind one address, asleep until a job wakes it.

  python voicebox_cerebrium.py serve                          # what cerebrium.toml runs in the container
  python3 voicebox_cerebrium.py connect <key> <studio> <log>  # the last setup step, on your machine: tells the studio
                                                              # the address `cerebrium deploy` printed into <log>

It starts the newest worker code from the studio (/api/bundle; the last one fetched, on /persistent-storage, when the
studio can't be reached), beats to the studio every minute while awake (that time counts toward the monthly cap, and
the answer can say Stop), keeps itself awake while a job runs, and if the start fails answers every request with why
(HTTP 424), so the studio's Test shows it. The key and the studio's address come from voicebox.env (deployed with the
app by the setup) or the environment.
"""
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = "/persistent-storage/voicebox"  # kept between starts: engines, weights, the last worker code
CODE = "/tmp/voicebox-worker"
SAVED = f"{HOME}/app"
PORT = 8000
MAX_BUSY_H = float(os.environ.get("VOICEBOX_CLOUD_MAX_BUSY_H", "4"))  # a job that runs longer is let go (the cap's backstop)
UA = "voicebox-worker-cerebrium"  # Cloudflare refuses Python's own user agent (error 1010)


def log(*a):
    print(time.strftime("%H:%M:%S"), "[voicebox-cerebrium]", *a, flush=True)


def ssl_context():
    try:
        import certifi
        import ssl
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def request(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET", headers={"User-Agent": UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout, context=ssl_context())


def settings():
    """WORKER_SECRET (the cloud key) and REGISTER_URL: the environment first, then voicebox.env next to this file."""
    env = {}
    path = os.path.join(HERE, "voicebox.env")
    if os.path.exists(path):
        for line in open(path):
            k, _, v = line.strip().partition("=")
            if k and v:
                env[k] = v
    return os.environ.get("WORKER_SECRET") or env.get("WORKER_SECRET", ""), os.environ.get("REGISTER_URL") or env.get("REGISTER_URL", "")


def own_url():
    """This app's address: https://api.cerebrium.ai/v4/<project>/<app> (CEREBRIUM_URL overrides)."""
    if os.environ.get("CEREBRIUM_URL"):
        return os.environ["CEREBRIUM_URL"].rstrip("/")
    project = os.environ.get("PROJECT_ID", "")
    project = project if project.startswith("p-") else f"p-{project}"
    return f"https://api.cerebrium.ai/v4/{project}/{os.environ.get('APP_NAME', 'voicebox-worker')}"


def code_for(register_url, secret):
    """The newest worker code from the studio; else the last one fetched (on persistent storage)."""
    try:
        with request(register_url.rsplit("/api/", 1)[0] + "/api/bundle", headers={"Authorization": "Bearer " + secret}, timeout=60) as r:
            data, version = r.read(), r.headers.get("X-Worker-Version", "?")
        shutil.rmtree(CODE, ignore_errors=True)
        os.makedirs(CODE, exist_ok=True)
        tarfile.open(fileobj=io.BytesIO(data), mode="r:gz").extractall(CODE, filter="data")
        shutil.rmtree(SAVED, ignore_errors=True)
        shutil.copytree(CODE, SAVED)
        return version
    except Exception as e:  # noqa: BLE001
        log(f"couldn't fetch the worker code from the studio ({type(e).__name__}: {e})")
        if os.path.exists(os.path.join(SAVED, "gateway.py")):
            shutil.rmtree(CODE, ignore_errors=True)
            shutil.copytree(SAVED, CODE)
            log("using the last fetched worker code")
            return "cached"
        raise RuntimeError(f"couldn't get the worker code from the studio ({type(e).__name__}: {e}) and none was saved from an earlier start") from e


def worker_env(register_url, secret):
    try:
        with request(register_url.rsplit("/api/", 1)[0] + "/api/worker-env", headers={"Authorization": "Bearer " + secret}, timeout=15) as r:
            got = json.loads(r.read())
        env = {k: v for k, v in got.items() if k in ("HF_TOKEN", "MY_VOICE_MODEL", "MY_VOICE_SPEAKER", "MY_VOICE_ADAPTER_URL") and v}
        if env.get("HF_TOKEN") and not env["HF_TOKEN"].startswith("hf_"):
            env.pop("HF_TOKEN")
        return env
    except Exception as e:  # noqa: BLE001
        log(f"could not fetch worker settings: {e}")
        return {}


def health(secret):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/health", headers={"Authorization": f"Bearer {secret}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def heartbeat(register_url, secret, url, version):
    h = health(secret)
    body = json.dumps({"backend": "cerebrium", "url": url, "version": version, "gpu": h["gpu"], "engines": h["engines"],
                       "loaded": h["loaded"], "queue": h["queue"], "started_at": time.time() - h["uptime_s"],
                       "running": len(h.get("running") or []), "last_active": h.get("last_active")}).encode()
    with request(register_url, data=body, headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}, timeout=20) as r:
        said = json.loads(r.read() or b"{}")
    return h, bool(said.get("stop"))


def broken(why):
    """Answer every request with why the start failed (HTTP 424), so the studio's Test shows it. Also what a stopped
    container serves while Cerebrium winds it down."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def _send(self):
            body = json.dumps({"error": why if why.startswith("stopped") else f"the Cerebrium worker didn't start: {why}"}).encode()
            self.send_response(424)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        do_GET = do_POST = _send

        def log_message(self, *a):
            pass
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()


def serve():
    try:
        secret, register_url = settings()
        if len(secret) < 24 or not register_url.startswith("https://"):
            raise RuntimeError("voicebox.env needs WORKER_SECRET (the cloud key from Settings → GPU & engines) and REGISTER_URL: run the setup again")
        os.makedirs(os.path.join(HOME, "logs"), exist_ok=True)
        version = code_for(register_url, secret)
        env = {**os.environ, **worker_env(register_url, secret), "WORKER_SECRET": secret, "REGISTER_URL": register_url,
               "VOICEBOX_HOME": HOME, "VOICEBOX_BACKEND": "cerebrium", "VOICEBOX_PREFETCH": "", "VOICEBOX_PRELOAD": "", "UV_LINK_MODE": "copy"}
    except Exception as e:  # noqa: BLE001
        log(f"start failed: {type(e).__name__}: {e}")
        return broken(f"{type(e).__name__}: {e}")

    def spawn():
        logf = open(os.path.join(HOME, "logs", "gateway.log"), "a")
        return subprocess.Popen([sys.executable, os.path.join(CODE, "gateway.py"), "--host", "0.0.0.0", "--port", str(PORT)],
                                stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=CODE)

    url = own_url()
    log(f"worker {version} at {url}")
    gw = spawn()

    def on_term(*_):
        # Cerebrium is replacing or stopping this container: go now, so an old copy never lingers next to the new one
        # (it would keep heartbeating, and hold a job nobody can reach)
        log("SIGTERM from Cerebrium: shutting down")
        try:
            gw.terminate()
            gw.wait(timeout=10)
        except Exception:  # noqa: BLE001
            gw.kill()
        os._exit(0)
    signal.signal(signal.SIGTERM, on_term)
    busy_since = None
    first = True
    while True:
        time.sleep(5 if first else 60)  # the first beat as soon as the gateway answers: the studio shows it awake
        first = False
        try:
            if gw.poll() is not None:
                log("gateway exited; restarting it")
                gw = spawn()
                continue
            h, stop = heartbeat(register_url, secret, url, version)
            if stop:  # Stop in Settings → GPU & engines (or the MCP)
                # never exit: Cerebrium takes an exit for a crash and starts a new container (it did, on another
                # provider). Go quiet instead: no gateway, no heartbeats, no self-knocks, and Cerebrium puts the idle
                # container to sleep after its cooldown
                log("stop asked by the studio: going quiet until Cerebrium puts this container to sleep")
                gw.kill()
                return broken("stopped from the studio; it wakes again for the next job")
            working = bool(h.get("running")) or int(h.get("queue") or 0) > 0
            busy_since = (busy_since or time.time()) if working else None
            if working and time.time() - busy_since < MAX_BUSY_H * 3600:
                # Cerebrium scales to zero after `cooldown` without requests, even mid-job: a request to its own address counts
                request(url + "/health", headers={"Authorization": f"Bearer {secret}"}, timeout=60).close()
        except urllib.error.HTTPError as e:
            if e.code != 401:  # the self-knock answers 401 only if the key changed; anything else is worth a line
                log(f"watch: HTTP {e.code}")
        except Exception as e:  # noqa: BLE001  one bad minute never ends the watch
            log(f"watch: {type(e).__name__}: {e}")


def connect(key, studio, logfile):
    """After `cerebrium deploy`: find the app's address in what it printed and tell the studio, so nobody pastes it."""
    text = open(logfile, errors="replace").read() if os.path.exists(logfile) else ""
    m = re.search(r"https://api(?:\.[a-z0-9-]+){0,3}\.cerebrium\.ai/v4/p-[a-z0-9]+/[a-z0-9-]+", text)
    if not m:
        sys.exit("Couldn't find the app's address in the deploy output. If the deploy succeeded, paste its address "
                 "(https://api.cerebrium.ai/v4/p-…/voicebox-worker) in Settings → GPU & engines → Cerebrium.")
    url = m.group(0)
    try:
        request(studio.rstrip("/") + "/api/register", data=json.dumps({"backend": "cerebrium", "hello": True, "url": url}).encode(),
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}).close()
    except urllib.error.HTTPError as e:
        sys.exit(f"Deployed at {url}, but the studio said {e.code}: {e.read().decode()[:200]}. Paste the address in Settings → GPU & engines → Cerebrium.")
    except urllib.error.URLError as e:
        sys.exit(f"Deployed at {url}, but couldn't reach the studio ({e.reason}). Paste the address in Settings → GPU & engines → Cerebrium.")
    print(f"\nCerebrium GPU connected: {url}\nThe studio uses it now (Settings → GPU & engines). It sleeps until a job wakes it.")


if __name__ == "__main__":
    if sys.argv[1:2] == ["serve"]:
        serve()
    elif sys.argv[1:2] == ["connect"] and len(sys.argv) == 5:
        connect(*sys.argv[2:5])
    else:
        sys.exit(__doc__)
