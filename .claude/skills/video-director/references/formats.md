# Formats and worlds: a new look every video (the owner, 2026-11-03)

"We can't be having the same aesthetic and designs every time… we need to be creative each time." The brand is a
signature, not a template. Before the script, pick a **format** (the shape of the story) and a **world** (the art
direction), and don't reuse the world of the last two videos. Write both at the top of the planning sheet.

## What stays the same (the signature)
- The channel's voice: the hype at its best, then **"what's the catch?"**, answered with sources. Facts checked,
  opinions labelled ("our take").
- The **red pen** (`#D8463A`) as the one gesture of meaning: it circles the catch, strikes what's wrong, ticks what's
  true. In a new world it can be a different tool (a marker, a stamp, a highlighter, a laser pointer) but it's red
  and it's drawn on.
- The ident at the end (`promo/brand/cte.js`), a one-word question before it.
- The hard rules: no banned colours (`check_colors.py`), no gradients, voice first, word-timed, SFX tied to motion,
  -14 LUFS, frame 1 has motion, text and voice.

## What changes every video (the world)
Palette (dull, real-material colours: newsprint, brass, cardboard, film stock, sepia; still checked), the type pairing
(one display face for the idea, one for statements, one for evidence), the motion grammar (smooth eases, stop-motion
on twos at 12 fps, hard cuts, one continuous zoom), the transitions (a page turn, a shutter, a printer feed, a map
fly-over), the props, and the sound palette.

### A menu of worlds (pick by what the story is, then make it your own)
| World | Fits | Look | Motion and sound |
| --- | --- | --- | --- |
| **The editor's desk** (Cyclon, Instagram TV) | a claim to fact-check | paper, ink, red pen | rises, pen strokes, soft pops |
| **Broadsheet / stop press** | breaking news, a launch | newsprint grey, black ink, halftone dots, column rules, a masthead | the press rolls, headlines slam into columns; a press clatter, paper rustle |
| **Patent drawing** | how a device or feature works | cream sheet, sepia line art, hatching, FIG. 1 / FIG. 2 callouts with leader lines | parts explode out along leaders; pencil, drafting-table taps |
| **The receipt** | prices, costs, "what it really costs" | thermal paper, mono type, a tear line | it prints line by line, the total lands; printer whirr, the tear |
| **The museum** | history, "they tried this before" (IGTV) | gallery wall, the object on a plinth under one spotlight, a brass label | slow dolly between exhibits; room tone, footsteps, a velvet-rope clink |
| **Map and route** (Johnny Harris) | rollouts by country, "US only" | an old atlas: land, sea, a route line, pins | fly-over, the line draws, pins drop; map rustle, pin taps |
| **The case file / courtroom** | X vs Y, a debate | manila folders, evidence tags, a verdict stamp | exhibits slide in, the gavel; stamp thud |
| **Lab notebook** | benchmarks, tests we ran | graph paper, hand-plotted points, sticky tabs | points plot one by one; pen ticks |
| **Paper cut-out, stop motion** | playful stories, a character | cut card with real drop shadows, a little jitter | on twos (12 fps), a 1-2 px jitter; card slides, scissor snips |
| **The DM thread** | anything social, a story told as chat | a phone's chat, bubbles, typing dots (drawn, no real app's branding) | bubbles pop in on the words; send / receive sounds |
| **One continuous zoom** | "zoom out to see the whole thing" | each scene lives inside a detail of the last | no cuts: the camera keeps pushing; one long riser |

Mix and invent: a world is a choice, not a list. If a topic suggests its own material (a TV app → a TV; a chip →
silicon under a microscope; a bank → a ledger), use that.

## Formats that travel (the hook patterns that get sent)
Directional (blogs and practitioner data, not studies: trust our own `analytics` and Radar first). Sends per reach and
the 3-second hold are what show a Reel to new people; likes mostly reach followers. A Reel's median length is ~25 s,
so a news cut should aim at 30-45 s, an explainer at 60-90 s.
1. **"They quietly shipped X"** + the catch (what we did with Instagram TV): news, then what the post left out.
2. **Spot the error** (our name, literally): open on the hype claim with one planted error, "can you catch it?",
   reveal it at the end with the red pen. Comments + rewatches.
3. **X vs Y, tested**: a real side-by-side we ran, the verdict stamp at the end.
4. **The timeline in 30 seconds**: "Instagram's four tries at TV", one beat per date.
5. **The number**: one figure, taken apart ("$20 a month: what you actually get").
6. **Myth vs fact**: three claims, struck or ticked.
7. **The receipts**: "we said this in March; here's what happened" (a series that earns trust).
8. **The reply**: a Reel answering the top comment on the last one (the comment card on screen).
9. **Numbered series**: "Catch #12" on the cover, so returning viewers know it's ours.
10. **The local angle**: "is it out in India?" (most of our audience): the honest answer, the workaround if real.

## Unique things to try (pick one per video, don't stack them)
- **A planted error** in the first frame that the pen catches in the last (rule 2 above).
- **Our own content inside the story** (the Reel on the TV): the channel promotes itself while it explains.
- **A verdict meter**: "hype ↔ real", the needle settles where the sources put it; the same segment every time.
- **The real artifact, marked up**: the owner's screenshot, a listing, a changelog (never redrawn as if real).
- **Motion from the voice**: the camera or a prop moves with the voice's loudness envelope (`venv(t)`).
- **A sound that is the topic**: the TV's click, a printer, a camera shutter: one real sound becomes the beat.
- **A cold open with no words** (0.5 s of the object doing the thing) before the first line lands on frame 2.

## The check before building
1. Which format, which world, and why this world for this story?
2. Is it different from the last two videos (look at `promo/cte-*`)?
3. What is the one image people will remember (the anchor)? Is it the topic's own material?
4. What does the red pen do in this world?
