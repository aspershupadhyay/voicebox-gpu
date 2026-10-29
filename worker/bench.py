"""The workbench (docs/AUTOMATION.md): what a model asks the worker to do beyond voice. One job kind, "bench", with an
op: run (phase 2: code in a sandbox). Later ops (media edits, inspections, the browser, templates) plug into OPS.

The sandbox: code runs as its own Linux user (vbsandbox) in a workspace folder of its own, with a clean environment
(none of the worker's secrets), no way into the worker's home (/content/voicebox is closed to other users), a time
limit, a memory watchdog and trimmed output. A workspace lives as long as the runtime; files the code writes to out/
are saved to Files by the dashboard. Code mode: `import voicebox` calls any VoiceBox tool from the script with a key
that lasts as long as the run (it still goes through the owner's approvals, the units cap and the call log), so a
script can filter a thousand rows and print five instead of passing them through the model."""
import ipaddress, json, os, pwd, re, shutil, signal, socket, subprocess, threading, time, urllib.parse, urllib.request

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
            if shutil.which("iptables"):
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
    with open(os.path.join(KIT, "voicebox.py"), "w") as f:
        f.write(KIT_PY)
    os.chmod(KIT, 0o755)
    os.chmod(os.path.join(KIT, "voicebox.py"), 0o644)


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
    """Inputs are fetched by the worker: https/http to the internet only, never this machine or a private network."""
    p = urllib.parse.urlparse(str(u or ""))
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError(f"not a web address: {str(u)[:80]}")
    for info in socket.getaddrinfo(p.hostname, None):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            if os.environ.get("VOICEBOX_BENCH_ALLOW_LOCAL") != "1":  # local tests only
                raise ValueError(f"{p.hostname} is a private address")
    return p.geturl()


def fetch_inputs(job, ws):
    got = []
    for f in job["bench"].get("files") or []:
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(f.get("name") or "file"))[:120] or "file"
        dst = os.path.join(ws, "in", name)
        req = urllib.request.Request(safe_url(f.get("url")), headers={"User-Agent": "voicebox-bench"})
        with urllib.request.urlopen(req, timeout=300) as r, open(dst, "wb") as out:
            shutil.copyfileobj(r, out, 1 << 20)
        ids = _ids()
        if ids:
            os.lchown(dst, *ids)
        got.append({"name": f"in/{name}", "mb": round(os.path.getsize(dst) / 1e6, 2)})
    return got


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
    out = {}
    for dirpath, _, files in os.walk(d):
        for n in files:
            p = os.path.join(dirpath, n)
            try:
                st = os.stat(p)
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
    code_path = os.path.join(ws, ".run", f"{job['id']}-{fname}")
    os.makedirs(os.path.dirname(code_path), exist_ok=True)
    with open(code_path, "w") as f:
        f.write(b["code"])
    ids = _ids()
    if ids:
        for p in (os.path.dirname(code_path), code_path):
            os.lchown(p, *ids)
    before = snapshot(os.path.join(ws, "out"))
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": ws, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
           "PYTHONPATH": KIT, "PYTHONUNBUFFERED": "1", "MPLBACKEND": "Agg", "TMPDIR": os.path.join(ws, ".tmp"),
           "PIP_USER": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PYTHONUSERBASE": os.path.join(ws, ".local"),
           "VOICEBOX_WORKSPACE": ws}
    for k in ("VOICEBOX_URL", "VOICEBOX_KEY", "VOICEBOX_MODEL"):
        if b.get(k.lower()):
            env[k] = b[k.lower()]
    for k in ("CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "LD_LIBRARY_PATH"):  # the GPU, not the secrets
        if os.environ.get(k):
            env[k] = os.environ[k]
    os.makedirs(env["TMPDIR"], exist_ok=True)
    if ids:
        os.lchown(env["TMPDIR"], *ids)

    def drop():
        os.setsid()
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE, (4 << 30, 4 << 30))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if ids:
            os.setgroups([])
            os.setgid(ids[1])
            os.setuid(ids[0])

    out_p, err_p = os.path.join(jdir, "stdout.txt"), os.path.join(jdir, "stderr.txt")
    b["stage"] = "running"
    t0 = time.time()
    killed = None
    with open(out_p, "wb") as so, open(err_p, "wb") as se:
        p = subprocess.Popen(cmd + [code_path] + [str(a) for a in b.get("args") or []], cwd=ws, env=env, stdout=so, stderr=se,
                             stdin=subprocess.DEVNULL, preexec_fn=drop)
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
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                p.wait()
                break
            with open(out_p, "rb") as f:  # the live tail, for get_job while it runs
                f.seek(max(0, os.path.getsize(out_p) - 1500))
                b["tail"] = f.read().decode("utf-8", "replace")
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
    collect_outputs(job, jdir, os.path.join(ws, "out"), before)
    b["stage"] = "done"


def collect_outputs(job, jdir, out_dir, before):
    """New or changed files in out/ are copied next to the job, for the dashboard to save into Files."""
    b = job["bench"]
    after = snapshot(out_dir)
    changed = sorted(k for k, v in after.items() if before.get(k) != v)
    files, total = [], 0
    for rel in changed[:MAX_OUT_FILES]:
        size = after[rel][1]
        if total + size > MAX_OUT_BYTES:
            b.setdefault("notes", []).append(f"{rel} left out: outputs go up to 2 GB a run")
            continue
        flat = re.sub(r"[^A-Za-z0-9._-]+", "_", rel.replace("/", "__"))[-120:]
        shutil.copy2(os.path.join(out_dir, rel), os.path.join(jdir, flat))
        total += size
        files.append({"name": flat, "path": f"out/{rel}", "bytes": size})
    if len(changed) > MAX_OUT_FILES:
        b.setdefault("notes", []).append(f"{len(changed) - MAX_OUT_FILES} more files in out/ weren't kept (40 a run)")
    b["outputs"] = files


# ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────

OPS = {"run": run_code}


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
    job["bench"] = b
    job["engine"], job["voice"] = op, ""


def run(job, jdir):
    os.makedirs(jdir, exist_ok=True)
    OPS[job["bench"]["op"]](job, jdir)


def view(job):
    """What get_job shows: never the key, never the whole code."""
    b = dict(job.get("bench") or {})
    for k in ("voicebox_key", "code", "files"):
        b.pop(k, None)
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
