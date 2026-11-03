# Review like a director

Render a contact sheet (`node tools/render.js sheet 32 0 <dur> out/sheet-a.png`, rename it before the next one) and
stills at every hit (`node tools/render.js stills 0.02 17.5 …`). Look at each at full size, not just the sheet.

## Picture
- [ ] Frame 1 (t = 0.02) already has motion, the text hook and is under the spoken hook.
- [ ] Nothing important outside the safe area; centred on the true centre (x 960 / 540).
- [ ] No text over text: captions never collide with on-screen type, the header or the stepper.
- [ ] Nothing cut off at the edges (characters and cards placed by their real extents).
- [ ] Every phrase lands in under 1.5 s; no bounce, tilt or overshoot.
- [ ] Something new every 2-3 s; no dead air longer than ~3 s.
- [ ] Colours: `python3 scripts/reels/check_colors.py film.html` prints "clean" (no purple / violet / lavender, no
  Tailwind defaults, no neon, no gradients, no pure black or white: style guide → "Banned colours"); one dull accent.
- [ ] Every number and name on screen matches what the voice says ("almost twenty" lands on 20, not 19).
- [ ] Captions only where the screen doesn't already say it; the script's words, not Whisper's mishearing.
- [ ] Nothing imitates a real product's UI or logo; a generic chat box is fine.
- [ ] The end card holds still for ≥ 2 s; the last frame isn't the first.

## Sound
- [ ] Voice on top everywhere (listen at the busiest moments: the wipes, the hits).
- [ ] Each whoosh swells with its move (peak on the fastest frame); each pop is on its element.
- [ ] One hit per scene; risers end on the hit, not after it.
- [ ] Master -14 LUFS ±0.5, true peak under -1 dBFS (`ffmpeg -af ebur128=peak=true`).
- [ ] Music ducks under every word and doesn't end abruptly (fade the last 3 s).

## Facts
- [ ] Every number traced to its source (a doc, the repo, the reference's own words); estimates labelled.
- [ ] Claims about the references are theirs ("his numbers, not ours"), credited in the post text.

## Notes, then rebuild
Write notes the way an editor gets them ("shorten the title by two words", "lower the pop at 0:41", "hold the end
card one more beat"), fix them all, then re-check the same times. Add anything the owner says to
`docs/FEEDBACK.md` in the same pull request.
