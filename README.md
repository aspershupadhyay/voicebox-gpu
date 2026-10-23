# voicebox-gpu

Expressive voiceover in your own cloned voice on a Colab GPU, plus a shared workspace where two creators plan, write,
voice and schedule posts together, live. Driven from the dashboard (installable on phone and desktop) or any MCP client.
Nothing runs on your machine.

```
MCP client ──Bearer MCP_TOKEN──▶ Vercel (/api/mcp) ──Bearer WORKER_SECRET──▶ Cloudflare tunnel ──▶ Colab worker
                                      ▲                                                             │
                                      └──────────── heartbeat every 60 s (/api/register) ───────────┘
```

- **Voice engines:** Orpheus 3B on vLLM (most human, English), Qwen3-TTS 1.7B (best cloning of *your* recorded voice, 10 languages),
  Chatterbox (emotion dial, cloning, 23 languages incl. Hindi), Kokoro (instant drafts). Each has `female` and `male` presets; all
  parameters are in [docs/API.md](docs/API.md). No length limits: long text is split at sentences and re-joined.
- **Your voice:** record 20 s in the browser (Voices page); the worker cleans it and Whisper transcribes it; it's kept in R2.
  [docs/YOUR_VOICE.md](docs/YOUR_VOICE.md) has the recording and settings guide for a pro tech-explainer sound.
  Every built-in voice also has an audition sample (`scripts/make-samples.py`), so you can pick without the GPU.
- **Shared workspace (Appwrite Cloud):** a board of posts by stage (idea, in production, review, scheduled, posted), a
  content calendar, comments, an activity feed and a media library (images and videos up to 2 GB a file), live on both
  screens. Two logins, one team. Media is also backed up to R2. See [docs/WORKSPACE.md](docs/WORKSPACE.md).
- **Lean GPU use:** only one engine group (voice or video) holds the GPU at a time, idle engines unload after 10 min, and model
  weights download on first use into per-engine folders that are evicted least-recently-used when disk runs short.
- **Made for YouTube, Shorts, Reels and TikTok:** pick a `platform` and every line gets a broadcast voice chain (rumble cut,
  presence, de-ess, gentle compression) and two-pass loudness to the platform's target (−14 LUFS; podcast −16), with
  pop-up 1–3 word captions for vertical video.
- **Reviewed, not hoped for:** Whisper listens back to every sentence. One that skips, swaps or invents a word, or drifts
  off your voice, is re-voiced (only that sentence, up to two more tries), so you get the fix without paying for best-of-N
  on everything. Scores compare the script and what was heard in the same spoken form (sound-alike words and letters,
  not spelling), so "SQL" vs "sequel" or "Kubernetes" vs "Cubernetes" no longer swings the number. Best-of-N (2–4 takes)
  is still there for final renders.
- **Your own model:** collect 30-60 minutes on the *Your model* page (read-along or uploads; the worker cleans, cuts and
  filters clips), press **Train my voice** to fine-tune Orpheus 3B on the GPU worker (saved to R2, no Hugging Face), use
  it as the `myvoice` engine, and benchmark it against your clones on unseen sentences.
- **Learns each voice:** every reviewed voiceover records how each setting scored for that voice and style; once there's
  enough evidence, the best temperature becomes that voice's default and its usual voice-match becomes the bar.
- **Says tech right:** SQL, GPU, JSON, 16GB, v2.1, URLs and markdown are read the way a presenter would; add your own
  pronunciations. `[pause 0.8]`, `[beat]` and `[breath]` put real silence in the script.
- **Re-voice:** upload any take of yourself (voice memo, screen recording) and get it back in your clean recorded voice,
  timing and emotion intact. Hindi lines in a Qwen script are voiced by Chatterbox in the same voice.
- **Bad mic, studio sound, measured:** each recording is measured first (noise floor, bandwidth, room echo, clipping) and
  gets only what it needs: DeepFilterNet (CPU) for noise, Resemble Enhance to restore a thin or echoey voice, or both. A
  speaker check makes sure it still sounds like you, and the report shows before and after. Runs on voice recordings
  before cloning, on re-voice input, and on the Clean-up page.
- **Settings:** studio-wide defaults (voice, platform, pronunciation dictionary, enhance switches, R2 backup) shared by both
  of you and every MCP client.
- **Subtitles:** Whisper large-v3 with word timestamps → SRT / VTT / JSON, per line and for the whole timeline, plus a script-match score
  and a voice-match score for cloned voices.
- **Dashboard:** `https://<app>/` (sign in with your account, or `MCP_TOKEN` for the studio only): Board, Calendar, Media,
  Voiceover, Voices, Clean-up, Subtitles, Images, Library, Engines, Settings. Light and dark themes; installable as an app.
- **MCP covers the whole dashboard:** voice, clean-up, re-voice, subtitles, images, library, settings, and the workspace
  (read the board and calendar, create and edit posts and scripts, comment, attach media, voice a post's script).
- **Output:** 48 kHz mono WAV, trimmed and mastered for the platform (or peak-normalised with `platform: raw`), plus a `fits` flag when you pass the line's timeline `window`.
- **Security:** two random secrets, both outside git. The tunnel URL is only stored in the private R2 bucket. Downloads are HMAC-signed and expire after 6 h.

## Setup (once)

```bash
scripts/gen-secrets.sh          # writes .secrets.local (gitignored, mode 600)
npx vercel login
scripts/deploy-mcp.sh           # links mcp/ to Vercel, sets MCP_TOKEN, WORKER_SECRET, R2_* (and APPWRITE_API_KEY if set), deploys
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

In claude.ai (or any client that can't send a custom header), add a custom connector with just the URL
`https://voiceboxstudio.vercel.app/api/mcp` and leave the OAuth Client ID/Secret empty. If you're signed in to the dashboard
it connects straight away; otherwise you sign in once (GitHub or `MCP_TOKEN`) and come back connected. Clients other than
claude.ai/claude.com get an **Allow access** click. Rotating `MCP_TOKEN` disconnects every app.

**Sign in with GitHub (optional, recommended):** create a GitHub OAuth app (Settings → Developer settings → OAuth Apps) with
callback URL `https://voiceboxstudio.vercel.app/api/auth/github/callback`, then add `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
and `OWNER_GITHUB=<your login>` to `.secrets.local` and rerun `scripts/deploy-mcp.sh`. Only logins in `OWNER_GITHUB` get in.

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
