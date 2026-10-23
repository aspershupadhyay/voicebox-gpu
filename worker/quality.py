"""Voice quality engine: how good is a take, and how bad is a recording.

score_text   - did the voice say the script? Script and transcript both go through the same spoken form (the lexicon),
               then are compared three ways: words, sound-alike words (a phonetic key) and letters. Whisper writing
               "SQL" for "sequel" or "Cubernetes" for "Kubernetes" no longer swings the number; a skipped or invented
               word still does. Also lists what was missed/added, so a retry can be explained.
take_score   - one number to rank takes: script accuracy first, then voice match (vs the voice's own baseline),
               naturalness (UTMOS, when available), and penalties for run-on tails and clipping.
analyze      - measures a recording: level, noise floor / SNR, effective bandwidth, reverb tail, clipping.
cleanup_plan - picks the clean-up chain from those measurements instead of one fixed recipe.
"""
import difflib
import math
import re

from lexicon import speakable

# ── text ──────────────────────────────────────────────────────────────────────────────────────────────────────────

_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def num_words(n):
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000:
        return _ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + num_words(n % 100))
    for div, name in ((10 ** 9, "billion"), (10 ** 6, "million"), (1000, "thousand")):
        if n >= div:
            return num_words(n // div) + " " + name + ("" if n % div == 0 else " " + num_words(n % div))
    return str(n)


_CONTRACT = {"won't": "will not", "can't": "can not", "cannot": "can not", "n't": " not", "'re": " are", "'ll": " will",
             "'ve": " have", "'m": " am", "'d": " would", "it's": "it is", "that's": "that is", "what's": "what is",
             "there's": "there is", "here's": "here is", "let's": "let us"}


def words(s, spoken=True):
    """Lower-case word list in spoken form: tags, markup and [pause] markers out, contractions expanded,
    numbers spelled, hyphens and dotted initials joined, so two renderings of the same speech compare equal."""
    if spoken:
        s = speakable(s, None, tech=True) or s
    s = re.sub(r"<[^>]{1,20}>|\[[^\]]{1,20}\]|\([a-z ]{2,20}\)", " ", s.lower().replace("’", "'"))
    for a, b in _CONTRACT.items():
        s = s.replace(a, b)
    s = re.sub(r"\b((?:[a-z]\.){2,})", lambda m: m.group(1).replace(".", ""), s)
    s = re.sub(r"(?<=\w)-(?=\w)", " ", s)
    s = re.sub(r"(\d+)\.(\d+)", lambda m: f"{m.group(1)} point {' '.join(m.group(2))}", s)  # 2.1 -> 2 point 1
    s = re.sub(r"\d[\d,]*", lambda m: num_words(int(m.group(0).replace(",", ""))) if m.group(0).replace(",", "").isdigit() and len(m.group(0)) < 10 else m.group(0), s)
    s = s.replace("%", " percent").replace("per cent", "percent").replace("&", " and ")
    out, run = [], False
    for w in re.findall(r"[a-z0-9']+", s):  # spelled-out letters are one word: "a p i" == "api"
        letter = len(w) == 1 and w.isalpha()
        if letter and run:
            out[-1] += w
        else:
            out.append(w)
        run = letter or (run and letter)
    return out


def phonetic(w):
    """A small sound-alike key (Soundex-like, but keeps vowel position): their/there, two/to, colour/color,
    'cubernetes'/'kubernetes' share a key."""
    w = re.sub(r"[^a-z]", "", w.lower())
    if not w:
        return ""
    for a, b in (("ph", "f"), ("ck", "k"), ("qu", "kw"), ("x", "ks"), ("wh", "w"), ("gh", ""), ("kn", "n"), ("wr", "r"), ("ps", "s")):
        w = w.replace(a, b)
    groups = {**dict.fromkeys("bp", "1"), **dict.fromkeys("fv", "2"), **dict.fromkeys("ckgjqsxz", "3"), **dict.fromkeys("dt", "4"),
              "l": "5", **dict.fromkeys("mn", "6"), "r": "7"}
    head = "a" if w[0] in "aeiouy" else groups.get(w[0], w[0])
    key, prev = head, groups.get(w[0], "")
    for ch in w[1:]:
        g = groups.get(ch, "")
        if g and g != prev:
            key += g
        prev = g
    return key[:6]


def _ratio(a, b):
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() if a and b else 0.0


def _join_compounds(a, b):
    """Merge neighbours in `a` whose concatenation is a word of `b`: "seg faults" vs "segfaults", "data base"."""
    want, out, i = set(b), [], 0
    while i < len(a):
        if i + 1 < len(a) and a[i] + a[i + 1] in want and a[i] not in want:
            out.append(a[i] + a[i + 1]); i += 2
        else:
            out.append(a[i]); i += 1
    return out


def score_text(script, heard, said=None):
    """How faithfully `heard` (ASR) renders `script` (or `said`, its spoken form). 0..1 plus the differences.
    Both sides go through the same spoken form, split/joined compounds are reconciled, then 60% sound-alike words
    (order-aware) + 40% letters. Spelling variants score ~1.0; a skipped, swapped or invented word costs points."""
    heards = {tuple(words(heard, spoken=False)), tuple(words(heard))}
    refs = {tuple(words(x, spoken=sp)) for x in (script, said) if x for sp in (True, False)}
    best = None
    for rw in refs:
        for hw in heards:
            if not rw or not hw:
                continue
            rw2, hw2 = _join_compounds(list(rw), list(hw)), _join_compounds(list(hw), list(rw))
            rk, hk = [phonetic(x) for x in rw2], [phonetic(x) for x in hw2]
            s = 0.6 * _ratio(rk, hk) + 0.4 * _ratio("".join(rw2), "".join(hw2))
            if best is None or s > best[0]:
                best = (s, rw2, hw2, rk, hk)
    if best is None:
        return {"score": None, "missed": [], "added": []}
    _, rw, hw, rk, hk = best
    missed, added = [], []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, rk, hk, autojunk=False).get_opcodes():
        if tag in ("delete", "replace"):
            missed += rw[i1:i2]
        if tag in ("insert", "replace"):
            added += hw[j1:j2]
    return {"score": round(min(1.0, best[0]), 3), "missed": missed[:12], "added": added[:12]}


# ── ranking takes ────────────────────────────────────────────────────────────────────────────────────────────────

def take_score(text, sim=None, sim_base=None, mos=None, dur=None, med_dur=None, clipped=0.0):
    """Rank one take. Script accuracy dominates (a wrong word is never worth a nicer timbre); voice match counts
    relative to what this voice usually achieves, so a voice whose clones sit at 0.88 isn't punished against one
    that sits at 0.95; naturalness breaks ties."""
    s = 2.0 * (text if text is not None else 0.85)
    if sim is not None:
        base = sim_base if sim_base is not None else 0.9
        s += 1.2 * max(-0.15, min(0.08, sim - base))
    if mos is not None:
        s += 0.15 * (mos - 3.5)
    if dur and med_dur and dur > 1.5 * med_dur + 0.5:  # a tail much longer than its siblings is usually a hallucination
        s -= 0.6
    s -= 2.0 * min(0.05, clipped)
    return round(s, 4)


def failed(text, sim=None, sim_base=None, gate=None):
    """Does a sentence need another try? Text below the gate, or a voice clearly off its own baseline."""
    g = gate or REVIEW
    if text is not None and text < g["text_gate"]:
        return "words"
    if sim is not None and sim < (sim_base if sim_base is not None else g["sim_floor"] + 0.06) - g["sim_drop"]:
        return "voice"
    return None


REVIEW = {
    "text_gate": 0.93,   # below this, a sentence was misread (skipped, swapped or invented words)
    "sim_drop": 0.05,    # this far under the voice's usual similarity = it drifted off-voice
    "sim_floor": 0.8,    # baseline guess before a voice has history
    "rounds": 2,         # extra attempts per failing sentence
}


# ── recordings ───────────────────────────────────────────────────────────────────────────────────────────────────

def analyze(path):
    """Measure a recording (mono, any rate). Returns level_db (active speech RMS), noise_db (floor), snr_db,
    bandwidth_hz (highest frequency within 50 dB of the speech spectrum's peak), reverb_s (T60 implied by how
    fast the level falls after words: dry speech ~0.2-0.35 s, a bare room 0.5 s+), clipped (fraction of near-full-scale samples), speech_s."""
    import numpy as np
    import soundfile as sf
    a, sr = sf.read(path, dtype="float32", always_2d=False)
    if a.ndim > 1:
        a = a.mean(axis=1)
    if len(a) < sr // 2:
        return {"level_db": None, "noise_db": None, "snr_db": None, "bandwidth_hz": None, "reverb_s": None, "clipped": 0.0, "speech_s": 0.0, "sr": sr}
    hop, win = int(0.01 * sr), int(0.03 * sr)
    n = 1 + (len(a) - win) // hop
    frames = np.lib.stride_tricks.as_strided(a, (n, win), (a.strides[0] * hop, a.strides[0]))
    e = 10 * np.log10(np.mean(frames ** 2, axis=1) + 1e-12)
    live = e[e > -95]  # digital silence (padding, gated edits) isn't the room's noise floor
    if len(live) < 20:
        live = e
    floor, peak = np.percentile(live, 10), np.percentile(live, 95)
    speech = e > max(floor + 10, peak - 30)
    level = 10 * np.log10(np.mean(10 ** (e[speech] / 10)) + 1e-12) if speech.any() else float(peak)
    # bandwidth: the highest frequency where the long-term speech spectrum is still within 50 dB of its peak
    bw = None
    if speech.any():
        sel = frames[speech][:: max(1, int(speech.sum()) // 400)]
        spec = lambda x: np.convolve(10 * np.log10(np.mean(np.abs(np.fft.rfft(x * np.hanning(win), axis=1)) ** 2, axis=0) + 1e-20), np.ones(5) / 5, mode="same")
        ltas = spec(sel)
        quiet = frames[(e <= floor + 3) & (e > -95)]
        ok = ltas > ltas.max() - 50
        if len(quiet) >= 10:  # with background noise, only count frequencies where the voice stands above the noise
            ok &= ltas > spec(quiet[:: max(1, len(quiet) // 300)]) + 6
        above = np.where(ok)[0]
        bw = float(above[-1] * sr / win) if len(above) else None
    # reverb: after each word, fit how fast the level falls (dB/s); dry speech stops in ~0.1-0.2 s, a room rings on.
    # Report the T60 implied by the slower half of the decays (the room shows in the free decays, not the fast ones).
    def decays(smooth, tol):
        sm = np.convolve(e, np.ones(smooth) / smooth, mode="same")
        out, i = [], 6
        while i < n - 8:
            if sm[i] > floor + 20 and sm[i] >= sm[i - 6:i + 7].max():
                j = i
                while j < min(n - 1, i + 150) and sm[j + 1] <= sm[j] + tol and sm[j] > floor + 5:
                    j += 1
                drop = sm[i] - sm[j]
                if drop >= 10 and j - i >= 3:
                    out.append(60 / (drop / ((j - i) * hop / sr)))
                i = max(j, i + 1)
            else:
                i += 1
        return out
    t60s = decays(3, 0.5)
    if len(t60s) < 4:  # a long, rough room tail breaks the fine walk: follow a smoother envelope instead
        t60s = decays(5, 1.5)
    reverb = float(np.median(sorted(t60s)[len(t60s) // 2:])) if len(t60s) >= 4 else None
    clipped = float(np.mean(np.abs(a) > 0.995))
    return {"level_db": round(float(level), 1), "noise_db": round(float(floor), 1), "snr_db": round(float(level - floor), 1),
            "bandwidth_hz": round(bw) if bw else None, "reverb_s": round(reverb, 3) if reverb is not None else None,
            "clipped": round(clipped, 5), "speech_s": round(float(speech.sum() * hop / sr), 2), "sr": sr}


def cleanup_plan(m, prefer=None):
    """Choose clean-up steps from measurements (see analyze), most transparent first:
       none     - already clean: just the voice chain and mastering (keeps your exact tone)
       denoise  - DeepFilterNet: removes steady and moving noise without touching the voice's timbre
       restore  - Resemble Enhance: rebuilds missing highs (phone/laptop mics) and dries a roomy recording
    Both run when a recording is noisy *and* narrow or echoey. Strength scales with how bad it is.
    `prefer` ("denoise"/"enhance") narrows the choice: denoise never restores, so the tone is untouched."""
    snr, bw, rev, clip = m.get("snr_db"), m.get("bandwidth_hz"), m.get("reverb_s"), m.get("clipped") or 0
    noisy = snr is not None and snr < 32
    very_noisy = snr is not None and snr < 18
    narrow = bw is not None and bw < 7000
    roomy = rev is not None and rev > 0.45
    steps, why = [], []
    if noisy:
        steps.append({"step": "denoise", "atten_db": 100 if very_noisy else 30 if snr > 26 else 60})
        why.append(f"noise floor {snr:.0f} dB under the voice")
    if prefer != "denoise" and (narrow or roomy or very_noisy):
        sev = max((7000 - bw) / 4000 if narrow else 0, (rev - 0.45) / 0.5 if roomy else 0, 0.3 if very_noisy else 0)
        steps.append({"step": "restore", "strength": round(min(0.85, 0.35 + 0.5 * min(1.0, sev)), 2)})
        why.append(", ".join(x for x in (f"bandwidth {bw / 1000:.1f} kHz" if narrow else "", f"room echo {rev:.2f} s" if roomy else "") if x) or "heavy noise")
    if clip > 0.001:
        why.append(f"{clip * 100:.1f}% clipped samples (can't be undone; record a little quieter)")
    return {"steps": steps, "why": "; ".join(why) or "clean recording: mastering only"}
