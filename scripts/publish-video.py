#!/usr/bin/env python3
"""Publish a rendered video to the dashboard library (private R2 bucket), optionally with subtitles.

  scripts/publish-video.py renders/film.mp4 --label "GPS · final" \
      [--poster poster.jpg] [--engine orpheus --voice tara] [--voice-job <library id>] \
      [--lines lines.tsv]

--lines builds video-level subtitles from per-line Whisper output: a TSV of
  <start seconds in the video> <TAB> <path to a <line>.subs.json from the library>
The words are re-cut into cues with the worker's own cue builder, so they match dashboard subtitles.

The video goes straight to Blob with a presigned PUT (no size limit from the Vercel function);
needs MCP_URL + MCP_TOKEN (read from .secrets.local when not in the environment).
"""
import argparse, json, os, ssl, subprocess, sys, tempfile, time, urllib.request, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("VOICEBOX_HOME", os.path.join(tempfile.gettempdir(), "voicebox-local"))
sys.path.insert(0, os.path.join(ROOT, "worker"))


def secrets():
    path = os.path.join(ROOT, ".secrets.local")
    if os.path.exists(path):
        for ln in open(path):
            if "=" in ln and not ln.lstrip().startswith("#"):
                k, v = ln.strip().split("=", 1)
                os.environ.setdefault(k, v.strip('"'))
    url, token = os.environ.get("MCP_URL", "https://mcp-eta-tawny.vercel.app").rstrip("/"), os.environ.get("MCP_TOKEN")
    if not token:
        sys.exit("MCP_TOKEN not set (put it in .secrets.local)")
    return url, token


def ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem") if os.path.exists("/etc/ssl/cert.pem") else None


def req(method, url, data=None, headers=None):
    r = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(r, timeout=600, context=ctx()) as res:
        body = res.read()
        return json.loads(body) if body[:1] in (b"{", b"[") else body


def probe(path):
    out = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                              "stream=width,height:format=duration", "-of", "json", path]))
    return out["streams"][0]["width"], out["streams"][0]["height"], float(out["format"]["duration"])


def subtitles(lines_tsv):
    import gateway as G  # the worker's cue builder and writers
    cues = []
    for ln in open(lines_tsv):
        if not ln.strip():
            continue
        start, path = ln.rstrip("\n").split("\t")
        words = json.load(open(path))["words"]
        cues += G.cues_from_words(words, offset=float(start))
    cues.sort(key=lambda c: c["s"])
    for a, b in zip(cues, cues[1:]):  # never overlap: end each cue a hair before the next starts
        a["e"] = min(a["e"], round(b["s"] - 0.04, 3))
    return {"subtitles.srt": G.to_srt(cues).encode(), "subtitles.vtt": G.to_vtt(cues).encode(),
            "subtitles.json": json.dumps({"cues": cues}, ensure_ascii=False).encode()}, len(cues)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--label", required=True)
    ap.add_argument("--poster")
    ap.add_argument("--engine", default="")
    ap.add_argument("--voice", default="")
    ap.add_argument("--voice-job")
    ap.add_argument("--lines")
    ap.add_argument("--id", help="library id to (over)write; default: a new one")
    a = ap.parse_args()
    url, token = secrets()
    auth = {"Authorization": f"Bearer {token}"}
    job = a.id or uuid.uuid4().hex[:12]
    w, h, dur = probe(a.video)

    files = {"video.mp4": a.video}
    if a.poster:
        files["poster.jpg"] = a.poster
    extra, n_cues = subtitles(a.lines) if a.lines else ({}, 0)

    names = list(files) + list(extra)
    pre = req("POST", f"{url}/api/dash/library/{job}/presign", json.dumps({"files": names}).encode(),
              {**auth, "Content-Type": "application/json"})
    types = {"mp4": "video/mp4", "jpg": "image/jpeg", "srt": "application/x-subrip", "vtt": "text/vtt", "json": "application/json"}
    for name in names:
        data = open(files[name], "rb").read() if name in files else extra[name]
        t0 = time.time()
        req("PUT", pre["targets"][name], data, {**pre["headers"], "x-content-type": types[name.rsplit(".", 1)[1]]})
        print(f"  {name:16s} {len(data) / 1e6:6.2f} MB  {time.time() - t0:.1f}s")

    meta = {"id": job, "kind": "video", "engine": a.engine, "voice": a.voice, "label": a.label, "created": int(time.time() * 1000),
            "source": "render", "results": [], "subs": {"cues": n_cues, "timeline": "video"} if n_cues else None,
            "video": {"width": w, "height": h, "duration": round(dur, 3), "size": os.path.getsize(a.video),
                      "poster": bool(a.poster), **({"voice_job": a.voice_job} if a.voice_job else {})}}
    req("PUT", f"{url}/api/dash/library/{job}/job.json", json.dumps(meta).encode(), {**auth, "Content-Type": "application/json"})
    print(f"published {job}: {url}/library#{job}")


if __name__ == "__main__":
    main()
