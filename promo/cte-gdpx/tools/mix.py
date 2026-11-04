#!/usr/bin/env python3
"""voice -15 LUFS, music -27 LUFS side-chained under the voice, SFX -23 LUFS held under the voice, master -14 LUFS
with true peak -2 dBTP before AAC (it lands under -1 after) (docs/REELS.md rule 13; the skill's references/sound-design.md).
The voice guard: wherever the voice is speaking, the SFX stem is turned down (smoothly, 10 ms attack / 120 ms release)
so it stays at least 6 dB under the voice in every 20 ms window: nothing ever covers the voice."""
import subprocess, re, json, wave, numpy as np
SR = 48000
def lufs(p):
    o = subprocess.run(['ffmpeg', '-i', p, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', o)[-1])
def rd(p):
    with wave.open(p) as w: return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
def wr(p, a):
    with wave.open(p, 'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())
gv = -15 - lufs('out/vo.wav'); gm = -27 - lufs('out/stem_music.wav'); gs = -23 - lufs('out/stem_sfx.wav')
print(f'gains vo {gv:+.1f} music {gm:+.1f} sfx {gs:+.1f}')
v = rd('out/vo.wav') * 10 ** (gv / 20); s = rd('out/stem_sfx.wav') * 10 ** (gs / 20); n = min(len(v), len(s)); v, s = v[:n], s[:n]
win = SR // 50; k = n // win
def hp(a, fc=250):  # one-pole high-pass: what competes with speech is above ~250 Hz (a sub boom sits under it)
    X = np.fft.rfft(a); f = np.fft.rfftfreq(len(a), 1 / SR); X *= f / np.sqrt(f * f + fc * fc)  # 1st-order high-pass
    return np.fft.irfft(X, len(a)).astype(np.float32)
sh = hp(s)
ev = np.sqrt((v[:k * win].reshape(k, win) ** 2).mean(1) + 1e-12); es = np.sqrt((sh[:k * win].reshape(k, win) ** 2).mean(1) + 1e-12)
# the voice "is speaking" around a window if it's above -45 dBFS within ±60 ms
speak = np.convolve((ev > 10 ** (-45 / 20)).astype(float), np.ones(7), 'same') > 0
vref = np.maximum(ev, np.convolve(ev, np.ones(7) / 7, 'same'))
g = np.ones(k)
g[speak] = np.clip((vref[speak] * 10 ** (-6 / 20)) / es[speak], 10 ** (-15 / 20), 1)  # at most -15 dB
# smooth: fast attack (gain drops quickly), slow release
sm = np.empty(k); cur = 1.0
for i in range(k):
    cur = g[i] if g[i] < cur else cur + (g[i] - cur) * (1 - np.exp(-1 / 6))
    sm[i] = cur
gain = np.interp(np.arange(n), np.arange(k) * win + win / 2, sm)
s = s * gain
print(f'voice guard (speech band): SFX turned down in {(sm < .98).mean() * 100:.1f}% of the film, at most {20 * np.log10(sm.min()):.1f} dB')
wr('out/_v.wav', v); wr('out/_s.wav', s)
fc = (f'[0:a]aformat=channel_layouts=stereo,asplit=2[v][vk];'
      f'[1:a]volume={gm:.2f}dB[m];[m][vk]sidechaincompress=threshold=0.015:ratio=4:attack=25:release=350:knee=4[md];'
      f'[2:a]aformat=channel_layouts=stereo[s];[v][md][s]amix=inputs=3:normalize=0:duration=first[o]')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', 'out/_v.wav', '-i', 'out/stem_music.wav', '-i', 'out/_s.wav', '-filter_complex', fc, '-map', '[o]', '-ar', '48000', 'out/mix_raw.wav'], check=True)
# master: two-pass loudnorm in linear mode (one gain, no pumping) to -14 LUFS, true peak -2 dBTP
o = subprocess.run(['ffmpeg', '-i', 'out/mix_raw.wav', '-af', 'loudnorm=I=-14:TP=-2:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
m = json.loads(o[o.rindex('{'):o.rindex('}') + 1])
af = (f"loudnorm=I=-14:TP=-2:LRA=11:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
      f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', 'out/mix_raw.wav', '-af', af, '-ar', '48000', 'out/mix.wav'], check=True)
o = subprocess.run(['ffmpeg', '-i', 'out/mix.wav', '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
print('master', re.findall(r'I:\s+(-?[\d.]+) LUFS', o)[-1], 'LUFS, true peak', re.findall(r'Peak:\s+(-?[\d.]+) dBFS', o)[-1], 'dBTP')
