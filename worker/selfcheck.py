"""Quick end-to-end check of a running worker. Python 3 only, no packages: run it from any computer.

  python3 worker/selfcheck.py --base https://<worker>.trycloudflare.com --secret <WORKER_SECRET>
  python3 worker/selfcheck.py --base ... --secret ... --quick      # Kokoro + clean-up only (~1 min)

--base is the worker's public link (Engines page, or worker_status's public_url); --secret is the WORKER_SECRET line in
.secrets.local (also in Colab's Secrets). On the Colab machine itself (a Colab terminal) the defaults work:
http://127.0.0.1:8000 and WORKER_SECRET from the environment.

It voices one line on each engine, runs the studio clean-up (Resemble Enhance) on a voiced line, transcribes a ~1 minute
take (the Whisper batching that ran out of memory), and prints PASS / FAIL with the reason and the engine's log tail.
"""
import argparse, json, os, sys, time, urllib.request

LINE = "Quick check: if you can hear this clearly, this engine works."
LONG = [  # ~1 minute in Kokoro: enough 30 s windows to exercise batched transcription
    "Every time you ask an AI a question, it isn't thinking in words.", "It's multiplying matrices, billions of them, on a GPU.",
    "And the trick that made it possible was one paper, from two thousand seventeen.", "It was called Attention Is All You Need.",
    "Every word asks which other words matter, and attention weaves that context into meaning.",
    "Stack that a few dozen layers deep, train it on trillions of tokens, and something remarkable happens.",
    "It starts to predict the next word so well that it has to model the world that wrote the words.",
    "That's the whole trick, and it's why your chatbot can explain black holes, write code, and argue about philosophy.",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--secret", default=os.environ.get("WORKER_SECRET", ""))
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--json", help="also write the results here (the worker's own check after start / training)")
    a = ap.parse_args()
    if not a.secret:
        sys.exit("WORKER_SECRET isn't set here: pass --secret (it's in the notebook's first cell output / your .secrets.local)")

    def req(path, body=None, timeout=60):
        r = urllib.request.Request(a.base + path, data=json.dumps(body).encode() if body is not None else None,
                                   headers={"Authorization": f"Bearer {a.secret}", "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=timeout) as f:
            return json.loads(f.read())

    def run(body, limit=900):
        j = req("/jobs", body)
        t0 = time.time()
        while j["status"] in ("queued", "running") and time.time() - t0 < limit:
            time.sleep(3)
            j = req(f"/jobs/{j['id']}")
        return j, time.time() - t0

    results = []

    def report(name, ok, detail, engine=None):
        results.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name:<26} {detail}", flush=True)
        if not ok and engine:
            try:
                print("      log:", "\n      ".join(req(f"/logs/{engine}?n=12")["text"].splitlines()[-12:]))
            except Exception:  # noqa: BLE001
                pass

    try:
        h = req("/health")
    except Exception as e:  # noqa: BLE001
        sys.exit(f"can't reach the worker at {a.base} ({e}). Is Colab running, and is --base its current public link?")
    gpu = h.get("gpu") or {}
    print(f"worker {h.get('version')} · {gpu.get('name')} · {gpu.get('used_gb')}/{gpu.get('total_gb')} GB used · errors: {h.get('engine_errors') or 'none'}\n")

    engines = ["kokoro"] if a.quick else ["kokoro", "orpheus", "qwen", "chatterbox"]
    first = None
    for e in engines:
        j, secs = run({"engine": e, "voice": "male", "lines": [{"id": "check", "text": LINE}], "review": False, "platform": "raw"})
        ok = j["status"] == "done" and j["results"]
        report(f"voice · {e}", bool(ok), f"{j['results'][0]['duration']:.1f} s of audio in {secs:.0f} s" if ok else (j.get("error") or j["status"]), e)
        if ok and not first:
            first = j["results"][0]["url"]
    if first:
        j, secs = run({"kind": "clean", "url": first, "cleanup": "enhance", "platform": "raw"})
        warn = [w for w in j.get("warnings", []) if "enhance unavailable" in w]
        steps = ((j.get("results") or [{}])[0].get("cleanup") or {}).get("steps") or []  # step names (older workers: dicts)
        ok = j["status"] == "done" and not warn
        report("clean-up · Resemble Enhance", ok, f"steps {[s if isinstance(s, str) else s.get('step') for s in steps]} in {secs:.0f} s" if ok else (warn[0] if warn else j.get("error") or j["status"]), "enhance")
    if not a.quick:
        j, secs = run({"engine": "kokoro", "voice": "male", "lines": [{"id": f"l{i}", "text": t} for i, t in enumerate(LONG)], "review": False, "platform": "raw"})
        if j["status"] == "done":
            t, s2 = run({"kind": "transcribe", "sources": [{"id": r["id"], "url": r["url"]} for r in j["results"]], "combine": True})
            ok = t["status"] == "done"
            report("transcribe · Whisper", ok, f"{len(j['results'])} lines in {s2:.0f} s" if ok else (t.get("error") or t["status"]), "whisper")
        else:
            report("transcribe · Whisper", False, f"couldn't voice the test take: {j.get('error')}", "kokoro")
    h = req("/health")
    print(f"\nGPU after: {(h.get('gpu') or {}).get('used_gb')} GB used · engine errors: {h.get('engine_errors') or 'none'}")
    bad = [n for n, ok, _ in results if not ok]
    print("ALL PASS" if not bad else f"{len(bad)} FAILED: {', '.join(bad)}")
    if a.json:
        json.dump({"ok": not bad, "quick": a.quick, "steps": [{"name": n, "ok": ok, "detail": str(d)[:300]} for n, ok, d in results]}, open(a.json, "w"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
