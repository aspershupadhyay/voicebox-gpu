#!/usr/bin/env python3
"""Music bed + SFX stems for the Cyclon Reel, timed from vo.json (the same times the film reads).
usage: audio.py <vo.json> <outdir>   -> outdir/stem_music.wav, outdir/stem_sfx.wav (48 kHz stereo)"""
import sys, json, wave
import numpy as np

SR = 48000
vo = json.load(open(sys.argv[1])); out = sys.argv[2]
L = {l['id']: l for l in vo['lines']}
def S(i): return L[i]['start']
def E(i): return L[i]['end']
def at(i, word):
    for w in L[i]['words']:
        if ''.join(c for c in w['w'].lower() if c.isalnum()).startswith(word): return w['s']
    return L[i]['start']
DUR = E('l15') + 2.4
N = int(DUR * SR) + SR
rng = np.random.default_rng(7)
t_all = np.arange(N) / SR

def put(buf, t0, x, g=1.0):
    i = int(t0 * SR)
    if i >= len(buf): return
    x = x[: len(buf) - i]; buf[i:i + len(x)] += g * x

def env(n, a, r, sus=None):
    e = np.ones(n)
    na = max(1, int(a * SR)); e[:na] = np.linspace(0, 1, na)
    nr = max(1, int(r * SR)); e[-nr:] *= np.linspace(1, 0, nr) ** 2
    return e

def lp(x, cut):  # one-pole low-pass, cut may be an array
    a = np.exp(-2 * np.pi * np.asarray(cut) / SR) * np.ones(len(x))
    y = np.empty_like(x); s = 0.0
    for i in range(len(x)): s = (1 - a[i]) * x[i] + a[i] * s; y[i] = s
    return y

def mtof(m): return 440 * 2 ** ((m - 69) / 12)

# ---------------- music: 120 BPM, a light pulse under the voice ----------------
BPM = 120; beat = 60 / BPM; bar = 4 * beat
music = np.zeros(N)
# Dm  Bb  F  C  (voicings, midi)
CH = [[50, 57, 62, 65], [46, 53, 58, 62], [53, 57, 60, 65], [48, 55, 60, 64]]
BASS = [38, 34, 41, 36]
hole0, hole1 = S('l14') - 0.3, S('l14') + 0.1   # a held breath before the question
end_t = S('l15')
def intensity(t):
    if t < S('l03'): return 0.7
    if t < S('l05'): return 0.8
    if t < S('l13'): return 1.0
    return 0.7
def kick(t, g):
    n = int(0.3 * SR); tt = np.arange(n) / SR
    f = 45 + 90 * np.exp(-tt * 30); ph = 2 * np.pi * np.cumsum(f) / SR
    put(music, t, np.sin(ph) * np.exp(-tt * 11) * 0.30 * g)
nbars = int(DUR / bar) + 2
for b in range(nbars):
    t0 = b * bar
    if t0 > DUR: break
    c = CH[b % 4]; I = intensity(t0)
    n = int(bar * SR) + int(0.4 * SR); tt = np.arange(n) / SR
    pad = np.zeros(n)
    for m in c:
        for d in (-0.08, 0.08):
            f = mtof(m + d); pad += 2 * ((tt * f) % 1) - 1
    pad = lp(pad, 900 + 500 * np.sin(np.pi * tt / bar)) * env(n, 0.2, 0.45) * 0.03
    put(music, t0, pad, I)
    for k in range(4):           # sub on every beat, a soft kick on 1 and 3 from the demo on
        tb = t0 + k * beat; n = int(beat * 0.9 * SR); tt = np.arange(n) / SR
        put(music, tb, np.sin(2 * np.pi * mtof(BASS[b % 4] - 12) * tt) * np.exp(-tt * 4) * 0.16, I)
        if S('l05') - 0.01 <= tb < S('l13') and k in (0, 2): kick(tb, 0.8)
    for k in range(8):           # pluck arpeggio, 8ths
        tp = t0 + k * beat / 2
        m = c[[0, 2, 1, 3, 2, 1, 3, 2][k]] + 12
        n = int(0.3 * SR); tt = np.arange(n) / SR
        x = (np.sin(2 * np.pi * mtof(m) * tt) + 0.3 * np.sin(4 * np.pi * mtof(m) * tt)) * np.exp(-tt * 16)
        put(music, tp, x * 0.05 * (1 if k % 2 == 0 else 0.65), I)
    if S('l03') <= t0 < S('l13'):  # shaker on the off-beats
        for k in range(4):
            th = t0 + k * beat + beat / 2; n = int(0.05 * SR)
            x = rng.standard_normal(n); x = x - lp(x, 6000); put(music, th, x * np.exp(-np.arange(n) / SR * 90) * 0.035)
# risers into the demo and into the build
for tgt in (S('l05'), S('l08')):
    r0 = tgt - 1.0; n = int(1.0 * SR); tt = np.arange(n) / SR
    x = rng.standard_normal(n); x = lp(x, 400 + 6000 * (tt / tt[-1]) ** 2) * (tt / tt[-1]) ** 2 * 0.09
    put(music, r0, x)
m = (t_all >= hole0) & (t_all < hole1)
fade = np.ones(N); fade[m] = 0.0
k = int(0.06 * SR); i0 = int(hole0 * SR); fade[i0 - k:i0] = np.linspace(1, 0, k); i1 = int(hole1 * SR); fade[i1:i1 + k] = np.linspace(0, 1, k)
music *= fade
i = int(end_t * SR); music[i:] *= np.linspace(1, 0.0, len(music) - i) ** 1.5
n = int(3.0 * SR); tt = np.arange(n) / SR; ch = np.zeros(n)
for mm in [50, 57, 62, 65, 69]: ch += np.sin(2 * np.pi * mtof(mm) * tt) * np.exp(-tt * 1.1)
put(music, end_t, ch * 0.05)

# ---------------- SFX ----------------
sfx = np.zeros(N)
def whoosh(t, d=0.35, g=1.0):
    n = int(d * SR); tt = np.arange(n) / SR; x = rng.standard_normal(n)
    x = lp(x, 300 + 5000 * np.sin(np.pi * tt / d) ** 2) * np.sin(np.pi * tt / d) ** 2
    put(sfx, t - d * 0.6, x * 0.25 * g)
def tick(t, f=2400, g=1.0):
    n = int(0.03 * SR); tt = np.arange(n) / SR
    put(sfx, t, np.sin(2 * np.pi * f * tt) * np.exp(-tt * 180) * 0.35 * g)
def pop(t, f=700, g=1.0):
    n = int(0.12 * SR); tt = np.arange(n) / SR
    put(sfx, t, np.sin(2 * np.pi * (f + 500 * np.exp(-tt * 40)) * tt) * np.exp(-tt * 35) * 0.4 * g)
def boom(t, g=1.0):
    n = int(1.4 * SR); tt = np.arange(n) / SR
    f = 32 + 50 * np.exp(-tt * 6); ph = 2 * np.pi * np.cumsum(f) / SR
    put(sfx, t, np.sin(ph) * np.exp(-tt * 2.6) * 0.9 * g)
def key(t, g=1.0):
    n = int(0.025 * SR); x = rng.standard_normal(n); x = x - lp(x, 1500)
    put(sfx, t, x * np.exp(-np.arange(n) / SR * 260) * 0.35 * g)
def chime(t, g=1.0):
    n = int(2.0 * SR); tt = np.arange(n) / SR
    x = sum(np.sin(2 * np.pi * f * tt) * a for f, a in [(1318.5, 1), (1975.5, .5), (2637, .25)]) * np.exp(-tt * 2.5)
    put(sfx, t, x * 0.12 * g)
def stamp_strike(t, d=0.3):
    n = int(d * SR); tt = np.arange(n) / SR; x = rng.standard_normal(n)
    put(sfx, t, (x - lp(x, 2500)) * np.sin(np.pi * tt / d) * 0.12)

TR = {'l02': 'pix', 'l03': 'zoom', 'l04': 'up', 'l05': 'pix', 'l06': 'cut', 'l07': 'cut', 'l08': 'zoom', 'l09': 'push',
      'l10': 'cut', 'l11': 'pix', 'l12': 'push', 'l13': 'zoom', 'l14': 'cut', 'l15': 'pix'}
def sparkle(t):  # the pixel wipe: a quick run of tiny ticks
    for k in range(10): tick(t + k * 0.024, 3000 + 400 * (k % 4), 0.25)
for l, tr in TR.items():
    t = S(l)
    if tr in ('push', 'up'): whoosh(t + 0.13, 0.3, 0.9)
    elif tr == 'zoom': whoosh(t + 0.13, 0.35, 0.8); tick(t, 1500, 0.5)
    elif tr == 'pix': sparkle(t)
    else: tick(t, 1800, 0.7)
# hook: apps scatter
rep = at('l01', 'replace')
for k in range(10): pop(rep + 0.05 + k * 0.035, 500 + 60 * k, 0.35)
whoosh(rep + 0.35, 0.5, 0.6)
pop(at('l02', 'talk'), 900, 0.6)
boom(at('l03', 'cyclon') - 0.02, 0.7)
pop(at('l04', 'do'), 700, 0.5); pop(at('l04', 'ask'), 1000, 0.6)
# demo
pop(S('l05') + 0.05, 1200, 0.6)
for w in ('chats', 'gallery'): tick(at('l06', w), 2400, 0.6)
for k in range(12): pop(at('l06', 'chats') + k * 0.05, 1400 + 30 * k, 0.22)
pop(at('l07', 'tap'), 600, 0.8); chime(at('l07', 'sent'), 0.6)
for k in range(9): tick(at('l07', 'sent') + 0.05 + k * 0.025, 2600, 0.2)
# app grid, the missing one
for k in range(11): pop(S('l08') + 0.05 + k * 0.04, 800 + 40 * k, 0.25)
boom(at('l08', 'builds'), 0.5); chime(at('l08', 'builds') + 0.05, 0.4)
# typing the prompts
for ln, end in (('l09', E('l09')), ('l10', at('l10', 'done') - 0.1)):
    a = S(ln); nk = int((end - a) / 0.06)
    for k in range(nk): key(a + k * 0.06 + (rng.random() - .5) * 0.012, 0.7)
for k in range(6): pop(E('l09') - 0.1 + k * 0.125, 1000 + 50 * k, 0.35)
pop(at('l10', 'mandarin'), 1100, 0.5); chime(at('l10', 'done'), 0.5)
# the hub
for k in range(6): pop(S('l11') + 0.25 + k * 0.08, 900 + 50 * k, 0.3)
pop(at('l11', 'mcps'), 700, 0.6); pop(at('l11', 'apis'), 750, 0.6)
# background tasks
for k in range(3): pop(S('l12') + 0.35 + k * 0.5 + 0.35, 1300, 0.5)
# the catch
boom(S('l13'), 0.4); pop(at('l13', 'first'), 800, 0.5); pop(at('l13', 'their'), 600, 0.5)
# the question
for k in range(8): tick(S('l14') + 0.3 + k * 0.14, 1200 - 60 * k, 0.25)
boom(at('l14', 'dead'), 0.5)
chime(S('l15'), 0.8); pop(at('l15', 'follow'), 800, 0.6)

def write(path, x):
    x = x[: int(DUR * SR)]
    pk = np.abs(x).max(); x = x / pk * 0.8 if pk > 0 else x
    st = np.stack([x, x], 1)
    with wave.open(path, 'w') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(st, -1, 1) * 32767).astype(np.int16).tobytes())
write(f'{out}/stem_music.wav', music); write(f'{out}/stem_sfx.wav', sfx)
print(f'{DUR:.2f}s written')
