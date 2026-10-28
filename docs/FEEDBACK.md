# The owner's feedback, kept

Every piece of design or product feedback the owner gives lands here, in the same pull request as the change it asked
for. Read this before touching the dashboard. Newest first. When something here conflicts with an older rule in
`docs/DESIGN.md`, this wins (and DESIGN.md is updated to match).

## Latest round (Instagram fixes, smart search, share links, pipeline, 2026-10-28)

- **"Post to Instagram" made two posts for the same carousel** (the agent's "Case 023 … (carousel)" post already held the
  photos; the button made another, which went live). It now reuses the post the photos already belong to and never
  posts the same files twice: photos already live are refused, and the publishing runner itself stops a repeat.
- **Posting to Instagram was slow**: one listing instead of two, only the files not yet on the post are moved, and the
  composer opens straight away from the reply (no waiting for the live post list). The button shows it's working and
  can't be pressed twice.
- **The carousel should open on the first photo**, and **the active photo bigger**: the card in focus is ~40% larger,
  fewer cards each side so all of them are bigger.
- **Sideways swipes went Back in the browser**: swipes on the carousel and the viewer now browse the photos instead.
- **The phone preview needs our logo**: the connected Instagram account's picture (the studio's logo if it can't load).
- **A carousel already live must not be posted again**; Claude can set up, arm or send a carousel through MCP.
- **Smart search, share links and the one-click post pipeline**: build them. **Not the duplicate finder** ("it will
  impact the performance"): left out. Keep background work light: smart search waits for the page to settle, looks at
  new photos one at a time, only on computers, never on data saver.

## Earlier round (carousels to Instagram, 2026-10-28)

- **The carousel stage was laggy and the spacing was off.** The curve is now placed straight on the page while you drag
  (no re-render per frame, ~60 fps), the cards have even gaps, the labels sit flat under them, and the whole curve fits
  the stage's width and height. Invisible wrappers were swallowing clicks on the middle card: fixed.
- **Opening a single file needed motion too**: the viewer zooms the file up on open, slides the next one in from the
  side you stepped towards, and sinks away on close.
- **Build the five carousel ideas**: post a carousel to Instagram (the composer opens with the slides in order and a
  fitted caption), drag a card up to reorder, a phone preview of the feed (P), slide checks (shape, size, duplicates),
  and its Instagram numbers once it's out. Instagram's API doesn't report which slide people stop on; say so rather
  than invent it.

## Earlier round (carousel fixes, 2026-10-28)

- **Uploading a carousel through the API failed on every file after the first** ("carousels are busy"). Fixed: the
  conditional write now matches R2's tag, falls back to a checked plain write, and turning a ticket in again retries
  the join. Files already uploaded can join a carousel without a re-upload (`/api/files/carousels`), and upload keys
  can do that too (the owner's call). Batch uploads take several files in one call.
- **"I don't see the UI"**: carousels now have their own row at the top of Files, not only inside their folder.
- **Uploads and image loading must be fast**: uploads go straight to storage; the copy into the workspace reads ahead,
  previews are made when the upload lands, the photos around the open one load ahead, and the Appwrite connection
  opens early.

## Earlier round (carousels in Files, 2026-10-28)

- **A post's photos must not scatter across Files.** A ten-photo post showed as ten loose files. Now they're one
  carousel card (the owner's reference: a curved fan of tall photo cards, each numbered #01… with a label under it).
- **Opening a carousel: the photos rise from the bottom to the middle of the screen**, one after another, "like the
  falling stick game but from bottom to up", then sit on the curve. Clicking a photo opens that photo.
- **Shortcuts to go back and forward inside a carousel, and to jump to the next post's**, in the stage and in the
  full-size viewer (← → inside, `[` `]` between posts). Make Files' image watching feel unique and creative, with
  motion.
- **Carousels need an MCP endpoint and must work through the upload API**: the `carousels` tool, `carousel` +
  `position` on `save_file` / `upload_media` / `add_media` and on `/api/files/upload`.

## Earlier round (Writing room, 2026-10-28)

- **The Writing room looks like the poster the owner sent** ("It's okay to be okay": marbled orbs in concentric rings,
  curved labels, black number chips, threads gathered into one hand, a small ring key). Built in matte black, flat and
  Geist (the owner picked "poster on black"): pixel marbles instead of paint, white chips, a pixel hand. Each orb opens
  its tool; keep it curated and premium, not a form page.
- **No AI model in the dashboard for writing** (the owner's call): the page scores from their own numbers with rules;
  the writing itself happens through Claude over MCP (`hook_score`, `title_lab`, `captions`, `weekly_digest`), which
  uses the same rules. "Ask Claude" buttons hand over the prompt.

## Earlier round (deck, cursor and charts, 2026-10-28)

- **A take you made must still be there after a refresh**, and play: it's kept in this browser (IndexedDB) and rebuilt
  from the library when it isn't, never "Couldn't play this take". Its player is our own: a turning disc with a ginger
  progress rim, the waveform as the scrubber. The voiceover being made uses the same deck.
- **Cursor: the white arrowhead the owner showed** (no "Studio" arrow). Every click drops a ginger water ripple (Miso's
  colour).
- **Settings' tabs are one centred pill bar**, sections sharing it equally, the white pill sliding to the open one.
- **Home → This week was cluttered**: now a ring per format, the next seven days as a strip, a slim Up next.
- **The YouTube and Instagram marks were rendering 4 px wide** in the sidebar (a flex item shrinking): fixed, and they
  have their own hover moves. Check a fix in the real frame, not only in isolation.
- **Charts must be visibly creative**: a dotted plot field, hatched areas, the latest value in a chip, numbers counting
  up, equalizer columns (fits an audio studio), tick-meter bars, a dot-size heatmap. Still flat.
- **Home's pixel desk is bigger** (up to 380 px) and handled with the header; gone on phones.

## Earlier round (premium pass, 2026-10-28)

- **Pixel icons didn't look good: undone.** The frame uses premium line icons (Phosphor, duotone) again. Keep a move per
  icon, but make it feel premium: smooth springy transitions that settle back, the soft duotone fill fading in on hover.
  Pixel art stays for the characters, the cursor option and the page scenes only.
- **Pixel loading wasn't intriguing.** Loading should be so fast you don't notice it: paint from the last copy at once,
  refresh behind it. A skeleton only shows if a wait passes ~180 ms, and it's a flat tile that breathes, nothing shiny.
- **Profile pictures are five pixel characters** you pick from (not a generated pattern).
- **A custom cursor**, ASCII-style as one option, changeable by the user.
- **Charts must look premium**: more contrast, a clear look, some life (lines drawing in, bars growing), still flat.
- **YouTube and Instagram marks must look right**, as their own logos, not generic outline icons.
- **YouTube and Instagram analytics in depth, down to each video**, every metric the APIs give.
- **Make what exists robust first**, then the new features (trend radar, watcher feeds, MCP for them: see ROADMAP →
  Next up).

## Earlier round (pixel pass)

- **The GPU once per page, at most.** The Voiceover page showed it three times (a "GPU is off" banner, a "GPU off"
  status and a "Start the GPU" button). A page that needs the GPU shows only its one action button ("Start the GPU", in
  place of Generate / Create); no banner, no status pill. The tool pages and the instant clone follow the same rule.
- ~~Pixel icons everywhere in the frame~~ (undone in the premium pass: line icons again).
- **Each icon has its own hover move**, the way the Settings gear turns: the house hops, the waves ripple, the cards
  shuffle, the folder's paper pops out, the mic bobs, the wand flicks, CC types itself, the sun rises, tiles light up in
  turn, rings go out, rows slide in, people hop, the calendar flips, the trophy wobbles, the gear turns in pixel steps.
- **Each page has its own calm pixel scene** next to its title (a mic and ripples on Voices, a corkboard on Posts, a cat
  asleep on a filing cabinet on Files, an on-air sign on Voiceover, a radio tower on Live…).
- ~~Loading is pixel~~ (replaced in the premium pass: fast first, a flat breathing tile only after 180 ms). Never shiny.
- **Files gets the most life**: cards build in from pixel blocks, folders tip open with a sheet of paper peeking out,
  covers zoom, audio waves dance on hover. Keep it light: transforms and opacity only, nothing for reduced motion.

## How to work with this owner

- They send screenshots and inspiration images. Build to the look they show, not to a reinterpretation. When they
  approved a mock (an artifact), the shipped page must look like that mock. They noticed when Grow first shipped in
  the old card style instead of the Flux mock they'd approved, and asked again.
- Say what's live and what isn't. A screenshot from before a deploy finished isn't a bug report on the new version.
- Anything left running in the background (a watcher waiting for a deploy, say) gets one plain sentence on what it is,
  and is stopped once its job is done. Finish a round by confirming the live site shows the change, not just the merge.
- Plan first when they ask for a plan; build when they say go. Ship every round (CLAUDE.md → Shipping).
- Never repeat the same control in several places. One home per thing (the GPU lives in Settings only).
- Their phrasing is casual. Act on the design and product asks, and keep replies professional.

## Look and feel

- **Matte black.** Pure, quiet blacks: canvas `#0a0a0a`, sidebar `#070707`, cards `#0f0f0f`, hairlines `#1c1c1c`. No
  blue-grey tints. Cards are sharp: small radii (10–12 px), crisp 1 px borders, no soft drop shadows.
- **The Flux look for Grow** (inspiration: the Flux analytics dashboard). Title and chips on one row, a KPI strip with
  hatched bars, step charts, a split bar with a table, a ranked table with gauges and live dots. Pinned rivals in the
  sidebar.
- **Pixel accents, calm and cozy.** Pixel-art details (the profile's pixel avatar, a small animated pixel scene) give
  the studio warmth. Animate gently (slow twinkles, a breathing glow), never busily, and respect reduced motion.
- **No dead space in cards.** A card in a row with a taller neighbour must not leave a big empty block: let the
  content (a chart) fill the height, or align the row to the top.
- **The logo is just a logo.** The Voicebox mark and name sit plainly at the top of the sidebar, not inside a button
  or a menu. Studio settings live in Settings.

## Layout and navigation

- Two modes, Create and Grow, with a switch at the top of the sidebar. The studio opens on Grow (`/` → `/analytics`).
- Search and Settings sit at the top right. Settings shows its icon and the word; on phones only the icon.
- The sidebar folds to an icon rail with a deliberate, nice-looking control (and ⌘B), not a bare chevron.
- Settings is tabs along the top (like a navbar), each a bento of cards. No "Settings" H1, the breadcrumb says it.
- Don't crowd one page with metrics: split into views, one question each.

## Data and cost

- Live numbers are read only while someone is on a Grow page with the tab visible and in use. Away = no API calls.
- Never pay for something that can be built: free tiers first (Cloudflare cron, R2), and say what something costs.
- Rivals: the five YouTube channels and four Instagram accounts the owner named (see `lib/live.ts`). Same metrics for
  them as for us, wherever the platforms make them public.
- Files of any size are saved through the upload endpoint (`save_file`), never pushed through MCP.
