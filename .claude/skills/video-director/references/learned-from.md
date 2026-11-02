# What two reference videos taught (analysed 2026-11-02)

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
