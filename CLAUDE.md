# Working in this repo

## Shipping (standing instruction from the owner)

Always ship finished work: commit, push the branch, open a pull request to `main`, and merge it once checks pass.
Merging to `main` makes it live: `.github/workflows/deploy.yml` deploys `mcp/` (dashboard + MCP server) to Vercel
(https://voiceboxstudio.vercel.app) and rebuilds the worker bundle that Colab pulls. After merging, check the Deploy
run succeeded and say so. A restarted Colab worker picks up `worker/` changes.

## Checks before pushing

- `cd mcp && npx tsc --noEmit` and `npx next build`
- `python3 -m py_compile worker/*.py` for worker changes

## Secrets

Never commit keys. `.env*`, `.secrets.local` and `.local/` are gitignored; ElevenLabs keys live in `.env.local`
(`ELEVENLABS_API_KEYS`, comma-separated, used by `scripts/elevenlabs-longform.py`).
