# Voicebox Studio design rules

The dashboard is a clean product UI in the family of ElevenLabs and Linear-style workspaces, dark only (the owner's
call): a near-black sidebar and canvas, hairline borders, white primary buttons, soft tinted status pills, and nothing
decorative. Read this before you
build or change any screen. Tokens live in `mcp/app/globals.css`; the shared parts live in `mcp/components/ui.tsx`
(`PageHeader`, `Field`, `StatCard`, `Empty`, `Notice`, `Toggle`, `PopMenu`, `ToolPage`, `SideRow`, `DropZone`), `Info.tsx`, `pop.tsx` (`Select`, `useDismiss`) and `Shell.tsx`.

## Structure

The app has two modes, switched at the top of the sidebar (in the top bar on phones), each remembering the page you were
last on. **Create** is the studio: its sidebar has the destinations below except Analytics, grouped by what you're doing,
not by which backend stores the data. **Grow** is analytics: everything under `/analytics`, with its own sidebar
(Overview, Radar, Live, Content, Audience, When to post, Competitors, YouTube, Instagram, then the rivals you pinned; Radar is also linked from Create's sidebar and is a phone tab) and its
own phone tabs (Overview, Live, Content, Competitors, More). Page by page:

| Group | Page | Route | Job |
|---|---|---|---|
| — | Home | `/home` | Greeting, the channels at a glance (headline tiles over one chart, top posts lately, this week against the goals and what's due), tool tiles, latest takes, ways to make a voice |
| — | Voices | `/voices` | Make a voice (three cards), then your voices and the built-in voices |
| — | Posts | `/posts` | Every post as a Board, Calendar, List or Gallery, filtered by platform; the post drawer; Autopilot (`?view=autopilot`): accounts, the publishing queue, rules |
| Grow | Live | `/analytics/live` | Every post under 72 hours old, yours and your rivals', checked every minute (`lib/live.ts`, a Cloudflare cron in `workers/live-timer.js`): views by age against the usual post at the same age (dashed, the middle half shaded), views in the last hour, a verdict (Taking off, Ahead, On par, Behind), followers as they move |
| Grow | Competitors | `/analytics/competitors` | You and each rival side by side (account cards, You vs them), the outlier feed (their videos beating their own usual), their fresh uploads live, when they post, the title habits of their hits, and following / pinning / removing rivals; each pinned rival gets `/analytics/competitors/<handle>` |
| Grow | Radar | `/analytics/radar` | What to post next (`components/Radar.tsx`, `lib/radar.ts` rules, `lib/radar-sources.ts` free sources, `lib/radar-data.ts` caching in R2): Sweep (an instrument-style scope, `components/RadarScope.tsx`: corner brackets, a turning dot-matrix core, a sweeping beam that pings each topic, mono readouts of real numbers only; distance = how good a bet, angle = the sector its signals came from; labels are laid out so they never overlap and the ones that can't fit stay off; a blip opens its evidence, heat parts and confidence; then the signal feed and a source grid), Keyword (`?q=`: opportunity rings, demand / momentum / competition / fit cards each listing their parts, the prediction against your usual with its range, a title lab scoring SEO and click as you type, long tail, questions, what ranks, news) and Watchlist (keywords over time, the prediction track record). Every number names its source; nothing is invented when a source fails |
| Grow | Analytics | `/analytics` | Six views, each a tab with its own address and 8–12 numbers at most: Overview (a one-line summary, the headline metrics as tiles that pick one big chart, this period against the one before, every format side by side, the next moves, top posts), Content (`/analytics/content`: output and hit rate, the performance map, every post with its deep dive, lengths and tags), Audience (`/analytics/audience`: followers and growth, followers over time, accounts, who's watching, how they find you), When to post (`/analytics/when-to-post`: the day × time heatmap, best slots, the days and hours the audience shows up, rhythm), YouTube and Instagram (`/analytics/youtube`, `/analytics/instagram`: that platform in depth in four views, `?view=` overview, reach, audience, posts) |
| — | Files | `/files` | A Drive-like file manager: category folders (Videos, Images, Audio, Docs & scripts, Other) and yours, Recent, search, filters, drag-and-drop, paste, trash (`?view=trash`) |
| Create | Writing room | `/writing` | Five tools as orbs (after the owner's poster): Hook score, Titles, Captions, Thumbnails, Weekly digest, each at `?tool=` (and `&post=`), the others shrunk into a rail; under the orbs, "On your desk" (every open post's hook, title, thumbnail and captions) |
| Create | Voiceover | `/voiceover` | Write, pick a voice, generate; Script and Lines views |
| Create | Clean-up, Subtitles, Images | `/clean-up`, `/subtitles`, `/images` | One tool each, in the tool layout |
| Studio | Settings | `/settings` | Tabs along the top with their own addresses (`?tab=`): Profile, Voice & sound, Publishing, GPU & engines (start/stop the Colab GPU, engines, machine, worker, failures; `/gpu` lands here), Security, Automation (approvals inbox, kill switch, units cap, ask-first switches, repos, workflows, call log), Claude & API (MCP, upload keys). Each tab is a bento of cards; no H1, the breadcrumb names the page |

Making a voice opens from the Voices cards: Instant voice clone (`/voices/new`), Professional voice clone (`/voices/professional`,
your trained model) and Re-voice (`/voices/revoice`). Old addresses redirect (`next.config.ts`), `/model` included. Add a
page only when a capability has its own object and its own primary action; otherwise it's a view, tab or section of an
existing page.

**The file viewer** (`Viewer.tsx`) is full screen on near-black: name and actions on top, the file in the middle, ← →
between files (a carousel's photo also gets its carousel as a strip along the bottom). Video and audio use `players.tsx` (own controls that fade while playing, buffered ranges, speed,
picture-in-picture, fullscreen, double-tap to skip, resume); documents use `docview.tsx`. Keep it the only way a file
opens full size.

**The publish composer** (`Publish.tsx`) opens from a target's pill in the post drawer or from Autopilot: a large
modal (full screen on phones) with the options on the left and a flat stand-in preview of the platform on the right, the
status and history under it, and the actions in a footer. It saves as you type.

**One name per page.** The nav label, the route, the H1 and how the docs and MCP instructions refer to it all agree.

## Page anatomy

- `PageHeader`: an optional small eyebrow (Home only), the page name as the H1, one sub line under ~90 characters,
  and at most two actions on the right (one black primary, one ghost).
- System state goes in a `Notice` strip directly under the header, except the GPU: a page that needs it shows it once,
  as its primary button ("Start the GPU" in place of Generate while it's off), never a banner or a status pill too.
- `PageHeader` shows the page's own pixel scene (`PageScene`, picked from the address in `pixel.tsx`) between the title
  and the actions; it hides on phones.
- Summary numbers go in a row of `StatCard`s (icon tile, number, what it counts, an optional link). Use them only when
  the numbers help decide what to do next (Posts, GPU).
- Then the content. Lists are rows inside one bordered container (`.lib-list`, `.erows`, `.table-wrap`), not a card per
  row. Cards (`.card`) group a form or a section; keep nesting to two levels.
- Voiceover uses the full height: a writing canvas on the left (Script: one box; Lines: each line with its audio,
  scores, 👍/👎 and Redo, plus the joined full take) and a settings panel with Settings / History tabs on the right.
- Tool pages (Re-voice, Clean-up, Subtitles, Images) use `ToolPage`: the work on a canvas on the left (`DropZone`,
  the recorder, results, an `Empty` state for where results land), settings in a panel on the right built from
  `SideRow`, and the one primary action at the panel's foot (`.tool-go`).
- Files is a file manager (`components/Files.tsx`, `fileparts.tsx`): a search box with filter pills ("Type: All ▾"),
  the folder path, then **Folders** and **Files** sections, each H2 with a count pill. A folder is a tabbed sheet in one
  of six soft colours (`--f-lavender` … `--f-sand`: back sheet and tab a shade deeper than the front, never a gradient);
  a file is a card whose white body rises into its cover as a tab, the ⋮ sitting in the notch. Every card has the same
  menu on right-click and ⋮, and a full-size open button under its checkbox and ⋮ (nothing interactive nests). Five
  category folders come first and file things by kind on their own; deleting goes to the trash with an Undo snackbar;
  uploads show as cards at once (with a progress ring) and in a panel bottom right. Every change shows at once and is
  saved behind it. The sidebar lists starred things under Favourites.
- Search on Files also understands photos: "red bottle" finds one nobody named (`components/smartsearch.ts`, a small
  image model in the browser; colours from the server), and a Colour filter pill groups photos by colour. A carousel or
  folder can be shared with a private, expiring link (Share link… in its menu, the share icon on the stage); the page
  behind it (`/s/<token>`) is the studio's black, read-only.
- A post's drawer opens with its **Pipeline**: six steps on a rail (Script, Hook score, Voice it, Subtitles,
  Thumbnail, Schedule), each a dot that turns green when the post has it, with "Do it" per step and Run all.
- A post's photos never scatter: two or more photos or clips on one post (or files grouped by hand, ⌘G) are one
  **carousel** card, its first photos fanned like a hand of cards that spread on hover (`components/Carousel.tsx`).
  Opening it stands each photo up from below the screen in turn onto a concave curved row on black (the owner's
  reference), starting on the first photo, the one in focus ~40% bigger than the rest, each with `#01` in ginger mono and its name under it. A click opens that photo in the file viewer with
  the carousel as a strip along the bottom. Keys: ← → browse, Enter open, 1–9, Alt+← → reorder, `[` `]` (or Shift+← →)
  the previous or next post's carousel, Esc back. Drag a card up (or hold it) and drop it to reorder. The top bar stays
  calm (the owner's call): an icon toggle for Curve / Phone, one chip (Live with saves and shares once it's out, else
  only slides that need a look), Post to Instagram, and the rest (star, rename, its post, share link, download,
  ungroup, slide checks) under ⋯. It switches Curve / Phone (the feed on a phone, swipeable, cropped to the first slide's shape), shows the slide checks
  as a chip (a panel lists each slide's size and problems) and, once posted, a Live chip with saves and shares; "Post to
  Instagram" opens the publish composer with the slides in order. The curve is positioned imperatively (no React
  render per drag frame). The motion is transforms only and stops for reduced motion.
- Grow's Overview follows the Flux layout (`components/Flux.tsx`): title and chips on one row (range, compare to,
  platform, live, a white Export, refresh), a strip of five numbers each with a hatched bar (this period's share of the
  last two, or progress to the posting goal), follower growth as a step chart per platform, likes / comments / shares
  as a split bar and table with one sentence on what it means, and the top posts as a ranked table with a half-ring
  performance gauge and a live dot for posts still followed.
- Live numbers are only read while someone is watching: a Grow page polls only while its tab is visible and someone
  touched it in the last 5 minutes; each poll marks the studio as watched, and the minute timer skips YouTube and
  Instagram entirely when nobody has been for 2½ minutes. The live chip says "Paused · you're away" meanwhile.
- Grow's live pages (`components/Grow.tsx`, `useLive`) poll every 30 s; the live chip (a beating `--live` dot and how long
  ago the last check landed) sits in every Grow page's top bar, which also holds the range, "Compare to" (the same
  number of days just before), Export (every post as CSV, or the page as PDF) and Refresh.
- Analytics (`components/AnalyticsShell.tsx`, `Analytics.tsx`, `AnalyticsPlatform.tsx`) answers one question per view, the
  way YouTube Studio and the social suites split theirs, never every number on one screen. The shell holds the header,
  the range, the strips and the view tabs, and loads the report once for every view (`useReport`, shared with Home), so
  switching views is instant; an old report shows at once with "Updating…" while a new one is built behind it. The
  headline metrics are a trend board: tiles (number, trend, sparkline) that pick the one big chart. The chart's current
  period is a solid ink line over a flat 6% ink fill, the period before a dashed `--mute` line; the heatmap steps
  `--ok` over the surface; networks are `--c-yt` / `--c-ig` (validated for colour blindness). The performance map plots
  every post (views against the usual × engagement rate) in four named quadrants. Every chart has a hover and keyboard
  read-out, and values are written beside bars, never only in them.
- The Writing room (`components/Writing.tsx`, `orbs.tsx`) is the owner's "It's okay to be okay" poster in matte black:
  each tool a marbled pixel orb (four shades of one token, never a gradient) in concentric hairline rings (3 to 9: more
  rings, further along), its name curving over the top in Geist, a white chip with its number, every chip's thread
  running down into one pixel hand, and a small key. Hover turns the marble and widens the rings. Inside a tool the orbs
  shrink into a pill rail; the score is the same rings filling in (`RingScore`). Below 720px the orbs become a list.
  Scores come from `lib/writing.ts` (no AI); "Ask Claude" copies a prompt for the MCP tools, which do the writing.
- Making a voice uses the voice art (`components/Orb.tsx`): a flat disc with a waveform inside a dotted arc that runs
  from nothing to the best length of audio, with the minimum ticked.

## Colour

- Matte black (the owner's call, see `docs/FEEDBACK.md`): canvas `#0a0a0a`, sidebar `#070707`, cards `#0f0f0f` with
  `#1c1c1c` hairlines, radii 12 / 9 / 7 px and no drop shadows, so cards read sharp. The logo sits plainly at the top of
  the sidebar (mark and name, no button). Pixel accents (`components/pixel.tsx`) add warmth: a pixel avatar from your
  name, a cozy pixel desk scene (Profile banner, Home's greeting, Live with nothing fresh, the 404), pixel icons on the
  Settings tabs. They animate slowly and stop for reduced motion.
- Dark only: near-black canvas (`--bg`), a darker sidebar (`--side`), `--fill` for tiles, tracks and inputs. There is
  no light theme and no theme switch. Every colour is a token; never write a hex in a component.
- Text: `--ink`, `--ink2`, `--dim`, `--mute`. All are 4.5:1 or better on their backgrounds in both themes. There is
  no fainter text token: decoration that must be lighter is not text.
- The primary button is solid ink (white). Ghost buttons are the surface colour with a hairline border.
- Status pills are soft tints with strong text: `ok` (green), `warn` (amber), `bad` (red), `blue`, `violet`, `grey`.
  Post stages always use the same tint: Ideas grey, In production amber, Review violet, Scheduled blue, Posted green.
- Red means an error, a destructive action or something overdue. Green means live or done.
- Flat everywhere: no gradients, glows or gradient art, the logo included (seven white bars falling into a V on a
  solid ink tile). `--brand` (violet) is only for text selection, checkmarks and native
  controls' accent colour.

## Type

- Geist for everything; Geist Mono only for numbers that move (timings, sizes, counters), code, and file and folder
  names on the Files page (they read as file names).
- H1 26px/600, section H2 15–16px/600, body 14px, small 13px, labels 13px/500. No serif, no all-caps labels.

## Controls and accessibility

- Every input has a visible label wired to it (`Field`, or `htmlFor`/`id`); icon-only buttons have an `aria-label`.
- `Info` (ⓘ) takes a `label` so screen readers hear "About Pace". Put what someone must know before acting in the label
  or sub line, never only behind an ⓘ.
- Don't disable a primary button without saying why next to it; better, keep it enabled and validate on submit with
  the message beside the field (`role="alert"`, `aria-invalid`).
- Shortcuts use a modifier: ⌘K / Ctrl+K opens search, ⌘B / Ctrl+B folds the sidebar to an icon rail, Alt+1–9 jumps to
  a page. No bare single-letter shortcuts.
- The top bar's right side holds search (a wide field with ⌘K; an icon on phones) and Settings (icon and word; the icon
  on phones), whose gear carries a dot while the GPU is on. The GPU appears nowhere else in the frame: no sidebar card,
  no top-bar pill, no Home banner. The studio opens on Grow (`/` → `/analytics`).
- Never a native `<select>` (it shows the device's menu): use `Select` from `components/pop.tsx`, which floats in a
  portal and stays on screen. `Info` tips, `PopMenu`s and `Select`s float the same way.
- Every popup closes on Escape and on a click outside (`useDismiss`); drawers and dialogs close on their scrim.
  Focus returns to the trigger. Targets are at least 24px.
- Anything fixed or sticky at the bottom (`.sticky`, `.save-bar`, the generate bar, the job tray) clears the phone tab
  bar (`--tab-h`).

## Motion

- Pages rise in once (0.3 s). Hover changes colour or border, never layout.
- Only live things loop: the GPU meter, a recording, a running job. `prefers-reduced-motion` stops them all, including
  the login's reading animation.
- The frame's icons are Phosphor, duotone, with `className="mv" data-move="…"`: the soft fill fades in on hover and on
  the current page, and each icon has its own springy move (globals.css, "icons in the frame"). The page scenes loop
  slowly (twinkles, steam, a breathing lamp): calm, cozy.
- Loading should go unnoticed: `api()` keeps a copy of every read (`components/cache.ts`), pages seed from it with
  `useSeed`, the report and live numbers come back from IndexedDB. `.skel` only appears after 180 ms and breathes;
  `PixelLoader` (three dots) for small waits. No shimmer, no gradient.
- Charts use one accent, `--chart`, over the surface: lines draw in, the last point carries a ring, hover shows a band,
  a crosshair and the value on the axis; columns and bars grow in. Values are written beside, never only in, the marks.
- Your character (`PixelAvatar` with `char`) and your cursor (Arrow, ASCII, System) are set in Settings → Profile →
  Look (`components/look.tsx`); every click drops a ginger ripple (`--ginger`, Miso's colour).
- Charts also carry a dotted plot field and a 45° hatch under lines (`ChartDefs`), the latest value in a chip, numbers
  that count up (`CountUp`), equalizer columns (twelve segments), tick-meter bars and a dot-size heatmap.

## Phones

- Below 960px the sidebar becomes a drawer, and a bottom tab bar shows Home, Voiceover, Posts, Voices and More (in Grow:
  Overview, Live, Content, Competitors and More).
- Stat cards go two-up, the board scrolls one column per screen, settings panels stack under their canvas.

## Before you ship UI

- Check the page at desktop and 390px width. No horizontal scrolling on any page.
- Run axe (or the browser's accessibility checker) on the page you changed.
- Run `npx tsc --noEmit` and `npx next build`.
