"""The workbench (docs/AUTOMATION.md): what a model asks the worker to do beyond voice. One job kind, "bench", with an
op: run (phase 2: code in a sandbox). Later ops (media edits, inspections, the browser, templates) plug into OPS.

The sandbox: code runs as its own Linux user (vbsandbox) in a workspace folder of its own, with a clean environment
(none of the worker's secrets), no way into the worker's home (/content/voicebox is closed to other users), a time
limit, a memory watchdog and trimmed output. A workspace lives as long as the runtime; files the code writes to out/
are saved to Files by the dashboard. Code mode: `import voicebox` calls any VoiceBox tool from the script with a key
that lasts as long as the run (it still goes through the owner's approvals, the units cap and the call log), so a
script can filter a thousand rows and print five instead of passing them through the model."""
import ipaddress, json, os, pwd, re, shutil, signal, socket, stat, subprocess, sys, threading, time, urllib.parse, urllib.request

import config as C

ROOT = os.environ.get("VOICEBOX_SANDBOX", "/content/sandbox")
USER = "vbsandbox"
KIT = os.path.join(ROOT, ".kit")
WS_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
LANGS = {"python": ("main.py", ["python3", "-u"]), "node": ("main.mjs", ["node"]), "bash": ("main.sh", ["bash", "-e"])}
MAX_TIMEOUT = 1800
MAX_OUT_FILES, MAX_OUT_BYTES = 40, 2_000_000_000
_SETUP = {"done": False, "isolation": [], "lock": threading.Lock()}


class Cancelled(Exception):
    pass


def log(*a):
    print("[bench]", *a, flush=True)


# ── setup: the sandbox user, the closed worker home, the code-mode kit ──────────────────────────────────────────────

def setup():
    """Once per runtime. Returns what isolation is in place, for the job's answer (honest about what isn't)."""
    with _SETUP["lock"]:
        if _SETUP["done"]:
            return _SETUP["isolation"]
        iso = []
        os.makedirs(ROOT, exist_ok=True)
        os.chmod(ROOT, 0o711)
        if os.geteuid() == 0:
            try:
                pwd.getpwnam(USER)
            except KeyError:
                subprocess.run(["useradd", "--system", "--no-create-home", "--home-dir", ROOT, "--shell", "/bin/bash", USER],
                               check=False, capture_output=True)
            try:
                pwd.getpwnam(USER)
                iso.append(f"runs as the {USER} user")
            except KeyError:
                iso.append("WARNING: couldn't make the sandbox user; code runs as the worker")
            for d in {C.HOME, os.path.expanduser("~")}:  # the worker's files, logs, cookies and the root home
                try:
                    os.chmod(d, 0o700)
                except OSError:
                    pass
            iso.append("the worker's folders are closed to it")
            # the engines listen on localhost without a key: the sandbox user can't open connections to this machine
            if shutil.which("iptables") and os.environ.get("VOICEBOX_BENCH_ALLOW_LOCAL") != "1":  # local tests serve inputs on localhost
                r = subprocess.run(["iptables", "-C", "OUTPUT", "-o", "lo", "-m", "owner", "--uid-owner", USER, "-j", "REJECT"], capture_output=True)
                if r.returncode != 0:
                    r = subprocess.run(["iptables", "-A", "OUTPUT", "-o", "lo", "-m", "owner", "--uid-owner", USER, "-j", "REJECT"], capture_output=True)
                if r.returncode == 0:
                    iso.append("no access to the worker's local ports")
        else:
            iso.append("WARNING: not root, so code runs as the worker's own user (local testing)")
        iso.append("a clean environment (no secrets)")
        write_kit()
        _SETUP.update(done=True, isolation=iso)
        return iso


def write_kit():
    os.makedirs(KIT, exist_ok=True)
    os.makedirs(os.path.join(KIT, "bin"), exist_ok=True)
    for name, body, mode in (("voicebox.py", KIT_PY, 0o644), ("browse.py", BROWSE_PY, 0o644), ("bin/hyperframes", HF_SH, 0o755)):
        with open(os.path.join(KIT, name), "w") as f:
            f.write(body)
        os.chmod(os.path.join(KIT, name), mode)
    os.chmod(KIT, 0o755)
    os.chmod(os.path.join(KIT, "bin"), 0o755)


def _ids():
    try:
        p = pwd.getpwnam(USER)
        return (p.pw_uid, p.pw_gid) if os.geteuid() == 0 else None
    except KeyError:
        return None


def workspace(name):
    if not WS_RE.match(name or ""):
        raise ValueError("workspace: lowercase letters, digits and dashes, up to 40 (e.g. case-025)")
    path = os.path.join(ROOT, "ws", name)
    for sub in ("", "in", "out"):
        os.makedirs(os.path.join(path, sub), exist_ok=True)
    ids = _ids()
    if ids:  # only what root made here; everything else the sandbox user made itself
        for sub in ("", "in", "out"):
            os.lchown(os.path.join(path, sub), *ids)
        os.chmod(os.path.join(ROOT, "ws"), 0o711)
        os.chmod(path, 0o700)
    return path


def safe_url(u):
    """Inputs: http(s) to the internet only (checked here, then fetched as the sandbox user, who can't reach this
    machine anyway)."""
    p = urllib.parse.urlparse(str(u or ""))
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError(f"not a web address: {str(u)[:80]}")
    for info in socket.getaddrinfo(p.hostname, None):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            if os.environ.get("VOICEBOX_BENCH_ALLOW_LOCAL") != "1":  # local tests only
                raise ValueError(f"{p.hostname} is a private address")
    return p.geturl()


def _drop(ids, fsize=4 << 30):
    """preexec for anything run as the sandbox user: its own session (so it's killed as a group), limits, then the user."""
    def go():
        os.setsid()
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if ids:
            os.setgroups([])
            os.setgid(ids[1])
            os.setuid(ids[0])
    return go


BASE_ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


def as_user(argv, cwd, stdin=None, timeout=600, env=None, err_tail=2000):
    """Run a helper as the sandbox user (never as root inside the workspace: the code there could have left symlinks
    pointing at the worker's files). Returns (exit code, stdout bytes, stderr text)."""
    r = subprocess.run(argv, cwd=cwd, input=stdin, capture_output=True, timeout=timeout, env={**BASE_ENV, "HOME": cwd, **(env or {})},
                       preexec_fn=_drop(_ids()))
    err = r.stderr.decode("utf-8", "replace")
    return r.returncode, r.stdout, err[-err_tail:] if err_tail else err


FETCH_PY = r"""
import os, sys, urllib.request, shutil
req = urllib.request.Request(sys.argv[1], headers={"User-Agent": "voicebox-bench"})
with urllib.request.urlopen(req, timeout=300) as r, open(sys.argv[2], "wb") as out:
    shutil.copyfileobj(r, out, 1 << 20)
print(os.path.getsize(sys.argv[2]))
"""


def fetch_inputs(job, ws):
    got = []
    for f in job["bench"].get("files") or []:
        if job.get("cancel"):
            raise Cancelled()
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(f.get("name") or "file"))[:120].lstrip(".") or "file"
        code, out, err = as_user(["python3", "-c", FETCH_PY, safe_url(f.get("url")), f"in/{name}"], ws, timeout=900)
        if code:
            raise ValueError(f"couldn't fetch {name}: {err.strip().splitlines()[-1] if err.strip() else code}")
        size = os.lstat(os.path.join(ws, "in", name)).st_size
        got.append({"name": f"in/{name}", "mb": round(size / 1e6, 2), **({"key": f["key"]} if f.get("key") else {})})
    return got


def write_as_user(ws, rel, data):
    code, _, err = as_user(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", rel], ws, stdin=data, timeout=60)
    if code:
        raise ValueError(f"couldn't write {rel}: {err.strip()}")


# ── running code ────────────────────────────────────────────────────────────────────────────────────────────────

def trim(s, head=3000, tail=8000):
    if len(s) <= head + tail + 200:
        return s
    return f"{s[:head]}\n…[{len(s) - head - tail} characters cut]…\n{s[-tail:]}"


def _rss_mb(pgid):
    total = 0
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            if os.getpgid(int(pid)) != pgid:
                continue
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        total += int(line.split()[1]) // 1024
        except (OSError, ProcessLookupError, ValueError):
            continue
    return total


def snapshot(d):
    """Regular files under d (never following a link), with their mtime and size."""
    out = {}
    for dirpath, _, files in os.walk(d):
        for n in files:
            p = os.path.join(dirpath, n)
            try:
                st = os.lstat(p)
                if stat.S_ISREG(st.st_mode):
                    out[os.path.relpath(p, d)] = (st.st_mtime_ns, st.st_size)
            except OSError:
                pass
    return out


def run_code(job, jdir):
    b = job["bench"]
    iso = setup()
    ws = workspace(b["workspace"])
    b["stage"] = "fetching inputs"
    b["inputs"] = fetch_inputs(job, ws)
    fname, cmd = LANGS[b["lang"]]
    rel = f".run/{job['id']}-{fname}"
    write_as_user(ws, rel, b["code"].encode())
    for name, code in (b.get("skills") or {}).items():  # saved skills: from skills import <name>
        write_as_user(ws, f"skills/{name}.py", code.encode())
    if b.get("skills"):
        write_as_user(ws, "skills/__init__.py", b"")
    before = snapshot(os.path.join(ws, "out"))
    env = {**BASE_ENV, "HOME": ws, "PYTHONPATH": f"{KIT}:{ws}",  # the kit, and the workspace (skills/, the code's own modules) "PYTHONUNBUFFERED": "1", "MPLBACKEND": "Agg", "TMPDIR": os.path.join(ws, ".tmp"),
           "PIP_USER": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PYTHONUSERBASE": os.path.join(ws, ".local"), "VOICEBOX_WORKSPACE": ws}
    for k in ("VOICEBOX_URL", "VOICEBOX_KEY", "VOICEBOX_MODEL"):
        if b.get(k.lower()):
            env[k] = b[k.lower()]
    for k in ("CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "LD_LIBRARY_PATH"):  # the GPU, not the secrets
        if os.environ.get(k):
            env[k] = os.environ[k]
    if b["lang"] == "node" or NODE_HINT.search(b["code"]):  # Node 22, npm, npx and the project's HyperFrames on PATH
        env.update(node_env(b, ws))
    as_user(["mkdir", "-p", ".tmp"], ws, timeout=30)
    out_p, err_p = os.path.join(jdir, "stdout.txt"), os.path.join(jdir, "stderr.txt")
    b["stage"] = "running"
    t0 = time.time()
    killed = None
    with open(out_p, "wb") as so, open(err_p, "wb") as se:
        p = subprocess.Popen(cmd + [os.path.join(ws, rel)] + [str(a) for a in b.get("args") or []], cwd=ws, env=env, stdout=so, stderr=se,
                             stdin=subprocess.DEVNULL, preexec_fn=_drop(_ids()))
        while p.poll() is None:
            time.sleep(0.5)
            elapsed = time.time() - t0
            if job.get("cancel"):
                killed = "cancelled"
            elif elapsed > b["timeout_s"]:
                killed = f"time limit ({b['timeout_s']} s)"
            elif int(elapsed * 2) % 6 == 0 and _rss_mb(p.pid) > b["memory_mb"]:
                killed = f"memory limit ({b['memory_mb']} MB)"
            if killed:
                break
            with open(out_p, "rb") as f:  # the live tail, for get_job while it runs
                f.seek(max(0, os.path.getsize(out_p) - 1500))
                b["tail"] = f.read().decode("utf-8", "replace")
        try:  # whatever it left running in the background goes too
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        p.wait()
    b["seconds"] = round(time.time() - t0, 2)
    b["exit"] = p.returncode
    read = lambda path: open(path, "rb").read().decode("utf-8", "replace")
    b["stdout"], b["stderr"] = trim(read(out_p)), trim(read(err_p), 600, 3000)  # a traceback says it at the end
    b.pop("tail", None)
    b["isolation"] = iso
    if killed == "cancelled":
        raise Cancelled()
    if killed:
        b["killed"] = killed
    collect_outputs(job, jdir, ws, "out", before)
    b["stage"] = "done"


def pull_files(ws, base, rels, dst_dir, limit=MAX_OUT_BYTES):
    """Copy files out of the workspace as the sandbox user, through a tar stream, keeping regular files only: what
    it hands over is only what it could read itself. Returns {rel: local path}."""
    import tarfile
    got, total = {}, 0
    p = subprocess.Popen(["tar", "-C", base, "-cf", "-", "--null", "-T", "-"], cwd=ws, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, env={**BASE_ENV, "HOME": ws}, preexec_fn=_drop(_ids()))
    feeder = threading.Thread(target=lambda: (p.stdin.write(b"\0".join(r.encode() for r in rels)), p.stdin.close()), daemon=True)
    feeder.start()
    with tarfile.open(fileobj=p.stdout, mode="r|") as tf:
        for m in tf:
            if not m.isfile() or m.name not in rels or total + m.size > limit:
                continue
            flat = re.sub(r"[^A-Za-z0-9._-]+", "_", m.name.replace("/", "__"))[-120:]
            dst = os.path.join(dst_dir, flat)
            with tf.extractfile(m) as src, open(dst, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
            total += m.size
            got[m.name] = dst
    p.wait()
    return got


def collect_outputs(job, jdir, ws, sub, before):
    """New or changed files in out/ are copied next to the job, for the dashboard to save into Files."""
    b = job["bench"]
    after = snapshot(os.path.join(ws, sub))
    changed = sorted(k for k, v in after.items() if before.get(k) != v)
    if len(changed) > MAX_OUT_FILES:
        b.setdefault("notes", []).append(f"{len(changed) - MAX_OUT_FILES} more files in out/ weren't kept (40 a run)")
    got = pull_files(ws, os.path.join(ws, sub), changed[:MAX_OUT_FILES], jdir) if changed else {}
    for rel in changed[:MAX_OUT_FILES]:
        if rel not in got:
            b.setdefault("notes", []).append(f"out/{rel} left out (over 2 GB a run, or it changed while being copied)")
    b["outputs"] = [{"name": os.path.basename(path), "path": f"out/{rel}", "bytes": os.path.getsize(path)} for rel, path in got.items()]


# ── repos: a clone for a workspace, and its changes back (lib/auto/repo.ts commits them through the API) ─────────────

def clone_repo(job, jdir):
    """Clone as root with the key in a header (never written into the clone), hand it to the sandbox user, move it
    into the workspace. The key leaves with this job."""
    b = job["bench"]
    b["isolation"] = setup()
    ws = workspace(b["workspace"])
    dest = os.path.join(ws, b["dir"])
    if os.path.lexists(dest):
        if not b.get("fresh"):
            raise ValueError(f"{b['dir']} is already in workspace {b['workspace']}: pass fresh to clone it again (its changes are lost)")
        as_user(["rm", "-rf", "--", b["dir"]], ws, timeout=300)
    stage = os.path.join(ROOT, ".stage", job["id"])
    os.makedirs(os.path.dirname(stage), exist_ok=True)
    os.chmod(os.path.dirname(stage), 0o711)
    b["stage"] = "cloning"
    key = b.pop("header", "")
    genv = {**BASE_ENV, "HOME": jdir, "GIT_TERMINAL_PROMPT": "0"}
    git = ["git", "-c", f"http.extraHeader={key}", "-c", "core.hooksPath=/dev/null"]
    if SHA_RE.match(b["ref"]):  # a commit (lib/auto/repo.ts resolves a short sha): fetch just it, checked out detached
        os.makedirs(stage)
        r = subprocess.run(["git", "init", "-q", stage], capture_output=True, timeout=60, env=genv)
        for argv in ([*git, "-C", stage, "fetch", "--depth", str(b["depth"]), "--", b["url"], b["ref"]], ["git", "-C", stage, "checkout", "-q", "--detach", "FETCH_HEAD"],
                     ["git", "-C", stage, "remote", "add", "origin", b["url"]]):
            if r.returncode:
                break
            r = subprocess.run(argv, capture_output=True, timeout=900, env=genv)
    else:
        r = subprocess.run([*git, "clone", "--depth", str(b["depth"]), "--branch", b["ref"], "--", b["url"], stage], capture_output=True, timeout=900, env=genv)
    if r.returncode:
        shutil.rmtree(stage, ignore_errors=True)
        raise ValueError(f"clone failed: {r.stderr.decode('utf-8', 'replace').replace(key, '***')[-600:]}")
    ids = _ids()
    if ids:
        subprocess.run(["chown", "-R", "-P", f"{ids[0]}:{ids[1]}", stage], check=True)
    os.rename(stage, dest)  # the final name isn't followed: a link left there can't redirect it
    head = as_user(["git", "-C", b["dir"], "rev-parse", "--short", "HEAD"], ws, timeout=30)[1].decode().strip()
    b.update(stage="done", head=head, path=f"{b['dir']}/")


DIFF_PY = r"""
import base64, json, os, subprocess, sys
os.chdir(sys.argv[1])
z = subprocess.run(["git", "status", "--porcelain=v1", "-z", "-uall"], capture_output=True, check=True).stdout.decode().split("\0")
out, total, i = [], 0, 0
while i < len(z):
    e = z[i]; i += 1
    if not e:
        continue
    st, path = e[:2], e[3:]
    if st[0] == "R":
        out.append({"path": z[i], "delete": True}); i += 1
    if "D" in st:
        out.append({"path": path, "delete": True}); continue
    if os.path.islink(path) or not os.path.isfile(path):
        continue
    data = open(path, "rb").read()
    total += len(data)
    if total > 20_000_000:
        print(json.dumps({"error": "over 20 MB of changes: commit less at once"})); sys.exit(0)
    out.append({"path": path, "base64": base64.b64encode(data).decode()})
head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True).stdout.decode().strip()
print(json.dumps({"changes": out, "head": head}))
"""


def diff_repo(job, jdir):
    """The clone's changes (new, changed, deleted files), read as the sandbox user, for a commit made by the dashboard."""
    b = job["bench"]
    ws = workspace(b["workspace"])
    code, out, err = as_user(["python3", "-c", DIFF_PY, b["dir"]], ws, timeout=120)
    if code:
        raise ValueError(f"couldn't read the changes: {err.strip()[-400:]}")
    d = json.loads(out.decode() or "{}")
    if d.get("error"):
        raise ValueError(d["error"])
    b.update(stage="done", changes=d["changes"], head=d["head"], count=len(d["changes"]))


# ── media: edits and inspections (media.py holds the recipes) ───────────────────────────────────────────────────

HOOKS = {}  # set by gateway.py: transcribe(job, wav path, language) -> {"words": [{w, s, e}], "text", "duration"}


def _media_ws(job):
    """A fresh workspace for one media job, emptied after it (the result goes to Files)."""
    return workspace(f"job-{job['id']}")


def _media_run(ws):
    return lambda argv, timeout=1800: as_user(argv, ws, timeout=timeout, err_tail=None)


def _words(job, ws, jdir, run, src_path, cap, inputs):
    """Word timings for captions: given, from an SRT input, or heard by Whisper on the GPU."""
    import media
    b = job["bench"]
    if cap.get("words"):
        return [{"w": str(x["w"]), "s": float(x["s"]), "e": float(x["e"])} for x in cap["words"]][:5000]
    if cap.get("srt"):
        ins = {i["key"]: i["name"] for i in inputs if i.get("key")}
        if cap["srt"] not in ins:
            raise ValueError(f"captions.srt: no input called {cap['srt']!r}")
        code, out, _ = as_user(["cat", "--", ins[cap["srt"]]], ws, timeout=30)
        return media.words_from_srt(out.decode("utf-8", "replace"))
    if "transcribe" not in HOOKS:
        raise ValueError("captions from speech need the GPU worker's Whisper (this worker has none): give captions.srt or captions.words")
    b["stage"] = "hearing the words"
    code, _, err = run(["ffmpeg", "-hide_banner", "-y", "-i", src_path, "-vn", "-ac", "1", "-ar", "16000", "speech.wav"], timeout=900)
    if code:
        raise ValueError(f"couldn't take the sound out: {err.strip()[-200:]}")
    got = pull_files(ws, ws, ["speech.wav"], jdir)
    heard = HOOKS["transcribe"](job, got["speech.wav"], cap.get("language"))
    os.remove(got["speech.wav"])
    return heard["words"]


def render_spec(job, ws, jdir, run, infos, spec, inputs, out_name):
    """One edit spec rendered (two passes when it has captions), checked and copied next to the job. Returns what it made."""
    import media
    b = job["bench"]
    for k in ("voice", "music", "logo"):
        srcs = spec.get(k) and spec[k].get("src")
        for src in (srcs if isinstance(srcs, list) and k == "voice" else [srcs] if spec.get(k) else []):
            if src not in infos:
                raise ValueError(f"{k}.src: no input called {src!r} (inputs: {', '.join(infos)})")
    nv = media.has_nvenc()
    args, layout, seconds, extra = media.plan_edit(spec, {k: v for k, v in infos.items() if not v[0].lower().endswith(".srt")}, nv, media.font_file())
    for name, content in extra.items():
        write_as_user(ws, name, content.encode())
    b["stage"] = f"rendering {out_name}: {seconds:.0f} s ({'NVENC on the GPU' if nv else 'x264 on the CPU'})"
    t0 = time.time()
    code, _, err = run(args, timeout=3600)
    if code:
        raise ValueError(f"ffmpeg failed: {err.strip()[-900:]}")
    final, caps = "out.mp4", None
    if spec.get("captions"):
        words = _words(job, ws, jdir, run, "out.mp4", spec["captions"], inputs)
        info = media.probe(run, "out.mp4")
        cap = spec["captions"]
        ass, boxes = media.captions_ass(words, info["width"], info["height"], cap.get("style") or "pop", cap.get("position") or "lower",
                                        platform=spec.get("platform") or "reels")
        write_as_user(ws, "captions.ass", ass.encode())
        layout += boxes
        b["stage"] = f"burning in the captions: {out_name}"
        enc = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0"] if nv else ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]
        code, _, err = run(["ffmpeg", "-hide_banner", "-y", "-nostats", "-i", "out.mp4", "-vf", "subtitles=filename=captions.ass", *enc, "-pix_fmt", "yuv420p",
                            "-c:a", "copy", "-movflags", "+faststart", "final.mp4"], timeout=3600)
        if code:
            raise ValueError(f"captions failed: {err.strip()[-600:]}")
        final, caps = "final.mp4", {"words": len(words), "style": cap.get("style") or "pop"}
    target = media.num(spec.get("lufs"), -30, -8, (media.PLATFORMS.get(spec.get("platform") or "reels") or media.PLATFORMS["reels"])["lufs"])
    if media.fix_loudness(run, final, "level.mp4", target) is not None:
        final = "level.mp4"
    render_s = round(time.time() - t0, 1)
    b["stage"] = f"checking {out_name}"
    stills = spec.get("_stills") or any(infos.get(c.get("src"), ("", {}))[1].get("image") for c in spec.get("clips") or [])
    q = media.qa(run, final, spec.get("platform") or "reels", layout, stills=bool(stills))
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", out_name)[:80].removesuffix(".mp4") + ".mp4"
    return {**keep_result(ws, jdir, final, name), "qa": q, "seconds": seconds, "render_s": render_s, **({"captions": caps} if caps else {})}


def keep_result(ws, jdir, path, name):
    """A file the job made in its workspace, copied next to the job under `name` (read as the sandbox user)."""
    as_user(["mkdir", "-p", "res"], ws, timeout=30)
    as_user(["mv", "-f", "--", path, f"res/{name}"], ws, timeout=60)
    got = pull_files(ws, os.path.join(ws, "res"), [name], jdir)
    if name not in got:
        raise ValueError(f"{name} wasn't made")
    return {"name": name, "path": name, "bytes": os.path.getsize(got[name])}


def _probe_inputs(job, ws, run):
    import media
    b = job["bench"]
    b["stage"] = "fetching"
    b["inputs"] = fetch_inputs(job, ws)
    return {i["key"]: (i["name"], media.probe(run, i["name"])) for i in b["inputs"]}


def _done_ws(ws):
    as_user(["rm", "-rf", "--", ws], ROOT, timeout=300)
    try:
        os.rmdir(ws)
    except OSError:
        pass


def edit_media(job, jdir):
    b = job["bench"]
    b["isolation"] = setup()
    ws = _media_ws(job)
    run = _media_run(ws)
    try:
        infos = _probe_inputs(job, ws, run)
        spec = dict(b["spec"])
        r = render_spec(job, ws, jdir, run, infos, spec, b["inputs"], str(spec.get("name") or "edit"))
        b.update(qa=r["qa"], render_s=r["render_s"], seconds_out=r["seconds"], outputs=[{k: r[k] for k in ("name", "path", "bytes")}],
                 **({"captions": r["captions"]} if r.get("captions") else {}))
        b["stage"] = "done"
    finally:
        _done_ws(ws)


# ── templates: HyperFrames compositions (lib/auto/templates.ts writes them; custom ones come from a repo) ────────────

HF_VERSION, GSAP_VERSION = "0.8.217", "3.12.5"
NODE_DIR, HF_DIR = "/opt/vb-node", "/opt/vb-hyperframes"
_HF = {"ready": None, "lock": threading.Lock()}


def _node_ok(node):
    try:
        v = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=20).stdout.strip().lstrip("v")
        return int(v.split(".")[0]) >= 22
    except Exception:  # noqa: BLE001
        return False


_NODE = {"bin": None, "lock": threading.Lock()}
NODE_URL = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz"


def ensure_node(b=None):
    """Node 22 (node, npm, npx) once per runtime in /opt/vb-node, readable by the sandbox user. Returns its bin dir."""
    with _NODE["lock"]:
        if _NODE["bin"]:
            return _NODE["bin"]
        node = os.path.join(NODE_DIR, "bin", "node")
        if not _node_ok(node):
            have = shutil.which("node")
            if have and _node_ok(have) and os.environ.get("VOICEBOX_NODE_SYSTEM") == "1":  # local tests: the machine's own Node 22
                _NODE["bin"] = os.path.dirname(os.path.realpath(have))
                return _NODE["bin"]
            if b is not None:
                b["stage"] = "installing Node 22 (once per runtime, ~20 s)"
            os.makedirs(NODE_DIR, exist_ok=True)
            r = subprocess.run(f"curl -fsSL --retry 3 {NODE_URL} | tar -xJ -C {NODE_DIR} --strip-components=1", shell=True, capture_output=True, timeout=600)
            if r.returncode or not _node_ok(node):
                raise ValueError(f"couldn't install Node 22: {r.stderr.decode('utf-8', 'replace')[-300:]}")
            subprocess.run(["chmod", "-R", "a+rX", NODE_DIR], check=False)
        _NODE["bin"] = os.path.join(NODE_DIR, "bin")
        return _NODE["bin"]


def hf_version(project_dir=None):
    """The HyperFrames version a project pins in its package.json (videos-post pins its own), else ours."""
    d = project_dir
    while d and d != "/":
        try:
            with open(os.path.join(d, "package.json")) as f:
                pkg = json.load(f)
            for sect in ("dependencies", "devDependencies"):
                v = str((pkg.get(sect) or {}).get("hyperframes") or "").lstrip("^~=v ")
                if re.match(r"^\d+\.\d+\.\d+$", v):
                    return v
        except (OSError, ValueError):
            pass
        d = os.path.dirname(d)
    return HF_VERSION


def hf_cli(b, version=HF_VERSION):
    """One HyperFrames version installed once per runtime (/opt/vb-hyperframes/<version>). Returns its cli."""
    if not re.match(r"^\d+\.\d+\.\d+$", version):
        raise ValueError(f"hyperframes version {version!r} isn't x.y.z")
    bin_dir = ensure_node(b)
    home = os.path.join(HF_DIR, version)
    cli = os.path.join(home, "node_modules", "hyperframes", "bin", "hyperframes.mjs")
    with _HF["lock"]:
        if not os.path.exists(cli):
            b["stage"] = f"installing HyperFrames {version} (once per runtime, ~1 min)"
            os.makedirs(home, exist_ok=True)
            r = subprocess.run([os.path.join(bin_dir, "npm"), "install", "--prefix", home, "--no-audit", "--no-fund", f"hyperframes@{version}", f"gsap@{GSAP_VERSION}"],
                               capture_output=True, timeout=900, env={**os.environ, "PATH": f"{bin_dir}:{BASE_ENV['PATH']}"})
            if r.returncode or not os.path.exists(cli):
                raise ValueError(f"couldn't install HyperFrames {version}: {r.stderr.decode('utf-8', 'replace')[-400:]}")
            subprocess.run(["chmod", "-R", "a+rX", HF_DIR], check=False)
    return cli


def node_env(b, ws):
    """What a run that uses Node gets: Node 22 first on PATH, `hyperframes` at the version each project in the
    workspace pins (installed here, as root, from the version string alone), Chromium for its renders."""
    bin_dir = ensure_node(b)
    env = {"PATH": f"{KIT}/bin:{bin_dir}:{BASE_ENV['PATH']}", "VB_HF_DEFAULT": HF_VERSION, "npm_config_update_notifier": "false"}
    if "hyperframes" in b["code"]:
        # package.json files read as the sandbox user (never followed by root), versions checked as x.y.z
        code, out, _ = as_user(["sh", "-c", "find . -maxdepth 5 -name package.json -not -path '*/node_modules/*' -type f -exec cat {} + 2>/dev/null"], ws, timeout=60)
        pins = set(re.findall(r'"hyperframes"\s*:\s*"[\^~=v ]*(\d+\.\d+\.\d+)"', out.decode("utf-8", "replace"))) or {HF_VERSION}
        for v in sorted(pins)[:3]:
            hf_cli(b, v)
        ensure_browser(b)
        chrome = chrome_path()
        env.update(HYPERFRAMES_BROWSER_PATH=chrome, PUPPETEER_EXECUTABLE_PATH=chrome, PRODUCER_LOW_MEMORY_MODE="0")
        b.setdefault("notes", []).append(f"hyperframes {', '.join(sorted(pins))} ready (the version each package.json pins)")
    b["stage"] = "running"
    return env


def chrome_path():
    return os.environ.get("VOICEBOX_CHROMIUM") or next(iter(sorted(__import__("glob").glob(f"{BROWSERS}/chromium-*/chrome-linux*/chrome"))), "")


def ensure_hyperframes(b, version=HF_VERSION):
    """Node 22 and HyperFrames, once per runtime, readable by the sandbox user. Returns (node, hyperframes cli, env)."""
    cli = hf_cli(b, version)
    bin_dir = ensure_node(b)
    ensure_browser(b)  # one Chromium for the browser and the renderer
    chrome = chrome_path()
    env = {"PATH": f"{bin_dir}:{BASE_ENV['PATH']}", "HYPERFRAMES_BROWSER_PATH": chrome, "PUPPETEER_EXECUTABLE_PATH": chrome, "PRODUCER_LOW_MEMORY_MODE": "0"}
    return os.path.join(bin_dir, "node"), cli, env


# `hyperframes` on the sandbox's PATH: the version the project's package.json pins (installed for it on the spot when
# the worker has it, else fetched by npx into the workspace's own cache), so `hyperframes check | snapshot | render`
# run as the project expects
HF_SH = r"""#!/bin/sh
v=$(node -e 'let d=process.cwd();for(;;){try{const p=require(d+"/package.json");const v=String((p.dependencies||{}).hyperframes||(p.devDependencies||{}).hyperframes||"").replace(/^[\^~=v ]+/,"");if(/^\d+\.\d+\.\d+$/.test(v)){console.log(v);break}}catch(e){}const u=require("path").dirname(d);if(u===d){console.log(process.env.VB_HF_DEFAULT);break}d=u}')
cli="/opt/vb-hyperframes/$v/node_modules/hyperframes/bin/hyperframes.mjs"
[ -f "$cli" ] && exec node "$cli" "$@"
exec npx -y "hyperframes@$v" "$@"
"""
NODE_HINT = re.compile(r"\b(npx|npm|node|hyperframes|pnpm|yarn)\b")


VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".m4v")


def with_media(html, inputs):
    """The template's data-media placeholders become real <img> / muted <video> clips with their files; a photo's
    sound track is dropped."""
    for i in inputs:
        k, fn = i.get("key"), os.path.basename(i["name"])
        if not k:
            continue
        ext = os.path.splitext(fn)[1].lower()
        src = f"media/{k}{ext}"
        if ext in VIDEO_EXT:
            html = html.replace(f'<img data-media="{k}"', f'<video src="{src}" muted playsinline')
            html = re.sub(rf'<audio data-media-audio="{re.escape(k)}"', f'<audio src="{src}"', html)
        else:
            html = html.replace(f'<img data-media="{k}"', f'<img src="{src}"')
            html = re.sub(rf'<audio data-media-audio="{re.escape(k)}"[^>]*></audio>', "", html)
    if 'data-media="' in html:
        raise ValueError("the template names media that wasn't given: " + ", ".join(re.findall(r'data-media="([^"]+)"', html)))
    return html


FONTS_DIR = "/opt/vb-fonts"
CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def font_css(family):
    """A Google font as local files (fonts.css + woff2), fetched once per runtime and cached, so a render never waits
    on the network. {} when it can't be had: the template falls back to DejaVu Sans instead of a black wait."""
    if not re.match(r"^[A-Za-z0-9 ]{2,40}$", family or ""):
        return {}
    d = os.path.join(FONTS_DIR, family.replace(" ", "_"))
    if not os.path.exists(os.path.join(d, "fonts.css")):
        try:
            q = urllib.parse.quote(family)
            req = urllib.request.Request(f"https://fonts.googleapis.com/css2?family={q}:wght@400;600;700;800&display=block", headers={"User-Agent": CHROME_UA})
            css = urllib.request.urlopen(req, timeout=30).read().decode()
            os.makedirs(d, exist_ok=True)
            for i, u in enumerate(dict.fromkeys(re.findall(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", css))):
                with urllib.request.urlopen(u, timeout=30) as r, open(os.path.join(d, f"f{i}.woff2"), "wb") as f:
                    f.write(r.read())
                css = css.replace(u, f"f{i}.woff2")
            with open(os.path.join(d, "fonts.css"), "w") as f:
                f.write(css)
        except Exception as e:  # noqa: BLE001
            log("font", family, e)
            return {}
    return {n: open(os.path.join(d, n), "rb").read() for n in os.listdir(d)}


def template_assets(ws, proj, b, version):
    """GSAP and the brand font into the project's assets/, from the worker's cache."""
    gsap = os.path.join(HF_DIR, version, "node_modules", "gsap", "dist", "gsap.min.js")
    if not os.path.exists(gsap):
        raise ValueError("GSAP isn't in the worker's cache: run the template again (it's installed with HyperFrames)")
    write_as_user(ws, f"{proj}/assets/gsap.min.js", open(gsap, "rb").read())
    files = font_css(b.get("font") or "Inter")
    if not files:
        b.setdefault("notes", []).append(f"the font {b.get('font') or 'Inter'} couldn't be fetched: DejaVu Sans stood in")
    for n, data in (files or {"fonts.css": b""}).items():
        write_as_user(ws, f"{proj}/assets/{n}", data)


def music_bed(run, src, music, out, volume_db=-16):
    """A music bed under the render: ducked under the render's own sound (a voice in it), faded out at the end."""
    import media
    info = media.probe(run, src)
    dur = float(info.get("duration") or 0)
    fade = max(0.0, dur - 1.5)
    bed = f"[1:a]aloop=loop=-1:size=2e9,atrim=0:{dur:.3f},volume={volume_db}dB,afade=t=out:st={fade:.3f}:d=1.5[m]"
    if info.get("has_audio"):
        fc = f"{bed};[0:a]asplit=2[v][sc];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[d];[v][d]amix=inputs=2:normalize=0:duration=first[a]"
    else:
        fc = f"{bed};[m]anull[a]"
    code, _, err = run(["ffmpeg", "-hide_banner", "-y", "-nostats", "-i", src, "-i", music, "-filter_complex", fc, "-map", "0:v", "-map", "[a]",
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], timeout=900)
    if code:
        raise ValueError(f"the music bed failed: {err.strip()[-400:]}")
    return out


def render_template(job, jdir):
    import media
    b = job["bench"]
    b["isolation"] = setup()
    ws = _media_ws(job) if not b.get("project") else workspace(b["project"]["workspace"])
    run = _media_run(ws)
    try:
        b["stage"] = "fetching"
        b["inputs"] = fetch_inputs(job, ws)
        music = next((i["name"] for i in b["inputs"] if b.get("music") and i.get("key") == b["music"]["key"]), None)
        if b.get("project"):  # a project from a repo checkout, rendered as it is at that commit, by the HyperFrames it pins
            proj = b["project"]["dir"]
            _, pkg, _ = as_user(["sh", "-c", 'd="$1"; while [ -n "$d" ] && [ "$d" != "." ]; do [ -f "$d/package.json" ] && { cat "$d/package.json"; exit 0; }; d=$(dirname "$d"); done; cat package.json 2>/dev/null', "sh", proj], ws, timeout=30)
            pin = re.search(r'"hyperframes"\s*:\s*"[\^~=v ]*(\d+\.\d+\.\d+)"', pkg.decode("utf-8", "replace"))
            version = pin.group(1) if pin else HF_VERSION
            node, cli, env = ensure_hyperframes(b, version)
        else:
            version = HF_VERSION
            node, cli, env = ensure_hyperframes(b, version)
            proj = "project"
            as_user(["mkdir", "-p", f"{proj}/media"], ws, timeout=30)
            for i in b["inputs"]:
                if i["name"] == music:
                    continue
                ext = os.path.splitext(i["name"])[1].lower()
                as_user(["mv", "-f", "--", i["name"], f"{proj}/media/{i['key']}{ext}"], ws, timeout=60)
            template_assets(ws, proj, b, version)
            write_as_user(ws, f"{proj}/index.html", with_media(b["html"], [i for i in b["inputs"] if i["name"] != music]).encode())
        b["hyperframes"] = version
        b["stage"] = "rendering the template"
        t0 = time.time()
        args = [node, cli, "render", "-o", os.path.join(ws, "tpl.mp4"), "--quality", b.get("quality") or "standard"]
        if b.get("composition"):
            args += ["-c", b["composition"]]
        code, out, err = as_user(args, os.path.join(ws, proj), timeout=1800, env={**env, "HOME": ws}, err_tail=4000)
        if code or not os.path.exists(os.path.join(ws, "tpl.mp4")):
            raise ValueError(f"HyperFrames couldn't render it: {(err or out.decode('utf-8', 'replace')).strip()[-900:]}")
        final = "tpl.mp4"
        if music:
            b["stage"] = "mixing the music bed"
            final = music_bed(run, final, music, "bed.mp4", b["music"].get("volume_db", -16))
        target = (media.PLATFORMS.get(b.get("platform") or "reels") or media.PLATFORMS["reels"])["lufs"]
        if media.probe(run, final).get("has_audio") and media.fix_loudness(run, final, "level.mp4", target) is not None:
            final = "level.mp4"
        q = media.qa(run, final, b.get("platform") or "reels", None, stills=False)  # templates move every frame now: a freeze is a fault
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(b.get("name") or "template"))[:80].removesuffix(".mp4") + ".mp4"
        out_f = keep_result(ws, jdir, final, name)
        b.update(qa=q, render_s=round(time.time() - t0, 1), outputs=[out_f], stage="done")
    finally:
        if not b.get("project"):
            _done_ws(ws)


RECIPES = ("long_to_shorts", "carousel_to_reel", "reel_to_carousel", "podcast_to_audiogram", "add_voiceover")


def repurpose(job, jdir):
    """Recipes over the edit pipeline: one call, several finished pieces, each checked."""
    import media
    b = job["bench"]
    b["isolation"] = setup()
    ws = _media_ws(job)
    run = _media_run(ws)
    o = b["options"]
    made = []
    try:
        infos = _probe_inputs(job, ws, run)
        keys = list(infos)
        first = keys[0]
        style = o.get("captions") if o.get("captions") in ("pop", "bold", "clean", None) else "pop"
        plat = o.get("platform") or "reels"
        if b["recipe"] == "long_to_shorts":
            src, info = infos[first]
            words = [{"w": str(x["w"]), "s": float(x["s"]), "e": float(x["e"])} for x in (o.get("words") or [])] or None
            if not words and (o.get("segments") is None or style) and "transcribe" in HOOKS:
                words = _words(job, ws, jdir, run, src, {}, b["inputs"])  # what's said picks the segments and makes the captions
            segs = o.get("segments") or media.pick_segments(words or [], info["duration"], int(o.get("count") or 3), float(o.get("min_s") or 20), float(o.get("max_s") or 55))
            if not segs:
                raise ValueError("no segments: give segments [{from, to, title}], or words / a GPU worker so they can be picked from what's said")
            for i, sg in enumerate(segs[:10]):
                a, z = float(sg["from"]), float(sg["to"])
                spec = {"platform": plat, "fit": o.get("fit") or "blur", "clips": [{"src": first, "from": a, "to": z}], "fade": {"out": 0.3}}
                if style and words:
                    spec["captions"] = {"style": style, "words": [{**w, "s": w["s"] - a, "e": w["e"] - a} for w in words if a <= w["s"] < z]}
                if sg.get("title"):
                    spec["texts"] = [{"text": sg["title"], "position": "top", "size": 64, "to": 3}]
                r = render_spec(job, ws, jdir, run, infos, spec, b["inputs"], f"{o.get('name') or 'short'}-{i + 1}")
                made.append({**r, "from": a, "to": z, **({"title": sg["title"]} if sg.get("title") else {}), **({"why": sg["why"]} if sg.get("why") else {})})
        elif b["recipe"] == "carousel_to_reel":
            photos = [k for k in keys if infos[k][1].get("image")]
            if not photos:
                raise ValueError("carousel_to_reel needs photos")
            spec = {"platform": plat, "fit": o.get("fit") or "blur", "clips": [{"src": k, "seconds": float(o.get("seconds") or 2.5), "zoom": o.get("zoom", True)} for k in photos],
                    "fade": {"in": 0.2, "out": 0.4}}
            aud = [k for k in keys if not infos[k][1].get("image") and infos[k][1].get("has_audio")]
            if o.get("music") in infos or aud:
                spec["music"] = {"src": o.get("music") if o.get("music") in infos else aud[0], "volume_db": -12, "duck": bool(o.get("voice"))}
            if o.get("voice") in infos:
                spec["voice"] = {"src": o["voice"]}
                if style:
                    spec["captions"] = {"style": style}
            made.append(render_spec(job, ws, jdir, run, infos, spec, b["inputs"], o.get("name") or "carousel-reel"))
        elif b["recipe"] == "reel_to_carousel":
            src, info = infos[first]
            n = int(o.get("count") or 8)
            cuts = media.scenes(run, src, 0.3)
            times = media.carousel_times(cuts, info["duration"], n)
            shape = o.get("shape") or "4:5"
            for i, t in enumerate(times):
                fn = f"slide-{i + 1:02d}.jpg"
                media.frame(run, src, t, fn, *media.SHAPES.get(shape, (1080, 1350)))
                made.append({**keep_result(ws, jdir, fn, f"{o.get('name') or 'slide'}-{i + 1:02d}.jpg"), "at": round(t, 2)})
        elif b["recipe"] == "podcast_to_audiogram":
            audio = next((k for k in keys if infos[k][1].get("has_audio") and not infos[k][1].get("image")), None)
            if not audio:
                raise ValueError("podcast_to_audiogram needs an audio or video file")
            cover = next((k for k in keys if infos[k][1].get("image")), None)
            a = float(o.get("from") or 0)
            z = min(float(o.get("to") or a + 60), infos[audio][1]["duration"])
            W, H = media.SHAPES.get(o.get("shape") or "9:16", (1080, 1920))
            args, extra = media.audiogram(infos[audio][0], infos[cover][0] if cover else None, a, z, W, H, o.get("title") or "", media.font_file())
            for name, content in extra.items():
                write_as_user(ws, name, content.encode())
            b["stage"] = "drawing the audiogram"
            code, _, err = run(args, timeout=3600)
            if code:
                raise ValueError(f"audiogram failed: {err.strip()[-600:]}")
            spec = {"platform": plat, "clips": [{"src": "ag"}], "fit": "pad", "_stills": True}
            if style:
                spec["captions"] = {"style": style, "position": "middle"} if not o.get("words") else {"style": style, "position": "middle", "words": o["words"]}
            infos2 = {"ag": ("audiogram.mp4", media.probe(run, "audiogram.mp4"))}
            made.append(render_spec(job, ws, jdir, run, infos2, spec, b["inputs"], o.get("name") or "audiogram"))
        elif b["recipe"] == "add_voiceover":
            video = next((k for k in keys if infos[k][1].get("has_video") and not infos[k][1].get("image")), None)
            voice = o.get("voice") if o.get("voice") in infos else next((k for k in keys if k != video and infos[k][1].get("has_audio")), None)
            if not video or not voice:
                raise ValueError("add_voiceover needs a video and a voice file (options.voice: its key)")
            spec = {"platform": plat, "fit": o.get("fit") or "crop", "clips": [{"src": video}], "voice": {"src": voice, "at": float(o.get("at") or 0)},
                    "original_volume_db": o.get("original_volume_db", -14)}
            if style:
                spec["captions"] = {"style": style}
            made.append(render_spec(job, ws, jdir, run, infos, spec, b["inputs"], o.get("name") or "voiced"))
        b["made"] = made
        b["outputs"] = [{k: m[k] for k in ("name", "path", "bytes")} for m in made]
        b["stage"] = "done"
    finally:
        _done_ws(ws)


INSPECT = ("probe", "scenes", "loudness", "sheet", "words", "qa")


def inspect_media(job, jdir):
    import media
    b = job["bench"]
    b["isolation"] = setup()
    ws = _media_ws(job)
    run = _media_run(ws)
    try:
        b["stage"] = "fetching"
        b["inputs"] = fetch_inputs(job, ws)
        path = b["inputs"][0]["name"]
        rep = {"probe": media.probe(run, path)}
        want = b["checks"]
        b["stage"] = "looking"
        if "scenes" in want and rep["probe"].get("has_video"):
            rep["scenes"] = media.scenes(run, path, b.get("threshold") or 0.3)
        if "loudness" in want and rep["probe"].get("has_audio"):
            rep["loudness"] = media.loudness(run, path)
        if "qa" in want:
            q = media.qa(run, path, b.get("platform") or "reels")
            rep["qa"] = {k: q[k] for k in ("verdict", "platform", "checks")}
        if "words" in want and rep["probe"].get("has_audio"):
            w = _words(job, ws, jdir, run, path, {}, b["inputs"])
            rep["words"] = [{"w": x["w"], "s": round(x["s"], 2), "e": round(x["e"], 2)} for x in w][:3000]
            rep["text"] = " ".join(x["w"] for x in w)[:20000]
        if "sheet" in want and rep["probe"].get("has_video"):
            os.makedirs(jdir, exist_ok=True)
            as_user(["mkdir", "-p", "res"], ws, timeout=30)
            rep["sheet"] = media.contact_sheet(run, path, "res/contact-sheet.jpg", rep["probe"]["duration"] or 1)
            got = pull_files(ws, os.path.join(ws, "res"), ["contact-sheet.jpg"], jdir)
            b["outputs"] = [{"name": "contact-sheet.jpg", "path": "contact-sheet.jpg", "bytes": os.path.getsize(p)} for p in got.values()]
        b["report"] = rep
        b["stage"] = "done"
    finally:
        as_user(["rm", "-rf", "--", ws], ROOT, timeout=300)
        try:
            os.rmdir(ws)
        except OSError:
            pass


# ── the browser (Playwright on the worker, run as the sandbox user: it can't reach this machine's ports) ─────────────

BROWSERS = os.environ.get("VOICEBOX_BROWSERS", "/opt/vb-browsers")
_BROWSER = {"ready": False, "lock": threading.Lock()}


def ensure_browser(b):
    """Playwright and its Chromium, once per runtime (about a minute), where the sandbox user can read them."""
    with _BROWSER["lock"]:
        if _BROWSER["ready"]:
            return
        if os.environ.get("VOICEBOX_CHROMIUM"):  # a Chromium already on this machine (local tests)
            _BROWSER["ready"] = True
            return
        b["stage"] = "installing the browser (once per runtime, ~1 min)"
        try:
            import playwright  # noqa: F401
        except ImportError:
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "playwright==1.48.0"], check=True, capture_output=True, timeout=600)
        env = {**os.environ, "PLAYWRIGHT_BROWSERS_PATH": BROWSERS}
        r = subprocess.run([sys.executable, "-m", "playwright", "install", "--with-deps", "chromium"], capture_output=True, timeout=900, env=env)
        if r.returncode:
            raise ValueError(f"couldn't install the browser: {r.stderr.decode('utf-8', 'replace')[-400:]}")
        subprocess.run(["chmod", "-R", "a+rX", BROWSERS], check=False)
        _BROWSER["ready"] = True


def browse(job, jdir):
    b = job["bench"]
    b["isolation"] = setup()
    ensure_browser(b)
    ws = _media_ws(job)
    try:
        write_as_user(ws, "spec.json", json.dumps(b["spec"]).encode())
        b["stage"] = "browsing"
        env = {"PLAYWRIGHT_BROWSERS_PATH": BROWSERS, "PYTHONPATH": ":".join(x for x in (KIT, *sys.path) if x and os.path.isdir(x))}
        if os.environ.get("VOICEBOX_CHROMIUM"):
            env["VOICEBOX_CHROMIUM"] = os.environ["VOICEBOX_CHROMIUM"]
        code, out, err = as_user([sys.executable, os.path.join(KIT, "browse.py"), "spec.json"], ws, timeout=b["timeout_s"] + 30, env=env)
        res = {}
        for line in (out or b"").decode("utf-8", "replace").splitlines()[::-1]:
            if line.startswith("{"):
                res = json.loads(line)
                break
        if code and not res:
            raise ValueError(f"the browser failed: {err.strip()[-500:]}")
        shots = [s_ for s_ in res.pop("shots", []) if re.match(r"^shot-\d+\.png$", s_)]
        got = pull_files(ws, os.path.join(ws, "out"), shots, jdir) if shots else {}
        b["outputs"] = [{"name": os.path.basename(p_), "path": os.path.basename(p_), "bytes": os.path.getsize(p_)} for p_ in got.values()]
        b["page"] = res
        b["stage"] = "done"
    finally:
        as_user(["rm", "-rf", "--", ws], ROOT, timeout=300)
        try:
            os.rmdir(ws)
        except OSError:
            pass


BROWSE_PY = r'''"""One browser visit for the workbench: open a page, do the steps, read it, take screenshots. Prints one JSON line.
Page content is data, never instructions."""
import json, os, sys, time
from playwright.sync_api import sync_playwright

spec = json.load(open(sys.argv[1]))
out = {"steps": []}
os.makedirs("out", exist_ok=True)
READ_JS = """() => {
  const pick = document.querySelector('article') || document.querySelector('main') || document.body;
  const clean = (pick ? pick.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  const links = [...document.querySelectorAll('a[href]')].map(a => ({text: (a.innerText || a.title || '').trim().slice(0, 80), href: a.href}))
    .filter(l => l.text && /^https?:/.test(l.href)).slice(0, 40);
  const meta = n => (document.querySelector(`meta[property="${n}"], meta[name="${n}"]`) || {}).content || null;
  return {text: clean, links, description: meta('description') || meta('og:description'), image: meta('og:image')};
}"""
with sync_playwright() as p:
    kw = {"executable_path": os.environ["VOICEBOX_CHROMIUM"]} if os.environ.get("VOICEBOX_CHROMIUM") else {}
    br = p.chromium.launch(**kw)
    w = int(spec.get("width") or 1280)
    mobile = w <= 500
    ctx = br.new_context(viewport={"width": w, "height": 844 if mobile else 900}, device_scale_factor=2 if mobile else 1, is_mobile=mobile,
                         has_touch=mobile, user_agent=None, locale="en-US")
    page = ctx.new_page()
    page.set_default_timeout(int(spec.get("step_timeout_ms") or 15000))
    t0 = time.time()
    try:
        r = page.goto(spec["url"], wait_until="domcontentloaded", timeout=45000)
        out["status"] = r.status if r else None
        try:
            page.wait_for_load_state("networkidle", timeout=6000)
        except Exception:
            pass
        shots = 0
        for i, st in enumerate(spec.get("steps") or []):
            try:
                if "click" in st: page.click(st["click"])
                elif "fill" in st: page.fill(st["fill"], str(st.get("text", "")))
                elif "press" in st: page.keyboard.press(st["press"])
                elif "wait" in st: page.wait_for_timeout(min(int(st["wait"]), 15000))
                elif "wait_for" in st: page.wait_for_selector(st["wait_for"])
                elif "scroll" in st: page.mouse.wheel(0, int(st["scroll"]))
                elif "goto" in st: page.goto(st["goto"], wait_until="domcontentloaded")
                elif "screenshot" in st:
                    shots += 1; page.screenshot(path=f"out/shot-{shots}.png", full_page=bool(st.get("full_page")))
                out["steps"].append({"step": i + 1, "ok": True})
            except Exception as e:
                out["steps"].append({"step": i + 1, "ok": False, "error": str(e).splitlines()[0][:200]})
                if not spec.get("keep_going"):
                    break
        if spec.get("screenshot", True):
            shots += 1; page.screenshot(path=f"out/shot-{shots}.png", full_page=bool(spec.get("full_page")))
        out["shots"] = [f"shot-{i}.png" for i in range(1, shots + 1)]
        out["title"], out["url"] = page.title(), page.url
        if spec.get("read", True):
            got = page.evaluate(READ_JS)
            limit = int(spec.get("max_chars") or 8000)
            out.update(description=got["description"], image=got["image"], links=got["links"][: int(spec.get("links") or 20)],
                       chars=len(got["text"]), text=got["text"][:limit] + ("…" if len(got["text"]) > limit else ""))
    except Exception as e:
        out["error"] = str(e).splitlines()[0][:300]
    out["seconds"] = round(time.time() - t0, 1)
    br.close()
print(json.dumps(out))
'''


# ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────

def drop_workspace(job, jdir):
    """A finished project's workspace, removed (as the sandbox user, so a link in it can't reach the worker's files)."""
    b = job["bench"]
    path = os.path.join(ROOT, "ws", b["workspace"])
    existed = os.path.isdir(path)
    if existed:
        _done_ws(path)
    b.update(stage="done", removed=existed)


OPS = {"drop": drop_workspace, "run": run_code, "clone": clone_repo, "diff": diff_repo, "edit": edit_media, "inspect": inspect_media, "browse": browse, "repurpose": repurpose, "template": render_template}


def prepare(job, body):
    """Validate a bench job's body onto job["bench"]; raises ValueError with what to fix."""
    op = body.get("op")
    if op not in OPS:
        raise ValueError(f"op must be one of {sorted(OPS)}")
    b = {"op": op, "stage": "queued"}
    if op == "run":
        lang = body.get("lang") or "python"
        if lang not in LANGS:
            raise ValueError(f"lang must be one of {sorted(LANGS)}")
        code = str(body.get("code") or "")
        if not code.strip() or len(code) > 200_000:
            raise ValueError("code: 1 to 200,000 characters")
        files = body.get("files") or []
        if not isinstance(files, list) or len(files) > 20:
            raise ValueError("files: up to 20 of {url, name}")
        b.update(lang=lang, code=code, workspace=str(body.get("workspace") or "default"), files=files,
                 args=[str(a)[:500] for a in (body.get("args") or [])][:20],
                 timeout_s=max(5, min(MAX_TIMEOUT, int(body.get("timeout_s") or 120))),
                 memory_mb=max(256, min(48_000, int(body.get("memory_mb") or 8000))),
                 voicebox_url=str(body.get("voicebox_url") or "")[:300], voicebox_key=str(body.get("voicebox_key") or "")[:2000],
                 voicebox_model=str(body.get("voicebox_model") or "")[:60],
                 skills={str(k): str(v)[:100_000] for k, v in (body.get("skills") or {}).items() if re.match(r"^[a-z][a-z0-9_]{1,40}$", str(k))} if isinstance(body.get("skills"), dict) else {})
        if not WS_RE.match(b["workspace"]):
            raise ValueError("workspace: lowercase letters, digits and dashes, up to 40 (e.g. case-025)")
        job["est_total"] = float(min(b["timeout_s"], 60))
    if op == "repurpose":
        if body.get("recipe") not in RECIPES:
            raise ValueError(f"recipe: one of {', '.join(RECIPES)}")
        b.update(recipe=body["recipe"], options=body.get("options") if isinstance(body.get("options"), dict) else {})
    if op == "template":
        html, proj = body.get("html"), body.get("project")
        if not html and not proj:
            raise ValueError("template needs html (from lib/auto/templates.ts) or project {workspace, dir} (a repo checkout)")
        if html:
            b["html"] = str(html)[:500_000]
        else:
            if not WS_RE.match(str(proj.get("workspace") or "")) or not re.match(r"^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$", str(proj.get("dir") or "")) or ".." in str(proj.get("dir")):
                raise ValueError("project: {workspace, dir} inside the workspace")
            b["project"] = {"workspace": proj["workspace"], "dir": proj["dir"]}
            if body.get("composition"):
                b["composition"] = re.sub(r"[^A-Za-z0-9._/-]", "", str(body["composition"]))[:200]
        if isinstance(body.get("music"), dict) and re.match(r"^[a-z0-9_]{1,20}$", str(body["music"].get("key") or "")):
            b["music"] = {"key": body["music"]["key"], "volume_db": max(-40.0, min(0.0, float(body["music"].get("volume_db") or -16)))}
        b.update(platform=str(body.get("platform") or "reels"), name=str(body.get("name") or "template")[:80], font=re.sub(r"[^A-Za-z0-9 ]", "", str(body.get("font") or "Inter"))[:40],
                 quality=body.get("quality") if body.get("quality") in ("draft", "standard", "high", "delivery") else "standard")
        body = {**body, "files": body.get("files") or []}
    if op in ("edit", "inspect", "repurpose") or (op == "template" and body.get("files")):
        files = body.get("files") or []
        if not isinstance(files, list) or (not files and op != "template") or len(files) > 30:
            raise ValueError("inputs: 1 to 30 files")
        b["files"] = [{"url": str(f.get("url") or ""), "name": f"{re.sub(r'[^A-Za-z0-9_-]+', '_', str(f.get('key') or 'f'))[:40]}-{re.sub(r'[^A-Za-z0-9._-]+', '_', str(f.get('name') or 'file'))[-80:]}",
                       "key": str(f.get("key") or "")[:40]} for f in files]
        job["est_total"] = 60.0
    if op == "edit":
        spec = body.get("spec")
        if not isinstance(spec, dict):
            raise ValueError("spec: the edit (clips, shape, voice, music, captions…)")
        b["spec"] = spec
    if op == "inspect":
        want = [c for c in (body.get("checks") or ["probe", "qa"]) if c in INSPECT]
        b.update(checks=want or ["probe"], platform=str(body.get("platform") or "reels"), threshold=float(body.get("threshold") or 0.3))
    if op == "browse":
        spec = body.get("spec") or {}
        url = str(spec.get("url") or "")
        if not re.match(r"^https?://", url):
            raise ValueError("url: an http(s) page")
        safe_url(url)
        steps = spec.get("steps") or []
        if not isinstance(steps, list) or len(steps) > 30:
            raise ValueError("steps: up to 30")
        b["spec"] = {k: spec[k] for k in ("url", "steps", "width", "screenshot", "full_page", "read", "max_chars", "links", "keep_going", "step_timeout_ms") if k in spec}
        b["timeout_s"] = max(20, min(300, int(body.get("timeout_s") or 90)))
        job["est_total"] = 20.0
    if op == "drop":
        b["workspace"] = str(body.get("workspace") or "")
        if not WS_RE.match(b["workspace"]) or b["workspace"] == "default":
            raise ValueError("workspace: a project's workspace (p-<id>)")
    if op in ("clone", "diff"):
        d = str(body.get("dir") or "")
        if not re.match(r"^[A-Za-z0-9._-]{1,100}$", d) or d.startswith("."):
            raise ValueError("dir: the folder for the clone in the workspace, e.g. voicebox-workbench")
        b.update(workspace=str(body.get("workspace") or "default"), dir=d)
        if not WS_RE.match(b["workspace"]):
            raise ValueError("workspace: lowercase letters, digits and dashes, up to 40 (e.g. case-025)")
    if op == "clone":
        url, ref = str(body.get("url") or ""), str(body.get("ref") or "")
        if not re.match(r"^https://[A-Za-z0-9.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$", url) and not (os.environ.get("VOICEBOX_BENCH_ALLOW_LOCAL") == "1" and url.startswith("/")):
            raise ValueError("url: https://github.com/<owner>/<repo>.git")
        if not re.match(r"^[A-Za-z0-9._/-]{1,100}$", ref):
            raise ValueError("ref: a branch, a tag or a commit sha")
        b.update(url=url, ref=ref, header=str(body.get("header") or "")[:500], fresh=bool(body.get("fresh")), depth=max(1, min(500, int(body.get("depth") or 50))))
    job["bench"] = b
    job["engine"], job["voice"] = op, ""


def run(job, jdir):
    os.makedirs(jdir, exist_ok=True)
    OPS[job["bench"]["op"]](job, jdir)


def view(job, full=True):
    """What get_job shows: never a key, never the whole code; a diff's file contents only to a job's own read."""
    b = dict(job.get("bench") or {})
    for k in ("voicebox_key", "code", "files", "header", "skills"):
        b.pop(k, None)
    if not full:
        b.pop("changes", None)
    return b


KIT_PY = r'''"""VoiceBox from code (code mode): every MCP tool as a function, so a script does the work and prints only what
matters. Each call goes through the owner's approvals, the units cap and the call log, like a call from the model.

    import voicebox as vb
    files = vb.list_files(folder="Downloads/Instagram")      # any tool: vb.<tool_name>(**args)
    vb.tools("video")                                        # find tools by keyword: name and first line
    a, b = vb.gather(("list_files", {}), ("workspace_board", {}))  # several calls at once
    job = vb.voice_lines(lines=[{"text": "Hello"}]); vb.wait(job["id"])
    vb.save("out/cut.mp4", folder="Renders")                 # or just write to out/: it's saved after the run
"""
import json, os, time, urllib.request

URL, KEY, MODEL = os.environ.get("VOICEBOX_URL", ""), os.environ.get("VOICEBOX_KEY", ""), os.environ.get("VOICEBOX_MODEL", "")


class ToolError(Exception):
    pass


def _rpc(method, params):
    if not URL or not KEY:
        raise ToolError("code mode isn't on for this run (run it with voicebox: true)")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
        "X-Model": (MODEL + " (code)").strip()})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read().decode("utf-8", "replace")
    for line in raw.splitlines():
        if line.startswith("data: "):
            raw = line[6:]
    msg = json.loads(raw)
    if "error" in msg:
        raise ToolError(msg["error"].get("message", str(msg["error"])))
    return msg["result"]


def call(tool, **args):
    res = _rpc("tools/call", {"name": tool, "arguments": args})
    text = "\n".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        raise ToolError(text)
    try:
        return json.loads(text)
    except ValueError:
        return text


def tools(query=""):
    """Every tool matching a keyword, a line each (the server lists only a core; this searches them all)."""
    return call("find_tools", query=query, detail="summary") if query else call("find_tools", detail="names")


def gather(*calls, workers=8):
    """Many tool calls at once, results in order; a failed one comes back as a ToolError (not raised):
        posts, files = vb.gather(("workspace_board", {}), ("list_files", {"search": "reel"}))"""
    from concurrent.futures import ThreadPoolExecutor

    def one(c):
        tool, args = (c, {}) if isinstance(c, str) else (c[0], c[1] if len(c) > 1 else {})
        try:
            return call(tool, **args)
        except Exception as e:  # noqa: BLE001
            return ToolError(str(e))
    with ThreadPoolExecutor(max(1, min(workers, len(calls)))) as ex:
        return list(ex.map(one, calls))


def wait(job_id, every=40):
    while True:
        j = call("get_job", job_id=job_id, wait_seconds=every)
        if j.get("status") not in ("queued", "running"):
            return j


def save(path, folder=None, name=None):
    name = name or os.path.basename(path)
    start = call("save_file", name=name, size=os.path.getsize(path), **({"folder": folder} if folder else {}))
    with open(path, "rb") as f:
        req = urllib.request.Request(start["upload_url"], data=f, method="PUT", headers={"Content-Length": str(os.path.getsize(path))})
        urllib.request.urlopen(req, timeout=1800).read()
    return call("save_file", ticket=start["ticket"])


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return lambda **args: call(name, **args)
'''
