"""Voicebox's second GPU: the same worker as the Colab notebook, on Modal (https://modal.com).

It sleeps until the studio sends it a job, then a container starts (about a minute; the first ever start also installs
the engines), runs the job and goes back to sleep ten minutes after the last request. Modal bills by the second, so a
quiet month costs nothing; the studio caps the hours a month (Settings → GPU & engines). The dashboard decides when to
use it (mcp/lib/gpus.ts): first or as the fallback when Colab is off, whichever you choose.

What it runs is the newest worker code, fetched from the studio at each start (/api/bundle, like the Colab notebook), so
a merge to main reaches it with no redeploy.

Setting it up: Settings → GPU & engines → Set up Modal prints four commands to paste in a terminal (they carry a key
the studio makes for Modal, so nothing has to be looked up), and the last one connects the address by itself. The same
by hand (docs/MODAL.md):

  python3 -m pip install modal && python3 -m modal setup
  python3 -m modal secret create voicebox WORKER_SECRET=<Modal's key, or the Worker's WORKER_SECRET> \\
      REGISTER_URL=https://voiceboxstudio.pages.dev/api/register --force
  python3 -m modal deploy voicebox_modal.py && python3 voicebox_modal.py <that key> https://voiceboxstudio.pages.dev

(The Deploy workflow redeploys it on every merge when the MODAL_TOKEN_ID / MODAL_TOKEN_SECRET repository secrets are
set.) Engines and weights are kept on a Modal Volume (voicebox-home), so they download once, not per start.
"""
import io
import json
import os
import subprocess
import sys
import tarfile
import threading
import time
import shutil
import urllib.error
import urllib.request

import modal

# Cloudflare turns away Python's own user agent ("error code: 1010"): every request here says what it is
_opener = urllib.request.build_opener()
_opener.addheaders = [("User-Agent", "voicebox-worker-modal")]
urllib.request.install_opener(_opener)

APP = "voicebox-worker"
# Modal takes the first of these it has free (read at deploy time). L4 alone can queue for many minutes ("waiting to be
# scheduled on a GPU_L4 worker"), so the next-closest cards follow: A10G (24 GB, same price range), then A100 40 GB and
# L40S (48 GB), which cost more an hour. VOICEBOX_MODAL_GPU=L4 (or a comma list) at deploy pins it.
GPU = [g.strip() for g in os.environ.get("VOICEBOX_MODAL_GPU", "L4,A10G,A100-40GB,L40S").split(",") if g.strip()]
HOME = "/vol/voicebox"
CODE = "/root/worker"
BAKED = "/root/baked"  # the worker code as it was at deploy time: the start never depends on reaching the studio
SAVED = f"{HOME}/app"  # the last code fetched at a start, on the Volume
PORT = 8000
IDLE_S = 600  # asleep ten minutes after the last request
MAX_BUSY_H = float(os.environ.get("VOICEBOX_MODAL_MAX_BUSY_H", "4"))  # a job that runs longer is let go (the cap's backstop)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ca-certificates", "ffmpeg", "sox", "git", "curl", "libsndfile1", "build-essential")
    .pip_install("numpy", "scipy", "soundfile", "pillow", "librosa", "yt-dlp", "curl_cffi", "uv")
    .env({"UV_LINK_MODE": "copy", "PYTHONUNBUFFERED": "1", "VOICEBOX_HOME": HOME, "VOICEBOX_BACKEND": "modal",
          # a container starts for a job: nothing is fetched or loaded ahead of it (the Volume keeps what's been used)
          "VOICEBOX_PREFETCH": "", "VOICEBOX_PRELOAD": ""})
)


def _ssl_context():
    """certifi's certificates when there are any: the python.org Python on a Mac trusts none of its own."""
    try:
        import certifi
        import ssl
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def _bake(image):
    """At deploy, on your machine: the worker code goes into the image (setup passes VOICEBOX_KEY and VOICEBOX_STUDIO)."""
    key, studio = os.environ.get("VOICEBOX_KEY"), os.environ.get("VOICEBOX_STUDIO", "").rstrip("/")
    if not (key and studio):
        return image
    import tempfile
    # the User-Agent on the request itself: urlopen with a context= ignores the opener installed above, and Cloudflare
    # refuses Python's own (HTTP 403, error code 1010)
    req = urllib.request.Request(studio + "/api/bundle", headers={"Authorization": "Bearer " + key, "User-Agent": "voicebox-worker-modal"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=_ssl_context()) as r:
            data, version = r.read(), r.headers.get("X-Worker-Version", "?")
    except Exception as e:  # noqa: BLE001  not fatal: each start fetches the code from the studio too
        print(f"warning: couldn't bake the worker code in ({e}); each start fetches it from the studio instead")
        return image
    d = tempfile.mkdtemp(prefix="voicebox-worker-")
    tarfile.open(fileobj=io.BytesIO(data), mode="r:gz").extractall(d, filter="data")
    print(f"worker {version} baked into the image")
    return image.add_local_dir(d, BAKED)


if modal.is_local():
    image = _bake(image)
vol = modal.Volume.from_name("voicebox-home", create_if_missing=True)
app = modal.App(APP)


def log(*a):
    print(time.strftime("%H:%M:%S"), "[voicebox-modal]", *a, flush=True)


def fetch_code(register_url, secret):
    """The newest worker code from the studio, unpacked into CODE (the same bundle Colab runs)."""
    req = urllib.request.Request(register_url.rsplit("/api/", 1)[0] + "/api/bundle",
                                 headers={"Authorization": "Bearer " + secret, "User-Agent": "voicebox-worker-modal"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data, version = r.read(), r.headers.get("X-Worker-Version", "?")
    os.makedirs(CODE, exist_ok=True)
    tarfile.open(fileobj=io.BytesIO(data), mode="r:gz").extractall(CODE, filter="data")
    return version


def worker_env(register_url, secret):
    """HF_TOKEN and the trained-voice settings, from the studio (as the Colab launcher gets them)."""
    env = {}
    try:
        req = urllib.request.Request(register_url.rsplit("/api/", 1)[0] + "/api/worker-env", headers={"Authorization": "Bearer " + secret, "User-Agent": "voicebox-worker-modal"})
        with urllib.request.urlopen(req, timeout=15) as r:
            got = json.loads(r.read())
        env = {k: v for k, v in got.items() if k in ("HF_TOKEN", "MY_VOICE_MODEL", "MY_VOICE_SPEAKER", "MY_VOICE_ADAPTER_URL") and v}
    except Exception as e:  # noqa: BLE001
        log(f"could not fetch worker settings: {e}")
    if env.get("HF_TOKEN") and not env["HF_TOKEN"].startswith("hf_"):  # e.g. a "[SENSITIVE]" placeholder
        env.pop("HF_TOKEN")
    return env


def health(secret):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/health", headers={"Authorization": f"Bearer {secret}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def heartbeat(register_url, secret, url, version):
    """Tell the studio this GPU is awake (its time counts toward the monthly cap), every minute while it is."""
    h = health(secret)
    body = json.dumps({"backend": "modal", "url": url, "version": version, "gpu": h["gpu"], "engines": h["engines"],
                       "loaded": h["loaded"], "queue": h["queue"], "started_at": time.time() - h["uptime_s"],
                       "running": len(h.get("running") or []), "last_active": h.get("last_active")}).encode()
    req = urllib.request.Request(register_url, data=body, method="POST",
                                 headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json",
                                          "User-Agent": "voicebox-worker-modal"})
    urllib.request.urlopen(req, timeout=20).close()
    return h


def watch(register_url, secret, version, spawn):
    """Every minute: restart the gateway if it died, heartbeat, and keep the container awake while a job runs (Modal
    puts a container to sleep after IDLE_S without requests, even mid-job: a request to its own address counts)."""
    url = ""
    busy_since = None
    committed = time.time()
    gw = spawn()
    first = True
    while True:
        time.sleep(5 if first else 60)  # the first beat as soon as the gateway answers: the studio shows it awake
        first = False
        try:
            if gw.poll() is not None:
                log("gateway exited; restarting it")
                gw = spawn()
                continue
            if not url:
                try:
                    url = modal.Function.from_name(APP, "gateway").get_web_url().rstrip("/")
                except Exception as e:  # noqa: BLE001
                    log(f"own address unknown yet: {e}")
                    continue
            h = heartbeat(register_url, secret, url, version)
            working = bool(h.get("running")) or int(h.get("queue") or 0) > 0
            busy_since = (busy_since or time.time()) if working else None
            if working and time.time() - busy_since < MAX_BUSY_H * 3600:
                urllib.request.urlopen(urllib.request.Request(url + "/health", headers={"Authorization": f"Bearer {secret}"}), timeout=60).close()
            if time.time() - committed > 600:
                vol.commit()  # what the jobs installed and downloaded is kept for the next start
                committed = time.time()
        except Exception as e:  # noqa: BLE001  one bad minute never ends the watch
            log(f"watch: {type(e).__name__}: {e}")


@app.function(image=image, gpu=GPU, volumes={"/vol": vol}, secrets=[modal.Secret.from_name("voicebox")],
              timeout=24 * 3600, scaledown_window=IDLE_S, min_containers=0, max_containers=1)
@modal.concurrent(max_inputs=200)
@modal.web_server(PORT, startup_timeout=600)
def gateway():
    try:
        start()
    except Exception as e:  # noqa: BLE001  a start that fails says why, instead of Modal retrying it for ever
        log(f"start failed: {type(e).__name__}: {e}")
        broken(f"{type(e).__name__}: {e}")


def code_for(register_url, secret):
    """The newest worker code from the studio; else the last one fetched (on the Volume); else the one baked in at deploy."""
    try:
        version = fetch_code(register_url, secret)
        shutil.rmtree(SAVED, ignore_errors=True)
        shutil.copytree(CODE, SAVED)
        return version
    except Exception as e:  # noqa: BLE001
        log(f"couldn't fetch the worker code from the studio ({type(e).__name__}: {e})")
        for src, what in ((SAVED, "the last fetched"), (BAKED, "the deployed")):
            if os.path.exists(os.path.join(src, "gateway.py")):
                shutil.rmtree(CODE, ignore_errors=True)
                shutil.copytree(src, CODE)
                log(f"using {what} worker code")
                return "cached"
        raise RuntimeError(f"couldn't get the worker code from the studio ({type(e).__name__}: {e}) and none was baked in at deploy") from e


def start():
    secret = os.environ.get("WORKER_SECRET", "")
    register_url = os.environ.get("REGISTER_URL", "")
    if len(secret) < 24 or not register_url.startswith("https://"):
        raise RuntimeError("the Modal secret 'voicebox' needs WORKER_SECRET (Modal's key from Settings → GPU & engines) and REGISTER_URL")
    os.makedirs(os.path.join(HOME, "logs"), exist_ok=True)
    version = code_for(register_url, secret)
    env = {**os.environ, **worker_env(register_url, secret), "WORKER_SECRET": secret, "REGISTER_URL": register_url}
    log(f"worker {version} on {GPU}")

    def spawn():
        logf = open(os.path.join(HOME, "logs", "gateway.log"), "a")
        return subprocess.Popen([sys.executable, os.path.join(CODE, "gateway.py"), "--host", "0.0.0.0", "--port", str(PORT)],
                                stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=CODE)

    threading.Thread(target=watch, args=(register_url, secret, version, spawn), daemon=True).start()


def broken(why):
    """Answer every request with why the start failed (HTTP 424), so the studio's Test Modal shows it."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def _send(self):
            body = json.dumps({"error": f"the Modal worker didn't start: {why}"}).encode()
            self.send_response(424)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        do_GET = do_POST = _send

        def log_message(self, *a):
            pass
    threading.Thread(target=ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever, daemon=True).start()
# web_server waits for the port to answer before the first request goes through


if __name__ == "__main__":
    # The last setup step, run on your machine right after `modal deploy`: tell the studio where this GPU answers, so
    # its address never has to be pasted.   python3 voicebox_modal.py <the Modal key> <the studio's address>
    if len(sys.argv) != 3:
        sys.exit("usage: python3 voicebox_modal.py <key> <https://your-studio>  (Settings → GPU & engines → Set up Modal prints it)")
    key, origin = sys.argv[1], sys.argv[2].rstrip("/")
    url = modal.Function.from_name(APP, "gateway").get_web_url().rstrip("/")
    req = urllib.request.Request(origin + "/api/register", method="POST",
                                 data=json.dumps({"backend": "modal", "hello": True, "url": url}).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "voicebox-modal-setup"})
    try:
        urllib.request.urlopen(req, timeout=30, context=_ssl_context()).close()
    except urllib.error.HTTPError as e:
        sys.exit(f"Deployed at {url}, but the studio said {e.code}: {e.read().decode()[:200]}. Paste the address in Settings → GPU & engines.")
    except urllib.error.URLError as e:
        sys.exit(f"Deployed at {url}, but couldn't reach the studio ({e.reason}). Paste that address in Settings → GPU & engines → Modal address.")
    print(f"\nModal GPU connected: {url}\nThe studio uses it now (Settings → GPU & engines). It sleeps until a job wakes it.")


@app.function(image=image, gpu=GPU, volumes={"/vol": vol}, secrets=[modal.Secret.from_name("voicebox")], timeout=900)
def doctor():
    """Every step of a start, printed as it goes:   python3 -m modal run voicebox_modal.py::doctor
    (the same GPU, secret, Volume and code as the real one, so whatever stops the real start shows here)."""
    print("1. container is running", flush=True)
    print("2. GPU:", subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip() or "none!", flush=True)
    secret, register_url = os.environ.get("WORKER_SECRET", ""), os.environ.get("REGISTER_URL", "")
    print(f"3. secret 'voicebox': WORKER_SECRET {'ok (' + secret[:5] + '…)' if len(secret) >= 24 else 'MISSING or too short'}, REGISTER_URL {register_url or 'MISSING'}", flush=True)
    try:
        print("4. worker code:", code_for(register_url, secret), flush=True)
    except Exception as e:  # noqa: BLE001
        print("4. worker code FAILED:", e, flush=True)
        return
    os.makedirs(os.path.join(HOME, "logs"), exist_ok=True)
    env = {**os.environ, **worker_env(register_url, secret), "WORKER_SECRET": secret, "REGISTER_URL": register_url}
    p = subprocess.Popen([sys.executable, os.path.join(CODE, "gateway.py"), "--host", "0.0.0.0", "--port", str(PORT)],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=CODE, text=True)
    for _ in range(90):
        time.sleep(1)
        if p.poll() is not None:
            print("5. gateway EXITED:\n" + (p.stdout.read() or "")[-3000:], flush=True)
            return
        try:
            print("5. gateway answers:", json.dumps(health(secret))[:300], flush=True)
            break
        except Exception:  # noqa: BLE001
            pass
    else:
        print("5. gateway didn't answer in 90 s", flush=True)
    try:
        print("6. studio heartbeat:", heartbeat(register_url, secret, "https://doctor.modal.run", "doctor") and "accepted", flush=True)
    except Exception as e:  # noqa: BLE001
        print("6. studio heartbeat FAILED:", e, flush=True)
    p.kill()
    print("done: every step above passed unless one says FAILED / MISSING / EXITED", flush=True)
