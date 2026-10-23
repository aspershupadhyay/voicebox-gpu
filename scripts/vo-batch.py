"""Voice a timeline script through the hosted MCP and download the results.

  python3 scripts/vo-batch.py SCRIPT.tsv OUT_DIR --engine orpheus --voice female [--param temperature=0.6] [--base URL]

TSV columns: id, start, window, text[, exaggeration]. Lines starting with # are skipped.
Writes OUT_DIR/<id>.wav and OUT_DIR/manifest.json (durations + fits flags).
"""
import argparse, io, json, os, ssl, sys, time, urllib.request, zipfile

# python.org builds on macOS ship without CA roots; fall back to certifi or the system bundle
try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def secrets():
    out = {}
    for ln in open(os.path.join(ROOT, ".secrets.local")):
        k, _, v = ln.strip().partition("=")
        out[k] = v
    return out


def rpc(base, token, name, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
    req = urllib.request.Request(base + "/api/mcp", data=body.encode(), method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"})
    with urllib.request.urlopen(req, timeout=90, context=CTX) as r:
        raw = r.read().decode()
    for ln in raw.splitlines():
        ln = ln[6:] if ln.startswith("data: ") else ln
        if ln.startswith("{"):
            res = json.loads(ln)["result"]
            text = res["content"][0]["text"]
            if res.get("isError"):
                raise RuntimeError(text)
            return json.loads(text)
    raise RuntimeError(raw[:300])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("script"); ap.add_argument("out")
    ap.add_argument("--engine", required=True); ap.add_argument("--voice", default="female")
    ap.add_argument("--param", action="append", default=[], help="key=value, applied to every line")
    ap.add_argument("--base", default=os.environ.get("VOICEBOX_URL", "https://voiceboxstudio.vercel.app"))
    ap.add_argument("--label", default="")
    a = ap.parse_args()
    token = secrets()["MCP_TOKEN"]

    lines = []
    for row in open(a.script):
        if not row.strip() or row.startswith("#"):
            continue
        c = row.rstrip("\n").split("\t")
        ln = {"id": c[0], "window": float(c[2]), "text": c[3]}
        if len(c) > 4 and c[4] and a.engine == "chatterbox":
            ln["params"] = {"exaggeration": float(c[4])}
        lines.append(ln)
    params = {k: (float(v) if v.replace(".", "", 1).lstrip("-").isdigit() else v) for k, v in (p.split("=", 1) for p in a.param)}

    job = rpc(a.base, token, "voice_lines", {"engine": a.engine, "voice": a.voice, "lines": lines, "params": params,
                                            "label": a.label or f"{a.engine}-{a.voice}", "wait_seconds": 0})
    t0, last = time.time(), None
    while job["status"] in ("queued", "running"):
        p = f"{job['status']} {job['progress']['done']}/{job['progress']['total']}"
        if p != last:
            print(f"[{a.engine}/{a.voice}] {time.time() - t0:5.0f}s {p}", flush=True)
            last = p
        job = rpc(a.base, token, "get_job", {"job_id": job["id"], "wait_seconds": 40})
    if job["status"] != "done":
        sys.exit(f"[{a.engine}/{a.voice}] {job['status']}: {job.get('error')}")

    os.makedirs(a.out, exist_ok=True)
    with urllib.request.urlopen(job["zip_url"], timeout=120, context=CTX) as r:
        zipfile.ZipFile(io.BytesIO(r.read())).extractall(a.out)
    over = [f"{r['id']} {r['duration']:.2f}/{r['window']}" for r in job["results"] if r["fits"] is False]
    print(f"[{a.engine}/{a.voice}] done in {time.time() - t0:.0f}s -> {a.out}" + (f"  OVER: {', '.join(over)}" if over else "  all lines fit"))


if __name__ == "__main__":
    main()
