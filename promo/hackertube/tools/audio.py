#!/usr/bin/env python3
"""Music bed + SFX stems for the HackerTube Reel, timed from vo.json (the same times the film reads).
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

# ---------------- music ----------------
BPM = 112; beat = 60 / BPM; bar = 4 * beat
music = np.zeros(N)
# Am  F  C  G  (voicings, midi)
CH = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]]
BASS = [45, 41, 36, 43]
hole0, hole1 = S('l14') - 0.25, S('l14') + 0.15   # a held breath before the question
end_t = S('l15')

def intensity(t):
    if t < S('l03'): return 0.55
    if t < S('l07'): return 0.75
    if t < S('l13'): return 1.0
    if t < S('l14'): return 1.0
    return 0.6

nbars = int(DUR / bar) + 2
for b in range(nbars):
    t0 = b * bar
    if t0 > DUR: break
    c = CH[b % 4]
    # pad: detuned saws, filtered
    n = int(bar * SR) + int(0.4 * SR); tt = np.arange(n) / SR
    pad = np.zeros(n)
    for m in c:
        for d in (-0.08, 0.08):
            f = mtof(m + d); pad += 2 * ((tt * f) % 1) - 1
    pad = lp(pad, 900 + 500 * np.sin(np.pi * tt / bar)) * env(n, 0.25, 0.45) * 0.035
    put(music, t0, pad, intensity(t0))
    # sub bass on beats 1 and 3
    for k in (0, 2):
        tb = t0 + k * beat; n = int(beat * 1.6 * SR); tt = np.arange(n) / SR
        put(music, tb, np.sin(2 * np.pi * mtof(BASS[b % 4] - 12) * tt) * np.exp(-tt * 2.2) * 0.22, intensity(tb))
    # pluck arpeggio, 8ths, from the problem on
    if t0 >= S('l02') - 0.01:
        for k in range(8):
            tp = t0 + k * beat / 2
            m = c[[0, 2, 1, 3, 2, 1, 3, 2][k]] + 12
            n = int(0.35 * SR); tt = np.arange(n) / SR
            x = (np.sin(2 * np.pi * mtof(m) * tt) + 0.3 * np.sin(4 * np.pi * mtof(m) * tt)) * np.exp(-tt * 14)
            put(music, tp, x * 0.05 * (1 if k % 2 == 0 else 0.7), intensity(tp))
    # soft hat ticks (no drum loop: a light shaker on the off-beats, only in the middle stretch)
    if S('l07') <= t0 < S('l13'):
        for k in range(4):
            th = t0 + k * beat + beat / 2; n = int(0.05 * SR)
            x = rng.standard_normal(n); x = x - lp(x, 6000); put(music, th, x * np.exp(-np.arange(n) / SR * 90) * 0.03)

# riser into the reveal
r0, r1 = S('l07') - 1.2, S('l07')
n = int((r1 - r0) * SR); tt = np.arange(n) / SR
x = rng.standard_normal(n); x = lp(x, 400 + 6000 * (tt / tt[-1]) ** 2) * (tt / tt[-1]) ** 2 * 0.12
put(music, r0, x)
# the held breath, then the outro chord
m = (t_all >= hole0) & (t_all < hole1)
fade = np.ones(N); fade[m] = 0.0
k = int(0.06 * SR); i0 = int(hole0 * SR); fade[i0 - k:i0] = np.linspace(1, 0, k); i1 = int(hole1 * SR); fade[i1:i1 + k] = np.linspace(0, 1, k) * 1
music *= fade
# end: fade the groove, ring one chord
i = int(end_t * SR); music[i:] *= np.linspace(1, 0.0, len(music) - i) ** 1.5
n = int(3.0 * SR); tt = np.arange(n) / SR; ch = np.zeros(n)
for mm in [57, 60, 64, 69, 76]: ch += np.sin(2 * np.pi * mtof(mm) * tt) * np.exp(-tt * 1.1)
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

cuts = [S(i) for i in ['l02', 'l03', 'l05', 'l07', 'l08', 'l09', 'l10', 'l11', 'l12', 'l13', 'l14', 'l15']]
for c in cuts: whoosh(c, g=0.7); tick(c, 1800, 0.6)
# hook: the timer ticks over
t2 = at('l01', 'in') - 0.1
for k in range(14): tick(t2 + k * 1.25 / 14, 3200, 0.35)
# feed cards pop in, then dim
for i in range(6): pop(S('l02') + 0.05 + i * 0.06, 900 + i * 40, 0.5)
# counter 43M
n0 = at('l03', 'forty') - 0.1; n1 = at('l03', 'hacker') + 0.35
for k in range(int((n1 - n0) / 0.045)): tick(n0 + k * 0.045, 2800 + (k % 3) * 200, 0.25)
pop(n1 - 0.3, 500, 0.7)
# 20 years line
for k in range(21): tick(S('l04') - 0.05 + 0.9 * (k / 20) ** 0.7, 2000, 0.2)
# the count lands on 6,454
c0 = S('l06') - 0.05
for k in range(18): tick(c0 + k * 0.05, 2600, 0.25)
boom(E('l06') - 0.25, 0.6)
# the reveal
boom(S('l07'), 1.0); chime(S('l07') + 0.05, 0.6)
pop(S('l07') + 0.35, 600, 0.5)
# no login: strike
stamp_strike(at('l08', 'login') + 0.15); pop(at('l08', 'your'), 800, 0.5)
# thumbnails: playhead lands
tick(S('l09') + 1.0, 1500, 0.8); pop(at('l09', 'real'), 700, 0.6); pop(at('l09', 'not'), 500, 0.5)
# typing
p0 = at('l10', 'point') + 0.2
for k in range(30): key(p0 + k * 1.1 / 30 + (rng.random() - .5) * 0.01, 0.8)
pop(at('l10', 'build'), 900, 0.6)
# checks
for w in ['api', 'server', 'domain']: pop(at('l11', w) + 0.12, 1100, 0.6)
# deploy steps
for w in ['secured', 'hardened', 'deployed']: pop(at('l12', w) + 0.3, 1200, 0.55)
pop(S('l12') + 0.9, 1200, 0.5); pop(at('l12', 'deployed') + 0.75, 1300, 0.5)
# months struck, breakfast
stamp_strike(at('l13', 'months') + 0.35); chime(at('l13', 'breakfast'), 0.4)
# the question lands after the held breath
boom(S('l14') + 0.05, 0.5)
# end card
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
