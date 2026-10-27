"""Ask Voicebox on the worker: Antigravity CLI (agy), signed in with the owner's Google account, so the dashboard's
assistant runs on their Google AI plan instead of an API key. agy needs no GPU (the model runs at Google); it reaches
the Voicebox tools through the dashboard's MCP server with a token minted for one conversation (mcp/lib/agy.ts).

- install(): agy from Google's installer, into HOME/agy/bin (once per runtime, ~230 MB).
- Sign-in: agy prints a Google link and waits up to 60 s for the code that page shows. start_login() runs it in a
  pseudo-terminal and hands the link to the dashboard; send_code() types the code in. The sign-in files then go back
  to the dashboard (sealed there), and restore() puts them in place on the next fresh runtime.
- run(): one `agy -p` per message, in an empty folder, with none of the worker's secrets in its environment.
"""
import base64, io, json, os, pty, re, select, shutil, subprocess, tarfile, threading, time, urllib.request, uuid

import config as C

AGY_HOME = os.path.join(C.HOME, "agy")
BIN = os.path.join(AGY_HOME, "bin", "agy")
WORK = os.path.join(AGY_HOME, "work")
FLAG = os.path.join(AGY_HOME, ".signed_in")
INSTALLER = "https://antigravity.google/cli/install.sh"
URL_RE = re.compile(r"https://accounts\.google\.com/\S+")
SKIP = {"bin", "work", "install.sh", "log", "crashes", "builtin", "updater"}  # not part of a sign-in
MAX_BLOB = 8 * 1024 * 1024

_install_lock = threading.Lock()
LOGIN = {}  # the sign-in in progress: proc, fd, url, started, out
RUNS = {}   # ask id -> run state
ACTIVE = [0.0]  # last time a run did something (the gateway counts it as activity)


def log(*a):
    print("[ask]", *a, flush=True)


def env():
    """agy gets a clean environment: its own HOME and nothing of the worker's (no WORKER_SECRET, no R2 keys)."""
    return {"HOME": AGY_HOME, "PATH": f"{os.path.dirname(BIN)}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "TERM": "dumb", "NO_COLOR": "1"}


def installed():
    return os.path.exists(BIN)


def install():
    with _install_lock:
        if installed():
            return
        os.makedirs(os.path.dirname(BIN), exist_ok=True)
        script = os.path.join(AGY_HOME, "install.sh")
        with urllib.request.urlopen(INSTALLER, timeout=60) as r, open(script, "wb") as f:
            f.write(r.read())
        t = time.time()
        p = subprocess.run(["bash", script, "-d", os.path.dirname(BIN)], env=env(), capture_output=True, text=True, timeout=600)
        if not installed():
            raise RuntimeError(f"installing Antigravity CLI failed: {(p.stderr or p.stdout)[-400:]}")
        log(f"installed agy in {time.time() - t:.0f}s")


def signed_in():
    return os.path.exists(FLAG)


def _email():
    try:
        return json.load(open(FLAG)).get("email")
    except Exception:
        return None


def status():
    lg = LOGIN if LOGIN.get("proc") and LOGIN["proc"].poll() is None else None
    return {"installed": installed(), "signed_in": signed_in(), "email": _email(),
            "login": {"url": lg["url"], "expires": lg["started"] + 60} if lg and lg.get("url") else None,
            "running": sum(1 for r in RUNS.values() if r["status"] == "running")}


# ── sign-in

def _reader(fd, out):
    while True:
        try:
            r, _, _ = select.select([fd], [], [], 1.0)
            if not r:
                if LOGIN.get("proc") is None or LOGIN["proc"].poll() is not None:
                    return
                continue
            chunk = os.read(fd, 4096)
            if not chunk:
                return
            out.append(chunk.decode("utf-8", "replace"))
        except OSError:
            return


def _stop_login():
    p = LOGIN.get("proc")
    if p and p.poll() is None:
        p.kill()
    if LOGIN.get("fd") is not None:
        try:
            os.close(LOGIN["fd"])
        except OSError:
            pass
    LOGIN.clear()


def start_login():
    install()
    _stop_login()
    os.makedirs(WORK, exist_ok=True)
    master, slave = pty.openpty()
    proc = subprocess.Popen([BIN, "-p", "Reply with just: OK", "--print-timeout", "120s"], cwd=WORK, env=env(),
                            stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    out = []
    LOGIN.update(proc=proc, fd=master, url=None, started=time.time(), out=out)
    threading.Thread(target=_reader, args=(master, out), daemon=True).start()
    until = time.time() + 45
    while time.time() < until:
        m = URL_RE.search("".join(out))
        if m:
            LOGIN["url"], LOGIN["started"] = m.group(0), time.time()
            return {"url": LOGIN["url"], "expires": LOGIN["started"] + 60}
        if proc.poll() is not None:
            text = "".join(out)
            if proc.returncode == 0 and "OK" in text:  # it was signed in already
                _mark({"email": _email()})
                return {"url": None, "expires": 0, "signed_in": True, "blob": pack()}
            raise RuntimeError(f"Antigravity didn't offer a sign-in: {_clean(text)[-300:]}")
        time.sleep(0.3)
    _stop_login()
    raise RuntimeError("Antigravity didn't show a sign-in link in time")


def _clean(s):
    return re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", s).replace("\r", "")


def _mark(info):
    os.makedirs(AGY_HOME, exist_ok=True)
    with open(FLAG, "w") as f:
        json.dump({**info, "at": time.time()}, f)


def send_code(code):
    p = LOGIN.get("proc")
    if not p or p.poll() is not None:
        _stop_login()
        return {"ok": False, "error": "that sign-in timed out (Google gives it a minute): press Sign in again and paste the new code quickly"}
    os.write(LOGIN["fd"], (code.strip() + "\n").encode())
    try:
        p.wait(timeout=80)
    except subprocess.TimeoutExpired:
        _stop_login()
        return {"ok": False, "error": "Antigravity didn't finish signing in"}
    text = _clean("".join(LOGIN.get("out", [])))
    _stop_login()
    if p.returncode != 0 or re.search(r"authentication (failed|timed out)|invalid_grant", text, re.I):
        why = re.findall(r"Error: (.+)", text)
        return {"ok": False, "error": f"Google didn't accept that code ({why[-1].strip()[:160] if why else 'no reason given'}): press Sign in again and paste the new code"}
    m = re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text)
    _mark({"email": m.group(0) if m else None})
    return {"ok": True, "email": m.group(0) if m else None, "blob": pack()}


def pack():
    """The sign-in (agy's state minus the binary, logs and caches) as base64 tar.gz, for the dashboard to keep."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for root, dirs, files in os.walk(AGY_HOME):
            rel = os.path.relpath(root, AGY_HOME)
            dirs[:] = [d for d in dirs if d not in SKIP and not (rel == "." and d in SKIP)]
            for name in files:
                if (rel == "." and name in SKIP) or name == "mcp_config.json":  # that holds a short-lived token
                    continue
                path = os.path.join(root, name)
                if os.path.islink(path) or os.path.getsize(path) > 2 * 1024 * 1024:
                    continue
                tar.add(path, arcname=os.path.relpath(path, AGY_HOME))
    data = buf.getvalue()
    if len(data) > MAX_BLOB:
        raise RuntimeError("Antigravity's sign-in files are unexpectedly large")
    return base64.b64encode(data).decode()


def restore(blob):
    """Put a saved sign-in in place on a fresh runtime (only safe relative paths)."""
    if signed_in() or not blob:
        return
    data = base64.b64decode(blob)
    if len(data) > MAX_BLOB:
        raise ValueError("sign-in blob too large")
    root = os.path.realpath(AGY_HOME)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            dest = os.path.realpath(os.path.join(root, m.name))
            if not dest.startswith(root + os.sep) or not (m.isfile() or m.isdir()):
                raise ValueError(f"unsafe path in the sign-in blob: {m.name}")
        tar.extractall(root, filter="data") if hasattr(tarfile, "data_filter") else tar.extractall(root)
    if not os.path.exists(FLAG):
        _mark({"email": None})
    log("restored the saved Antigravity sign-in")


def logout():
    _stop_login()
    for name in os.listdir(AGY_HOME) if os.path.isdir(AGY_HOME) else []:
        if name not in ("bin", "install.sh"):
            p = os.path.join(AGY_HOME, name)
            shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)
    return {"ok": True}


# ── runs

def _mcp(url, token):
    path = os.path.join(AGY_HOME, ".gemini", "config", "mcp_config.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cfg = {}
    try:
        cfg = json.load(open(path))
    except Exception:
        pass
    cfg.setdefault("mcpServers", {})["voicebox"] = {"serverUrl": url, "headers": {"Authorization": f"Bearer {token}"}, "disabled": False}
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)


def _event(run, ev):
    """One line of agy's stream-json, folded into what the dashboard shows: tool calls and text."""
    if not isinstance(ev, dict):
        return
    for k in ("session_id", "conversation_id", "conversationId", "sessionId"):
        if isinstance(ev.get(k), str):
            run["conversation"] = ev[k]
    typ = str(ev.get("type") or ev.get("event") or "")
    if typ == "result":
        r = ev.get("result") or ev.get("text") or ev.get("response")
        if isinstance(r, str):
            run["text"] = r
        if ev.get("is_error") or ev.get("subtype") == "error":
            run["error"] = str(r or ev.get("error") or "error")
        return
    msg = ev.get("message") if isinstance(ev.get("message"), dict) else ev
    parts = msg.get("content") if isinstance(msg.get("content"), list) else [msg]
    for p in parts:
        if not isinstance(p, dict):
            continue
        name = p.get("name") or p.get("tool") or p.get("tool_name") or (p.get("functionCall") or {}).get("name")
        if p.get("type") in ("tool_use", "tool_call", "toolCall") or (name and p.get("type") not in ("text", "tool_result")):
            if name:
                run["events"].append({"kind": "tool", "tool": str(name).split("/")[-1].split("__")[-1], "ok": True})
        elif p.get("type") in ("tool_result",) and p.get("is_error") and run["events"]:
            run["events"][-1]["ok"] = False
        elif (msg.get("role") in ("assistant", "model") or typ in ("assistant", "text", "message")) and isinstance(p.get("text"), str) and p["text"].strip():
            run["events"].append({"kind": "text", "text": p["text"]})


def _run(run, cmd):
    try:
        proc = subprocess.Popen(cmd, cwd=WORK, env=env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        run["proc"] = proc
        err = []
        threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()
        for line in proc.stdout:
            ACTIVE[0] = time.time()
            line = line.strip()
            if not line:
                continue
            if "Authentication required" in line or URL_RE.search(line):
                proc.kill()
                if os.path.exists(FLAG):
                    os.remove(FLAG)
                raise RuntimeError("Antigravity's Google sign-in has expired: sign in again in Settings → Ask Voicebox")
            try:
                _event(run, json.loads(line))
            except ValueError:
                run["events"].append({"kind": "text", "text": line})
        proc.wait(timeout=30)
        tail = _clean("".join(err))[-400:]
        if "Authentication required" in tail:
            if os.path.exists(FLAG):
                os.remove(FLAG)
            raise RuntimeError("Antigravity's Google sign-in has expired: sign in again in Settings → Ask Voicebox")
        if proc.returncode != 0 and not run.get("text"):
            raise RuntimeError(f"agy exited {proc.returncode}: {tail.strip() or 'no output'}")
        run["status"] = "error" if run.get("error") else "done"
    except Exception as e:
        run["status"], run["error"] = "error", str(e)
    finally:
        run["finished"] = time.time()
        ACTIVE[0] = time.time()
        run.pop("proc", None)


def start(body):
    prompt = str(body.get("prompt") or "")[:60_000]
    url, token = str(body.get("mcp_url") or ""), str(body.get("token") or "")
    if not prompt or not url.startswith("https://") or not token:
        raise ValueError("prompt, mcp_url (https) and token are needed")
    if sum(1 for r in RUNS.values() if r["status"] == "running") >= 2:
        raise ValueError("two Ask Voicebox runs are already going: wait for one to finish")
    install()
    restore(body.get("auth"))
    if not signed_in():
        raise ValueError("Antigravity isn't signed in on this worker: Settings → Ask Voicebox → Sign in with Google")
    os.makedirs(WORK, exist_ok=True)
    _mcp(url, token)
    conv = body.get("conversation")
    cmd = [BIN, "-p", prompt, "--output-format", "stream-json", "--dangerously-skip-permissions", "--print-timeout", "900s"]
    if isinstance(conv, str) and re.fullmatch(r"[\w-]{4,80}", conv):
        cmd += ["--conversation", conv]
    rid = uuid.uuid4().hex[:12]
    run = {"id": rid, "status": "running", "events": [], "text": None, "conversation": conv, "error": None, "started": time.time()}
    RUNS[rid] = run
    for k in [k for k, r in RUNS.items() if r["status"] != "running" and time.time() - r.get("finished", 0) > 3600]:
        RUNS.pop(k, None)
    threading.Thread(target=_run, args=(run, cmd), daemon=True).start()
    return {"id": rid}


def view(rid):
    r = RUNS.get(rid)
    if not r:
        return None
    return {k: r.get(k) for k in ("id", "status", "events", "text", "conversation", "error")}


def cancel(rid):
    r = RUNS.get(rid)
    if r and r.get("proc"):
        r["proc"].kill()
    return view(rid)
