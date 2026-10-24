"""Your voice in Kokoro: search Kokoro's voice space for the style vector that sounds most like a recording of you.

Kokoro (the engine behind af_heart) is tiny, deterministic and very clean, but it only speaks with its built-in voices.
Each voice is a style tensor (510 x 1 x 256, one 256-d style per input length). This finds a new one:

  1. audition every English built-in voice on the same sentences and measure how close each is to your recording
     (WavLM speaker embeddings, the same "voice match" the review uses);
  2. start from a blend of the closest few, weighted by how close they are;
  3. random-walk over the *mix*: a voice is a weighted blend of all the built-in ones (weights may go a little
     negative, which pushes away from a voice), so the search moves in ~28 dimensions instead of 130,000 and every
     step is still a plausible voice. Each round tries a handful of nudged mixes, keeps the best if it beats the
     current one, and shrinks the steps as it settles;
  4. guard the words: the final voice is checked with Whisper on a sentence it was never tuned on, and if it
     mumbles, the search steps back to an earlier, clearer state.

The result plays at Kokoro speed and clarity, in something much closer to your voice. It is a nearest match inside
Kokoro's voice space, not a clone: a trained model (myvoice) still copies you more exactly.

Pure numpy; the gateway supplies the three callbacks (voice it, compare it, transcribe it), so the engines stay
in their own processes.
"""
import numpy as np

SEARCH_LINES = [
    "Okay, so here's the thing nobody tells you about batteries. They don't store electricity at all.",
    "Let's break it down step by step, and by the end you'll know exactly why it works.",
]
CHECK_LINE = "Thanks for watching, and I'll see you in the next one, where we finally answer the big question."


def english_voices(names):
    """American and British voices: the space the walk explores (the other languages' voices pull toward accents)."""
    return [n for n in names if n[:2] in ("af", "am", "bf", "bm")]


def blend(scores, k=3, sharp=25.0):
    """Mixing weights over all voices: the k closest, closer voices weigh more (softmax of similarity x sharp).
    Returns (weights, indices of the k picked)."""
    scores = np.asarray(scores, dtype="float64")
    order = np.argsort(scores)[::-1][:k]
    w = np.zeros(len(scores))
    e = np.exp(sharp * (scores[order] - scores.max()))
    w[order] = e / e.sum()
    return w, [int(i) for i in order]


def mix(bank, w):
    """The voice for mixing weights w over bank (n x 510 x 1 x 256)."""
    return np.tensordot(np.asarray(w, dtype="float32"), bank, axes=1).astype("float32")


def walk(w0, start_score, try_batch, rounds=30, per_round=8, scale=(0.25, 0.03), floor=-0.3, seed=7, progress=None):
    """Hill-climb over mixing weights from w0. try_batch([weights]) -> [scores] (higher = closer to you). Steps anneal
    from scale[0] to scale[1]; weights are kept summing to 1 and no lower than floor (a little "less like that voice"
    is useful, a lot makes noise). Returns (best weights, best score, history of accepted (weights, score), latest last)."""
    rng = np.random.default_rng(seed)
    best, best_s = np.asarray(w0, dtype="float64"), start_score
    history = [(best, start_score)]
    for r in range(rounds):
        f = r / max(1, rounds - 1)
        step = scale[0] * (1 - f) + scale[1] * f
        cands = []
        while len(cands) < per_round:
            w = np.maximum(floor, best + rng.standard_normal(len(best)) * step * (rng.random(len(best)) < 0.35))
            if w.sum() > 0.5:  # mostly positive mixes: a near-zero sum would blow the voice up when normalised
                cands.append(w / w.sum())
        scores = try_batch(cands)
        i = int(np.argmax(scores))
        if scores[i] > best_s:
            best, best_s = cands[i], float(scores[i])
            history.append((best, best_s))
        if progress:
            progress(r + 1, rounds, best_s)
    return best, best_s, history
