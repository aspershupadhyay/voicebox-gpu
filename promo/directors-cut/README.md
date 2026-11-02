# Director's Cut: the "7 rules" video, rewound (v2, 1920×1080, ~50 s)

v2 of `promo/claude-video-rules/` after the owner's notes: faster, Nolan-style, our own character, a CTA for the
skill file. One continuous world instead of slides: the finished frame (plan, title, Reel the director, the hook's
word timings, a live waveform) is shown, **rewound** (the timecode scrubs back, a Shepard tone rises), then stripped
one layer per rule (sound, motion, timing, plan, style), each strip pushing into its layer and growing an explainer
out of it. On "And under all of it?" everything goes to black and silence; one line of script types itself and
Reel drops in. Then "Start directing": every layer snaps back on the hit and the music returns. The ask: Reel holds a
slate reading SKILL.md / TAKE: YOURS, the comment box types SKILL, Reel replies with the file.

- **Reel** (`blob.js`): the studio's pixel director, drawn cell by cell in code: marigold, a backwards cap and a
  finger viewfinder; blinks, lip-syncs to the voice's own loudness, squashes on landings, can hold and clap a slate.
  `sketch.html` shows the three sketches the owner picked from (A Cue, B Boom, C Reel: the owner chose C).
- **Palette**: Reel's marigold `#E3BC5C` is the accent (not Claude's clay), a dull blue `#8FA8D8` the second voice.
- **Sound arc**: the bed plays under the hook, cuts dead on "Strip the sound", a slow Shepard tone holds the tension
  under the strips, true silence before "And under all of it?", the bed and a sub boom slam back on "directing"
  (`MUSIC()` / `SHEPARD()` in film.html, synthesized in `tools/audio.py`).
- Build: as in `promo/claude-video-rules/README.md` (`mkvo.py` → `render.js cues` → `audio.py` → `mix.py` →
  `render.js out/video.mp4 4` → mux). `tools/shot.js page.html out.png` screenshots a static page (the sketches).

The rendered MP4 is in VoiceBox Files → Videos/Claude video rules (not in git).
