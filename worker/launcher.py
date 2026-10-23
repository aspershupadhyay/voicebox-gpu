"""Colab entry point: gateway + Cloudflare tunnel + heartbeat to the hosted MCP server.

Reads settings from Colab Secrets (or environment variables):
  WORKER_SECRET   shared secret between this worker and the MCP server (required)
  REGISTER_URL    https://<your-vercel-app>/api/register (required for the MCP to find this worker)
  PREWARM         optional, comma-separated engines to load at startup, e.g. "orpheus,chatterbox"
  VOICEBOX_VRAM_GB optional override of the VRAM budget

Keeps running (the notebook cell stays busy) and repairs itself: if the tunnel dies it opens a new
one and re-registers the new URL.
"""
import json, os, platform, re, subprocess, sys, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import config as C  # noqa: E402

PORT = 8000
HOME = C.HOME
os.makedirs(os.path.join(HOME, "logs"), exist_ok=True)


def setting(name, default=None):
    if os.environ.get(name):
        return os.environ[name]
    try:
        from google.colab import userdata  # type: ignore
        return userdata.get(name)
    except Exception:
        return default


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def ensure_tools():
    try:  # gateway post-processing deps (preinstalled on Colab; cheap no-op check)
        import numpy, scipy, soundfile  # noqa: F401
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "numpy", "scipy", "soundfile"])
    if subprocess.call(["which", "uv"], stdout=subprocess.DEVNULL) != 0:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "uv"])
    cf = os.path.join(HOME, "bin", "cloudflared")
    if subprocess.call(["which", "cloudflared"], stdout=subprocess.DEVNULL) == 0:
        return "cloudflared"
    if not os.path.exists(cf):
        os.makedirs(os.path.dirname(cf), exist_ok=True)
        arch = "arm64" if platform.machine() in ("aarch64", "arm64") else "amd64"
        url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{arch}"
        urllib.request.urlretrieve(url, cf)
        os.chmod(cf, 0o755)
    return cf


def start_gateway(secret):
    env = {**os.environ, "WORKER_SECRET": secret, "VOICEBOX_HOME": HOME}
    logf = open(os.path.join(HOME, "logs", "gateway.log"), "a")
    p = subprocess.Popen([sys.executable, os.path.join(HERE, "gateway.py"), "--port", str(PORT)],
                         stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=HERE)
    for _ in range(60):
        try:
            urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/health",
                                                          headers={"Authorization": f"Bearer {secret}"}), timeout=2)
            return p
        except Exception:
            if p.poll() is not None:
                raise RuntimeError("gateway exited; see " + os.path.join(HOME, "logs", "gateway.log"))
            time.sleep(1)
    raise RuntimeError("gateway did not start")


def start_tunnel(cf):
    logpath = os.path.join(HOME, "logs", "tunnel.log")
    logf = open(logpath, "w")
    p = subprocess.Popen([cf, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"],
                         stdout=logf, stderr=subprocess.STDOUT)
    for _ in range(90):
        m = re.search(r"https://[a-z0-9\-]+\.trycloudflare\.com", open(logpath).read())
        if m:
            open(os.path.join(HOME, "public_url"), "w").write(m.group(0))
            return p, m.group(0)
        if p.poll() is not None:
            break
        time.sleep(1)
    raise RuntimeError("tunnel failed; see " + logpath)


def health(secret):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/health", headers={"Authorization": f"Bearer {secret}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def register(register_url, secret, url):
    h = health(secret)
    body = json.dumps({"url": url, "version": C.VERSION, "gpu": h["gpu"], "engines": h["engines"],
                       "loaded": h["loaded"], "queue": h["queue"], "started_at": time.time() - h["uptime_s"]}).encode()
    req = urllib.request.Request(register_url, data=body, method="POST",
                                 headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json",
                                          "User-Agent": f"voicebox-worker/{C.VERSION}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status


def main():
    secret = setting("WORKER_SECRET")
    register_url = setting("REGISTER_URL")
    if not secret or len(secret) < 24:
        sys.exit("Set WORKER_SECRET (>= 24 chars) in Colab Secrets (key icon in the left sidebar).")
    if os.environ.get("VOICEBOX_VRAM_GB") is None and setting("VOICEBOX_VRAM_GB"):
        os.environ["VOICEBOX_VRAM_GB"] = setting("VOICEBOX_VRAM_GB")
    # optional Hugging Face read token: anonymous downloads of 50-70 GB video models get rate-limited (HTTP 429)
    # and your own voice model (MY_VOICE_MODEL / MY_VOICE_SPEAKER, from the training notebook)
    wanted = ("HF_TOKEN", "MY_VOICE_MODEL", "MY_VOICE_SPEAKER", "MY_VOICE_ADAPTER_URL")
    for k in wanted:
        if not os.environ.get(k) and setting(k):
            os.environ[k] = setting(k)
    if register_url and not all(os.environ.get(k) for k in wanted):
        try:  # or from the dashboard, which keeps them in its own env (deploy-mcp.sh pushes HF_TOKEN from .secrets.local)
            req = urllib.request.Request(register_url.rsplit("/api/", 1)[0] + "/api/worker-env", headers={"Authorization": f"Bearer {secret}"})
            with urllib.request.urlopen(req, timeout=15) as r:
                env = json.loads(r.read())
            for k in wanted:
                if not os.environ.get(k) and env.get(k):
                    os.environ[k] = env[k]
        except Exception as e:
            log(f"could not fetch worker settings: {e}")
    if os.environ.get("HF_TOKEN") and not os.environ["HF_TOKEN"].startswith("hf_"):
        # e.g. the "[SENSITIVE]" placeholder `vercel env pull` writes: Hugging Face refuses a bad token even for public models
        log("ignoring HF_TOKEN: it isn't a Hugging Face token (they start with hf_)")
        del os.environ["HF_TOKEN"]
    if os.environ.get("MY_VOICE_MODEL"):
        log(f"your voice model: {os.environ['MY_VOICE_MODEL']}")
    log("Hugging Face token: " + ("set" if os.environ.get("HF_TOKEN") else "none (big downloads may be rate-limited; add HF_TOKEN in Colab Secrets)"))
    cf = ensure_tools()
    # a previous run in this runtime may have left processes behind (e.g. after "interrupt" + re-run)
    for pat in ("gateway.py", "engine_host.py", "cloudflared tunnel"):
        subprocess.call(["pkill", "-f", pat])
    # engines spawn children (vLLM's EngineCore) that don't match those names: free the GPU completely
    try:
        pids = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], text=True).split()
        for pid in pids:
            if pid.isdigit() and int(pid) != os.getpid():
                subprocess.call(["kill", "-9", pid])
    except Exception:
        pass
    time.sleep(3)
    gw = start_gateway(secret)
    h = health(secret)
    log(f"gateway up · GPU {h['gpu']['name']} {h['gpu']['total_gb']} GB · VRAM budget {h['vram_budget_gb']} GB")
    tunnel, url = start_tunnel(cf)
    log(f"public URL {url}")

    for name in filter(None, (setting("PREWARM", "") or "").split(",")):
        name = name.strip()
        if name in C.ENGINES:
            req = urllib.request.Request(f"http://127.0.0.1:{PORT}/engines/{name}/load", data=b"{}", method="POST",
                                         headers={"Authorization": f"Bearer {secret}"})
            urllib.request.urlopen(req, timeout=10)
            log(f"prewarming {name}")

    last_status = ""
    while True:
        if gw.poll() is not None:
            log("gateway died; restarting")
            gw = start_gateway(secret)
        if tunnel.poll() is not None:
            log("tunnel died; reopening")
            tunnel, url = start_tunnel(cf)
            log(f"new public URL {url}")
        if register_url:
            try:
                register(register_url, secret, url)
                status = "registered"
            except Exception as e:
                status = f"register failed: {e}"
        else:
            status = "no REGISTER_URL set (MCP can't find this worker)"
        h = health(secret)
        line = f"{status} · engines {h['engines']} · queue {h['queue']} · VRAM {h['gpu']['used_gb']}/{h['gpu']['total_gb']} GB"
        if line != last_status:
            log(line)
            last_status = line
        time.sleep(60)


if __name__ == "__main__":
    main()
