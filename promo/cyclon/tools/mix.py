#!/usr/bin/env python3
"""voice -15 LUFS, music -27 LUFS side-chained under the voice, SFX -23 LUFS, master -14 LUFS (docs/REELS.md rule 13)."""
import subprocess, re, json
def lufs(p):
    o = subprocess.run(['ffmpeg', '-i', p, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', o)[-1])
gv = -15 - lufs('out/vo.wav'); gm = -27 - lufs('out/stem_music.wav'); gs = -23 - lufs('out/stem_sfx.wav')
print(f'gains vo {gv:+.1f} music {gm:+.1f} sfx {gs:+.1f}')
fc = (f'[0:a]aformat=channel_layouts=stereo,volume={gv:.2f}dB,asplit=2[v][vk];'
      f'[1:a]volume={gm:.2f}dB[m];[m][vk]sidechaincompress=threshold=0.015:ratio=4:attack=25:release=350:knee=4[md];'
      f'[2:a]volume={gs:.2f}dB[s];[v][md][s]amix=inputs=3:normalize=0:duration=first,alimiter=limit=0.9:attack=3:release=50:level=disabled[o]')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', 'out/vo.wav', '-i', 'out/stem_music.wav', '-i', 'out/stem_sfx.wav', '-filter_complex', fc, '-map', '[o]', '-ar', '48000', 'out/mix_raw.wav'], check=True)
g = -14 - lufs('out/mix_raw.wav')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', 'out/mix_raw.wav', '-af', f'volume={g:.2f}dB,alimiter=limit=0.89:level=disabled', '-ar', '48000', 'out/mix.wav'], check=True)
print('master', lufs('out/mix.wav'), 'LUFS')
