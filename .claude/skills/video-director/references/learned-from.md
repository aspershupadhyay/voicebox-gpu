# What the reference videos and our own builds taught

Both are in VoiceBox Files: the YouTube tutorial in `Videos/` ("How to Edit VIRAL Instagram Reels Using Opus 5.5"),
the Reel in `Downloads/Instagram` (by miftahul_islam_efaz). Transcribed with Whisper, 1 fps and 0.1 fps contact
sheets, scene cuts, loudness and SFX onsets measured. Learn the patterns; never reuse their words, characters or brand.

## The YouTube tutorial (17:16, 1080p, talking head + screen recordings)
**What it teaches.** Claude edits well only after two kinds of training, each turned into a skill so it's never
repeated:
1. **Visual training**, one guide in three parts:
   - *Captions*: a reference image; one medium sans for most words and one script font for the special words;
     white text plus one accent colour; where text sits; a glow on the special words and a light drop shadow on
     the rest; **word-by-word pop-up from slightly below, fading in with a light blur, never longer than 1.5 s**;
     the hook with the speaker always on screen and the caption highlighting the one word that keeps you watching.
   - *Animations*: four kinds (text-centric, person-centric, object-centric, graphic-centric), how to build a
     background, and the **three-object rule** (a main object in the centre, supporting elements at the edges,
     depth elements around the outside), design basics, and 100+ inspiration pieces.
   - *On-screen animations*: small UI that pops up while talking: the background darkens and blurs, the animation
     sits in the lower half.
2. **Sound-design training**: a library and a guide. The guide's philosophy (worth keeping word for word in our
   own words): sound emphasises motion; three jobs, three families (whooshes → movement, textures → things that
   happen without sliding, risers & hits → anticipation); never too loud (whooshes low, textures higher, risers
   highest, nothing covers the voice); one impact per scene; sound scale matches shot scale; diegetic first; **the
   whoosh peak sits on the fastest frame**. A starter library: 5 whooshes (long, short, textured), 2-3 mechanical
   clicks, 2-3 sci-fi, 2-3 UI (click, success, fail), 2 risers and 2 hits (bass and metallic).

**The workflow he showed.** Cut first (a word-level transcript, remove silences and bad takes, ~20 ms padding;
slow in Claude: 24 min for 1 min of footage). Then **plan**: Claude builds a planning page (accent colour, two
fonts, the script on the left, an empty box on the right per line, and one of four scene types per line: captions,
captions with a UI, half screen, full screen). He fills it in (~15 min): that's where the content psychology goes.
Claude builds every animation in Remotion from the training and the plan (~40 min, asks for assets it needs, finds
some itself), he reviews and gives notes, then Claude sound-designs it from the library (~25 min) and a song goes in
at -20 dB. Total ~1 h 50 min, of which he worked ~20 min. Editing tips inside the example: make every element ~25%
smaller; less is more with effects; duller colours look more high-end.

## The Reel (2:00, 1440p landscape, pixel art + kinetic type)
**Hook.** "This video went viral, and everyone's asking the same thing. What's the prompt? Wrong question."
Authority (it went viral) + the viewer's own question + a contradiction, then a reveal ("Claude didn't make this,
not alone… The difference? A director.").
**Pace.** ~0.45 hard cuts a second plus constant motion inside shots; every spoken phrase is on screen, one or two
words at a time, each word in a different weight or font, big and centred.
**Visual system.** A recurring pixel-art world (a detective character and a mascot in a voxel room), pixel-block
dissolves between sections (the signature move), binary counters (`0110`), a level bar, real UI cards. It shows the
"crew in one file" as a row of icons lighting up (script, storyboard, animation, captions, voiceover, sound design)
and the framework as a 75% / 25% bar: the skill does 75%, your idea, taste and notes are the other 25%.
**Sound.** A steady music bed with an SFX roughly every 1.6 s, mastered loud (-14 LUFS, LRA 2.4).
**Ending.** A comment CTA ("Comment SKILL for the file"), held on screen.

## What we took (and changed)
- The **75/25 idea** became rule 1 (direct, don't prompt) in our words; the **planning sheet with four scene types**
  became rule 3 and `planning-sheet.md`; the **caption motion spec** and the **three-object rule** went into
  `style-guide.md`; the **sound philosophy and the library checklist** went into `sound-design.md`, mapped onto our
  own 92-sound library; the **pixel dissolve** became our one flashy transition, in our palette.
- Not taken: their characters and voxel rooms (our look stays ours), glitchy text, constant music under graphics
  (we duck a bed under the voice instead: docs/REELS.md rule 13), a course pitch.

## Our build: Instagram on Apple TV (2026-11-03, `promo/cte-instagram-tv/`)
- **Research finds the story the post left out.** The post said "new on Apple TV, US only". The reporting said the app
  went live quietly ten days earlier, that it's Instagram's fourth TV platform in a year, and that IGTV (2018-2022)
  was its first try: the catch came from history, not from the post. Search the launch, the predecessor and the pattern.
- **Their screenshot is evidence.** Put the owner's screenshot in as "the real post", scaled up and marked with the
  pen (a ring measured on the screenshot's own pixels), never redrawn as if it were the real thing.
- **Another product's look, without its logos.** The TV interface is drawn in code from what makes it feel like that
  product (the focus engine's lift, light edge, sheen and parallax; a top shelf; the remote), with a drawn camera glyph
  for the app. Labelled as redrawn in the caption.
- **Our own video on the screen.** When a screen plays a video, it's ours: `tools/frames.sh` turns the Files MP4 into
  30 fps JPGs; the film preloads and decodes them, and `seek()` returns a promise that waits for every `<img>`, so
  Playwright never grabs a blank frame.
- **A match cut as the hook.** The phone playing our Reel widens into the TV on "biggest screen": one object becomes
  the next, so the hook has motion, text and voice on frame 1 and a payoff in second 1.
- **`wordIdx` matches by prefix.** `at('l01','in')` found "Instagram" (word 0), so "in your house" rose before "the
  biggest screen". Pass the start index (`wordIdx(id, word, from)`) for short words, or check the order on a sheet.
- **Heard is not said.** Whisper heard "DMs" as "demiss": re-voice with a spelling the model says cleanly
  (`pronounce: {"DMs": "dee emms"}`, `takes: 3`) and check `heard` again.
- **Dates line up across time zones.** The post read Nov 3 (IST) while the voice says "ten days later" (Oct 23 → Nov 2
  in the US): show a "+10 days" counter rather than a second date that could contradict the screenshot.

## Our build: AI, decoded #1, the satellite (2026-11-03, `promo/cte-satellite-ai/`)
- Real media first, from the primary source: NASA GIBS serves real satellite imagery for any date and box as a plain
  WMS URL (a globe projected from that day's VIIRS true colour, tiles, Punjab's smoke with VIIRS fire dots). ESA's
  image pages come through VoiceBox `download` (our sandbox gets 403 there; don't spoof a browser).
- Our own footage: record the real site in a headless browser (Playwright `recordVideo`, scripted clicks and wheel
  zooms), then cut frames from the webm. It reads as "we checked", and it's ours.
- Research changes the script: Φ-sat-1 only *flagged* cloudy photos in its trial, so the voice says "checking", and
  the "nothing comes down" claim rests on Φ-sat-2's fire app, which ESA says returns no data when there's no fire.
- The sound that is the topic: a synthesized camera shutter (two blade clicks) is the transition and the beat;
  a low thud is "not sent". Both live in `tools/audio.py` (synth cues), since the library has no shutter.
- When a voice job ran on another GPU, its `/files` links won't open from Colab's tunnel: the WAVs are in the
  library (`get_file`), and word stamps can be remade locally (faster-whisper small.en, fed raw audio from ffmpeg).

## Our build: an AI fixed another AI's brain (2026-11-03, `promo/cte-weight-space/`)
- **Go past the post to the artifact.** The tweet had the numbers; the published checkpoints and eval samples had the
  story. A safetensors header is JSON at the front of the file, so one tensor can be fetched with two HTTP range
  requests (header length, header, then the tensor's byte range): 7 MB instead of 1.6 GB. Diffing base vs edited showed
  the exact edit, and `eval/samples_*.jsonl` held the real loop ("found 27, then 1,237 repeats, no answer").
- **The brand mark can be the metaphor.** The logo's red ring became the loop the text runs around; its red letters
  became the edited nodes. One gesture, two meanings, no new props.
- **Screenshots in an off-brand colour get toned to ink** (grayscale → ink on sheet paper): Qwen's card is purple on
  Hugging Face; the clipping keeps every word and loses the colour.
- **Cerebrium's first myvoice install can hang** with an empty install log: after ~5 minutes start Colab
  (`gpu action=start purpose=voice`), set `backend prefer=colab`, resend, and put the preference back afterwards.
- **A spoken number and the exact one:** the voice says "twelve hundred", the counter lands on "1,200+", and the exact
  1,237 sits in the small evidence line, so the screen never contradicts the voice.

## Our build: GDPx, the best AI scored 12% (2026-11-04, `promo/cte-gdpx/`)
- **The reference** (speedy_devv, "abliteration", 2:07 vertical, -14.2 LUFS, LRA 2.4): the spoken line sits at the
  top all the time, two to six words, each rising on its word, the key word marked; one object in the centre that the
  camera keeps moving through; real pages (arXiv, GitHub, Hugging Face) as rounded white cards with a soft shadow,
  highlighted on the word; counting numbers; "here's the strange part". Its violet glow and neon 3D are what the owner
  called the slop part: not taken. Our version is `topcap()` (phrase groups, the emphasised words in red serif italic).
- **120 BPM as one grid**: `tools/mkvo.py` snaps every line start to 0.25 s; the music bed's kick was measured
  (nightfall at 1.2×: 0.04 s past each half second) and each segment's offset is phased with `ph(base, t0)` so the kick
  lands on the film's half seconds. Check it: low-pass the music stem and find the onset phase (it should print 0.0).
- **Screenshots you can move through**: `shot()` puts the image in a rounded card and takes a view (`cx, cy, z`), so
  the camera pans from the whole leaderboard to a row, to the price column and back, with pen marks drawn in the
  screenshot's own pixels so they stay on their numbers while it moves.
- **Cerebrium's myvoice exited while loading** (15 s, "see logs/myvoice.log"): Colab was online in ~2.5 min and voiced
  17 lines in ~3.5 min. Put `backend prefer` back afterwards.
- **`ffmpeg` in a `while read` loop eats the list**: it reads stdin, so every name after the first lost its first
  letter. Use `ffmpeg -nostdin` (and `curl … </dev/null`) inside loops.
