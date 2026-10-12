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
JOBS_DIR, REFS_DIR, LOGS_DIR, CACHE_DIR = (os.path.join(HOME, d) for d in ("jobs", "refs", "logs", "hf"))
for d in (JOBS_DIR, REFS_DIR, LOGS_DIR, CACHE_DIR):
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


def mem_info():
    """System RAM in GB (Linux /proc/meminfo); zeros elsewhere."""
    try:
        m = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo")}
        return {"total_gb": round(m["MemTotal"] / 2**20, 1), "used_gb": round((m["MemTotal"] - m["MemAvailable"]) / 2**20, 1)}
    except Exception:
        return {"total_gb": 0.0, "used_gb": 0.0}


# --------------------------------------------------------------------------------------- disk
def cache_dir(name):
    """Every engine downloads its weights into its own folder, so one engine's weights can be dropped alone."""
    return os.path.join(CACHE_DIR, name)


_SIZES = {}


def dir_gb(path, max_age=60):
    hit = _SIZES.get(path)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    _SIZES[path] = (time.time(), round(total / 1e9, 2))
    return _SIZES[path][1]


def disk_info():
    du = shutil.disk_usage(HOME)
    return {"total_gb": round(du.total / 1e9, 1), "free_gb": round(du.free / 1e9, 1),
            "weights_gb": {n: dir_gb(cache_dir(n)) for n in C.ENGINES if os.path.isdir(cache_dir(n))}}


USAGE_PATH = os.path.join(HOME, "usage.json")
try:
    USAGE = json.load(open(USAGE_PATH))
except Exception:
    USAGE = {}


def mark_used(name):
    USAGE[name] = time.time()
    try:
        json.dump(USAGE, open(USAGE_PATH, "w"))
    except OSError:
        pass


# --------------------------------------------------------------------------------------- engines
class Engines:
    """Starts engine processes lazily and keeps the machine lean:
      - one resource group at a time: a video engine stops every voice engine and vice versa (VRAM + RAM),
      - least-recently-used eviction inside a group when VRAM would overflow,
      - idle engines are unloaded after C.IDLE_MIN minutes,
      - weights download on first use only, and old weights are deleted when the disk runs short."""

    def __init__(self):
        self.procs = OrderedDict()   # name -> Popen, in LRU order
        self.state = {n: "idle" for n in C.ENGINES}
        self.since = {n: time.time() for n in C.ENGINES}
        self.last = {n: 0.0 for n in C.ENGINES}   # last request served (for idle unload)
        self.inflight = {n: 0 for n in C.ENGINES}
        self.batch = {}
        self.errors = {}
        self.lock = threading.RLock()
        self.budget = float(os.environ.get("VOICEBOX_VRAM_GB") or gpu_info()["total_gb"] or 0) - 1.5
        threading.Thread(target=self._reaper, daemon=True).start()

    def _set(self, name, state):
        self.state[name] = state
        self.since[name] = time.time()

    @property
    def mode(self):
        groups = {C.ENGINES[n]["group"] for n in self.procs}
        return groups.pop() if len(groups) == 1 else ("mixed" if groups else "idle")

    def idle_left(self):
        """Seconds until each loaded, unused engine is unloaded."""
        out = {}
        for n in list(self.procs):
            if self.state[n] == "ready" and not self.inflight[n]:
                out[n] = max(0, round(C.IDLE_MIN * 60 - (time.time() - max(self.last[n], self.since[n]))))
        return out

    def _reaper(self):
        while True:
            time.sleep(20)
            busy = any(j["status"] == "running" for j in list(JOBS.values()))
            for n, left in self.idle_left().items():
                if left <= 0 and not busy:
                    log(f"unloading {n}: idle for {C.IDLE_MIN:g} min")
                    self.stop(n)

    def _install(self, name):
        py = C.python_for(name)
        if os.path.exists(py):
            return py
        self._set(name, "installing")
        venv = os.path.dirname(os.path.dirname(py))
        logf = open(os.path.join(LOGS_DIR, f"{name}-install.log"), "a")
        apt = C.ENGINES[name].get("apt")
        if apt and shutil.which("apt-get") and not all(shutil.which(b) for b in apt.split()):
            subprocess.run(f"apt-get install -y -qq {apt}", shell=True, stdout=logf, stderr=logf)
        subprocess.run(["uv", "venv", "--python", "3.11", venv, "-q", "--allow-existing"], check=True, stdout=logf, stderr=logf)
        subprocess.run(f'uv pip install --python {py} -q {C.ENGINES[name]["packages"]}', shell=True, check=True,
                       stdout=logf, stderr=logf)
        return py

    def _switch_group(self, name):
        group = C.ENGINES[name]["group"]
        others = [n for n in self.procs if C.ENGINES[n]["group"] != group]
        busy = [n for n in others if self.inflight[n]]
        if busy:
            raise RuntimeError(f"{busy[0]} is busy right now; {name} can start when it finishes")
        for other in others:
            log(f"stopping {other}: switching to {group} models")
            self.stop(other)

    def _ensure_disk(self, name):
        """Make room for a first download by deleting the least-recently-used weights of stopped engines."""
        have = dir_gb(cache_dir(name), max_age=0) if os.path.isdir(cache_dir(name)) else 0.0
        need = max(0.0, C.ENGINES[name].get("disk_gb", 0) - have) + C.DISK_RESERVE_GB
        free = shutil.disk_usage(HOME).free / 1e9
        if free >= need:
            return
        legacy = os.path.expanduser("~/.cache/huggingface")
        victims = ([legacy] if os.path.isdir(legacy) else []) + [
            cache_dir(n) for n in sorted(C.ENGINES, key=lambda n: USAGE.get(n, 0))
            if n != name and n not in self.procs and os.path.isdir(cache_dir(n))]
        for v in victims:
            log(f"disk: deleting {v} ({dir_gb(v):.1f} GB) to make room for {name}")
            shutil.rmtree(v, ignore_errors=True)
            _SIZES.pop(v, None)
            free = shutil.disk_usage(HOME).free / 1e9
            if free >= need:
                return
        raise RuntimeError(f"not enough disk for {name}: needs ~{need:.0f} GB free, {free:.0f} GB left")

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
                self._switch_group(name)
                self._ensure_disk(name)
                py = self._install(name)
                self._evict_for(name)
                self._set(name, "loading")
                mark_used(name)
                logf = open(os.path.join(LOGS_DIR, f"{name}.log"), "a")
                venv_bin = os.path.dirname(py)
                cache = cache_dir(name)
                env = {**os.environ, "VOICEBOX_HOME": HOME, "PATH": venv_bin + os.pathsep + os.environ.get("PATH", ""),
                       "HF_HOME": cache, "KOKORO_MODEL_DIR": cache, "HF_HUB_ENABLE_HF_TRANSFER": "0",
                       "VLLM_USE_FLASHINFER_SAMPLER": "0", "TOKENIZERS_PARALLELISM": "false",
                       "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
                p = subprocess.Popen([py, os.path.join(HERE, "engine_host.py"), "--engine", name,
                                      "--port", str(C.ENGINES[name]["port"])], stdout=logf, stderr=logf, env=env, cwd=HERE,
                                     start_new_session=True)  # own process group: stop() also kills vLLM's children
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
            if p:
                import signal
                for sig, wait in ((signal.SIGTERM, 30), (signal.SIGKILL, 10)):
                    try:
                        os.killpg(p.pid, sig)
                    except (ProcessLookupError, PermissionError):
                        break
                    try:
                        p.wait(wait)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                time.sleep(1)
            if not keep_state:
                self._set(name, "idle")

    def _post(self, name, path, payload, timeout=60 * 60):
        self.ensure(name)
        req = urllib.request.Request(f"http://127.0.0.1:{C.ENGINES[name]['port']}{path}",
                                     data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        self.inflight[name] += 1
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(json.loads(e.read() or b"{}").get("error", str(e)))
        finally:
            self.inflight[name] -= 1
            self.last[name] = time.time()
            mark_used(name)

    def synth(self, name, payload):
        return self._post(name, "/synth", payload)

    def synth_batch(self, name, items):
        return self._post(name, "/synth_batch", {"items": items})["results"]

    def transcribe(self, paths, language=None):
        return self._post("whisper", "/transcribe", {"paths": paths, "language": language})["results"]

    def video(self, name, payload):
        return self._post(name, "/video", payload, timeout=3 * 60 * 60)


ENG = Engines()


# --------------------------------------------------------------------------------------- references
def ref_paths(name):
    return os.path.join(REFS_DIR, f"{name}.wav"), os.path.join(REFS_DIR, f"{name}.json")


def get_ref(name, sync=None):
    """Return (wav_path, transcript) for a reference voice, building the female/male presets on demand.
    sync = {"url", "transcript"}: the dashboard's permanent copy (R2), fetched when this worker lacks it or
    holds an older version (the Colab disk is wiped whenever the runtime is recycled)."""
    wav, meta = ref_paths(name)
    if sync and sync.get("url"):
        have = json.load(open(meta)) if os.path.exists(meta) else {}
        if not os.path.exists(wav) or have.get("version") != sync.get("version"):
            if not ID_RE.match(name):
                raise ValueError("bad reference name")
            log(f"syncing reference '{name}' from storage")
            with urllib.request.urlopen(sync["url"], timeout=120) as r, open(wav + ".dl", "wb") as f:
                shutil.copyfileobj(r, f)
            os.replace(wav + ".dl", wav)
            json.dump({"transcript": sync.get("transcript"), "version": sync.get("version"), "source": "storage"}, open(meta, "w"))
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
    tempo = float(post.get("tempo") or 1.0)
    if abs(tempo - 1.0) > 0.005 and len(audio):
        # pitch-preserving speed-up/slow-down (WSOLA): the only pace control for engines without a speed knob
        tmp_in, tmp_out = dst + ".tin.wav", dst + ".tout.wav"
        sf.write(tmp_in, audio, sr, subtype="FLOAT")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp_in, "-filter:a", f"atempo={max(0.5, min(2.0, tempo)):.4f}", tmp_out], check=True)
        audio, sr = sf.read(tmp_out, dtype="float32", always_2d=False)
        for f in (tmp_in, tmp_out):
            os.remove(f)
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


ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def num_words(n):
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000:
        return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + num_words(n % 100))
    if n < 1_000_000:
        return num_words(n // 1000) + " thousand" + ("" if n % 1000 == 0 else " " + num_words(n % 1000))
    return str(n)


def norm_words(s):
    s = re.sub(r"<[^>]{1,20}>|\([a-z ]{2,20}\)", " ", s.lower())
    s = re.sub(r"\b((?:[a-z]\.){2,})", lambda m: m.group(1).replace(".", ""), s)  # g.p.s. -> gps
    s = re.sub(r"(?<=\w)-(?=\w)", "", s)  # non-stop -> nonstop
    s = re.sub(r"\d[\d,]*", lambda m: num_words(int(m.group(0).replace(",", ""))) if m.group(0).replace(",", "").isdigit() and len(m.group(0)) < 8 else m.group(0), s)
    s = s.replace("percent", "per cent").replace("%", " per cent")
    return re.findall(r"[\w']+", s.replace("per cent", "percent"))


def match_score(script, heard):
    import difflib
    a, b = norm_words(script), norm_words(heard)
    return round(difflib.SequenceMatcher(None, a, b).ratio(), 3) if a and b else None


# --------------------------------------------------------------------------------------- subtitles
def cues_from_words(words, offset=0.0, style=C.SUBTITLE_STYLE):
    """Caption cues the way subtitlers cut them: one sentence per cue when it fits (with ~20% grace so a
    single word is never orphaned), otherwise the sentence is split into balanced parts, preferring
    breaks after commas. Times come from the word timestamps."""
    max_c, max_s = style["max_chars"], style["max_seconds"]
    sentences, cur = [], []
    for w in words:
        cur.append(w)
        if re.search(r"[.!?।。！？…]$", w["w"]):
            sentences.append(cur); cur = []
    if cur:
        sentences.append(cur)

    def text(ws):
        return re.sub(r"\s+(?=[.,!?;:%\u2019]|-\S)", "", " ".join(x["w"] for x in ws))  # "non -stop" -> "non-stop"

    def split(ws):
        t, dur = text(ws), ws[-1]["e"] - ws[0]["s"]
        if len(ws) <= 1 or (len(t) <= max_c * 1.2 and dur <= max_s * 1.3):
            return [ws]
        parts = max(2, -(-len(t) // max_c), int(-(-dur // max_s)))
        target = len(t) / parts
        best, best_cost, pos = 1, 1e9, 0
        for i in range(1, len(ws)):  # choose the cut closest to the target, bonus after punctuation
            pos += len(ws[i - 1]["w"]) + 1
            cost = abs(pos - target) - (12 if re.search(r"[,;:—–-]$", ws[i - 1]["w"]) else 0)
            if cost < best_cost:
                best, best_cost = i, cost
        return split(ws[:best]) + split(ws[best:])

    out = []
    for sent in sentences:
        for k, c in enumerate(split(sent)):
            st, en = c[0]["s"] + offset, c[-1]["e"] + offset
            if out and st < out[-1]["e"] + style["min_gap"]:
                out[-1]["e"] = max(out[-1]["s"] + 0.2, st - style["min_gap"])
            t = text(c)
            if k == 0:  # Whisper sometimes lower-cases a sentence that opens a 30 s window
                t = t[:1].upper() + t[1:]
            out.append({"s": round(st, 3), "e": round(max(en, st + 0.3), 3), "text": t})
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
    if body.get("kind") == "video":
        return make_video_job(body)
    if body.get("kind") == "reference":
        return make_reference_job(body)
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
    style = body.get("style") or C.DEFAULT_STYLE
    style_params, style_post = C.style_settings(style, engine)
    job = _base_job("tts", body)
    job.update({"engine": engine, "voice": resolve_voice(engine, body.get("voice")), "style": style,
                "params": {**style_params, **(body.get("params") or {})},
                "post": {**C.POST_DEFAULTS, **style_post, **(body.get("post") or {})}, "lines": clean,
                "subtitles": bool(body.get("subtitles")), "ref": body.get("ref") if isinstance(body.get("ref"), dict) else None})
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


def make_video_job(body):
    model = body.get("model") or "wan"
    if model not in C.VIDEO_ENGINES:
        raise ValueError(f"model must be one of {C.VIDEO_ENGINES}")
    spec = C.ENGINES[model]
    prompt = str(body.get("prompt") or "").strip()
    if not 3 <= len(prompt) <= 4000:
        raise ValueError("prompt must be 3-4000 characters")
    aspect = body.get("aspect") or "9:16"
    if aspect not in spec["sizes"]:
        raise ValueError(f"aspect must be one of {list(spec['sizes'])}")
    quality = body.get("quality") or "fast"
    if quality not in spec["qualities"]:
        raise ValueError(f"quality must be one of {list(spec['qualities'])} for {model}")
    q = spec["qualities"][quality]
    w, h = spec["sizes"][aspect]
    fps, step = spec["fps"], spec["frame_step"]
    seconds = max(1.0, min(spec["max_seconds"], float(body.get("seconds") or 5)))
    frames = max(1, round(seconds * fps / step)) * step + 1
    steps = q["steps"] if model == "ltx" else max(1, min(60, int(body.get("steps") or q["steps"])))
    image = str(body.get("image_url") or "")
    if image and not image.startswith(("https://", "http://")):
        raise ValueError("image_url must be an http(s) URL")
    if spec.get("image_only") and not image:
        raise ValueError(f"{model} is image-to-video only: give it a start frame (image_url or from_library)")
    if spec.get("min_gpu_gb") and gpu_info()["total_gb"] < spec["min_gpu_gb"]:
        raise ValueError(f"{model} needs a {spec['min_gpu_gb']:g} GB+ GPU (A100 class); this runtime has {gpu_info()['total_gb']:g} GB")
    adult = bool(body.get("adult")) and bool(spec.get("adult"))
    seed = body.get("seed")
    job = _base_job("video", body)
    job.update({"engine": model, "voice": "", "lines": [], "params": {}, "post": {}, "image_url": image or None,
                "gen": {"model": model, "mode": "i2v" if image else "t2v", "prompt": prompt,
                        "negative": str(body.get("negative") or "")[:2000], "seed": int(seed) if seed not in (None, "") else 7,
                        "steps": steps, "guidance": float(q["guidance"]), "quality": quality, "aspect": aspect, "fps": fps,
                        "frames": frames, "seconds": round((frames - 1) / fps, 2), "width": w, "height": h,
                        "audio": bool(body.get("audio", True)) and model == "ltx", "adult": adult}})
    job["est_total"] = video_estimate(job["gen"]) + 25
    return _enqueue(job)


def video_estimate(g):
    """Seconds to render: learned seconds per (step x frame x megapixel), doubled when CFG runs two passes."""
    return RATES[g["model"]] * g["steps"] * g["frames"] * g["width"] * g["height"] / 1e6 * (2 if g["guidance"] > 1 else 1)


def make_reference_job(body):
    name = str(body.get("name") or "")
    if not ID_RE.match(name) or name in C.PRESET_REFS or name == "default":
        raise ValueError("name: 1-64 letters, digits, - or _ (and not female/male/default)")
    url = str(body.get("url") or "")
    if not url.startswith(("https://", "http://")):
        raise ValueError("url must point at the recording")
    job = _base_job("reference", body)
    job.update({"engine": "whisper", "voice": name, "lines": [{"id": "reference", "url": url}], "params": {}, "post": {},
                "transcript": str(body.get("transcript") or "").strip() or None, "version": str(body.get("version") or "")[:40]})
    job["est_total"] = 25.0
    return _enqueue(job)


class Cancelled(Exception):
    pass


def _run_unit(job, est, fn, label=""):
    """Run one unit of work while the job view interpolates progress from the speed model.
    If the unit overruns its estimate, the job total grows with it so progress never stalls or jumps back."""
    if job["cancel"]:
        raise Cancelled()
    job["cur"] = {"t0": time.time(), "est": max(est, 0.5), "label": label}
    try:
        return fn()
    finally:
        spent = time.time() - job["cur"]["t0"]
        job["est_total"] += spent - job["cur"]["est"]  # replace the guess with what it really took
        job["est_done"] += spent
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
    if C.ENGINES[engine].get("clone") or (engine == "chatterbox" and voice != "default"):
        job["stage"] = "reference"
        ref_path, ref_text = get_ref(voice, job.get("ref"))
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
    batch_size = 8 if ENG.batch.get(engine) else 1
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
        first, last = len(job["results"]) + 1, len(job["results"]) + len(group)
        label = f"line {first} of {len(job['lines'])}" if first == last else f"lines {first}–{last} of {len(job['lines'])} together"
        res = _run_unit(job, RATES[engine] * chars, lambda: ENG.synth_batch(engine, items), label)
        if ENG.batch.get(engine) and len(items) > 1:
            learn_rate(engine, time.time() - t0, chars)
        elif not ENG.batch.get(engine):
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
        try:
            subtitle_tts(job, jdir)
        except Cancelled:
            raise
        except Exception as e:  # the voiceover is done; don't lose it over subtitles
            traceback.print_exc()
            job["warnings"].append(f"subtitles failed ({type(e).__name__}); audio is saved, run subtitles again from the Library")
            for r in job["results"]:
                r.pop("words", None); r.pop("subs", None)


def subtitle_tts(job, jdir):
    _prepare(job, "whisper")
    job["stage"] = "subtitles"
    res_by_id = {r["id"]: r for r in job["results"]}
    ids = [r["id"] for r in job["results"]]
    for i in range(0, len(ids), 4):
        batch = ids[i:i + 4]
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


def _download(url, path, limit=600 * 1024 * 1024):
    with urllib.request.urlopen(url, timeout=300) as r, open(path, "wb") as f:
        n = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            n += len(chunk)
            if n > limit:
                raise ValueError("download too large")
            f.write(chunk)


def run_video(job):
    g, model = job["gen"], job["engine"]
    jdir = os.path.join(JOBS_DIR, job["id"])
    payload = {k: g.get(k) for k in ("prompt", "negative", "seed", "steps", "guidance", "quality", "fps", "audio", "adult")}
    payload.update({"width": g["width"], "height": g["height"], "num_frames": g["frames"],
                    "out_path": os.path.join(jdir, "video.mp4"), "progress_path": os.path.join(jdir, "progress.json")})
    if job.get("image_url"):
        job["stage"] = "downloading"
        raw = os.path.join(jdir, "source.in")
        _download(job["image_url"], raw, 40 * 1024 * 1024)
        src = os.path.join(jdir, "source.jpg")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-frames:v", "1", "-q:v", "2", src], check=True)
        os.remove(raw)
        payload["image_path"] = src
        g["source"] = True
    _prepare(job, model)
    job["stage"] = "rendering"
    job["progress_file"] = payload["progress_path"]
    units = g["steps"] * g["frames"] * g["width"] * g["height"] / 1e6 * (2 if g["guidance"] > 1 else 1)
    t0 = time.time()
    try:
        info = _run_unit(job, video_estimate(g), lambda: ENG.video(model, payload), f"{g['seconds']:g} s at {g['width']}x{g['height']}")
    except RuntimeError:
        if job["cancel"]:
            raise Cancelled()
        raise
    learn_rate(model, time.time() - t0, units)
    job["stage"] = "packaging"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", payload["out_path"], "-frames:v", "1", "-q:v", "3",
                    os.path.join(jdir, "poster.jpg")], check=True)
    info["size"] = os.path.getsize(payload["out_path"])
    job["video"] = {**info, "poster": True}
    job["results"] = [{"id": "video", "text": g["prompt"], "duration": info["duration"]}]


def run_reference(job):
    """Turn a raw recording into a clean cloning reference: mono, rumble + hiss removed, silence trimmed,
    level normalised, cut to <= ~20 s at a word boundary, transcribed by Whisper (cloners need the words)."""
    import numpy as np
    import soundfile as sf
    jdir = os.path.join(JOBS_DIR, job["id"])
    job["stage"] = "downloading"
    raw = os.path.join(jdir, "recording.in")
    _download(job["lines"][0]["url"], raw, 60 * 1024 * 1024)
    job["stage"] = "cleaning"
    clean = os.path.join(jdir, "clean.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-ac", "1", "-ar", "44100",
                    "-af", "highpass=f=70,lowpass=f=14000,afftdn=nf=-30", clean], check=True)
    a, sr = sf.read(clean, dtype="float32")
    peak = float(np.max(np.abs(a))) if len(a) else 0.0
    rms_db = float(20 * np.log10(max(1e-9, float(np.sqrt(np.mean(a ** 2)))))) if len(a) else -120.0
    if peak > 0.98:
        job["warnings"].append("the recording clips (too loud): move back a little or lower the input gain")
    if rms_db < -38:
        job["warnings"].append("the recording is very quiet: move closer to the mic")
    out = os.path.join(jdir, "reference.wav")
    dur = postprocess(clean, out, {"trim": True, "trim_db": -45, "normalize_dbfs": -3, "sample_rate": None})
    os.remove(raw); os.remove(clean)
    if dur < 4:
        raise ValueError(f"only {dur:.1f} s of speech: record at least 6-10 seconds")
    words, heard = [], job.get("transcript")
    if not heard or dur > 24:
        _prepare(job, "whisper")
        job["stage"] = "transcribing"
        o = _run_unit(job, RATES["whisper"] * dur + 2, lambda: ENG.transcribe([out], job.get("language"))[0])
        words, heard = o["words"], heard or o["text"]
    cut = False
    if dur > 24 and words:  # long takes: keep the first ~20 s, ending on a finished word
        end = max((w["e"] for w in words if w["e"] <= 20.0), default=20.0)
        a, sr = sf.read(out, dtype="float32")
        sf.write(out, a[: int((end + 0.15) * sr)], sr, subtype="PCM_16")
        heard = re.sub(r"\s+(?=[.,!?;:%\u2019])", "", " ".join(w["w"] for w in words if w["e"] <= end + 0.01))
        dur, cut = end + 0.15, True
    if dur < 8:
        job["warnings"].append("under 8 s: cloning works, but 10-20 s of varied speech sounds much more like you")
    name = job["voice"]
    shutil.copy(out, ref_paths(name)[0])
    json.dump({"transcript": heard, "version": job.get("version"), "source": "recording"}, open(ref_paths(name)[1], "w"))
    job["results"] = [{"id": "reference", "text": heard, "duration": round(dur, 2), "cut": cut,
                       "level_db": round(rms_db, 1), "peak": round(peak, 3)}]


def package(job):
    job["stage"] = "packaging"
    if job["kind"] in ("video", "reference"):
        return  # single files, served directly; no zip copy of a large video
    jdir = os.path.join(JOBS_DIR, job["id"])
    with zipfile.ZipFile(os.path.join(JOBS_DIR, f"{job['id']}.zip"), "w") as z:
        for f in sorted(os.listdir(jdir)):
            if f.endswith((".wav", ".srt", ".vtt")) or (f.endswith(".json") and ".subs" in f) or f == "subtitles.json":
                z.write(os.path.join(jdir, f), f)
        z.writestr("manifest.json", json.dumps(job_view(job, urls=False), indent=2))


PUSH_TYPES = {".wav": "audio/wav", ".srt": "application/x-subrip", ".vtt": "text/vtt", ".json": "application/json",
              ".mp4": "video/mp4", ".jpg": "image/jpeg"}


def push_files(job_id, targets, headers):
    """Upload job files straight to object storage via presigned PUT URLs (much faster than pulling
    them back through the tunnel). targets: {file name in the job dir: presigned url}."""
    from concurrent.futures import ThreadPoolExecutor
    jdir = os.path.join(JOBS_DIR, job_id)

    def one(item):
        name, url = item
        path = os.path.join(jdir, os.path.basename(name))
        if not os.path.isfile(path) or not url.startswith("https://"):
            return name, "missing"
        ext = os.path.splitext(path)[1]
        ctype = PUSH_TYPES.get(ext, "application/octet-stream")
        hdrs = {**{k: str(v) for k, v in headers.items() if k.lower().startswith("x-")}, "Content-Type": ctype}
        for attempt in range(3):
            try:
                with open(path, "rb") as f:
                    req = urllib.request.Request(url, data=f.read(), method="PUT", headers=hdrs)
                with urllib.request.urlopen(req, timeout=600) as r:
                    if r.status < 300:
                        return name, None
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"
                time.sleep(1 + attempt)
        return name, err

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(one, targets.items()))
    return {"pushed": [n for n, e in results if not e], "failed": {n: e for n, e in results if e}}


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
            {"transcribe": run_transcribe, "video": run_video, "reference": run_reference}.get(job["kind"], run_tts)(job)
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
    if job["kind"] == "video" and stage == "rendering" and job.get("progress_file"):
        try:
            pf = json.load(open(job["progress_file"]))
        except Exception:
            pf = {"phase": "encoding prompt", "step": 0, "total": job["gen"]["steps"], "t": 0}
        el = now - job["cur"]["t0"] if job.get("cur") else 0
        step, steps = pf.get("step", 0), max(1, pf.get("total", 1))
        if pf["phase"] == "denoising" and step:
            per = el / (step + 0.5)  # elapsed includes the prompt encode (~half a step)
            eta = per * (steps - step) + 30
            frac = 0.05 + 0.85 * step / steps
            return min(0.97, frac), round(eta), "rendering", f"step {step} of {steps}"
        if pf["phase"] == "decoding":
            return 0.92, round(max(10, 120 - (el - pf.get("t", el)))), "decoding", f"decoding {job['gen']['frames']} frames"
        if pf["phase"] == "encoding video":
            return 0.93, 15, "encoding", "decoding frames and writing the MP4"
        left = max(10, job["cur"]["est"] - el) if job.get("cur") else job["est_total"]
        return 0.03, round(left), "rendering", "encoding the prompt"
    cur = job.get("cur")
    total = job["est_total"]
    if cur:
        el = now - cur["t0"]
        eff = max(cur["est"], el * 1.25)  # overrunning: assume ~25% more to go, keeps moving
        total += eff - cur["est"]
        partial = el
    else:
        partial = 0.0
    done = job["est_done"] + partial
    total = max(total, done + 0.1)
    frac = min(0.99, done / total)
    eta = (total - done) + extra
    if stage == "generating":
        detail = (cur or {}).get("label") or f"line {min(len(job['results']) + 1, len(job['lines']))} of {len(job['lines'])}"
    elif stage == "subtitles":
        detail = "Whisper large-v3, word timestamps"
    elif stage == "transcribing":
        detail = "Whisper is writing down what you said" if job["kind"] == "reference" else f"file {min(len(job['results']) + 1, len(job['lines']))} of {len(job['lines'])}"
    elif stage == "cleaning":
        detail = "removing rumble and hiss, levelling"
    return frac, round(eta), stage, detail


def job_view(job, urls=True):
    v = {k: job.get(k) for k in ("id", "kind", "engine", "voice", "style", "status", "error", "label", "language", "warnings", "subs", "match", "attach_to", "video", "version")}
    if job["kind"] == "video":
        v["gen"] = job["gen"]
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
            if job["kind"] in ("tts", "reference"):
                r["url"] = sign(f"/files/{job['id']}/{r['id']}.wav")
            if job["kind"] == "video" and job["status"] == "done":
                r["url"] = sign(f"/files/{job['id']}/video.mp4")
                r["poster_url"] = sign(f"/files/{job['id']}/poster.jpg")
            if r.get("subs"):
                r["srt_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.srt")
                r["vtt_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.vtt")
                r["json_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.json")
        res.append(r)
    v["results"] = res
    if urls and job["status"] == "done" and job["kind"] not in ("video", "reference"):
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
        out[name] = {k: spec[k] for k in ("kind", "about", "voices", "presets", "params", "gpu_gb", "chunk_chars", "group",
                                          "disk_gb", "sizes", "qualities", "max_seconds", "fps", "languages", "clone",
                                          "image_only", "adult", "min_gpu_gb") if k in spec}
        out[name]["state"] = ENG.state[name]
        out[name]["downloaded"] = os.path.isdir(cache_dir(name)) and dir_gb(cache_dir(name)) > 0.05
        unit = {"tts": "seconds_per_char", "asr": "seconds_per_audio_second", "video": "seconds_per_step_frame_megapixel"}[spec["kind"]]
        out[name][unit] = RATES.get(name)
    refs = sorted(f[:-4] for f in os.listdir(REFS_DIR) if f.endswith(".wav"))
    return {"engines": out, "references": refs, "preset_references": list(C.PRESET_REFS),
            "post_defaults": C.POST_DEFAULTS, "subtitle_style": C.SUBTITLE_STYLE,
            "styles": C.STYLES, "default_style": C.DEFAULT_STYLE, "groups": C.GROUPS, "idle_min": C.IDLE_MIN}


def health():
    return {"ok": True, "version": C.VERSION, "uptime_s": int(time.time() - STARTED), "gpu": gpu_info(),
            "ram": mem_info(), "disk": disk_info(), "mode": ENG.mode, "idle_unload_s": ENG.idle_left(), "idle_min": C.IDLE_MIN,
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
        m = re.match(r"^/logs/([a-z0-9]+)$", u.path)
        if m and (m.group(1) in C.ENGINES or m.group(1) in ("gateway", "tunnel")):
            names = [f"{m.group(1)}.log", f"{m.group(1)}-install.log"]
            n = min(400, int(parse_qs(u.query).get("n", ["120"])[0]))
            text = ""
            for name in names:
                path = os.path.join(LOGS_DIR, name)
                if os.path.exists(path):
                    with open(path, "rb") as f:
                        f.seek(max(0, os.path.getsize(path) - 200_000))
                        lines = f.read().decode("utf-8", "replace").splitlines()[-n:]
                    text += f"==> {name} <==\n" + "\n".join(lines) + "\n\n"
            return self._json(200, {"name": m.group(1), "text": text or "(no log yet)"})
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
            m = re.match(r"^/jobs/([a-f0-9]{12})/push$", u.path)
            if m and m.group(1) in JOBS:
                return self._json(200, push_files(m.group(1), body.get("targets") or {}, body.get("headers") or {}))
            m = re.match(r"^/jobs/([a-f0-9]{12})/cancel$", u.path)
            if m and m.group(1) in JOBS:
                JOBS[m.group(1)]["cancel"] = True
                pf = JOBS[m.group(1)].get("progress_file")
                if pf:  # a running video: the engine checks this file between denoising steps
                    open(pf + ".cancel", "w").close()
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
            m = re.match(r"^/engines/([a-z0-9]+)/(load|unload|forget)$", u.path)
            if m and m.group(1) in C.ENGINES:
                if m.group(2) == "forget":  # delete downloaded weights (frees disk; re-downloads on next use)
                    ENG.stop(m.group(1))
                    shutil.rmtree(cache_dir(m.group(1)), ignore_errors=True)
                    _SIZES.pop(cache_dir(m.group(1)), None)
                elif m.group(2) == "unload":
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
        m = re.match(r"^/files/([a-f0-9]{12})(?:/([A-Za-z0-9_\-]{1,64}(?:\.subs)?\.(?:wav|srt|vtt|json)|video\.mp4|poster\.jpg|source\.jpg)|\.zip)$", u.path)
        if not m:
            return self._json(404, {"error": "not found"})
        path = os.path.join(JOBS_DIR, m.group(1), m.group(2)) if m.group(2) else os.path.join(JOBS_DIR, f"{m.group(1)}.zip")
        if not os.path.exists(path):
            return self._json(404, {"error": "not found"})
        self.send_response(200)
        ctype = {".wav": "audio/wav", ".zip": "application/zip", ".srt": "application/x-subrip", ".vtt": "text/vtt",
                 ".json": "application/json", ".mp4": "video/mp4", ".jpg": "image/jpeg"}[os.path.splitext(path)[1]]
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
