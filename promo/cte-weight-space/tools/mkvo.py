#!/usr/bin/env python3
"""Lay the voice lines on the timeline -> vo.js / vo.json (the script's words on Whisper's times, a 30 fps loudness
envelope per line) and out/vo.wav.   usage: python3 tools/mkvo.py <dir with lNN.wav + lNN.subs.json>"""
import sys, json, wave, re, numpy as np
D = sys.argv[1]; SR = 48000; FPS = 30
S = json.load(open('tools/script.json'))
# pace: 0.1 s between lines; the story's breaths are deliberate (the rewind lands, the silence before the void,
# the riser into the rebuild, the ask)
# 120 BPM: each line starts on the next 8th note (0.25 s) after its gap; the breaths are deliberate (before the
# rule, before the demo, the silence before "what's the catch?", before the payoff and the ask)
import math
GAP = {k: .08 for k in S}
# the breaths: a section turn before the weights, the loop, the operation; silence before the catch
GAP.update({'l04': .25, 'l06': .15, 'l07': .3, 'l07b': .12, 'l08': .35, 'l09': .3, 'l11': .2, 'l12': .12, 'l13': .3, 'l15': .6, 'l16': .3, 'l17': .2, 'l18': .2, 'l19': .35, 'l20': .3})
STEP = .02
def read(p):
    with wave.open(p) as w:
        assert w.getframerate() == SR, p; raw = w.readframes(w.getnframes()); sw = w.getsampwidth(); ch = w.getnchannels()
    a = np.frombuffer(raw, {2: np.int16, 4: np.int32}[sw]).astype(np.float32) / (32768 if sw == 2 else 2**31)
    return a.reshape(-1, ch).mean(1) if ch > 1 else a
norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
def align(toks, ws):
    """The script's words on Whisper's times: runs that match take their own times; a mismatched run ("twenty five
    percent" heard as "25%") is spread over the heard run's span by length."""
    import difflib
    sm = difflib.SequenceMatcher(None, [norm(t) for t in toks], [norm(w['w']) for w in ws], autojunk=False)
    out = [None] * len(toks)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal':
            for d in range(i2 - i1): out[i1 + d] = {'w': toks[i1 + d], 's': ws[j1 + d]['s'], 'e': ws[j1 + d]['e']}
        elif i2 > i1:
            if j2 > j1: s0, e0 = ws[j1]['s'], ws[j2 - 1]['e']
            else:  # nothing heard for these words: squeeze them between their neighbours
                s0 = ws[j1 - 1]['e'] if j1 > 0 else ws[0]['s']; e0 = ws[j1]['s'] if j1 < len(ws) else s0 + .3 * (i2 - i1)
            L = [len(x) + 2 for x in toks[i1:i2]]; c = np.cumsum([0] + L) / sum(L)
            for d in range(i2 - i1): out[i1 + d] = {'w': toks[i1 + d], 's': s0 + (e0 - s0) * c[d], 'e': s0 + (e0 - s0) * c[d + 1]}
    return out
lines, t, clips = [], 0.05, []
for k, text in S.items():
    if k != 'l01': t = math.ceil((t + GAP[k]) / STEP - 1e-6) * STEP
    a = read(f'{D}/{k}.wav'); ws = json.load(open(f'{D}/{k}.subs.json'))['words']; toks = text.split()
    words = align(toks, ws)
    if len(ws) != len(toks): print(f'{k}: {len(ws)} heard vs {len(toks)} script words: aligned, mismatched runs spread')
    dur = len(a) / SR; hop = SR // FPS
    env = [round(float(np.sqrt((a[i:i + hop] ** 2).mean())), 4) for i in range(0, len(a), hop)]
    m = max(env) or 1; env = [round(e / m, 3) for e in env]
    lines.append({'id': k, 'start': round(t, 3), 'end': round(t + dur, 3), 'text': text, 'env': env,
                  'words': [{'w': w['w'], 's': round(t + w['s'], 3), 'e': round(t + w['e'], 3)} for w in words]})
    clips.append((t, a)); print(f'{k} {t:6.2f} -> {t+dur:6.2f}  {text[:60]}'); t += dur
DUR = t + 7.6   # a breath, the ident (4.3 s) and its hold
vo = np.zeros(int((DUR + 1) * SR), np.float32)
for t0, a in clips: i = int(t0 * SR); vo[i:i + len(a)] += a
vo = vo[:int(DUR * SR)]
with wave.open('out/vo.wav', 'w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(vo / np.abs(vo).max() * .89, -1, 1) * 32767).astype(np.int16).tobytes())
json.dump({'lines': lines, 'duration': round(DUR, 3)}, open('vo.json', 'w'))
open('vo.js', 'w').write('window.VO=' + json.dumps({'lines': lines, 'duration': round(DUR, 3)}) + ';')
print(f'duration {DUR:.2f}s')
