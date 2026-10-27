"""The dashboard's R2 bucket as a cache for what every fresh Colab runtime would otherwise rebuild (docs/INFERENCE.md
step 7): model weights (a mirror of the Hugging Face repos the voice engines use) and vLLM's compiled kernels (per GPU
model and vLLM version: a cache built on an L4 is useless on an A100).

The worker holds no storage keys: it asks the dashboard (/api/worker-cache, the same WORKER_SECRET as the heartbeat)
for presigned links, one per object. A directory goes up as a tar stream cut into parts (R2 takes at most 5 GB in one
PUT; parts also download side by side), and its manifest last, so a manifest means a complete upload. A download
fetches the parts in parallel and pipes them, in order, into tar, so extracting overlaps the download.

Stdlib only: the gateway runs on Colab's own Python.
"""
import json, os, shutil, subprocess, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

PART = 256 << 20       # bytes per part
PULL_THREADS = 8       # parts downloading at once (RAM: at most PULL_THREADS + 2 parts held)
PUSH_THREADS = 4
VERSION = 1            # bump to ignore every upload made by an older layout

_locks, _locks_lock = {}, threading.Lock()
EVENTS = {}  # what came from or went to R2 this run (the gateway's /health shows it under boot.r2)


def _lock(key):
    with _locks_lock:
        return _locks.setdefault(key, threading.Lock())


def enabled():
    return bool(os.environ.get("REGISTER_URL") and len(os.environ.get("WORKER_SECRET", "")) >= 24
                and os.environ.get("VOICEBOX_R2_CACHE", "1") != "0")


def _api(op, **kw):
    base = os.environ["REGISTER_URL"].rsplit("/api/", 1)[0]
    req = urllib.request.Request(base + "/api/worker-cache", data=json.dumps({"op": op, **kw}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {os.environ['WORKER_SECRET']}",
                                          "Content-Type": "application/json", "User-Agent": "voicebox-worker"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.loads(r.read())
    if out.get("error"):
        raise RuntimeError(out["error"])
    return out


def _sign(keys, method="GET"):
    urls = {}
    for i in range(0, len(keys), 200):
        urls.update(_api("sign", keys=keys[i:i + 200], method=method)["urls"])
    return urls


def _get(url, timeout=600):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == 3:
                raise
        except (urllib.error.URLError, ConnectionError, OSError):
            if attempt == 3:
                raise
        time.sleep(2 ** attempt)


def _put(url, data):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Length": str(len(data))})
            with urllib.request.urlopen(req, timeout=1800):
                return
        except (urllib.error.URLError, ConnectionError, OSError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def manifest(prefix):
    """The finished upload under prefix, or None."""
    url = _sign([f"{prefix}/manifest.json"])[f"{prefix}/manifest.json"]
    raw = _get(url, timeout=30)
    if not raw:
        return None
    m = json.loads(raw)
    return m if m.get("v") == VERSION else None


def pull(prefix, dest, m=None):
    """Download prefix into the directory dest (made fresh: extracted beside it, then moved into place, so a broken
    download never leaves half a folder that looks complete). Returns {bytes, secs, mbps} or None if nothing is there."""
    m = m or manifest(prefix)
    if not m:
        return None
    t = time.time()
    keys = [f"{prefix}/part-{i:04d}" for i in range(m["parts"])]
    urls = _sign(keys)
    tmp = dest + ".r2part"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    tar = subprocess.Popen(["tar", "-xf", "-", "-C", tmp], stdin=subprocess.PIPE)
    try:
        with ThreadPoolExecutor(PULL_THREADS) as ex:
            futs = [None] * len(keys)
            ahead = PULL_THREADS + 2
            for i in range(min(ahead, len(keys))):
                futs[i] = ex.submit(_get, urls[keys[i]])
            for i in range(len(keys)):
                data = futs[i].result()
                futs[i] = None
                if data is None:
                    raise RuntimeError(f"{keys[i]} is missing")
                if i + ahead < len(keys):
                    futs[i + ahead] = ex.submit(_get, urls[keys[i + ahead]])
                tar.stdin.write(data)
        tar.stdin.close()
        if tar.wait():
            raise RuntimeError(f"tar exited {tar.returncode}")
    except BaseException:
        tar.kill()
        tar.wait()
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    if os.path.isdir(dest):
        for name in os.listdir(tmp):  # merge: dest may already hold other things (another repo, another config)
            src, dst = os.path.join(tmp, name), os.path.join(dest, name)
            if os.path.exists(dst):
                shutil.rmtree(dst, ignore_errors=True) if os.path.isdir(dst) and not os.path.islink(dst) else os.remove(dst)
            os.replace(src, dst)
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        os.replace(tmp, dest)
    secs = time.time() - t
    return {"bytes": m["bytes"], "secs": round(secs, 1), "mbps": round(m["bytes"] / 1e6 / max(secs, 1e-3))}


def push(prefix, src, names=None, meta=None):
    """Upload the directory src (or only the entries names inside it) under prefix. Returns {bytes, secs}."""
    t = time.time()
    names = names or sorted(os.listdir(src))
    tar = subprocess.Popen(["tar", "-cf", "-", "-C", src, *names], stdout=subprocess.PIPE)
    total, n, futs = 0, 0, []
    try:
        with ThreadPoolExecutor(PUSH_THREADS) as ex:
            while True:
                data = tar.stdout.read(PART)
                if not data:
                    break
                key = f"{prefix}/part-{n:04d}"
                url = _sign([key], "PUT")[key]
                futs.append(ex.submit(_put, url, data))
                total += len(data)
                n += 1
                while sum(not f.done() for f in futs) >= PUSH_THREADS + 1:  # bound the RAM held by queued parts
                    time.sleep(0.2)
            for f in futs:
                f.result()
        if tar.wait():
            raise RuntimeError(f"tar exited {tar.returncode}")
    except BaseException:
        tar.kill()
        tar.wait()
        raise
    key = f"{prefix}/manifest.json"
    body = {"v": VERSION, "parts": n, "bytes": total, "names": names, "made": time.time(), **(meta or {})}
    _put(_sign([key], "PUT")[key], json.dumps(body).encode())
    return {"bytes": total, "secs": round(time.time() - t, 1)}


# ----------------------------------------------------------------------------------------- weights
def repo_dir(repo):
    return "models--" + repo.replace("/", "--")


def weights_prefix(repo):
    return f"cache/hf/{repo_dir(repo)}"


def have_repo(hf_home, repo):
    """The repo is fully in this Hugging Face cache: a snapshot with no unfinished downloads."""
    d = os.path.join(hf_home, "hub", repo_dir(repo))
    snaps = os.path.join(d, "snapshots")
    if not os.path.isdir(snaps) or not os.listdir(snaps):
        return False
    blobs = os.path.join(d, "blobs")
    return not (os.path.isdir(blobs) and any(f.endswith(".incomplete") for f in os.listdir(blobs)))


def pull_repo(hf_home, repo, log=print):
    """Fill hf_home with repo from R2: "have" (it was there), "r2" (it came from R2 now) or False (R2 hasn't it)."""
    with _lock(("repo", repo)):
        if have_repo(hf_home, repo):
            return "have"
        try:
            out = pull(weights_prefix(repo), os.path.join(hf_home, "hub", repo_dir(repo)))
        except Exception as e:  # noqa: BLE001  Hugging Face is the fallback
            log(f"R2 weights for {repo} failed ({type(e).__name__}: {e}); Hugging Face instead")
            shutil.rmtree(os.path.join(hf_home, "hub", repo_dir(repo)), ignore_errors=True)
            return False
        if out:
            EVENTS[f"pull {repo}"] = out
            log(f"weights {repo} from R2: {out['bytes'] / 1e9:.1f} GB in {out['secs']} s ({out['mbps']} MB/s)")
        return "r2" if out else False


def push_repo(hf_home, repo, log=print):
    """Mirror a fully downloaded repo to R2 once (skipped if R2 already has it)."""
    with _lock(("repo", repo)):
        if not have_repo(hf_home, repo) or manifest(weights_prefix(repo)):
            return
        d = os.path.join(hf_home, "hub", repo_dir(repo))
        out = push(weights_prefix(repo), d, [n for n in ("blobs", "refs", "snapshots") if os.path.exists(os.path.join(d, n))],
                   {"repo": repo})
        EVENTS[f"push {repo}"] = out
        log(f"mirrored {repo} to R2: {out['bytes'] / 1e9:.1f} GB in {out['secs']} s")


# ----------------------------------------------------------------------------------------- compiled kernels
def slug(s):
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")


def vllm_version(python):
    """vLLM's version in a venv, from its dist-info folder (importing vLLM to ask takes ~10 s)."""
    lib = os.path.join(os.path.dirname(os.path.dirname(python)), "lib")
    for root, dirs, _ in os.walk(lib):
        for d in dirs:
            if d.startswith("vllm-") and d.endswith(".dist-info"):
                return d[5:-10]
        if root.count(os.sep) - lib.count(os.sep) >= 2:
            dirs[:] = []
    return None


def compile_root(home, gpu, version):
    return os.path.join(home, "compile-cache", slug(gpu), slug(version))


def compile_env(root):
    """Where vLLM, Inductor and Triton keep what they compile: one folder per GPU and vLLM version."""
    return {"VLLM_CACHE_ROOT": os.path.join(root, "vllm"), "TORCHINDUCTOR_CACHE_DIR": os.path.join(root, "inductor"),
            "TRITON_CACHE_DIR": os.path.join(root, "triton")}


def compile_prefix(gpu, version):
    return f"cache/compile/{slug(gpu)}/{slug(version)}"


def tree_sig(root):
    """(files, bytes) under root: what changed since the last pull or push."""
    n = size = 0
    for r, _, fs in os.walk(root):
        for f in fs:
            try:
                size += os.lstat(os.path.join(r, f)).st_size
                n += 1
            except OSError:
                pass
    return n, size
