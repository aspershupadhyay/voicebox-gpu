# voicebox-gpu

Expressive voiceover on a Colab GPU, driven from any MCP client. Nothing runs on your machine.

```
MCP client ──Bearer MCP_TOKEN──▶ Vercel (/api/mcp) ──Bearer WORKER_SECRET──▶ Cloudflare tunnel ──▶ Colab worker
                                      ▲                                                             │
                                      └──────────── heartbeat every 60 s (/api/register) ───────────┘
```

- **Engines:** Orpheus 3B on vLLM (most human, English), Chatterbox (emotion dial, cloning, 23 languages incl. Hindi), Kokoro (instant drafts).
  Each one has `female` and `male` presets; all parameters are listed in [docs/API.md](docs/API.md). No length limits: long text is split at sentences and re-joined.
- **Subtitles:** Whisper large-v3 with word timestamps → SRT / VTT / JSON, per line and for the whole timeline, plus a script-match score.
- **Dashboard:** `https://<app>/` (sign in with `MCP_TOKEN`): Overview, Generate, Subtitles, Library (private Cloudflare R2 storage).
- **Output:** 48 kHz mono WAV, trimmed and peak-normalised, plus a `fits` flag when you pass the line's timeline `window`.
- **Security:** two random secrets, both outside git. The tunnel URL is only stored in the private R2 bucket. Downloads are HMAC-signed and expire after 6 h.

## Setup (once)

```bash
scripts/gen-secrets.sh          # writes .secrets.local (gitignored, mode 600)
npx vercel login
scripts/deploy-mcp.sh           # links mcp/ to Vercel, sets MCP_TOKEN + WORKER_SECRET, deploys
```

1. In the Vercel dashboard, open **Storage → Create → Blob (Private)** and connect it to the `mcp` project, then redeploy.
   Upstash Redis also works: set `KV_REST_API_URL` and `KV_REST_API_TOKEN` instead.
2. Open `notebook/voicebox_worker.ipynb` in Colab. In 🔑 **Secrets**, add `WORKER_SECRET` and `REGISTER_URL` (`https://<app>/api/register`).
3. Add the MCP to your client:

```bash
claude mcp add --transport http voicebox https://<app>.vercel.app/api/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

## Every session

In Colab, set **Runtime → L4 → Run all**. Within about a minute `worker_status` reports online.
The first job on an engine installs and loads it, which takes a few minutes; jobs after that take seconds.
Stop the runtime when you're done.

## Develop

```bash
cd mcp && npm i && npm run typecheck && npm run build
VOICEBOX_PY_KOKORO=~/.cache/hyperframes/kokoro-venv/bin/python scripts/local-worker.sh   # worker on :8000, no tunnel
WORKER_URL_PATTERN='^http://127\.0\.0\.1:8000$' npm --prefix mcp run dev                 # MCP on :3000 (temp-file registry)
scripts/smoke.sh http://localhost:3000 voice
python3 notebook/build_notebook.py   # after any change in worker/
python3 scripts/gen-docs.py          # after any change in worker/config.py
```

| Path | |
|---|---|
| `worker/` | gateway, engine hosts, engines, Colab launcher |
| `mcp/` | Next.js app on Vercel: `/api/mcp`, `/api/register` |
| `notebook/` | Colab notebook with `worker/` embedded (no repo access needed) |
| `scripts/` | secrets, deploy, smoke test, local worker, docs |
