# AI, decoded #1: the satellite that decides what we see (Catch the Error, ~70 s, 1080×1920)

An explainer with a catch, the first of a numbered series. Plan, beats and sources: `PLAN.md`; posting: `POSTING.md`.

**World**: mission control (dark slate console, amber line art, cream photo prints, a mission clock), not the paper
desk of the last two Reels. The red pen is a red grease pencil on the console glass. Fonts: Barlow Condensed (ideas),
Instrument Serif italic (statements), IBM Plex Mono (evidence). Transitions are fast (0.22 s): a camera-shutter
close/open, whips, zooms.

**Real media** (credited small, top right): a globe projected from NASA VIIRS true colour of 1 Nov 2026 (GIBS),
nine real VIIRS tiles, our own screen recording of NASA Worldview (India, Oct 28 → Nov 1, then a zoom into the Bay
of Bengal cyclone), ESA's Myriad 2 board, the CERN radiation test rig, Φ-sat-2 flight hardware and its own image
(ESA / Open Cosmos), Punjab under smoke on 1 Nov 2026 with VIIRS fire dots (NASA).

**Sound**: the satellite's shutter is the beat (synthesized in `tools/audio.py`, with a "not sent" thud), library SFX
per motion, music 88300 at 150 BPM (lines start on the 8th note), cut dead before the catch. -14.2 LUFS, -2 dBTP.

**Voice**: Sparsh (myvoice, hype, 1.06x, best of 2); every line heard word for word.

Build: assets (globe frames, tiles, recording frames: see PLAN.md) → `python3 tools/mkvo.py <voice dir>` →
`node tools/render.js cues` → `python3 tools/audio.py <SFX wav dir>` → `python3 tools/mix.py` →
`node tools/render.js out/video.mp4 4` → mux. `assets/globe/` and `assets/rec/` are gitignored (rebuilt from NASA).
