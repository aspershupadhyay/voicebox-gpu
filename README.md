# voicebox-gpu

Expressive voiceover, your own cloned voice and generated video clips on a Colab GPU, driven from any MCP client or the
dashboard. Nothing runs on your machine.

```
MCP client ──Bearer MCP_TOKEN──▶ Vercel (/api/mcp) ──Bearer WORKER_SECRET──▶ Cloudflare tunnel ──▶ Colab worker
                                      ▲                                                             │
                                      └──────────── heartbeat every 60 s (/api/register) ───────────┘
```

- **Voice engines:** Orpheus 3B on vLLM (most human, English), Qwen3-TTS 1.7B (best cloning of *your* recorded voice, 10 languages),
  Chatterbox (emotion dial, cloning, 23 languages incl. Hindi), Kokoro (instant drafts). Each has `female` and `male` presets; all
  parameters are in [docs/API.md](docs/API.md). No length limits: long text is split at sentences and re-joined.
- **Your voice:** record 20 s in the browser (Voices page); the worker cleans it and Whisper transcribes it; it's kept in R2.
  Every built-in voice also has an audition sample (`scripts/make-samples.py`), so you can pick without the GPU.
- **Video:** Wan 2.2 TI2V 5B (sharp 720p, Turbo 4-step) and LTX-2.3 distilled (picture + soundtrack, up to 10 s), from text or a start frame.
- **Lean GPU use:** only one engine group (voice or video) holds the GPU at a time, idle engines unload after 10 min, and model
  weights download on first use into per-engine folders that are evicted least-recently-used when disk runs short.
- **Subtitles:** Whisper large-v3 with word timestamps → SRT / VTT / JSON, per line and for the whole timeline, plus a script-match score.
- **Dashboard:** `https://<app>/` (sign in with `MCP_TOKEN`): Overview, Generate, Voices, Video, Subtitles, Library (private Cloudflare R2 storage).
- **Output:** 48 kHz mono WAV, trimmed and peak-normalised, plus a `fits` flag when you pass the line's timeline `window`.
- **Security:** two random secrets, both outside git. The tunnel URL is only stored in the private R2 bucket. Downloads are HMAC-signed and expire after 6 h.

## Setup (once)

```bash
scripts/gen-secrets.sh          # writes .secrets.local (gitignored, mode 600)
npx vercel login
scripts/deploy-mcp.sh           # links mcp/ to Vercel, sets MCP_TOKEN, WORKER_SECRET and R2_*, deploys
```

1. Create a private Cloudflare R2 bucket (`voicebox`), paste [docs/r2-cors.json](docs/r2-cors.json) into its CORS policy, create an
   *Object Read & Write* API token scoped to it, and put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
   in `.secrets.local`. `scripts/deploy-mcp.sh` pushes them to Vercel.
2. Open `notebook/voicebox_worker.ipynb` in Colab. In 🔑 **Secrets**, add `WORKER_SECRET` and `REGISTER_URL` (`https://<app>/api/register`).
3. Add the MCP to your client:

```bash
claude mcp remove voicebox   # only when replacing an older entry
claude mcp add --transport http voicebox https://voiceboxstudio.vercel.app/api/mcp --header "Authorization: Bearer <MCP_TOKEN>"
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
