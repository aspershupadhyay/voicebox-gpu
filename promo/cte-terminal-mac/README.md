# Catch the Error: terminal-mac, a whole Mac inside a terminal, for your AI agent (87 s, 1080×1920)

On govijr/terminal-mac (v0.2.0, Nov 3, 2026), made like a paid launch ad with the honest catch. Plan, beats,
retention plan and sources: `PLAN.md`; posting: `POSTING.md`.

**World:** the desktop (new): a sand desk where everything is a window; two cursors as the cast (yours ink, the
agent's red); the real footage as rounded cards the camera pans inside (`shot()`, frames from `frame()`); dark scenes
for the mechanism. The anchor is the Droste (`droste()`): the real "macOS in the terminal" frame inside itself, the
cover and the ask. Explainers: the dots (what the guest can see, which frames get sent) and the bars (an idle desktop
sends zero frames).

**Real footage** (~13 s): @kirtandopamine's two launch videos (VoiceBox Files → Videos/terminal-mac), cut to
frames by `bash tools/clips.sh <intro.mp4> <demo.mp4>` into `assets/clips/` (not in git: 44 MB; rebuild them first).

**Rhythm:** 120 BPM. Lines start on 8th notes (`tools/mkvo.py`); the bed is gorila (105.3 BPM, `atempo=1.1396` →
`gorila120`), phased per segment so its kick (0.37 s past each half second) lands on the film's grid (`ph()`): the
drop under the hook, its second drop on "Here's the clever part", cut dead before the catch, the breakdown under the
fine print, the ending under the payoff and the ident.

**Voice:** Sparsh (myvoice, hype, 1.08×, best of 2) on the Colab L4; all 21 lines heard as written (Cerebrium stalled
on "installing packages" at 0 MB/s for 3 min, so the job moved to Colab).

**Contrast:** red words and pills on the desk use `REDT` #A8322A (4.6:1); the pen stroke stays the brand red
#D8463A (3:1 on the lighter desk #E0D9CC); dots not reached yet use `DIM` (3:1 on the window).

Build: `bash tools/clips.sh …` → `python3 tools/mkvo.py <voice dir>` → `node tools/render.js cues` →
`python3 tools/audio.py <SFX wav dir>` (aliases: `typing`, `tick`, `mouse-click`, `soft-pop`, `subtle-pop`,
`sharp-pop`, `uipop`, `data`, `erreur`, `accept`, `notify`, `flipcard`, `sound-off`, `glint`, `swoosh-snap`,
`gorila120`) → `python3 tools/mix.py` → `node tools/render.js out/video.mp4 4` → mux. Cover: `node tools/render.js stills -1`.
