# The owner's feedback, kept

Every piece of design or product feedback the owner gives lands here, in the same pull request as the change it asked
for. Read this before touching the dashboard. Newest first. When something here conflicts with an older rule in
`docs/DESIGN.md`, this wins (and DESIGN.md is updated to match).

## Latest round (pixel pass)

- **The GPU once per page, at most.** The Voiceover page showed it three times (a "GPU is off" banner, a "GPU off"
  status and a "Start the GPU" button). A page that needs the GPU shows only its one action button ("Start the GPU", in
  place of Generate / Create); no banner, no status pill. The tool pages and the instant clone follow the same rule.
- **Pixel icons everywhere in the frame**: the sidebar, the Create / Grow switch, the top bar (menu, sidebar, search,
  Settings, Create) and the phone tab bar use the pixel icons from `components/pixel.tsx`, not the line icons.
- **Each icon has its own hover move**, the way the Settings gear turns: the house hops, the waves ripple, the cards
  shuffle, the folder's paper pops out, the mic bobs, the wand flicks, CC types itself, the sun rises, tiles light up in
  turn, rings go out, rows slide in, people hop, the calendar flips, the trophy wobbles, the gear turns in pixel steps.
- **Each page has its own calm pixel scene** next to its title (a mic and ripples on Voices, a corkboard on Posts, a cat
  asleep on a filing cabinet on Files, an on-air sign on Voiceover, a radio tower on Live…).
- **Loading is pixel, never shiny**: skeletons are flat tiles with drifting pixel static and a stepped band of pixel
  blocks; small waits show three hopping pixels. No shimmer gradients.
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
