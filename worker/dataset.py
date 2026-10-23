"""Training data for your own voice model: long recordings -> short, clean, transcribed clips.

Whisper's word timestamps say where every word is. Clips end at a sentence end (or a breath pause when a sentence runs
long), 2-12 s each, so the model learns whole phrases with natural endings. Every clip is checked before it's kept:
long enough, not clipped, voice well above the noise, and a plausible speaking rate (a clip whose text and audio
disagree, e.g. a mis-timed cut, reads impossibly fast or slow). Output: LJSpeech-style `metadata.csv` (file|text) +
24 kHz mono WAVs, which is what the Orpheus/SNAC training notebook reads.
"""
import re

MIN_S, TARGET_S, MAX_S = 2.0, 7.0, 12.0
END = re.compile(r"[.!?…]['\")\]]?$")


def segment(words, total_s):
    """Group Whisper words [{w, s, e}] into clips [(start, end, text)]: cut at sentence ends once a clip is >= 2 s,
    at the widest pause once it passes the target length, and always before 12 s."""
    clips, cur = [], []

    def flush(upto):
        nonlocal cur
        part, cur = cur[:upto], cur[upto:]
        if part:
            clips.append(part)

    for w in words:
        cur.append(w)
        dur = cur[-1]["e"] - cur[0]["s"]
        if END.search(w["w"]) and dur >= MIN_S:
            flush(len(cur))
        elif dur >= TARGET_S:
            gaps = [(cur[i + 1]["s"] - cur[i]["e"], i + 1) for i in range(len(cur) - 1) if cur[i + 1]["s"] - cur[0]["s"] >= MIN_S]
            if gaps and (max(gaps)[0] >= 0.3 or dur >= MAX_S):
                flush(max(gaps)[1])
            elif dur >= MAX_S:
                flush(len(cur))
    flush(len(cur))
    out = []
    for i, part in enumerate(clips):
        # pad into the silence around the clip, never into the neighbours
        prev_e = clips[i - 1][-1]["e"] if i else 0.0
        next_s = clips[i + 1][0]["s"] if i + 1 < len(clips) else total_s
        s = max(prev_e, part[0]["s"] - 0.12)
        e = min(next_s, part[-1]["e"] + 0.2)
        text = re.sub(r"\s+(?=[.,!?;:%’])", "", " ".join(x["w"] for x in part)).strip()
        out.append((round(s, 3), round(e, 3), text))
    return out


def keep(text, dur, m):
    """Why a clip is dropped, or None to keep it. m = quality.analyze() of the clip."""
    if dur < 1.5:
        return "short"
    if dur > MAX_S + 1:
        return "long"
    if not re.search(r"[A-Za-zऀ-ॿ]", text):
        return "no words"
    cps = len(re.sub(r"\s", "", text)) / max(dur, 0.1)
    if cps < 5 or cps > 22:  # Whisper and the audio disagree (missed words, music, a bad cut)
        return "timing"
    if (m.get("clipped") or 0) > 0.0015:
        return "clipped"
    if m.get("snr_db") is not None and m["snr_db"] < 22:
        return "noisy"
    return None
