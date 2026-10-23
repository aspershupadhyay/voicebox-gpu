"""Adaptive clean-up: measure the recording, run only what it needs, check the voice survived.

  measure (quality.analyze) -> plan (quality.cleanup_plan) -> denoise (DeepFilterNet) and/or restore (Resemble Enhance)
  -> verify: the result must still sound like the same person (speaker similarity to the input) and must actually
  be cleaner; otherwise fall back one step. The report says what was measured, what ran and why.

DeepFilterNet runs as its official static CLI on the CPU (real-time on a laptop core), so it costs no GPU memory and no
Python dependencies; it is fetched once into $VOICEBOX_HOME/bin.
"""
import os
import shutil
import subprocess
import tempfile
import urllib.request

import quality

DF_URL = os.environ.get("DEEPFILTER_URL",
                        "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl")
IDENTITY_MIN = 0.80   # speaker similarity input -> output below this means the clean-up changed who is talking


def _bin(home):
    path = os.path.join(home, "bin", "deep-filter")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        with urllib.request.urlopen(DF_URL, timeout=120) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        os.chmod(tmp, 0o755)
        os.replace(tmp, path)
    return path


def denoise(home, src, dst, atten_db=100):
    """DeepFilterNet 3 at 48 kHz. atten_db caps how far noise is pushed down (30 = gentle, 100 = all of it)."""
    with tempfile.TemporaryDirectory() as d:
        inp = os.path.join(d, "in.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "48000", inp], check=True)
        subprocess.run([_bin(home), "-a", str(int(atten_db)), "-D", "-o", os.path.join(d, "out"), inp],
                       check=True, capture_output=True, timeout=3600)
        shutil.move(os.path.join(d, "out", "in.wav"), dst)
    return dst


def run(src, dst, workdir, home, enhance=None, similarity=None, prefer=None, note=print):
    """Clean src into dst. enhance(src, dst, params) -> bool runs Resemble Enhance (None = unavailable);
    similarity(ref, [paths]) -> [floats] checks identity (None = skip). prefer: None (auto), "denoise" (never
    restore: keeps the exact tone) or "enhance" (always restore). Returns the report."""
    before = quality.analyze(src)
    plan = quality.cleanup_plan(before, prefer)
    if prefer == "enhance" and not any(s["step"] == "restore" for s in plan["steps"]):
        plan["steps"].append({"step": "restore", "strength": 0.5})
        plan["why"] += "; restore asked for"
    cur, applied, skipped, stages = src, [], [], [src]
    for n, step in enumerate(plan["steps"]):
        out = os.path.join(workdir, f"clean.step{n}.wav")
        try:
            if step["step"] == "denoise":
                note("removing background noise (DeepFilterNet)")
                denoise(home, cur, out, step["atten_db"])
            elif enhance is None or not enhance(cur, out, {"mode": "enhance", "strength": step["strength"]}):
                continue
        except Exception as e:  # noqa: BLE001  one tool failing shouldn't sink the job: keep what we have
            skipped.append({**step, "error": f"{type(e).__name__}: {str(e)[:120]}"})
            continue
        cur = out
        stages.append(out)
        applied.append(step)
    # verify: same voice, actually cleaner. Walk back one stage at a time until both hold.
    sims = None
    if similarity and len(stages) > 1:
        try:
            sims = similarity(src, stages[1:])
        except Exception:  # noqa: BLE001
            sims = None
    pick = len(stages) - 1
    while pick > 0:
        ok_voice = sims is None or sims[pick - 1] >= IDENTITY_MIN
        if ok_voice:
            break
        pick -= 1
    chosen = stages[pick]
    after = quality.analyze(chosen) if pick else before
    if pick < len(stages) - 1:
        plan["why"] += f"; kept step {pick} of {len(stages) - 1} (later steps changed the voice too much)"
    if chosen != dst:
        shutil.copy(chosen, dst)
    for s in stages[1:]:
        if os.path.exists(s) and s != dst:
            os.remove(s)
    return {"before": before, "after": after, "steps": applied[:pick], "skipped": skipped, "why": plan["why"],
            "identity": None if sims is None or not pick else round(sims[pick - 1], 3)}
