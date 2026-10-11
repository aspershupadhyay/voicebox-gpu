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
        self.since = {n: time.time() for n in C.ENGINES}
        self.batch = {}
        self.errors = {}
        self.lock = threading.RLock()
        self.budget = float(os.environ.get("VOICEBOX_VRAM_GB") or gpu_info()["total_gb"] or 0) - 1.5

    def _set(self, name, state):
        self.state[name] = state
        self.since[name] = time.time()

    def _install(self, name):
        py = C.python_for(name)
        if os.path.exists(py):
            return py
        self._set(name, "installing")
        venv = os.path.dirname(os.path.dirname(py))
        logf = open(os.path.join(LOGS_DIR, f"{name}-install.log"), "a")
        subprocess.run(["uv", "venv", "--python", "3.11", venv, "-q", "--allow-existing"], check=True, stdout=logf, stderr=logf)
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

    def running(self, name):
        p = self.procs.get(name)
        return bool(p and p.poll() is None and self.state[name] == "ready")

    def ensure(self, name):
        with self.lock:
            p = self.procs.get(name)
            if p and p.poll() is None:
                self.procs.move_to_end(name)
                return
            try:
                py = self._install(name)
                self._evict_for(name)
                self._set(name, "loading")
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
                        with urllib.request.urlopen(f"http://127.0.0.1:{C.ENGINES[name]['port']}/ready", timeout=2) as r:
                            self.batch[name] = bool(json.loads(r.read()).get("batch"))
                        self._set(name, "ready")
                        self.errors.pop(name, None)
                        log(f"{name} ready (batch={self.batch[name]})")
                        return
                    except Exception:
                        time.sleep(2)
                raise RuntimeError(f"{name} did not become ready in 30 min")
            except Exception as e:
                self._set(name, "error")
                self.errors[name] = str(e)
                self.stop(name, keep_state=True)
                raise

    def stop(self, name, keep_state=False):
        with self.lock:
            p = self.procs.pop(name, None)
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(30)
                except subprocess.TimeoutExpired:
                    p.kill()
            if not keep_state:
                self._set(name, "idle")

    def _post(self, name, path, payload):
        self.ensure(name)
        req = urllib.request.Request(f"http://127.0.0.1:{C.ENGINES[name]['port']}{path}",
                                     data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60 * 60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(json.loads(e.read() or b"{}").get("error", str(e)))

    def synth(self, name, payload):
        return self._post(name, "/synth", payload)

    def synth_batch(self, name, items):
        return self._post(name, "/synth_batch", {"items": items})["results"]

    def transcribe(self, paths, language=None):
        return self._post("whisper", "/transcribe", {"paths": paths, "language": language})["results"]


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


# --------------------------------------------------------------------------------------- text + speed model
SENT_RE = re.compile(r"(?<=[.!?।。！？…])\s+|\n+")


def split_text(text, max_chars):
    """Sentence-aware chunks of at most ~max_chars (0 = no split). Never cuts inside a word."""
    text = re.sub(r"[ \t]+", " ", text.strip())
    if not max_chars or len(text) <= max_chars:
        return [text]
    chunks, cur = [], ""
    for sent in [s.strip() for s in SENT_RE.split(text) if s.strip()]:
        while len(sent) > max_chars:  # one very long sentence: break at a comma, else at a space
            cut = max(sent.rfind(",", 0, max_chars), sent.rfind(";", 0, max_chars), sent.rfind(":", 0, max_chars))
            cut = cut + 1 if cut > max_chars // 3 else (sent.rfind(" ", 0, max_chars) if " " in sent[:max_chars] else max_chars)
            head, sent = sent[:cut].strip(), sent[cut:].strip()
            if cur:
                chunks.append(cur); cur = ""
            chunks.append(head)
        if cur and len(cur) + 1 + len(sent) > max_chars:
            chunks.append(cur); cur = sent
        else:
            cur = f"{cur} {sent}".strip()
    if cur:
        chunks.append(cur)
    return chunks


RATES_PATH = os.path.join(HOME, "rates.json")
try:
    RATES = {**C.RATE_PRIORS, **json.load(open(RATES_PATH))}
except Exception:
    RATES = dict(C.RATE_PRIORS)


def learn_rate(name, seconds, units):
    if units <= 0 or seconds <= 0:
        return
    RATES[name] = round(0.6 * RATES[name] + 0.4 * (seconds / units), 5)
    try:
        json.dump(RATES, open(RATES_PATH, "w"))
    except OSError:
        pass


def norm_words(s):
    s = re.sub(r"<[^>]{1,20}>|\([a-z ]{2,20}\)", " ", s.lower())
    return re.findall(r"[\w']+", s)


def match_score(script, heard):
    import difflib
    a, b = norm_words(script), norm_words(heard)
    return round(difflib.SequenceMatcher(None, a, b).ratio(), 3) if a and b else None


# --------------------------------------------------------------------------------------- subtitles
def cues_from_words(words, offset=0.0, style=C.SUBTITLE_STYLE):
    cues, cur = [], []
    for w in words:
        if cur:
            text = " ".join(x["w"] for x in cur + [w])
            if len(text) > style["max_chars"] or w["e"] - cur[0]["s"] > style["max_seconds"]:
                cues.append(cur); cur = []
        cur.append(w)
        if re.search(r"[.!?।。]$", w["w"]) or (re.search(r"[,;:]$", w["w"]) and len(" ".join(x["w"] for x in cur)) > 22):
            cues.append(cur); cur = []
    if cur:
        cues.append(cur)
    out = []
    for c in cues:
        s, e = c[0]["s"] + offset, c[-1]["e"] + offset
        if out and s < out[-1]["e"] + style["min_gap"]:
            out[-1]["e"] = max(out[-1]["s"] + 0.2, s - style["min_gap"])
        out.append({"s": round(s, 3), "e": round(max(e, s + 0.3), 3), "text": " ".join(x["w"] for x in c)})
    return out


def _ts(t, sep):
    t = max(0.0, t)
    h, m, s, ms = int(t // 3600), int(t % 3600 // 60), int(t % 60), int(round((t - int(t)) * 1000)) % 1000
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_srt(cues):
    return "\n".join(f"{i}\n{_ts(c['s'], ',')} --> {_ts(c['e'], ',')}\n{c['text']}\n" for i, c in enumerate(cues, 1))


def to_vtt(cues):
    return "WEBVTT\n\n" + "\n".join(f"{_ts(c['s'], '.')} --> {_ts(c['e'], '.')}\n{c['text']}\n" for c in cues)


def write_subs(jdir, stem, cues, words):
    open(os.path.join(jdir, f"{stem}.srt"), "w").write(to_srt(cues))
    open(os.path.join(jdir, f"{stem}.vtt"), "w").write(to_vtt(cues))
    json.dump({"cues": cues, "words": words}, open(os.path.join(jdir, f"{stem}.json"), "w"), ensure_ascii=False)


# --------------------------------------------------------------------------------------- jobs
JOBS = OrderedDict()
QUEUE = []
QCOND = threading.Condition()
MAX_LINES, MAX_TEXT = 1000, 100_000


def resolve_voice(engine, voice):
    spec = C.ENGINES[engine]
    voice = voice or "female"
    return spec["presets"].get(voice, voice)


def _enqueue(job):
    os.makedirs(os.path.join(JOBS_DIR, job["id"]), exist_ok=True)
    with QCOND:
        JOBS[job["id"]] = job
        QUEUE.append(job["id"])
        QCOND.notify()
    while len(JOBS) > 300:
        JOBS.popitem(last=False)
    return job


def _base_job(kind, body):
    return {"id": uuid.uuid4().hex[:12], "kind": kind, "status": "queued", "created": time.time(), "results": [],
            "error": None, "cancel": False, "label": str(body.get("label") or "")[:120], "stage": "queued",
            "est_total": 0.0, "est_done": 0.0, "cur": None, "language": body.get("language") or None, "warnings": []}


def make_job(body):
    if body.get("kind") == "transcribe":
        return make_transcribe_job(body)
    engine = body.get("engine")
    if engine not in C.TTS_ENGINES:
        raise ValueError(f"engine must be one of {C.TTS_ENGINES}")
    lines = body.get("lines") or []
    if not lines or len(lines) > MAX_LINES:
        raise ValueError(f"lines must contain 1-{MAX_LINES} items")
    clean, seen = [], set()
    for i, ln in enumerate(lines):
        lid = str(ln.get("id") or f"{i + 1:02d}")
        text = str(ln.get("text", "")).strip()
        if not ID_RE.match(lid) or not text:
            raise ValueError(f"line {i + 1}: needs an id (letters/digits/-/_) and non-empty text")
        if lid in seen:
            raise ValueError(f"line {i + 1}: duplicate id '{lid}'")
        if len(text) > MAX_TEXT:
            raise ValueError(f"line {lid}: text over {MAX_TEXT} characters; split it into several lines")
        seen.add(lid)
        clean.append({"id": lid, "text": text, "window": ln.get("window"), "start": ln.get("start"), "params": ln.get("params") or {}})
    job = _base_job("tts", body)
    job.update({"engine": engine, "voice": resolve_voice(engine, body.get("voice")), "params": body.get("params") or {},
                "post": {**C.POST_DEFAULTS, **(body.get("post") or {})}, "lines": clean,
                "subtitles": bool(body.get("subtitles"))})
    chars = sum(len(l["text"]) for l in clean)
    job["est_total"] = RATES[engine] * chars + (RATES["whisper"] * chars / 14 if job["subtitles"] else 0)
    return _enqueue(job)


def make_transcribe_job(body):
    srcs = body.get("sources") or []
    if not srcs or len(srcs) > 200:
        raise ValueError("sources must contain 1-200 items of {id, url, text?}")
    clean = []
    for i, s in enumerate(srcs):
        sid = str(s.get("id") or f"{i + 1:02d}")
        if not ID_RE.match(sid) or not str(s.get("url", "")).startswith(("http://", "https://")):
            raise ValueError(f"source {i + 1}: needs an id and an http(s) url")
        clean.append({"id": sid, "url": s["url"], "text": s.get("text"), "name": str(s.get("name") or sid)[:200],
                      "start": s.get("start")})
    job = _base_job("transcribe", body)
    job.update({"engine": "whisper", "voice": "", "lines": clean, "params": {}, "post": {},
                "combine": bool(body.get("combine")), "attach_to": str(body.get("attach_to") or "")[:64]})
    job["est_total"] = len(clean) * 30 * RATES["whisper"]  # refined once durations are known
    return _enqueue(job)


class Cancelled(Exception):
    pass


def _run_unit(job, est, fn):
    """Run one unit of work while the job view interpolates progress from the speed model."""
    if job["cancel"]:
        raise Cancelled()
    job["cur"] = {"t0": time.time(), "est": max(est, 0.5)}
    try:
        return fn()
    finally:
        job["est_done"] += est
        job["cur"] = None


def _prepare(job, name):
    job["stage"] = "preparing:" + name
    ENG.ensure(name)


def _join_chunks(paths, out_path, gap=0.2):
    import numpy as np
    import soundfile as sf
    parts, sr = [], None
    for p in paths:
        a, sr_ = sf.read(p, dtype="float32", always_2d=False)
        if a.ndim > 1:
            a = a.mean(axis=1)
        sr = sr or sr_
        if len(paths) > 1:
            idx = np.where(np.abs(a) > 10 ** (-45 / 20))[0]
            if len(idx):
                a = a[max(0, idx[0] - int(0.04 * sr)): idx[-1] + int(0.06 * sr)]
        parts.append(a)
        parts.append(np.zeros(int(gap * sr), dtype="float32"))
    sf.write(out_path, np.concatenate(parts[:-1]) if parts else np.zeros(1, "float32"), sr)


def run_tts(job):
    engine, voice = job["engine"], job["voice"]
    jdir = os.path.join(JOBS_DIR, job["id"])
    ref_path = ref_text = None
    if engine == "chatterbox" and voice != "default":
        job["stage"] = "reference"
        ref_path, ref_text = get_ref(voice)
    voice_arg = voice if engine in ("kokoro", "orpheus") else None
    _prepare(job, engine)
    job["stage"] = "generating"
    max_chars = C.ENGINES[engine].get("chunk_chars", 0)

    plan = []  # (line, [chunk texts])
    for ln in job["lines"]:
        plan.append((ln, split_text(ln["text"], max_chars)))
    if any(len(c) > 1 for _, c in plan):
        job["warnings"].append(f"long lines split into {sum(len(c) for _, c in plan)} sentence chunks and re-joined")

    # group lines: big batches on batch engines (vLLM), one line at a time elsewhere
    groups, cur, n = [], [], 0
    batch_size = 24 if ENG.batch.get(engine) else 1
    for item in plan:
        cur.append(item); n += len(item[1])
        if n >= batch_size:
            groups.append(cur); cur, n = [], 0
    if cur:
        groups.append(cur)

    for group in groups:
        items, owners = [], []
        for ln, chunks in group:
            params = C.resolve_params(engine, {**job["params"], **ln["params"]})
            for k, text in enumerate(chunks):
                items.append({"text": text, "voice": voice_arg, "params": params, "ref_path": ref_path, "ref_text": ref_text,
                              "out_path": os.path.join(jdir, f"{ln['id']}.c{k}.wav")})
                owners.append(ln["id"])
        chars = sum(len(it["text"]) for it in items)
        t0 = time.time()
        res = _run_unit(job, RATES[engine] * chars, lambda: ENG.synth_batch(engine, items))
        learn_rate(engine, time.time() - t0, chars)
        errs = [r["error"] for r in res if "error" in r]
        if errs:
            raise RuntimeError(errs[0])
        for ln, chunks in group:
            raw = os.path.join(jdir, f"{ln['id']}.raw.wav")
            paths = [os.path.join(jdir, f"{ln['id']}.c{k}.wav") for k in range(len(chunks))]
            _join_chunks(paths, raw)
            for p in paths:
                os.remove(p)
            dur = postprocess(raw, os.path.join(jdir, f"{ln['id']}.wav"), job["post"])
            os.remove(raw)
            win = ln.get("window")
            job["results"].append({"id": ln["id"], "text": ln["text"], "duration": round(dur, 3), "window": win,
                                   "start": ln.get("start"), "chunks": len(chunks),
                                   "fits": None if win in (None, "") else dur <= float(win)})
        log(f"job {job['id']} {engine}/{voice} {len(job['results'])}/{len(job['lines'])} lines")

    if job["subtitles"]:
        subtitle_tts(job, jdir)


def subtitle_tts(job, jdir):
    _prepare(job, "whisper")
    job["stage"] = "subtitles"
    res_by_id = {r["id"]: r for r in job["results"]}
    ids = [r["id"] for r in job["results"]]
    for i in range(0, len(ids), 8):
        batch = ids[i:i + 8]
        audio_s = sum(res_by_id[x]["duration"] for x in batch)
        t0 = time.time()
        outs = _run_unit(job, RATES["whisper"] * audio_s,
                         lambda: ENG.transcribe([os.path.join(jdir, f"{x}.wav") for x in batch], job.get("language")))
        learn_rate("whisper", time.time() - t0, audio_s)
        for x, o in zip(batch, outs):
            r = res_by_id[x]
            r["heard"] = o["text"]
            r["match"] = match_score(r["text"], o["text"])
            r["words"] = o["words"]
            cues = cues_from_words(o["words"])
            write_subs(jdir, f"{x}.subs", cues, o["words"])
            r["subs"] = True
    # one subtitle file for the whole timeline: real starts when given, else lines back to back
    t, cues, words = 0.0, [], []
    for r in job["results"]:
        off = float(r["start"]) if r.get("start") not in (None, "") else t
        cues += cues_from_words(r.get("words") or [], off)
        words += [{**w, "s": round(w["s"] + off, 3), "e": round(w["e"] + off, 3), "line": r["id"]} for w in r.get("words") or []]
        t = off + r["duration"]
    write_subs(jdir, "subtitles", cues, words)
    job["subs"] = {"cues": len(cues), "timeline": "starts" if any(r.get("start") not in (None, "") for r in job["results"]) else "sequential"}
    scores = [r["match"] for r in job["results"] if r.get("match") is not None]
    job["match"] = round(sum(scores) / len(scores), 3) if scores else None


def run_transcribe(job):
    jdir = os.path.join(JOBS_DIR, job["id"])
    job["stage"] = "downloading"
    paths = []
    for s in job["lines"]:
        if job["cancel"]:
            raise Cancelled()
        ext = os.path.splitext(urlparse(s["url"]).path)[1][:6] or ".bin"
        p = os.path.join(jdir, f"{s['id']}.src{ext}")
        with urllib.request.urlopen(s["url"], timeout=300) as r, open(p, "wb") as f:
            shutil.copyfileobj(r, f)
        paths.append(p)
    try:
        import soundfile as sf
        total_audio = sum(sf.info(p).duration for p in paths)
    except Exception:
        total_audio = 60.0 * len(paths)
    job["est_total"] = RATES["whisper"] * total_audio + 1
    _prepare(job, "whisper")
    job["stage"] = "transcribing"
    t_all, cues_all, words_all = 0.0, [], []
    for s, p in zip(job["lines"], paths):
        try:
            import soundfile as sf
            dur = sf.info(p).duration
        except Exception:
            dur = 60.0
        t0 = time.time()
        o = _run_unit(job, RATES["whisper"] * dur, lambda: ENG.transcribe([p], job.get("language"))[0])
        learn_rate("whisper", time.time() - t0, max(dur, 1))
        cues = cues_from_words(o["words"])
        write_subs(jdir, f"{s['id']}.subs", cues, o["words"])
        job["results"].append({"id": s["id"], "name": s["name"], "text": s.get("text") or "", "heard": o["text"],
                               "duration": o["duration"], "cues": len(cues), "words": o["words"], "subs": True,
                               "match": match_score(s["text"], o["text"]) if s.get("text") else None})
        off = float(s["start"]) if s.get("start") not in (None, "") else t_all
        cues_all += cues_from_words(o["words"], off)
        if s.get("text"):
            sc = [r["match"] for r in job["results"] if r.get("match") is not None]
            job["match"] = round(sum(sc) / len(sc), 3) if sc else None
        words_all += [{**w, "s": round(w["s"] + off, 3), "e": round(w["e"] + off, 3), "line": s["id"]} for w in o["words"]]
        t_all = off + o["duration"]
        os.remove(p)
    write_subs(jdir, "subtitles", cues_all, words_all)
    job["subs"] = {"cues": len(cues_all), "timeline": "sequential"}


def package(job):
    job["stage"] = "packaging"
    jdir = os.path.join(JOBS_DIR, job["id"])
    with zipfile.ZipFile(os.path.join(JOBS_DIR, f"{job['id']}.zip"), "w") as z:
        for f in sorted(os.listdir(jdir)):
            if f.endswith((".wav", ".srt", ".vtt")) or (f.endswith(".json") and ".subs" in f) or f == "subtitles.json":
                z.write(os.path.join(jdir, f), f)
        z.writestr("manifest.json", json.dumps(job_view(job, urls=False), indent=2))


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
            (run_transcribe if job["kind"] == "transcribe" else run_tts)(job)
            package(job)
            job["status"], job["stage"] = "done", "done"
        except Cancelled:
            job["status"], job["stage"] = "cancelled", "cancelled"
        except Exception as e:
            traceback.print_exc()
            job["status"], job["stage"], job["error"] = "error", "error", str(e)
        job["finished"] = time.time()


def _progress(job):
    """(fraction, eta_seconds, stage, stage_detail) from the live speed model; honest, never stuck at 100%."""
    now = time.time()
    stage = job["stage"]
    if job["status"] == "done":
        return 1.0, 0, "done", ""
    if job["status"] in ("error", "cancelled"):
        return min(1.0, job["est_done"] / max(job["est_total"], 1e-6)), 0, job["status"], ""
    if job["status"] == "queued":
        ahead = [JOBS[j] for j in QUEUE[:QUEUE.index(job["id"])]] if job["id"] in QUEUE else []
        wait = sum(max(0, j["est_total"] - j["est_done"]) for j in ahead)
        for r in (JOBS[x] for x in JOBS if JOBS[x]["status"] == "running"):
            wait += max(0, r["est_total"] - r["est_done"])
        return 0.0, round(wait), "queued", f"{len(ahead)} job(s) ahead"
    extra, detail = 0.0, ""
    if stage.startswith("preparing:"):
        name = stage.split(":", 1)[1]
        st = ENG.state[name]
        prior = C.INSTALL_PRIORS[name] if st == "installing" else C.LOAD_PRIORS[name]
        left = max(5, prior - (now - ENG.since[name]))
        stage = "installing" if st == "installing" else "loading"
        detail = f"{name}: first run downloads the model" if st == "installing" else f"loading {name} into memory"
        extra = left
    cur = job.get("cur")
    partial = min(0.95, (now - cur["t0"]) / cur["est"]) * cur["est"] if cur else 0.0
    done = job["est_done"] + partial
    total = max(job["est_total"], done + 0.1)
    frac = min(0.99, done / total)
    # scale ETA by how this job is actually running vs the model
    spent = now - job.get("started", now)
    speed = (spent / done) if done > 2 and not extra else 1.0
    eta = (total - done) * min(max(speed, 0.5), 3.0) + extra
    if stage == "generating":
        detail = f"line {min(len(job['results']) + 1, len(job['lines']))} of {len(job['lines'])}"
    elif stage == "subtitles":
        detail = "Whisper large-v3, word timestamps"
    elif stage == "transcribing":
        detail = f"file {min(len(job['results']) + 1, len(job['lines']))} of {len(job['lines'])}"
    return frac, round(eta), stage, detail


def job_view(job, urls=True):
    v = {k: job.get(k) for k in ("id", "kind", "engine", "voice", "status", "error", "label", "language", "warnings", "subs", "match", "attach_to")}
    if job["kind"] == "tts":
        v["params"] = C.resolve_params(job["engine"], job["params"])
        v["post"] = job["post"]
        v["subtitles"] = job.get("subtitles")
    frac, eta, stage, detail = _progress(job)
    v["progress"] = {"done": len(job["results"]), "total": len(job["lines"]), "fraction": round(frac, 4),
                     "eta_s": eta, "stage": stage, "detail": detail,
                     "elapsed_s": round((job.get("finished") or time.time()) - job.get("started", time.time()), 1)
                     if job.get("started") else 0}
    if job["status"] == "queued":
        v["queue_position"] = QUEUE.index(job["id"]) + 1 if job["id"] in QUEUE else 0
    res = []
    for r in job["results"]:
        r = {k: val for k, val in r.items() if k != "words"} if urls else dict(r)
        if urls:
            if job["kind"] == "tts":
                r["url"] = sign(f"/files/{job['id']}/{r['id']}.wav")
            if r.get("subs"):
                r["srt_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.srt")
                r["vtt_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.vtt")
                r["json_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.json")
        res.append(r)
    v["results"] = res
    if urls and job["status"] == "done":
        v["zip_url"] = sign(f"/files/{job['id']}.zip")
        if job.get("subs"):
            v["subs_urls"] = {ext: sign(f"/files/{job['id']}/subtitles.{ext}") for ext in ("srt", "vtt", "json")}
    for k in ("created", "started", "finished"):
        if job.get(k):
            v[k] = round(job[k], 1)
    return v


def catalogue():
    out = {}
    for name, spec in C.ENGINES.items():
        out[name] = {k: spec.get(k) for k in ("kind", "about", "voices", "presets", "params", "gpu_gb", "chunk_chars")}
        out[name]["state"] = ENG.state[name]
        out[name]["seconds_per_char" if spec["kind"] == "tts" else "seconds_per_audio_second"] = RATES.get(name)
    refs = sorted(f[:-4] for f in os.listdir(REFS_DIR) if f.endswith(".wav"))
    return {"engines": out, "references": refs, "preset_references": list(C.PRESET_REFS),
            "post_defaults": C.POST_DEFAULTS, "subtitle_style": C.SUBTITLE_STYLE}


def health():
    return {"ok": True, "version": C.VERSION, "uptime_s": int(time.time() - STARTED), "gpu": gpu_info(),
            "vram_budget_gb": round(ENG.budget, 1), "engines": ENG.state, "engine_errors": ENG.errors,
            "loaded": list(ENG.procs), "queue": len(QUEUE), "rates": RATES,
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
        m = re.match(r"^/files/([a-f0-9]{12})(?:/([A-Za-z0-9_\-]{1,64}(?:\.subs)?\.(?:wav|srt|vtt|json))|\.zip)$", u.path)
        if not m:
            return self._json(404, {"error": "not found"})
        path = os.path.join(JOBS_DIR, m.group(1), m.group(2)) if m.group(2) else os.path.join(JOBS_DIR, f"{m.group(1)}.zip")
        if not os.path.exists(path):
            return self._json(404, {"error": "not found"})
        self.send_response(200)
        ctype = {".wav": "audio/wav", ".zip": "application/zip", ".srt": "application/x-subrip", ".vtt": "text/vtt",
                 ".json": "application/json"}[os.path.splitext(path)[1]]
        self.send_header("Content-Type", ctype)
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
