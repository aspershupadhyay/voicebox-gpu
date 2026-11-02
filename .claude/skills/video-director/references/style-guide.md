# The style guide (the "visual training", written once)

The owner's feedback (`docs/FEEDBACK.md`) and `docs/REELS.md` win where they differ. Two looks are approved:
**the launch-film look** (near-black and ivory scenes, a serif for the idea word, mono for the real details; HackerTube,
this kit) and **the paper house look** (warm paper with a dot grid, navy title scenes, Inter 800 with Caveat notes;
the EGM Reel). Pick one per video and keep it for the whole film.

## Type
- **Statements**: Geist 700, tight tracking (-0.03em), 56-120 px in landscape, white on dark / ink on ivory.
- **The idea word**: Instrument Serif italic in the accent colour. One per line at most; that's the emphasis
  (colour, never a box or a stamp).
- **Real details**: Geist Mono, 18-26 px, letter-spaced labels (`RULE 03 / 07 · PLAN`), file names, commands, numbers.
- Never more than two sizes of statement on one frame.

## Colour
- Matte near-black `#0D0D0C`, raised cards `#171615` with a 1 px `#2A2826` hairline; ivory `#EFEBE3` scenes for
  documents and sheets (they read as paper).
- **One accent**: dull clay orange `#E07A4F`. Supporting tones are dull too: teal `#7BA79F`, blue `#8597B8`,
  sand `#CDB98D`, red `#C8594C`, green `#79AB84`. No pure #000 / #FFF / #F00 / #00F (they look cheap; duller
  colours look more expensive).
- Flat. No gradients except a soft highlight inside a mock thumbnail.

## Banned colours (the owner's hard rule, 2026-11-02: "never use this purple slop")
These are the colours AI agents reach for by default. They make a video read as generated. Never use them, in any
video, thumbnail prompt or new design. `python3 scripts/reels/check_colors.py film.html` must print "clean" before a
render. It flags each of these, anything within a hair of one, and every gradient.

1. **Purple, violet, indigo, lavender: any of it.** Tailwind indigo/violet/purple (`#6366F1`, `#4F46E5`, `#8B5CF6`,
   `#7C3AED`, `#A855F7`), the "AI startup" violet (`#7C6CF2`, the v1 Cyclon cut), lilac text (`#A99EFF`), pastel
   lavender washes (`#E0E7FF`, `#EDE9FE`, `#ECE9F5`). Hue 235-300° with any real saturation fails, whatever the shade.
2. **The purple-to-blue / purple-to-pink gradient** (`#667EEA → #764BA2`), aurora and mesh gradients, glows. Flat only.
3. **Tailwind and shadcn defaults used as-is**: blue-500 `#3B82F6` / `#2563EB`, sky `#0EA5E9`, emerald `#10B981`,
   green-500 `#22C55E`, amber `#F59E0B`, orange-500 `#F97316`, red-500 `#EF4444`, pink `#EC4899`, fuchsia `#D946EF`.
4. **Neon "cyber"**: cyan `#06B6D4` / `#22D3EE`, teal `#14B8A6`, magenta: any colour over ~75% saturation at mid
   lightness, especially glowing on black.
5. **Slate "navy dark mode"**: `#0F172A`, `#1E293B`, `#020617`. Our dark is a warm matte near-black (`#0D0D0C`).
6. **Pure values**: `#000`, `#FFF`, `#F00`, `#0F0`, `#00F`. Use near-black and warm off-white.
7. **Claude's clay** (`#D97757`, `#CC785C`): never Claude's colour (the owner, on Reel).
8. **The rainbow of saturated tiles**: a row of chips or app icons each in a different loud colour. Use one family of
   tones, varied in lightness.

What to do instead: neutrals do most of the work (matte near-black, warm greys, warm off-white paper), plus **one**
accent taken from the subject's own world and dulled (lower saturation, a little grey in it). Hold it to a few
moments per scene. A second tone only if it means something (good / bad). When unsure, take the colour away and see
if the frame still reads: it usually reads better.

## Text motion (the one rule everyone notices)
- Words rise **one at a time on their spoken word**: opacity 0→1, translateY 20 px→0, blur 5 px→0, 0.34 s, ease-out
  expo. A phrase never takes longer than 1.5 s to land. No bounce, no overshoot, no tilt, no typewriter on statements.
- Things that type (a chat box, a command) type at a believable speed with a caret and keyboard sound.
- A line dims (60% black over it) when the next idea replaces it on the same frame.

## Layout (landscape 1920×1080)
- Centre on the frame's true centre, x 960. Content between y 120 and 870. The persistent header at y 44 (left: the
  series in mono, right: where we are), the stepper at y 1022, captions in the band y 880-990.
- Elements are smaller than your first guess: make every element ~25% smaller, then check it still reads at phone size.
- Margins ≥ 120 px left and right for anything important.

## The persistent frame (one visual system for the whole film)
- A header and a breadcrumb (`RULE 03 / 07 · PLAN`), and a **stepper** of every step with the current one lit
  (accent dot), the done ones white, the rest outlined. Viewers always know where they are and how much is left.
- Section titles: a big mono number counting in (`03`), the rule in words beside it, the idea word in serif italic.
- **Between sections, a pixel wipe**: a 20×12 grid of 96 px blocks covers the frame in a left-to-right, slightly random
  order and uncovers it on the new scene (0.4 s each way), mostly near-black with ~12% accent blocks. It's the one
  flashy move; everything else is calm.

## The four scene types (pick one per line on the planning sheet)
1. **Captions**: the statement itself, big, rising word by word. For lines that are the point.
2. **Captions + UI**: the statement plus one small element in the lower half (a pill, a checklist item, a chip).
3. **Half screen**: the statement on one side, a diagram or mock-up on the other (left/right in landscape,
   top/bottom in vertical).
4. **Full screen**: the visual takes the frame: a document, a planning sheet, a waveform, a mixer, a timeline.
   Captions then carry the line (bottom band, three words at a time, the current word lit).

## Building a full-screen visual (the three-object rule)
1. **One main object** in the centre: the thing the line is about (the style guide, the plan, the waveform).
2. **Supporting elements** at its edges that land on their words: labels, chips, swatches, check marks.
3. **Depth around the outside**: the dot grid, the header and stepper, a dim secondary card.
Show the real thing: a real document's rows, the real command, this video's own waveform and word timestamps, its
own mixer, its own frames on the contact sheet. Real beats decorative every time.

## Camera
- A 3% punch-in on every cut (0.3 s ease-out), then a slow drift (+1.8% over the scene) so it's never fully still;
  the end card holds still.
- One cut or one new element every 2-3 s, on a spoken word.

## Captions
Only on lines the screen doesn't already say in big type (most viewers watch muted on phones, but double text is
noise). Dark pill `rgba(10,10,9,.86)`, Geist 700 50 px, three words at a time in landscape (1-2 in vertical), the
current word lit in a light accent `#F4B08F`, the script's words on Whisper's times (Whisper mishears).

## Never
Stamps, shakes, white flashes, glitch transitions as a habit, cartoon crawling bugs or smug robots, record scratches,
stock "tech" b-roll, a logo or UI that imitates a real product, a ghosted loop back to the first frame.

## The character: Reel (2026-11-02, the owner's pick)
`promo/directors-cut/blob.js`: a marigold pixel blob (`#E3BC5C`), backwards brown cap, a finger viewfinder; drawn cell
by cell, so it blinks, lip-syncs to the voice's loudness (`talk: venv(t)`), squashes on landings (`squash`), raises
its arms (`raise`), and can hold and clap a slate (`holdSlate`, `clap`, `slate: [line1, line2]`). It's our own: never
Claude's mascot or colours, never another creator's characters. Use it for a few moments that need a face (the
reveal, "that's you", the ask), not in every frame. When it's on screen, marigold is the accent.

## Pace for short attention spans (2026-11-02)
Under a minute for a single idea: short lines voiced at 1.15x, 0.08 s gaps, something new on screen every 1-2 s, a
hook whose text, motion and voice are all there on frame 1. Keep the deliberate breaths (a 0.6 s silence before the
reveal is worth more than the time it costs). Avoid the "AI explainer" look: few labels, big ones, one continuous
world with a camera that moves through it, and a structure with a payoff (the Director's Cut rewinds and strips its
own frame, then rebuilds it).
