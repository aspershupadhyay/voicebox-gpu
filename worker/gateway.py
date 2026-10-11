"""voicebox gateway: the worker's public HTTP API.

Starts engines on demand (each in its own venv, see engine_host.py), queues jobs so the GPU does one
thing at a time, post-processes audio for video timelines, and serves results through signed URLs.

  python gateway.py --port 8000          (WORKER_SECRET must be set)

Auth: every endpoint needs `Authorization: Bearer $WORKER_SECRET`, except /files/* which needs a
valid ?exp=&sig= signature (so download links can be handed to tools that can't set headers).
"""
import argparse, base64, hashlib, hmac, json, os, re, shutil, subprocess, sys, threading, time, traceback, uuid
import urllib.error, urllib.request, zipfile
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config as C  # noqa: E402

SECRET = os.environ.get("WORKER_SECRET", "")
HOME = C.HOME
JOBS_DIR, REFS_DIR, LOGS_DIR = (os.path.join(HOME, d) for d in ("jobs", "refs", "logs"))
for d in (JOBS_DIR, REFS_DIR, LOGS_DIR):
    os.makedirs(d, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))
STARTED = time.time()
ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def public_url():
    try:
        return open(os.path.join(HOME, "public_url")).read().strip()
    except OSError:
        return os.environ.get("PUBLIC_URL", "")


def sign(path, ttl=6 * 3600):
    exp = int(time.time()) + ttl
    sig = hmac.new(SECRET.encode(), f"{path}:{exp}".encode(), hashlib.sha256).hexdigest()[:40]
    return f"{public_url()}{path}?exp={exp}&sig={sig}"


def check_sig(path, qs):
    try:
        exp = int(qs["exp"][0]); sig = qs["sig"][0]
    except (KeyError, ValueError, IndexError):
        return False
    good = hmac.new(SECRET.encode(), f"{path}:{exp}".encode(), hashlib.sha256).hexdigest()[:40]
    return exp > time.time() and hmac.compare_digest(sig, good)


# --------------------------------------------------------------------------------------- GPU
def gpu_info():
    try:
        out = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.total,memory.used",
                                       "--format=csv,noheader,nounits"], text=True, timeout=10).strip().splitlines()[0]
        name, total, used = [x.strip() for x in out.split(",")]
        return {"name": name, "total_gb": round(float(total) / 1024, 1), "used_gb": round(float(used) / 1024, 1)}
    except Exception:
        return {"name": "none (CPU)", "total_gb": 0.0, "used_gb": 0.0}


# --------------------------------------------------------------------------------------- engines
class Engines:
    """Starts engine processes lazily; evicts the least-recently-used one when VRAM would overflow."""

    def __init__(self):
        self.procs = OrderedDict()   # name -> Popen, in LRU order
        self.state = {n: "idle" for n in C.ENGINES}
        self.errors = {}
        self.lock = threading.RLock()
        self.budget = float(os.environ.get("VOICEBOX_VRAM_GB") or gpu_info()["total_gb"] or 0) - 1.5

    def _install(self, name):
        py = C.python_for(name)
        if os.path.exists(py):
            return py
        self.state[name] = "installing"
        venv = os.path.dirname(os.path.dirname(py))
        logf = open(os.path.join(LOGS_DIR, f"{name}-install.log"), "a")
        subprocess.run(["uv", "venv", "--python", "3.11", venv, "-q"], check=True, stdout=logf, stderr=logf)
        subprocess.run(f'uv pip install --python {py} -q {C.ENGINES[name]["packages"]}', shell=True, check=True,
                       stdout=logf, stderr=logf)
        return py

    def _evict_for(self, name):
        need = C.ENGINES[name]["gpu_gb"]
        if need <= 0 or self.budget <= 0:
            return
        while sum(C.ENGINES[n]["gpu_gb"] for n in self.procs) + need > self.budget:
            victim = next((n for n in self.procs if C.ENGINES[n]["gpu_gb"] > 0), None)
            if not victim:
                return
            log(f"evicting {victim} to make room for {name}")
            self.stop(victim)

    def ensure(self, name):
        with self.lock:
            p = self.procs.get(name)
            if p and p.poll() is None:
                self.procs.move_to_end(name)
                return
            try:
                py = self._install(name)
                self._evict_for(name)
                self.state[name] = "loading"
                logf = open(os.path.join(LOGS_DIR, f"{name}.log"), "a")
                env = {**os.environ, "VOICEBOX_HOME": HOME}
                p = subprocess.Popen([py, os.path.join(HERE, "engine_host.py"), "--engine", name,
                                      "--port", str(C.ENGINES[name]["port"])], stdout=logf, stderr=logf, env=env, cwd=HERE)
                self.procs[name] = p
                deadline = time.time() + 30 * 60
                while time.time() < deadline:
                    if p.poll() is not None:
                        raise RuntimeError(f"{name} exited while loading (see logs/{name}.log)")
                    try:
                        urllib.request.urlopen(f"http://127.0.0.1:{C.ENGINES[name]['port']}/ready", timeout=2)
                        self.state[name] = "ready"
                        self.errors.pop(name, None)
                        log(f"{name} ready")
                        return
                    except Exception:
                        time.sleep(2)
                raise RuntimeError(f"{name} did not become ready in 30 min")
            except Exception as e:
                self.state[name] = "error"
                self.errors[name] = str(e)
                self.stop(name, keep_state=True)
                raise

    def stop(self, name, keep_state=False):
        with self.lock:
            p = self.procs.pop(name, None)
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(20)
                except subprocess.TimeoutExpired:
                    p.kill()
            if not keep_state:
                self.state[name] = "idle"

    def synth(self, name, payload):
        self.ensure(name)
        req = urllib.request.Request(f"http://127.0.0.1:{C.ENGINES[name]['port']}/synth",
                                     data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15 * 60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(json.loads(e.read() or b"{}").get("error", str(e)))


ENG = Engines()


# --------------------------------------------------------------------------------------- references
def ref_paths(name):
    return os.path.join(REFS_DIR, f"{name}.wav"), os.path.join(REFS_DIR, f"{name}.json")


def get_ref(name):
    """Return (wav_path, transcript) for a reference voice, building the female/male presets on demand."""
    wav, meta = ref_paths(name)
    if not os.path.exists(wav) and name in C.PRESET_REFS:
        engine, voice = C.PRESET_REFS[name]
        log(f"building preset reference '{name}' with {engine}:{voice}")
        params = C.resolve_params(engine, {"seed": 3})
        raw = wav + ".raw.wav"
        ENG.synth(engine, {"text": C.REF_TEXT, "voice": voice, "params": params, "out_path": raw})
        postprocess(raw, wav, {"trim": True, "trim_db": -45, "normalize_dbfs": -3, "sample_rate": None})
        os.remove(raw)
        json.dump({"transcript": C.REF_TEXT, "source": f"{engine}:{voice}"}, open(meta, "w"))
    if not os.path.exists(wav):
        raise ValueError(f"unknown reference voice '{name}' (add it with POST /refs)")
    transcript = json.load(open(meta)).get("transcript") if os.path.exists(meta) else None
    return wav, transcript


def add_ref(name, audio_bytes, transcript=None):
    if not ID_RE.match(name):
        raise ValueError("reference name must be 1-64 chars of letters, digits, - or _")
    wav, meta = ref_paths(name)
    tmp = wav + ".in"
    open(tmp, "wb").write(audio_bytes)
    postprocess(tmp, wav, {"trim": True, "trim_db": -45, "normalize_dbfs": -3, "sample_rate": None})
    os.remove(tmp)
    json.dump({"transcript": transcript, "source": "upload"}, open(meta, "w"))
    import soundfile as sf
    return {"name": name, "duration": round(sf.info(wav).duration, 2), "has_transcript": bool(transcript)}


# --------------------------------------------------------------------------------------- audio
def postprocess(src, dst, post):
    import numpy as np
    import soundfile as sf
    try:
        audio, sr = sf.read(src, dtype="float32", always_2d=False)
    except Exception:
        conv = src + ".wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, conv], check=True)
        audio, sr = sf.read(conv, dtype="float32", always_2d=False)
        os.remove(conv)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if post.get("trim"):
        thr = 10 ** (float(post.get("trim_db", -45)) / 20)
        idx = np.where(np.abs(audio) > thr)[0]
        if len(idx):
            pad = int(0.06 * sr)
            audio = audio[max(0, idx[0] - pad): min(len(audio), idx[-1] + pad)]
    target = post.get("sample_rate")
    if target and int(target) != sr:
        try:
            from math import gcd
            from scipy.signal import resample_poly
            g = gcd(int(target), sr)
            audio = resample_poly(audio, int(target) // g, sr // g).astype("float32")
        except ImportError:
            n = int(round(len(audio) * int(target) / sr))
            audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype("float32")
        sr = int(target)
    if post.get("normalize_dbfs") is not None:
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        if peak > 0:
            audio = audio * (10 ** (float(post["normalize_dbfs"]) / 20) / peak)
    sf.write(dst, audio, sr, subtype="PCM_16")
    return len(audio) / sr


# --------------------------------------------------------------------------------------- jobs
JOBS = OrderedDict()
QUEUE = []
QCOND = threading.Condition()


def resolve_voice(engine, voice):
    spec = C.ENGINES[engine]
    voice = voice or "female"
    return spec["presets"].get(voice, voice)


def make_job(body):
    engine = body.get("engine")
    if engine not in C.ENGINES:
        raise ValueError(f"engine must be one of {list(C.ENGINES)}")
    lines = body.get("lines") or []
    if not lines or len(lines) > 200:
        raise ValueError("lines must contain 1-200 items")
    clean = []
    for i, ln in enumerate(lines):
        lid = str(ln.get("id") or f"{i + 1:02d}")
        if not ID_RE.match(lid) or not str(ln.get("text", "")).strip():
            raise ValueError(f"line {i}: needs an id (letters/digits/-/_) and non-empty text")
        clean.append({"id": lid, "text": str(ln["text"]).strip()[:2000], "window": ln.get("window"),
                      "params": ln.get("params") or {}})
    job = {"id": uuid.uuid4().hex[:12], "engine": engine, "voice": resolve_voice(engine, body.get("voice")),
           "params": body.get("params") or {}, "post": {**C.POST_DEFAULTS, **(body.get("post") or {})},
           "lines": clean, "status": "queued", "created": time.time(), "results": [], "error": None,
           "cancel": False, "label": str(body.get("label") or "")[:80]}
    os.makedirs(os.path.join(JOBS_DIR, job["id"]), exist_ok=True)
    with QCOND:
        JOBS[job["id"]] = job
        QUEUE.append(job["id"])
        QCOND.notify()
    while len(JOBS) > 200:
        JOBS.popitem(last=False)
    return job


def run_job(job):
    engine, voice = job["engine"], job["voice"]
    ref_path = ref_text = None
    if engine in ("chatterbox", "dia") and voice != "default":
        ref_path, ref_text = get_ref(voice)
    voice_arg = voice if engine in ("kokoro", "orpheus") else None
    jdir = os.path.join(JOBS_DIR, job["id"])
    for ln in job["lines"]:
        if job["cancel"]:
            job["status"] = "cancelled"
            return
        params = C.resolve_params(engine, {**job["params"], **ln["params"]})
        raw = os.path.join(jdir, f"{ln['id']}.raw.wav")
        t0 = time.time()
        ENG.synth(engine, {"text": ln["text"], "voice": voice_arg, "params": params,
                           "ref_path": ref_path, "ref_text": ref_text, "out_path": raw})
        dur = postprocess(raw, os.path.join(jdir, f"{ln['id']}.wav"), job["post"])
        os.remove(raw)
        win = ln.get("window")
        job["results"].append({"id": ln["id"], "text": ln["text"], "duration": round(dur, 3),
                               "window": win, "fits": None if win is None else dur <= float(win),
                               "seconds": round(time.time() - t0, 1)})
        log(f"job {job['id']} {engine}/{voice} line {ln['id']} {dur:.2f}s")
    with zipfile.ZipFile(os.path.join(JOBS_DIR, f"{job['id']}.zip"), "w") as z:
        for r in job["results"]:
            z.write(os.path.join(jdir, f"{r['id']}.wav"), f"{r['id']}.wav")
        z.writestr("manifest.json", json.dumps(job_view(job, urls=False), indent=2))
    job["status"] = "done"


def worker_loop():
    while True:
        with QCOND:
            while not QUEUE:
                QCOND.wait()
            jid = QUEUE.pop(0)
        job = JOBS.get(jid)
        if not job or job["cancel"]:
            continue
        job["status"], job["started"] = "running", time.time()
        try:
            run_job(job)
        except Exception as e:
            traceback.print_exc()
            job["status"], job["error"] = "error", str(e)
        job["finished"] = time.time()


def job_view(job, urls=True):
    v = {k: job[k] for k in ("id", "engine", "voice", "status", "error", "label")}
    v["params"] = C.resolve_params(job["engine"], job["params"])
    v["post"] = job["post"]
    v["progress"] = {"done": len(job["results"]), "total": len(job["lines"])}
    if job["status"] == "queued":
        v["queue_position"] = QUEUE.index(job["id"]) + 1 if job["id"] in QUEUE else 0
    res = []
    for r in job["results"]:
        r = dict(r)
        if urls:
            r["url"] = sign(f"/files/{job['id']}/{r['id']}.wav")
        res.append(r)
    v["results"] = res
    if urls and job["status"] == "done":
        v["zip_url"] = sign(f"/files/{job['id']}.zip")
    for k in ("created", "started", "finished"):
        if job.get(k):
            v[k] = round(job[k], 1)
    return v


# --------------------------------------------------------------------------------------- HTTP
def catalogue():
    out = {}
    for name, spec in C.ENGINES.items():
        out[name] = {k: spec[k] for k in ("about", "voices", "presets", "params", "gpu_gb")}
        out[name]["state"] = ENG.state[name]
    refs = sorted(f[:-4] for f in os.listdir(REFS_DIR) if f.endswith(".wav"))
    return {"engines": out, "references": refs, "preset_references": list(C.PRESET_REFS),
            "post_defaults": C.POST_DEFAULTS}


def health():
    return {"ok": True, "version": C.VERSION, "uptime_s": int(time.time() - STARTED), "gpu": gpu_info(),
            "vram_budget_gb": round(ENG.budget, 1), "engines": ENG.state, "engine_errors": ENG.errors,
            "loaded": list(ENG.procs), "queue": len(QUEUE),
            "running": [j["id"] for j in JOBS.values() if j["status"] == "running"], "public_url": public_url()}


class Handler(BaseHTTPRequestHandler):
    server_version = "voicebox/" + C.VERSION

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        got = self.headers.get("Authorization", "")
        return bool(SECRET) and hmac.compare_digest(got, f"Bearer {SECRET}")

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        if n > 60 * 1024 * 1024:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/files/"):
            return self._file(u)
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        if u.path == "/health":
            return self._json(200, health())
        if u.path == "/voices":
            return self._json(200, catalogue())
        if u.path == "/jobs":
            return self._json(200, {"jobs": [job_view(j, urls=False) for j in reversed(JOBS.values())][:30]})
        m = re.match(r"^/jobs/([a-f0-9]{12})$", u.path)
        if m and m.group(1) in JOBS:
            return self._json(200, job_view(JOBS[m.group(1)]))
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        try:
            body = self._body()
            if u.path == "/jobs":
                return self._json(202, job_view(make_job(body)))
            m = re.match(r"^/jobs/([a-f0-9]{12})/cancel$", u.path)
            if m and m.group(1) in JOBS:
                JOBS[m.group(1)]["cancel"] = True
                with QCOND:
                    if m.group(1) in QUEUE:
                        QUEUE.remove(m.group(1))
                        JOBS[m.group(1)]["status"] = "cancelled"
                return self._json(200, job_view(JOBS[m.group(1)]))
            if u.path == "/refs":
                if body.get("audio_b64"):
                    data = base64.b64decode(body["audio_b64"])
                elif body.get("url"):
                    with urllib.request.urlopen(body["url"], timeout=60) as r:
                        data = r.read(50 * 1024 * 1024)
                else:
                    raise ValueError("send audio_b64 or url")
                return self._json(201, add_ref(body.get("name", ""), data, body.get("transcript")))
            m = re.match(r"^/engines/([a-z]+)/(load|unload)$", u.path)
            if m and m.group(1) in C.ENGINES:
                if m.group(2) == "unload":
                    ENG.stop(m.group(1))
                else:
                    threading.Thread(target=ENG.ensure, args=(m.group(1),), daemon=True).start()
                return self._json(200, {"engines": ENG.state})
            return self._json(404, {"error": "not found"})
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _file(self, u):
        if not check_sig(u.path, parse_qs(u.query)):
            return self._json(403, {"error": "bad or expired signature"})
        m = re.match(r"^/files/([a-f0-9]{12})(?:/([A-Za-z0-9_\-]{1,64})\.wav|\.zip)$", u.path)
        if not m:
            return self._json(404, {"error": "not found"})
        path = os.path.join(JOBS_DIR, m.group(1), f"{m.group(2)}.wav") if m.group(2) else os.path.join(JOBS_DIR, f"{m.group(1)}.zip")
        if not os.path.exists(path):
            return self._json(404, {"error": "not found"})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav" if path.endswith(".wav") else "application/zip")
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(path)}"')
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    if len(SECRET) < 24:
        sys.exit("WORKER_SECRET must be set (>= 24 chars)")
    threading.Thread(target=worker_loop, daemon=True).start()
    log(f"voicebox gateway {C.VERSION} on {a.host}:{a.port} · GPU {gpu_info()['name']} · VRAM budget {ENG.budget:.1f} GB")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
