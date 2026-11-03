# Catch the Error (cte): the brand

The channel's mark (the owner's logo, `promo/brand/cte-logo.png`): lowercase **c t** sitting on a grey baseline, an
**e** that has dropped below the line (the error), circled by a loose red pen ring, and **CATCH - THE - ERROR** in a
typewriter face underneath. The idea the whole brand comes from: *an editor's desk*: paper, ink, and a red pen that
catches what's wrong in the hype.

## Colours (checked by `scripts/reels/check_colors.py`)
| Role | Hex | Use |
| --- | --- | --- |
| Paper | `#E7E5E1` (with a faint grain) | the ground of brand scenes and the ident |
| Paper, deeper | `#D9D6D0` | cards, folds, a second plane |
| Ink | `#1B1A18` | statements, the ink scenes' ground |
| Ink, soft | `#3A3936` | body text, the tagline |
| Graphite | `#A6A49F` | the baseline, rules, quiet labels |
| **Red pen** | `#D8463A` (sampled from the logo) | the one accent: the catch, circles, underlines, strikes, ticks |

These are the brand's colours: the ident, the end card and the default *editor's desk* world. A video's own world
(the owner, 2026-11-03: "we can't be having the same aesthetic every time") brings its own dull, real-material palette
(newsprint, sepia, brass, film stock), checked like everything else; the red pen stays the accent of meaning. Inside
the desk world: nothing else, except a second dull tone when it carries meaning (a muted green `#5E7D5B` for "true / done").
Never purple, violet, lavender, neon or gradients (the style guide's banned list).

## Type
- **Jost 400/500** (`promo/brand/fonts/jost.woff2`): the logo's geometric letters; the ident and big statements.
- **Instrument Serif**, italic for the idea word (`fonts/serif*.woff2`): the editor's voice, the word you'd underline.
- **Courier Prime** (`fonts/courier-prime.woff2`): the typewriter: the tagline, sources, dates, quotes as evidence.
- **Geist / Geist Mono** for UI inside phone mock-ups only.

## The visual language: the red pen
Every emphasis is a pen gesture, drawn on (stroke-dashoffset, slightly wobbly, never a perfect vector shape): a
**circle** for the catch, an **underline** for the idea word, a **strike** for what's wrong, a **tick** for what's
true, an **arrow** with a handwritten note for context. One pen gesture per beat; the pen is the focal point while it
draws.

## Signature vs world
The signature never changes: the "what's the catch?" turn, the red pen as the gesture of meaning, sources on
screen, the ident. The world changes every video: palette, type pairing, motion grammar, transitions, props, sound.
The menu and the check are in the video-director skill's `references/formats.md`; don't reuse the last two worlds.

## The ident (every video ends on it)
`promo/brand/cte.js` (`CTE.ident(t, {w, h})`, `CTE.cues(t0)`, `CTE.DUR` = 4.3 s, then hold ≥ 1.5 s). A Pixar-style
character animation: the baseline draws out; **c** hops in on an arc; **t** drops onto the line and c flinches; **e**
hops in like a desk lamp (anticipation, squash and stretch, arcs), lands on the line, the line gives way and e slips
below it; c and t lean to look; the red pen circles e; e jumps ("caught!"); the tagline types out word by word.
Sound: soft pops on each hop, a sharp pop on each landing, a give-and-snap as the line breaks, a pen on paper for the
circle, a glint on "caught", a tick per tagline word. Preview: `PAGE=ident.html node tools/render.js stills 1 2 3 5`
in `promo/brand/`. It works in 9:16 and 16:9 (`w`, `h`, `cx`, `cy`, `k` set the size and place).

## Voice of the channel
Sharp, fair, curious. We show the hype at its best, then ask **"what's the catch?"** and answer it with sources.
No dunking, no fake urgency. Every video ends on a one-word question for the comments, then the ident.
