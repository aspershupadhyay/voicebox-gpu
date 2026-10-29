"""voicebox gateway: the worker's public HTTP API.

Starts engines on demand (each in its own venv, see engine_host.py), queues jobs so the GPU does one
thing at a time, post-processes audio for video timelines, and serves results through signed URLs.

  python gateway.py --port 8000          (WORKER_SECRET must be set)

Auth: every endpoint needs `Authorization: Bearer $WORKER_SECRET`, except /files/* which needs a
valid ?exp=&sig= signature (so download links can be handed to tools that can't set headers).
"""
import argparse, base64, hashlib, hmac, json, os, re, shutil, subprocess, sys, threading, time, traceback, uuid
import urllib.error, urllib.parse, urllib.request, zipfile
from collections import OrderedDict, defaultdict
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
import r2cache  # noqa: E402

SECRET = os.environ.get("WORKER_SECRET", "")
FETCH_ONLY = os.environ.get("VOICEBOX_MODE") == "fetch"  # a CPU runtime started for downloads: only fetch jobs
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
# Engines that run on another's weights share its folder: myvoice is Orpheus plus small LoRA adapters, and kept its own
# 6.7 GB copy of the same base model (downloaded twice on every fresh runtime, part of its 311 s first load).
CACHE_ALIAS = {"myvoice": "orpheus"}


def cache_dir(name):
    """Every engine downloads its weights into its own folder, so one engine's weights can be dropped alone (an
    engine in CACHE_ALIAS shares the folder of the one whose weights it runs on)."""
    return os.path.join(CACHE_DIR, CACHE_ALIAS.get(name, name))


if os.environ.get("ORPHEUS_MODEL", "unsloth/orpheus-3b-0.1-ft") == "unsloth/orpheus-3b-0.1-ft" and not os.environ.get("MY_VOICE_MODEL"):
    # the copy myvoice kept before it shared Orpheus's folder: the same files, 6.7 GB
    shutil.rmtree(os.path.join(CACHE_DIR, "myvoice"), ignore_errors=True)
else:
    CACHE_ALIAS.clear()  # a different base model (MY_VOICE_MODEL, ORPHEUS_MODEL): keep them apart


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
            "weights_gb": {n: dir_gb(cache_dir(n)) for n in C.ENGINES if n not in CACHE_ALIAS and os.path.isdir(cache_dir(n))}}


USAGE_PATH = os.path.join(HOME, "usage.json")
try:
    USAGE = json.load(open(USAGE_PATH))
except Exception:
    USAGE = {}


USAGE_LOCK = threading.Lock()


def mark_used(name):
    """Every engine call writes this from its own thread: one writer at a time, and atomically, so a crash or two
    threads at once never leave a half-written file that loses every engine's last-used time on the next start."""
    with USAGE_LOCK:
        USAGE[name] = time.time()
        try:
            with open(USAGE_PATH + ".part", "w") as f:
                json.dump(USAGE, f)
            os.replace(USAGE_PATH + ".part", USAGE_PATH)
        except OSError:
            pass



def _meminfo():
    """/proc/meminfo in GB: total, available, and the page cache (files the kernel keeps in RAM, e.g. model weights)."""
    try:
        m = {l.split(":")[0]: int(l.split()[1]) / 2**20 for l in open("/proc/meminfo")}
        return {"total": m["MemTotal"], "avail": m["MemAvailable"], "cache": m.get("Cached", 0.0) + m.get("Buffers", 0.0)}
    except Exception:
        return None


# --------------------------------------------------------------------------------------- monitor
class Monitor:
    """What the machine is doing, every few seconds: CPU busy %, RAM (and the page cache holding model weights), GPU
    busy %, GPU memory, power. Keeps the last 10 minutes for the Health page's charts, and folds each running job's
    share into job["_res"] (job_view "resources"), so the dashboard can tell which jobs need a big GPU and which
    leave it idle."""

    def __init__(self, every=5, keep=120):
        from collections import deque
        self.every, self.samples, self.cores = every, deque(maxlen=keep), os.cpu_count() or 1
        self._cpu = self._stat()
        threading.Thread(target=self._loop, daemon=True).start()

    @staticmethod
    def _stat():
        try:
            v = [int(x) for x in open("/proc/stat").readline().split()[1:]]
            return sum(v), v[3] + (v[4] if len(v) > 4 else 0)  # all jiffies, idle + iowait
        except Exception:
            return None

    @staticmethod
    def _gpu():
        try:
            out = subprocess.check_output(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,power.draw,temperature.gpu",
                                           "--format=csv,noheader,nounits"], text=True, timeout=5).strip().splitlines()[0]
            num = [float(x) if re.match(r"^[\d.]+$", x.strip()) else None for x in out.split(",")]
            return {"gpu": num[0], "vram_gb": round(num[1] / 1024, 1) if num[1] is not None else None, "power_w": num[2], "temp_c": num[3]}
        except Exception:
            return {}

    def sample(self):
        now, cpu = self._stat(), None
        if now and self._cpu and now[0] > self._cpu[0]:
            cpu = round(100 * (1 - (now[1] - self._cpu[1]) / (now[0] - self._cpu[0])), 1)
        self._cpu = now
        m = _meminfo() or {"total": 0, "avail": 0, "cache": 0}
        return {"t": round(time.time()), "cpu": cpu, "ram_gb": round(m["total"] - m["avail"], 1), "cache_gb": round(m["cache"], 1), **self._gpu()}

    def _loop(self):
        while True:
            time.sleep(self.every)
            try:
                s = self.sample()
            except Exception:  # noqa: BLE001  a missed sample is nothing
                continue
            self.samples.append(s)
            for j in [j for j in list(JOBS.values()) if j["status"] == "running"]:
                r = j.setdefault("_res", {"n": 0, "gpu": 0.0, "cpu": 0.0, "vram_peak_gb": 0.0, "ram_peak_gb": 0.0, "power": 0.0})
                r["n"] += 1
                r["gpu"] += s.get("gpu") or 0
                r["cpu"] += s.get("cpu") or 0
                r["power"] += s.get("power_w") or 0
                r["vram_peak_gb"] = max(r["vram_peak_gb"], s.get("vram_gb") or 0)
                r["ram_peak_gb"] = max(r["ram_peak_gb"], s["ram_gb"])

    def latest(self):
        return self.samples[-1] if self.samples else self.sample()


def job_resources(job):
    """A job's average GPU / CPU use and its peaks, from the monitor's samples while it ran (None until sampled)."""
    r = job.get("_res")
    if not r or not r["n"]:
        return None
    return {"gpu_util": round(r["gpu"] / r["n"]), "cpu_util": round(r["cpu"] / r["n"]), "power_w": round(r["power"] / r["n"]),
            "vram_peak_gb": r["vram_peak_gb"], "ram_peak_gb": r["ram_peak_gb"], "gpu_name": gpu_info_cached()["name"], "lane": job.get("lane", "gpu")}


_GPU_INFO = []


def gpu_info_cached():
    if not _GPU_INFO:
        _GPU_INFO.append(gpu_info())
    return _GPU_INFO[0]


# --------------------------------------------------------------------------------------- warm weights
class Warmer:
    """Keeps model weights in RAM so starting an engine reads them from memory, not the disk: the engines you use most
    (weights + their Python packages) are read into the kernel's page cache while nothing is loading. The page cache
    belongs to the VM, not to this process, so it outlives worker restarts and updates, and the kernel hands it back
    the moment a program needs the memory: it never takes RAM from a job. Budget: VOICEBOX_WARM_GB, else 55% of RAM
    less what programs already use (a 167 GB machine holds every engine; a 12 GB one warms nothing)."""

    def __init__(self):
        self.state, self.files, self.last = {}, {}, 0.0   # engine -> {gb, warm, secs}; path -> (size, mtime) read
        threading.Thread(target=self._loop, daemon=True).start()

    @staticmethod
    def budget_gb():
        if os.environ.get("VOICEBOX_WARM_GB"):
            return float(os.environ["VOICEBOX_WARM_GB"])
        m = _meminfo()
        if not m:
            return 0.0
        b = 0.55 * m["total"] - (m["total"] - m["avail"])
        return round(b, 1) if b >= 4 else 0.0

    @staticmethod
    def dirs(name):
        out = [cache_dir(name)]
        venv = os.path.dirname(os.path.dirname(C.python_for(name)))
        if os.path.isdir(venv):
            out.append(venv)
        return [d for d in out if os.path.isdir(d)]

    def plan(self):
        """The engines to keep warm: most recently used first, while they fit the budget."""
        budget, used, out = self.budget_gb(), 0.0, []
        for n in sorted((n for n in C.ENGINES if USAGE.get(n)), key=lambda n: -USAGE[n]):
            gb = sum(dir_gb(d) for d in self.dirs(n))
            if gb and used + gb <= budget:
                out.append((n, gb))
                used += gb
        return out

    def _quiet(self):
        return not any(ENG.state[n] in ("installing", "loading") for n in C.ENGINES)

    def _read(self, path, buf):
        st = os.stat(path)
        if self.files.get(path) == (st.st_size, st.st_mtime) and time.time() - self.last < 3600:
            return 0
        with open(path, "rb", buffering=0) as f:
            while f.readinto(buf):
                pass
        self.files[path] = (st.st_size, st.st_mtime)
        return st.st_size

    def warm(self):
        buf = bytearray(16 << 20)
        for name, gb in self.plan():
            t0, done = time.time(), 0
            self.state[name] = {"gb": round(gb, 1), "warm": False, "secs": None}
            for d in self.dirs(name):
                for root, _, fs in os.walk(d):
                    for f in fs:
                        while not self._quiet():  # never compete with an engine that is loading
                            time.sleep(5)
                        try:
                            done += self._read(os.path.join(root, f), buf)
                        except OSError:
                            pass
            self.state[name] = {"gb": round(gb, 1), "warm": True, "secs": round(time.time() - t0, 1), "read_gb": round(done / 1e9, 1)}
        self.last = time.time()

    def _loop(self):
        time.sleep(15)
        while True:
            try:
                if self.budget_gb() > 0:
                    self.warm()
            except Exception as e:  # noqa: BLE001
                log(f"warm weights: {type(e).__name__}: {e}")
            time.sleep(600)  # pick up new downloads; re-read anything the kernel let go of

    def view(self):
        return {"budget_gb": self.budget_gb(), "engines": self.state}


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
        self.inflight = {n: 0 for n in C.ENGINES}  # calls in progress per engine (an engine with one is never moved off)
        self.inflight_lock = threading.Lock()  # += from many threads isn't atomic; a count stuck above 0 blocked switching
        self.batch = {}
        self.errors = {}
        self.fetch = {}   # name -> live download / load progress while installing or loading
        self.install_lock = defaultdict(threading.Lock)  # one venv install per engine at a time
        self.loads = {}   # name -> the last start: seconds from launch to ready, and whether its weights were in RAM
        self.parked = {}  # name -> when it was parked in RAM (its process lives on, off the GPU)
        self.lock = threading.RLock()
        self.budget = float(os.environ.get("VOICEBOX_VRAM_GB") or gpu_info()["total_gb"] or 0) - 1.5
        # size the vLLM engines to the card: a bigger KV cache generates more sentences at once
        pool = float(os.environ.get("ORPHEUS_VRAM_GB") or C.vllm_pool_gb(self.budget + 1.5))
        os.environ["ORPHEUS_VRAM_GB"] = f"{pool:g}"
        os.environ.setdefault("ORPHEUS_MAX_SEQS", str(C.vllm_max_seqs(pool)))
        for n in ("orpheus", "myvoice"):
            C.ENGINES[n]["gpu_gb"] = pool + 2.5  # + SNAC decoder + CUDA context
        self.resident = C.resident_engines(self.budget + 1.5)  # step 4: the review's models stay loaded
        self.preloading = set()
        self.compile_sig = {}  # compile-cache folder -> (files, bytes) as last pulled or pushed (step 7)
        threading.Thread(target=self._reaper, daemon=True).start()

    def _set(self, name, state):
        self.state[name] = state
        self.since[name] = time.time()

    @property
    def mode(self):
        live = [n for n in self.procs if n not in self.parked]
        groups = {C.ENGINES[n]["group"] for n in live if C.ENGINES[n]["gpu_gb"]} or {C.ENGINES[n]["group"] for n in live}
        return groups.pop() if len(groups) == 1 else ("mixed" if groups else "idle")

    def idle_left(self):
        """Seconds until each loaded, unused engine is unloaded."""
        out = {}
        for n in list(self.procs):
            if self.state[n] == "ready" and not self.inflight[n]:
                out[n] = max(0, round(C.IDLE_MIN * 60 - (time.time() - max(self.last[n], self.since[n]))))
        return out

    def _reaper(self):
        ticks = 0
        while True:
            time.sleep(20)
            ticks += 1
            try:
                self._reap(ticks)
            except Exception as e:  # noqa: BLE001  one bad pass must never end idle unloads and pruning for good
                log(f"reaper: {type(e).__name__}: {e}")

    def _reap(self, ticks):
        if ticks % 30 == 0:  # every 10 min: finished jobs' files off the disk
            try:
                prune_jobs()
            except Exception as e:  # noqa: BLE001
                log(f"pruning old jobs: {type(e).__name__}: {e}")
        busy = any(j["status"] == "running" for j in list(JOBS.values()))
        for n, left in self.idle_left().items():
            if left <= 0 and not busy and n not in self.parked and n not in self.resident:
                if C.IDLE_PARK:  # a high-RAM machine: off the GPU but kept in RAM, back in about a second
                    with self.lock:
                        if self.running(n) and not self.inflight[n]:
                            self._park_or_stop(n, f"idle for {C.IDLE_MIN:g} min")
                else:
                    log(f"unloading {n}: idle for {C.IDLE_MIN:g} min")
                    self.stop(n)
        for n, at in list(self.parked.items()):  # parked models give their RAM back after a while, or when RAM runs low
            m = _meminfo()
            late = C.PARK_MIN > 0 and time.time() - at > C.PARK_MIN * 60
            if late or (m and m["avail"] < C.RAM_RESERVE_GB / 2):
                log(f"stopping parked {n}: " + (f"parked {C.PARK_MIN:g} min" if late else "RAM is low"))
                self.stop(n)

    def _can_park(self, name):
        """Room in RAM for this engine's weights (and its process) with the reserve still free."""
        if name in C.NO_PARK or not C.ENGINES[name]["gpu_gb"] or not self.running(name):
            return False
        m = _meminfo()
        return bool(m) and m["avail"] - (float(C.ENGINES[name].get("disk_gb") or 4) + 2) >= C.RAM_RESERVE_GB

    def _park_or_stop(self, name, why):
        """Free the GPU for another engine: park this one in RAM when there's room (it wakes in seconds), else stop it."""
        if self._can_park(name):
            try:
                t = time.time()
                self._call(name, "/park", {}, timeout=300)
                self.parked[name] = time.time()
                self._set(name, "parked")
                log(f"parked {name} in RAM in {time.time() - t:.1f} s: {why}")
                return
            except Exception as e:  # noqa: BLE001  e.g. vLLM without sleep mode
                log(f"couldn't park {name} ({type(e).__name__}: {e}); stopping it instead")
        log(f"stopping {name}: {why}")
        self.stop(name)

    def park_for_post(self, name):
        """A voiceover's generation is done and the review, studio polish and subtitles come next: park the voice
        engine in RAM (it wakes in about a second) so Whisper and the enhancer get its GPU memory and batch wider."""
        with self.lock:
            if self.running(name) and not self.inflight[name] and name not in self.resident and self._can_park(name):
                self._park_or_stop(name, "its voiceover is generated; the review, polish and subtitles get the GPU")

    def _wake(self, name):
        t = time.time()
        self._call(name, "/wake", {}, timeout=300)
        self.parked.pop(name, None)
        self._set(name, "ready")
        self.loads[name] = {"secs": round(time.time() - t, 1), "warm": True, "parked": True, "at": time.time()}
        log(f"woke {name} from RAM in {time.time() - t:.1f} s")

    def _call(self, name, path, payload, timeout):
        req = urllib.request.Request(f"http://127.0.0.1:{C.ENGINES[name]['port']}{path}", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read())
        if "error" in out:
            raise RuntimeError(out["error"])
        return out

    def _room_in_ram(self, name):
        """Before a new engine loads, stop parked models (oldest first) until its weights fit in RAM with the reserve."""
        need = float(C.ENGINES[name].get("disk_gb") or 4) * 1.2 + C.RAM_RESERVE_GB
        for victim in sorted(self.parked, key=self.parked.get):
            m = _meminfo()
            if not m or m["avail"] >= need:
                return
            log(f"stopping parked {victim}: {name} needs the RAM")
            self.stop(victim)

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
        with self.install_lock[name]:  # a step 6 prefetch may be installing this venv right now: wait for it
            return self._install_once(name)

    def _install_once(self, name):
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

    def prefetch(self, name):
        """Step 6: install name's venv and download its weights to disk (nothing on the GPU), so its first load is
        just a load. Skipped when it's already loaded or there's no disk to spare. It gives way to real work: while a job
        installs or downloads an engine, the prefetch waits (a download under way stops and resumes where it was)."""
        if name in self.procs or not C.ENGINES[name].get("prefetch"):
            return
        t = time.time()
        self._wait_for_quiet(name)
        py = self._install(name)
        if self.state.get(name) == "installing" and name not in self.procs:
            self._set(name, "idle")
        have = dir_gb(cache_dir(name), max_age=0) if os.path.isdir(cache_dir(name)) else 0.0
        if shutil.disk_usage(HOME).free / 1e9 < max(0.0, C.ENGINES[name].get("disk_gb", 0) - have) + C.DISK_RESERVE_GB:
            return log(f"not prefetching {name}: short of disk (a prefetch never deletes other weights)")
        repos = self._r2_weights(name)  # whatever R2 has, from R2 (step 7); the rest from Hugging Face
        if not repos:
            return log(f"prefetched {name} (venv + weights on disk) in {time.time() - t:.0f} s")
        env = {**os.environ, "HF_HOME": cache_dir(name), "HF_HUB_ENABLE_HF_TRANSFER": "0"}
        code = ("import sys; from huggingface_hub import snapshot_download\n"
                "for r in sys.argv[1:]: snapshot_download(r, ignore_patterns=['*.msgpack', '*.h5', '*.ot', '*.onnx', '*.gguf', 'original/*'])")
        with open(os.path.join(LOGS_DIR, f"{name}-prefetch.log"), "a") as logf:
            while True:
                self._wait_for_quiet(name)
                if name in self.procs:
                    return  # a job loaded it meanwhile: its own load fetched what was missing
                p = subprocess.Popen([py, "-c", code, *repos], stdout=logf, stderr=logf, env=env)
                while p.poll() is None and not self._others_fetching(name):
                    time.sleep(1)
                if p.poll() is None:  # a job needs the network and the disk now: stop, pick up again after it
                    p.terminate()
                    p.wait()
                    log(f"prefetch of {name} paused for a job's download")
                    continue
                if p.returncode:
                    raise RuntimeError(f"download failed (exit {p.returncode}); see {name}-prefetch.log")
                break
        log(f"prefetched {name} (venv + weights on disk) in {time.time() - t:.0f} s")
        self._r2_mirror(name, repos)

    def _r2_weights(self, name):
        """Step 7: fill name's weights folder from the R2 mirror. Returns the repos that didn't come from R2 just now
        (missing ones, and ones already on disk that Hugging Face's snapshot_download checks are complete)."""
        repos = list(C.ENGINES[name].get("prefetch") or [])
        if not (C.R2_WEIGHTS and r2cache.enabled()):
            return repos
        left = []
        for repo in repos:
            try:
                got = r2cache.pull_repo(cache_dir(name), repo, log)
            except Exception as e:  # noqa: BLE001  e.g. an older dashboard without /api/worker-cache
                log(f"R2 weights for {repo}: {type(e).__name__}: {e}")
                got = False
            if got != "r2":
                left.append(repo)
        _SIZES.pop(cache_dir(name), None)
        return left

    def _r2_mirror(self, name, repos):
        """Mirror repos this runtime downloaded from Hugging Face to R2, in the background, for the next runtime."""
        if not (C.R2_WEIGHTS and r2cache.enabled() and repos):
            return

        def go():
            for repo in repos:
                while self.fetch:  # never slow a load down: a fresh L4's preload took 202 s beside four uploads (62 s alone)
                    time.sleep(5)
                try:
                    r2cache.push_repo(cache_dir(name), repo, log)
                except Exception as e:  # noqa: BLE001
                    log(f"couldn't mirror {repo} to R2 ({type(e).__name__}: {e})")
        threading.Thread(target=go, daemon=True).start()

    def _compile_cache(self, name, py):
        """Step 7: vLLM engines keep their compiled kernels in a folder per GPU model and vLLM version, filled from R2
        on a fresh runtime. Returns (extra env, folder) or ({}, None) for engines that don't run vLLM."""
        if "vllm" not in C.ENGINES[name].get("packages", "").split():
            return {}, None
        version = r2cache.vllm_version(py)
        if not version:
            return {}, None
        gpu = gpu_info_cached()["name"]
        root = r2cache.compile_root(HOME, gpu, version)
        if C.R2_COMPILE and r2cache.enabled() and root not in self.compile_sig:
            self.compile_sig[root] = None
            if r2cache.tree_sig(root)[0]:  # compiled here already: upload after this load if R2 lacks them
                try:
                    if not r2cache.manifest(r2cache.compile_prefix(gpu, version)):
                        self.compile_sig[root] = (0, 0)
                        return r2cache.compile_env(root), root
                except Exception as e:  # noqa: BLE001
                    log(f"R2 compiled kernels: {type(e).__name__}: {e}")
            else:
                try:
                    out = r2cache.pull(r2cache.compile_prefix(gpu, version), root)
                    r2cache.EVENTS[f"pull kernels {version}"] = out or "none yet"
                    log(f"compiled kernels for {gpu} / vLLM {version} from R2: {out['bytes'] / 1e6:.0f} MB in {out['secs']} s"
                        if out else f"no compiled kernels in R2 yet for {gpu} / vLLM {version}: this load compiles them")
                except Exception as e:  # noqa: BLE001  it compiles them itself
                    log(f"R2 compiled kernels: {type(e).__name__}: {e}")
            self.compile_sig[root] = r2cache.tree_sig(root)
        os.makedirs(root, exist_ok=True)
        return r2cache.compile_env(root), root

    def _compile_push(self, root):
        """After a vLLM engine is ready: upload its folder if this load compiled anything new (background, holding the
        engine lock so no other load writes into it meanwhile)."""
        if not (root and C.R2_COMPILE and r2cache.enabled()):
            return
        sig = r2cache.tree_sig(root)
        if not sig[0] or sig == self.compile_sig.get(root):
            return
        self.compile_sig[root] = sig
        parts = root.split(os.sep)

        def go():
            with self.lock:
                try:
                    names = [n for n in ("vllm", "inductor", "triton") if os.path.isdir(os.path.join(root, n))]
                    out = r2cache.push(r2cache.compile_prefix(*parts[-2:]), root, names)
                    r2cache.EVENTS["push kernels"] = out
                    log(f"compiled kernels saved to R2: {out['bytes'] / 1e6:.0f} MB in {out['secs']} s")
                except Exception as e:  # noqa: BLE001
                    log(f"couldn't save compiled kernels to R2 ({type(e).__name__}: {e})")
        threading.Thread(target=go, daemon=True).start()

    def _others_fetching(self, name):
        """A job is installing, downloading or loading another engine (its live progress is in self.fetch)."""
        return any(n != name for n in list(self.fetch))

    def _wait_for_quiet(self, name):
        while self._others_fetching(name):
            time.sleep(2)

    def _switch_group(self, name):
        if not C.ENGINES[name]["gpu_gb"]:
            return  # a CPU engine (Kokoro) sits next to either group: it's what the CPU lane runs while the GPU works
        group = C.ENGINES[name]["group"]
        others = [n for n in self.procs if C.ENGINES[n]["group"] != group and C.ENGINES[n]["gpu_gb"] and n not in self.parked]
        busy = [n for n in others if self.inflight[n]]
        if busy:
            raise RuntimeError(f"{busy[0]} is busy right now; {name} can start when it finishes")
        for other in others:
            self._park_or_stop(other, f"switching to {group} models")

    def _ensure_disk(self, name):
        """Make room for a first download by deleting the least-recently-used weights of stopped engines."""
        have = dir_gb(cache_dir(name), max_age=0) if os.path.isdir(cache_dir(name)) else 0.0
        need = max(0.0, C.ENGINES[name].get("disk_gb", 0) - have) + C.DISK_RESERVE_GB
        free = shutil.disk_usage(HOME).free / 1e9
        if free >= need:
            return
        legacy = os.path.expanduser("~/.cache/huggingface")
        keep = {cache_dir(name)} | {cache_dir(n) for n in self.procs}  # a shared folder (CACHE_ALIAS) counts for both
        victims = ([legacy] if os.path.isdir(legacy) else []) + list(dict.fromkeys(
            cache_dir(n) for n in sorted(C.ENGINES, key=lambda n: USAGE.get(n, 0))
            if cache_dir(n) not in keep and os.path.isdir(cache_dir(n))))
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
        # a parked engine keeps ~1 GB on the GPU (its CUDA context); a live one its whole share
        used = lambda: sum(1.0 if n in self.parked else C.ENGINES[n]["gpu_gb"] for n in self.procs if n != name)
        while used() + need > self.budget:
            live = [n for n in self.procs if n != name and C.ENGINES[n]["gpu_gb"] > 0 and n not in self.parked and not self.inflight[n]]
            live.sort(key=lambda n: n in self.resident)  # oldest first, the review's models last (stable sort keeps LRU)
            victim = live[0] if live else next((n for n in self.procs if n != name and n in self.parked), None)
            if not victim:
                return
            if victim in self.parked:
                log(f"stopping parked {victim} to make room for {name}")
                self.stop(victim)
            else:
                self._park_or_stop(victim, f"making room for {name}")

    def running(self, name):
        p = self.procs.get(name)
        return bool(p and p.poll() is None and self.state[name] == "ready")

    def fits_now(self, name):
        """Can name serve right now without anything else leaving the GPU: running, or parked in RAM with room for its
        share next to what's loaded (the streamed first line wakes Whisper only then, never mid-generation evictions)."""
        if self.running(name):
            return True
        p = self.procs.get(name)
        if name not in self.parked or not (p and p.poll() is None):
            return False
        return self._room_for(name)

    def _room_for(self, name):
        """name's share of the GPU fits next to everything loaded now (a parked engine keeps ~1 GB)."""
        if self.budget <= 0:
            return False
        used = sum(1.0 if n in self.parked else C.ENGINES[n]["gpu_gb"] for n in list(self.procs) if n != name)
        return used + C.ENGINES[name]["gpu_gb"] <= self.budget

    def preload(self, name):
        """Step 4: load (or wake) a resident engine in the background while a job generates, so its stage never waits
        for it. Only when it fits beside what's loaded: it never moves anything else off the GPU."""
        if name not in self.resident or name in self.preloading or self.running(name) or not self._room_for(name):
            return
        p = self.procs.get(name)
        if p and p.poll() is None and name not in self.parked:
            return  # already loading
        self.preloading.add(name)

        def go():
            try:
                t = time.time()
                self.ensure(name)
                log(f"preloaded {name} beside the running job in {time.time() - t:.0f} s")
            except Exception as e:  # noqa: BLE001  the stage that needs it loads it the usual way
                log(f"couldn't preload {name} ({type(e).__name__}: {e})")
            finally:
                self.preloading.discard(name)
        threading.Thread(target=go, daemon=True).start()

    def ensure(self, name):
        if self.running(name):  # loaded: don't wait on the lock while another engine loads (a step 4 preload holds it)
            if self.lock.acquire(blocking=False):
                try:
                    self.procs.move_to_end(name)
                finally:
                    self.lock.release()
            return
        with self.lock:
            p = self.procs.get(name)
            if p and p.poll() is None:
                self.procs.move_to_end(name)
                if name in self.parked:
                    try:  # back from RAM: make GPU room the same way a cold start would, then wake it
                        self._switch_group(name)
                        self._evict_for(name)
                        self._wake(name)
                    except Exception as e:  # noqa: BLE001  a failed wake: a clean cold start instead
                        log(f"couldn't wake {name} ({type(e).__name__}: {e}); restarting it")
                        self.parked.pop(name, None)
                        self.stop(name)
                        return self.ensure(name)
                return
            if p:  # it died since it last answered: its children (vLLM's EngineCore) may still hold GPU memory
                import signal
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                self.procs.pop(name, None)
                self.parked.pop(name, None)
                log(f"{name} had exited (code {p.returncode}); starting it again")
            compile_root = None
            try:
                self._switch_group(name)
                self._ensure_disk(name)
                self.state[name] = "installing" if not os.path.exists(C.python_for(name)) else "loading"
                self.since[name] = time.time()
                threading.Thread(target=self._watch, args=(name,), daemon=True).start()
                py = self._install(name)
                self._evict_for(name)
                self._room_in_ram(name)
                self._r2_weights(name)  # a fresh runtime whose prefetch hasn't got this far: R2 beats the engine's own download
                compile_env, compile_root = self._compile_cache(name, py)
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
                       "MPLBACKEND": "Agg", "VOICEBOX_COMPILE_CODEC": "1" if C.COMPILE_CODEC else "0",
                       "VOICEBOX_STREAM": "1" if C.STREAM else "0", "VOICEBOX_SPEC": C.SPEC, **compile_env}
                p = subprocess.Popen([py, os.path.join(HERE, "engine_host.py"), "--engine", name,
                                      "--port", str(C.ENGINES[name]["port"])], stdout=logf, stderr=logf, env=env, cwd=HERE,
                                     start_new_session=True)  # own process group: stop() also kills vLLM's children
                self.procs[name] = p
                t_load, warm = time.time(), bool(WARM.state.get(name, {}).get("warm"))
                deadline = time.time() + 30 * 60
                while time.time() < deadline:
                    if p.poll() is not None:
                        raise RuntimeError(f"{name} exited while loading (see logs/{name}.log)")
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{C.ENGINES[name]['port']}/ready", timeout=2) as r:
                            self.batch[name] = bool(json.loads(r.read()).get("batch"))
                        self._set(name, "ready")
                        self.errors.pop(name, None)
                        self.loads[name] = {"secs": round(time.time() - t_load, 1), "warm": warm, "at": time.time()}
                        log(f"{name} ready in {time.time() - t_load:.0f} s (batch={self.batch[name]}, weights {'in RAM' if warm else 'from disk'})")
                        self._compile_push(compile_root)
                        return
                    except Exception:
                        time.sleep(2)
                raise RuntimeError(f"{name} did not become ready in 30 min")
            except Exception as e:
                self._set(name, "error")
                self.errors[name] = str(e)
                self.stop(name, keep_state=True)
                if compile_root:  # a bad or mismatched kernel cache must not fail every load: the next one compiles afresh
                    shutil.rmtree(compile_root, ignore_errors=True)
                    self.compile_sig[compile_root] = (0, 0)
                raise

    def stop(self, name, keep_state=False):
        with self.lock:
            self.parked.pop(name, None)
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

    def _post(self, name, path, payload, timeout=60 * 60, retry=True):
        """One call to an engine. If the engine dies during it (a crash, the kernel's OOM killer, or a fatal GPU error
        it exits on), it's restarted and the call made once more, so a job survives it; a second death is an error."""
        self.ensure(name)
        req = urllib.request.Request(f"http://127.0.0.1:{C.ENGINES[name]['port']}{path}",
                                     data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with self.inflight_lock:
            self.inflight[name] += 1
        died = None
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            err = json.loads(e.read() or b"{}")
            if not err.get("fatal"):
                raise RuntimeError(err.get("error", str(e)))
            died = err.get("error")
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            if isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError):
                # hung (e.g. a stuck vLLM step): it would hang the next job too, so it goes; the next call starts it fresh
                log(f"{name} didn't answer {path} in {timeout:.0f} s: stopping it")
                self.errors[name] = f"stopped answering ({path}, {timeout:.0f} s); restarted on next use"
                threading.Thread(target=self.stop, args=(name,), daemon=True).start()
                raise RuntimeError(f"{name} stopped answering after {timeout:.0f} s; it will restart on the next try")
            p = self.procs.get(name)
            if not (p and self._exited(p)):
                raise
            died = f"{type(e).__name__}: {e}"
        finally:
            with self.inflight_lock:
                self.inflight[name] -= 1
            self.last[name] = time.time()
            mark_used(name)
        self.errors[name] = f"crashed during a call ({died}); restarted"
        log(f"{name} died during {path} ({died}): restarting it" + (" and trying once more" if retry else ""))
        self.stop(name)
        if not retry:
            raise RuntimeError(f"{name} stopped working twice in a row: {died}")
        return self._post(name, path, payload, timeout, retry=False)

    @staticmethod
    def _exited(p, wait=5.0):
        """Has this engine process ended (allowing it a moment: a fatal error answers first, then exits)?"""
        try:
            p.wait(wait)
            return True
        except subprocess.TimeoutExpired:
            return False

    def synth(self, name, payload):
        return self._post(name, "/synth", payload)

    def synth_batch(self, name, items, timing=None, timeout=60 * 60):
        """timing: a dict that gets the engine's codec seconds and decode speed (Orpheus / myvoice: tokens made, their
        seconds, the speculative decoding in use), when it reports them."""
        r = self._post(name, "/synth_batch", {"items": items}, timeout=timeout)
        if timing is not None:
            timing["codec"] = r.get("codec_s") or 0.0
            timing.update({k: r[k] for k in ("gen_tokens", "gen_s", "spec") if k in r})
        return r["results"]

    def transcribe(self, paths, language=None, words=True):
        """words=False: text only, short clips decoded together in one batch (the review)."""
        return self._post("whisper", "/transcribe", {"paths": paths, "language": language, "words": words})["results"]

    def similarity(self, ref_path, paths):
        """Speaker-embedding cosine of each file vs the reference (WavLM SV, ~0.86+ = same speaker)."""
        return self._post("whisper", "/similarity", {"ref": ref_path, "paths": paths})["scores"]

    def mos(self, paths):
        """Predicted naturalness (UTMOS, 1-5) per file."""
        return self._post("whisper", "/mos", {"paths": paths})["scores"]

    def revoice(self, payload):
        return self._post("chatterbox", "/revoice", payload)

    def enhance(self, payload, name="enhance"):
        return self._post(name, "/enhance", payload)

    def enhance_batch(self, items, name="enhance"):
        """Studio polish for many files in one call (Resemble Enhance or AP-BWE)."""
        return self._post(name, "/enhance_batch", {"items": items})["results"]

    def video(self, name, payload):
        return self._post(name, "/video", payload, timeout=3 * 60 * 60)

    def image(self, name, payload):
        return self._post(name, "/image", payload, timeout=60 * 60)

    def animate(self, name, payload):
        return self._post(name, "/animate", payload, timeout=3 * 60 * 60)


ENG = Engines()
WARM = Warmer()
MON = Monitor()


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
QUEUE = []       # the GPU lane: one job at a time
CPU_QUEUE = []   # the CPU lane: jobs that need no GPU, run alongside
FETCH_QUEUE = []  # the download lane: links download side by side (FETCH_WORKERS at once), never behind a voiceover
FETCH_WORKERS = int(os.environ.get("VOICEBOX_FETCH_WORKERS", "4"))
QCOND = threading.Condition()
MAX_LINES, MAX_TEXT = 1000, 100_000


def resolve_voice(engine, voice):
    spec = C.ENGINES[engine]
    voice = voice or "female"
    return spec["presets"].get(voice, voice)


def _cpu_only(job):
    """A job that never touches the GPU (a Kokoro voiceover with no listening pass, subtitles or studio polish): it runs
    in the CPU lane, next to whatever the GPU is doing, instead of waiting behind it."""
    if job["kind"] in ("storycard", "fetch"):  # ffmpeg / yt-dlp only
        return True
    return (job["kind"] == "tts" and not job.get("mode") and C.ENGINES.get(job.get("engine"), {}).get("gpu_gb", 1) == 0
            and job.get("takes", 1) == 1 and not job.get("review") and not job.get("subtitles") and not (job.get("post") or {}).get("enhance"))


def _queue_of(job):
    return FETCH_QUEUE if job.get("lane") == "fetch" else CPU_QUEUE if job.get("lane") == "cpu" else QUEUE


JOB_KEEP_H = float(os.environ.get("VOICEBOX_JOB_KEEP_H", "12"))


def prune_jobs():
    """Every job leaves its files in jobs/ (takes, masters, zips, a draft's training data), and nothing removed them,
    so a long session filled the disk. A finished job's files go after JOB_KEEP_H hours (its links expire after 6, and
    the dashboard keeps its own copy); after 1 hour when the disk runs short. Queued and running jobs are never touched."""
    now = time.time()
    short = shutil.disk_usage(HOME).free / 1e9 < 2 * C.DISK_RESERVE_GB
    keep_s = (1.0 if short else JOB_KEEP_H) * 3600
    live = {j for j, x in list(JOBS.items()) if x["status"] in ("queued", "running")}
    freed = 0
    for entry in os.listdir(JOBS_DIR):
        jid = entry.split(".")[0]
        if jid in live:
            continue
        path = os.path.join(JOBS_DIR, entry)
        job = JOBS.get(jid)
        try:
            t = (job or {}).get("finished") or os.path.getmtime(path)
        except OSError:
            continue
        if now - t < keep_s:
            continue
        freed += dir_gb(path, max_age=0) if os.path.isdir(path) else os.path.getsize(path) / 1e9
        shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else os.remove(path)
        _SIZES.pop(path, None)
    if freed > 0.05:
        log(f"removed old jobs' files: {freed:.1f} GB" + (" (disk was short)" if short else ""))


def _enqueue(job):
    os.makedirs(os.path.join(JOBS_DIR, job["id"]), exist_ok=True)
    job["lane"] = "fetch" if job["kind"] == "fetch" else "cpu" if _cpu_only(job) else "gpu"
    g = gpu_info_cached()
    if job["kind"] in ("train", "video") and 0 < g["total_gb"] < 30:
        job.setdefault("warnings", []).append(f"{'training' if job['kind'] == 'train' else 'video'} on a {g['total_gb']:.0f} GB {g['name'].replace('NVIDIA ', '')}: "
                                              "it works, but an A100 does it much faster (Health: Start for training & video)")
    with QCOND:
        JOBS[job["id"]] = job
        _queue_of(job).append(job["id"])
        QCOND.notify_all()
    if len(JOBS) > 300:  # forget the oldest finished jobs; never one that's still queued or running
        done = [j for j, x in list(JOBS.items()) if x["status"] not in ("queued", "running")]
        for j in done[:len(JOBS) - 300]:
            JOBS.pop(j, None)
    return job


def _base_job(kind, body):
    return {"id": uuid.uuid4().hex[:12], "kind": kind, "status": "queued", "created": time.time(), "results": [],
            "error": None, "cancel": False, "label": str(body.get("label") or "")[:120], "stage": "queued",
            "est_total": 0.0, "est_done": 0.0, "cur": None, "language": body.get("language") or None, "warnings": [], "lines": []}


def make_job(body):
    if FETCH_ONLY and body.get("kind") != "fetch":
        raise ValueError("this is the downloads-only worker (a CPU runtime, no GPU): start the GPU for voice, clean-up and video (it replaces this one)")
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
    if body.get("kind") == "eagle":
        return make_eagle_job(body)
    if body.get("kind") == "storycard":
        return make_storycard_job(body)
    if body.get("kind") == "fetch":
        return make_fetch_job(body)
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
                "takes": 1 if engine == "kokoro" else max(1, min(C.MAX_TAKES, int(body.get("takes") or 1))),
                "review_batch": body["review_batch"] if isinstance(body.get("review_batch"), bool) else C.BATCH_REVIEW,
                "stream": body["stream"] if isinstance(body.get("stream"), bool) else C.STREAM})
    _platform(job, body, style_post)
    if engine == "myvoice" and "enhance" not in (body.get("post") or {}):
        job["post"]["enhance"] = "auto"  # 24 kHz codec -> 44.1 kHz studio air, kept only when it listens better
    if engine == "kokoro" and int(body.get("takes") or 1) > 1:
        job["warnings"].append("kokoro is deterministic, so every take would be identical: made one")
    if learned:
        job["warnings"].append("learned settings for this voice: " + ", ".join(f"{k} {v}" for k, v in learned.items()))
    chars = sum(len(l["text"]) for l in clean)
    job["est_total"] = (RATES[engine] * chars * job["takes"] + (RATES["whisper"] * chars / 14 if job["subtitles"] else 0)
                        + (RATES["listen" if job["review_batch"] else "whisper"] * chars / 14 * job["takes"] if job["takes"] > 1 or job["review"] else 0))


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


def polish_engine(job):
    """The engine studio polish runs on for this job: post.polish_engine, else config.POLISH."""
    pick = (job.get("post") or {}).get("polish_engine") or C.POLISH
    return C.POLISH_ENGINE.get(pick, "enhance")


def studio_clean(job, src, dst, params=None, label="studio clean-up: noise out, detail restored", engine="enhance"):
    """Resemble Enhance (or AP-BWE for studio polish) src -> dst. True on success; False after a warning when the
    enhancer can't run, so the caller falls back to its plain ffmpeg clean-up instead of failing the job. AP-BWE that
    fails hands the file to Resemble Enhance."""
    import soundfile as sf
    stage = job["stage"]
    dur = sf.info(src).duration
    p = C.resolve_params("enhance", params or {})
    try:
        _prepare(job, engine)
        job["stage"] = "enhancing"
        t0 = time.time()
        _run_unit(job, RATES[engine] * dur + 2, lambda: ENG.enhance({"src_path": src, "out_path": dst, "params": p}, engine), label)
        learn_rate(engine, time.time() - t0, max(dur, 1.0))
        return True
    except Cancelled:
        raise
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        if engine != "enhance":
            log(f"{engine} failed ({type(e).__name__}: {e}); Resemble Enhance instead")
            job["stage"] = stage
            return studio_clean(job, src, dst, params, label)
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
                        "studio polish", polish_engine(job)):
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


def _studio_outputs(job, paths):
    """_studio_output for a whole voiceover: every line through the enhancer in one batched call, then ("auto") one
    voice-match check per line and one naturalness call for all. Was a line at a time: 37 lines spent 88 s polishing."""
    import soundfile as sf
    mode = job["post"].get("enhance")
    if not mode or job.get("_no_polish") or not paths:
        return paths
    outs = [x[:-4] + ".enh.wav" for x in paths]
    params = C.resolve_params("enhance", {"mode": "enhance", "strength": float(job["post"].get("enhance_strength", 0.3))})
    stage = job["stage"]
    dur = sum(sf.info(x).duration for x in paths)
    res = None
    for engine in dict.fromkeys((polish_engine(job), "enhance")):  # AP-BWE, and Resemble Enhance if it fails
        try:
            _prepare(job, engine)
            job["stage"] = "enhancing"
            t0 = time.time()
            res = _run_unit(job, RATES[engine] * dur + 2, lambda: ENG.enhance_batch(
                [{"src_path": a, "out_path": b, "params": params} for a, b in zip(paths, outs)], engine),
                f"studio polish: {len(paths)} lines at once")
            learn_rate(engine, time.time() - t0, max(dur, 1.0))
            job["polish_engine"] = engine
            job["polish"] = {"engine": engine, "lines": len(paths), "audio_s": round(dur, 1), "model_s": round(time.time() - t0, 1)}
            break
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            if engine != "enhance":
                log(f"{engine} failed ({type(e).__name__}: {e}); Resemble Enhance instead")
                continue
            msg = f"studio enhance unavailable ({type(e).__name__}: {str(e)[:120]}); used the standard clean-up"
            if msg not in job["warnings"]:
                job["warnings"].append(msg)
            return paths
        finally:
            job["stage"] = stage
    ok = [i for i, r in enumerate(res) if "error" not in r and os.path.exists(outs[i])]
    keep = set(ok)
    t_check, sims, mos = time.time(), {}, []
    if mode == "auto" and ok:
        try:
            _prepare(job, "whisper")
            job["stage"] = "enhancing"
            sims = {i: ENG.similarity(paths[i], [outs[i]])[0] for i in ok}
            mos = ENG.mos([x for i in ok for x in (paths[i], outs[i])])
            keep = {i for n, i in enumerate(ok) if sims[i] >= 0.9 and (mos[2 * n + 1] is None or mos[2 * n] is None or mos[2 * n + 1] >= mos[2 * n] - 0.05)}
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001  can't judge them: keep the takes as generated
            log(f"polish check failed ({type(e).__name__}: {e})")
            note = f"studio polish not applied: its voice check failed ({type(e).__name__}: {str(e)[:80]})"
            if note not in job["warnings"]:
                job["warnings"].append(note)
            keep, ok = set(), []
        finally:
            job["stage"] = stage
        avg = lambda xs: round(sum(xs) / len(xs), 3) if xs else None
        job["polish"].update(check_s=round(time.time() - t_check, 1), sim=avg(list(sims.values())),  # voice match, polished vs not
                             mos_before=avg([m for m in mos[0::2] if m is not None]), mos_after=avg([m for m in mos[1::2] if m is not None]))
        if ok and len(keep) < len(paths):
            note = "studio polish skipped on some lines: it changed the voice or sounded less natural"
            if note not in job["warnings"]:
                job["warnings"].append(note)
    job["polish"]["kept"] = len(keep)
    final = []
    for i, (a, b) in enumerate(zip(paths, outs)):
        if i in keep:
            os.remove(a)
            final.append(b)
        else:
            if os.path.exists(b):
                os.remove(b)
            final.append(a)
    return final


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
        _time(job, job.get("stage") or "", spent)
        job["est_total"] += spent - job["cur"]["est"]  # replace the guess with what it really took
        job["est_done"] += spent
        job["cur"] = None


# where a job's time went, by step (shown on the Health page): stage names -> plain steps
STEP = {"preparing": "loading", "generating": "generating", "fixing": "re-voicing", "choosing": "listening"}


def _time(job, stage, secs):
    step = STEP.get(stage.split(":", 1)[0], stage.split(":", 1)[0] or "other")
    t = job.setdefault("timings", {})
    t[step] = round(t.get(step, 0.0) + secs, 2)


def _prepare(job, name):
    job["stage"] = "preparing:" + name
    t0 = time.time()
    ENG.ensure(name)
    _time(job, "preparing", time.time() - t0)


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
    # step 5: publish the first line while the rest generate (not with studio polish, which needs the GPU's enhancer,
    # nor a trained voice, whose takes are kept whole as preference pairs)
    streamed, watcher, stop = {}, None, threading.Event()
    if job.get("stream") and len(plans) > 1 and not job["post"].get("enhance") and engine != "myvoice":
        job["_stream_line"] = plans[0]
        watcher = threading.Thread(target=_stream_line, args=(job, jdir, plans[0], out, ref_path, stop, streamed), daemon=True)
        watcher.start()
    # listen live: every line's first take, playable the moment it is made, for every engine (_live_preview)
    live_stop = threading.Event()
    live = threading.Thread(target=_live_preview, args=(job, jdir, plans, out, live_stop), daemon=True) \
        if job.get("stream") and len(plans) > 1 else None
    if live:
        live.start()
    try:
        try:
            _generate(job, first, out, ref_path, ref_text, order, len(plans))
        finally:
            job.pop("_stream_line", None)
            if watcher:
                stop.set()  # the files are all there now (or the job failed): it finishes what it started
                watcher.join()
        rest = [p for p in plans if not ("trials" in streamed and p is plans[0])]
        if C.ENGINES[engine].get("gpu_gb") and len(plans) >= 4 and (job["subtitles"] or job["post"].get("enhance") or job.get("review")):
            ENG.park_for_post(engine)  # its GPU memory goes to the review, the polish and the subtitles (bigger batches)

        if takes == 1 and not job.get("review"):  # fast path: no listening pass
            _assemble_all(job, jdir, [(p, [out(p, i, 0) for i in range(len(p["chunks"]))], None) for p in rest])
        else:
            picks = _review(job, rest, out, ref_path, ref_text, order)
            job["trials"] = (streamed.get("trials", []) + job.get("trials", []))[:2000]
            _assemble_all(job, jdir, [(p, [out(p, i, picks[p["ln"]["id"]]["take"][i]) for i in range(len(p["chunks"]))], picks[p["ln"]["id"]])
                                      for p in rest])
            for x in os.listdir(jdir):  # the takes that lost
                if re.search(r"\.c\d+\.t\d+\.wav$", x):
                    os.remove(os.path.join(jdir, x))
        job["results"].sort(key=lambda r: order[r["id"]])
        for x in os.listdir(jdir):  # codec tokens of takes no review looked at
            if x.endswith(".codes.json"):
                os.remove(os.path.join(jdir, x))

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
    finally:
        if live:
            live_stop.set()
            live.join(timeout=30)
        job.pop("live", None)  # the finished lines replace the previews
        for x in os.listdir(jdir) if os.path.isdir(jdir) else []:
            if x.endswith((".live.wav", ".liveraw.wav")):
                try:
                    os.remove(os.path.join(jdir, x))
                except OSError:
                    pass


def _save_pairs(job, plans, cands, best, out):
    """A trained voice's takes as preference data (RLHF: train_dpo.py): per chunk, the codec tokens of the take the
    review kept and of its worst take, with their scores, in pairs.json (the dashboard stores it per person). A chunk
    with one take still records the kept one, so a thumbs-down on its line can pair it with a better take later."""
    if job.get("engine") != "myvoice" or job.get("mode"):
        return
    jdir = os.path.dirname(out(plans[0], 0, 0))
    chunks, n_pairs = [], 0
    for p in plans:
        if p["engine"] != "myvoice":
            continue
        for i in range(len(p["chunks"])):
            c = cands.get((p["ln"]["id"], i)) or {}
            if not c:
                continue
            k, _ = best((p["ln"]["id"], i))
            med = sorted(v["dur"] for v in c.values())[len(c) // 2]
            rank = {kk: quality.take_score(v["text"], v["sim"], None, v["mos"], v["dur"], med, v["clip"]) for kk, v in c.items()}
            keep = [k] + ([min(rank, key=rank.get)] if len(c) > 1 else [])
            takes = []
            for kk in dict.fromkeys(keep):
                f = out(p, i, kk)[:-4] + ".codes.json"
                if not os.path.exists(f):
                    continue
                v = c[kk]
                takes.append({"take": kk, "picked": kk == k, "score": round(rank[kk], 4), "text": v["text"], "sim": v["sim"],
                              "missed": v["missed"], "codes": json.load(open(f))})
            if takes:
                n_pairs += len(takes) > 1
                chunks.append({"line": p["ln"]["id"], "chunk": i, "said": p["chunks"][i][1], "takes": takes})
    for f in os.listdir(jdir):
        if f.endswith(".codes.json"):
            os.remove(os.path.join(jdir, f))
    if chunks:
        json.dump({"voice": job["voice"], "speaker": plans[0].get("voice_arg"), "chunks": chunks}, open(os.path.join(jdir, "pairs.json"), "w"))
        job["pairs"] = {"chunks": len(chunks), "pairs": n_pairs}


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
    """Script order for flow: each line's first chunk follows the previous line's last one (see _flow), in chains the
    GPU voices side by side. One chain through the whole script made a trained voice's voiceover one chunk at a time
    (37 lines: 17 min on an L4 at 45 tokens/s, under real time). Chains grow 1, 1, 2, 2, 3, 3 ... up to C.FLOW_CHAIN
    lines, so the opening lines are ready first (they play while the rest are made) and every chain runs at once.
    C.FLOW_CHAIN 0: one chain, as before."""
    k = start = 0
    while start < len(plans):
        size = len(plans) if C.FLOW_CHAIN <= 0 else min(C.FLOW_CHAIN, 1 + k // 2)
        seg = plans[start:start + size]
        for a, b in zip(seg, seg[1:]):
            b["after"] = f"{a['ln']['id']}/{len(a['chunks']) - 1}"
        start, k = start + size, k + 1


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
        if job.get("review") or job.get("takes", 1) > 1 or job.get("subtitles"):
            ENG.preload("whisper")  # step 4: the review's model loads beside the generation, not after it
        if job["post"].get("enhance"):
            ENG.preload(polish_engine(job))
        job["stage"] = "generating" if job["stage"] != "fixing" else "fixing"
        # vLLM schedules its own batches (continuous batching over the KV cache): hand it the whole job at once.
        # Qwen batches on plain transformers, where memory grows with the batch: sized to the card (config.qwen_batch).
        size = (int(os.environ.get("ORPHEUS_MAX_SEQS", "64")) if eng in ("orpheus", "myvoice")
                else C.qwen_batch(ENG.budget + 1.5) if eng == "qwen" else 8) if ENG.batch.get(eng) else 1
        head = [w for w in mine if w[0] is job.get("_stream_line")] if size > 1 and eng not in ("orpheus", "myvoice") else []
        rest = [w for w in mine if not any(w is h for h in head)]  # streaming: the first line goes first, on its own
        for group in ([head] if head else []) + [rest[b:b + size] for b in range(0, len(rest), size)]:
            items = [{"text": p["chunks"][i][1], "voice": p["voice_arg"], "params": params, "ref_path": ref_path,
                      "ref_text": ref_text, "out_path": out(p, i, k), "lora": p.get("lora"), **_flow(job, p, i, k),
                      # a trained voice's takes keep their codec tokens: the winner and loser become a preference pair
                      **({"codes_path": out(p, i, k)[:-4] + ".codes.json"} if eng == "myvoice" and not job.get("mode") else {})}
                     for p, i, k, params in group]
            chars = sum(len(it["text"]) for it in items)
            lo, hi = order[group[0][0]["ln"]["id"]] + 1, order[group[-1][0]["ln"]["id"]] + 1
            label = (f"line {lo} of {n_lines}" if lo == hi else f"lines {lo}–{hi} of {n_lines} together")
            if job["stage"] == "fixing":
                label = f"re-voicing {len(mine)} sentence{'s' if len(mine) > 1 else ''} that missed"
            elif job.get("takes", 1) > 1:
                label += f" · {job['takes']} takes each"
            t0 = time.time()
            spent = {}
            # a hung engine shouldn't hold the GPU queue for an hour: 10x the expected time, at least 15 min
            limit = max(900.0, 10 * RATES[eng] * chars)
            res = _run_unit(job, RATES[eng] * chars, lambda: ENG.synth_batch(eng, items, spent, timeout=limit), label)
            if spent.get("codec"):  # show the codec as its own step: move its seconds out of generating / re-voicing
                t = job["timings"]
                step = STEP.get(job["stage"], job["stage"])
                t[step] = round(t.get(step, 0.0) - spent["codec"], 2)
                t["codec"] = round(t.get("codec", 0.0) + spent["codec"], 2)
            if spent.get("gen_tokens"):  # step 5b: codec tokens a second of vLLM decoding, over the whole job
                d = job.setdefault("decode", {"tokens": 0, "secs": 0.0})
                d["tokens"] += spent["gen_tokens"]
                d["secs"] = round(d["secs"] + spent.get("gen_s", 0.0), 2)
                d.update(tokens_per_s=round(d["tokens"] / max(d["secs"], 1e-3), 1), spec=spent.get("spec"))
            if not ENG.batch.get(eng) or len(items) > 1:
                learn_rate(eng, time.time() - t0, chars)
            errs = [r["error"] for r in res if "error" in r]
            if errs:
                raise RuntimeError(errs[0])
        log(f"job {job['id']} {eng}/{job['voice']} {len(mine)} chunk takes")


def _assemble_all(job, jdir, items):
    """Master every line, on all CPU cores at once (join, trim, pace, loudness and the delivery measure are CPU work:
    a 60-line script finishes in the time of a few lines). Studio polish runs on the GPU's enhancer, so in order."""
    from concurrent.futures import ThreadPoolExecutor
    workers = min(len(items), max(1, (os.cpu_count() or 2) - 1), 12)
    # studio polish is GPU work (the enhancer, then the voice check), one line after another; it used to take the
    # CPU mastering with it, so a 19-line voiceover mastered one line at a time (76 s). Now: polish in order, then
    # master every line at once.
    raws = _studio_outputs(job, [_line_raw(job, jdir, p, paths, polish=False) for p, paths, _ in items]) \
        if job["post"].get("enhance") else [None] * len(items)
    if workers < 2:
        for (p, paths, pick), raw in zip(items, raws):
            _assemble(job, jdir, p, paths, pick, raw=raw)
        return
    t0 = time.time()
    job["stage"] = "mastering"
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(lambda a: _assemble(job, jdir, *a[0], timed=False, raw=a[1]), zip(items, raws)))
    _time(job, "mastering", time.time() - t0)


def _line_raw(job, jdir, p, paths, polish=True):
    """A line's chunks joined with the asked-for gaps (and studio-polished when asked): the WAV mastering starts from."""
    ln = p["ln"]
    raw = os.path.join(jdir, f"{ln['id']}.raw.wav")
    _join_chunks(paths, raw, [c[2] for c in p["chunks"]], [c[1] for c in p["chunks"]])
    for x in paths:
        if os.path.exists(x):
            os.remove(x)
    return _studio_output(job, raw) if polish else raw


def _assemble(job, jdir, p, paths, pick=None, timed=True, raw=None):
    """Chunks -> one line WAV: join with the asked-for gaps, then trim, pace, resample and master. raw: the joined
    (and polished) line, when _assemble_all made it already."""
    ln = p["ln"]
    if raw is None:
        raw = _line_raw(job, jdir, p, paths)
    t0 = time.time()  # mastering only: studio polish times itself as "enhancing"
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
    if timed:
        _time(job, "mastering", time.time() - t0)
    job["results"].append(r)


def _listen(job, paths, ref_path, side=False):
    """Whisper + voice match (+ naturalness when available) for a set of takes. side: called next to a running
    generation (the streamed first line): Whisper must already be loaded, and the job's progress is left alone."""
    import soundfile as sf

    def unit(est, fn, label):
        return fn() if side else _run_unit(job, est, fn, label)
    if not side:
        stage = job["stage"]
        _prepare(job, "whisper")
        job["stage"] = stage
    durs = [sf.info(x).duration for x in paths]
    heard = []
    if job.get("review_batch") or side:  # every take in one text-only call (INFERENCE.md step 3)
        audio_s = sum(durs)
        t0 = time.time()
        heard = unit(RATES["listen"] * audio_s + 2, lambda: ENG.transcribe(paths, job.get("language"), words=False),
                     f"listening back: {len(paths)} take{'s' if len(paths) > 1 else ''} at once")
        if not side:
            learn_rate("listen", time.time() - t0, audio_s)
    else:
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
            sims = unit(0.3 * len(paths) + 5, lambda: ENG.similarity(ref_path, paths), "comparing with your voice")
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001  a missing voice-match model only costs the similarity half of the score
            job["warnings"].append(f"voice match unavailable ({type(e).__name__}); takes chosen on script accuracy")
    mos = [None] * len(paths)
    if not job.get("_no_mos"):
        try:
            mos = unit(0.15 * len(paths) + 3, lambda: ENG.mos(paths), "rating naturalness")
        except Cancelled:
            raise
        except Exception:  # noqa: BLE001  UTMOS is a tie-breaker; carry on without it (and don't retry every round)
            job["_no_mos"] = True
    clip = []
    for x in paths:
        a, _ = sf.read(x, dtype="float32", always_2d=False)
        clip.append(float((abs(a) > 0.995).mean()) if len(a) else 0.0)
    return [{"heard": h["text"], "sim": s, "mos": m, "dur": d, "clip": c} for h, s, m, d, c in zip(heard, sims, mos, durs, clip)]


def _score_takes(entries, stats, cands):
    """Fold what the listening pass heard into cands: (line id, chunk) -> {take: stats + script match}."""
    for (p, i, k, params), st in zip(entries, stats):
        text, said, _ = p["chunks"][i]
        t = quality.score_text(text, st["heard"], said)
        cands.setdefault((p["ln"]["id"], i), {})[k] = {**st, "text": t["score"], "missed": t["missed"], "added": t["added"],
                                                      "temperature": params.get("temperature"), "seed": params.get("seed")}


def _best_take(c, base):
    """The winning take of one chunk and its score (script match first, then voice, naturalness, length, clipping)."""
    med = sorted(v["dur"] for v in c.values())[len(c) // 2]
    rank = {k: quality.take_score(v["text"], v["sim"], base, v["mos"], v["dur"], med, v["clip"]) for k, v in c.items()}
    k = max(rank, key=rank.get)
    return k, rank[k]


def _live_preview(job, jdir, plans, out, stop):
    """Listen live: each line's first take, joined and mastered (no review, no studio polish) as soon as all its chunks
    are on disk, in script order, so the dashboard can play a voiceover while it is still being made (a trained voice
    with flow makes its lines one after another, so they arrive in order). CPU only, beside the generation; never
    touches the takes, the review or the results. The finished lines replace these when the job is done."""
    import soundfile as sf
    live = job.setdefault("live", [])
    for p in plans:
        lid = p["ln"]["id"]
        paths = [out(p, i, 0) for i in range(len(p["chunks"]))]
        while not all(os.path.exists(x) for x in paths):
            if stop.is_set() or any(r["id"] == lid for r in job["results"]):  # finished already (the streamed first line)
                break
            time.sleep(0.2)
        else:
            raw, dst = os.path.join(jdir, f"{lid}.liveraw.wav"), os.path.join(jdir, f"{lid}.live.wav")
            try:
                _join_chunks(paths, raw, [c[2] for c in p["chunks"]], [c[1] for c in p["chunks"]])
                postprocess(raw, dst, job["post"])
                live.append({"id": lid, "duration": round(sf.info(dst).duration, 2)})
            except Exception as e:  # noqa: BLE001  the final assembly took a take first: that line plays when done
                log(f"job {job['id']} live preview of line {lid} skipped ({type(e).__name__}: {e})")
            finally:
                if os.path.exists(raw):
                    os.remove(raw)
            continue
        if stop.is_set():
            return


def _stream_line(job, jdir, p, out, ref_path, stop, done):
    """Step 5, next to the generation: as soon as every take of the first line is on disk, review it, master it and
    publish it (job results), so the dashboard plays it while the rest are still voiced. Only when Whisper is loaded or
    can wake beside the generation (nothing leaves the GPU for it) and only if the line passes the review; otherwise the normal path
    takes it, retries included. done gets the line's trials when it was published."""
    takes = job.get("takes", 1)
    entries = [(p, i, k, _take_params(p, k)) for i in range(len(p["chunks"])) for k in range(takes)]
    while not all(os.path.exists(out(p, i, k)) for p, i, k, _ in entries):
        if stop.is_set():
            return
        time.sleep(0.1)
    try:
        _publish_first(job, jdir, p, out, ref_path, entries, done, stop)
    except Exception:  # noqa: BLE001  the normal path voices it then
        traceback.print_exc()


def _publish_first(job, jdir, p, out, ref_path, entries, done, stop):
    takes = job.get("takes", 1)
    pick, trials = None, []
    if takes > 1 or job.get("review"):
        while "whisper" in ENG.preloading and not stop.is_set():  # step 4's preload is under way: worth the wait
            time.sleep(0.2)
        if not ENG.fits_now("whisper"):
            return
        if takes == 1:
            job["_no_mos"] = True  # as _review: naturalness only breaks ties between takes
        cands, base = {}, (job.get("profile") or {}).get("sim_base")
        gate = {**quality.REVIEW, **(job.get("review_gate") or {})}
        _score_takes(entries, _listen(job, [out(p, i, k) for p, i, k, _ in entries], ref_path, side=True), cands)
        chosen, texts, sims, moss = [], [], [], []
        for i in range(len(p["chunks"])):
            k, _ = _best_take(cands[(p["ln"]["id"], i)], base)
            v = cands[(p["ln"]["id"], i)][k]
            if quality.failed(v["text"], v["sim"], base, gate):
                return  # needs re-voicing: the normal review does that once the batch is done
            chosen.append(k)
            texts.append(v["text"] or 0)
            sims += [v["sim"]] if v["sim"] is not None else []
            moss += [v["mos"]] if v["mos"] is not None else []
            trials += [{"engine": p["engine"], "temperature": vv["temperature"], "text": vv["text"], "sim": vv["sim"],
                        "mos": vv["mos"], "picked": kk == k} for kk, vv in cands[(p["ln"]["id"], i)].items()]
        pick = {"take": chosen, "match": round(sum(texts) / len(texts), 3), "similarity": round(sum(sims) / len(sims), 3) if sims else None,
                "mos": round(sum(moss) / len(moss), 2) if moss else None, "review": {"retried": 0, "fixed": 0, "issues": []}}
    _assemble(job, jdir, p, [out(p, i, pick["take"][i] if pick else 0) for i in range(len(p["chunks"]))], pick, timed=False)
    done["trials"] = trials
    log(f"job {job['id']} streamed line {p['ln']['id']} after {time.time() - job['started']:.1f} s")


def _review(job, plans, out, ref_path, ref_text, order):
    """Listen to every sentence, keep the best take, and re-voice only the sentences that missed (a skipped, swapped
    or invented word, or a voice that drifted from the reference), up to REVIEW rounds, trying the voice's settings a
    little either side each time. Every attempt is reported as a trial so the dashboard can learn this voice's best
    settings. Returns per-line picks."""
    gate = {**quality.REVIEW, **(job.get("review_gate") or {})}
    base = (job.get("profile") or {}).get("sim_base")
    if job.get("takes", 1) == 1:  # naturalness only breaks ties between takes: with one take each it can't change a pick
        job["_no_mos"] = True
    cands = {}  # (line id, chunk) -> {take k: stats}
    by_key = {(p["ln"]["id"], i): p for p in plans for i in range(len(p["chunks"]))}

    def score_all(entries):
        job["stage"] = "choosing"
        _score_takes(entries, _listen(job, [out(p, i, k) for p, i, k, _ in entries], ref_path), cands)

    def best(key):
        return _best_take(cands[key], base)

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
    try:
        _save_pairs(job, plans, cands, best, out)
    except Exception:  # noqa: BLE001  training data is a bonus, never worth failing a voiceover over
        traceback.print_exc()
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


def make_storycard_job(body):
    """A post's video as an Instagram story the way the app shares one by hand: the whole video as a card with rounded
    corners and the account's @handle above it, on a blurred, darkened copy of itself, 1080x1920, up to 60 s. The
    dashboard (mcp/lib/publish/storycard.ts) sends the layout numbers' inputs, the header strip and where to put the
    result (a presigned PUT); style "fit" leaves out the card corners and the header."""
    url = _http_url(body.get("video_url"), "video_url")
    put = str(body.get("put_url") or "")
    if not url or not put.startswith("https://"):
        raise ValueError("video_url and put_url (https) are required")
    style = body.get("style") or "card"
    if style not in ("card", "fit"):
        raise ValueError("style must be card or fit")
    job = _base_job("storycard", body)
    job.update({"engine": "ffmpeg", "voice": "", "story": {"url": url, "put": put, "style": style,
                "header": _http_url(body.get("header_url"), "header_url") or None}})
    job["est_total"] = 40.0
    return _enqueue(job)


def make_fetch_job(body):
    """A link from Instagram, YouTube, TikTok, X, Facebook, Reddit, Vimeo or any page yt-dlp knows, downloaded for the
    dashboard's Download page (mcp/lib/downloads.ts): sites that refuse servers answer a Colab runtime. Each file goes
    straight to storage through its own presigned PUT (put_urls, in order, up to 20: a carousel is several), then a
    manifest of what each one is goes to info_put. cookies (Netscape format) is optional, for posts behind a login."""
    url = _http_url(body.get("url"), "url")
    puts = [str(u) for u in (body.get("put_urls") or []) if str(u).startswith("https://")][:20]
    info = str(body.get("info_put") or "")
    if not url or not puts or not info.startswith("https://"):
        raise ValueError("url, put_urls and info_put (https) are required")
    job = _base_job("fetch", body)
    job.update({"engine": "yt-dlp", "voice": "", "fetch": {"url": url, "puts": puts, "info": info, "cookies": str(body.get("cookies") or "")[:200_000]},
                "dl": {"pct": 0.0, "speed": None, "files": 0}, "notify": bool(body.get("notify"))})
    job["est_total"] = 45.0
    return _enqueue(job)


YTDLP_LOCK = threading.Lock()
YTDLP_FRESH = [False]  # sites change often: yt-dlp (+ curl_cffi for browser impersonation) and gallery-dl are brought
                       # up to date once per runtime, at boot (warm_downloaders), so the first link doesn't wait on pip


def warm_downloaders():
    with YTDLP_LOCK:
        if YTDLP_FRESH[0]:
            return
        t = time.time()
        r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "yt-dlp[default,curl-cffi]", "gallery-dl"], capture_output=True, timeout=300)
        if r.returncode:  # the extras can fail to build somewhere: the plain packages still work
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "yt-dlp", "gallery-dl"], capture_output=True, timeout=300)
        YTDLP_FRESH[0] = True
        log(f"downloaders ready in {time.time() - t:.0f} s")


def _ytdlp():
    if not YTDLP_FRESH[0]:
        try:
            warm_downloaders()
        except Exception as e:  # noqa: BLE001  whatever is installed still gets a go
            log(f"couldn't update the downloaders: {e}")
    import yt_dlp
    return yt_dlp


def _impersonate_target(yt_dlp):
    """Chrome's TLS fingerprint (curl_cffi) for sites that refuse plain Python clients; None when it isn't available."""
    try:
        import curl_cffi  # noqa: F401
        from yt_dlp.networking.impersonate import ImpersonateTarget
        return ImpersonateTarget.from_str("chrome")
    except Exception:  # noqa: BLE001
        return None


FETCH_TYPES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".m4a": "audio/mp4",
               ".mp3": "audio/mpeg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic"}
UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def _put_file(url, path, ctype):
    """One file to storage through its presigned PUT, streamed from disk; retried (a dropped connection, a 5xx)."""
    last = None
    for wait in (0, 2, 5, 10):
        time.sleep(wait)
        try:
            with open(path, "rb") as f:
                req = urllib.request.Request(url, data=f, method="PUT", headers={"Content-Type": ctype, "Content-Length": str(os.path.getsize(path))})
                with urllib.request.urlopen(req, timeout=1800) as r:
                    if r.status < 300:
                        return
                    last = RuntimeError(f"storage refused {os.path.basename(path)} ({r.status})")
        except urllib.error.HTTPError as e:
            last = RuntimeError(f"storage refused {os.path.basename(path)} ({e.code})")
            if e.code < 500 and e.code not in (408, 429):
                break
        except Exception as e:  # noqa: BLE001
            last = e
    raise last or RuntimeError("storage upload failed")


class _Uploader:
    """Each file goes up the moment it's finished (yt-dlp's post hook, after any merge), while the next one downloads:
    a carousel's photos stream out one by one instead of all at the end."""
    def __init__(self, job, puts):
        from concurrent.futures import ThreadPoolExecutor
        self.job, self.puts, self.pool, self.futs, self.seen = job, puts, ThreadPoolExecutor(max_workers=3), [], set()
        self.lock = threading.Lock()

    def add(self, path):
        path = os.path.abspath(path)
        ext = os.path.splitext(path)[1].lower()
        with self.lock:
            if path in self.seen or ext not in FETCH_TYPES or not os.path.exists(path) or len(self.futs) >= len(self.puts):
                return
            self.seen.add(path)
            # a carousel's items are named by their place in it ("03-…"): that place is their slot, so Files keeps
            # the post's order whatever order they finish in; anything else takes the next free slot
            taken = getattr(self, "taken", set())
            self.taken = taken
            m = re.match(r"(\d{2})-", os.path.basename(path))
            slot = int(m.group(1)) - 1 if m and 0 < int(m.group(1)) <= len(self.puts) and int(m.group(1)) - 1 not in taken else None
            if slot is None:
                slot = next(i for i in range(len(self.puts)) if i not in taken)
            taken.add(slot)
            self.futs.append(self.pool.submit(self._up, slot, path, FETCH_TYPES[ext]))

    def _up(self, slot, path, ctype):
        _put_file(self.puts[slot], path, ctype)
        self.job["dl"]["files"] += 1
        return {"slot": slot, "name": os.path.basename(path), "mime": ctype, "size": os.path.getsize(path)}

    def sweep(self, jdir):
        """What landed without the post hook (gallery-dl, a run that failed after writing). A video-only or audio-only
        half (name.f137.mp4) left by a failed merge only goes when there's nothing whole."""
        names = [f for f in sorted(os.listdir(jdir)) if not f.endswith((".part", ".ytdl", ".temp"))]
        whole = [f for f in names if not re.search(r"\.f\d+\.\w+$", f)]
        for f in whole if any(os.path.splitext(f)[1].lower() in FETCH_TYPES for f in whole) else names:
            self.add(os.path.join(jdir, f))

    def results(self):
        items = [f.result() for f in self.futs]  # an upload that failed raises here
        self.pool.shutdown(wait=True)
        return items


# Pacing, so the downloader never hammers a site: the same site at most once every few seconds (social sites, which
# rate-limit bursts, a little longer), with a little randomness, like a person opening links one after another.
SOCIAL = ("instagram.com", "youtube.com", "youtu.be", "tiktok.com", "facebook.com", "threads.net", "threads.com", "x.com", "twitter.com", "reddit.com")
HOST_LAST = {}
HOST_LOCK = threading.Lock()


def _social(url):
    h = (urlparse(url).hostname or "").lower()
    return any(h == d or h.endswith("." + d) for d in SOCIAL)


def _pace(url):
    import random
    h = (urlparse(url).hostname or "").lower().removeprefix("www.")
    gap = (4.0 if _social(url) else 1.0) + random.uniform(0, 1.5)
    with HOST_LOCK:
        wait = HOST_LAST.get(h, 0) + gap - time.time()
        HOST_LAST[h] = max(time.time(), HOST_LAST.get(h, 0) + gap)
    if wait > 0:
        time.sleep(wait)


def _best_error(errors):
    """Of everything that was tried, the error that says the most: a sign-in or bot check, then an HTTP code."""
    for pat in (r"sign in|log ?in|login|private|bot|age|country", r"HTTP Error \d{3}|\b\d{3}\b"):
        for e in errors:
            if re.search(pat, e, re.I):
                return e
    return errors[0] if errors else "nothing to download at that link"


VIDEO_IN_PAGE = re.compile(r"""https?:(?:\\?/){2}[^\s"'<>\\]+?\.(?:mp4|m3u8|webm|mov)(?:\?[^\s"'<>\\]*)?""", re.I)


def _videos_in_page(url, cookies_path=None):
    """The last resort for a page neither yt-dlp nor gallery-dl knows: every video link in its HTML (og:video,
    <video>/<source> src, JSON contentUrl, a bare .mp4 or .m3u8), best first."""
    req = urllib.request.Request(url, headers={"User-Agent": UA_CHROME, "Accept": "text/html,*/*"})
    with urllib.request.urlopen(req, timeout=25) as r:
        html = r.read(6_000_000).decode("utf-8", "replace")
    html = html.replace("\\u002F", "/").replace("\\/", "/").replace("&amp;", "&")
    found = []
    for m in re.finditer(r"""<(?:meta[^>]+(?:og:video(?::secure_url|:url)?|twitter:player:stream)[^>]+content|(?:video|source)[^>]+src)=["']([^"']+)""", html, re.I):
        found.append(urllib.parse.urljoin(url, m.group(1)))
    found += [m.group(0).replace("\\/", "/") for m in VIDEO_IN_PAGE.finditer(html)]
    out, seen = [], set()
    for u in found:
        if u.startswith("http") and u not in seen:
            seen.add(u)
            out.append(u)
    out.sort(key=lambda u: (".m3u8" in u.lower(), "preview" in u.lower() or "thumb" in u.lower()))  # mp4 first, previews last
    return out[:6]


def _image_size(path):
    """(width, height) of a photo, or None."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return im.size
    except Exception:  # noqa: BLE001
        return None


def run_fetch(job):
    ft, jdir = job["fetch"], os.path.join(JOBS_DIR, job["id"])
    os.makedirs(jdir, exist_ok=True)
    job["stage"] = "preparing"
    yt_dlp = _ytdlp()
    job["stage"] = "downloading"
    up = _Uploader(job, ft["puts"])

    def hook(d):
        if job["cancel"]:
            raise Cancelled()
        if d.get("status") == "downloading":
            tot = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if tot:
                job["dl"]["pct"] = round(min(0.98, d.get("downloaded_bytes", 0) / tot), 3)
            job["dl"]["speed"] = d.get("speed")
    cpath = None
    if ft.get("cookies"):
        cpath = os.path.join(jdir, "cookies.txt")
        with open(cpath, "w") as f:
            f.write(ft["cookies"])

    def opts_for(impersonate=None, referer=None):
        o = {"outtmpl": os.path.join(jdir, "%(autonumber)02d-%(id)s.%(ext)s"), "format": "bv*+ba/b",
             # h264 in an mp4 first: it plays everywhere and Instagram and YouTube take it back as it is
             "format_sort": ["res:1920", "vcodec:h264", "ext:mp4:m4a"], "merge_output_format": "mp4", "noplaylist": True,
             "playlistend": 20, "max_filesize": 1900 * 1024 * 1024, "quiet": True, "no_warnings": True, "progress_hooks": [hook],
             "post_hooks": [up.add],  # the final file (after the merge): it goes up while the next one downloads
             "restrictfilenames": True, "socket_timeout": 20, "retries": 5, "fragment_retries": 10, "extractor_retries": 2,
             # YouTube: fewer parallel connections (bursts are what it rate-limits); CDN fragments elsewhere take 8
             "concurrent_fragment_downloads": 4 if "youtu" in ft["url"] else 8, "http_chunk_size": 10 * 1024 * 1024, "noprogress": True,
             # YouTube: when the default client is refused (the bot check), the others often aren't
             "extractor_args": {"youtube": {"player_client": ["default", "mweb", "web_safari"]}}}
        if _social(ft["url"]):  # a short pause between a site's requests, and between a carousel's items
            o.update({"sleep_interval_requests": 0.75, "sleep_interval": 1, "max_sleep_interval": 3})
        if cpath:
            o["cookiefile"] = cpath
        if impersonate is not None:
            o["impersonate"] = impersonate
        if referer:
            o["http_headers"] = {"Referer": referer, "User-Agent": UA_CHROME}
        return o

    def ytdlp(url, **kw):
        with yt_dlp.YoutubeDL(opts_for(**kw)) as y:
            return y.extract_info(url, download=True) or {}

    def photo(entry, i):
        """A carousel's photo (or a photo post) at full size, saved as item i. The sizes a post lists come smallest
        first and don't always say how big they are: each is ranked by its width x height, else the size in its
        address (Instagram's s150x150 / p1080x1080), else its place in the list (later = bigger). The saved photo's
        real size is checked: a preview (under 600 px) tries the next sizes, and if nothing bigger exists it says so."""
        th = [dict(t) for t in (entry.get("thumbnails") or []) if t.get("url")]
        for k in ("display_url", "thumbnail", "url"):
            u = entry.get(k)
            if isinstance(u, str) and u.startswith("http") and not any(t["url"] == u for t in th) and (k != "url" or not entry.get("formats")):
                th.append({"url": u})
        if not th:
            return False

        def area(t, n):
            w, h = t.get("width"), t.get("height")
            try:
                if w and h:
                    return int(w) * int(h)
            except (TypeError, ValueError):
                pass
            m = re.search(r"[_/.-][sp](\d{2,4})x(\d{2,4})(?:[_/.&?-]|$)", t["url"])
            return int(m.group(1)) * int(m.group(2)) if m else None
        # a crop (Instagram's square grid version: c<x>.<y>.<w>.<h> in its address) only after every uncropped size: the
        # photo as it was posted, whole, is what's wanted
        cropped = lambda t: bool(re.search(r"[=_/]c\d+(?:\.\d+){3}", t["url"]))  # noqa: E731
        ranked = sorted(enumerate(th), key=lambda it: (not cropped(it[1]), area(it[1], it[0]) or 0, area(it[1], it[0]) is None, it[0]), reverse=True)
        ranked = [t for _, t in ranked]
        base = os.path.join(jdir, f"{i:02d}-{re.sub(r'[^A-Za-z0-9_-]', '', str(entry.get('id') or 'photo'))[:40] or 'photo'}")
        best = None  # (final path, temp path, (w, h) or None, the size it came from)
        for n, t in enumerate(ranked[:6]):
            ext = os.path.splitext(urlparse(t["url"]).path)[1].lower()
            path = base + (ext if ext in (".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif") else ".jpg")
            tmp = f"{path}.{n}.part"  # each size to its own file: the bigger one wins
            try:
                req = urllib.request.Request(t["url"], headers={"User-Agent": UA_CHROME, "Referer": ft["url"]})
                with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
                    shutil.copyfileobj(r, f)
            except Exception as e:  # noqa: BLE001  the next size
                errors.append(f"photo {i}: {e}"[:200])
                continue
            size = _image_size(tmp)
            # the bigger real picture wins: the whole 1080x1350 holds more than its 1080x1080 crop
            if best is None or (size and (not best[2] or size[0] * size[1] > best[2][0] * best[2][1])):
                if best:
                    os.remove(best[1])
                best = (path, tmp, size, t)
            else:
                os.remove(tmp)
            if size and min(size) >= 600 and not cropped(t):
                break
        if not best:
            return False
        os.replace(best[1], best[0])
        if cropped(best[3]):
            job.setdefault("warnings", []).append(f"photo {i} is the square grid crop: the full photo wasn't offered to a signed-out downloader")
        if best[2] and min(best[2]) < 600:
            job.setdefault("warnings", []).append(f"photo {i} only came at {best[2][0]}x{best[2][1]}: the site gave a signed-out downloader nothing bigger")
        up.add(best[0])
        return True

    def whole(url, **kw):
        """Everything the post has, in its order: read it once, then each video through yt-dlp and each photo from the
        post's own image list (yt-dlp alone stops at a carousel's first photo, which has no video to download)."""
        probe = {**opts_for(**kw), "ignore_no_formats_error": True}
        with yt_dlp.YoutubeDL(probe) as y:
            raw = y.extract_info(url, download=False, process=False) or {}
        top = {k: raw[k] for k in ("extractor", "extractor_key", "webpage_url", "webpage_url_basename", "webpage_url_domain", "original_url") if k in raw}
        entries = raw.get("entries")
        if raw.get("_type") in ("playlist", "multi_video") and entries is not None:
            import itertools
            for i, e in enumerate(itertools.islice(entries, len(ft["puts"])), 1):
                if job["cancel"]:
                    raise Cancelled()
                if not e:
                    continue
                if e.get("formats") or e.get("_type") in ("url", "url_transparent"):
                    try:
                        with yt_dlp.YoutubeDL({**opts_for(**kw), "outtmpl": os.path.join(jdir, f"{i:02d}-%(id)s.%(ext)s")}) as y:
                            y.process_ie_result({**top, **e}, download=True)
                        continue
                    except Cancelled:
                        raise
                    except Exception as err:  # noqa: BLE001  its cover photo, rather than nothing
                        errors.append(re.sub(r"\x1b\[[0-9;]*m", "", str(err)).replace("ERROR: ", "")[:300])
                try:  # one photo that won't come never stops the rest of the carousel
                    photo(e, i)
                except Exception as err:  # noqa: BLE001
                    errors.append(f"photo {i}: {err}"[:200])
            return raw
        if raw.get("formats") or raw.get("_type") in ("url", "url_transparent"):
            with yt_dlp.YoutubeDL(opts_for(**kw)) as y:  # what was read already: no second visit to the site
                return y.process_ie_result(raw, download=True) or raw
        photo(raw, 1)  # a photo post
        return raw

    def have():
        up.sweep(jdir)
        return bool(up.futs)

    info, errors = {}, []
    _pace(ft["url"])
    target = _impersonate_target(yt_dlp)
    # 1) yt-dlp, 2) the same as Chrome (sites that refuse plain clients), 3) gallery-dl (photo posts),
    # 4) every video link in the page itself. The first that gets a file wins.
    attempts = [lambda: whole(ft["url"])] + ([lambda: whole(ft["url"], impersonate=target)] if target is not None else [])
    for attempt in attempts:
        try:
            info = attempt() or info
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001
            errors.append(re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("ERROR: ", "")[:300])
        if have():
            break
    if not have():
        job["stage"] = "downloading photos"
        cmd = [sys.executable, "-m", "gallery_dl", "-D", jdir, "--range", "1-20"] + (["--cookies", cpath] if cpath else [])
        try:
            r = subprocess.run(cmd + [ft["url"]], capture_output=True, text=True, timeout=240)
            if r.returncode and r.stderr.strip():
                errors.append(r.stderr.strip().splitlines()[-1][:300])
        except subprocess.TimeoutExpired:
            errors.append("the site didn't answer in time")
    if not have():
        job["stage"] = "downloading"
        try:
            for v in _videos_in_page(ft["url"]):
                try:
                    ytdlp(v, referer=ft["url"])
                except Exception as e:  # noqa: BLE001
                    errors.append(str(e)[:200])
                if have():
                    break
        except Exception as e:  # noqa: BLE001
            errors.append(f"the page: {e}"[:200])
    if not have():
        raise RuntimeError(_best_error(errors)[:300])
    job["stage"] = "uploading"
    job["dl"]["pct"] = 0.99
    items = sorted(up.results(), key=lambda x: x["slot"])
    first = (info.get("entries") or [info])[0] or {} if isinstance(info.get("entries"), list) else info
    meta = {"title": info.get("title") or first.get("title"), "uploader": info.get("uploader") or first.get("uploader") or info.get("channel"),
            "handle": info.get("uploader_id") or first.get("uploader_id") or info.get("channel_id"), "description": (info.get("description") or first.get("description") or "")[:2000],
            "webpage_url": info.get("webpage_url") or ft["url"], "thumbnail": info.get("thumbnail") or first.get("thumbnail"),
            "duration": info.get("duration") or first.get("duration"), "extractor": info.get("extractor_key"), "items": items,
            "warnings": job.get("warnings") or []}
    mpath = os.path.join(jdir, "info.json")
    with open(mpath, "w") as f:
        json.dump(meta, f)
    _put_file(ft["info"], mpath, "application/json")
    job["dl"]["pct"] = 1.0
    log(f"job {job['id']} downloaded {len(items)} file(s) from {urlparse(ft['url']).netloc}")


def run_storycard(job):
    st, jdir = job["story"], os.path.join(JOBS_DIR, job["id"])
    os.makedirs(jdir, exist_ok=True)
    job["stage"] = "downloading"
    src, out = os.path.join(jdir, "in.mp4"), os.path.join(jdir, "story.mp4")
    _download(st["url"], src)
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation",
                            "-of", "json", src], capture_output=True, text=True, check=True)
    info = json.loads(probe.stdout)["streams"][0]
    w, h = int(info["width"]), int(info["height"])
    if any(abs(int(float(d.get("rotation", 0)))) == 90 for d in info.get("side_data_list", []) or []):
        w, h = h, w
    W, H, CW, CH, HEAD, GAP, R = 1080, 1920, 920, 1300, 76, 22, 34
    card = st["style"] == "card"
    sc = min((CW if card else W) / w, (CH if card else H) / h)
    cw, ch = int(round(w * sc / 2) * 2), int(round(h * sc / 2) * 2)
    top = (H - (HEAD + GAP + ch if card else ch)) // 2
    x, y = (W - cw) // 2, top + (HEAD + GAP if card else 0)
    inputs, fc = ["-i", src], [f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},gblur=sigma=40,eq=brightness=-0.22,setsar=1[bg]",
                                f"[0:v]scale={cw}:{ch},setsar=1,format=rgba[fg0]"]
    fg = "fg0"
    if card:
        try:  # rounded corners: a mask the size of the card
            from PIL import Image, ImageDraw
            mask = Image.new("L", (cw, ch), 0)
            ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=R, fill=255)
            mpath = os.path.join(jdir, "mask.png")
            mask.save(mpath)
            inputs += ["-loop", "1", "-i", mpath]
            fc.append(f"[{inputs.count('-i') - 1}:v]format=gray[m];[fg0][m]alphamerge[fg1]")
            fg = "fg1"
        except Exception:  # noqa: BLE001 - square corners rather than no story
            pass
    fc.append(f"[bg][{fg}]overlay={x}:{y}:shortest=1[v1]")
    last = "v1"
    if card and st.get("header"):
        hpath = os.path.join(jdir, "header.png")
        _download(st["header"], hpath, limit=5 * 1024 * 1024)
        inputs += ["-loop", "1", "-i", hpath]
        fc.append(f"[v1][{inputs.count('-i') - 1}:v]overlay={x}:{top}:shortest=1[v2]")
        last = "v2"
    fc.append(f"[{last}]format=yuv420p[out]")
    job["stage"] = "rendering"
    subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(fc), "-map", "[out]", "-map", "0:a?",
                    "-t", "60", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
                    "-movflags", "+faststart", out], check=True)
    job["stage"] = "uploading"
    with open(out, "rb") as f:
        req = urllib.request.Request(st["put"], data=f, method="PUT", headers={"Content-Type": "video/mp4", "Content-Length": str(os.path.getsize(out))})
        with urllib.request.urlopen(req, timeout=600) as r:
            if r.status >= 300:
                raise RuntimeError(f"storage refused the story ({r.status})")
    job["results"] = [{"id": "story", "text": "", "duration": 0}]


def _download(url, path, limit=600 * 1024 * 1024):
    if not _http_url(url, "url"):  # every caller passes a link from a request: never file:// or ftp:// (local files)
        raise ValueError("url is missing")
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
    prep_pool, cut_pool = ThreadPoolExecutor(1), ThreadPoolExecutor(max(1, min(12, (os.cpu_count() or 2) - 1)))
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
    if body.get("method") == "dpo":
        return make_dpo_job(body)
    parts = [{"url": _http_url(p.get("url"), f"part {i + 1} url")} for i, p in enumerate(body.get("parts") or [])][:200]
    if not parts:
        raise ValueError("parts: the dataset has no recordings yet (Your model: collect first)")
    minutes = float(body.get("minutes") or 0)
    job = _base_job("train", body)
    ft = "qwen" if body.get("engine") == "qwen" else "orpheus"  # which model learns the voice
    job.update({"voice": str(body.get("name") or "me")[:64], "lines": [], "engine": "qwen" if ft == "qwen" else "myvoice", "parts": parts,
                "speaker": "me", "epochs": body.get("epochs"), "learning_rate": body.get("learning_rate"), "train_engine": ft,
                "resume": _resume_links(body.get("resume"))})
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


def _resume_links(r):
    """Signed links for the training checkpoint (resume.py): get, put and state, each https or left out."""
    r = r if isinstance(r, dict) else {}
    return {k: r[k] for k in ("get", "put", "state") if isinstance(r.get(k), str) and r[k].startswith("https://")}


def _train_over(job, ok):
    """The run is over for good (finished, cancelled or failed in the trainer): the dashboard stops restarting it."""
    if job.get("resume"):
        from resume import mark
        threading.Thread(target=mark, args=({"resume": job["resume"]}, "done" if ok else "failed"), daemon=True).start()


def make_dpo_job(body):
    """RLHF polish of a trained Orpheus voice (train_dpo.py): adapter {job, url} (the model in use), pairs_url (the
    preference pairs the dashboard built from reviewed takes and ratings), pairs (how many), minutes (what the model was
    trained on: a polish adds no recordings)."""
    a = body.get("adapter") or {}
    job = _base_job("train", body)
    job.update({"voice": str(body.get("name") or "me")[:64], "lines": [], "engine": "myvoice", "train_engine": "orpheus", "method": "dpo",
                "adapter": {"job": str(a.get("job") or ""), "url": _http_url(a.get("url"), "adapter url")},
                "pairs_url": _http_url(body.get("pairs_url"), "pairs_url"), "n_pairs": int(body.get("pairs") or 0),
                "minutes": float(body.get("minutes") or 0), "speaker": str(body.get("speaker") or "me")[:64],
                "epochs": body.get("epochs"), "learning_rate": body.get("learning_rate")})
    if not ID_RE.match(job["voice"]) or not ID_RE.match(job["adapter"]["job"]):
        raise ValueError("name and adapter.job: letters, digits, - or _")
    # ~0.6 s a pair (two forward passes + one backward) on an A100, 2 epochs, plus loading and a test line
    job["est_total"] = 240 + job["n_pairs"] * 2 * 0.6 * int(job["epochs"] or 2) + (0 if os.path.exists(_train_python()) else C.TRAIN_INSTALL_S)
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
               "work": os.path.join(jdir, "work"), "out": jdir, "progress": prog, "resume": job.get("resume")}, open(cfg, "w"))
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
                _train_over(job, False)
                raise Cancelled()
            time.sleep(2)
    shutil.rmtree(os.path.join(jdir, "work"), ignore_errors=True)
    _train_over(job, p.returncode == 0)
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


EAGLE_DIR = os.path.join(HOME, "eagle")  # trained draft heads (<job>/) and current.json: the one the Orpheus engine uses


def make_eagle_job(body):
    """Train an EAGLE draft head for Orpheus (train_eagle.py, step 5b): sentences to voice for its data (default 6000),
    epochs (default 2), ks: how many guesses a step to benchmark (default 2, 3, 4). The whole GPU, like training a voice."""
    job = _base_job("eagle", body)
    n = int(body.get("sentences") or 6000)
    ks = [int(k) for k in (body.get("ks") or [2, 3, 4]) if 1 <= int(k) <= 8][:4]
    job.update({"voice": "", "lines": [], "engine": "orpheus", "sentences": max(500, min(30000, n)),
                "epochs": max(1, min(5, int(body.get("epochs") or 2))), "ks": ks or [3]})
    # L4: ~1500 codec tokens/s voicing, ~2 s a training step of 12k tokens, ~70 s per benchmark load; ~350 tokens a sentence
    toks = job["sentences"] * 350
    job["est_total"] = 120 + toks / 1500 + toks / 12000 * job["epochs"] * 2.0 + 90 * (1 + len(job["ks"]))
    return _enqueue(job)


def _stage_tail(name, n=15):
    try:
        return "".join(open(os.path.join(LOGS_DIR, f"eagle-{name}.log"), errors="replace").readlines()[-n:]).strip()
    except OSError:
        return ""


def run_eagle(job):
    """Voice data, train the head, then benchmark Orpheus on vLLM plain and with the head (each k). The head becomes
    the engine's (EAGLE_DIR/current.json) only if it made one request at least 10% faster and lost no more than 5% on
    ten lines together; otherwise it's kept on disk and reported, and the engine stays as it was."""
    jdir = os.path.join(JOBS_DIR, job["id"])
    out = os.path.join(jdir, "eagle")
    os.makedirs(out, exist_ok=True)
    prog = os.path.join(jdir, "progress.json")
    job["progress_file"] = prog
    t0 = time.time()
    job["cur"] = {"t0": t0, "est": job["est_total"], "label": ""}
    for name in list(ENG.procs):
        log(f"stopping {name}: training the Orpheus draft needs the whole GPU")
        ENG.stop(name)
    job["stage"] = "installing"
    py = ENG._install("orpheus")
    if ENG.state.get("orpheus") == "installing":
        ENG._set("orpheus", "idle")
    if subprocess.run([py, "-c", "import pyarrow"], capture_output=True).returncode:
        with open(os.path.join(LOGS_DIR, "eagle-install.log"), "a") as logf:
            subprocess.run(f"uv pip install --python {py} -q pyarrow", shell=True, check=True, stdout=logf, stderr=logf)
    env = {**os.environ, "HF_HOME": cache_dir("orpheus"), "TOKENIZERS_PARALLELISM": "false", "VLLM_USE_FLASHINFER_SAMPLER": "0",
           "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True", "MPLBACKEND": "Agg"}
    head = os.path.join(out, "head")
    stages = [("gen", None), ("train", None), ("bench", None)] + [("bench", {"model": head, "k": k}) for k in job["ks"]]
    if ENG.budget > 0 and shutil.disk_usage(HOME).free / 1e9 < 20:
        raise RuntimeError("not enough disk for the draft's data and model (needs ~20 GB free)")
    bench_errors = {}
    for i, (stage, spec) in enumerate(stages):
        if stage == "gen" and os.path.exists(os.path.join(out, "gen.json")):
            continue  # a re-run of the same job keeps its data
        cfg = os.path.join(out, f"{stage}-{i}.json")
        json.dump({"out": out, "progress": prog, "sentences": job["sentences"], "epochs": job["epochs"], "spec": spec}, open(cfg, "w"))
        job["stage"] = {"gen": "generating", "train": "training", "bench": "testing"}[stage]
        name = stage if stage != "bench" else ("bench-plain" if not spec else f"bench-k{spec['k']}")
        with open(os.path.join(LOGS_DIR, f"eagle-{name}.log"), "w") as logf:
            p = subprocess.Popen([py, os.path.join(HERE, "train_eagle.py"), stage, cfg], stdout=logf, stderr=logf, env=env, cwd=HERE,
                                 start_new_session=True)
            while p.poll() is None:
                if job["cancel"]:
                    import signal
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait()
                    raise Cancelled()
                time.sleep(2)
        if p.returncode:
            if spec:  # the head wouldn't load or run in this vLLM: report it, the other runs still count
                bench_errors[f"k{spec['k']}"] = _stage_tail(name, 6)
                continue
            raise RuntimeError(f"{name} stopped (exit {p.returncode}): {_stage_tail(name)}")
    rd = lambda f: json.load(open(os.path.join(out, f))) if os.path.exists(os.path.join(out, f)) else None  # noqa: E731
    plain = rd("bench-plain.json")
    runs = [r for r in (rd(f"bench-eagle-k{k}.json") for k in job["ks"]) if r]
    best = max(runs, key=lambda r: r["lone_tokens_per_s"], default=None)
    adopt = bool(best and plain and best["lone_tokens_per_s"] >= 1.1 * plain["lone_tokens_per_s"]
                 and best["ten"]["tokens_per_s"] >= 0.95 * plain["ten"]["tokens_per_s"])
    keep = os.path.join(EAGLE_DIR, job["id"])
    shutil.rmtree(keep, ignore_errors=True)
    if os.path.isdir(head):
        shutil.copytree(head, keep)
        with zipfile.ZipFile(os.path.join(jdir, "eagle.zip"), "w", zipfile.ZIP_STORED) as z:  # for the dashboard to keep
            for f in os.listdir(keep):
                z.write(os.path.join(keep, f), f)
        shutil.rmtree(head, ignore_errors=True)  # ~1.2 GB: the kept copy and the zip are enough
    k = int(best["name"].rsplit("k", 1)[1]) if best else None
    if adopt:
        json.dump({"job": job["id"], "path": keep, "k": k, "at": time.time()}, open(os.path.join(EAGLE_DIR, "current.json"), "w"))
    job["eagle"] = {"gen": rd("gen.json"), "train": rd("train.json"), "plain": plain, "eagle": runs, "best_k": k, "adopted": adopt,
                    "errors": bench_errors or None}
    if bench_errors and not runs:
        job.setdefault("warnings", []).append("vLLM couldn't run the draft: " + next(iter(bench_errors.values()))[-400:])
    job["cur"], job["est_done"] = None, time.time() - t0
    job["est_total"] = job["est_done"]
    log(f"job {job['id']} EAGLE draft: best k {k}, adopted {adopt}")


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
    dpo = job.get("method") == "dpo"
    if dpo:
        json.dump({"adapter_url": job["adapter"]["url"], "pairs_url": job["pairs_url"], "speaker": job["speaker"], "minutes": job["minutes"],
                   "epochs": job.get("epochs"), "learning_rate": job.get("learning_rate"), "work": os.path.join(jdir, "work"), "out": jdir,
                   "progress": prog}, open(cfg, "w"))
    else:
        json.dump({"parts": job["parts"], "speaker": job["speaker"], "epochs": job.get("epochs"), "learning_rate": job.get("learning_rate"),
                   "work": os.path.join(jdir, "work"), "out": jdir, "progress": prog,
                   "cache": os.path.join(C.MYVOICE_DIR, "codes"), "resume": job.get("resume")}, open(cfg, "w"))
    job["stage"] = "training"
    env = {**os.environ, "HF_HOME": cache_dir("myvoice"), "TOKENIZERS_PARALLELISM": "false", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
           "MPLBACKEND": "Agg"}
    with open(os.path.join(LOGS_DIR, "train.log"), "a") as logf:
        p = subprocess.Popen([py, os.path.join(HERE, "train_dpo.py" if dpo else "train.py"), cfg], stdout=logf, stderr=logf, env=env, cwd=HERE, start_new_session=True)
        while p.poll() is None:
            if job["cancel"]:
                import signal
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
                _train_over(job, False)
                raise Cancelled()
            time.sleep(2)
    shutil.rmtree(os.path.join(jdir, "work"), ignore_errors=True)
    _train_over(job, p.returncode == 0)
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
    run_selfcheck("after training")
    job["cur"], job["est_done"] = None, time.time() - t0
    job["est_total"] = job["est_done"]
    log(f"job {job['id']} trained your voice: {job['train']}")


def package(job):
    job["stage"] = "packaging"
    if job["kind"] in ("video", "reference", "image", "dataset", "train", "voicewalk", "eagle", "storycard", "fetch"):
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


def worker_loop(q=None):
    q = QUEUE if q is None else q
    while True:
        with QCOND:
            while not q:
                QCOND.wait()
            jid = q.pop(0)
        job = JOBS.get(jid)
        if not job or job["cancel"]:
            continue
        job["status"], job["started"] = "running", time.time()
        LAST_ACTIVE[0] = time.time()
        try:
            {"transcribe": run_transcribe, "video": run_video, "reference": run_reference,
             "image": run_image, "dataset": run_dataset, "train": run_train, "voicewalk": run_voicewalk,
             "eagle": run_eagle, "storycard": run_storycard, "fetch": run_fetch}.get(job["kind"], run_tts)(job)
            package(job)
            job["status"], job["stage"] = "done", "done"
        except Cancelled:
            job["status"], job["stage"] = "cancelled", "cancelled"
        except Exception as e:
            traceback.print_exc()
            job["status"], job["stage"], job["error"] = "error", "error", str(e)
        job["finished"] = time.time()
        LAST_ACTIVE[0] = time.time()
        if job.get("notify"):
            threading.Thread(target=_notify_done, args=(job,), daemon=True).start()


def _notify_done(job):
    """Tell the dashboard a download finished (or failed) so it saves it now, not at the next look or heartbeat. Only
    ever to REGISTER_URL's own origin: the secret never goes anywhere a job body names."""
    base = os.environ.get("REGISTER_URL", "").rsplit("/api/", 1)[0]
    if not base.startswith("https://"):
        return
    body = json.dumps({"job": job["id"], "status": job["status"]}).encode()
    for wait in (0, 2, 5):
        time.sleep(wait)
        try:
            req = urllib.request.Request(base + "/api/downloads/done", data=body, method="POST",
                                         headers={"Authorization": f"Bearer {SECRET}", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30):
                return
        except Exception as e:  # noqa: BLE001  the heartbeat picks it up within a minute anyway
            log(f"download callback for {job['id']} failed: {e}")


def _progress(job):
    """(fraction, eta_seconds, stage, stage_detail) from the live speed model; honest, never stuck at 100%."""
    now = time.time()
    stage = job["stage"]
    if job["status"] == "done":
        return 1.0, 0, "done", ""
    if job["status"] in ("error", "cancelled"):
        return min(1.0, job["est_done"] / max(job["est_total"], 1e-6)), 0, job["status"], ""
    if job["status"] == "queued":
        q = _queue_of(job)
        ahead = [JOBS[j] for j in q[:q.index(job["id"])]] if job["id"] in q else []
        wait = sum(max(0, j["est_total"] - j["est_done"]) for j in ahead)
        for r in (JOBS[x] for x in JOBS if JOBS[x]["status"] == "running" and JOBS[x].get("lane") == job.get("lane")):
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
    if job["kind"] == "eagle" and job["status"] == "running":
        el = now - job["cur"]["t0"] if job.get("cur") else 0
        try:
            pf = json.load(open(job["progress_file"]))
        except Exception:
            pf = {"phase": "starting", "step": 0, "total": 0}
        ph, step, tot = pf.get("phase"), pf.get("step", 0), max(1, pf.get("total") or 1)
        frac = {"generating": 0.05 + 0.40 * step / tot, "training": 0.45 + 0.40 * step / tot, "testing": 0.88,
                "saving": 0.86}.get(ph, 0.03)
        return frac, round(max(20, job["est_total"] - el)), job.get("stage") or ph, pf.get("detail") or ""
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
                                 "platform", "captions", "takes", "mode", "similarity", "scenes", "review", "trials", "profile", "cleanup", "decode",
                                 "dataset", "benchmark", "train", "kvoice", "walk", "auto_train", "train_engine", "timings", "pairs", "method", "lane", "review_batch", "stream",
                                 "eagle", "polish_engine", "polish", "dl")}
    v["resources"] = job_resources(job)
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
        v["queue_position"] = _queue_of(job).index(job["id"]) + 1 if job["id"] in _queue_of(job) else 0
    if job.get("live") and urls:  # listen live: lines made but not finished yet (_live_preview)
        done = {r["id"] for r in job["results"]}
        v["live"] = [{**x, "url": sign(f"/files/{job['id']}/{x['id']}.live.wav")} for x in list(job["live"]) if x["id"] not in done]
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
    if urls and job["status"] == "done" and job["kind"] not in ("video", "reference", "dataset", "train", "voicewalk", "eagle"):
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


def lanes():
    """What each lane is doing: the GPU lane (one job at a time), the CPU lane beside it, and the downloads."""
    out = {}
    for name, q in (("gpu", QUEUE), ("cpu", CPU_QUEUE), ("fetch", FETCH_QUEUE)):
        run = [j for j in list(JOBS.values()) if j["status"] == "running" and j.get("lane", "gpu") == name]
        out[name] = {"running": [{"id": j["id"], "label": j.get("label"), "stage": j.get("stage"), "engine": j.get("engine")} for j in run], "queued": len(q)}
    return out


BOOT_PREFETCH = {}  # step 6: how long this gateway's prefetch took


def boot_info():
    """Step 6: when each phase of the worker's start finished, in seconds after the launcher started (launcher.py),
    and how long the gateway's prefetch of the voice engines took."""
    try:
        b = json.load(open(os.path.join(HOME, "boot.json")))
    except (OSError, ValueError):
        b = {}
    return {**b, "prefetch": {"engines": C.PREFETCH, **BOOT_PREFETCH}, "r2": r2cache.EVENTS} if (b or C.PREFETCH) else None


def health():
    return {"ok": True, "version": C.VERSION, "uptime_s": int(time.time() - STARTED), "gpu": gpu_info(), "boot": boot_info(),
            "ram": mem_info(), "disk": disk_info(), "mode": ENG.mode, "idle_unload_s": ENG.idle_left(), "idle_min": C.IDLE_MIN, "fetch": ENG.fetch,
            "vram_budget_gb": round(ENG.budget, 1), "engines": ENG.state, "engine_errors": ENG.errors,
            "loaded": list(ENG.procs), "queue": len(QUEUE) + len(CPU_QUEUE) + len(FETCH_QUEUE), "rates": RATES, "lanes": lanes(),
            "cpu": {"cores": MON.cores, "load": os.getloadavg()[0] if hasattr(os, "getloadavg") else None}, "now": MON.latest(),
            "warm": WARM.view(), "loads": ENG.loads, "parked": {n: round(time.time() - t) for n, t in ENG.parked.items()},
            "running": [j["id"] for j in JOBS.values() if j["status"] == "running"], "public_url": public_url(),
            "selfcheck": _selfcheck_result(), "last_active": LAST_ACTIVE[0], "fetch_only": FETCH_ONLY}


LAST_ACTIVE = [time.time()]  # when a job last started or finished: the dashboard stops an idle runtime the app started


SELFCHECK = os.path.join(HOME, "selfcheck.json")


def _selfcheck_result():
    try:
        return json.load(open(SELFCHECK))
    except (OSError, ValueError):
        return None


def run_selfcheck(why, delay=0):
    """The quick self-check (selfcheck.py --quick: Kokoro + the clean-up) in the background, results in /health.
    Runs after every start and after training (which stopped every engine)."""
    def go():
        time.sleep(delay)
        while any(j["status"] in ("queued", "running") for j in JOBS.values()):
            time.sleep(30)  # never compete with real work
        port = int(os.environ.get("VOICEBOX_PORT", "8000"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "selfcheck.py"), "--base", f"http://127.0.0.1:{port}", "--secret", SECRET,
                            "--quick", "--json", SELFCHECK + ".tmp"], capture_output=True, text=True, timeout=1800)
        try:
            res = json.load(open(SELFCHECK + ".tmp"))
        except (OSError, ValueError):
            res = {"ok": False, "steps": [], "output": (r.stdout + r.stderr)[-2000:]}
        res.update({"why": why, "at": time.time(), "version": C.VERSION})
        json.dump(res, open(SELFCHECK, "w"))
        log(f"self-check ({why}): {'ALL PASS' if res.get('ok') else 'FAILED'}")
    threading.Thread(target=go, daemon=True).start()


def self_update(url):
    """Fetch the newest worker code (the dashboard's /api/bundle) over this one and restart the gateway: the launcher
    starts it again within a minute, with the new code. Engines are stopped first so the GPU starts clean."""
    import io, tarfile
    if any(j["status"] in ("queued", "running") for j in JOBS.values()):
        raise ValueError("a job is running: update when the queue is empty")
    url = url or (os.environ.get("REGISTER_URL", "").rsplit("/api/", 1)[0] + "/api/bundle")
    if not url.startswith("https://"):
        raise ValueError("no bundle url: pass url (https://<dashboard>/api/bundle)")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {SECRET}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data, version = r.read(), r.headers.get("X-Worker-Version")
    tar = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    try:
        tar.extractall(HERE, filter="data")
    except TypeError:  # Python < 3.12 without extraction filters
        tar.extractall(HERE)
    # the bundle's files all carry mtime 0, and Python trusts cached bytecode whose (mtime, size) match: an edit that
    # keeps a module's size (a flag "1" -> "0", a version string) would run the old code. Drop the caches.
    for root, dirs, _ in os.walk(HERE):
        if "__pycache__" in dirs:
            shutil.rmtree(os.path.join(root, "__pycache__"), ignore_errors=True)
            dirs.remove("__pycache__")

    def restart():
        time.sleep(1.5)
        for name in list(ENG.procs):
            ENG.stop(name)
        log(f"updated to {version}: restarting")
        os._exit(0)
    threading.Thread(target=restart, daemon=True).start()
    return {"ok": True, "version": version, "restarting": True}


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
        if u.path == "/metrics":  # the last 10 minutes of CPU / RAM / GPU samples, for the Health page's charts
            return self._json(200, {"every_s": MON.every, "cores": MON.cores, "ram_total_gb": (_meminfo() or {}).get("total"),
                                    "vram_total_gb": gpu_info_cached()["total_gb"], "samples": list(MON.samples)})
        if u.path == "/voices":
            return self._json(200, catalogue())
        if u.path == "/jobs":
            return self._json(200, {"jobs": [job_view(j, urls=False) for j in reversed(JOBS.values())][:30]})
        m = re.match(r"^/logs/([a-z0-9-]+)$", u.path)
        if m and (m.group(1) in C.ENGINES or m.group(1) in ("gateway", "tunnel", "train", "eagle-gen", "eagle-train", "eagle-install")):
            names = [f"{m.group(1)}.log", f"{m.group(1)}-install.log"]
            n = parse_qs(u.query).get("n", ["120"])[0]
            n = min(400, int(n)) if n.isdigit() else 120
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
            if u.path == "/admin/update":
                return self._json(200, self_update(str(body.get("url") or "")))
            if u.path == "/admin/restart":
                if any(j["status"] in ("queued", "running") for j in JOBS.values()) and not body.get("force"):
                    raise ValueError("a job is running: restart when the queue is empty")

                def restart():
                    time.sleep(1.5)
                    for name in list(ENG.procs):
                        ENG.stop(name)
                    log("restart asked: restarting")
                    os._exit(0)
                threading.Thread(target=restart, daemon=True).start()
                return self._json(200, {"ok": True, "restarting": True})
            if u.path == "/selfcheck":
                run_selfcheck("asked")
                return self._json(202, {"ok": True})
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
                    if m.group(1) in _queue_of(JOBS[m.group(1)]):
                        _queue_of(JOBS[m.group(1)]).remove(m.group(1))
                        JOBS[m.group(1)]["status"] = "cancelled"
                return self._json(200, job_view(JOBS[m.group(1)]))
            if u.path == "/refs":
                if body.get("audio_b64"):
                    data = base64.b64decode(body["audio_b64"])
                elif body.get("url"):
                    with urllib.request.urlopen(_http_url(body["url"], "url"), timeout=60) as r:  # never file:// or ftp://
                        data = r.read(50 * 1024 * 1024)
                else:
                    raise ValueError("send audio_b64 or url")
                return self._json(201, add_ref(body.get("name", ""), data, body.get("transcript")))
            m = re.match(r"^/engines/([a-z0-9]+)/(load|unload|forget)$", u.path)
            if m and m.group(1) in C.ENGINES:
                if m.group(2) == "forget":  # delete downloaded weights (frees disk; re-downloads on next use)
                    ENG.stop(m.group(1))
                    d = cache_dir(m.group(1))
                    if any(cache_dir(n) == d for n in ENG.procs):  # a shared folder another loaded engine runs on
                        raise ValueError(f"{m.group(1)}'s weights are shared with a loaded engine: unload it first")
                    shutil.rmtree(d, ignore_errors=True)
                    _SIZES.pop(d, None)
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
        m = re.match(r"^/files/([a-f0-9]{12})(?:/([A-Za-z0-9_\-]{1,64}(?:\.subs|\.live)?\.(?:wav|srt|vtt|json)|video\.mp4|poster\.jpg|source\.jpg|image-\d{1,2}\.png|thumb-\d{1,2}\.jpg)|\.zip)$", u.path)
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
        origin = self.headers.get("Origin", "")
        if origin in CORS_ORIGINS:  # the dashboard's live player decodes the lines with fetch, which needs this
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)


def _origin(url):
    u = urlparse(url or "")
    return f"{u.scheme}://{u.netloc}" if u.scheme == "https" and u.netloc else None


# Origins whose pages may read signed file links with fetch (the dashboard; the link itself is still the permission)
CORS_ORIGINS = {o for o in [_origin(os.environ.get("REGISTER_URL")), *map(_origin, os.environ.get(
    "VOICEBOX_CORS_ORIGINS", "https://voiceboxstudio.vercel.app,https://mcp-eta-tawny.vercel.app").split(","))] if o}


def prefetch_all():
    """Step 6: the voice engines' venvs and weights onto the disk, one at a time, right after a start (config.PREFETCH)."""
    t = time.time()
    for name in C.PREFETCH:
        if name not in C.ENGINES:
            continue
        try:
            ENG.prefetch(name)
        except Exception as e:  # noqa: BLE001  the first job that needs it installs and downloads it the usual way
            log(f"couldn't prefetch {name} ({type(e).__name__}: {e})")
        if name in C.PRELOAD:
            threading.Thread(target=preload_at_start, args=(name,), daemon=True).start()
    if C.PREFETCH:
        BOOT_PREFETCH["done_s"] = round(time.time() - t, 1)
    for name in C.PRELOAD:  # one that isn't prefetched loads now instead
        if name in C.ENGINES and name not in C.PREFETCH:
            threading.Thread(target=preload_at_start, args=(name,), daemon=True).start()


def has_trained_voice():
    return bool(os.environ.get("MY_VOICE_MODEL") or os.environ.get("MY_VOICE_ADAPTER_URL")
                or os.path.exists(os.path.join(HOME, "myvoice", "adapter", "adapter_config.json")))


def preload_at_start(name):
    """Load name on the GPU while the worker comes online (config.PRELOAD), so the first voiceover finds it ready.
    Skipped when a job is running, the video models hold the GPU, or (myvoice) there's no trained voice to serve."""
    if name == "myvoice" and not has_trained_voice():
        return
    if ENG.running(name) or name in ENG.procs or ENG.mode == "visual" or any(j["status"] == "running" for j in list(JOBS.values())):
        return
    t = time.time()
    try:
        ENG.ensure(name)
        BOOT_PREFETCH.setdefault("preloaded", {})[name] = round(time.time() - t, 1)
        log(f"preloaded {name} at start in {time.time() - t:.0f} s")
    except Exception as e:  # noqa: BLE001  the first job that needs it loads it the usual way
        log(f"couldn't preload {name} ({type(e).__name__}: {e})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    if len(SECRET) < 24:
        sys.exit("WORKER_SECRET must be set (>= 24 chars)")
    threading.Thread(target=worker_loop, daemon=True).start()
    threading.Thread(target=worker_loop, args=(CPU_QUEUE,), daemon=True).start()
    for _ in range(FETCH_WORKERS):  # downloads run side by side: they need a little CPU and bandwidth, not the GPU
        threading.Thread(target=worker_loop, args=(FETCH_QUEUE,), daemon=True).start()
    os.environ["VOICEBOX_PORT"] = str(a.port)
    threading.Thread(target=warm_downloaders, daemon=True).start()  # the first link never waits on pip
    if not FETCH_ONLY:  # a downloads-only (CPU) worker has no engines to check or fetch
        run_selfcheck("start", delay=20)
        threading.Thread(target=prefetch_all, daemon=True).start()
    log(f"voicebox gateway {C.VERSION} on {a.host}:{a.port} · GPU {gpu_info()['name']} · VRAM budget {ENG.budget:.1f} GB")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
