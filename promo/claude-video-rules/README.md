# 7 rules for directing Claude: a landscape tutorial (1920×1080)

A 2:11 YouTube tutorial on making videos with Claude that look directed, not generated, made the way it teaches:
script first, voiced in Sparsh's trained voice (`myvoice`, hype, 1.06x, best of 2 takes, every line checked by
Whisper), every frame drawn in code and timed to the voice's word stamps, every sound from the studio's SFX library
tied to what's on screen. Built from two references the owner added on 2026-11-02 (an Opus 5.5 editing tutorial and
miftahul_islam_efaz's Reel); what they taught is in `.claude/skills/video-director/references/learned-from.md`.

This folder is also the **landscape kit of the `video-director` skill** (`.claude/skills/video-director/SKILL.md`).

- `tools/script.json`: the voiceover, one line per beat.
- `tools/mkvo.py <voice dir>`: lays the lines on the timeline → `vo.js` / `vo.json` (the script's words on Whisper's
  times + a 30 fps loudness envelope per line) and `out/vo.wav`. `tools/placeholder.py` makes a stand-in to lay out
  the film before the voice exists.
- `film.html`: the film. Scenes start on their lines; a persistent header and the seven-step stepper; a pixel wipe
  between rules; captions only where the screen doesn't already say it; `cues()` holds every sound cue next to the
  picture it scores. The waveform, the word chips, the mixer's voice meter and the contact sheet are this video's
  own voice and frames.
- `tools/render.js`: `cues` (→ `out/cues.json`), `stills t…`, `sheet N from to out.png`, or `out/video.mp4 [workers]`.
- `tools/audio.py <SFX wav dir>`: places every cue (levelled, peak on the cue, risers reversed) → `out/stem_sfx.wav`,
  and the music bed (`nightfall-future-bass`) → `out/stem_music.wav`.
- `tools/mix.py`: voice -15 LUFS, music -27 LUFS side-chained under the voice, SFX -23 LUFS, master -14 LUFS.
- `POSTING.md`: title, description with credits and chapters, tags, thumbnail prompt.

Build, from this folder:
```
python3 tools/mkvo.py <unzipped voice job>
node tools/render.js cues && python3 tools/audio.py <SFX wavs> && python3 tools/mix.py
node tools/render.js out/video.mp4 4
ffmpeg -i out/video.mp4 -i out/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest out/final.mp4
```
The SFX wavs: download VoiceBox Files → SFX and `ffmpeg -i x.mp3 -ac 1 -ar 48000 wav/x.wav` each. The rendered
MP4 is in VoiceBox Files → Videos/Claude video rules (not in git).
