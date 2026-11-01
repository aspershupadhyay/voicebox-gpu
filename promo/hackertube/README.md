# HackerTube: a 50-second Reel on Karpathy's weekend hack

From Andrej Karpathy's post of 1 Nov 2026 (x.com/karpathy/status/2116957135661945283): he had Claude filter 43M Hacker
News comments over 20 years down to 6,454 videos people keep recommending, and shipped it as hackertube.org in about two
hours with Claude Code. The video is cut like a model-launch film: fast, kinetic type, ivory and near-black scenes, a
serif for the idea words, mono for the real details.

- `film.html`: the film (1080×1920, 30 fps). Every frame is `window.seek(t)`, timed from `vo.js` (the voice's word times).
- `tools/script.json`: the voiceover, one line per beat, voiced in Sparsh's trained voice (`myvoice`, hype, 1.08x, best
  of 2-3 takes; every line heard word for word by Whisper; line 1 is heard as "Andre Carpathie", which is how the name is said; line 10 re-voiced once for "clod"). The first cut was voiced by Harsh.
- `tools/mkvo.py`: lays the lines on the timeline, writes `vo.js` / `vo.json` and `out/vo.wav`.
- `tools/audio.py`: the music bed (a pad, sub and pluck at 112 BPM, no drum loop, a held breath before the question)
  and the sound effects tied to what's on screen (counter ticks, key clicks under the typing, pops on the checks, booms on
  the reveal), from the same `vo.json`.
- `tools/mix.py`: voice -15 LUFS, music -27 LUFS side-chained under the voice, SFX -23 LUFS, master -14 LUFS.
- `tools/render.js`: `node tools/render.js out/video.mp4 6` (Playwright → ffmpeg), `stills t…`, `sheet N`.
- `POSTING.md`: caption, title, hashtags, and the thumbnail prompt for ChatGPT.

Facts on screen are checked against the post: the numbers (43M comments, 20 years, 6,454 videos, ~2 hours), no login
with state in the browser, a frame from the middle of the video as the thumbnail, the data as one zip, and the three
manual steps (a Google Cloud API key, a VPS, the domain). The screenshot is Karpathy's own, credited on screen.

The rendered MP4 is in VoiceBox Files → Videos/HackerTube (not in git).
