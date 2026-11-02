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
for q in C['cues']:
    a = read(q['f']).copy()
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
write('out/stem_sfx.wav', sfx)
# music bed: the track from the start; if the film runs longer, its middle section is looped once with a crossfade
m = read('nightfall-future-bass-music-228100')
if len(m) < N + SR:
    a0, a1, xf = int(40 * SR), int(70 * SR), int(1.5 * SR)
    ramp = np.linspace(0, 1, xf)
    head, mid, tail = m[:a1], m[a0:a1], m[a0:]
    def join(x, y): return np.concatenate([x[:-xf], x[-xf:] * (1 - ramp) + y[:xf] * ramp, y[xf:]])
    m = join(join(head, mid), tail)
m = m[:N].copy(); fi = int(.4 * SR); fo = int(3.0 * SR)
m[:fi] *= np.linspace(0, 1, fi); m[-fo:] *= np.linspace(1, 0, fo) ** 2
write('out/stem_music.wav', m)
print(f'{len(C["cues"])} cues, {len(used)} different sounds from the library; music {len(m)/SR:.1f}s')
json.dump(used, open('out/sfx_used.json', 'w'), indent=1)
