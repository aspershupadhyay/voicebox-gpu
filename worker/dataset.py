"""Training data for your own voice model: long recordings -> short, clean, transcribed clips.

Whisper's word timestamps say where every word is. Clips end at a sentence end (or a breath pause when a sentence runs
long), 2-20 s each, so the model learns whole phrases with natural endings. Clip lengths are deliberately mixed (short,
medium, long in turn): long clips hold two or three sentences, so the model hears how you move from one sentence to the
next (the pause, the reset in pitch), which is what the engine is asked to do on a long script. Every clip is checked before it's kept:
long enough, not clipped, voice well above the noise, and a plausible speaking rate (a clip whose text and audio
disagree, e.g. a mis-timed cut, reads impossibly fast or slow). Output: LJSpeech-style `metadata.csv` (file|text) +
24 kHz mono WAVs, which is what the Orpheus/SNAC training notebook reads.
"""
import re

MIN_S, MAX_S = 2.0, 20.0
TARGETS = (4.0, 9.0, 15.0)  # each clip aims for the next of these in turn: a mix of short, medium and long
END = re.compile(r"[.!?…]['\")\]]?$")
HARD_GAP = 1.2   # a silence this long always ends a clip (moving to the next read-along line, a sip of water)
LEVEL_DB = -20.0  # every clip is brought to this active-speech level, so the model hears one consistent loudness
SNR_MIN = 28.0    # after denoising, a clean room sits well above this; below it the noise gets learnt with the voice
REVERB_MAX = 0.55  # seconds of T60: past this the room's echo is part of every clip
BANDWIDTH_MIN = 6000  # Hz: narrower than this is a phone line or a muffled mic


def segment(words, total_s):
    """Group Whisper words [{w, s, e}] into clips [(start, end, text)]: cut at a sentence end once a clip reaches its
    target length (4, 9 or 15 s in turn), at the widest pause once it runs past the target with no sentence end, and
    always before 20 s."""
    clips, cur = [], []

    def flush(upto):
        nonlocal cur
        part, cur = cur[:upto], cur[upto:]
        if part:
            clips.append(part)

    for w in words:
        if cur and w["s"] - cur[-1]["e"] >= HARD_GAP and cur[-1]["e"] - cur[0]["s"] >= 1.0:
            flush(len(cur))  # a long silence is a clip boundary, never something to learn inside a clip
        elif cur and w["s"] - cur[-1]["e"] >= HARD_GAP:
            cur = []  # a stray word or two before a long pause: not worth a clip
        cur.append(w)
        dur = cur[-1]["e"] - cur[0]["s"]
        target = TARGETS[len(clips) % len(TARGETS)]
        if END.search(w["w"]) and dur >= max(MIN_S, target - 2.5):
            flush(len(cur))
        elif dur >= target + 3.0:  # a sentence that won't end: cut at a breath
            gaps = [(cur[i + 1]["s"] - cur[i]["e"], i + 1) for i in range(len(cur) - 1) if cur[i + 1]["s"] - cur[0]["s"] >= MIN_S]
            if gaps and (max(gaps)[0] >= 0.3 or dur >= MAX_S - 1):
                flush(max(gaps)[1])
            elif dur >= MAX_S - 1:
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
    if m.get("snr_db") is not None and m["snr_db"] < SNR_MIN:
        return "noisy"
    if m.get("reverb_s") is not None and m["reverb_s"] > REVERB_MAX:
        return "echo"
    if m.get("bandwidth_hz") is not None and m["bandwidth_hz"] < BANDWIDTH_MIN:
        return "muffled"
    return None


def level_gain(m, peak):
    """Linear gain that brings a clip's active speech to LEVEL_DB without its peak passing -1 dBFS (and never more
    than +/-15 dB: a clip that far off is better dropped by the checks than rescued)."""
    lvl = m.get("level_db")
    if lvl is None or peak <= 0:
        return 1.0
    db = max(-15.0, min(15.0, LEVEL_DB - lvl))
    return min(10 ** (db / 20), 10 ** (-1 / 20) / peak)


WHY = {"short": "under 1.5 s", "long": "over 21 s", "no words": "no words heard", "timing": "words and audio out of step",
       "clipped": "distorted (too loud)", "noisy": "background noise", "echo": "room echo", "muffled": "muffled sound"}


def explain(dropped):
    """'12 background noise, 3 room echo': why clips were dropped, biggest reason first."""
    return ", ".join(f"{n} {WHY.get(k, k)}" for k, n in sorted(dropped.items(), key=lambda kv: -kv[1]))
