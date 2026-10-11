# Voicebox API

Two layers. You normally only touch the first.

## 1 · MCP tools (`https://<app>.vercel.app/api/mcp`, header `Authorization: Bearer $MCP_TOKEN`)

| Tool | What it does |
|---|---|
| `worker_status` | Online? GPU, VRAM, loaded engines, queue. Says "re-run the notebook" if the heartbeat is older than 4 min. |
| `list_voices` | Engines, voices, presets, every parameter with default/min/max, uploaded references. |
| `voice_lines` | `{engine, voice?, lines:[{id?, text, window?, params?}], params?, post?, label?, wait_seconds?}` → job. Blocks up to 45 s, then returns progress + a hint to call `get_job`. |
| `get_job` | `{job_id, wait_seconds?}` long-poll. When done, each result has `duration`, `fits` (vs `window`) and a signed `url`; the job has `zip_url`. Links expire after 6 h. |
| `list_jobs` | Last 30 jobs. |
| `cancel_job` | Cancel a queued job, or stop a running one after the current line. |
| `add_reference_voice` | `{name, url? \| audio_b64?, transcript?}` → a voice Chatterbox/Dia can clone. Dia needs the transcript. |
| `engine` | `{name, action: load\|unload}` prewarm or free VRAM. |

`voice` resolves as: `female` / `male` preset → engine voice name (`tara`, `af_heart`, …) → uploaded reference.
For Chatterbox and Dia, the `female` / `male` presets are reference clips that Orpheus speaks (`tara` / `dan`) on first use, so all three
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
| `orpheus` | 9 GB | `tara` / `dan` | Orpheus 3B. Most human-sounding; inline tags <laugh> <chuckle> <sigh> <cough> <sniffle> <groan> <yawn> <gasp>. |
| `dia` | 7 GB | `female` / `male` | Dia 1.6B (Nari Labs). Dialogue-native ([S1]/[S2]), non-verbals like (laughs) (sighs); clones from a reference. |

#### `kokoro` params

| Param | Default | Range | Notes |
|---|---|---|---|
| `speed` | `1.0` | 0.5 – 2 | speaking rate |
| `lang` | `''` |  | phonemizer override, e.g. en-us, en-gb, hi |

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
| `temperature` | `0.6` | 0.1 – 1.5 |  |
| `top_p` | `0.95` | 0.1 – 1 |  |
| `repetition_penalty` | `1.1` | 1 – 2 | >= 1.1 needed for stable output |
| `max_new_tokens` | `1800` | 200 – 4000 |  |
| `seed` | `7` |  |  |

#### `dia` params

| Param | Default | Range | Notes |
|---|---|---|---|
| `cfg_scale` | `3.0` | 1 – 5 |  |
| `temperature` | `1.3` | 0.5 – 2 |  |
| `top_p` | `0.95` | 0.5 – 1 |  |
| `cfg_filter_top_k` | `45` | 10 – 100 |  |
| `seed` | `7` |  |  |

#### Post-processing (`post`)

| Key | Default |
|---|---|
| `trim` | `True` |
| `trim_db` | `-45.0` |
| `normalize_dbfs` | `-3.0` |
| `sample_rate` | `48000` |
<!-- engines:end -->
