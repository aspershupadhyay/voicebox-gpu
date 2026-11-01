#!/usr/bin/env python3
"""Lay the voice lines on the timeline -> vo.js / vo.json (the script's words on Whisper's times) and vo.wav.
usage: mkvo.py <dir with lNN.wav + lNN.subs.json>"""
import sys, json, wave, numpy as np
D = sys.argv[1]; SR = 48000
S = json.load(open('tools/script.json'))
GAP = {'l02': .2, 'l03': .15, 'l04': .12, 'l05': .18, 'l06': .12, 'l07': .35, 'l08': .2, 'l09': .18, 'l10': .18,
       'l11': .18, 'l12': .18, 'l13': .2, 'l14': .45, 'l15': .45}
def read(p):
    with wave.open(p) as w:
        assert w.getframerate() == SR; raw = w.readframes(w.getnframes()); sw = w.getsampwidth(); ch = w.getnchannels()
    a = np.frombuffer(raw, {2: np.int16, 4: np.int32}[sw]).astype(np.float32) / (32768 if sw == 2 else 2**31)
    return a.reshape(-1, ch).mean(1) if ch > 1 else a
lines, t, clips = [], 0.05, []
for k, text in S.items():
    t += GAP.get(k, 0); a = read(f'{D}/{k}.wav'); ws = json.load(open(f'{D}/{k}.subs.json'))['words']; toks = text.split()
    if len(ws) == len(toks):
        words = [{'w': tk, 's': w['s'], 'e': w['e']} for tk, w in zip(toks, ws)]
    else:  # spread the script's words over Whisper's span by length
        s0, e0 = ws[0]['s'], ws[-1]['e']; L = [len(x) + 2 for x in toks]; c = np.cumsum([0] + L) / sum(L)
        words = [{'w': tk, 's': s0 + (e0 - s0) * c[i], 'e': s0 + (e0 - s0) * c[i + 1]} for i, tk in enumerate(toks)]
        print(f'{k}: {len(ws)} heard vs {len(toks)} script words: spread')
    dur = len(a) / SR
    lines.append({'id': k, 'start': round(t, 3), 'end': round(t + dur, 3), 'text': text,
                  'words': [{'w': w['w'], 's': round(t + w['s'], 3), 'e': round(t + w['e'], 3)} for w in words]})
    clips.append((t, a)); print(f'{k} {t:6.2f} -> {t+dur:6.2f}'); t += dur
DUR = t + 2.4
vo = np.zeros(int((DUR + 1) * SR), np.float32)
for t0, a in clips: i = int(t0 * SR); vo[i:i + len(a)] += a
vo = vo[:int(DUR * SR)]
with wave.open('out/vo.wav', 'w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(vo / np.abs(vo).max() * .89, -1, 1) * 32767).astype(np.int16).tobytes())
json.dump({'lines': lines}, open('vo.json', 'w'), indent=1)
open('vo.js', 'w').write('window.VO=' + json.dumps({'lines': lines}) + ';')
print(f'duration {DUR:.2f}s')
