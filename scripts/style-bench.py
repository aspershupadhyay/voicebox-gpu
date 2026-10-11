#!/usr/bin/env python3
"""Benchmark delivery settings: generate one script under many engine/voice/param configs on the worker,
then score every take for liveliness (pitch spread), pace (words/s), dynamics, and accuracy (Whisper match).

  scripts/style-bench.py run     # queue the jobs, wait, download into /tmp/style-bench
  scripts/style-bench.py score   # analyse (run with: uv run --with librosa --with soundfile python ...)
"""
import json, os, sys, time, urllib.request, zipfile, io

OUT = "/tmp/style-bench"
SCRIPT = [
    "Your phone just did something wild.",
    "In under a second, it talked to four satellites, twenty thousand kilometers away!",
    "And it did the math faster than you can blink.",
    "Here's exactly how it works.",
]
ORPHEUS = {"o06": {"temperature": 0.6, "repetition_penalty": 1.1}, "o075": {"temperature": 0.75, "repetition_penalty": 1.1},
           "o09": {"temperature": 0.9, "repetition_penalty": 1.1}, "o075r12": {"temperature": 0.75, "repetition_penalty": 1.2}}
CHATTER = {"c05": {"exaggeration": 0.5, "cfg_weight": 0.5}, "c07": {"exaggeration": 0.7, "cfg_weight": 0.35},
           "c09": {"exaggeration": 0.9, "cfg_weight": 0.3}, "c12": {"exaggeration": 1.2, "cfg_weight": 0.3, "temperature": 0.9}}
KOKORO = {"k10": {"speed": 1.0}, "k11": {"speed": 1.1}, "k12": {"speed": 1.2}}
JOBS = ([("orpheus", "tara", ORPHEUS)] +
        [("orpheus", v, {"o075": ORPHEUS["o075"]}) for v in ("leah", "jess", "mia", "zoe", "leo", "dan", "zac")] +
        [("chatterbox", v, CHATTER) for v in ("female", "male")] +
        [("kokoro", v, KOKORO) for v in ("af_heart", "af_bella", "af_nicole", "am_michael", "am_puck", "am_fenrir", "bf_emma", "bm_george")])


def env():
    for ln in open(os.path.join(os.path.dirname(__file__), "..", ".secrets.local")):
        if "=" in ln:
            k, v = ln.strip().split("=", 1)
            os.environ.setdefault(k, v.strip('"'))
    return "https://mcp-eta-tawny.vercel.app/api/dash", {"Authorization": f"Bearer {os.environ['MCP_TOKEN']}"}


def http(url, h, body=None, method=None):
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method,
                               headers={**h, "Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=120) as res:
        return res.read()


def run():
    base, h = env()
    os.makedirs(OUT, exist_ok=True)
    ids = []
    for engine, voice, cfgs in JOBS:
        lines = [{"id": f"{c}-{i + 1}", "text": t, "params": p} for c, p in cfgs.items() for i, t in enumerate(SCRIPT)]
        j = json.loads(http(f"{base}/jobs", h, {"engine": engine, "voice": voice, "lines": lines, "subtitles": True,
                                                  "label": f"bench · {engine} {voice}"}))
        ids.append((j["id"], engine, voice))
        print("queued", j["id"], engine, voice, flush=True)
    meta = []
    for jid, engine, voice in ids:
        while True:
            d = json.loads(http(f"{base}/jobs/{jid}", h))
            if d["status"] in ("done", "error", "failed", "cancelled"):
                break
            time.sleep(6)
        print(jid, engine, voice, d["status"], d.get("error") or "", flush=True)
        lib = (d.get("library") or {}).get("id")
        if not lib:
            continue
        z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(urllib.request.Request(
            base.replace("/dash", f"/zip/{lib}"), headers=h), timeout=300).read()))
        d_dir = os.path.join(OUT, f"{engine}-{voice}")
        z.extractall(d_dir)
        meta.append({"engine": engine, "voice": voice, "dir": d_dir, "lib": lib,
                     "results": {r["id"]: {"match": r.get("match"), "duration": r["duration"]} for r in d["results"]}})
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    print("library ids to clean up:", " ".join(m["lib"] for m in meta))


def score():
    import numpy as np, librosa, soundfile as sf
    rows = []
    for m in json.load(open(os.path.join(OUT, "meta.json"))):
        cfgs = sorted({k.rsplit("-", 1)[0] for k in m["results"]})
        for c in cfgs:
            semis, wps, dyn, match, dur = [], [], [], [], 0.0
            for i, text in enumerate(SCRIPT):
                lid = f"{c}-{i + 1}"
                y, sr = sf.read(os.path.join(m["dir"], f"{lid}.wav"), dtype="float32")
                f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=500, sr=sr, frame_length=2048)
                f0 = f0[voiced & ~np.isnan(f0)]
                if len(f0) > 10:
                    st = 12 * np.log2(f0 / np.median(f0))
                    semis.append(np.percentile(st, 95) - np.percentile(st, 5))
                rms = librosa.feature.rms(y=y)[0]
                db = 20 * np.log10(rms[rms > 1e-4] + 1e-9)
                dyn.append(np.percentile(db, 95) - np.percentile(db, 30))
                intervals = librosa.effects.split(y, top_db=35)
                speech = sum(e - s for s, e in intervals) / sr
                wps.append(len(text.split()) / max(speech, 0.1))
                match.append(m["results"][lid]["match"] or 0)
                dur += len(y) / sr
            rows.append({"engine": m["engine"], "voice": m["voice"], "cfg": c, "pitch_range_st": float(np.mean(semis)),
                         "words_per_s": float(np.mean(wps)), "dyn_db": float(np.mean(dyn)), "match": float(np.mean(match)),
                         "min_match": float(np.min(match)), "seconds": round(dur, 2)})
    rows.sort(key=lambda r: (r["engine"], -r["pitch_range_st"]))
    print(f"{'engine':10s} {'voice':10s} {'cfg':8s} {'pitch st':>8s} {'words/s':>8s} {'dyn dB':>7s} {'match':>6s} {'min':>5s} {'secs':>6s}")
    for r in rows:
        print(f"{r['engine']:10s} {r['voice']:10s} {r['cfg']:8s} {r['pitch_range_st']:8.2f} {r['words_per_s']:8.2f} {r['dyn_db']:7.1f} "
              f"{r['match']:6.3f} {r['min_match']:5.2f} {r['seconds']:6.1f}")
    json.dump(rows, open(os.path.join(OUT, "scores.json"), "w"), indent=1)


if __name__ == "__main__":
    {"run": run, "score": score}[sys.argv[1]]()
