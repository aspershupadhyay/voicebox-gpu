"""The workbench (docs/AUTOMATION.md): what a model asks the worker to do beyond voice. One job kind, "bench", with an
op: run (phase 2: code in a sandbox). Later ops (media edits, inspections, the browser, templates) plug into OPS.

The sandbox: code runs as its own Linux user (vbsandbox) in a workspace folder of its own, with a clean environment
(none of the worker's secrets), no way into the worker's home (/content/voicebox is closed to other users), a time
limit, a memory watchdog and trimmed output. A workspace lives as long as the runtime; files the code writes to out/
are saved to Files by the dashboard. Code mode: `import voicebox` calls any VoiceBox tool from the script with a key
that lasts as long as the run (it still goes through the owner's approvals, the units cap and the call log), so a
script can filter a thousand rows and print five instead of passing them through the model."""
import ipaddress, json, os, pwd, re, shutil, signal, socket, stat, subprocess, sys, threading, time, urllib.parse

import config as C

ROOT = os.environ.get("VOICEBOX_SANDBOX", "/content/sandbox")
USER = "vbsandbox"
KIT = os.path.join(ROOT, ".kit")
WS_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
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
    for name, body in (("voicebox.py", KIT_PY), ("browse.py", BROWSE_PY)):
        with open(os.path.join(KIT, name), "w") as f:
            f.write(body)
        os.chmod(os.path.join(KIT, name), 0o644)
    os.chmod(KIT, 0o755)


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
    before = snapshot(os.path.join(ws, "out"))
    env = {**BASE_ENV, "HOME": ws, "PYTHONPATH": KIT, "PYTHONUNBUFFERED": "1", "MPLBACKEND": "Agg", "TMPDIR": os.path.join(ws, ".tmp"),
           "PIP_USER": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PYTHONUSERBASE": os.path.join(ws, ".local"), "VOICEBOX_WORKSPACE": ws}
    for k in ("VOICEBOX_URL", "VOICEBOX_KEY", "VOICEBOX_MODEL"):
        if b.get(k.lower()):
            env[k] = b[k.lower()]
    for k in ("CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "LD_LIBRARY_PATH"):  # the GPU, not the secrets
        if os.environ.get(k):
            env[k] = os.environ[k]
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
    r = subprocess.run(["git", "-c", f"http.extraHeader={key}", "-c", "core.hooksPath=/dev/null", "clone", "--depth", str(b["depth"]),
                        "--branch", b["ref"], "--", b["url"], stage], capture_output=True, timeout=900, env={**BASE_ENV, "HOME": jdir, "GIT_TERMINAL_PROMPT": "0"})
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


def edit_media(job, jdir):
    import media
    b = job["bench"]
    b["isolation"] = setup()
    ws = _media_ws(job)
    run = _media_run(ws)
    try:
        b["stage"] = "fetching"
        b["inputs"] = fetch_inputs(job, ws)
        infos = {}
        for i in b["inputs"]:
            infos[i["key"]] = (i["name"], media.probe(run, i["name"]))
        spec = dict(b["spec"])
        for k in ("voice", "music", "logo"):
            if spec.get(k) and spec[k].get("src") not in infos:
                raise ValueError(f"{k}.src: no input called {spec[k].get('src')!r} (inputs: {', '.join(infos)})")
        nv = media.has_nvenc()
        args, layout, seconds, extra = media.plan_edit(spec, {k: v for k, v in infos.items() if not v[0].lower().endswith(".srt")}, nv, media.font_file())
        for name, content in extra.items():
            write_as_user(ws, name, content.encode())
        b["stage"] = f"rendering {seconds:.0f} s ({'NVENC on the GPU' if nv else 'x264 on the CPU'})"
        t0 = time.time()
        code, _, err = run(args, timeout=3600)
        if code:
            raise ValueError(f"ffmpeg failed: {err.strip()[-900:]}")
        final = "out.mp4"
        if spec.get("captions"):
            words = _words(job, ws, jdir, run, "out.mp4", spec["captions"], b["inputs"])
            info = media.probe(run, "out.mp4")
            cap = spec["captions"]
            ass, boxes = media.captions_ass(words, info["width"], info["height"], cap.get("style") or "pop", cap.get("position") or "lower",
                                            platform=spec.get("platform") or "reels")
            write_as_user(ws, "captions.ass", ass.encode())
            layout += boxes
            b["stage"] = "burning in the captions"
            enc = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0"] if nv else ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]
            code, _, err = run(["ffmpeg", "-hide_banner", "-y", "-nostats", "-i", "out.mp4", "-vf", "subtitles=filename=captions.ass", *enc, "-pix_fmt", "yuv420p",
                                "-c:a", "copy", "-movflags", "+faststart", "final.mp4"], timeout=3600)
            if code:
                raise ValueError(f"captions failed: {err.strip()[-600:]}")
            final = "final.mp4"
            b["captions"] = {"words": len(words), "style": cap.get("style") or "pop"}
        b["render_s"] = round(time.time() - t0, 1)
        b["stage"] = "checking"
        b["qa"] = media.qa(run, final, spec.get("platform") or "reels", layout)
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(spec.get("name") or "edit"))[:80].removesuffix(".mp4") + ".mp4"
        write_as_user(ws, f"res/{name}", b"")  # the result's own folder, so pull_files names it plainly
        as_user(["mv", "-f", final, f"res/{name}"], ws, timeout=60)
        got = pull_files(ws, os.path.join(ws, "res"), [name], jdir)
        b["outputs"] = [{"name": name, "path": name, "bytes": os.path.getsize(p)} for p in got.values()]
        b["seconds_out"] = seconds
        b["stage"] = "done"
    finally:
        as_user(["rm", "-rf", "--", ws], ROOT, timeout=300)
        try:
            os.rmdir(ws)
        except OSError:
            pass


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

OPS = {"run": run_code, "clone": clone_repo, "diff": diff_repo, "edit": edit_media, "inspect": inspect_media, "browse": browse}


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
                 voicebox_model=str(body.get("voicebox_model") or "")[:60])
        if not WS_RE.match(b["workspace"]):
            raise ValueError("workspace: lowercase letters, digits and dashes, up to 40 (e.g. case-025)")
        job["est_total"] = float(min(b["timeout_s"], 60))
    if op in ("edit", "inspect"):
        files = body.get("files") or []
        if not isinstance(files, list) or not files or len(files) > 30:
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
            raise ValueError("ref: a branch or tag")
        b.update(url=url, ref=ref, header=str(body.get("header") or "")[:500], fresh=bool(body.get("fresh")), depth=max(1, min(500, int(body.get("depth") or 50))))
    job["bench"] = b
    job["engine"], job["voice"] = op, ""


def run(job, jdir):
    os.makedirs(jdir, exist_ok=True)
    OPS[job["bench"]["op"]](job, jdir)


def view(job, full=True):
    """What get_job shows: never a key, never the whole code; a diff's file contents only to a job's own read."""
    b = dict(job.get("bench") or {})
    for k in ("voicebox_key", "code", "files", "header"):
        b.pop(k, None)
    if not full:
        b.pop("changes", None)
    return b


KIT_PY = r'''"""VoiceBox from code (code mode): every MCP tool as a function, so a script does the work and prints only what
matters. Each call goes through the owner's approvals, the units cap and the call log, like a call from the model.

    import voicebox as vb
    files = vb.list_files(folder="Downloads/Instagram")      # any tool: vb.<tool_name>(**args)
    vb.tools("video")                                        # find tools by keyword: name and first line
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
    q = query.lower()
    out = []
    for t in _rpc("tools/list", {})["tools"]:
        d = (t.get("description") or "").split(". ")[0][:160]
        if q in t["name"].lower() or q in d.lower():
            out.append(f"{t['name']}: {d}")
    return out


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
