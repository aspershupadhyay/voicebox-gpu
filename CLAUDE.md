# Working in this repo

## Shipping (standing instruction from the owner)

Always ship finished work: commit, push the branch, open a pull request to `main`, and merge it once checks pass.
Merging to `main` makes it live: `.github/workflows/deploy.yml` deploys `mcp/` (dashboard + MCP server) to Vercel
(https://voiceboxstudio.vercel.app) and rebuilds the worker bundle that Colab pulls. After merging, check the Deploy
run succeeded and say so. A restarted Colab worker picks up `worker/` changes.

## Design

Every dashboard change follows `docs/DESIGN.md`. In short:

- Bone and ink with one emerald accent. No gradients, no orange or purple.
- Geist for the interface, with an Instrument Serif italic only for display words.
- One-line page subtitles. Explanations go in `<Info>` (ⓘ), not on the page.
- Pages rise in. Only live things loop.

Check light, dark and 390px width before you ship.

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
