"""Upload a local folder of line WAVs into the dashboard library.

  python3 scripts/import-library.py FOLDER --id gps-orpheus-female --engine orpheus --voice tara --label "GPS · Orpheus female" \
      [--script vo-script.tsv]

Uses FOLDER/manifest.json when present (durations, fits); otherwise reads durations from the WAVs and
texts/windows from --script.
"""
import argparse, json, os, ssl, subprocess, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")


def token():
    for ln in open(os.path.join(ROOT, ".secrets.local")):
        if ln.startswith("MCP_TOKEN="):
            return ln.strip().split("=", 1)[1]


def put(base, path, data, ctype):
    req = urllib.request.Request(f"{base}/api/dash/library/{path}", data=data, method="PUT",
                                 headers={"Authorization": f"Bearer {token()}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder"); ap.add_argument("--id", required=True)
    ap.add_argument("--engine", required=True); ap.add_argument("--voice", required=True)
    ap.add_argument("--label", default=""); ap.add_argument("--script")
    ap.add_argument("--base", default=os.environ.get("VOICEBOX_URL", "https://voiceboxstudio.vercel.app"))
    a = ap.parse_args()

    man = os.path.join(a.folder, "manifest.json")
    if os.path.exists(man):
        m = json.load(open(man))
        results = [{k: r.get(k) for k in ("id", "text", "duration", "window", "fits")} for r in m["results"]]
        params = m.get("params", {})
    else:
        script = {}
        if a.script:
            for row in open(a.script):
                if row.strip() and not row.startswith("#"):
                    c = row.rstrip("\n").split("\t")
                    script[c[0]] = (c[3], float(c[2]))
        results, params = [], {}
        for f in sorted(os.listdir(a.folder)):
            if f.endswith(".wav") and f[:-4].replace("-", "").replace("_", "").isalnum():
                dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                                     "-of", "csv=p=0", os.path.join(a.folder, f)]).strip())
                text, win = script.get(f[:-4], ("", None))
                results.append({"id": f[:-4], "text": text, "duration": round(dur, 3), "window": win,
                                "fits": None if win is None else dur <= win})
    for r in results:
        put(a.base, f"{a.id}/{r['id']}.wav", open(os.path.join(a.folder, f"{r['id']}.wav"), "rb").read(), "audio/wav")
    put(a.base, f"{a.id}/job.json", json.dumps({"id": a.id, "engine": a.engine, "voice": a.voice, "label": a.label,
        "params": params, "created": int(os.path.getmtime(a.folder) * 1000), "source": "import", "results": results}).encode(),
        "application/json")
    print(f"imported {a.id}: {len(results)} lines")


if __name__ == "__main__":
    main()
