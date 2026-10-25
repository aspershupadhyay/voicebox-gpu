# Voicebox Studio design rules

The dashboard is a clean product UI in the family of ElevenLabs and Linear-style workspaces: a light sidebar, a white
canvas, hairline borders, black primary buttons, soft tinted status pills, and nothing decorative. Read this before you
build or change any screen. Tokens live in `mcp/app/globals.css`; the shared parts live in `mcp/components/ui.tsx`
(`PageHeader`, `Field`, `StatCard`, `Empty`, `Notice`, `Toggle`, `PopMenu`), `Info.tsx` and `Shell.tsx`.

## Structure

The studio has nine destinations, grouped by what you're doing, not by which backend stores the data:

| Group | Page | Route | Job |
|---|---|---|---|
| — | Home | `/` | Greeting with the GPU's state, tool tiles, latest takes, ways to make a voice, what's due next |
| — | Voices | `/voices` | Your voices and the built-in voices; clone your voice; re-voice a take |
| — | Posts | `/posts` | Every post as a Board, Calendar, List or Gallery, filtered by platform; the post drawer |
| — | Files | `/files` | Generated (takes, subtitles, images, videos in R2) and Uploads (shared workspace files) |
| Create | Voiceover | `/voiceover` | Write, pick a voice, generate |
| Create | Voice model | `/model` | Collect recordings and train your own model |
| Create | Clean-up, Subtitles, Images | `/clean-up`, `/subtitles`, `/images` | One tool each |
| Studio | GPU & engines | `/gpu` | Start/stop the Colab GPU, engines, machine, worker, failures |
| Studio | Settings | `/settings` | Defaults, security, MCP access |

Old addresses redirect (`next.config.ts`). Add a page only when a capability has its own object and its own primary
action; otherwise it's a view, tab or section of an existing page.

**One name per page.** The nav label, the route, the H1 and how the docs and MCP instructions refer to it all agree.

## Page anatomy

- `PageHeader`: an optional small eyebrow (Home only), the page name as the H1, one sub line under ~90 characters,
  and at most two actions on the right (one black primary, one ghost).
- System state goes in a `Notice` strip directly under the header ("The GPU is off" + the action that fixes it).
- Summary numbers go in a row of `StatCard`s (icon tile, number, what it counts, an optional link). Use them only when
  the numbers help decide what to do next (Posts, GPU).
- Then the content. Lists are rows inside one bordered container (`.lib-list`, `.erows`, `.table-wrap`), not a card per
  row. Cards (`.card`) group a form or a section; keep nesting to two levels.
- Tool pages (Voiceover) use the full height: a writing canvas on the left and a settings panel with Settings / History
  tabs on the right (`.tts`), with the generate bar at the bottom of the canvas.

## Colour

- Light: white canvas (`--bg`), barely-grey sidebar (`--side`), `--fill` for tiles, tracks and inputs on grey.
  Dark mirrors it on near-black. Every colour is a token; never write a hex in a component.
- Text: `--ink`, `--ink2`, `--dim`, `--mute`. All are 4.5:1 or better on their backgrounds in both themes. There is
  no fainter text token: decoration that must be lighter is not text.
- The primary button is solid ink (black in light, white in dark). Ghost buttons are white with a hairline border.
- Status pills are soft tints with strong text: `ok` (green), `warn` (amber), `bad` (red), `blue`, `violet`, `grey`.
  Post stages always use the same tint: Ideas grey, In production amber, Review violet, Scheduled blue, Posted green.
- Red means an error, a destructive action or something overdue. Green means live or done. No gradients or glows.

## Type

- Geist for everything; Geist Mono only for numbers that move (timings, sizes, counters) and code.
- H1 26px/600, section H2 15–16px/600, body 14px, small 13px, labels 13px/500. No serif, no all-caps labels.

## Controls and accessibility

- Every input has a visible label wired to it (`Field`, or `htmlFor`/`id`); icon-only buttons have an `aria-label`.
- `Info` (ⓘ) takes a `label` so screen readers hear "About Pace". Put what someone must know before acting in the label
  or sub line, never only behind an ⓘ.
- Don't disable a primary button without saying why next to it; better, keep it enabled and validate on submit with
  the message beside the field (`role="alert"`, `aria-invalid`).
- Shortcuts use a modifier: ⌘K / Ctrl+K opens search, Alt+1–9 jumps to a page. No bare single-letter shortcuts.
- Popovers and drawers close on Escape and return focus. Targets are at least 24px.
- Anything fixed or sticky at the bottom (`.sticky`, `.save-bar`, the generate bar, the job tray) clears the phone tab
  bar (`--tab-h`).

## Motion

- Pages rise in once (0.3 s). Hover changes colour or border, never layout.
- Only live things loop: the GPU meter, a recording, a running job. `prefers-reduced-motion` stops them all, including
  the login's reading animation.

## Phones

- Below 960px the sidebar becomes a drawer, and a bottom tab bar shows Home, Voiceover, Posts, Voices and More.
- Stat cards go two-up, the board scrolls one column per screen, settings panels stack under their canvas.

## Before you ship UI

- Check light, dark and 390px width. No horizontal scrolling on any page.
- Run axe (or the browser's accessibility checker) on the page you changed.
- Run `npx tsc --noEmit` and `npx next build`.
