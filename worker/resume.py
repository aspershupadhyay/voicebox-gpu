"""Training that survives the GPU going away: checkpoints go to object storage as training runs, and a train job
started again (on this runtime or a new one) picks up from the last one instead of starting over.

job.json "resume": {"get": presigned GET, "put": presigned PUT, "state": presigned PUT} (the dashboard signs them, one
object per voice and engine). The checkpoint is a zip with resume.json inside: {"key", "epoch", ...}. "key" is a
fingerprint of the dataset and the settings, so a checkpoint is only used for the very same training run.
"state" gets {"state": "done" | "failed"} when the run ends, so the dashboard stops restarting it.
"""
import hashlib, json, os, shutil, threading, time, urllib.request, zipfile


def fingerprint(cfg, *extra):
    parts = sorted((p.get("url") or "").split("?", 1)[0] for p in cfg.get("parts") or [])
    raw = json.dumps([parts, cfg.get("epochs"), cfg.get("learning_rate"), cfg.get("speaker") or cfg.get("name"), *extra])
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


class Resume:
    def __init__(self, cfg, *extra):
        r = cfg.get("resume") or {}
        self.get, self.put, self.state = r.get("get"), r.get("put"), r.get("state")
        self.key = fingerprint(cfg, *extra)
        self.thread = None
        self.tmp = os.path.join(cfg["work"], "resume-up.zip")

    def fetch(self, dest):
        """Unpack the saved checkpoint into dest; its resume.json, or None when there's none for this run."""
        if not self.get:
            return None
        z = os.path.join(os.path.dirname(dest.rstrip("/")) or ".", "resume-down.zip")
        try:
            with urllib.request.urlopen(self.get, timeout=1800) as r, open(z, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            with zipfile.ZipFile(z) as zf:
                meta = json.loads(zf.read("resume.json"))
                if meta.get("key") != self.key:
                    print(f"[resume] saved checkpoint is for a different dataset or settings; starting fresh", flush=True)
                    return None
                os.makedirs(dest, exist_ok=True)
                zf.extractall(dest)
            print(f"[resume] picking up from {meta}", flush=True)
            return meta
        except Exception as e:  # noqa: BLE001  none saved yet (404) or unreadable: start fresh
            print(f"[resume] no checkpoint to resume from ({type(e).__name__}: {e})", flush=True)
            return None
        finally:
            if os.path.exists(z):
                os.remove(z)

    def push(self, src, meta, skip=lambda path: False):
        """Zip src (with resume.json) and upload it in the background; training carries on meanwhile. One upload at a
        time: a new checkpoint waits for the previous upload, so storage always holds a whole one."""
        if not self.put:
            return
        self.wait()
        os.makedirs(os.path.dirname(self.tmp), exist_ok=True)
        with zipfile.ZipFile(self.tmp, "w", zipfile.ZIP_STORED) as z:  # weights don't compress
            z.writestr("resume.json", json.dumps({**meta, "key": self.key, "t": time.time()}))
            for root, _, files in os.walk(src):
                for f in files:
                    p = os.path.join(root, f)
                    if not skip(p):
                        z.write(p, os.path.relpath(p, src))

        def up():
            for attempt in range(3):
                try:
                    with open(self.tmp, "rb") as f:
                        req = urllib.request.Request(self.put, data=f, method="PUT", headers={
                            "Content-Type": "application/zip", "Content-Length": str(os.path.getsize(self.tmp))})
                        with urllib.request.urlopen(req, timeout=3600) as r:
                            if r.status < 300:
                                print(f"[resume] checkpoint saved ({meta})", flush=True)
                                return
                except Exception as e:  # noqa: BLE001
                    print(f"[resume] checkpoint upload failed ({type(e).__name__}: {e}); retrying", flush=True)
                    time.sleep(5 * (attempt + 1))
        self.thread = threading.Thread(target=up, daemon=True)
        self.thread.start()

    def wait(self):
        if self.thread:
            self.thread.join()
            self.thread = None


def mark(cfg, state):
    """Tell the dashboard the run is over (done or failed for good), so it doesn't start it again."""
    url = (cfg.get("resume") or {}).get("state")
    if not url:
        return
    body = json.dumps({"state": state, "t": time.time()}).encode()
    try:
        req = urllib.request.Request(url, data=body, method="PUT", headers={"Content-Type": "application/json", "Content-Length": str(len(body))})
        urllib.request.urlopen(req, timeout=60).close()
    except Exception as e:  # noqa: BLE001
        print(f"[resume] could not mark the run {state}: {e}", flush=True)
