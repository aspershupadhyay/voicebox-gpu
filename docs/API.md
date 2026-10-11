# Voicebox API

Two layers. You normally only touch the first.

## 1 · MCP tools (`https://<app>.vercel.app/api/mcp`, header `Authorization: Bearer $MCP_TOKEN`)

| Tool | What it does |
|---|---|
| `worker_status` | Online? GPU, VRAM, loaded engines, queue. Says "re-run the notebook" if the heartbeat is older than 4 min. |
| `list_voices` | Engines, voices, presets, every parameter with default/min/max, uploaded references. |
| `voice_lines` | `{engine, voice?, style?, lines:[{id?, text, window?, start?, params?}], params?, post?, subtitles?, language?, label?, wait_seconds?}` → job. Blocks up to 45 s, then returns progress + a hint to call `get_job`. Engines: `orpheus`, `qwen`, `chatterbox`, `kokoro`. |
| `my_voices` | Voices the user recorded on the dashboard's Voices page. Use the `name` as `voice` with `qwen` (best) or `chatterbox` (Hindi, emotion dial). |
| `animate` | `{prompt, model?: wan\|ltx, aspect?: 9:16\|16:9\|1:1, seconds?, quality?: fast\|full, seed?, negative?, audio?, image_url? \| from_library?, label?}` → video job (minutes; poll `get_job`). Saved to the library as MP4 + poster. |
| `get_job` | `{job_id, wait_seconds?}` long-poll. When done, each result has `duration`, `fits` (vs `window`) and a signed `url`; the job has `zip_url`. Links expire after 6 h. |
| `list_jobs` | Last 30 jobs. |
| `cancel_job` | Cancel a queued job, or stop a running one after the current line. |
| `add_reference_voice` | `{name, url? \| audio_b64?, transcript?}` → a voice Chatterbox can clone. |
| `transcribe` | `{sources:[{url, name?, text?}] \| library_job, language?}` → Whisper large-v3 subtitles (SRT/VTT/JSON, word timing). |
| `list_library` | Saved jobs in the dashboard library. |
| `engine` | `{name, action: load\|unload\|forget}` prewarm, free VRAM, or delete downloaded weights to free disk. |

`voice` resolves as: `female` / `male` preset → engine voice name (`tara`, `af_heart`, …) → a recorded voice (`my_voices`).
Recorded voices live in R2 (`voices/<name>/reference.wav` + transcript); the dashboard passes the worker a signed link
(`ref: {url, transcript, version}`) so they survive the Colab runtime being recycled.
For Chatterbox, the `female` / `male` presets are reference clips that Orpheus speaks (`tara` / `dan`) on first use, so both
engines can share the same two voices.

## 2 · Worker gateway (Colab, behind a Cloudflare quick tunnel)

All routes need `Authorization: Bearer $WORKER_SECRET`, except `/files/*`, which needs a valid HMAC `sig` + `exp`.

| Route | |
|---|---|
| `GET /health` | GPU, VRAM budget, engine states, queue |
| `GET /voices` | catalogue (same as `list_voices`) |
| `POST /jobs` · `GET /jobs` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel` | job queue (FIFO, one job at a time). `kind`: `tts` (default), `transcribe`, `video`, `reference` |
| `POST /jobs/{id}/push` | `{targets: {file: presigned PUT url}}`: the worker uploads results straight to R2 |
| `POST /refs` | `{name, audio_b64 \| url, transcript?}` (raw; the dashboard uses `kind: reference` jobs, which clean + transcribe) |
| `POST /engines/{name}/load\|unload\|forget` | `forget` also deletes the engine's downloaded weights |
| `GET /files/{job}/{line}.wav?exp&sig` · `video.mp4` · `poster.jpg` · `GET /files/{job}.zip?exp&sig` | downloads (zip includes `manifest.json`) |

**Video job** `{kind: "video", model, prompt, aspect, seconds, quality, seed, negative?, audio?, image_url?}`: frames are
`seconds × 24` rounded to the model's frame step (+1). Progress reports real denoising steps (`step 3 of 8`).
**Reference job** `{kind: "reference", name, url, version}`: ffmpeg cleans the recording (high-pass, low-pass, FFT
denoise, trim, −3 dBFS), Whisper transcribes it, takes over ~24 s are cut to ≤ 20 s at a word boundary.

Each engine runs in its own `uv` virtualenv as a localhost process, so pinned torch/transformers versions never clash.

**Resource management** (nothing is held that isn't being used):
- **One group on the GPU.** Engines belong to `voice` (orpheus, qwen, chatterbox, kokoro, whisper) or `visual` (wan, ltx).
  Starting an engine of the other group stops every engine of the current one; each engine is its own process, so its
  VRAM *and* RAM are freed.
- **Inside a group**, engines are evicted least-recently-used when the next one wouldn't fit the VRAM budget (total − 1.5 GB).
- **Idle unload.** An engine with no work for `VOICEBOX_IDLE_MIN` minutes (default 10) is stopped.
- **Lazy, separate downloads.** Weights download on first use into `hf/<engine>/`. When free disk would drop below
  12 GB, the least-recently-used weights of stopped engines are deleted first. `/health` reports `mode`, `ram`, `disk`
  (free + per-engine weights) and `idle_unload_s`.

## Engines and parameters

Generated from `worker/config.py` by `python3 scripts/gen-docs.py`; don't edit by hand.

<!-- engines:start -->
| Engine | Group | VRAM | Download | Presets (female / male) | About |
|---|---|---|---|---|---|
| `kokoro` | voice | 0 GB | 0.4 GB | `af_heart` / `am_michael` | Kokoro-82M. Fast, clean, flat delivery. Best for drafts and timing. |
| `chatterbox` | voice | 4 GB | 4 GB | `female` / `male` | Chatterbox 0.5B (Resemble AI, MIT). Emotion dial + zero-shot cloning; 23 languages incl. Hindi. |
| `orpheus` | voice | 11.5 GB | 7 GB | `tara` / `dan` | Orpheus 3B on vLLM. Most human-sounding; inline tags <laugh> <chuckle> <sigh> <cough> <sniffle> <groan> <yawn> <gasp>. |
| `whisper` | voice | 6 GB | 3.2 GB | n/a (subtitles) | Whisper large-v3 (OpenAI). Best open subtitle model: word-level timestamps, 99 languages. |
| `qwen` | voice | 6 GB | 4.6 GB | `female` / `male` | Qwen3-TTS 1.7B Base (Alibaba, Apache-2.0). Best voice cloning: a 10-20 s recording of you becomes your voice. 10 languages (no Hindi: use Chatterbox). |
| `wan` | visual | 20 GB | 23 GB | n/a (video) | Wan 2.2 TI2V 5B (Alibaba, Apache-2.0). Sharp 720p, strong motion and prompt following. Turbo: 4 steps. |
| `ltx` | visual | 20 GB | 48 GB | n/a (video) | LTX-2.3 22B distilled (Lightricks). Video *with matching sound* in 8 steps; up to 10 s. 4-bit on the L4. |

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

#### `qwen` params

| Param | Default | Range | Notes |
|---|---|---|---|
| `language` | `'English'` |  | English, Chinese, Japanese, Korean, German, French, Russian, Portuguese, Spanish or Italian |
| `temperature` | `0.8` | 0.1 – 1.5 | lower = closer to your reference delivery, higher = livelier |
| `top_p` | `0.95` | 0.1 – 1 |  |
| `seed` | `7` |  | change it for a different take |

#### `wan` video

- Sizes: 16:9 = 1280×704, 9:16 = 704×1280, 1:1 = 960×960
- 24 fps, up to 5 s (frames are multiples of 4 + 1)
- Quality: `fast`: 4 steps, CFG 1 (Turbo distill, ~2-4 min per 5 s clip); `full`: 30 steps, CFG 5 (Original model, best detail, ~20-30 min on an L4)

#### `ltx` video

- Sizes: 16:9 = 1024×576, 9:16 = 576×1024, 1:1 = 768×768
- 24 fps, up to 10 s (frames are multiples of 8 + 1)
- Quality: `fast`: 8 steps, CFG 1 (Distilled, ~3-5 min per 5 s clip with audio)

#### Post-processing (`post`)

| Key | Default |
|---|---|
| `trim` | `True` |
| `trim_db` | `-45.0` |
| `normalize_dbfs` | `-3.0` |
| `sample_rate` | `48000` |
| `tempo` | `1.0` |

#### Delivery styles (`style`, default `tech`)

A style sets engine params and `post` defaults; explicit values in the request win. Measured with `scripts/style-bench.py`.

| Style | About | orpheus | qwen | chatterbox | kokoro | post |
|---|---|---|---|---|---|---|
| `tech` | Bright, quick, confident. YouTube-tech pace (~185 wpm). | temperature=0.65, top_p=0.95, repetition_penalty=1.1 | temperature=0.85 | exaggeration=0.9, cfg_weight=0.3, temperature=0.8 | speed=1.1 | tempo=1.05 |
| `hype` | Maximum energy for promos and hooks (~200 wpm). Best with mia or leo. | temperature=0.7, top_p=0.95, repetition_penalty=1.1 | temperature=0.9 | exaggeration=1.05, cfg_weight=0.3, temperature=0.85 | speed=1.2 | tempo=1.08 |
| `narrator` | Measured documentary read with room to breathe (~165 wpm). | temperature=0.6, top_p=0.95, repetition_penalty=1.1 | temperature=0.7 | exaggeration=0.4, cfg_weight=0.5, temperature=0.8 | speed=0.95 | tempo=0.95 |
| `neutral` | Engine defaults, no styling. | defaults | defaults | defaults | defaults | — |
<!-- engines:end -->
