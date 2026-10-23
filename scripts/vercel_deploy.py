"""Deploy mcp/ to Vercel production through the REST API (no Vercel CLI).

  VERCEL_TOKEN=... python3 scripts/vercel_deploy.py [--scope forchatgptuseho-9784] [--project mcp]

Works with project-scoped tokens, which the CLI can't use (it always loads the user first: 404 "User not found").
Uploads every file once (by SHA-1), creates a production deployment from them and waits until it's ready; Vercel then
points the production domain at it. Env vars and build settings stay as they are on the project.
"""
import argparse, hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {"node_modules", ".next", ".vercel", ".git"}
API = "https://api.vercel.com"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", default=os.environ.get("VERCEL_SCOPE", "forchatgptuseho-9784"))
    ap.add_argument("--project", default=os.environ.get("VERCEL_PROJECT", "mcp"))
    ap.add_argument("--dir", default=os.path.join(ROOT, "mcp"))
    a = ap.parse_args()
    token = "".join(os.environ.get("VERCEL_TOKEN", "").split())
    if not token:
        sys.exit("VERCEL_TOKEN is not set")

    def call(method, path, body=None, headers=None, data=None):
        q = ("&" if "?" in path else "?") + urllib.parse.urlencode({"slug": a.scope})
        h = {"Authorization": f"Bearer {token}", **(headers or {})}
        if body is not None:
            data, h["Content-Type"] = json.dumps(body).encode(), "application/json"
        req = urllib.request.Request(API + path + q, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise SystemExit(f"{method} {path}: {e.code} {e.read().decode()[:500]}")

    project = call("GET", f"/v9/projects/{a.project}")
    prefix = (project.get("rootDirectory") or "").strip("/")  # the project builds from this folder of the upload
    files = []
    for dirpath, dirnames, names in os.walk(a.dir):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for n in names:
            if n.startswith(".env"):
                continue
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, a.dir).replace(os.sep, "/")
            data = open(full, "rb").read()
            files.append({"file": f"{prefix}/{rel}" if prefix else rel, "sha": hashlib.sha1(data).hexdigest(), "size": len(data), "path": full})
    print(f"{len(files)} files, {sum(f['size'] for f in files) / 1e6:.1f} MB" + (f" (under {prefix}/)" if prefix else ""))

    def upload(f):
        call("POST", "/v2/files", data=open(f["path"], "rb").read(),
             headers={"Content-Type": "application/octet-stream", "x-vercel-digest": f["sha"], "Content-Length": str(f["size"])})
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(upload, files))

    d = call("POST", "/v13/deployments", {"name": a.project, "project": project["id"], "target": "production",
                                          "files": [{"file": f["file"], "sha": f["sha"], "size": f["size"]} for f in files]})
    print("deployment", d["id"], "https://" + d["url"])
    t0 = time.time()
    while True:
        s = call("GET", f"/v13/deployments/{d['id']}")
        state = s.get("readyState") or s.get("status")
        if state in ("READY", "ERROR", "CANCELED"):
            break
        if time.time() - t0 > 900:
            sys.exit("timed out waiting for the build")
        time.sleep(5)
    print(f"{state} in {time.time() - t0:.0f}s; aliases: {', '.join(s.get('alias') or []) or '-'}")
    if state != "READY":
        sys.exit(f"build {state.lower()}: see https://vercel.com/{a.scope}/{a.project}/{d['id'].removeprefix('dpl_')}")


if __name__ == "__main__":
    main()
