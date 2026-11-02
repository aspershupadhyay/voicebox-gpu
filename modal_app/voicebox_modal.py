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
import urllib.error
import urllib.request

import modal

APP = "voicebox-worker"
GPU = os.environ.get("VOICEBOX_MODAL_GPU", "L4")  # read at deploy time: L4 (24 GB) by default, A100 / H100 work too
HOME = "/vol/voicebox"
CODE = "/root/worker"
PORT = 8000
IDLE_S = 600  # asleep ten minutes after the last request
MAX_BUSY_H = float(os.environ.get("VOICEBOX_MODAL_MAX_BUSY_H", "4"))  # a job that runs longer is let go (the cap's backstop)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "sox", "git", "curl", "libsndfile1", "build-essential")
    .pip_install("numpy", "scipy", "soundfile", "pillow", "librosa", "yt-dlp", "curl_cffi", "uv")
    .env({"UV_LINK_MODE": "copy", "PYTHONUNBUFFERED": "1", "VOICEBOX_HOME": HOME, "VOICEBOX_BACKEND": "modal",
          # a container starts for a job: nothing is fetched or loaded ahead of it (the Volume keeps what's been used)
          "VOICEBOX_PREFETCH": "", "VOICEBOX_PRELOAD": ""})
)
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
        req = urllib.request.Request(register_url.rsplit("/api/", 1)[0] + "/api/worker-env", headers={"Authorization": "Bearer " + secret})
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
    secret = os.environ["WORKER_SECRET"]
    register_url = os.environ["REGISTER_URL"]
    if len(secret) < 24:
        raise RuntimeError("the voicebox secret's WORKER_SECRET must be Modal's key from Settings → GPU & engines (24+ characters)")
    os.makedirs(os.path.join(HOME, "logs"), exist_ok=True)
    version = fetch_code(register_url, secret)
    env = {**os.environ, **worker_env(register_url, secret), "WORKER_SECRET": secret, "REGISTER_URL": register_url}
    log(f"worker {version} on {GPU}")

    def spawn():
        logf = open(os.path.join(HOME, "logs", "gateway.log"), "a")
        return subprocess.Popen([sys.executable, os.path.join(CODE, "gateway.py"), "--host", "0.0.0.0", "--port", str(PORT)],
                                stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=CODE)

    threading.Thread(target=watch, args=(register_url, secret, version, spawn), daemon=True).start()
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
        urllib.request.urlopen(req, timeout=30).close()
    except urllib.error.HTTPError as e:
        sys.exit(f"Deployed at {url}, but the studio said {e.code}: {e.read().decode()[:200]}. Paste the address in Settings → GPU & engines.")
    print(f"\nModal GPU connected: {url}\nThe studio uses it now (Settings → GPU & engines). It sleeps until a job wakes it.")
