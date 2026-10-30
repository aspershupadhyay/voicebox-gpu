# Working in this repo

## Shipping (standing instruction from the owner)

Always ship finished work: commit, push the branch, open a pull request to `main`, and merge it once checks pass.
Merging to `main` makes it live: `.github/workflows/deploy.yml` deploys `mcp/` (dashboard + MCP server) to Vercel
(https://voiceboxstudio.vercel.app) and rebuilds the worker bundle that Colab pulls. After merging, check the Deploy
run succeeded and say so. A restarted Colab worker picks up `worker/` changes.

## The owner's feedback (read first)

`docs/FEEDBACK.md` keeps every piece of design and product feedback the owner has given, newest first, and it wins over
older rules. Read it before any dashboard work. Whenever the owner gives new feedback, add it there in the same pull
request as the change, so the next session doesn't repeat the mistake.

## Design

Every dashboard change follows `docs/DESIGN.md`. In short:

- Clean product UI, matte black only (the owner's call): pure black sidebar and canvas, sharp cards with hairline
  borders, white primary buttons, soft tinted status pills, small animated pixel accents for warmth. Flat: no gradients
  anywhere (the owner's call), including the logo; the hatched KPI bars are stripes, not gradients.
- Geist only (Mono for moving numbers). Every page opens with `PageHeader` (the page name as the H1, one sub line).
- Build from `components/ui.tsx`; every text colour is a token at 4.5:1 or better; every control has a label.
- Two modes, switched at the top of the sidebar: Create (Home at `/home`, Voices, Posts, Files, Voiceover,
  Clean-up/Subtitles/Images, Download) and Grow (analytics under `/analytics`: Overview, Live, Content, Audience, When to post,
  Competitors, Radar, YouTube, Instagram, pinned rivals). The studio opens on Grow. Search and Settings are at the top right;
  the GPU lives only in Settings → GPU & engines. Making a voice lives under Voices (`/voices/new`, `/voices/professional`, `/voices/revoice`).
- Never a native `<select>`: use `Select` from `components/pop.tsx`. Every popup closes on Escape and a click outside.
  New capabilities become views or tabs, not new pages. Pages rise in; only live things loop.

Check dark (the only theme) and 390px width before you ship.

## The automation suite

The MCP is a cloud workbench any model (Claude, Gemini…) can drive: approvals, units cap, call log and kill switch
(`lib/auto/control.ts`, `wrap.ts`: every tool call goes through them), a sandbox with code mode (`worker/bench.py`),
repos, media recipes (`worker/media.py`), the browser, templates, workflows, roles, the audit and lessons, and a lean
endpoint (`/api/mcp/lean`). All nine phases shipped; `docs/AUTOMATION.md` has the decisions, what's waiting on the
owner and what still needs checking on Colab: read it before working on any of it. A new tool goes in
`lib/auto/tools.ts` with an action enum and a worked example (`scripts/check_tools.py`); anything risky gets a gate in
`wrap.ts`.

## Inference work

Speed-ups for the voice engines follow `docs/INFERENCE.md` (the plan, in order, with its rules: behind a flag, works
on L4 and A100, measured before and after on a real GPU, same review scores). Tick `docs/ROADMAP.md` → Inference.

## Security

- The dashboard is invite-only: see `mcp/lib/access.ts` and `mcp/lib/session.ts`.
- The MCP (`/api/mcp`, `/api/mcp/lean`, `lib/auto/auth.ts`) takes `MCP_TOKEN`, OAuth access tokens, model keys
  (`vbmk_`, `lib/auto/keys.ts`, made and revoked only by a signed-in person, MCP only) and code-mode run keys.
- Tool keys (GitHub, search) pasted in Settings → Automation → Keys live encrypted in R2 (`lib/auto/secrets.ts`): never
  return one to the browser or a model, and only a signed-in person sets them.
- Never add a route without `isAuthed(req)` (worker routes use `WORKER_SECRET`; `/api/cron/live` also takes the
  Cloudflare live timer's secret, kept only as a SHA-256; `/api/files/upload`, `/complete` and `/api/files/carousels` also take an
  upload key, which can save files and arrange carousels and nothing else: no reading other files, no deleting). The
  share page `/s/<token>` is public by design (lib/shares.ts): it shows only what one unexpired, unrevoked link names,
  read-only; the token is kept only as a SHA-256 and uploads are served by Appwrite tokens that expire with the link.
- Never loosen the allow-list, the same-origin check or the session expiry.

## Checks before pushing

- `cd mcp && npx tsc --noEmit` and `npx next build`
- `python3 -m py_compile worker/*.py` for worker changes

## Secrets

Never commit keys. `.env*`, `.secrets.local` and `.local/` are gitignored; ElevenLabs keys live in `.env.local`
(`ELEVENLABS_API_KEYS`, comma-separated, used by `scripts/elevenlabs-longform.py`).
