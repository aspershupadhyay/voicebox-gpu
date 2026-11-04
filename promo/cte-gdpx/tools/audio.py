#!/usr/bin/env python3
"""The SFX stem and the music stem, from out/cues.json (film.html's cues(): every sound is tied to something on screen).
usage: python3 tools/audio.py <dir of the SFX library as 48 kHz mono WAVs>
  - each clip is levelled first (its loudest 50 ms to -12 dBFS), then gets its cue's dB
  - peak: true puts the clip's loudest moment ON the cue (the whoosh peaks on the fastest frame), or on cue.at
  - reverse: true flips the first `len` seconds into a riser that swells into t + len
  - len / fade trim long files and fade their tail
  - music: nightfall-future-bass, faded in and out, laid under the whole film (mix.py ducks it under the voice)"""
import sys, json, wave, numpy as np
D = sys.argv[1]; SR = 48000
C = json.load(open('out/cues.json')); DUR = C['duration']; N = int(DUR * SR)
def read(name):
    with wave.open(f'{D}/{name}.wav') as w:
        a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    return a
def loudest(a, win=2400):
    e = np.sqrt(np.convolve(a * a, np.ones(win) / win, 'same') + 1e-12); return int(np.argmax(e)), float(e.max())
sfx = np.zeros(N + SR * 4, np.float32); used = {}
rng = np.random.default_rng(3)
def pen(dur):
    # a felt-tip on paper: band-passed noise whose loudness follows the stroke's speed (fast in the middle of each loop)
    n = int(dur * SR); t = np.arange(n) / SR; x = rng.standard_normal(n).astype(np.float32)
    X = np.fft.rfft(x); f = np.fft.rfftfreq(n, 1 / SR); X *= ((f > 1800) & (f < 7500)) * (1 + 0.5 * np.sin(f / 900))
    x = np.fft.irfft(X, n).astype(np.float32)
    sp = 0.55 + 0.45 * np.abs(np.sin(np.pi * t / (dur / 2.35)))          # one swell per loop of the ring
    grain = 1 + 0.35 * rng.standard_normal(n // 240 + 1).repeat(240)[:n]  # the paper's tooth
    env = np.minimum(1, t / .03) * np.minimum(1, (dur - t) / .08)
    return (x * sp * grain * env).astype(np.float32)
for q in C['cues']:
    a = pen(q.get('len', .7)) if q.get('synth') == 'pen' else read(q['f']).copy()
    if q.get('reverse'): a = a[:int(q.get('len', 1) * SR)][::-1].copy()
    elif q.get('len'): a = a[:int(q['len'] * SR)]
    if q.get('fade'):
        n = min(len(a), int(q['fade'] * SR)); a[-n:] *= np.linspace(1, 0, n) ** 1.5
    pk, lv = loudest(a); a *= (10 ** (-12 / 20) / max(lv, 1e-6)) * 10 ** (q.get('db', 0) / 20)
    t = q['t']
    if q.get('peak'): t = q.get('at', t) - pk / SR
    i = int(round(t * SR))
    if i < 0: a = a[-i:]; i = 0
    sfx[i:i + len(a)] += a[:len(sfx) - i]; used[q['f']] = used.get(q['f'], 0) + 1
sfx = sfx[:N]
def write(p, a):
    with wave.open(p, 'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(a / max(1e-6, np.abs(a).max()) * .89, -1, 1) * 32767).astype(np.int16).tobytes())
# music: segments of the bed (film.html MUSIC(): where it plays, from which point of the track), faded at each edge;
# with no segments, the bed runs under the whole film
m0 = read(C.get('bed') or 'nightfall120'); m = np.zeros(N, np.float32)
for g in (C.get('music') or [{'t0': 0, 't1': DUR, 'offset': 0, 'fadein': .4, 'fadeout': 3}]):
    i0, i1 = int(g['t0'] * SR), min(N, int(g['t1'] * SR)); o = int(g.get('offset', 0) * SR)
    seg = m0[o:o + (i1 - i0)].copy(); n = len(seg)
    fi, fo = int(g.get('fadein', .05) * SR), int(g.get('fadeout', .05) * SR)
    if fi: seg[:fi] *= np.linspace(0, 1, min(fi, n))[:n] if fi <= n else 1
    if fo and fo <= n: seg[-fo:] *= np.linspace(1, 0, fo) ** 2
    m[i0:i0 + n] += seg
write('out/stem_music.wav', m)
# the Shepard tone (film.html SHEPARD()): octaves of a sine gliding up for ever under a fixed bell curve, so it keeps
# rising without getting higher. It goes in the SFX stem, so it's held under the voice like everything else.
def shepard(dur, rate, f0=55.0, octaves=7):
    t = np.arange(int(dur * SR)) / SR; out = np.zeros_like(t)
    for k in range(octaves):
        pos = (k + rate * t) % octaves                     # where this voice sits, in octaves above f0
        f = f0 * 2 ** pos; ph = 2 * np.pi * np.cumsum(f) / SR
        amp = np.exp(-.5 * ((pos - octaves / 2) / 1.3) ** 2)
        out += amp * np.sin(ph)
    out /= np.abs(out).max() + 1e-9; n = min(len(out), int(.25 * SR))
    out[:n] *= np.linspace(0, 1, n); out[-n:] *= np.linspace(1, 0, n); return out.astype(np.float32)
for g in (C.get('shepard') or []):
    a = shepard(g['t1'] - g['t0'], g.get('rate', .3)) * 10 ** ((g.get('db', -10) - 12) / 20) * 4
    i = int(g['t0'] * SR); sfx[i:i + len(a)] += a[:len(sfx) - i]
write('out/stem_sfx.wav', sfx)
print(f'{len(C["cues"])} cues, {len(used)} different sounds from the library; music {len(C.get("music") or [1])} segment(s); shepard {len(C.get("shepard") or [])}')
json.dump(used, open('out/sfx_used.json', 'w'), indent=1)
