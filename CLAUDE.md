# Working in this repo

## Shipping (standing instruction from the owner)

Always ship finished work: commit, push the branch, open a pull request to `main`, and merge it once checks pass.
Merging to `main` makes it live: `.github/workflows/deploy.yml` deploys `mcp/` (dashboard + MCP server) to Vercel
(https://voiceboxstudio.vercel.app) and rebuilds the worker bundle that Colab pulls. After merging, check the Deploy
run succeeded and say so. A restarted Colab worker picks up `worker/` changes.

## Design

Every dashboard change follows `docs/DESIGN.md`. In short:

- Clean product UI, dark only (the owner's call): near-black sidebar and canvas, hairline borders, white primary buttons,
  soft tinted status pills. Flat: no gradients anywhere (the owner's call), including the logo.
- Geist only (Mono for moving numbers). Every page opens with `PageHeader` (the page name as the H1, one sub line).
- Build from `components/ui.tsx`; every text colour is a token at 4.5:1 or better; every control has a label.
- Nine sidebar pages (Home, Voices, Posts, Analytics, Files, Voiceover, Clean-up/Subtitles/Images, GPU & engines, Settings).
  Making a voice lives under Voices (`/voices/new`, `/voices/professional`, `/voices/revoice`).
- Never a native `<select>`: use `Select` from `components/pop.tsx`. Every popup closes on Escape and a click outside.
  New capabilities become views or tabs, not new pages. Pages rise in; only live things loop.

Check dark (the only theme) and 390px width before you ship.

## Inference work

Speed-ups for the voice engines follow `docs/INFERENCE.md` (the plan, in order, with its rules: behind a flag, works
on L4 and A100, measured before and after on a real GPU, same review scores). Tick `docs/ROADMAP.md` → Inference.

## Security

- The dashboard is invite-only: see `mcp/lib/access.ts` and `mcp/lib/session.ts`.
- Never add a route without `isAuthed(req)` (worker routes use `WORKER_SECRET`).
- Never loosen the allow-list, the same-origin check or the session expiry.

## Checks before pushing

- `cd mcp && npx tsc --noEmit` and `npx next build`
- `python3 -m py_compile worker/*.py` for worker changes

## Secrets

Never commit keys. `.env*`, `.secrets.local` and `.local/` are gitignored; ElevenLabs keys live in `.env.local`
(`ELEVENLABS_API_KEYS`, comma-separated, used by `scripts/elevenlabs-longform.py`).
