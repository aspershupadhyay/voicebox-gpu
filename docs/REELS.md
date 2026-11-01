# Making Reels and Shorts (what works, learned on the EGM explainer, 2026-10-31, updated 2026-11-01)

The owner's rules for short videos, and the pipeline that made the first two (the Elephant-Goldfish Model explainer:
a 57 s story cut and a ~35 s hype cut). Read this before making any Reel, Short or TikTok. Newer owner feedback in
`docs/FEEDBACK.md` wins.

## The owner's rules

0. **Informative, never AI slop.** One video that can go viral on substance: real facts on screen (the repo, the real
   commands, what each part does, the numbers labelled as estimates). No stamps, no shaking, no white flashes, no
   cartoon crawling bugs or smug robots, no record-scratch or cartoon sound effects. Text rises in cleanly (fade +
   ~24 px, no overshoot, no tilt); emphasis is colour, not a box. Sound: soft whooshes on section changes, light
   ticks on cuts, one gentle chime where a verdict lands; the voice clearly leads (no drum loop since round 3: a pad
   bed ~16 dB under the voice, booms on reveals, UI sounds on what appears).
0b. **Keep the house look** (the owner liked v1): warm paper backgrounds with a dot grid, navy for the big title and
   number scenes, Inter 800 headlines with Caveat hand notes, sticky notes and paper docs, the hand-drawn elephant
   and goldfish, big 1-2 word captions in a dark pill. A new video changes the script and the pacing, not the art.
1. **Hook like the posts that blow up.** Open on authority + news + stakes, the way viral X posts do: "Google just
   open-sourced the tool thousands of its engineers use to stop AI from shipping sloppy code." Not a slow question.
   Then punchy parallel lines ("No code until the plan survives. No AI grading its own homework."), a turn ("Here's
   the wild part:"), and an honest catch at the end. Learn the pattern; never copy someone's post.
2. **Triple hook in the first 2 seconds.** On frame 1, all three at once: the picture is already moving (no fade in
   from black, no empty first frame), the text hook is already on screen, and the spoken hook starts at ~0.05 s.
3. **Fast paced, calmly.** A cut every 2-3 s, most of them on a spoken word; a subtle punch-in (≤5%) on hard cuts,
   a push or zoom transition (0.22 s) on section changes, a slow drift so the camera is never fully still. Short lines
   (hype delivery, ~1.08x tempo), tiny gaps between them (snap to the next 8th note, 0.1-0.2 s).
4. **B-roll between the story beats**: the real thing on screen (terminals typing the real command, the repo card,
   the workflow), not filler.
5. **Big captions, 1-2 words**, the current word lit, inside the safe area, on every line (most people watch muted).
6. **End on an end card, not a loop** (superseded on 2026-11-01, rule 10): a "Follow for more" beat, then a still
   end card.
7. **One video** unless asked for more: the hype script's hook and pace with the story version's clarity.
8. **Facts are checked against the source** (the repo, the docs) before they go in. A viral post can be wrong (the
   one we learned from said EGM runs only in Antigravity and has no security reviewer; the repo shows Claude Code and
   Codex installs and a design critic that checks security). Estimates are labelled as estimates on screen.

## Round 3: explain it like a system-design diagram (the owner, 2026-11-01)

9. **Layout is checked, not hoped for.** Centre headlines and diagrams on the frame's true centre (x = 540), not the
   safe area's centre (500: that reads as off-centre). The app's buttons only cover the lower right, so anything below
   ~y 1100 stays inside x 60…940; diagrams stay above ~y 1330 so the captions (≈ y 1500) never collide. Place a
   character by its real extent (the EGM elephant spans about -215…+410 × its scale around x), so nothing is cut off.
10. **The last frame is not the first.** No "loop" that crossfades the end into the hook (the owner saw a ghosted,
   transparent overlap). End on an end card (name, one line, where to get it, Follow / Send to a friend) that holds
   still for ~2 s.
11. **Explain like ByteByteGo**, not like a slideshow: one visual system for the whole film. A persistent header (topic
   in mono) and a breadcrumb ("STEP 2 · THE GOLDFISH"), a stepper that shows the whole workflow with the current step
   lit (the recurring map), crisp diagram cards with a coloured accent and an icon, arrows that draw on and carry
   packets, numbered stages that light up on their word, highlights on a document that turn into finding cards, and
   the real details (commands, file names, report names) in mono. Bold sans for statements, a serif italic
   (Instrument Serif) for the idea word. Hand-drawn characters on top of the crisp diagrams.
12. **What the two reference Reels taught** (devmonk.preetam's Uber heatmap, 300k+ views; kallawaymarketing's
   storytelling framework): open on a concrete situation and the question it raises, then authority ("asked in
   Uber's interview"); explain in numbered steps, each with a trap (what goes wrong) and its fix; reveal the term
   ("this is called…") after the viewer understands it; keep one continuous world (devmonk has no hard cuts at all:
   things morph and the camera moves); a recurring framework map that lights up step by step (Kallaway); end on a
   share-driven call to action ("send this to the friend who…"). Sound: **no drum loop**. devmonk is voice only, with
   real silences and tiny UI sounds tied to on-screen events (pings, ticks, a low hit); Kallaway adds deep sub booms
   on the reveals, a soft drone and whooshes as graphics enter. The voice is always on top.

## The pipeline (all in the cloud, ~20 min of work, ~0.3 Colab units)

1. **Script**: one line per beat, written to be said. Put it in `assets/script.json`.
2. **Voice** through the VoiceBox MCP: `gpu action=start purpose=voice`, then `voice_lines` with `engine: myvoice`,
   `voice: sparsh` (or `harsh`), `style: hype` for fast cuts (`tech` for calm), `platform: raw` (we master ourselves),
   `subtitles: true` (Whisper word times), `takes: 2`, `post: {tempo: 1.08}`. Poll `get_job`; download `zip_url`;
   then `gpu action=stop` (it costs ~2 units an hour while on). The first load of myvoice takes ~2 min.
3. **Word times**: build `vodata.js` from each line's `.subs.json` and `.wav` (duration, a 30 fps loudness envelope).
   Use the **script's words on Whisper's times** whenever the word counts match: Whisper mishears ("$150,000" for
   "one hundred fifty thousand", "to catch up" for "The catch? Up"), and a misheard caption is worse than none.
4. **The film**: the `animation-studio` skill (canvas drawn in code, sound synthesized in code). `score.js` lays the
   voice lines on a beat grid and names every hit as a word (`word(line, 'prefix')`); `film.js` and `song.js` both
   read it, so picture, music and voice can't drift. Characters for an idea can be drawn from `G.*` primitives
   (`cast-egm.js`: an elephant with glasses and a pencil, goldfish in bowls).
5. **Mix**: voice on top (stem RMS ~10-12 dB above the bed), music ducked under the voice and sidechained to the
   kick, master to -14 LUFS (`MIX.master(..., {lufs: -14})`). Measure it (`engine/tools/levels.js`): nobody listens.
6. **Review like a director before rendering**: `render.js sheet 0 <dur> 18 6`, `board`, `stills` at the hits. Look
   for text over characters, text past the right edge (the app's buttons live there), captions colliding with
   on-screen text, and anything misleading. Fix and re-check the same times.
6b. **Make the renderer fast first** (the owner's call, on by default): `python3 scripts/reels/fast_render.py <project>`
   right after copying the engine. Frames go out as raw RGBA instead of PNGs (bit-identical video; PNG-encoding a frame
   cost ~75 ms against ~14 ms to draw it), and on an NVIDIA GPU ffmpeg encodes with NVENC for both the frames and the
   mux. Measured on the 76 s EGM explainer: Colab L4 render + mux 278 s -> 59 s (raw frames alone: 215 s -> 89 s);
   a 4-core session 336 s -> 118 s. The owner chose speed over file size: NVENC files are ~3.5x larger than x264 at
   the same look (116 MB vs 33 MB; SSIM 0.992, PSNR 48 dB against the x264 cut), so save them with `upload_url`
   (R2, up to 2 GB) when they pass 95 MB. `RENDER_RAW=0` / `RENDER_GPU=0` turn either part off for one render.
7. **Render**: `render.js video` (background), `mux`, `check`, `verify` (sync at every marker).
7b. **Or render on Colab** (the L4's 12 cores: 157 s vs 215 s on a 4-core session for 47 s of video; worth it for
   batches, about even for one video once boot is counted). Pack the project (engine, scripts, assets, out/music.wav;
   ~22 MB) and `save_file` it (PUT to `put_url`); then `run` in bash in a named workspace with `files: [m:<id>]`:
   Node is `/opt/vb-node/bin`; install Chrome once with `npx -y @puppeteer/browsers install chrome-headless-shell@stable
   --path ~/chs`; the sandbox has no root, so fetch its four missing libraries with `apt-get download libatk1.0-0t64
   libatk-bridge2.0-0t64 libxcomposite1 libatspi2.0-0t64`, `dpkg -x` them into `~/libroot` and set
   `LD_LIBRARY_PATH=~/libroot/usr/lib/x86_64-linux-gnu` and `CHROME_PATH` (the fast renderer adds `/usr/lib64-nvidia`
   back by itself; without it ffmpeg can't find NVENC and quietly falls back to x264); then `render.js video 11`, `mux`, `verify`,
   copy the MP4 to `out/` with `save_to: "Videos/<topic>"`. The workspace keeps Chrome while the runtime is on.
8. **Deliver**: save to Files (`save_file` → PUT to `put_url` → ticket) in a folder like `Videos/<topic>`, and send it.

## Costs seen

- Voice: 10-11 lines in Sparsh's trained voice, 2 takes each, ~3.5 min of GPU including the model load, about
  0.1-0.15 units each run.
- Render: 1717 frames (57 s at 30 fps) in 265 s on the session's CPU, 32 MB H.264; 1401 frames (47 s) in 215 s
  here and 157 s on the Colab L4 (12 cores, 9.4 fps).
- Sync check: with no hit sound effects, mark cuts `sync: 'v'` (picture); Whisper's word starts are only good to
  ~0.1 s, so an 'a' check on a spoken word fails for no visible reason.
