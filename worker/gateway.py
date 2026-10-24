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
from lexicon import is_devanagari, segments, speakable  # noqa: E402
import story  # noqa: E402
import cleanup  # noqa: E402
import dataset  # noqa: E402
import quality  # noqa: E402
import voicewalk  # noqa: E402

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
        self.fetch = {}   # name -> live download / load progress while installing or loading
        self.lock = threading.RLock()
        self.budget = float(os.environ.get("VOICEBOX_VRAM_GB") or gpu_info()["total_gb"] or 0) - 1.5
        # size the vLLM engines to the card: a bigger KV cache generates more sentences at once
        pool = float(os.environ.get("ORPHEUS_VRAM_GB") or C.vllm_pool_gb(self.budget + 1.5))
        os.environ["ORPHEUS_VRAM_GB"] = f"{pool:g}"
        for n in ("orpheus", "myvoice"):
            C.ENGINES[n]["gpu_gb"] = pool + 2.5  # + SNAC decoder + CUDA context
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

    def _watch(self, name):
        """While an engine installs or loads, measure how much of its weights have landed on disk (every 2 s) so the
        dashboard can show a real progress bar: GB done / expected, download speed, time left."""
        total = float(C.ENGINES[name].get("disk_gb") or 0)
        t0, prev, rate, last_growth = time.time(), None, 0.0, time.time()
        while self.state[name] in ("installing", "loading"):
            gb = dir_gb(cache_dir(name), max_age=0) if os.path.isdir(cache_dir(name)) else 0.0
            now = time.time()
            if prev is not None:
                inst = max(0.0, (gb - prev[1]) / max(now - prev[0], 1e-3))  # GB/s
                rate = inst if rate == 0 else 0.7 * rate + 0.3 * inst
                if gb - prev[1] > 0.01:
                    last_growth = now
            prev = (now, gb)
            if self.state[name] == "installing":
                phase = "installing"
            elif total and gb < total * 0.97 and now - last_growth < 20:
                phase = "downloading"
            elif total and gb < total * 0.97 and now - t0 < 15:
                phase = "downloading"
            else:
                phase = "loading"
            left = (total - gb) / rate if phase == "downloading" and rate > 0.005 else None
            self.fetch[name] = {"phase": phase, "gb": round(gb, 2), "total_gb": total, "mbps": round(rate * 1000),
                                "eta_s": round(left) if left else None, "elapsed_s": round(now - t0)}
            time.sleep(2)
        self.fetch.pop(name, None)

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
        if C.ENGINES[name].get("nodeps"):  # packages whose own pins would break the venv: installed without them
            subprocess.run(f'uv pip install --python {py} -q --no-deps {C.ENGINES[name]["nodeps"]}', shell=True, check=True,
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
                self.state[name] = "installing" if not os.path.exists(C.python_for(name)) else "loading"
                self.since[name] = time.time()
                threading.Thread(target=self._watch, args=(name,), daemon=True).start()
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
                       "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
                       # Colab sets the notebook's inline plot backend, which an engine's own venv can't load: matplotlib
                       # then refuses to import (Resemble Enhance imports pyplot and died loading). Engines never show plots.
                       "MPLBACKEND": "Agg"}
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

    def similarity(self, ref_path, paths):
        """Speaker-embedding cosine of each file vs the reference (WavLM SV, ~0.86+ = same speaker)."""
        return self._post("whisper", "/similarity", {"ref": ref_path, "paths": paths})["scores"]

    def mos(self, paths):
        """Predicted naturalness (UTMOS, 1-5) per file."""
        return self._post("whisper", "/mos", {"paths": paths})["scores"]

    def revoice(self, payload):
        return self._post("chatterbox", "/revoice", payload)

    def enhance(self, payload):
        return self._post("enhance", "/enhance", payload)

    def video(self, name, payload):
        return self._post(name, "/video", payload, timeout=3 * 60 * 60)

    def image(self, name, payload):
        return self._post(name, "/image", payload, timeout=60 * 60)

    def animate(self, name, payload):
        return self._post(name, "/animate", payload, timeout=3 * 60 * 60)


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


def get_adapter(job, voice):
    """(adapter dir, speaker) for a trained voice: downloaded once per model into myvoice/models/<train job>/ (a model
    trained on this worker is already there), or (None, default speaker) = the engine's default model."""
    models = job.get("models") or {}
    m = models.get(voice) or (models.get("me") if voice in ("me", "female", "male", "default") else None)
    if not m:
        if models and voice not in ("me", "female", "male", "default"):
            raise ValueError(f"no trained model called '{voice}' (trained: {', '.join(sorted(k for k in models if k != 'me'))})")
        return None, None
    path = os.path.join(C.MYVOICE_DIR, "models", m["job"])
    if not os.path.exists(os.path.join(path, "adapter_config.json")):
        job["stage"] = "fetching the voice model"
        log(f"downloading voice model '{voice}' ({m['job']})")
        tmp = path + ".part"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with urllib.request.urlopen(m["url"], timeout=900) as r, open(tmp + ".zip", "wb") as f:
            shutil.copyfileobj(r, f)
        zipfile.ZipFile(tmp + ".zip").extractall(tmp)
        os.remove(tmp + ".zip")
        shutil.rmtree(path, ignore_errors=True)
        os.replace(tmp, path)
    return path, m["speaker"]


def get_kvoice(job, voice):
    """Path of a Kokoro voice found for someone (kv_<name>, a voicewalk job's voice.npy): downloaded once per version
    from the dashboard's storage (job["kvoices"] = {voice: {job, url}})."""
    m = (job.get("kvoices") or {}).get(voice)
    if not m:
        raise ValueError(f"no Kokoro voice called '{voice}' yet: make it on the Your model page (Your voice in Kokoro)")
    path = os.path.join(HOME, "kokoro", "voices", f"{m['job']}.npy")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with urllib.request.urlopen(m["url"], timeout=120) as r, open(path + ".dl", "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(path + ".dl", path)
    return path


def get_qwen_model(job, voice):
    """A fine-tuned Qwen3-TTS voice (ft_<name>): its model, downloaded once per train job into qwenft/models/<job>/
    (job["qmodels"] = {name: {job, url}} from the dashboard). Returns the path of its ref.wav: the qwen engine sees the
    model next to it, and the voice match compares takes with that clip of the person."""
    name = voice[3:]
    m = (job.get("qmodels") or {}).get(name)
    if not m:
        raise ValueError(f"no fine-tuned Qwen voice called '{name}' yet: train one on the Your model page (Train Qwen3-TTS)")
    path = os.path.join(C.QWENFT_DIR, "models", m["job"])
    if not os.path.exists(os.path.join(path, "model.safetensors")):
        job["stage"] = "fetching the voice model"
        log(f"downloading fine-tuned Qwen voice '{name}' ({m['job']})")
        tmp = path + ".part"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        with urllib.request.urlopen(m["url"], timeout=1800) as r, open(tmp + ".zip", "wb") as f:
            shutil.copyfileobj(r, f)
        zipfile.ZipFile(tmp + ".zip").extractall(tmp)
        os.remove(tmp + ".zip")
        shutil.rmtree(path, ignore_errors=True)
        os.replace(tmp, path)
    return os.path.join(path, "ref.wav")


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
def postprocess(src, dst, post, info=None):
    """trim -> tempo -> resample -> master (voice chain + platform loudness) or peak normalise.
    info, when given, receives {"lufs": integrated loudness of the result, or None when not mastered}."""
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
    plat = C.PLATFORMS.get(post.get("master") or "raw") or C.PLATFORMS["raw"]
    lufs = None
    if plat["lufs"] is not None and len(audio) > 0.6 * sr:
        try:
            audio, lufs = master(audio, sr, plat, dst, C.VOICE_CHAIN if post.get("voice_chain", True) else "anull")
        except Exception as e:  # noqa: BLE001  never lose a take over mastering: fall back to peak normalising
            log(f"mastering skipped ({type(e).__name__}: {e})")
    if lufs is None and post.get("normalize_dbfs") is not None:
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        if peak > 0:
            audio = audio * (10 ** (float(post["normalize_dbfs"]) / 20) / peak)
    sf.write(dst, audio, sr, subtype="PCM_16")
    if info is not None:
        info["lufs"] = lufs
    return len(audio) / sr


def _loudnorm_stats(stderr):
    """The JSON block loudnorm prints at the end of a run."""
    m = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr)
    if not m:
        raise RuntimeError("loudnorm printed no measurement")
    return json.loads(m[-1])


def master(audio, sr, plat, dst, chain_filters=C.VOICE_CHAIN):
    """Broadcast voice chain (C.VOICE_CHAIN) + two-pass EBU R128 loudness to the platform's LUFS and true-peak
    target. Pass one measures, pass two applies one linear gain, so the read keeps its dynamics.
    Returns (audio, integrated LUFS of the result)."""
    import soundfile as sf
    tin, tout = dst + ".min.wav", dst + ".mout.wav"
    sf.write(tin, audio, sr, subtype="FLOAT")
    target = f"I={plat['lufs']}:TP={plat['tp']}:LRA=11"
    try:
        for chain in (chain_filters, re.sub(r"deesser=[^,]*,", "", chain_filters)):  # older ffmpeg has no deesser
            p1 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", tin, "-af", f"{chain},loudnorm={target}:print_format=json",
                                 "-f", "null", "-"], capture_output=True, text=True)
            if p1.returncode == 0:
                break
        else:
            raise RuntimeError(p1.stderr.strip().splitlines()[-1] if p1.stderr.strip() else "ffmpeg failed")
        s = _loudnorm_stats(p1.stderr)
        if not re.match(r"^-?\d", str(s["input_i"])):  # silence measures -inf: nothing to master
            raise RuntimeError("no measurable loudness")
        measured = (f"measured_I={s['input_i']}:measured_TP={s['input_tp']}:measured_LRA={s['input_lra']}:"
                    f"measured_thresh={s['input_thresh']}:offset={s['target_offset']}:linear=true")
        p2 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", tin, "-af",
                             f"{chain},loudnorm={target}:{measured}:print_format=json,aresample={sr}",
                             "-ar", str(sr), "-c:a", "pcm_f32le", tout], capture_output=True, text=True)
        if p2.returncode != 0:
            raise RuntimeError(p2.stderr.strip().splitlines()[-1] if p2.stderr.strip() else "ffmpeg failed")
        out, _ = sf.read(tout, dtype="float32", always_2d=False)
        try:
            lufs = round(float(_loudnorm_stats(p2.stderr)["output_i"]), 1)
        except Exception:
            lufs = float(plat["lufs"])
        return (out.mean(axis=1) if out.ndim > 1 else out), lufs
    finally:
        for f in (tin, tout):
            if os.path.exists(f):
                os.remove(f)


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


def match_score(script, heard):
    """How closely what was heard follows the script (quality.score_text: same spoken form, sound-alike words, letters)."""
    return quality.score_text(script, heard)["score"]


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
    if body.get("kind") == "animate" or (body.get("kind") == "video" and body.get("model") == "animate"):
        return make_animate_job(body)
    if body.get("kind") == "video":
        return make_video_job(body)
    if body.get("kind") == "image":
        return make_image_job(body)
    if body.get("kind") == "reference":
        return make_reference_job(body)
    if body.get("kind") == "revoice":
        return make_revoice_job(body)
    if body.get("kind") == "clean":
        return make_clean_job(body)
    if body.get("kind") == "story":
        return make_story_job(body)
    if body.get("kind") == "dataset":
        return make_dataset_job(body)
    if body.get("kind") == "benchmark":
        return make_benchmark_job(body)
    if body.get("kind") == "train":
        return make_train_job(body)
    if body.get("kind") == "voicewalk":
        return make_voicewalk_job(body)
    job = _base_job("tts", body)
    _voice_setup(job, body, body.get("lines") or [])
    return _enqueue(job)


def _voice_setup(job, body, lines):
    """Everything a voiceover needs (engine, voice, style, takes, pronunciation, platform), validated, onto job."""
    engine = body.get("engine")
    if engine not in C.TTS_ENGINES:
        raise ValueError(f"engine must be one of {C.TTS_ENGINES}")
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
        if not segments(text):
            raise ValueError(f"line {lid}: only pause markers, nothing to say")
        seen.add(lid)
        clean.append({"id": lid, "text": text, "window": ln.get("window"), "start": ln.get("start"), "params": ln.get("params") or {}})
    style = body.get("style") or C.DEFAULT_STYLE
    style_params, style_post = C.style_settings(style, engine)
    # what this voice has learned works best (sent by the dashboard from past reviews); explicit params still win
    profile = body.get("profile") if isinstance(body.get("profile"), dict) else {}
    specs = C.ENGINES[engine]["params"]
    learned = {k: v for k, v in (profile.get("params") or {}).items() if k in specs and isinstance(v, (int, float))
               and specs[k].get("min", -1e9) <= v <= specs[k].get("max", 1e9)}
    job.update({"engine": engine, "voice": resolve_voice(engine, body.get("voice")), "style": style,
                "params": {**style_params, **learned, **(body.get("params") or {})}, "lines": clean,
                "profile": {"sim_base": profile.get("sim_base") if isinstance(profile.get("sim_base"), (int, float)) else None,
                            "learned": learned},
                "review": body.get("review", engine != "kokoro") is not False,
                "subtitles": bool(body.get("subtitles")), "ref": body.get("ref") if isinstance(body.get("ref"), dict) else None,
                "models": _models(body.get("models")), "kvoices": _models(body.get("kvoices")),
                "lexicon": body.get("lexicon", True) is not False, "pronounce": _pronounce(body.get("pronounce")),
                "takes": 1 if engine == "kokoro" else max(1, min(C.MAX_TAKES, int(body.get("takes") or 1)))})
    _platform(job, body, style_post)
    if engine == "myvoice" and "enhance" not in (body.get("post") or {}):
        job["post"]["enhance"] = "auto"  # 24 kHz codec -> 44.1 kHz studio air, kept only when it listens better
    if engine == "kokoro" and int(body.get("takes") or 1) > 1:
        job["warnings"].append("kokoro is deterministic, so every take would be identical: made one")
    if learned:
        job["warnings"].append("learned settings for this voice: " + ", ".join(f"{k} {v}" for k, v in learned.items()))
    chars = sum(len(l["text"]) for l in clean)
    job["est_total"] = (RATES[engine] * chars * job["takes"] + (RATES["whisper"] * chars / 14 if job["subtitles"] else 0)
                        + (RATES["whisper"] * chars / 14 * job["takes"] if job["takes"] > 1 or job["review"] else 0))


def _models(given):
    """{voice: {job, url, speaker}}: the trained models a myvoice job may use (signed links from the dashboard)."""
    if not isinstance(given, dict):
        return {}
    out = {}
    for name, m in list(given.items())[:500]:
        if isinstance(m, dict) and ID_RE.match(str(name)) and ID_RE.match(str(m.get("job") or "")) and str(m.get("url") or "").startswith("http"):
            out[str(name)] = {"job": str(m["job"]), "url": str(m["url"]), "speaker": str(m.get("speaker") or "me")[:64]}
    return out


def _pronounce(given):
    """{"word": "how to say it"} from the request, trimmed to something sane."""
    if not isinstance(given, dict):
        return {}
    return {str(k)[:60]: str(v)[:120] for k, v in list(given.items())[:300] if str(k).strip() and str(v).strip()}


def _platform(job, body, style_post=None):
    """Where the audio is going: sets the mastering target and the caption cut. An explicit post.master or
    captions in the request wins over the platform's."""
    platform = body.get("platform") or C.DEFAULT_PLATFORM
    if platform not in C.PLATFORMS:
        raise ValueError(f"platform must be one of {list(C.PLATFORMS)}")
    given = body.get("post") or {}
    if given.get("master") not in (None, "", *C.PLATFORMS):
        raise ValueError(f"post.master must be one of {list(C.PLATFORMS)} or null")
    job["platform"] = platform
    job["post"] = {**C.POST_DEFAULTS, **(style_post or {}), **given}
    job["post"]["master"] = given["master"] if "master" in given else platform
    captions = body.get("captions") or C.PLATFORMS[platform]["captions"]
    if captions not in C.CAPTION_STYLES:
        raise ValueError(f"captions must be one of {list(C.CAPTION_STYLES)}")
    job["captions"] = captions


def make_revoice_job(body):
    """Re-voice a performance: the user's own take (any recording, even a phone voice memo or a video) keeps its
    timing, emphasis and emotion, but comes out in a clean studio copy of a recorded voice (Chatterbox VC)."""
    url = _http_url(body.get("url"), "url")
    if not url:
        raise ValueError("url must point at the performance to re-voice (audio or video)")
    voice = str(body.get("voice") or "")
    if not voice or voice == "default":
        raise ValueError("voice: the recorded voice to speak in (a my_voices name, or female/male)")
    job = _base_job("tts", body)
    job.update({"engine": "chatterbox", "voice": voice, "style": "neutral", "mode": "revoice", "params": {},
                "lines": [{"id": "revoice", "text": "", "url": url, "window": None, "start": None, "params": {}}],
                "subtitles": bool(body.get("subtitles")), "ref": body.get("ref") if isinstance(body.get("ref"), dict) else None,
                "models": _models(body.get("models")),
                "takes": 1, "lexicon": False, "pronounce": {}})
    _platform(job, {**body, "post": {"trim": False, **(body.get("post") or {})}})  # untrimmed: stays in sync with the video
    job["enhance"] = body.get("enhance", True) is not False
    job["est_total"] = 60.0  # refined once the source's length is known
    return _enqueue(job)


def make_clean_job(body):
    """Studio clean-up of the user's own recording (voiceover, podcast, a video's soundtrack): Resemble Enhance, then
    mastered for the platform. Untrimmed by default so it drops back onto the video in sync."""
    url = _http_url(body.get("url"), "url")
    if not url:
        raise ValueError("url must point at the recording to clean up (audio or video)")
    job = _base_job("tts", body)
    given = body.get("params") or {}
    choice = body.get("cleanup") or given.get("mode") or "auto"  # an explicit params.mode (older clients) still decides
    if choice not in ("auto", "denoise", "enhance"):
        raise ValueError("cleanup must be auto, denoise or enhance")
    job.update({"engine": "enhance", "voice": "", "style": "neutral", "mode": "clean", "cleanup": choice,
                "params": C.resolve_params("enhance", given),
                "lines": [{"id": "clean", "text": "", "url": url, "window": None, "start": None, "params": {}}],
                "subtitles": bool(body.get("subtitles")), "ref": None, "takes": 1, "lexicon": False, "pronounce": {}})
    _platform(job, {**body, "post": {"trim": False, **(body.get("post") or {})}})
    job["est_total"] = 60.0
    return _enqueue(job)


MAX_SCENES = 80


def make_story_job(body):
    """Script -> finished video. scenes: [{text, visual?, image_url?}] (one voiced line + one shot each). The voice
    takes every voice_lines option; visuals: images (Z-Image stills with Ken Burns motion, seconds per scene) or clips
    (each still animated by Wan 2.2, minutes per scene); captions burned in; optional music bed ducked under the voice."""
    scenes = body.get("scenes") or []
    if not scenes or len(scenes) > MAX_SCENES:
        raise ValueError(f"scenes must contain 1-{MAX_SCENES} items of {{text, visual?, image_url?}}")
    lines, shots = [], []
    for i, sc in enumerate(scenes):
        sc = sc if isinstance(sc, dict) else {"text": str(sc)}
        lid = str(sc.get("id") or f"s{i + 1:02d}")
        lines.append({"id": lid, "text": str(sc.get("text") or "").strip(), "params": sc.get("params") or {}})
        shots.append({"id": lid, "visual": str(sc.get("visual") or "").strip()[:1500],
                      "image_url": _http_url(sc.get("image_url"), f"scene {i + 1} image_url") or None})
    job = _base_job("video", body)
    _voice_setup(job, {**body, "subtitles": False}, lines)  # subtitles run once the scenes are timed
    visuals = body.get("visuals") or "images"
    if visuals not in ("images", "clips"):
        raise ValueError("visuals must be images (stills with camera motion) or clips (animated with Wan)")
    vstyle = body.get("visual_style") or "tech"
    if vstyle not in story.VISUAL_STYLES:
        raise ValueError(f"visual_style must be one of {list(story.VISUAL_STYLES)}")
    look = body.get("captions_look") or ("bold" if C.PLATFORMS[job["platform"]]["captions"] == "punchy" else "clean")
    if look not in story.CAPTION_LOOKS:
        raise ValueError(f"captions_look must be one of {list(story.CAPTION_LOOKS)}")
    transition = body.get("transition") or "fade"
    if transition not in ("fade", "cut"):
        raise ValueError("transition must be fade or cut")
    aspect = story.aspect_for(job["platform"], body.get("aspect"))
    w, h = story.FRAME[aspect]
    seed = int(body["seed"]) if body.get("seed") not in (None, "") else 7
    music_db = float(body.get("music_lufs") if body.get("music_lufs") is not None else -28)
    job.update({"mode": "story", "story": {"shots": shots, "visuals": visuals, "visual_style": vstyle, "look": look,
                                            "transition": transition, "aspect": aspect, "music_url": _http_url(body.get("music_url"), "music_url") or None,
                                            "music_lufs": max(-40.0, min(-18.0, music_db))},
                "gen": {"model": "story", "mode": "story", "prompt": (job["label"] or lines[0]["text"])[:300], "negative": "",
                        "seed": seed, "steps": C.ENGINES["zimage"]["qualities"]["turbo"]["steps"], "guidance": 0.0,
                        "quality": visuals, "aspect": aspect, "fps": story.FPS, "frames": 0, "seconds": 0.0,
                        "width": w, "height": h, "audio": True, "source": False, "scenes": len(lines)}})
    iw, ih = C.ENGINES["zimage"]["sizes"][aspect]
    per_image = RATES["zimage"] * 8 * iw * ih / 1e6
    job["est_total"] += len(lines) * (per_image + 4) + 30 + (RATES["whisper"] * sum(len(l["text"]) for l in lines) / 14)
    if visuals == "clips":
        ww, wh = C.ENGINES["wan"]["sizes"][aspect]
        job["est_total"] += len(lines) * video_estimate({"model": "wan", "steps": 4, "frames": 121, "width": ww, "height": wh, "guidance": 1.0})
    return _enqueue(job)


def run_story(job):
    import numpy as np
    import soundfile as sf
    jdir = os.path.join(JOBS_DIR, job["id"])
    st, g = job["story"], job["gen"]
    w, h = g["width"], g["height"]

    # 1 · the voice, line by line (every voice option applies: takes, pronunciation, mastering...)
    run_tts(job)
    by_id = {r["id"]: r for r in job["results"]}
    lines = job["lines"]
    starts, lengths, total = story.timeline([by_id[l["id"]]["duration"] for l in lines])
    for l, s in zip(lines, starts):
        by_id[l["id"]]["start"] = s

    # 2 · word timing on the scene timeline (captions), while the voice models are still loaded
    job["subtitles"] = True
    try:
        subtitle_tts(job, jdir)
    except Cancelled:
        raise
    except Exception as e:  # noqa: BLE001  a video without captions beats no video
        traceback.print_exc()
        job["warnings"].append(f"captions skipped: subtitles failed ({type(e).__name__})")
        st["look"] = "none"

    # 3 · the voiceover track: every line at its scene start
    sr = int(job["post"].get("sample_rate") or 48000)
    track = np.zeros(int((total + 0.5) * sr), dtype="float32")
    for l, s in zip(lines, starts):
        a, asr = sf.read(os.path.join(jdir, f"{l['id']}.wav"), dtype="float32", always_2d=False)
        if asr != sr:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(jdir, f"{l['id']}.wav"), "-ar", str(sr),
                            os.path.join(jdir, "rs.wav")], check=True)
            a, _ = sf.read(os.path.join(jdir, "rs.wav"), dtype="float32", always_2d=False)
        i0 = int(s * sr)
        track[i0:i0 + len(a)] += a[: max(0, len(track) - i0)]
    voice_path = os.path.join(jdir, "voiceover.wav")
    sf.write(voice_path, track[: int(total * sr)], sr, subtype="PCM_16")

    # 4 · one picture per scene: the user's image, or Z-Image from the scene's visual description
    images, model = [], "zimage"
    iw, ih = C.ENGINES[model]["sizes"][st["aspect"]]
    todo = [i for i, s in enumerate(st["shots"]) if not s.get("image_url")]
    prompts = [story.visual_prompt(s["visual"], l["text"], st["visual_style"], st["aspect"]) for s, l in zip(st["shots"], lines)]
    for i, s in enumerate(st["shots"]):
        if s.get("image_url"):
            job["stage"] = "downloading"
            raw = os.path.join(jdir, f"scene{i}.in")
            _download(s["image_url"], raw, 40 * 1024 * 1024)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-frames:v", "1", os.path.join(jdir, f"scene{i}.png")], check=True)
            os.remove(raw)
    if todo:
        _prepare(job, model)
        job["stage"] = "visuals"
        for n, i in enumerate(todo):
            out_dir = os.path.join(jdir, f"scene{i}")
            payload = {"prompt": prompts[i], "negative": "", "seed": g["seed"] + i, "steps": g["steps"], "guidance": 0.0,
                       "quality": "turbo", "count": 1, "transparent": False, "width": iw, "height": ih, "out_dir": out_dir,
                       "progress_path": os.path.join(out_dir, "progress.json")}
            os.makedirs(out_dir, exist_ok=True)
            t0 = time.time()
            _run_unit(job, RATES[model] * g["steps"] * iw * ih / 1e6, lambda: ENG.image(model, payload),
                      f"picture {n + 1} of {len(todo)}")
            learn_rate(model, time.time() - t0, g["steps"] * iw * ih / 1e6)
            shutil.move(os.path.join(out_dir, "image-1.png"), os.path.join(jdir, f"scene{i}.png"))
            shutil.rmtree(out_dir, ignore_errors=True)
    images = [os.path.join(jdir, f"scene{i}.png") for i in range(len(lines))]

    # 5 · clips mode: animate every still with Wan (all images first, so the GPU switches model once)
    clips = [None] * len(lines)
    if st["visuals"] == "clips":
        ww, wh = C.ENGINES["wan"]["sizes"][st["aspect"]]
        _prepare(job, "wan")
        job["stage"] = "visuals"
        for i, (img, s, l) in enumerate(zip(images, st["shots"], lines)):
            out = os.path.join(jdir, f"clip{i}.mp4")
            motion = (s["visual"] or l["text"]).rstrip(". ") + ". Smooth cinematic camera push-in, gentle natural motion, stable subject."
            payload = {"prompt": motion, "negative": "", "seed": g["seed"] + i, "steps": 4, "guidance": 1.0, "quality": "fast",
                       "fps": 24, "audio": False, "adult": False, "width": ww, "height": wh, "num_frames": 121,
                       "out_path": out, "progress_path": os.path.join(jdir, f"clip{i}.progress.json"), "image_path": img}
            ge = {"model": "wan", "steps": 4, "frames": 121, "width": ww, "height": wh, "guidance": 1.0}
            try:
                t0 = time.time()
                _run_unit(job, video_estimate(ge), lambda: ENG.video("wan", payload), f"animating shot {i + 1} of {len(lines)}")
                learn_rate("wan", time.time() - t0, 4 * 121 * ww * wh / 1e6)
                clips[i] = out
            except Cancelled:
                raise
            except Exception as e:  # noqa: BLE001  keep the still with camera motion for this scene
                job["warnings"].append(f"shot {i + 1}: animation failed ({type(e).__name__}), used the still")

    # 6 · scene segments, soundtrack, captions, final cut
    job["stage"] = "assembling"
    segs = []
    for i in range(len(lines)):
        seg = os.path.join(jdir, f"seg{i}.mp4")
        secs = story.segment_length(lengths, i, st["transition"])
        _run_unit(job, 2 + secs * 0.4, (lambda i=i, seg=seg, secs=secs: story.motion_clip(clips[i], seg, secs, (w, h)) if clips[i]
                                         else story.still_clip(images[i], seg, secs, (w, h), story.MOTIONS[i % len(story.MOTIONS)])),
                  f"shot {i + 1} of {len(lines)}")
        segs.append(seg)
    music = None
    if st.get("music_url"):
        music = os.path.join(jdir, "music.in")
        try:
            _download(st["music_url"], music, 100 * 1024 * 1024)
        except Exception as e:  # noqa: BLE001
            job["warnings"].append(f"music skipped ({type(e).__name__})")
            music = None
    mix_raw, mix = os.path.join(jdir, "mix.raw.wav"), os.path.join(jdir, "mix.wav")
    _run_unit(job, 3 + total * 0.05, lambda: story.mix_music(voice_path, music, mix_raw, total, st["music_lufs"]), "mixing the soundtrack")
    postprocess(mix_raw, mix, {"trim": False, "sample_rate": 48000, "master": job["post"].get("master"), "voice_chain": False,
                               "normalize_dbfs": -1.0})
    ass = None
    if st["look"] != "none":
        sub = json.load(open(os.path.join(jdir, "subtitles.json")))
        ass = os.path.join(jdir, "captions.ass")
        open(ass, "w").write(story.make_ass(st["look"], (w, h), words=sub.get("words"), cues=sub.get("cues")))
    fonts = story.ensure_fonts(HOME)
    out = os.path.join(jdir, "video.mp4")
    _run_unit(job, 10 + total * 0.6, lambda: story.assemble(segs, lengths, mix, ass, fonts, out, st["transition"]),
              f"encoding {total:.0f} s at {w}x{h}")
    job["stage"] = "packaging"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{min(1.0, total / 2):.2f}", "-i", out, "-frames:v", "1", "-q:v", "3",
                    os.path.join(jdir, "poster.jpg")], check=True)
    info = story.probe(out)
    info["size"] = os.path.getsize(out)
    job["video"] = {**info, "poster": True}
    g.update({"frames": info["frames"], "seconds": info["duration"]})
    cuts = [round(sum(lengths[:k]), 3) for k in range(len(lines))]  # where each shot starts on screen
    job["scenes"] = [{"id": l["id"], "text": l["text"], "start": cuts[k], "seconds": ln, "voice_start": starts[k],
                      "prompt": None if sh.get("image_url") else prompts[k], "match": by_id[l["id"]].get("match"),
                      "animated": bool(clips[k])}
                     for k, (l, ln, sh) in enumerate(zip(lines, lengths, st["shots"]))]
    job["voice_lines"] = job["results"]
    job["results"] = [{"id": "video", "text": g["prompt"], "duration": info["duration"]}]
    for f in segs + [mix_raw, mix] + [c for c in clips if c] + ([music] if music else []):
        if f and os.path.exists(f):
            os.remove(f)


def studio_clean(job, src, dst, params=None, label="studio clean-up: noise out, detail restored"):
    """Resemble Enhance src -> dst (44.1 kHz). True on success; False after a warning when the enhancer can't run,
    so the caller falls back to its plain ffmpeg clean-up instead of failing the job."""
    import soundfile as sf
    stage = job["stage"]
    dur = sf.info(src).duration
    p = C.resolve_params("enhance", params or {})
    try:
        _prepare(job, "enhance")
        job["stage"] = "enhancing"
        t0 = time.time()
        _run_unit(job, RATES["enhance"] * dur + 2, lambda: ENG.enhance({"src_path": src, "out_path": dst, "params": p}), label)
        learn_rate("enhance", time.time() - t0, max(dur, 1.0))
        return True
    except Cancelled:
        raise
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        msg = f"studio enhance unavailable ({type(e).__name__}: {str(e)[:120]}); used the standard clean-up"
        if msg not in job["warnings"]:
            job["warnings"].append(msg)
        return False
    finally:
        job["stage"] = stage


def _studio_output(job, path):
    """post.enhance: run the finished take through the enhancer too (restores 44.1 kHz air on 24 kHz engines).
    "auto" (the default for your trained voice) listens to both and keeps the polished one only when it is still
    clearly you (speaker match >= 0.9 against the unpolished take) and at least as natural (UTMOS)."""
    mode = job["post"].get("enhance")
    if not mode or job.get("_no_polish"):
        return path
    out = path[:-4] + ".enh.wav"
    if not studio_clean(job, path, out, {"mode": "enhance", "strength": float(job["post"].get("enhance_strength", 0.3))},
                        "studio polish"):
        return path
    if mode == "auto":
        try:
            _prepare(job, "whisper")
            job["stage"] = "enhancing"
            sim = ENG.similarity(path, [out])[0]
            mos = ENG.mos([path, out])
            keep = sim >= 0.9 and (mos[1] is None or mos[0] is None or mos[1] >= mos[0] - 0.05)
        except Exception as e:  # noqa: BLE001  can't judge it: keep the take as generated
            log(f"polish check failed ({type(e).__name__}: {e})")
            keep = False
        if not keep:
            os.remove(out)
            note = "studio polish skipped on some lines: it changed the voice or sounded less natural"
            if note not in job["warnings"]:
                job["warnings"].append(note)
            return path
    os.remove(path)
    return out


def smart_clean(job, src, dst, prefer=None):
    """Adaptive clean-up (cleanup.run): measure, run only what the recording needs (DeepFilterNet noise removal on the
    CPU, Resemble Enhance restoration on the GPU), then check it still sounds like the same person. Returns the
    report; never raises for a missing tool (the report lists what was skipped)."""
    import soundfile as sf
    stage = job["stage"]
    dur = sf.info(src).duration

    def enhance(a, b, params):
        return studio_clean(job, a, b, params)

    def similarity(ref, paths):
        _prepare(job, "whisper")
        job["stage"] = "checking"
        return _run_unit(job, 0.3 * len(paths) + 5, lambda: ENG.similarity(ref, paths), "checking it still sounds like you")

    def note(msg):
        job["stage"] = "denoising"
        job["cur"] = {"t0": time.time(), "est": max(1.0, 0.08 * dur), "label": msg}

    try:
        rep = cleanup.run(src, dst, os.path.dirname(dst), HOME, enhance=enhance, similarity=similarity, prefer=prefer, note=note)
    finally:
        job["cur"] = None
        job["stage"] = stage
    for sk in rep.get("skipped", []):
        job["warnings"].append(f"clean-up step {sk['step']} skipped ({sk['error']})")
    log(f"job {job['id']} clean-up: {rep['why']} -> {[x['step'] for x in rep['steps']]}")
    return rep


def _cleanup_summary(rep):
    b, a = rep["before"], rep["after"]
    return {"steps": [x["step"] for x in rep["steps"]], "why": rep["why"], "identity": rep.get("identity"),
            "before": {k: b.get(k) for k in ("snr_db", "bandwidth_hz", "reverb_s", "clipped")},
            "after": {k: a.get(k) for k in ("snr_db", "bandwidth_hz", "reverb_s", "clipped")}}


def run_clean(job):
    jdir = os.path.join(JOBS_DIR, job["id"])
    job["stage"] = "downloading"
    raw = os.path.join(jdir, "recording.in")
    _download(job["lines"][0]["url"], raw, 600 * 1024 * 1024)
    job["stage"] = "cleaning"
    prep, clean = os.path.join(jdir, "clean.prep.wav"), os.path.join(jdir, "clean.raw.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-vn", "-ac", "1", "-ar", "44100", "-af", "highpass=f=60", prep], check=True)
    os.remove(raw)
    import soundfile as sf
    dur = sf.info(prep).duration
    if dur > 60 * 60:
        raise ValueError("clean-up takes up to an hour of audio at a time")
    job["est_total"] = RATES["enhance"] * dur + (RATES["whisper"] * dur if job["subtitles"] else 0) + 20
    rep = smart_clean(job, prep, clean, {"auto": None}.get(job.get("cleanup", "auto"), job.get("cleanup")))
    enhanced = any(x["step"] == "restore" for x in rep["steps"])
    os.remove(prep)
    info = {}
    final = postprocess(clean, os.path.join(jdir, "clean.wav"), job["post"], info)
    os.remove(clean)
    job["results"].append({"id": "clean", "text": "", "duration": round(final, 3), "window": None, "start": None, "chunks": 1,
                           "fits": None, "lufs": info.get("lufs"), "enhanced": enhanced, "source_s": round(dur, 2),
                           "cleanup": _cleanup_summary(rep)})
    if job["subtitles"]:
        try:
            subtitle_tts(job, jdir)
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job["warnings"].append(f"subtitles failed ({type(e).__name__}); audio is saved")
    r = job["results"][0]
    r["text"] = r.get("heard") or "Studio clean-up"
    r["match"] = None
    job["match"] = None


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
    w, h = (q.get("sizes") or spec["sizes"])[aspect]
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


def _http_url(u, what):
    u = str(u or "")
    if u and not u.startswith(("https://", "http://")):
        raise ValueError(f"{what} must be an http(s) URL")
    return u


def make_image_job(body):
    model = body.get("model") or "zimage"
    if model not in C.IMAGE_ENGINES:
        raise ValueError(f"model must be one of {C.IMAGE_ENGINES}")
    spec = C.ENGINES[model]
    prompt = str(body.get("prompt") or "").strip()
    if not 3 <= len(prompt) <= 4000:
        raise ValueError("prompt must be 3-4000 characters")
    aspect = body.get("aspect") or "1:1"
    if aspect not in spec["sizes"]:
        raise ValueError(f"aspect must be one of {list(spec['sizes'])}")
    quality = body.get("quality") or next(iter(spec["qualities"]))
    if quality not in spec["qualities"]:
        raise ValueError(f"quality must be one of {list(spec['qualities'])} for {model}")
    w, h = spec["sizes"][aspect]
    refs = [_http_url(u, "image_urls") for u in (body.get("image_urls") or []) if u]
    if refs and not spec.get("edit"):
        raise ValueError(f"{model} doesn't take reference images (use qwenimage)")
    refs = refs[: spec.get("max_refs", 0)]
    count = max(1, min(int(spec.get("max_count", 1)), int(body.get("count") or 1)))
    seed = body.get("seed")
    job = _base_job("image", body)
    job.update({"engine": model, "voice": "", "lines": [], "params": {}, "post": {}, "image_urls": refs,
                "gen": {"model": model, "mode": "edit" if refs else "t2i", "prompt": prompt,
                        "negative": str(body.get("negative") or "")[:2000], "seed": int(seed) if seed not in (None, "") else 7,
                        "steps": spec["qualities"][quality]["steps"], "guidance": spec["qualities"][quality]["guidance"],
                        "quality": quality, "aspect": aspect, "width": w, "height": h, "count": count, "refs": len(refs),
                        "transparent": bool(body.get("transparent")) and bool(spec.get("transparent"))}})
    job["est_total"] = image_estimate(job["gen"]) + 5
    return _enqueue(job)


def image_estimate(g):
    return RATES[g["model"]] * g["steps"] * g["width"] * g["height"] / 1e6 * g["count"]


def make_animate_job(body):
    """Character image + driving video -> the character performs that motion. Runs as a video job (engine "animate"),
    so the library, progress and archiving treat it like any other clip."""
    spec = C.ENGINES["animate"]
    image, video = _http_url(body.get("image_url"), "image_url"), _http_url(body.get("video_url"), "video_url")
    if not image or not video:
        raise ValueError("animate needs image_url (the character) and video_url (the motion to copy)")
    if spec.get("min_gpu_gb") and gpu_info()["total_gb"] < spec["min_gpu_gb"]:
        raise ValueError(f"animate needs a {spec['min_gpu_gb']:g} GB+ GPU (A100 class); this runtime has {gpu_info()['total_gb']:g} GB")
    aspect = body.get("aspect") or "9:16"
    if aspect not in spec["sizes"]:
        raise ValueError(f"aspect must be one of {list(spec['sizes'])}")
    w, h = spec["sizes"][aspect]
    seconds = max(1.0, min(spec["max_seconds"], float(body.get("seconds") or spec["max_seconds"])))
    fps = spec["fps"]
    frames = max(1, round(seconds * fps / 4)) * 4 + 1
    seed = body.get("seed")
    job = _base_job("video", body)
    job.update({"engine": "animate", "voice": "", "lines": [], "params": {}, "post": {}, "image_url": image, "video_url": video,
                "gen": {"model": "animate", "mode": "animate", "prompt": str(body.get("prompt") or "").strip()[:2000],
                        "negative": str(body.get("negative") or "")[:2000], "seed": int(seed) if seed not in (None, "") else 7,
                        "steps": spec["qualities"]["fast"]["steps"], "guidance": 1.0, "quality": "fast", "aspect": aspect,
                        "fps": fps, "frames": frames, "seconds": round((frames - 1) / fps, 2), "width": w, "height": h,
                        "audio": False, "retarget": bool(body.get("retarget", False))}})
    job["est_total"] = video_estimate(job["gen"]) + 60
    return _enqueue(job)


def make_reference_job(body):
    name = str(body.get("name") or "")
    if not ID_RE.match(name) or name in C.PRESET_REFS or name == "default":
        raise ValueError("name: 1-64 letters, digits, - or _ (and not female/male/default)")
    url = str(body.get("url") or "")
    if not url.startswith(("https://", "http://")):
        raise ValueError("url must point at the recording")
    job = _base_job("reference", body)
    job.update({"engine": "whisper", "voice": name, "lines": [{"id": "reference", "url": url}], "params": {}, "post": {},
                "transcript": str(body.get("transcript") or "").strip() or None, "version": str(body.get("version") or "")[:40],
                "enhance": body.get("enhance", True) is not False, "from_dataset": bool(body.get("from_dataset")),
                # how much of the recording the clone engines get: 20 s is the sweet spot, up to 60 s if you want more
                "max_seconds": max(6.0, min(60.0, float(body.get("max_seconds") or 20)))})
    if job["from_dataset"]:  # url is a dataset zip: its clips are already clean and transcribed
        job["enhance"] = False
    job["est_total"] = 25.0 + (10.0 if job["enhance"] else 0)
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


# The pause after a chunk when the script doesn't ask for one: what a presenter leaves after that punctuation.
NATURAL_GAP = ((re.compile(r"\?[\"')\]]*$"), 0.42), (re.compile(r"!+[\"')\]]*$"), 0.36), (re.compile(r"[.…][\"')\]]*$"), 0.34),
               (re.compile(r"[,;:–—-][\"')\]]*$"), 0.16))


def natural_gap(text):
    for pat, gap in NATURAL_GAP:
        if pat.search((text or "").strip()):
            return gap
    return 0.22


def speech_level(a, sr):
    """Active speech level in dB (RMS of the 20 ms frames within 25 dB of the loudest), or None for silence."""
    import numpy as np
    n = int(0.02 * sr)
    if len(a) < n * 5:
        return None
    f = a[: len(a) // n * n].reshape(-1, n)
    e = 10 * np.log10(np.mean(f ** 2, axis=1) + 1e-12)
    live = e[e > e.max() - 25]
    return float(10 * np.log10(np.mean(10 ** (live / 10)) + 1e-12)) if e.max() > -70 else None


def _join_chunks(paths, out_path, gaps=None, texts=None):
    """Join chunk WAVs with the pause their punctuation calls for (a question gets a longer one than a comma), or the
    gap a [pause] marker asked for (gaps[i] follows chunk i). Each chunk is trimmed to its speech and gets a few ms of
    fade at both ends, so the joins don't click."""
    import numpy as np
    import soundfile as sf
    parts, sr, clips = [], None, []
    for p in paths:
        a, sr_ = sf.read(p, dtype="float32", always_2d=False)
        clips.append(a.mean(axis=1) if a.ndim > 1 else a)
        sr = sr or sr_
    # every sentence at the same speech level (each one was generated on its own and can come out a little louder or
    # softer): bring each to the median, at most +/-6 dB, so a script never jumps in volume at a sentence boundary
    levels = [speech_level(a, sr) for a in clips] if len(clips) > 1 else []
    ref = float(np.median([x for x in levels if x is not None])) if any(x is not None for x in levels) else None
    for i, a in enumerate(clips):
        if ref is not None and levels[i] is not None:
            a = a * 10 ** (max(-6.0, min(6.0, ref - levels[i])) / 20)
            peak = float(np.max(np.abs(a))) if len(a) else 0.0
            if peak > 0.98:  # never clip a sentence to match the others
                a = a * (0.98 / peak)
        if len(paths) > 1:
            idx = np.where(np.abs(a) > 10 ** (-45 / 20))[0]
            if len(idx):
                a = a[max(0, idx[0] - int(0.04 * sr)): idx[-1] + int(0.06 * sr)].copy()
            f = min(len(a) // 4, int(0.008 * sr))
            if f > 1:
                ramp = np.linspace(0.0, 1.0, f, dtype="float32")
                a[:f] *= ramp
                a[-f:] *= ramp[::-1]
        parts.append(a)
        gap = gaps[i] if gaps and i < len(gaps) else None
        if gap is None:
            gap = natural_gap(texts[i]) if texts and i < len(texts) else 0.2
        parts.append(np.zeros(int(gap * sr), dtype="float32"))
    sf.write(out_path, np.concatenate(parts[:-1]) if parts else np.zeros(1, "float32"), sr)


def _is_english(engine, voice, params, job):
    if engine in ("orpheus", "myvoice"):
        return True
    if engine == "kokoro":
        return (voice or "a")[0] in "ab" or str(voice).startswith("kv_")  # kv_: your voice found in Kokoro (English)
    lang = params.get("language") or job.get("language") or "en"
    return str(lang).lower().startswith("en")


def _line_plan(job, ln, engine, voice_arg):
    """How one line gets voiced: which engine (Hindi lines on a Qwen job go to Chatterbox, same voice), its params,
    and its chunks as (script text, spoken text, gap after) — split at [pause] markers, then at sentences."""
    eng, params = engine, {**job["params"], **ln["params"]}
    if engine == "qwen" and is_devanagari(ln["text"]):
        eng = "chatterbox"
        params = {**C.style_settings(job["style"], "chatterbox")[0], **{k: v for k, v in params.items() if k == "seed"}, "language": "hi"}
    params = C.resolve_params(eng, params)
    english = _is_english(eng, voice_arg if eng == engine else None, params, job)
    chunks = []
    text = re.sub(r"\s*\n\s*\n\s*", " [pause 0.7] ", ln["text"].strip())  # a new paragraph is a longer breath
    for seg, gap in segments(text):
        parts = split_text(seg, C.ENGINES[eng].get("chunk_chars", 0))
        for k, part in enumerate(parts):
            said = speakable(part, job.get("pronounce"), tech=english and job.get("lexicon", True)) or part
            chunks.append((part, said, gap if k == len(parts) - 1 else None))
    return {"ln": ln, "engine": eng, "params": params, "chunks": chunks,
            "voice_arg": voice_arg if eng == engine else None}


def run_tts(job):
    if job.get("mode") == "benchmark":
        return run_benchmark(job)
    if job.get("mode") == "revoice":
        return run_revoice(job)
    if job.get("mode") == "clean":
        return run_clean(job)
    engine, voice = job["engine"], job["voice"]
    jdir = os.path.join(JOBS_DIR, job["id"])
    ref_path = ref_text = None
    if engine == "qwen" and str(voice).startswith("ft_"):
        ref_path = get_qwen_model(job, voice)  # a fine-tuned voice: the engine loads the model sitting next to this clip
    elif C.ENGINES[engine].get("clone") or (engine == "chatterbox" and voice != "default"):
        job["stage"] = "reference"
        ref_path, ref_text = get_ref(voice, job.get("ref"))
    if engine == "kokoro" and str(voice).startswith("kv_"):
        ref_path = get_kvoice(job, voice)  # the style vector found for you (voicewalk), handed to Kokoro as its voice
    job["ref_path"] = ref_path
    voice_arg = voice if engine in ("kokoro", "orpheus", "myvoice") else None
    lora = None
    if engine == "myvoice":
        lora, speaker = get_adapter(job, voice)
        voice_arg = speaker or voice_arg
    takes = job.get("takes", 1)

    plans = [_line_plan(job, ln, engine, voice_arg) for ln in job["lines"]]
    for p in plans:
        p["lora"] = lora if p["engine"] == "myvoice" else None
    _chain(plans)
    order = {p["ln"]["id"]: i for i, p in enumerate(plans)}
    if any(len(p["chunks"]) > 1 for p in plans):
        job["warnings"].append(f"long lines split into {sum(len(p['chunks']) for p in plans)} chunks (sentences and [pause] markers) and re-joined")
    rerouted = [p["ln"]["id"] for p in plans if p["engine"] != engine]
    if rerouted:
        job["warnings"].append(f"{len(rerouted)} Hindi line(s) voiced by Chatterbox in the same voice (Qwen has no Hindi)")
    if any(c[0] != c[1] for p in plans for c in p["chunks"]):
        job["warnings"].append("tech terms / markdown rewritten for speech (lexicon: false to turn off)")

    def out(p, i, k):
        return os.path.join(jdir, f"{p['ln']['id']}.c{i}.t{k}.wav")

    first = [(p, i, k, _take_params(p, k)) for p in plans for i in range(len(p["chunks"])) for k in range(takes)]
    _generate(job, first, out, ref_path, ref_text, order, len(plans))

    if takes == 1 and not job.get("review"):  # fast path: no listening pass
        for p in plans:
            _assemble(job, jdir, p, [out(p, i, 0) for i in range(len(p["chunks"]))])
    else:
        picks = _review(job, plans, out, ref_path, ref_text, order)
        for p in plans:
            _assemble(job, jdir, p, [out(p, i, picks[p["ln"]["id"]]["take"][i]) for i in range(len(p["chunks"]))],
                      picks[p["ln"]["id"]])
        for x in os.listdir(jdir):  # the takes that lost
            if re.search(r"\.c\d+\.t\d+\.wav$", x):
                os.remove(os.path.join(jdir, x))
    job["results"].sort(key=lambda r: order[r["id"]])

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


# Retakes try the voice's settings a little either side as well as a new seed: that is how a voice's best settings are
# found (the dashboard keeps the scores per voice and feeds the winners back as its learned defaults).
JITTER = [0.0, -0.05, 0.05, -0.1, 0.1, -0.15]


def _take_params(p, k):
    """Engine params for take k of a chunk: take 0 = the line's params; later takes = new seed + a temperature nudge."""
    if not k:
        return p["params"]
    params = {**p["params"], "seed": int(p["params"].get("seed", 7)) + 1000 * k}
    spec = C.ENGINES[p["engine"]]["params"].get("temperature")
    if spec and "temperature" in params:
        t = float(params["temperature"]) + JITTER[k % len(JITTER)]
        params["temperature"] = round(min(spec.get("max", 2.0), max(spec.get("min", 0.05), t)), 3)
    return params


def _chain(plans):
    """Script order for flow: each line's first chunk follows the previous line's last one (see _flow)."""
    for a, b in zip(plans, plans[1:]):
        b["after"] = f"{a['ln']['id']}/{len(a['chunks']) - 1}"


def _flow(job, p, i, k):
    """Names for one chunk take: its own key, and the keys of the chunk before it (same take first, else the first
    take), so an engine that keeps flow (your trained voice) can carry the delivery on from the audio it just made."""
    base = f"{job['id']}/"
    before = f"{p['ln']['id']}/{i - 1}" if i else p.get("after")
    return {"key": f"{base}{p['ln']['id']}/{i}/{k}", "ctx": [f"{base}{before}/{k}", f"{base}{before}/0"] if before else []}


def _generate(job, wanted, out, ref_path, ref_text, order, n_lines):
    """Synthesise (plan, chunk, take, params) items: per engine, batched up to 8 on batch engines (vLLM / Qwen)."""
    for eng in dict.fromkeys(w[0]["engine"] for w in wanted):
        mine = [w for w in wanted if w[0]["engine"] == eng]
        _prepare(job, eng)
        job["stage"] = "generating" if job["stage"] != "fixing" else "fixing"
        # vLLM schedules its own batches (continuous batching over the KV cache): hand it the whole job at once.
        # Qwen batches on plain transformers, where memory grows with the batch: 8 at a time.
        size = (64 if eng in ("orpheus", "myvoice") else 8) if ENG.batch.get(eng) else 1
        for b in range(0, len(mine), size):
            group = mine[b:b + size]
            items = [{"text": p["chunks"][i][1], "voice": p["voice_arg"], "params": params, "ref_path": ref_path,
                      "ref_text": ref_text, "out_path": out(p, i, k), "lora": p.get("lora"), **_flow(job, p, i, k)} for p, i, k, params in group]
            chars = sum(len(it["text"]) for it in items)
            lo, hi = order[group[0][0]["ln"]["id"]] + 1, order[group[-1][0]["ln"]["id"]] + 1
            label = (f"line {lo} of {n_lines}" if lo == hi else f"lines {lo}–{hi} of {n_lines} together")
            if job["stage"] == "fixing":
                label = f"re-voicing {len(mine)} sentence{'s' if len(mine) > 1 else ''} that missed"
            elif job.get("takes", 1) > 1:
                label += f" · {job['takes']} takes each"
            t0 = time.time()
            res = _run_unit(job, RATES[eng] * chars, lambda: ENG.synth_batch(eng, items), label)
            if not ENG.batch.get(eng) or len(items) > 1:
                learn_rate(eng, time.time() - t0, chars)
            errs = [r["error"] for r in res if "error" in r]
            if errs:
                raise RuntimeError(errs[0])
        log(f"job {job['id']} {eng}/{job['voice']} {len(mine)} chunk takes")


def _assemble(job, jdir, p, paths, pick=None):
    """Chunks -> one line WAV: join with the asked-for gaps, then trim, pace, resample and master."""
    ln = p["ln"]
    raw = os.path.join(jdir, f"{ln['id']}.raw.wav")
    _join_chunks(paths, raw, [c[2] for c in p["chunks"]], [c[1] for c in p["chunks"]])
    for x in paths:
        if os.path.exists(x):
            os.remove(x)
    raw = _studio_output(job, raw)
    info = {}
    dur = postprocess(raw, os.path.join(jdir, f"{ln['id']}.wav"), job["post"], info)
    os.remove(raw)
    win = ln.get("window")
    r = {"id": ln["id"], "text": ln["text"], "duration": round(dur, 3), "window": win, "start": ln.get("start"),
         "chunks": len(p["chunks"]), "fits": None if win in (None, "") else dur <= float(win), "lufs": info.get("lufs")}
    if p["engine"] != job["engine"]:
        r["engine"] = p["engine"]
    if any(c[0] != c[1] for c in p["chunks"]):
        r["spoken"] = " ".join(c[1] for c in p["chunks"])
    if pick:
        r["takes"] = {"n": job["takes"], "picked": [k + 1 for k in pick["take"]], "match": pick["match"], "similarity": pick["similarity"], "mos": pick.get("mos")}
        r["review"] = pick.get("review")
    try:  # pitch spread and pauses: the voice coach's "flat" / "odd pause" checks
        r["delivery"] = quality.delivery(os.path.join(jdir, f"{ln['id']}.wav"))
    except Exception:  # noqa: BLE001  a measurement, never worth failing a voiceover over
        pass
    job["results"].append(r)


def _listen(job, paths, ref_path):
    """Whisper + voice match (+ naturalness when available) for a set of takes."""
    import soundfile as sf
    stage = job["stage"]
    _prepare(job, "whisper")
    job["stage"] = stage
    durs = [sf.info(x).duration for x in paths]
    heard = []
    for b in range(0, len(paths), 4):
        batch = paths[b:b + 4]
        audio_s = sum(durs[b:b + 4])
        t0 = time.time()
        heard += _run_unit(job, RATES["whisper"] * audio_s, lambda: ENG.transcribe(batch, job.get("language")),
                           f"listening back: {b + 1}–{b + len(batch)} of {len(paths)}")
        learn_rate("whisper", time.time() - t0, audio_s)
    sims = [None] * len(paths)
    if ref_path:
        try:
            sims = _run_unit(job, 0.3 * len(paths) + 5, lambda: ENG.similarity(ref_path, paths), "comparing with your voice")
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001  a missing voice-match model only costs the similarity half of the score
            job["warnings"].append(f"voice match unavailable ({type(e).__name__}); takes chosen on script accuracy")
    mos = [None] * len(paths)
    if not job.get("_no_mos"):
        try:
            mos = _run_unit(job, 0.15 * len(paths) + 3, lambda: ENG.mos(paths), "rating naturalness")
        except Cancelled:
            raise
        except Exception:  # noqa: BLE001  UTMOS is a tie-breaker; carry on without it (and don't retry every round)
            job["_no_mos"] = True
    clip = []
    for x in paths:
        a, _ = sf.read(x, dtype="float32", always_2d=False)
        clip.append(float((abs(a) > 0.995).mean()) if len(a) else 0.0)
    return [{"heard": h["text"], "sim": s, "mos": m, "dur": d, "clip": c} for h, s, m, d, c in zip(heard, sims, mos, durs, clip)]


def _review(job, plans, out, ref_path, ref_text, order):
    """Listen to every sentence, keep the best take, and re-voice only the sentences that missed (a skipped, swapped
    or invented word, or a voice that drifted from the reference), up to REVIEW rounds, trying the voice's settings a
    little either side each time. Every attempt is reported as a trial so the dashboard can learn this voice's best
    settings. Returns per-line picks."""
    gate = {**quality.REVIEW, **(job.get("review_gate") or {})}
    base = (job.get("profile") or {}).get("sim_base")
    cands = {}  # (line id, chunk) -> {take k: stats}
    by_key = {(p["ln"]["id"], i): p for p in plans for i in range(len(p["chunks"]))}

    def score_all(entries):
        job["stage"] = "choosing"
        stats = _listen(job, [out(p, i, k) for p, i, k, _ in entries], ref_path)
        for (p, i, k, params), st in zip(entries, stats):
            text, said, _ = p["chunks"][i]
            t = quality.score_text(text, st["heard"], said)
            cands.setdefault((p["ln"]["id"], i), {})[k] = {**st, "text": t["score"], "missed": t["missed"], "added": t["added"],
                                                          "temperature": params.get("temperature"), "seed": params.get("seed")}

    def best(key):
        c = cands[key]
        med = sorted(v["dur"] for v in c.values())[len(c) // 2]
        rank = {k: quality.take_score(v["text"], v["sim"], base, v["mos"], v["dur"], med, v["clip"]) for k, v in c.items()}
        k = max(rank, key=rank.get)
        return k, rank[k]

    takes = job.get("takes", 1)
    score_all([(p, i, k, _take_params(p, k)) for p in plans for i in range(len(p["chunks"])) for k in range(takes)])
    retried, rounds = set(), 0 if C.ENGINES[job["engine"]].get("deterministic") or job["engine"] == "kokoro" else gate["rounds"]
    for r in range(rounds):
        failing = []
        for key in cands:
            k, _ = best(key)
            v = cands[key][k]
            why = quality.failed(v["text"], v["sim"], base, gate)
            if why:
                failing.append((key, why))
        if not failing:
            break
        job["stage"] = "fixing"
        job["est_total"] += sum(RATES[by_key[k]["engine"]] * len(by_key[k]["chunks"][k[1]][1]) + RATES["whisper"] * 4 for k, _ in failing)
        new = []
        for key, why in failing:
            p, i = by_key[key], key[1]
            k = max(cands[key]) + 1
            new.append((p, i, k, _take_params(p, k)))
            retried.add(key)
        log(f"job {job['id']} review round {r + 1}: re-voicing {len(new)} chunk(s) ({', '.join(sorted(set(w for _, w in failing)))})")
        _generate(job, new, out, ref_path, ref_text, order, len(plans))
        score_all(new)

    picks, trials = {}, []
    for p in plans:
        chosen, texts, sims, moss, issues = [], [], [], [], []
        for i in range(len(p["chunks"])):
            key = (p["ln"]["id"], i)
            k, _ = best(key)
            v = cands[key][k]
            chosen.append(k)
            texts.append(v["text"] or 0)
            if v["sim"] is not None:
                sims.append(v["sim"])
            if v["mos"] is not None:
                moss.append(v["mos"])
            if quality.failed(v["text"], v["sim"], base, gate):
                issues.append({"chunk": i + 1, "missed": v["missed"], "added": v["added"], "match": v["text"], "similarity": v["sim"]})
            for kk, vv in cands[key].items():
                trials.append({"engine": p["engine"], "temperature": vv["temperature"], "text": vv["text"], "sim": vv["sim"],
                               "mos": vv["mos"], "picked": kk == k})
        n_retried = sum(1 for i in range(len(p["chunks"])) if (p["ln"]["id"], i) in retried)
        picks[p["ln"]["id"]] = {"take": chosen, "match": round(sum(texts) / len(texts), 3), "similarity": round(sum(sims) / len(sims), 3) if sims else None,
                                "mos": round(sum(moss) / len(moss), 2) if moss else None, "review": {"retried": n_retried, "fixed": n_retried - len(issues) if n_retried else 0, "issues": issues}}
    job["trials"] = trials[:2000]
    fixed = sum(x["review"]["fixed"] for x in picks.values())
    still = sum(len(x["review"]["issues"]) for x in picks.values())
    if fixed:
        job["warnings"].append(f"review: re-voiced and fixed {fixed} sentence{'s' if fixed > 1 else ''} that missed the script or the voice")
    if still:
        job["warnings"].append(f"review: {still} sentence{'s' if still > 1 else ''} still below the bar after {rounds} retries (see each line's issues)")
    return picks


def run_revoice(job):
    """Speech-to-speech: clean the user's performance, cut it into <= ~20 s pieces at the quietest moments, convert
    each to the target voice with Chatterbox VC, and butt them back together with no gaps so the timing still
    matches the original video frame for frame."""
    import numpy as np
    import soundfile as sf
    jdir = os.path.join(JOBS_DIR, job["id"])
    job["stage"] = "downloading"
    raw = os.path.join(jdir, "performance.in")
    _download(job["lines"][0]["url"], raw, 600 * 1024 * 1024)
    job["stage"] = "cleaning"
    clean = os.path.join(jdir, "performance.wav")
    prep = os.path.join(jdir, "performance.prep.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-vn", "-ac", "1", "-ar", "44100", "-af", "highpass=f=60", prep], check=True)
    os.remove(raw)
    # noise in the performance turns into mumbles in the new voice: denoise it first (timbre doesn't matter here)
    done = False
    if job.get("enhance", True):
        try:
            job["stage"] = "denoising"
            cleanup.denoise(HOME, prep, clean, 100)  # DeepFilterNet on the CPU: fast, keeps the performance's timing
            done = True
        except Exception as e:  # noqa: BLE001
            job["warnings"].append(f"DeepFilterNet unavailable ({type(e).__name__}); used the enhancer's denoiser")
            done = studio_clean(job, prep, clean, {"mode": "denoise"}, "removing background noise")
    if not done:
        job["stage"] = "cleaning"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", prep, "-af", "lowpass=f=11000,afftdn=nf=-28", clean], check=True)
    os.remove(prep)
    a, sr = sf.read(clean, dtype="float32", always_2d=False)
    dur = len(a) / sr
    if dur < 1:
        raise ValueError("the performance is under a second long")
    if dur > 15 * 60:
        raise ValueError("re-voice takes up to 15 minutes at a time; split the performance")
    # cut points: the quietest 50 ms within +-4 s of every 20 s mark
    win = int(0.05 * sr)
    energy = np.convolve(a ** 2, np.ones(win) / win, mode="same")
    cuts, t = [0], 20.0
    while t < dur - 5:
        lo, hi = int((t - 4) * sr), int(min(dur, t + 4) * sr)
        c = lo + int(np.argmin(energy[lo:hi]))
        cuts.append(c)
        t = c / sr + 20.0
    cuts.append(len(a))
    pieces = []
    for n in range(len(cuts) - 1):
        p = os.path.join(jdir, f"piece{n}.wav")
        sf.write(p, a[cuts[n]:cuts[n + 1]], sr)
        pieces.append((p, (cuts[n + 1] - cuts[n]) / sr))
    os.remove(clean)
    job["stage"] = "reference"
    ref_path, _ = get_ref(job["voice"], job.get("ref"))
    job["ref_path"] = ref_path
    job["est_total"] = RATES["revoice"] * dur + (RATES["whisper"] * dur if job["subtitles"] else 0) + 10
    _prepare(job, "chatterbox")
    job["stage"] = "generating"
    outs = []
    for n, (p, d) in enumerate(pieces):
        o = os.path.join(jdir, f"piece{n}.out.wav")
        t0 = time.time()
        _run_unit(job, RATES["revoice"] * d, lambda: ENG.revoice({"src_path": p, "ref_path": ref_path, "out_path": o}),
                  f"piece {n + 1} of {len(pieces)}")
        learn_rate("revoice", time.time() - t0, d)
        outs.append(o)
        os.remove(p)
    parts, osr = [], None
    for o in outs:
        x, osr = sf.read(o, dtype="float32", always_2d=False)
        parts.append(x.mean(axis=1) if x.ndim > 1 else x)
        os.remove(o)
    joined = os.path.join(jdir, "revoice.raw.wav")
    sf.write(joined, np.concatenate(parts), osr)
    joined = _studio_output(job, joined)
    info = {}
    final = postprocess(joined, os.path.join(jdir, "revoice.wav"), job["post"], info)
    os.remove(joined)
    job["results"].append({"id": "revoice", "text": "", "duration": round(final, 3), "window": None, "start": None,
                           "chunks": len(pieces), "fits": None, "lufs": info.get("lufs"), "source_s": round(dur, 2)})
    if job["subtitles"]:
        try:
            subtitle_tts(job, jdir)
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job["warnings"].append(f"subtitles failed ({type(e).__name__}); audio is saved")
    r = job["results"][0]
    r["text"] = r.get("heard") or "Re-voiced performance"
    r["match"] = None
    job["match"] = None


def subtitle_tts(job, jdir):
    _prepare(job, "whisper")
    job["stage"] = "subtitles"
    style = C.CAPTION_STYLES[job.get("captions") or "subtitles"]
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
            t = quality.score_text(r["text"], o["text"], r.get("spoken"))  # same spoken form both sides: "SQL" == "sequel"
            r["match"] = t["score"]
            if t["missed"] or t["added"]:
                r["diff"] = {"missed": t["missed"], "added": t["added"]}
            r["words"] = o["words"]
            cues = cues_from_words(o["words"], style=style)
            write_subs(jdir, f"{x}.subs", cues, o["words"])
            r["subs"] = True
    if job.get("ref_path"):  # how much each finished line sounds like the cloned voice
        try:
            ids = [r["id"] for r in job["results"]]
            sims = _run_unit(job, 0.3 * len(ids) + 5, lambda: ENG.similarity(job["ref_path"], [os.path.join(jdir, f"{x}.wav") for x in ids]),
                             "comparing with the reference voice")
            for x, s in zip(ids, sims):
                res_by_id[x]["similarity"] = s
            job["similarity"] = round(sum(sims) / len(sims), 3) if sims else None
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001
            job["warnings"].append(f"voice match unavailable ({type(e).__name__})")
    # one subtitle file for the whole timeline: real starts when given, else lines back to back
    t, cues, words = 0.0, [], []
    for r in job["results"]:
        off = float(r["start"]) if r.get("start") not in (None, "") else t
        cues += cues_from_words(r.get("words") or [], off, style)
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
                               "match": quality.score_text(s["text"], o["text"])["score"] if s.get("text") else None})
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


def run_image(job):
    g, model = job["gen"], job["engine"]
    jdir = os.path.join(JOBS_DIR, job["id"])
    os.makedirs(jdir, exist_ok=True)
    payload = {k: g.get(k) for k in ("prompt", "negative", "seed", "steps", "guidance", "quality", "count", "transparent")}
    payload.update({"width": g["width"], "height": g["height"], "out_dir": jdir,
                    "progress_path": os.path.join(jdir, "progress.json")})
    if job.get("image_urls"):
        job["stage"] = "downloading"
        paths = []
        for i, url in enumerate(job["image_urls"], 1):
            raw = os.path.join(jdir, f"ref-{i}.in")
            _download(url, raw, 40 * 1024 * 1024)
            paths.append(raw)
        payload["image_paths"] = paths
    _prepare(job, model)
    job["stage"] = "rendering"
    job["progress_file"] = payload["progress_path"]
    units = g["steps"] * g["width"] * g["height"] / 1e6 * g["count"]
    t0 = time.time()
    try:
        out = _run_unit(job, image_estimate(g), lambda: ENG.image(model, payload), f"{g['count']} image(s) at {g['width']}x{g['height']}")
    except RuntimeError:
        if job["cancel"]:
            raise Cancelled()
        raise
    learn_rate(model, time.time() - t0, units)
    job["results"] = [{"id": im["file"].rsplit(".", 1)[0], "text": g["prompt"], "duration": 0, **im} for im in out["images"]]


def run_animate(job):
    g = job["gen"]
    jdir = os.path.join(JOBS_DIR, job["id"])
    os.makedirs(jdir, exist_ok=True)
    job["stage"] = "downloading"
    img_raw, vid_raw = os.path.join(jdir, "source.in"), os.path.join(jdir, "driving.in")
    _download(job["image_url"], img_raw, 40 * 1024 * 1024)
    _download(job["video_url"], vid_raw, 300 * 1024 * 1024)
    src = os.path.join(jdir, "source.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", img_raw, "-frames:v", "1", "-q:v", "2", src], check=True)
    os.remove(img_raw)
    g["source"] = True
    payload = {k: g.get(k) for k in ("prompt", "negative", "seed", "steps", "guidance", "fps", "retarget")}
    payload.update({"width": g["width"], "height": g["height"], "num_frames": g["frames"], "image_path": src,
                    "video_path": vid_raw, "work_dir": os.path.join(jdir, "prep"),
                    "out_path": os.path.join(jdir, "video.mp4"), "progress_path": os.path.join(jdir, "progress.json")})
    _prepare(job, "animate")
    job["stage"] = "rendering"
    job["progress_file"] = payload["progress_path"]
    units = g["steps"] * g["frames"] * g["width"] * g["height"] / 1e6
    t0 = time.time()
    try:
        info = _run_unit(job, video_estimate(g), lambda: ENG.animate("animate", payload), f"{g['seconds']:g} s at {g['width']}x{g['height']}")
    except RuntimeError:
        if job["cancel"]:
            raise Cancelled()
        raise
    learn_rate("animate", time.time() - t0, units)
    job["stage"] = "packaging"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", payload["out_path"], "-frames:v", "1", "-q:v", "3",
                    os.path.join(jdir, "poster.jpg")], check=True)
    info["size"] = os.path.getsize(payload["out_path"])
    job["video"] = {**info, "poster": True}
    job["results"] = [{"id": "video", "text": g["prompt"] or "animate", "duration": info["duration"]}]


def run_video(job):
    if job.get("mode") == "story":
        return run_story(job)
    if job["engine"] == "animate":
        return run_animate(job)
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


def _reference_from_dataset(url, jdir, out, cap=20.0):
    """A cloning reference from a dataset zip (Your model): a run of consecutive 3-12 s clips from the middle of the
    session, about cap seconds in all (70-100% of it), joined with short pauses. Writes out (WAV) and returns the words."""
    import io
    import numpy as np
    import soundfile as sf
    zpath = os.path.join(jdir, "dataset.zip")
    _download(url, zpath, 2 * 1024 * 1024 * 1024)
    with zipfile.ZipFile(zpath) as z:
        rows = [ln.split("|", 1) for ln in z.read("metadata.csv").decode("utf-8").splitlines() if "|" in ln]
        lens = {f: sf.info(io.BytesIO(z.read(f))).duration for f, _ in rows}
        ok = [3.0 <= lens[f] <= 12.0 for f, _ in rows]
        best, mid = None, len(rows) // 2
        for i in sorted(range(len(rows)), key=lambda k: abs(k - mid)):  # start near the middle: past the intro, warmed up
            total, j = 0.0, i
            while j < len(rows) and ok[j] and total < 0.7 * cap:
                total += lens[rows[j][0]]
                j += 1
            if 0.7 * cap <= total <= cap + 2:
                best = (i, j)
                break
        if not best:
            # a small dataset: take the longest run there is rather than nothing
            starts = [i for i in range(len(rows)) if ok[i]]
            if not starts:
                raise ValueError("no clean 3-12 s clips in this dataset: add a longer session")
            best, total = None, 0.0
            for i in starts:
                t, j = 0.0, i
                while j < len(rows) and ok[j] and t + lens[rows[j][0]] <= cap + 2:
                    t += lens[rows[j][0]]
                    j += 1
                if t > total:
                    best, total = (i, j), t
        parts, sr = [], 24000
        for f, _ in rows[best[0]:best[1]]:
            a, sr = sf.read(io.BytesIO(z.read(f)), dtype="float32")
            parts += [a if a.ndim == 1 else a.mean(axis=1), np.zeros(int(0.3 * sr), dtype="float32")]
    os.remove(zpath)
    sf.write(out, np.concatenate(parts[:-1]), sr, subtype="PCM_16", format="WAV")
    return " ".join(t.strip() for _, t in rows[best[0]:best[1]])


def run_reference(job):
    """Turn a raw recording into a clean cloning reference: mono, rumble + hiss removed, silence trimmed,
    level normalised, cut to <= ~20 s at a word boundary, transcribed by Whisper (cloners need the words)."""
    import numpy as np
    import soundfile as sf
    jdir = os.path.join(JOBS_DIR, job["id"])
    job["stage"] = "downloading"
    raw = os.path.join(jdir, "recording.in")
    if job.get("from_dataset"):
        job["transcript"] = _reference_from_dataset(job["lines"][0]["url"], jdir, raw, job.get("max_seconds") or 20.0)
    else:
        _download(job["lines"][0]["url"], raw, 60 * 1024 * 1024)
    job["stage"] = "cleaning"
    clean = os.path.join(jdir, "clean.wav")
    prep = os.path.join(jdir, "prep.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-vn", "-ac", "1", "-ar", "44100", "-af", "highpass=f=60", prep], check=True)
    a, sr = sf.read(prep, dtype="float32")
    peak = float(np.max(np.abs(a))) if len(a) else 0.0
    rms_db = float(20 * np.log10(max(1e-9, float(np.sqrt(np.mean(a ** 2)))))) if len(a) else -120.0
    if peak > 0.98:
        job["warnings"].append("the recording clips (too loud): move back a little or lower the input gain")
    if rms_db < -38:
        job["warnings"].append("the recording is very quiet: move closer to the mic")
    # studio clean-up first (a better reference = a better clone); the plain ffmpeg chain if the enhancer can't run
    rep = None
    if job.get("enhance"):
        rep = smart_clean(job, prep, clean)
        job["cleanup"] = _cleanup_summary(rep)
    else:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", prep, "-af", "lowpass=f=14000,afftdn=nf=-30", clean], check=True)
    job["enhanced"] = bool(rep and rep["steps"])
    out = os.path.join(jdir, "reference.wav")
    dur = postprocess(clean, out, {"trim": True, "trim_db": -45, "normalize_dbfs": -3, "sample_rate": None})
    os.remove(raw); os.remove(clean); os.remove(prep)
    if dur < 4:
        raise ValueError(f"only {dur:.1f} s of speech: record at least 6-10 seconds")
    words, heard = [], job.get("transcript")
    cap = job.get("max_seconds") or 20.0
    if dur > cap + 4:  # only the first ~cap seconds are kept: don't make Whisper read a 7 min upload to find the cut
        a, sr = sf.read(out, dtype="float32")
        sf.write(out, a[: int((cap + 6) * sr)], sr, subtype="PCM_16")
        dur = min(dur, cap + 6)
        heard = None if not job.get("from_dataset") else heard
    if not heard or dur > cap + 4:
        _prepare(job, "whisper")
        job["stage"] = "transcribing"
        o = _run_unit(job, RATES["whisper"] * dur + 2, lambda: ENG.transcribe([out], job.get("language"))[0])
        words, heard = o["words"], heard or o["text"]
    cut = False
    if dur > cap + 4 and words:  # long takes: keep the first ~cap seconds, ending on a finished word
        end = max((w["e"] for w in words if w["e"] <= cap), default=cap)
        a, sr = sf.read(out, dtype="float32")
        sf.write(out, a[: int((end + 0.15) * sr)], sr, subtype="PCM_16")
        heard = re.sub(r"\s+(?=[.,!?;:%\u2019])", "", " ".join(w["w"] for w in words if w["e"] <= end + 0.01))
        dur, cut = end + 0.15, True
    if dur < 8:
        job["warnings"].append("under 8 s: cloning works, but 10-20 s of varied speech sounds much more like you")
    name = job["voice"]
    shutil.copy(out, ref_paths(name)[0])
    json.dump({"transcript": heard, "version": job.get("version"), "source": "recording", "enhanced": job["enhanced"]},
              open(ref_paths(name)[1], "w"))
    job["results"] = [{"id": "reference", "text": heard, "duration": round(dur, 2), "cut": cut,
                       "level_db": round(rms_db, 1), "peak": round(peak, 3), "enhanced": job["enhanced"], "cleanup": job.get("cleanup")}]


# --------------------------------------------------------------------------------------- your own voice model
MAX_DATASET_S = 3 * 3600


def make_dataset_job(body):
    """Long recordings of you -> training clips (see dataset.py). sources: [{url, name?}]; name: the dataset (voice)."""
    name = str(body.get("name") or "")
    if not ID_RE.match(name):
        raise ValueError("name: the dataset to add to (letters, digits, - and _)")
    sources = body.get("sources") or []
    if not sources or len(sources) > 20:
        raise ValueError("sources: 1-20 recordings [{url, name?}]")
    lines = []
    for i, src in enumerate(sources):
        lines.append({"id": f"s{i + 1:02d}", "url": _http_url(src.get("url"), f"source {i + 1} url"), "name": str(src.get("name") or f"recording {i + 1}")[:80],
                      "text": str(src.get("text") or "")[:20000]})
    job = _base_job("dataset", body)
    # auto_train: once this batch is stored, the dashboard starts training on the whole dataset (if it has enough)
    job.update({"voice": name, "lines": lines, "engine": "whisper", "auto_train": bool(body.get("auto_train"))})
    job["est_total"] = 120.0 * len(lines)
    return _enqueue(job)


def _dataset_prep(job, src, jdir):
    """Download one recording and remove its noise (CPU: ffmpeg + DeepFilterNet), so it can run on a helper thread
    while the GPU transcribes the recording before it. Noise only, never "restore": the model should learn your real
    tone. Returns (clean wav, seconds, clean-up report)."""
    raw = os.path.join(jdir, f"{src['id']}.in")
    _download(src["url"], raw, 1024 * 1024 * 1024)
    prep = os.path.join(jdir, f"{src['id']}.prep.wav")
    p = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-vn", "-ac", "1", "-ar", "48000", "-af", "highpass=f=60", prep],
                       capture_output=True, text=True)
    os.remove(raw)
    if p.returncode != 0:
        raise ValueError(f"couldn't read it as audio ({(p.stderr.strip().splitlines() or ['ffmpeg failed'])[-1][:120]})")
    import soundfile as sf
    dur = sf.info(prep).duration
    if dur < 3:
        os.remove(prep)
        raise ValueError(f"only {dur:.1f} s long")
    clean = os.path.join(jdir, f"{src['id']}.clean.wav")
    rep = cleanup.run(prep, clean, jdir, HOME, enhance=None, similarity=None, prefer="denoise", note=lambda m: None)
    os.remove(prep)
    return clean, dur, rep


def _dataset_clips(clean, words, src, wavs):
    """Cut one cleaned recording into 24 kHz clips at the segment() boundaries, level each one, and check it.
    CPU only. Returns (kept [(file name, text, seconds)], dropped {reason: n})."""
    import numpy as np
    import soundfile as sf
    from math import gcd
    from scipy.signal import resample_poly
    a, sr = sf.read(clean, dtype="float32", always_2d=False)
    g = gcd(24000, sr)
    kept, dropped = [], {}
    # the room's noise floor, measured once on the whole recording (its pauses): a short clip of continuous talking
    # has no silence of its own, so its own estimate mistakes quiet syllables for noise and reads 15 dB on a clean take
    rec = quality.analyze(clean)
    floor = rec.get("noise_db")
    # same for the room's echo: one room per recording, and a few seconds hold too few word endings to measure it
    # (a dry take's clips spread 0.34-0.51 s and the tail crossed the limit), so a clip can't read much roomier than the recording
    room = rec.get("reverb_s")
    for i, (s0, e0, text) in enumerate(dataset.segment(words, len(a) / sr)):
        clip = a[int(s0 * sr): int(e0 * sr)]
        if not len(clip):
            continue
        clip = resample_poly(clip, 24000 // g, sr // g).astype("float32")
        fname = f"{src['id']}_{i:04d}.wav"
        path = os.path.join(wavs, fname)
        sf.write(path, clip, 24000, subtype="FLOAT")
        m = quality.analyze(path)
        if floor is not None and m.get("level_db") is not None:
            m["snr_db"] = max(m.get("snr_db") or -99.0, m["level_db"] - floor)
        if room is not None and m.get("reverb_s") is not None:
            m["reverb_s"] = min(m["reverb_s"], room + 0.08)
        why = dataset.keep(text, len(clip) / 24000, m)
        if why:
            dropped[why] = dropped.get(why, 0) + 1
            os.remove(path)
            continue
        clip = clip * dataset.level_gain(m, float(np.max(np.abs(clip))))  # one loudness for every clip
        sf.write(path, clip, 24000, subtype="PCM_16")
        kept.append((fname, text, len(clip) / 24000))
    return kept, dropped


def run_dataset(job):
    """Each recording: clean (noise only), Whisper word timestamps, cut into 2-20 s clips at sentence ends / long
    pauses, check and level each clip, write 24 kHz WAVs + metadata.csv, zip.
    Pipelined: while the GPU transcribes recording n, a helper thread downloads and denoises n+1 and another cuts the
    clips of n-1, so the CPU and the GPU are both busy. A recording that can't be used is reported and skipped; the
    job only fails when nothing at all is usable, and then says why."""
    from concurrent.futures import ThreadPoolExecutor
    jdir = os.path.join(JOBS_DIR, job["id"])
    wavs = os.path.join(jdir, "wavs")
    os.makedirs(wavs, exist_ok=True)
    meta, dropped, total_in, kept_s, failed = [], {}, 0.0, 0.0, []
    srcs = job["lines"]
    prep_pool, cut_pool = ThreadPoolExecutor(1), ThreadPoolExecutor(max(1, min(4, (os.cpu_count() or 2) - 1)))
    job["stage"] = "downloading"
    preps = [prep_pool.submit(_dataset_prep, job, src, jdir) for src in srcs]  # run one after another, ahead of the GPU
    cuts = []
    try:
        for n, src in enumerate(srcs):
            if job["cancel"]:
                raise Cancelled()
            if not preps[n].done():
                job["stage"] = "cleaning"
            job["cur"] = {"t0": time.time(), "est": 30.0, "label": f"{src['name']}: removing background noise"}
            try:
                clean, dur, rep = preps[n].result()
            except Exception as e:  # noqa: BLE001  one bad file shouldn't sink the batch
                failed.append(f"{src['name']}: {e}")
                job["warnings"].append(f"{src['name']} skipped: {e}")
                continue
            finally:
                job["cur"] = None
            total_in += dur
            if total_in > MAX_DATASET_S:
                os.remove(clean)
                job["warnings"].append(f"{src['name']} and later skipped: a batch takes up to 3 hours of audio")
                break
            for sk in rep.get("skipped", []):
                job["warnings"].append(f"{src['name']}: clean-up step {sk['step']} skipped ({sk['error']})")
            job["est_total"] = max(job["est_total"], job["est_done"] + RATES["whisper"] * dur + 10)
            _prepare(job, "whisper")
            job["stage"] = "transcribing"
            t0 = time.time()
            o = _run_unit(job, RATES["whisper"] * dur + 2, lambda: ENG.transcribe([clean], job.get("language"))[0],
                          f"{src['name']}: writing down every word")
            learn_rate("whisper", time.time() - t0, max(dur, 1))
            job["stage"] = "cutting"
            cuts.append((src, dur, rep, cut_pool.submit(_dataset_clips, clean, o["words"], src, wavs), clean))
        job["stage"] = "cutting"
        for src, dur, rep, fut, clean in cuts:
            try:
                kept, drop = fut.result()
            except Exception as e:  # noqa: BLE001
                failed.append(f"{src['name']}: {type(e).__name__}: {e}")
                job["warnings"].append(f"{src['name']} skipped while cutting clips ({type(e).__name__})")
                continue
            finally:
                if os.path.exists(clean):
                    os.remove(clean)
            for k, v in drop.items():
                dropped[k] = dropped.get(k, 0) + v
            meta += [f"wavs/{f}|{t}" for f, t, _ in kept]
            secs = sum(d for _, _, d in kept)
            kept_s += secs
            job["results"].append({"id": src["id"], "name": src["name"], "duration": round(dur, 1), "clips": len(kept),
                                   "minutes": round(secs / 60, 2), "dropped": drop, "cleanup": _cleanup_summary(rep)})
            if not kept:
                job["warnings"].append(f"{src['name']}: no clips kept ({dataset.explain(drop) or 'nothing usable heard'})")
    finally:
        prep_pool.shutdown(wait=True, cancel_futures=True)
        cut_pool.shutdown(wait=True)
    if not meta:
        why = dataset.explain(dropped)
        raise ValueError("no usable clips" + (f": dropped {why}" if why else "") + (f"; {'; '.join(failed)[:300]}" if failed else "")
                         + ". Record close to the mic in a quiet room, in whole sentences")
    job["stage"] = "packaging"
    summary = {"name": job["voice"], "clips": len(meta), "minutes": round(kept_s / 60, 2), "input_minutes": round(total_in / 60, 2),
               "dropped": dropped, "skipped": failed, "sample_rate": 24000, "level_db": dataset.LEVEL_DB, "format": "ljspeech (metadata.csv: file|text)"}
    with zipfile.ZipFile(os.path.join(jdir, "dataset.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("metadata.csv", "\n".join(meta) + "\n")
        z.writestr("summary.json", json.dumps(summary, indent=2))
        for f in sorted(os.listdir(wavs)):
            z.write(os.path.join(wavs, f), f"wavs/{f}")
    shutil.rmtree(wavs)
    job["dataset"] = summary
    log(f"job {job['id']} dataset {job['voice']}: {summary['clips']} clips, {summary['minutes']} min (dropped {dropped})")


MAX_BENCH = 6


def make_benchmark_job(body):
    """The same held-out sentences in every candidate voice, scored the same way. candidates: [{engine, voice, params?,
    label?}]; target_ref: the recording to measure voice match against (your real voice); refs: {voice: ref} for
    recorded voices used by cloners."""
    cands = body.get("candidates") or []
    if not 1 <= len(cands) <= MAX_BENCH:
        raise ValueError(f"candidates: 1-{MAX_BENCH} of {{engine, voice}}")
    lines = body.get("lines") or []
    if not 1 <= len(lines) <= 20:
        raise ValueError("lines: 1-20 test sentences (ones the model did not train on)")
    clean = []
    for c in cands:
        if c.get("engine") not in C.TTS_ENGINES:
            raise ValueError(f"candidate engine must be one of {C.TTS_ENGINES}")
        clean.append({"engine": c["engine"], "voice": resolve_voice(c["engine"], c.get("voice")), "params": c.get("params") or {},
                      "label": str(c.get("label") or f"{c['engine']} · {c.get('voice') or 'default'}")[:60]})
    job = _base_job("tts", body)
    _voice_setup(job, {**body, "engine": clean[0]["engine"], "voice": clean[0]["voice"], "review": False, "takes": 1, "subtitles": False},
                 [{"id": f"{i + 1:02d}", "text": str(t.get("text") if isinstance(t, dict) else t)} for i, t in enumerate(lines)])
    job.update({"mode": "benchmark", "candidates": clean, "refs": body.get("refs") if isinstance(body.get("refs"), dict) else {},
                "target_ref": body.get("target_ref") if isinstance(body.get("target_ref"), dict) else None,
                "target_voice": str(body.get("target_voice") or "")})
    chars = sum(len(l["text"]) for l in job["lines"])
    job["est_total"] = sum(RATES[c["engine"]] * chars + LOAD_PRIORS_S.get(c["engine"], 60) for c in clean) + RATES["whisper"] * chars / 14 * len(clean) + 30
    return _enqueue(job)


LOAD_PRIORS_S = C.LOAD_PRIORS


def run_benchmark(job):
    """Voice every test sentence with every candidate (one take, no review: we're measuring the model, not the
    retry loop), master them the same way, then score each: script accuracy, voice match vs your real recording,
    naturalness (UTMOS), speed. Ranked by the same blend the review uses."""
    jdir = os.path.join(JOBS_DIR, job["id"])
    keep_lines = list(job["lines"])
    target = None
    if job.get("target_voice"):
        job["stage"] = "reference"
        target, _ = get_ref(job["target_voice"], job.get("target_ref"))
    board, keep = [], {k: job[k] for k in ("engine", "voice", "params")}
    for ci, cand in enumerate(job["candidates"]):
        sp, _ = C.style_settings(job["style"], cand["engine"])
        job.update({"engine": cand["engine"], "voice": cand["voice"], "params": {**sp, **cand["params"]}})
        ref_path = ref_text = None
        if cand["engine"] == "qwen" and str(cand["voice"]).startswith("ft_"):
            try:
                ref_path = get_qwen_model(job, cand["voice"])
            except Exception as e:  # noqa: BLE001
                board.append({"label": cand["label"], "engine": cand["engine"], "voice": cand["voice"], "error": str(e)[:200]})
                continue
        elif C.ENGINES[cand["engine"]].get("clone") or (cand["engine"] == "chatterbox" and cand["voice"] != "default"):
            job["stage"] = "reference"
            ref_path, ref_text = get_ref(cand["voice"], (job.get("refs") or {}).get(cand["voice"]))
        if cand["engine"] == "kokoro" and str(cand["voice"]).startswith("kv_"):
            try:
                ref_path = get_kvoice(job, cand["voice"])
            except Exception as e:  # noqa: BLE001
                board.append({"label": cand["label"], "engine": cand["engine"], "voice": cand["voice"], "error": str(e)[:200]})
                continue
        voice_arg = cand["voice"] if cand["engine"] in ("kokoro", "orpheus", "myvoice") else None
        lora = None
        if cand["engine"] == "myvoice":
            try:
                lora, speaker = get_adapter(job, cand["voice"])
            except Exception as e:  # noqa: BLE001
                job["warnings"].append(f"{cand['label']}: {e}")
                board.append({"label": cand["label"], "engine": cand["engine"], "voice": cand["voice"], "error": str(e)[:200]})
                continue
            voice_arg = speaker or voice_arg
        lines = [{**ln, "id": f"c{ci + 1}-{ln['id']}"} for ln in keep_lines]
        plans = [_line_plan(job, ln, cand["engine"], voice_arg) for ln in lines]
        for p in plans:
            p["lora"] = lora if p["engine"] == "myvoice" else None
        order = {p["ln"]["id"]: i for i, p in enumerate(plans)}

        def out(p, i, k):
            return os.path.join(jdir, f"{p['ln']['id']}.c{i}.t{k}.wav")
        t0, first = time.time(), len(job["results"])
        try:
            _generate(job, [(p, i, 0, p["params"]) for p in plans for i in range(len(p["chunks"]))], out, ref_path, ref_text, order, len(plans))
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001  one candidate failing (e.g. no model yet) shouldn't sink the others
            job["warnings"].append(f"{cand['label']}: {type(e).__name__}: {str(e)[:160]}")
            board.append({"label": cand["label"], "engine": cand["engine"], "voice": cand["voice"], "error": str(e)[:200]})
            continue
        gen_s = time.time() - t0
        for p in plans:
            _assemble(job, jdir, p, [out(p, i, 0) for i in range(len(p["chunks"]))])
        mine = job["results"][first:]
        job["stage"] = "choosing"
        stats = _listen(job, [os.path.join(jdir, f"{r['id']}.wav") for r in mine], target)
        audio_s = sum(r["duration"] for r in mine)
        rows = []
        for r, st in zip(mine, stats):
            t = quality.score_text(r["text"], st["heard"], r.get("spoken"))
            r.update({"match": t["score"], "similarity": st["sim"], "mos": st["mos"], "heard": st["heard"], "candidate": cand["label"]})
            if t["missed"] or t["added"]:
                r["diff"] = {"missed": t["missed"], "added": t["added"]}
            rows.append(quality.take_score(t["score"], st["sim"], None, st["mos"], None, None, st["clip"]))
        avg = lambda xs: round(sum(xs) / len(xs), 3) if xs else None  # noqa: E731
        board.append({"label": cand["label"], "engine": cand["engine"], "voice": cand["voice"],
                      "match": avg([r["match"] for r in mine if r["match"] is not None]),
                      "similarity": avg([r["similarity"] for r in mine if r["similarity"] is not None]),
                      "mos": avg([r["mos"] for r in mine if r["mos"] is not None]),
                      "rtf": round(gen_s / max(audio_s, 0.1), 3), "score": avg(rows), "lines": [r["id"] for r in mine]})
    job.update(keep)
    ranked = sorted([b for b in board if "error" not in b], key=lambda b: -(b["score"] or 0)) + [b for b in board if "error" in b]
    job["benchmark"] = {"target": job.get("target_voice") or None, "candidates": ranked}


def make_voicewalk_job(body):
    """Find your voice inside Kokoro (voicewalk.py). name: the new voice's owner (it becomes kv_<name>); voice: the
    recorded voice to match (a my_voices name) with ref = its signed link; rounds: how long to search (10-80)."""
    name = str(body.get("name") or "")
    if not ID_RE.match(name):
        raise ValueError("name: who the Kokoro voice is for (letters, digits, - and _)")
    target = str(body.get("voice") or "")
    if not ID_RE.match(target):
        raise ValueError("voice: the recording of you to match (a name from my_voices)")
    job = _base_job("voicewalk", body)
    rounds = max(10, min(80, int(body.get("rounds") or 24)))
    job.update({"voice": name, "engine": "kokoro", "target": target, "ref": body.get("ref") if isinstance(body.get("ref"), dict) else None,
                "rounds": rounds, "lines": [], "post": {**C.POST_DEFAULTS, "master": "youtube"}})
    job["est_total"] = 60 + 28 * 2 * RATES["kokoro"] * 90 + rounds * (6 * 2 * RATES["kokoro"] * 90 + 5) + 30
    return _enqueue(job)


def run_voicewalk(job):
    import numpy as np
    jdir = os.path.join(JOBS_DIR, job["id"])
    tmp = os.path.join(jdir, "walk")
    os.makedirs(tmp, exist_ok=True)
    job["stage"] = "reference"
    ref_path, _ = get_ref(job["target"], job.get("ref"))
    _prepare(job, "kokoro")
    bank = np.load(os.path.join(cache_dir("kokoro"), "voices-v1.0.bin"))
    names = [n for n in voicewalk.english_voices(C.ENGINES["kokoro"]["voices"]) if n in bank.files]
    if not names:
        raise RuntimeError("Kokoro's voice file has no English voices")
    stack = np.stack([bank[n].astype("float32") for n in names])
    seq = [0]

    def voice(vectors, lines, label):
        """Voice every line with every vector; returns [[path per line] per vector]."""
        items, out = [], []
        for v in vectors:
            seq[0] += 1
            npy = os.path.join(tmp, f"v{seq[0]}.npy")
            np.save(npy, v)
            row = []
            for k, text in enumerate(lines):
                p = os.path.join(tmp, f"v{seq[0]}_{k}.wav")
                items.append({"text": text, "voice": "kv", "params": {"speed": 1.0}, "ref_path": npy, "out_path": p})
                row.append(p)
            out.append(row)
        _prepare(job, "kokoro")
        job["stage"] = "generating"
        res = _run_unit(job, RATES["kokoro"] * sum(len(i["text"]) for i in items) + 1, lambda: ENG.synth_batch("kokoro", items), label)
        errs = [r["error"] for r in res if "error" in r]
        if errs:
            raise RuntimeError(errs[0])
        return out

    def closeness(weights, label):
        vectors = [voicewalk.mix(stack, w) for w in weights]
        rows = voice(vectors, voicewalk.SEARCH_LINES, label)
        flat = [p for r in rows for p in r]
        _prepare(job, "whisper")
        job["stage"] = "choosing"
        sims = _run_unit(job, 0.3 * len(flat) + 2, lambda: ENG.similarity(ref_path, flat), "comparing with your recording")
        n = len(voicewalk.SEARCH_LINES)
        for p in flat:
            os.remove(p)
        return [float(np.mean(sims[i * n:(i + 1) * n])) for i in range(len(vectors))]

    # 1. every built-in English voice, auditioned
    one = np.eye(len(names))
    base = closeness(list(one), f"auditioning {len(names)} Kokoro voices against you")
    closest = sorted(zip(names, base), key=lambda x: -x[1])[:5]
    start, picked = voicewalk.blend(base)
    start_s = closeness([start], "trying a blend of the closest voices")[0]
    if start_s < closest[0][1]:  # the blend can land between voices: start from the single closest then
        start, start_s = one[picked[0]], closest[0][1]

    # 2. the walk, over how much of each voice is in the mix
    def progress(r, total, best):
        job["walk"] = {"round": r, "rounds": total, "similarity": round(best, 3)}
    best, best_s, history = voicewalk.walk(start, start_s, lambda ws: closeness(ws, "searching for your voice"),
                                           rounds=job["rounds"], per_round=6, progress=progress)

    # 3. the words still land? Check on a sentence the search never heard; step back to a clearer state if not.
    chosen, chosen_w, match = voicewalk.mix(stack, best), best, None
    for w, sc in list(reversed(history))[:4]:
        v = voicewalk.mix(stack, w)
        p = voice([v], [voicewalk.CHECK_LINE], "checking it still speaks clearly")[0][0]
        _prepare(job, "whisper")
        heard = ENG.transcribe([p], "en")[0]["text"]
        m = quality.score_text(voicewalk.CHECK_LINE, heard)["score"] or 0.0
        if match is None or m > match[0]:
            chosen, chosen_w, match = v, w, (m, sc, p)
        if m >= 0.93:
            break
    m, sc, sample_raw = match
    weights = sorted(((names[i], round(float(x), 3)) for i, x in enumerate(chosen_w) if abs(x) >= 0.02), key=lambda t: -abs(t[1]))
    np.save(os.path.join(jdir, "voice.npy"), chosen)
    dur = postprocess(sample_raw, os.path.join(jdir, "sample.wav"), job["post"])
    keep = os.path.join(HOME, "kokoro", "voices", f"{job['id']}.npy")
    os.makedirs(os.path.dirname(keep), exist_ok=True)
    shutil.copy(os.path.join(jdir, "voice.npy"), keep)
    shutil.rmtree(tmp, ignore_errors=True)
    job["kvoice"] = {"name": f"kv_{job['voice']}", "target": job["target"], "similarity": round(sc, 3), "match": round(m, 3),
                     "start": round(start_s, 3), "closest": [{"voice": n, "similarity": round(x, 3)} for n, x in closest],
                     "rounds": job["rounds"], "steps_kept": len(history) - 1, "mix": [{"voice": n, "weight": x} for n, x in weights],
                     "sample": {"text": voicewalk.CHECK_LINE, "duration": round(dur, 2)}}
    job["results"].append({"id": "sample", "text": voicewalk.CHECK_LINE, "duration": round(dur, 2), "similarity": round(sc, 3), "match": round(m, 3)})
    log(f"job {job['id']} kokoro voice for {job['voice']}: {job['kvoice']}")


TRAIN_STEP_S = 10.0  # prior for one optimizer step on a T4, replaced by the measured speed once training runs


def make_train_job(body):
    """Fine-tune Orpheus on your dataset (train.py). parts: [{url}] (the dataset zips, signed by the dashboard)."""
    parts = [{"url": _http_url(p.get("url"), f"part {i + 1} url")} for i, p in enumerate(body.get("parts") or [])][:200]
    if not parts:
        raise ValueError("parts: the dataset has no recordings yet (Your model: collect first)")
    minutes = float(body.get("minutes") or 0)
    job = _base_job("train", body)
    ft = "qwen" if body.get("engine") == "qwen" else "orpheus"  # which model learns the voice
    job.update({"voice": str(body.get("name") or "me")[:64], "lines": [], "engine": "qwen" if ft == "qwen" else "myvoice", "parts": parts,
                "speaker": "me", "epochs": body.get("epochs"), "learning_rate": body.get("learning_rate"), "train_engine": ft})
    if ft == "qwen":
        if not ID_RE.match(job["voice"]):
            raise ValueError("name: letters, digits, - or _")
        # full fine-tune of 1.7B: ~2.5 s a step of 2 clips on an A100, one step per 2 clips per epoch, plus encode and test
        epochs = job["epochs"] or (6 if minutes < 10 else 4 if minutes < 30 else 3)
        job["est_total"] = 240 + minutes * 6 * 0.5 + minutes * 6 / 2 * epochs * 2.5 + 120
        return _enqueue(job)
    # T4 (fp16, no bf16): ~10 s per optimizer step of 4 clips; ~6 clips a minute of audio; 4 epochs under 40 min, else 3
    # (train.py keeps the best epoch); flow clips are about twice as long, so steps cost ~1.4x on average
    clips = max(30, minutes * 6)
    epochs = job["epochs"] or (10 if minutes < 5 else 6 if minutes < 15 else 4 if minutes < 40 else 3)  # as train.py
    job["est_total"] = 300 + clips * 0.4 + clips / 4 * epochs * TRAIN_STEP_S * 1.4 + 120 + (0 if os.path.exists(_train_python()) else C.TRAIN_INSTALL_S)
    return _enqueue(job)


def _train_python():
    tag = hashlib.sha1(C.TRAIN_PACKAGES.encode()).hexdigest()[:8]
    return os.environ.get("VOICEBOX_PY_TRAIN") or os.path.join(C.VENVS, f"train-{tag}", "bin", "python")


def run_train_qwen(job):
    """Fine-tune Qwen3-TTS on the dataset (train_qwen.py, in the qwen venv): the whole GPU, then the voice ft_<name> is
    ready on this worker (the dashboard keeps a copy in R2 for the next runtime)."""
    cap = subprocess.run(["nvidia-smi", "--query-gpu=name,compute_cap", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
    if cap and float(cap.split(",")[-1]) < 8:
        raise RuntimeError(f"Qwen3-TTS fine-tuning needs a bf16 GPU (A100, L4, A10 or newer); this one is a {cap.split(',')[0]}. "
                           "Train Orpheus instead, or switch the Colab runtime.")
    jdir = os.path.join(JOBS_DIR, job["id"])
    prog = os.path.join(jdir, "progress.json")
    job["progress_file"] = prog
    t0 = time.time()
    job["cur"] = {"t0": t0, "est": job["est_total"], "label": ""}
    for name in list(ENG.procs):
        log(f"stopping {name}: fine-tuning Qwen needs the whole GPU")
        ENG.stop(name)
    job["stage"] = "installing"
    py = ENG._install("qwen")
    marker = os.path.join(os.path.dirname(os.path.dirname(py)), ".ft-" + hashlib.sha1(C.QWENFT_PACKAGES.encode()).hexdigest()[:8])
    if not os.path.exists(marker):
        with open(os.path.join(LOGS_DIR, "train-install.log"), "a") as logf:
            subprocess.run(f"uv pip install --python {py} -q {C.QWENFT_PACKAGES}", shell=True, check=True, stdout=logf, stderr=logf)
        open(marker, "w").close()
    cfg = os.path.join(jdir, "train.json")
    json.dump({"parts": job["parts"], "name": job["voice"], "epochs": job.get("epochs"), "learning_rate": job.get("learning_rate"),
               "work": os.path.join(jdir, "work"), "out": jdir, "progress": prog}, open(cfg, "w"))
    job["stage"] = "training"
    env = {**os.environ, "HF_HOME": cache_dir("qwen"), "TOKENIZERS_PARALLELISM": "false", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
           "MPLBACKEND": "Agg", "PATH": os.path.dirname(py) + os.pathsep + os.environ.get("PATH", "")}
    with open(os.path.join(LOGS_DIR, "train.log"), "a") as logf:
        p = subprocess.Popen([py, os.path.join(HERE, "train_qwen.py"), cfg], stdout=logf, stderr=logf, env=env, cwd=HERE, start_new_session=True)
        while p.poll() is None:
            if job["cancel"]:
                import signal
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
                raise Cancelled()
            time.sleep(2)
    shutil.rmtree(os.path.join(jdir, "work"), ignore_errors=True)
    if p.returncode != 0:
        raise RuntimeError(f"fine-tuning stopped (exit {p.returncode}); the trainer's last lines are under the Train card")
    job["train"] = json.load(open(os.path.join(jdir, "result.json")))
    if job["train"].get("sample"):
        job["results"].append({"id": "sample", "text": job["train"]["sample"]["text"], "duration": job["train"]["sample"]["duration"]})
    mine = os.path.join(C.QWENFT_DIR, "models", job["id"])  # ready here at once; other runtimes download it (get_qwen_model)
    shutil.rmtree(mine, ignore_errors=True)
    os.makedirs(mine)
    zipfile.ZipFile(os.path.join(jdir, "qmodel.zip")).extractall(mine)
    job["cur"], job["est_done"] = None, time.time() - t0
    job["est_total"] = job["est_done"]
    log(f"job {job['id']} fine-tuned Qwen3-TTS as ft_{job['voice']}: {job['train']}")


def run_train(job):
    """The whole GPU for training: stop every engine, install the train venv once, run train.py, then install the
    adapter for the myvoice engine on this worker (the dashboard also keeps a copy in R2 for the next runtime)."""
    if job.get("train_engine") == "qwen":
        return run_train_qwen(job)
    jdir = os.path.join(JOBS_DIR, job["id"])
    prog = os.path.join(jdir, "progress.json")
    job["progress_file"] = prog
    t0 = time.time()
    job["cur"] = {"t0": t0, "est": job["est_total"], "label": ""}
    for name in list(ENG.procs):
        log(f"stopping {name}: training your voice needs the whole GPU")
        ENG.stop(name)
    py = _train_python()
    if not os.path.exists(py):
        job["stage"] = "installing"
        venv = os.path.dirname(os.path.dirname(py))
        with open(os.path.join(LOGS_DIR, "train-install.log"), "a") as logf:
            subprocess.run(["uv", "venv", "--python", "3.11", venv, "-q", "--allow-existing"], check=True, stdout=logf, stderr=logf)
            subprocess.run(f"uv pip install --python {py} -q {C.TRAIN_PACKAGES}", shell=True, check=True, stdout=logf, stderr=logf)
    cfg = os.path.join(jdir, "train.json")
    json.dump({"parts": job["parts"], "speaker": job["speaker"], "epochs": job.get("epochs"), "learning_rate": job.get("learning_rate"),
               "work": os.path.join(jdir, "work"), "out": jdir, "progress": prog,
               "cache": os.path.join(C.MYVOICE_DIR, "codes")}, open(cfg, "w"))
    job["stage"] = "training"
    env = {**os.environ, "HF_HOME": cache_dir("myvoice"), "TOKENIZERS_PARALLELISM": "false", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
           "MPLBACKEND": "Agg"}
    with open(os.path.join(LOGS_DIR, "train.log"), "a") as logf:
        p = subprocess.Popen([py, os.path.join(HERE, "train.py"), cfg], stdout=logf, stderr=logf, env=env, cwd=HERE, start_new_session=True)
        while p.poll() is None:
            if job["cancel"]:
                import signal
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
                raise Cancelled()
            time.sleep(2)
    shutil.rmtree(os.path.join(jdir, "work"), ignore_errors=True)
    if p.returncode != 0:
        raise RuntimeError(f"training stopped (exit {p.returncode}); see the train log on the Engines page")
    job["train"] = json.load(open(os.path.join(jdir, "result.json")))
    if job["train"].get("sample"):
        job["results"].append({"id": "sample", "text": job["train"]["sample"]["text"], "duration": job["train"]["sample"]["duration"]})
    # this person's model, under its train job (what the dashboard names it in later jobs, so no download here), and
    # the default for jobs that don't name one
    mine = os.path.join(C.MYVOICE_DIR, "models", job["id"])
    shutil.rmtree(mine, ignore_errors=True)
    shutil.copytree(os.path.join(jdir, "adapter"), mine)
    dst = os.path.join(C.MYVOICE_DIR, "adapter")
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(os.path.join(jdir, "adapter"), dst)
    shutil.rmtree(os.path.join(jdir, "adapter"), ignore_errors=True)
    ENG.errors.pop("myvoice", None)
    job["cur"], job["est_done"] = None, time.time() - t0
    job["est_total"] = job["est_done"]
    log(f"job {job['id']} trained your voice: {job['train']}")


def package(job):
    job["stage"] = "packaging"
    if job["kind"] in ("video", "reference", "image", "dataset", "train", "voicewalk"):
        return  # single files, served directly; no zip copy of a large video (a dataset packs its own zip)
    jdir = os.path.join(JOBS_DIR, job["id"])
    with zipfile.ZipFile(os.path.join(JOBS_DIR, f"{job['id']}.zip"), "w") as z:
        for f in sorted(os.listdir(jdir)):
            if f.endswith((".wav", ".srt", ".vtt")) or (f.endswith(".json") and ".subs" in f) or f == "subtitles.json":
                z.write(os.path.join(jdir, f), f)
        z.writestr("manifest.json", json.dumps(job_view(job, urls=False), indent=2))


PUSH_TYPES = {".wav": "audio/wav", ".srt": "application/x-subrip", ".vtt": "text/vtt", ".json": "application/json",
              ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png", ".zip": "application/zip",
              ".npy": "application/octet-stream"}


PUSHING, PUSHING_LOCK = set(), threading.Lock()  # (job, file) uploads in flight


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
        key = (job_id, os.path.basename(name))
        with PUSHING_LOCK:  # a big file (a 3.5 GB Qwen voice) outlasts the request that asked for it, and the next poll
            if key in PUSHING:  # asks again: one upload per file, the rest hear "in progress"
                return name, "in progress"
            PUSHING.add(key)
        ext = os.path.splitext(path)[1]
        ctype = PUSH_TYPES.get(ext, "application/octet-stream")
        hdrs = {**{k: str(v) for k, v in headers.items() if k.lower().startswith("x-")}, "Content-Type": ctype,
                "Content-Length": str(os.path.getsize(path))}
        try:
            for attempt in range(3):
                try:
                    with open(path, "rb") as f:  # streamed from disk, never read into memory whole
                        req = urllib.request.Request(url, data=f, method="PUT", headers=hdrs)
                        with urllib.request.urlopen(req, timeout=1800) as r:
                            if r.status < 300:
                                return name, None
                except Exception as e:  # noqa: BLE001
                    err = f"{type(e).__name__}: {e}"
                    time.sleep(1 + attempt)
            return name, err
        finally:
            with PUSHING_LOCK:
                PUSHING.discard(key)

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
            {"transcribe": run_transcribe, "video": run_video, "reference": run_reference,
             "image": run_image, "dataset": run_dataset, "train": run_train, "voicewalk": run_voicewalk}.get(job["kind"], run_tts)(job)
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
        detail = f"{name}: installing packages" if st == "installing" else f"loading {name} into memory"
        f = ENG.fetch.get(name)
        if f and f["phase"] == "downloading":
            detail = f"downloading {name}: {f['gb']:.1f} of {f['total_gb']:.0f} GB" + (f" · {f['mbps']} MB/s" if f["mbps"] else "")
            left = (f["eta_s"] or left) + 30
        elif f and f["phase"] == "loading" and st == "loading":
            left = max(5, min(left, 120))
        extra = left
    if job["kind"] == "train" and job["status"] == "running":
        el = now - job["cur"]["t0"] if job.get("cur") else 0
        if stage == "installing":
            return min(0.05, 0.05 * el / C.TRAIN_INSTALL_S), round(max(30, job["est_total"] - el)), "installing", "installing the training tools (first time only)"
        try:
            pf = json.load(open(job["progress_file"]))
        except Exception:
            pf = {"phase": "starting", "step": 0, "total": 0}
        ph, step, tot = pf.get("phase"), pf.get("step", 0), max(1, pf.get("total") or 1)
        if ph == "training":
            t_ref, s_ref = job.setdefault("train_ref", (now, step))  # measure the real step speed from the first sighting
            per = (now - t_ref) / (step - s_ref) if step - s_ref >= 3 else TRAIN_STEP_S  # prior until a few steps are in
            return 0.25 + 0.63 * step / tot, round(per * (tot - step) + 120), "training", pf.get("detail") or ""
        frac = {"starting": 0.05, "downloading": 0.06 + 0.04 * step / tot, "encoding": 0.10 + 0.10 * step / tot, "loading": 0.22,
                "listening": 0.90 + 0.02 * step / tot, "saving": 0.93, "testing": 0.95, "done": 0.99}.get(ph, 0.05)
        return frac, round(max(20, job["est_total"] - el)), ph if ph != "starting" else "preparing", pf.get("detail") or ""
    if job["kind"] in ("video", "image") and stage == "rendering" and job.get("progress_file"):
        try:
            pf = json.load(open(job["progress_file"]))
        except Exception:
            pf = {"phase": "encoding prompt", "step": 0, "total": job["gen"]["steps"], "t": 0}
        el = now - job["cur"]["t0"] if job.get("cur") else 0
        step, steps = pf.get("step", 0), max(1, pf.get("total", 1))
        if pf["phase"] == "denoising" and step:
            per = el / (step + 0.5)  # elapsed includes the prompt encode (~half a step)
            eta = per * (steps - step) + (30 if job["kind"] == "video" else 3)
            frac = 0.05 + 0.85 * step / steps
            return min(0.97, frac), round(eta), "rendering", f"step {step} of {steps}"
        if pf["phase"] == "decoding":
            what = f"decoding {job['gen']['frames']} frames" if job["gen"].get("frames") else "decoding"
            return 0.92, round(max(10 if job["kind"] == "video" else 2, (120 if job["kind"] == "video" else 10) - (el - pf.get("t", el)))), "decoding", what
        if pf["phase"] == "encoding video":
            if job["kind"] == "image":
                return 0.97, 2, "encoding", "saving images"
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
        detail = (cur or {}).get("label") or "Whisper large-v3, word timestamps"
    elif stage == "transcribing":
        detail = "Whisper is writing down what you said" if job["kind"] == "reference" else (cur or {}).get("label") or f"file {min(len(job['results']) + 1, len(job['lines']))} of {len(job['lines'])}"
    elif stage == "cleaning":
        detail = (cur or {}).get("label") or "removing rumble and hiss, levelling"
    elif stage == "cutting":
        detail = "cutting clean clips at sentence ends, checking and levelling each one"
    elif stage in ("visuals", "assembling"):
        detail = (cur or {}).get("label") or ""
    elif stage == "enhancing":
        detail = (cur or {}).get("label") or "studio clean-up"
    elif stage == "choosing":
        detail = (cur or {}).get("label") or "listening back to every sentence"
    if job["kind"] == "voicewalk" and job.get("walk") and stage in ("generating", "choosing"):
        w = job["walk"]
        detail = f"round {w['round']} of {w['rounds']} · {round(w['similarity'] * 100)}% like you"
    elif stage == "fixing":
        detail = (cur or {}).get("label") or "re-voicing the sentences that missed"
    elif stage == "denoising":
        detail = (cur or {}).get("label") or "removing background noise"
    elif stage == "checking":
        detail = (cur or {}).get("label") or "checking it still sounds like you"
    return frac, round(eta), stage, detail


def job_view(job, urls=True):
    v = {k: job.get(k) for k in ("id", "kind", "engine", "voice", "style", "status", "error", "label", "language", "warnings", "subs", "match", "attach_to", "video", "version",
                                 "platform", "captions", "takes", "mode", "similarity", "scenes", "review", "trials", "profile", "cleanup",
                                 "dataset", "benchmark", "train", "kvoice", "walk", "auto_train", "train_engine")}
    if job["kind"] in ("video", "image"):
        v["gen"] = job["gen"]
    if job["kind"] == "tts":
        v["params"] = C.resolve_params(job["engine"], job["params"])
        v["post"] = job["post"]
        v["subtitles"] = job.get("subtitles")
    frac, eta, stage, detail = _progress(job)
    v["progress"] = {"done": len(job["results"]), "total": len(job["lines"]), "fraction": round(frac, 4),
                     "eta_s": eta, "stage": stage, "detail": detail,
                     "fetch": ENG.fetch.get(job["stage"].split(":", 1)[1]) if job["stage"].startswith("preparing:") else None,
                     "elapsed_s": round((job.get("finished") or time.time()) - job.get("started", time.time()), 1)
                     if job.get("started") else 0}
    if job["status"] == "queued":
        v["queue_position"] = QUEUE.index(job["id"]) + 1 if job["id"] in QUEUE else 0
    res = []
    for r in job["results"]:
        r = {k: val for k, val in r.items() if k != "words"} if urls else dict(r)
        if urls:
            if job["kind"] in ("tts", "reference", "train", "voicewalk"):
                r["url"] = sign(f"/files/{job['id']}/{r['id']}.wav")
            if job["kind"] == "video" and job["status"] == "done":
                r["url"] = sign(f"/files/{job['id']}/video.mp4")
                r["poster_url"] = sign(f"/files/{job['id']}/poster.jpg")
            if job["kind"] == "image" and r.get("file"):
                r["url"] = sign(f"/files/{job['id']}/{r['file']}")
                r["thumb_url"] = sign(f"/files/{job['id']}/{r['thumb']}")
            if r.get("subs"):
                r["srt_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.srt")
                r["vtt_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.vtt")
                r["json_url"] = sign(f"/files/{job['id']}/{r['id']}.subs.json")
        res.append(r)
    v["results"] = res
    if urls and job["status"] == "done" and job["kind"] not in ("video", "reference", "dataset", "train", "voicewalk"):
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
                                          "image_only", "adult", "min_gpu_gb", "license", "commercial", "max_count", "edit",
                                          "max_refs", "transparent") if k in spec}
        out[name]["state"] = ENG.state[name]
        out[name]["downloaded"] = os.path.isdir(cache_dir(name)) and dir_gb(cache_dir(name)) > 0.05
        unit = {"tts": "seconds_per_char", "asr": "seconds_per_audio_second", "video": "seconds_per_step_frame_megapixel",
                "image": "seconds_per_step_megapixel_image", "animate": "seconds_per_step_frame_megapixel",
                "enhance": "seconds_per_audio_second"}[spec["kind"]]
        out[name][unit] = RATES.get(name)
    refs = sorted(f[:-4] for f in os.listdir(REFS_DIR) if f.endswith(".wav"))
    return {"engines": out, "references": refs, "preset_references": list(C.PRESET_REFS),
            "post_defaults": C.POST_DEFAULTS, "subtitle_style": C.SUBTITLE_STYLE, "caption_styles": C.CAPTION_STYLES,
            "platforms": C.PLATFORMS, "default_platform": C.DEFAULT_PLATFORM, "max_takes": C.MAX_TAKES,
            "styles": C.STYLES, "default_style": C.DEFAULT_STYLE, "groups": C.GROUPS, "idle_min": C.IDLE_MIN}


def health():
    return {"ok": True, "version": C.VERSION, "uptime_s": int(time.time() - STARTED), "gpu": gpu_info(),
            "ram": mem_info(), "disk": disk_info(), "mode": ENG.mode, "idle_unload_s": ENG.idle_left(), "idle_min": C.IDLE_MIN, "fetch": ENG.fetch,
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
        if m and (m.group(1) in C.ENGINES or m.group(1) in ("gateway", "tunnel", "train")):
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
            if u.path == "/speakable":  # dry run of the pronunciation layer: what the voice will actually read
                pron, tech = _pronounce(body.get("pronounce")), body.get("lexicon", True) is not False
                return self._json(200, {"lines": [{"text": str(t)[:MAX_TEXT], "parts": [
                    {"spoken": speakable(seg, pron, tech=tech and not is_devanagari(seg)), "pause_after": gap}
                    for seg, gap in segments(str(t)[:MAX_TEXT])]} for t in (body.get("lines") or [])[:200]]})
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
        m = re.match(r"^/files/([a-f0-9]{12})(?:/([A-Za-z0-9_\-]{1,64}(?:\.subs)?\.(?:wav|srt|vtt|json)|video\.mp4|poster\.jpg|source\.jpg|image-\d{1,2}\.png|thumb-\d{1,2}\.jpg)|\.zip)$", u.path)
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
