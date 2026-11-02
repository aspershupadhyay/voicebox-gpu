#!/usr/bin/env python3
"""A stand-in vo.js (0.36 s a word) so the film can be laid out before the voice is back."""
import json
S = json.load(open('tools/script.json')); TITLE = {'l05','l08','l11','l14','l16','l19','l23','l26'}
t = .05; lines = []
for k, text in S.items():
    if k != 'l01': t += .55 if k in TITLE else .16
    ws = []; toks = text.split()
    for w in toks: ws.append({'w': w, 's': round(t, 3), 'e': round(t + .3, 3)}); t += .36 if not w.endswith(('.', ',', '?')) else .5
    lines.append({'id': k, 'start': ws[0]['s'], 'end': round(t, 3), 'text': text, 'words': ws, 'env': [abs(((i * 7) % 11) / 11) for i in range(int((t - ws[0]['s']) * 30))]})
open('vo.js', 'w').write('window.VO=' + json.dumps({'lines': lines, 'duration': round(t + 3, 3)}) + ';'); print(round(t + 3, 2))
