# Cyclon: a 45-second Reel on the "AI phone to replace your iPhone"

From Adam Zinebi's post of 2 Nov 2026 (x.com/AdamZinebi1/status/2117300841036353559) and Cyclon's 96 s launch video:
Cyclon (YC F26) is a phone and OS built around AI. You ask it, it uses your apps, builds the ones you're missing and
works in the background. Cut like the HackerTube Reel (`promo/hackertube/`, same kit), but faster: 120 BPM, every
line starting on an 8th note, and something new about every 1-2 s.

- `film.html`: the film (1080×1920, 30 fps), timed from `vo.js`. Scenes enter with fast transitions (push, push up,
  zoom-through with blur, a pixel wipe that echoes Cyclon's pixel motif, hard cuts with a punch-in), and pixel corner
  brackets step on every beat. Their demos are redrawn in code, labelled "redrawn from Cyclon's demo"; app icons are
  generic, and we never draw Cyclon's logo (the name is set in Geist).
- `tools/script.json`: 15 lines, voiced in Sparsh's trained voice (`myvoice`, hype, 1.10x, best of 2; line 2 took 3
  takes). Every line was heard word for word ("Cyclon" is heard as "cyclone", which is how it's said).
- `tools/mkvo.py`: lays the lines on the 120 BPM grid (each starts on the next 0.25 s after a short gap, with a longer
  breath before the question) and writes `vo.js` / `vo.json` / `out/vo.wav`.
- `tools/audio.py`: a Dm-Bb-F-C bed at 120 BPM (pad, sub on every beat, 8th-note plucks, off-beat shaker, a soft kick
  only through the demo stretch, a held breath before the question). The SFX are tied to the picture: whooshes on
  pushes and zooms, sparkle ticks on pixel wipes, pops as apps scatter or land, key clicks under the typed prompts,
  and a chime on "Sent" and "Done".
- `tools/mix.py`: voice -15, music -27 side-chained under the voice, SFX -23, master -14 LUFS (measured -14.2, LRA 2.8).
- `tools/render.js`: `node tools/render.js out/video.mp4 4` (1366 frames in 54 s on 4 cores).

Facts on screen were checked against the tweet, a Whisper transcript of the launch video and cyclon.ai: YC F26; the
photos demo ("finds the right ones across my chats and gallery"); "build me an app to learn Spanish" and "add Mandarin
and make the streaks weekly"; integrations "through MCPs, APIs and custom software just by asking"; the background
tasks shown on their pre-order card; first pre-orders get a Pixel 8a running Cyclon OS; their own hardware is a
concept expected Q2 2027 (subject to FCC authorization); a $199 refundable reservation deposit. The rule
("If you can do it on your phone…") is the tweet's own line, credited to Adam Zinebi.

The rendered MP4 is in VoiceBox Files → Videos/Cyclon (not in git).
