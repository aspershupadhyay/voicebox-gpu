# The owner's feedback, kept

Every piece of design or product feedback the owner gives lands here, in the same pull request as the change it asked
for. Read this before touching the dashboard. Newest first. When something here conflicts with an older rule in
`docs/DESIGN.md`, this wins (and DESIGN.md is updated to match).

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
