# Catch the Error: GDPx, the best AI scored 12% (75 s, 1080×1920)

On SemiAnalysis's GDPx benchmark (Nov 2, 2026). Plan, beats, sources and the reference notes: `PLAN.md`; posting:
`POSTING.md`.

**World:** the exam, in the Cyclon house look (paper, ink, the red pen that grades). The anchor is the line-up: the
labs' real marks as app-icon tiles in a ring around 12% (`logoRing()`, marks in `logos.js`, MIT, @lobehub/icons); the real media are SemiAnalysis's post and the leaderboard, as rounded cards the camera pans
inside (`shot()`), marked by the pen in the screenshot's own pixels.

**Rhythm:** 120 BPM. `tools/mkvo.py` starts every line on an 8th note (0.25 s), so every cut lands on the grid, and
the music (nightfall, 100 BPM sped 1.2× to 120) is phased per segment (`ph()` in film.html) so its kick lands on
the film's half seconds. Music as a story: the drop under the hook and the explainer (restarted from its top on the
word montage), cut dead before the catch, the breakdown under the caveats, the second drop for the payoff.

**Voice:** Sparsh (myvoice, hype, 1.08×, best of 2) on a Colab L4; every line heard as written (Cerebrium's myvoice
crashed on load, so we switched).

Build: `python3 tools/mkvo.py <voice dir>` → `node tools/render.js cues` → `python3 tools/audio.py <SFX wav dir>`
(aliases: `tick`, `sharp-pop`, `soft-pop`, `subtle-pop`, `data`, `erreur`, `accept`, `marimba`, `notify`, `glint`,
`flipcard`, `mouse-click`, `sound-off`, `swoosh-snap`, `nightfall120` = nightfall at `atempo=1.2`) →
`python3 tools/mix.py` → `node tools/render.js out/video.mp4 4` → mux. Cover: `node tools/render.js stills -1`.
