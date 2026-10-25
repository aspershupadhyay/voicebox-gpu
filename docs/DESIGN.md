# Voicebox Studio design rules

The dashboard should feel like a quiet, hand-made instrument, not a template. Read this before you build or change any
screen. The tokens live in `mcp/app/globals.css`; the shared parts live in `mcp/components/` (`Info`, `art.tsx`, `Shell`).

## Feel

- Calm and confident. The content (scripts, voices, takes) is the loudest thing on a page; the chrome stays quiet.
- Decide for people. Show one obvious next action, sensible defaults, and options only where a choice matters.
- Every corner is deliberate: aligned edges, consistent spacing, no stray borders, nothing that looks like a default.

## Colour

- Light mode is bone paper (`--bg #fbfbfa`); dark mode is warm ink (`--bg #0b0b0a`). Hairline borders (`--line*`) give
  structure; text runs in graphite (`--ink`, `--ink2`, `--dim`, `--faint`).
- There is one accent, studio emerald (`--accent`, which `--signal` and `--ok` point to). It means "live", "selected"
  or "good", and nothing else. Use it sparingly: a live dot, the active waveform, the current word.
- `--danger` (red) is only for errors and destructive actions. `--warn` (ochre) is only for warnings. `--glacier`
  (steel blue) is only for informational states, such as a model parked in RAM.
- Never use gradients on surfaces, text or buttons. Never use orange, purple or "AI" rainbow palettes, and never use
  glows. The primary button is solid ink (`button.sig`).

## Type

- Geist for the interface. Geist Mono only for numbers that move (timings, sizes, counters) and for code.
- Instrument Serif (`--serif`, italic) is for display moments only: one word in a page title (`<h1>Write it,
  <em>hear it.</em></h1>`), the voice initials and the login script. Never use it for body text or labels.
- Page titles are 30px semibold with tight tracking. Section headers (`h2`) are 14px. Eyebrows are 11px uppercase.

## Text and explanations

- Page subtitles (`.sub`) are one short line, under about 60 characters. Say what the page is for, nothing more.
- Card headers carry a title only. If something needs explaining, put an `<Info>` (ⓘ) next to the label with one or
  two plain sentences; never add a grey paragraph to the page.
- Labels say what a control does in a few words. Anything a first-time user might wonder about goes in `<Info>`.
  Anything they must know before they act goes in the label itself.
- Don't add marketing copy, feature lists or "how it works" essays to working screens.

## Layout

- The sidebar holds three sections: Create (the tools), Workspace (planning), and Studio (library, engines, health,
  settings). The topbar shows the breadcrumb, a live status pill and ⌘K search.
- Structure a page like this: the head (eyebrow, title, one-line sub, and the primary action on the right), then
  cards in a grid (`.split` for editor + options, `.g2`/`.g3` for peers). Sticky action bars sit at the bottom for
  long forms.
- Cards: 14px radius, 22px padding, a 1px `--line` border and a barely-there shadow. Keep at most two levels of
  nesting.
- Use the full width at 1440px or wider, and keep the layout working at 390px (the tab bar replaces the sidebar).

## Identity

- The logo (`Logo` in `art.tsx`) is an ink box with five bars hanging from its lid. Their lower edge draws a V, and
  the middle bar is emerald. Don't recolour it, add effects to it, or put it on a gradient.
- Voice portraits (`VoiceGlyph`) are graphite radial waveforms seeded by the voice name, with the voice's initial in
  the serif. The active or playing voice turns emerald and breathes. Don't use gradient orbs or photos.
- The login page is typographic: a script reads itself word by word over a waveform, with a REC timecode. Keep it
  free of feature lists.

## Motion

- Pages rise in (0.42 s, `--ease`, staggered by section). Hover lifts clickable cards by 1px. Popovers fade in over
  0.14 s.
- Only live things loop: the live dot, the playing voice and a running job. Nothing else animates on its own.
- Always respect `prefers-reduced-motion`; `globals.css` already turns motion off for it.

## Before you ship UI

- Check light, dark and 390px width.
- Check that every new explanation lives in an `<Info>`.
- Make sure the page uses no new colours outside the tokens.
- Run `npx tsc --noEmit` and `npx next build`.
