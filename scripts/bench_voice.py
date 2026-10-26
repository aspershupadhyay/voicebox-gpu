#!/usr/bin/env python3
"""Inference baseline (docs/INFERENCE.md step 1): time a fixed 10-line voiceover on the live worker.

Runs through the dashboard API like make-samples.py (MCP_TOKEN from .secrets.local). For each engine and best-of N it
voices the same script with the same seed, review on, and records: time to first line, wall time, where the time went
(the job's per-stage timings), peak VRAM and the review's scores (script match, voice match). Times come from the
worker's clock, so the network and the queue don't count. One short warm-up job per engine runs first so model loading
isn't timed; --cold times it instead.

  scripts/bench_voice.py                              # orpheus + qwen, best-of-1 and best-of-4
  scripts/bench_voice.py --engines orpheus --takes 4 --runs 3
  scripts/bench_voice.py --label "step 2: compiled codec"   # the name of the row in the Results table
  scripts/bench_voice.py --batch-review off --label Baseline  # A/B a flagged step on the same card

Prints one Results row per engine for docs/INFERENCE.md and writes every number to bench/<date>-<gpu>.json.
"""
import argparse, json, os, re, ssl, sys, time, urllib.request

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")

# Fixed script: plain explainer lines of mixed length, a number, a term or two. Never change it, or old numbers stop
# comparing; add a new script under a new name instead.
SCRIPT = [
    "Here's how your phone finds you, anywhere on Earth.",
    "Above us, about thirty satellites circle the planet twice a day.",
    "Each one keeps shouting the time, measured by an atomic clock on board.",
    "Your phone listens for at least four of them at once.",
    "A signal from a satellite overhead takes about sixty-seven milliseconds to arrive.",
    "The tiny differences between those arrival times tell your phone how far away each satellite is.",
    "Four distances, one point where they all meet: that's you.",
    "But there's a catch. The clocks up there run faster than ours, by about thirty-eight microseconds a day.",
    "Einstein saw it coming, and every satellite is corrected for it.",
    "Without that fix, your map would drift by about ten kilometres every single day.",
]
VOICES = {"orpheus": "tara", "qwen": "female", "chatterbox": "female", "myvoice": None, "kokoro": "af_heart"}
SEED = 7
# The tech style's temperatures, pinned: the dashboard sends what each voice has learned from past reviews (benchmark
# runs included), and that would quietly change the settings between two runs.
TEMPERATURE = {"orpheus": 0.65, "qwen": 0.85, "myvoice": 0.5, "chatterbox": 0.8}


def env():
    for ln in open(os.path.join(os.path.dirname(__file__), "..", ".secrets.local")):
        if "=" in ln and not ln.startswith("#"):
            k, v = ln.strip().split("=", 1)
            os.environ.setdefault(k, v.strip('"'))
    base = os.environ.get("VOICEBOX_URL", "https://voiceboxstudio.vercel.app").rstrip("/") + "/api/dash"
    return base, {"Authorization": f"Bearer {os.environ['MCP_TOKEN']}"}


def http(url, h, body=None):
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                               headers={**h, "Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=120, context=CTX) as res:
        return json.loads(res.read())


def run_job(base, h, body, poll=0.5):
    """Submit a job and watch it; returns (final view, seconds from start to the first finished line)."""
    jid = http(f"{base}/jobs", h, body)["id"]
    first = None
    while True:
        # ?raw: status only; a plain jobs/<id> would also archive the result into the Library
        st = http(f"{base}/jobs/{jid}?raw", h)
        if first is None and st.get("results"):
            first = (st.get("progress") or {}).get("elapsed_s")  # worker clock, from when the job started running
        if st["status"] in ("done", "error", "cancelled"):
            return st, first
        time.sleep(poll)


def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(sum(xs) / len(xs), 3) if xs else None


def measure(st, first):
    res = st.get("results") or []
    takes = [r.get("takes") or {} for r in res]
    wall = round(st["finished"] - st["started"], 1) if st.get("finished") and st.get("started") else None
    return {"job": st["id"], "status": st["status"], "error": st.get("error"),
            "first_line_s": first, "wall_s": wall, "timings": st.get("timings") or {},
            "vram_peak_gb": (st.get("resources") or {}).get("vram_peak_gb"),
            "audio_s": round(sum(r.get("duration") or 0 for r in res), 1),
            "match": mean(t.get("match") for t in takes), "similarity": mean(t.get("similarity") for t in takes),
            "retried": sum(((r.get("review") or {}).get("retried") or 0) for r in res)}


def summarise(runs):
    ok = [r for r in runs if r["status"] == "done"]
    if not ok:
        return None
    med = lambda k: sorted(r[k] for r in ok if r[k] is not None)[len(ok) // 2] if any(r[k] is not None for r in ok) else None  # noqa: E731
    stages = sorted({s for r in ok for s in r["timings"]})
    return {"runs": len(ok), "first_line_s": med("first_line_s"), "wall_s": med("wall_s"), "audio_s": ok[0]["audio_s"],
            "vram_peak_gb": max((r["vram_peak_gb"] or 0) for r in ok) or None,
            "match": mean(r["match"] for r in ok), "similarity": mean(r["similarity"] for r in ok),
            "timings": {s: round(sum(r["timings"].get(s, 0) for r in ok) / len(ok), 1) for s in stages}}


def fmt(x, unit=""):
    return "—" if x is None else f"{x}{unit}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engines", default="orpheus,qwen", help="comma-separated voice engines")
    ap.add_argument("--takes", default="1,4", help="comma-separated best-of values")
    ap.add_argument("--runs", type=int, default=1, help="repeat each case; the median is reported")
    ap.add_argument("--voice", help="override the voice (e.g. a trained myvoice name)")
    ap.add_argument("--no-review", action="store_true", help="skip the listening pass (best-of-1 only)")
    ap.add_argument("--cold", action="store_true", help="no warm-up job: model loading counts in the first case")
    ap.add_argument("--batch-review", choices=["on", "off"], help="force the batched review (step 3) on or off; default: the worker's setting")
    ap.add_argument("--label", default="Baseline", help="the step this run measures (first column of the Results row)")
    ap.add_argument("--out", help="JSON file for every number (default bench/<date>-<gpu>.json)")
    a = ap.parse_args()
    engines = [e.strip() for e in a.engines.split(",") if e.strip()]
    takes = [int(t) for t in a.takes.split(",") if t.strip()]
    base, h = env()

    st = http(f"{base}/status", h)
    if not st.get("online"):
        sys.exit(f"worker offline ({st.get('reason')}): start the Colab notebook first")
    gpu = st.get("gpu") or {}
    if st.get("running") or st.get("queue"):
        print(f"warning: the worker is busy ({len(st.get('running') or [])} running, {st.get('queue')} queued); "
              "numbers will include their load", flush=True)
    print(f"{gpu.get('name')} · {gpu.get('total_gb')} GB · worker {st.get('version')}", flush=True)

    report = {"label": a.label, "date": time.strftime("%Y-%m-%d %H:%M"), "gpu": gpu, "version": st.get("version"),
              "script_chars": sum(len(s) for s in SCRIPT), "seed": SEED, "engines": {}}
    lines = [{"id": f"{i + 1:02d}", "text": t} for i, t in enumerate(SCRIPT)]
    failed = 0
    for eng in engines:
        voice = a.voice or VOICES.get(eng)
        # everything explicit, so the dashboard's settings (subtitles, platform) can't change what's measured
        params = {"seed": SEED, **({"temperature": TEMPERATURE[eng]} if eng in TEMPERATURE else {})}
        common = {"engine": eng, "voice": voice, "style": "tech", "params": params, "review": not a.no_review,
                  "subtitles": False, "platform": "youtube"}
        if a.batch_review:
            common["review_batch"] = a.batch_review == "on"
        if not a.cold:
            print(f"{eng}: warming up", flush=True)
            w, _ = run_job(base, h, {**common, "lines": lines[:1], "takes": 1, "review": False, "label": f"bench · {eng} warm-up"})
            if w["status"] != "done":
                print(f"  warm-up failed: {w.get('error')}", flush=True)
                failed += 1
                continue
        report["engines"][eng] = {"voice": voice, "cases": {}}
        for n in takes:
            runs = []
            for k in range(a.runs):
                fin, first = run_job(base, h, {**common, "lines": lines, "takes": n, "label": f"bench · {eng} best-of-{n} #{k + 1}"})
                m = measure(fin, first)
                runs.append(m)
                if m["status"] != "done":
                    failed += 1
                print(f"  {eng} best-of-{n} #{k + 1}: {m['status']} first line {fmt(m['first_line_s'], ' s')}, "
                      f"total {fmt(m['wall_s'], ' s')} for {m['audio_s']} s of audio, VRAM {fmt(m['vram_peak_gb'], ' GB')}, "
                      f"match {fmt(m['match'])} voice {fmt(m['similarity'])} · {m['timings']}"
                      + (f" · {m['error']}" if m["error"] else ""), flush=True)
            report["engines"][eng]["cases"][f"best-of-{n}"] = {"summary": summarise(runs), "runs": runs}

    slug = re.sub(r"[^a-z0-9]+", "-", (gpu.get("name") or "gpu").lower()).strip("-")
    out = a.out or os.path.join(os.path.dirname(__file__), "..", "bench", f"{time.strftime('%Y-%m-%d-%H%M')}-{slug}.json")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    json.dump(report, open(out, "w"), indent=2)

    # rows for the Results table in docs/INFERENCE.md
    print("\n| Step | Card | Time to first audio | 10 lines, best-of-1 | 10 lines, best-of-4 | Peak VRAM | Match / voice |")
    print("|---|---|---|---|---|---|---|")
    card = f"{gpu.get('name')} ({gpu.get('total_gb')} GB)"
    for eng, e in report["engines"].items():
        s1, s4 = (e["cases"].get("best-of-1") or {}).get("summary"), (e["cases"].get("best-of-4") or {}).get("summary")
        lead = s1 or s4 or {}
        vram = max([s["vram_peak_gb"] or 0 for s in (s1, s4) if s] or [0]) or None
        print(f"| {a.label} · {eng} | {card} | {fmt(lead.get('first_line_s'), ' s')} | {fmt((s1 or {}).get('wall_s'), ' s')} | "
              f"{fmt((s4 or {}).get('wall_s'), ' s')} | {fmt(vram, ' GB')} | {fmt(lead.get('match'))} / {fmt(lead.get('similarity'))} |")
    print(f"\nall numbers: {os.path.relpath(out)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
