---
name: video-director
description: Direct Claude to make a finished, voiced, sound-designed video (a YouTube landscape explainer or tutorial, a Reel, Short or TikTok) that looks directed, not generated. Use when asked to "make a video", "make a tutorial / explainer / Reel / Short", "turn this into a video", "make a video like <reference>", or to analyse a reference video and make one in that spirit. Covers analysing references, the script, the planning sheet, voicing in the creators' trained voices on a cloud GPU (Modal / Colab / Cerebrium), the film drawn in code and timed to the voice's word stamps, sound design from the studio's SFX library, the mix, the review and delivery to Files.
---

# Video director

You are the editor, motion designer and sound designer. The owner is the director: their taste, their notes and
`docs/FEEDBACK.md` win over anything here. Read `docs/REELS.md` (the owner's video rules) before you start; this skill
is how to apply them, plus what we learned from two reference videos on 2026-11-02 (`references/learned-from.md`).
**Read `references/craft.md` first** (story, audience psychology, focal points, type pairing, motion principles: what
the best creators do), and `docs/BRAND.md`: every video is on the Catch the Error brand and ends on its ident
(`promo/brand/cte.js`). The current reference build is `promo/cte-cyclon/` (vertical, paper + ink + the red pen).

The working kit to copy is `promo/claude-video-rules/` (a 2:11 landscape tutorial made this way); the faster,
story-shaped v2 is `promo/directors-cut/` (54 s: the rewind and strip structure, Reel the pixel director, music
segments and a Shepard tone). It has the film
engine (`film.html`), the timeline builder (`tools/mkvo.py`), the renderer (`tools/render.js`), the SFX placer
(`tools/audio.py`) and the mix (`tools/mix.py`). For vertical Reels, `promo/hackertube/` is the same kit at 1080×1920.

## The seven rules (the short version of everything below)

1. **Direct, don't prompt.** No magic prompt exists. Claude does most of the work; the idea, the taste and the
   notes are the owner's. Ask what the video is for and who it's for if that isn't clear, then decide everything else.
2. **Style written down once.** Fonts, colours, where text sits, how words move: `references/style-guide.md`. Don't
   reinvent the look per video. A new video changes the script and pacing, not the art.
3. **Plan every line before a frame.** Fill the planning sheet (`references/planning-sheet.md`): each script line
   gets a scene type (captions, captions + UI, half screen, full screen), what appears on which word, and its sounds.
4. **Voice first, then animate to it.** Every cut, every word rising and every sound is timed from Whisper's word
   stamps on the real voice, never guessed.
5. **Small, calm, on the beat.** Words rise one at a time (fade + 20 px + a little blur, under 1.5 s for a phrase);
   a cut or a new element every 2-3 s on a spoken word; elements smaller than you think (-25%); dull colours.
6. **Sound is half the video.** Whooshes for movement, clicks and pops for what appears, risers and hits for the
   reveal; the whoosh's peak on the fastest frame; one big hit per scene; nothing covers the voice
   (`references/sound-design.md`, the library map in `references/sfx-library.json`).
7. **Review like a director.** Contact sheet, stills at every hit, then notes and a rebuild
   (`references/review-checklist.md`). Every fact checked against its source; estimates labelled.

## The workflow

### First: pick the format and the world (every video gets its own look)
`references/formats.md`: the shape of the story ("they quietly shipped X", spot the error, X vs Y, the timeline…)
and the art direction (editor's desk, broadsheet, patent drawing, receipt, museum, map…). Not the world of the last
two videos (`promo/cte-*`). The signature stays: the catch, the red pen, sources, the ident.

### 0. Start a project
`project action=start name=<topic>` (VoiceBox MCP). Pass `project` to every tool that makes files, so they land in
`Projects/<name>-<id>` and you can clean up. Copy the kit: `cp -r promo/claude-video-rules promo/<topic>` and clear
its `out/`.

### 1. Analyse the references (when the owner gives some)
Files from Files: `list_files search=...`; the Instagram/YouTube downloads are in `Downloads/<Site>`. Download them
(`curl -L` the Files link: it redirects) into a fresh scratchpad folder, then:
- **Words**: `transcribe` with the Files links (Whisper large-v3, word stamps; runs on the GPU).
- **Pictures**: `ffmpeg -i ref.mp4 -vf "fps=1,scale=480:-1,tile=6x5" sheet_%02d.jpg` (1 fps contact sheets; use
  `fps=1/10` for long videos) and look at every sheet; pull full-size frames where a document or UI is on screen and
  read it (that's where the real method hides).
- **Cuts**: `ffmpeg -i ref.mp4 -vf "select='gt(scene,0.25)',showinfo" -f null -` → cut times; cuts per second.
- **Sound**: `ffmpeg -i ref.mp4 -af ebur128 -f null -` (loudness, LRA), plus onset counting for how often an SFX
  lands (the Instagram reference: about 0.6 a second over a steady bed, master -14 LUFS, LRA 2.4).
Write down what to learn (hook pattern, pacing, the visual system, the sound) and what not to copy (their words,
their characters, their brand). Credit the creators in the post text when the video teaches what they taught.

### 2. Script
One line per beat, written to be said, in `tools/script.json` (`{"l01": "...", ...}`). The hook follows
`docs/REELS.md` rule 1-2 (authority, news or a sharp contradiction; on screen from frame 1; spoken from ~0.05 s).
Lines short enough to voice cleanly (one or two sentences). Facts only from sources you've read. ~2.5 words a second
at hype pace, 1.06x: 379 words came out at 2:11 with the gaps.

### 3. Voice (Sparsh or Harsh, on the cloud GPU)
`worker_status` first: it says which GPU is online (Colab, Modal, Cerebrium) and which goes first. The owner prefers
Modal for voice; with Colab offline and fallback on, jobs go to Modal by themselves. Then:

```
voice_lines engine=myvoice voice=sparsh style=hype platform=raw subtitles=true takes=2 post={tempo:1.06}
            pronounce={"Claude":"Clawd"} project=<id> lines=[{id:"l01",text:"..."}, ...]
```
Poll `get_job` (45 s each). The first myvoice load on a fresh Modal container takes several minutes (the venv imports
from the Volume, and vLLM compiles kernels the first time on a new GPU type); later loads are ~3 min, voicing 28 lines
with 2 takes a few minutes more. `worker_status logs=gateway` / `logs=myvoice` shows where it is when progress looks
stuck. On 2026-11-02 Modal's first myvoice load hung for 15+ minutes importing its packages from the
Volume (heartbeat going stale, the log frozen on one torch warning): stop Modal (`gpu action=backend stop_modal=true`),
start Colab (`gpu action=start purpose=voice`, online in ~1 min, myvoice loaded in ~3 min) and send the job again. When done, download `zip_url`, check every result's `heard` against the script (anything that isn't a match
gets re-voiced with `takes: 3`).

### 4. Timeline
`python3 tools/mkvo.py <unzipped dir>`: lays the lines with small gaps (longer before section titles), writes
`vo.js` (the script's words on Whisper's times, plus a 30 fps loudness envelope per line that the film can draw),
`vo.json` and `out/vo.wav`. If Whisper split or merged words, it spreads the script's words over the line: check
the warnings.

### 5. The film (drawn in code)
`film.html` is a list of scenes; each starts on its line (`scene(S('l06'), bg, draw)`), and `draw(t)` returns the
frame as HTML for time `t`. Time things with `at(line, 'word')` (the spoken word's start), `rise()`/`wrise()` (the
house text motion), `spoken()` (a phrase whose words rise on their own spoken times). The persistent frame (header,
the stepper that lights the current step) is `chrome()`, captions are `caption()`, the pixel wipe between sections
is `wipe()`. Every sound cue lives next to it in `cues()`, so picture and sound come from one source.
Build from the scene types in `references/style-guide.md`, and show the real thing (the real document, the real
command, the real waveform, the real numbers) rather than stock-ish decoration.

### 6. Sound
`node tools/render.js cues` (dumps `cues()` to `out/cues.json`) → `python3 tools/audio.py <SFX wav dir>` (places
every cue: levelled, peak-aligned, trimmed, reversed for risers) → `python3 tools/mix.py` (voice -15 LUFS, music
-27 LUFS side-chained under the voice, SFX -23 LUFS, master -14 LUFS). The SFX library is VoiceBox Files → SFX:
download it once and convert to 48 kHz mono WAVs (`ffmpeg -i x.mp3 -ac 1 -ar 48000 wav/x.wav`).

### 7. Review, then render
`node tools/render.js sheet 32 0 <dur> out/sheet-a.png`, then `stills` at the hits. Go through
`references/review-checklist.md`. Fix, re-check the same times. Then `node tools/render.js out/video.mp4 4` (CPU:
3,935 frames of 1080p in 134 s on a 4-core session, ~29 fps, since these scenes are HTML, not heavy canvas) or on Colab (`docs/REELS.md` 7b, `scripts/reels/fast_render.py` for NVENC), and mux:
`ffmpeg -i out/video.mp4 -i out/mix.wav -c:v copy -c:a aac -b:a 256k -shortest out/final.mp4`.

### 8. Deliver
Never mark a post as AI content: `youtube.synthetic: false` and `instagram.ai_generated: false`, always (the
owner's call, docs/FEEDBACK.md 2026-11-02).
`save_file` (or the project's folder) into `Videos/<Topic>`, PUT the bytes (`stat -c %s` for the exact size), and
send the owner the Files link. Write `POSTING.md` (title, description with credits, chapters, tags, a thumbnail
prompt). `project action=finish` with the files to keep. Commit the kit (not the renders) and ship per CLAUDE.md.

## Landscape vs vertical
- **Landscape 1920×1080 (YouTube)**: content between y 120 and 870, centred on x 960; captions in the band
  y 880-990; the header at y 44 and the stepper at y 1022. Longer is fine (2-10 min) if every 2-3 s something new
  happens; chapters in the description.
- **Vertical 1080×1920 (Reels, Shorts)**: `docs/REELS.md` rule 9 (centre on x 540, below y 1100 stay inside
  x 60-940, captions ≈ y 1500, diagrams above y 1330). Under 60 s for Shorts.
