"""Colab entry point: gateway + Cloudflare tunnel + heartbeat to the hosted MCP server.

Reads settings from Colab Secrets (or environment variables):
  WORKER_SECRET   shared secret between this worker and the MCP server (required)
  REGISTER_URL    https://<your-vercel-app>/api/register (required for the MCP to find this worker)
  PREWARM         optional, comma-separated engines to load at startup, e.g. "orpheus,chatterbox"
  VOICEBOX_VRAM_GB optional override of the VRAM budget

Keeps running (the notebook cell stays busy) and repairs itself: if the tunnel dies it opens a new
one and re-registers the new URL.
"""
import json, os, platform, re, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import config as C  # noqa: E402

PORT = 8000
HOME = C.HOME
os.makedirs(os.path.join(HOME, "logs"), exist_ok=True)


# Colab Secrets answer only with a notebook page open: started from the app (VOICEBOX_STARTED_BY=app, a bare kernel),
# each lookup of a missing secret waited for a timeout (51 s of a 64 s start), so the app's start never asks, and a
# notebook start stops asking after the first failure.
USERDATA = {"ok": os.environ.get("VOICEBOX_STARTED_BY") != "app"}


def setting(name, default=None):
    if os.environ.get(name):
        return os.environ[name]
    if not USERDATA["ok"]:
        return default
    try:
        from google.colab import userdata  # type: ignore
        return userdata.get(name)
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ not in ("SecretNotFoundError", "NotebookAccessError"):  # no answer at all: stop asking
            USERDATA["ok"] = False
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


def fetch_cloudflared():
    """cloudflared from the runtime disk (kept in HOME/bin across worker restarts), downloaded once per runtime."""
    cf = os.path.join(HOME, "bin", "cloudflared")
    if subprocess.call(["which", "cloudflared"], stdout=subprocess.DEVNULL) == 0:
        return "cloudflared"
    if not os.path.exists(cf):
        os.makedirs(os.path.dirname(cf), exist_ok=True)
        arch = "arm64" if platform.machine() in ("aarch64", "arm64") else "amd64"
        url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{arch}"
        urllib.request.urlretrieve(url, cf + ".part")
        os.chmod(cf + ".part", 0o755)
        os.replace(cf + ".part", cf)  # a download cut off by a restart never passes for the real thing
    return cf


def start_gateway(secret):
    return wait_gateway(spawn_gateway(secret), secret)


def spawn_gateway(secret):
    # REGISTER_URL too: the gateway asks the dashboard for its R2 cache links (r2cache.py) and fetches updates there
    env = {**os.environ, "WORKER_SECRET": secret, "VOICEBOX_HOME": HOME, "REGISTER_URL": setting("REGISTER_URL") or ""}
    logf = open(os.path.join(HOME, "logs", "gateway.log"), "a")
    return subprocess.Popen([sys.executable, os.path.join(HERE, "gateway.py"), "--port", str(PORT)],
                            stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=HERE)


def wait_gateway(p, secret):
    for _ in range(120):
        try:
            urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/health",
                                                          headers={"Authorization": f"Bearer {secret}"}), timeout=2)
            return p
        except Exception:
            if p.poll() is not None:
                raise RuntimeError("gateway exited; see " + os.path.join(HOME, "logs", "gateway.log"))
            time.sleep(0.5)
    raise RuntimeError("gateway did not start")


def start_tunnel(cf):
    logpath = os.path.join(HOME, "logs", "tunnel.log")
    logf = open(logpath, "w")
    p = subprocess.Popen([cf, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"],
                         stdout=logf, stderr=subprocess.STDOUT)
    for _ in range(180):
        m = re.search(r"https://[a-z0-9\-]+\.trycloudflare\.com", open(logpath).read())
        if m:
            open(os.path.join(HOME, "public_url"), "w").write(m.group(0))
            return p, m.group(0)
        if p.poll() is not None:
            break
        time.sleep(0.5)
    raise RuntimeError("tunnel failed; see " + logpath)


def clear_processes(patterns):
    """Kill processes by command line, then whatever still holds the GPU (vLLM's EngineCore doesn't match the
    names). Returns how many were killed."""
    killed = 0
    for pat in patterns:
        killed += subprocess.call(["pkill", "-9", "-f", pat]) == 0
    try:
        pids = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], text=True).split()
        for pid in pids:
            if pid.isdigit() and int(pid) != os.getpid():
                killed += subprocess.call(["kill", "-9", pid]) == 0
    except Exception:  # noqa: BLE001
        pass
    return killed


HUNG_MIN = 10  # minutes of /health not answering before a living gateway counts as hung
HUNG_BUSY_MIN = 30  # the same while a job was running (training can starve it of CPU; never kill a run that's fine)
HEALTH_FAILS = [0]
WAS_BUSY = [False]  # a job was running at the last answer


def health(secret):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/health", headers={"Authorization": f"Bearer {secret}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def register(register_url, secret, url):
    """Heartbeat. Returns the URL that answered: urllib won't follow a 307/308 on POST (e.g. an old Vercel domain
    that now redirects to the new one), so follow it here, keeping the Authorization header, and remember it."""
    h = health(secret)
    body = json.dumps({"url": url, "version": C.VERSION, "gpu": h["gpu"], "engines": h["engines"],
                       "loaded": h["loaded"], "queue": h["queue"], "started_at": time.time() - h["uptime_s"],
                       "running": len(h.get("running") or []), "last_active": h.get("last_active")}).encode()
    for _ in range(4):
        req = urllib.request.Request(register_url, data=body, method="POST",
                                     headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json",
                                              "User-Agent": f"voicebox-worker/{C.VERSION}"})
        try:
            with urllib.request.urlopen(req, timeout=20):
                return register_url
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location")
            if e.code not in (301, 302, 303, 307, 308) or not loc:
                raise
            nxt = urllib.parse.urljoin(register_url, loc)
            if not nxt.startswith("https://"):
                raise
            log(f"REGISTER_URL moved: {register_url} -> {nxt} (update the Colab secret to skip the redirect)")
            register_url = nxt
    raise RuntimeError(f"too many redirects registering at {register_url}")


def wait_public(url, secret, limit=45):
    """Until the tunnel's public address answers (/health through Cloudflare), at most limit seconds: registering
    sooner hands the dashboard an address its first request can't resolve ("fetch failed")."""
    t = time.time()
    while time.time() - t < limit:
        try:
            urllib.request.urlopen(urllib.request.Request(url + "/health", headers={"Authorization": f"Bearer {secret}"}), timeout=5)
            log(f"public URL answers after {time.time() - t:.1f} s")
            return True
        except Exception:  # noqa: BLE001  not resolving / not connected yet
            time.sleep(1.5)
    log(f"public URL still not answering after {limit} s: registering anyway (the dashboard retries)")
    return False


BOOT = {}  # step 6: seconds from launcher start to each phase, written to HOME/boot.json (the gateway's /health shows it)
T0 = time.time()


def mark(phase):
    BOOT[phase] = round(time.time() - T0, 1)
    try:
        json.dump({"phases": BOOT, "at": T0}, open(os.path.join(HOME, "boot.json"), "w"))
    except OSError:
        pass


def main():
    # cloudflared downloads while the settings are read and old processes cleared: it's needed only once the gateway runs
    cf_box = {}
    cf_thread = threading.Thread(target=lambda: cf_box.update(cf=fetch_cloudflared()), daemon=True)
    cf_thread.start()
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
    mark("secrets")
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
    mark("worker-env")
    ensure_tools()
    mark("tools")
    # a previous run in this runtime may have left processes behind (e.g. after "interrupt" + re-run)
    if clear_processes(("gateway.py", "engine_host.py", "cloudflared tunnel")):
        time.sleep(3)  # let the port and the GPU memory go; a fresh runtime has nothing to wait for
    # the gateway and the tunnel start side by side: cloudflared connects to Cloudflare while the gateway imports, and
    # forwards requests once the gateway listens
    gw = spawn_gateway(secret)
    cf_thread.join()
    cf = cf_box.get("cf") or fetch_cloudflared()  # the background download failed: once more, in the open
    mark("cloudflared")
    tunnel_box = {}

    def open_tunnel():
        try:
            tunnel_box["t"] = start_tunnel(cf)
        except Exception as e:  # noqa: BLE001
            tunnel_box["err"] = e
    tunnel_thread = threading.Thread(target=open_tunnel, daemon=True)
    tunnel_thread.start()
    gw = wait_gateway(gw, secret)
    mark("gateway")
    h = health(secret)
    log(f"gateway up · GPU {h['gpu']['name']} {h['gpu']['total_gb']} GB · VRAM budget {h['vram_budget_gb']} GB")
    tunnel_thread.join()
    if "t" not in tunnel_box:
        raise tunnel_box.get("err") or RuntimeError("tunnel failed")
    tunnel, url = tunnel_box["t"]
    mark("tunnel")
    log(f"public URL {url}")
    wait_public(url, secret)  # a trycloudflare address takes a few seconds to resolve: don't announce one that doesn't work yet
    mark("reachable")
    if register_url:  # register now, not after prewarming: the dashboard shows the worker online from this moment
        try:
            register_url = register(register_url, secret, url)
            mark("registered")
            log(f"registered {BOOT['registered']} s after the launcher started ({BOOT})")
        except Exception as e:  # noqa: BLE001  the heartbeat loop keeps trying
            log(f"first register failed: {e}")

    for name in filter(None, (setting("PREWARM", "") or "").split(",")):
        name = name.strip()
        if name in C.ENGINES:
            req = urllib.request.Request(f"http://127.0.0.1:{PORT}/engines/{name}/load", data=b"{}", method="POST",
                                         headers={"Authorization": f"Bearer {secret}"})
            urllib.request.urlopen(req, timeout=10)
            log(f"prewarming {name}")

    last_status = ""
    while True:
        try:
            gw, tunnel, url, register_url, last_status = tick(gw, tunnel, url, register_url, last_status, secret, cf)
        except Exception as e:  # noqa: BLE001  never let one bad minute end the loop: no heartbeat = the GPU gets reclaimed
            log(f"heartbeat loop: {type(e).__name__}: {e}")
        time.sleep(60)


def tick(gw, tunnel, url, register_url, last_status, secret, cf):
    """One minute of the watch loop: restart what died, heartbeat (which keeps the Colab runtime alive), log a line.
    A busy gateway (training uses every core) can answer /health slowly; that must never stop the heartbeats."""
    limit = HUNG_BUSY_MIN if WAS_BUSY[0] else HUNG_MIN
    if gw.poll() is None and HEALTH_FAILS[0] >= limit:
        # alive but not answering (a deadlock): the dashboard sees it offline and nothing would ever recover it
        log(f"gateway hasn't answered for {limit} min: restarting it and its engines")
        gw.kill()
        gw.wait()
        clear_processes(("engine_host.py",))
        time.sleep(3)
        HEALTH_FAILS[0] = 0
    if gw.poll() is not None:
        log("gateway died; restarting")
        clear_processes(("engine_host.py",))  # its engines live in their own sessions and would keep the GPU
        gw = start_gateway(secret)
    if tunnel.poll() is not None:
        log("tunnel died; reopening")
        tunnel, url = start_tunnel(cf)
        log(f"new public URL {url}")
        wait_public(url, secret, limit=30)
    if register_url:
        try:
            register_url = register(register_url, secret, url)
            status = "registered"
        except Exception as e:
            status = f"register failed: {e}"
    else:
        status = "no REGISTER_URL set (MCP can't find this worker)"
    try:
        h = health(secret)
        HEALTH_FAILS[0] = 0
        WAS_BUSY[0] = bool(h.get("running"))
        line = f"{status} · engines {h['engines']} · queue {h['queue']} · VRAM {h['gpu']['used_gb']}/{h['gpu']['total_gb']} GB"
    except Exception as e:  # noqa: BLE001
        HEALTH_FAILS[0] += 1
        line = f"{status} · health check slow ({type(e).__name__}, {HEALTH_FAILS[0]} min)"
    if line != last_status:
        log(line)
        last_status = line
    else:  # a quiet kernel looks idle to Colab: one short line a minute is output, i.e. activity, without the noise
        print(f"\r[voicebox] alive {time.strftime('%H:%M')}", end="", flush=True)
    return gw, tunnel, url, register_url, last_status


if __name__ == "__main__":
    main()
