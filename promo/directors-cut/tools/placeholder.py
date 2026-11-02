#!/usr/bin/env python3
"""A stand-in vo.js (0.3 s a word at 1.12x) so the film can be laid out before the voice is back."""
import json
S = json.load(open('tools/script.json')); GAP = {k: .1 for k in S}; GAP.update({'l04': .3, 'l14': .65, 'l15': .25, 'l16': .3, 'l18': .4, 'l19': .45})
t = .05; lines = []
for k, text in S.items():
    if k != 'l01': t += GAP[k]
    ws = []
    for w in text.split(): ws.append({'w': w, 's': round(t, 3), 'e': round(t + .26, 3)}); t += .3 if not w.endswith(('.', ',', '?')) else .42
    lines.append({'id': k, 'start': ws[0]['s'], 'end': round(t, 3), 'text': text, 'words': ws, 'env': [abs(((i * 7) % 11) / 11) for i in range(int((t - ws[0]['s']) * 30))]})
open('vo.js', 'w').write('window.VO=' + json.dumps({'lines': lines, 'duration': round(t + 2.6, 3)}) + ';'); print(round(t + 2.6, 2))
