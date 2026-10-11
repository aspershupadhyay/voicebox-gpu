# Voicebox API

Two layers. You normally only touch the first.

## 1 · MCP tools (`https://<app>.vercel.app/api/mcp`, header `Authorization: Bearer $MCP_TOKEN`)

| Tool | What it does |
|---|---|
| `worker_status` | Online? GPU, VRAM, loaded engines, queue. Says "re-run the notebook" if the heartbeat is older than 4 min. |
| `list_voices` | Engines, voices, presets, every parameter with default/min/max, uploaded references. |
| `voice_lines` | `{engine, voice?, lines:[{id?, text, window?, start?, params?}], params?, post?, subtitles?, language?, label?, wait_seconds?}` → job. Blocks up to 45 s, then returns progress + a hint to call `get_job`. |
| `get_job` | `{job_id, wait_seconds?}` long-poll. When done, each result has `duration`, `fits` (vs `window`) and a signed `url`; the job has `zip_url`. Links expire after 6 h. |
| `list_jobs` | Last 30 jobs. |
| `cancel_job` | Cancel a queued job, or stop a running one after the current line. |
| `add_reference_voice` | `{name, url? \| audio_b64?, transcript?}` → a voice Chatterbox can clone. |
| `transcribe` | `{sources:[{url, name?, text?}] \| library_job, language?}` → Whisper large-v3 subtitles (SRT/VTT/JSON, word timing). |
| `list_library` | Saved jobs in the dashboard library. |
| `engine` | `{name, action: load\|unload}` prewarm or free VRAM. |

`voice` resolves as: `female` / `male` preset → engine voice name (`tara`, `af_heart`, …) → uploaded reference.
For Chatterbox, the `female` / `male` presets are reference clips that Orpheus speaks (`tara` / `dan`) on first use, so both
engines can share the same two voices.

## 2 · Worker gateway (Colab, behind a Cloudflare quick tunnel)

All routes need `Authorization: Bearer $WORKER_SECRET`, except `/files/*`, which needs a valid HMAC `sig` + `exp`.

| Route | |
|---|---|
| `GET /health` | GPU, VRAM budget, engine states, queue |
| `GET /voices` | catalogue (same as `list_voices`) |
| `POST /jobs` · `GET /jobs` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel` | job queue (FIFO, one job at a time) |
| `POST /refs` | `{name, audio_b64 \| url, transcript?}` |
| `POST /engines/{name}/load\|unload` | |
| `GET /files/{job}/{line}.wav?exp&sig` · `GET /files/{job}.zip?exp&sig` | downloads (zip includes `manifest.json`) |

Each engine runs in its own `uv` virtualenv as a localhost process, so pinned torch/transformers versions never clash.
Engines load lazily and are evicted least-recently-used when the next one wouldn't fit the VRAM budget (total − 1.5 GB).

## Engines and parameters

Generated from `worker/config.py` by `python3 scripts/gen-docs.py`; don't edit by hand.

<!-- engines:start -->
| Engine | VRAM | Presets (female / male) | About |
|---|---|---|---|
| `kokoro` | 0 GB | `af_heart` / `am_michael` | Kokoro-82M. Fast, clean, flat delivery. Best for drafts and timing. |
| `chatterbox` | 4 GB | `female` / `male` | Chatterbox 0.5B (Resemble AI, MIT). Emotion dial + zero-shot cloning; 23 languages incl. Hindi. |
| `orpheus` | 11.5 GB | `tara` / `dan` | Orpheus 3B on vLLM. Most human-sounding; inline tags <laugh> <chuckle> <sigh> <cough> <sniffle> <groan> <yawn> <gasp>. |
| `whisper` | 6 GB | n/a (subtitles) | Whisper large-v3 (OpenAI). Best open subtitle model: word-level timestamps, 99 languages. |

#### `kokoro` params

| Param | Default | Range | Notes |
|---|---|---|---|
| `speed` | `1.0` | 0.5 – 2 | speaking rate |
| `lang` | `''` |  | leave empty: picked from the voice (h* = Hindi, b* = British...) |

#### `chatterbox` params

| Param | Default | Range | Notes |
|---|---|---|---|
| `exaggeration` | `0.5` | 0 – 2 | emotion intensity: 0.25 calm, 0.5 natural, 0.8+ dramatic |
| `cfg_weight` | `0.5` | 0 – 1 | lower = slower, more deliberate pacing |
| `temperature` | `0.8` | 0.05 – 2 |  |
| `language` | `'en'` |  | ISO code; non-English uses the multilingual model |
| `seed` | `7` |  |  |

#### `orpheus` params

| Param | Default | Range | Notes |
|---|---|---|---|
| `temperature` | `0.6` | 0.1 – 1.5 | lower = steadier and more literal, higher = more expressive but riskier |
| `top_p` | `0.95` | 0.1 – 1 |  |
| `repetition_penalty` | `1.1` | 1 – 2 | >= 1.1 needed for stable output; raise if words repeat |
| `seed` | `7` |  | change it to get a different take of the same line |

#### `whisper` params

| Param | Default | Range | Notes |
|---|---|---|---|

#### Post-processing (`post`)

| Key | Default |
|---|---|
| `trim` | `True` |
| `trim_db` | `-45.0` |
| `normalize_dbfs` | `-3.0` |
| `sample_rate` | `48000` |
<!-- engines:end -->
