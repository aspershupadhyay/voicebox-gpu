#!/usr/bin/env python3
"""Lay a voice's lines on the film's timeline, write caption data, and mix VO + music + SFX.
usage: assemble.py <voice>   (expects /tmp/pm/vo/<voice>/{main,fix,fix2}/... unzipped)"""
import sys, json, glob, os, subprocess, wave, re
import numpy as np

voice = sys.argv[1]
root = f'/tmp/pm/vo/{voice}'
SR, DUR = 48000, 42.5
SCRIPT = {
 'l01': 'You only see the result.', 'l02': 'The timing. The type. The motion.', 'l03': 'But how was it made?',
 'l04': "Let's rewind it.", 'l05': 'Every video starts with a prompt.',
 'r06': 'This is Prompt Motion: videos made with Claude, and the prompts behind them.',
 'r07': 'This one? One sentence.', 'l08': 'Dynamic.', 'l09': 'Fifteen seconds.', 'r10': 'Motion designer.',
 'l11': 'Go all out.', 'r12': "That's the prompt.", 'r13': 'Copy it. Or customize it, and make it yours.',
 'l15': 'Every video. The prompt behind it.', 'l16': 'Prompt Motion.',
 'l17': "Want the prompt? Comment CATCH, and we'll DM you the link.",
}
WANT = [('l01', .05), ('l02', 2.0), ('l03', 6.0), ('l04', 8.8), ('l05', 12.0), ('r06', 13.75), ('r07', 18.1),
        ('l08', 20.0), ('l09', 21.0), ('r10', 22.15), ('l11', 23.0), ('r12', 24.5), ('r13', 26.7), ('l15', 32.0),
        ('l16', 36.0), ('l17', 37.05)]
CAPTIONED = {'l02', 'l03', 'l04', 'r06', 'r07', 'r13'}
# per-voice replacement takes (a fixed line overrides the main one)
OVERRIDE = {'harsh': {'l16': 'r16'}, 'sparsh': {'l03': 'r03'}}[voice]

def find(stem):
    hits = sorted(glob.glob(f'{root}/*/{stem}.wav'))
    return hits[-1] if hits else None

def read(path):
    with wave.open(path) as w:
        assert w.getframerate() == SR, (path, w.getframerate())
        n = w.getnframes(); ch = w.getnchannels(); sw = w.getsampwidth()
        raw = w.readframes(n)
    a = np.frombuffer(raw, dtype={2: np.int16, 4: np.int32}[sw]).astype(np.float32) / (32768.0 if sw == 2 else 2147483648.0)
    if ch > 1: a = a.reshape(-1, ch).mean(1)
    return a

vo = np.zeros(int(DUR * SR), np.float32)
lines, prev_end = [], 0.0
for lid, want in WANT:
    src = OVERRIDE.get(lid, lid)
    wav = find(src)
    if not wav: sys.exit(f'missing {src} for {voice}')
    a = read(wav)
    start = max(want, prev_end + 0.08)
    i = int(start * SR); vo[i:i + len(a)] += a[: len(vo) - i]
    end = start + len(a) / SR; prev_end = end
    sj = wav.replace('.wav', '.subs.json')
    ws = json.load(open(sj)).get('words', []) if os.path.exists(sj) else []
    toks = SCRIPT[lid].split()
    if len(toks) == len(ws):  # the script's words on Whisper's times
        ws = [{'w': t, 's': w['s'], 'e': w['e']} for t, w in zip(toks, ws)]
    words = [{'w': w['w'], 's': round(start + w['s'], 3), 'e': round(start + w['e'], 3)} for w in ws]
    lines.append({'id': lid, 'src': src, 'start': round(start, 3), 'end': round(end, 3), 'text': SCRIPT[lid], 'words': words,
                  'late': round(start - want, 2)})
    print(f'{lid:4} {src:4} want {want:6.2f} at {start:6.2f} -> {end:6.2f}  ({len(a)/SR:.2f}s){"  LATE %.2f" % (start-want) if start-want > 0.2 else ""}')

json.dump({'voice': voice, 'lines': lines, 'captioned': sorted(CAPTIONED)}, open(f'/tmp/pm/build/vo_{voice}.json', 'w'), indent=1)
pk = np.abs(vo).max(); vo = vo / pk * 0.89 if pk > 0 else vo
pcm = (np.clip(vo, -1, 1) * 32767).astype(np.int16)
with wave.open(f'{root}/vo.wav', 'w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

def lufs(p):
    out = subprocess.run(['ffmpeg', '-i', p, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1])

# loudness targets: voice leads, music a bed ~12 dB under it (ducked a further ~6 dB under each word), SFX in between
gv = -15 - lufs(f'{root}/vo.wav'); gm = -27 - lufs('/tmp/pm/stem_music.wav'); gs = -23 - lufs('/tmp/pm/stem_sfx.wav')
print(f'gains: vo {gv:+.1f} dB, music {gm:+.1f} dB, sfx {gs:+.1f} dB')
mix = f'{root}/mix_raw.wav'
fc = (f'[0:a]aformat=channel_layouts=stereo,volume={gv:.2f}dB,asplit=2[v][vk];'
      f'[1:a]volume={gm:.2f}dB[m];[m][vk]sidechaincompress=threshold=0.015:ratio=4:attack=25:release=350:knee=4[md];'
      f'[2:a]volume={gs:.2f}dB[s];[v][md][s]amix=inputs=3:normalize=0:duration=longest,alimiter=limit=0.9:attack=3:release=50:level=disabled[o]')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f'{root}/vo.wav', '-i', '/tmp/pm/stem_music.wav', '-i', '/tmp/pm/stem_sfx.wav',
                '-filter_complex', fc, '-map', '[o]', '-t', '42', '-ar', '48000', mix], check=True)
g = -14 - lufs(mix)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', mix, '-af', f'volume={g:.2f}dB,alimiter=limit=0.89:level=disabled', '-ar', '48000',
                f'{root}/mix.wav'], check=True)
print('final', lufs(f'{root}/mix.wav'), 'LUFS')
