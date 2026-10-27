# Voicebox API

Two layers. You normally only touch the first.

## 1 · MCP tools (`https://<app>.vercel.app/api/mcp`, header `Authorization: Bearer $MCP_TOKEN`)

| Tool | What it does |
|---|---|
| `worker_status` | Online? GPU, VRAM, loaded engines, queue. Says "re-run the notebook" if the heartbeat is older than 4 min. |
| `list_voices` | Engines, voices, presets, every parameter with default/min/max, uploaded references. |
| `voice_lines` | `{engine, voice?, style?, platform?, takes?, lines?:[{id?, text, window?, start?, params?}], post_id?, params?, post?, subtitles?, captions?, pronounce?, lexicon?, language?, label?, wait_seconds?}` → job. With `post_id` (and no `lines`) it voices that workspace post's script and attaches the result to the post. `review` (default on) listens back and re-voices only the sentences that missed; each result has `review {retried, fixed, issues}`. Blocks up to 45 s, then returns progress + a hint to call `get_job`. Engines: `orpheus`, `qwen`, `chatterbox`, `kokoro`. `platform` masters the audio (see *Platforms*); `takes: 2-4` = best-of-N per sentence; `[pause 0.8]` / `[beat]` / `[breath]` in the text insert silence. |
| `revoice` | `{url, voice, platform?, subtitles?, language?, label?}` → speech-to-speech job: a performance (audio or video URL) re-spoken in a recorded voice (Chatterbox VC), timing kept, mastered for the platform. |
| `clean_audio` | `{url, cleanup?: auto\|denoise\|enhance, params?: {strength, steps}, platform?, subtitles?}` → adaptive clean-up: measures the recording, runs DeepFilterNet and/or Resemble Enhance as needed, checks speaker identity, masters, same length. Result has `cleanup {steps, why, identity, before, after}`. |
| `voice_profile` | `{engine, voice, style?}` → what a voice has learned from reviewed voiceovers: usual voice match, best temperature, every setting tried. |
| `preview_pronunciation` | `{lines, pronounce?, lexicon?}` → what the voice will actually read (no GPU). |
| `get_settings` / `update_settings` | The shared studio defaults (R2 `settings.json`); every tool fills unset arguments from them, and the pronunciation dictionary merges into every request. |
| `my_voices` | Voices the user recorded on the dashboard's Voices page. Use the `name` as `voice` with `qwen` (best) or `chatterbox` (Hindi, emotion dial). |
| `get_job` | `{job_id, wait_seconds?}` long-poll. When done, each result has `duration`, `fits` (vs `window`) and a signed `url`; the job has `zip_url`. Links expire after 6 h. |
| `list_jobs` | Last 30 jobs. |
| `cancel_job` | Cancel a queued job, or stop a running one after the current line. |
| `publish_accounts` | Connected YouTube channels and Instagram accounts, every publish plan (draft, armed, uploading, published + link, failed + next retry) and the automation rules. See `docs/PUBLISHING.md`. |
| `publish_post` | `{post_id, space: yt_video\|yt_short\|ig_reel\|ig_post\|ig_story, account?, files?: [m:…\|g:…], cover?, youtube?: {title, description, tags, category, privacy, made_for_kids, synthetic, playlist, language, notify, youtube_schedules, …}, instagram?: {caption, share_to_feed, collaborators, user_tags, trial, audio_name, alt_text, ai_generated, first_comment, location_id}, go?: save\|arm\|now\|disarm}` → the plan. `arm` goes out at the target's publish time; `now` right away. |
| `publish_status` | `{post_id, space, action?: status\|stop\|retry}` → state, progress, live link, problems, history. |
| `automation_rules` | `{set?, run_now?}`: autopilot switch, retries, mark_posted, notify, crosspost rules, posting slots, caption footers, first comment, YouTube defaults, tz. |
| `add_reference_voice` | `{name, url? \| audio_b64?, transcript?}` → a voice Chatterbox can clone. |
| `transcribe` | `{sources:[{url, name?, text?}] \| library_job, language?}` → Whisper large-v3 subtitles (SRT/VTT/JSON, word timing). |
| `list_library` | Saved jobs in the dashboard library. |
| `engine` | `{name, action: load\|unload\|forget}` prewarm, free VRAM, or delete downloaded weights to free disk. |
| `imagine` | `{prompt, model?: zimage\|qwenimage, aspect?, count?, ...}` → stills (thumbnails, B-roll) saved to the library. |

**Shared workspace** (Appwrite; needs `APPWRITE_API_KEY` on the server). Changes made through MCP show up live on both
dashboards and are signed "Claude (MCP)" in the activity feed.

| Tool | What it does |
|---|---|
| `workspace_board` | `{status?, platform?, search?, limit?}` → posts with stage, platforms, due date, owner, voiceover count. |
| `get_post` | `{post_id}` → script, caption, notes, comments, media (view links), voiceover job ids, recent activity. |
| `create_post` / `update_post` | title, status (`idea`, `draft`, `review`, `scheduled`, `posted`), platforms, script (`script_mode: append` adds to it), caption, notes, `due_at` (ISO with offset), link, assignee (name or email). |
| `delete_post` | Only when asked. |
| `comment_on_post` | `{post_id, text}` → a note in the post's discussion. |
| `content_calendar` | `{from?, to?}` → scheduled posts in order (default: the next 14 days) plus unscheduled work in progress. |
| `workspace_media` / `add_media` / `upload_media` | List uploads (optionally one post's); copy a file from a URL (≤150 MB) or upload bytes (≤3 MB) into the shared uploads, attached to a post and/or filed in a `folder`. |
| `attach_voiceover` | `{post_id, job_id}` → link a library voiceover to a post. |
| `workspace_activity` / `workspace_members` | Who did what, newest first; who is on the team. |

**Files** (the Files page as a Drive-like file manager: uploads and generated items in one list, in folders kept in R2
at `workspace/files.json`; five category folders, Videos `sysvideos`, Images `sysimages`, Audio `sysaudio`, Docs &
scripts `sysdocs` and Other `sysother`, file everything by kind unless you move it). File ids are `m:<upload id>` or `g:<library id>`; folders are an id or a name path such as
`Thumbnails/October`, and `f:<folder id>` when moved or starred.

| Tool | What it does |
|---|---|
| `list_files` | `{folder?, everywhere?, search?, kind?, source?, starred?, trash?, limit?}` → the folder's subfolders (with item counts) and files (type, size, who, folder path, star, view link). Search looks in every folder. |
| `get_file` | `{file_id}` → details plus links valid for 6 h: an upload's view/download link, or every file of a generated item and its zip path. |
| `create_folder` / `update_folder` | `{name, parent?, color?}`; rename, recolour (lavender, sky, peach, mint, rose, sand) or move a folder (`parent: "/"` for the top). |
| `move_files` | `{items, to}` → file ids and `f:` folders into a folder, or the top with `to: "/"`. |
| `rename_file` / `star_files` | Rename an upload or a generated item; star or unstar files and folders. |
| `delete_files` / `delete_folder` | Only when asked. To the trash for 30 days (a folder with everything in it); `delete_files` with `forever: true` deletes for good (an upload's R2 backup stays). |
| `restore_files` / `empty_trash` | Bring things back from the trash; empty it (only when asked). |

The dashboard uses the same operations under `/api/dash/files`: `GET` (the tree, with video poster links), `GET items`
(generated items as file summaries from `library/index.json`), `GET favourites`, `POST folders {id?, name, parent?}`,
`POST folders/<id>`, `POST move {items, folder}`, `POST auto {items}` (back to its category), `POST star {items, on}`,
`POST rename {item, name}`, `POST delete {items, forever?}`, `POST restore {items}`, `POST empty-trash`,
`POST poster {item, data}`, `POST import {url, folder?}`.

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
| `POST /jobs` · `GET /jobs` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel` | job queue (FIFO, one job at a time). `kind`: `tts` (default), `transcribe`, `video`, `image`, `animate`, `reference` (`enhance`), `revoice` (`enhance`), `clean`, `story`, `dataset`, `train`, `benchmark`, `voicewalk` |
| `POST /speakable` | `{lines, pronounce?, lexicon?}` → per line, the spoken parts and pauses (pronunciation dry run) |
| `POST /jobs/{id}/push` | `{targets: {file: presigned PUT url}}`: the worker uploads results straight to R2 |
| `POST /refs` | `{name, audio_b64 \| url, transcript?}` (raw; the dashboard uses `kind: reference` jobs, which clean + transcribe) |
| `POST /engines/{name}/load\|unload\|forget` | `forget` also deletes the engine's downloaded weights |
| `GET /files/{job}/{line}.wav?exp&sig` · `video.mp4` · `poster.jpg` · `GET /files/{job}.zip?exp&sig` | downloads (zip includes `manifest.json`) |

**Video job** `{kind: "video", model, prompt, aspect, seconds, quality, seed, negative?, audio?, image_url?}`: frames are
`seconds × 24` rounded to the model's frame step (+1). Progress reports real denoising steps (`step 3 of 8`).
**Voice job extras.** What the engine reads is rewritten from the script (`lexicon`, on by default for English):
markdown and links cleaned, tech terms said right (`SQL` → sequel, `GPU` → G P U, `JSON` → jay-son, `16GB` → 16 gigabytes,
`v2.1` → version 2.1), plus your `pronounce: {word: say}` map. The script stays as written for subtitles and the match
score; each result's `spoken` shows what was read. `[pause]`, `[pause 0.8]`, `[pause 500ms]`, `[beat]`, `[breath]`
become real silence. On `qwen` with a recorded voice, Devanagari lines go to Chatterbox (`hi`) in the same voice.
`takes: N` voices each sentence N times (different seeds); Whisper transcribes every take and the WavLM speaker
model (`microsoft/wavlm-base-plus-sv`, in the whisper venv) compares it with the reference; the most accurate,
most-like-you take without a run-on tail wins, per sentence. Results carry `lufs`, `takes {n, picked, match, similarity}`
and, with subtitles on a cloned voice, `similarity` (0.86+ = same speaker).
**Re-voice job** `{kind: "revoice", url, voice, platform?, subtitles?}`: the performance is cleaned (high-pass, FFT denoise),
cut into ≤ 20 s pieces at its quietest moments, converted with Chatterbox VC and re-joined without gaps, untrimmed, so it
stays frame-accurate against the source video.
**Studio enhance.** The `enhance` engine (Resemble Enhance, MIT; ~0.7 GB, ~3 GB VRAM) denoises and restores speech to
44.1 kHz. Measured on the model's own street-noise sample: the noise floor between words dropped from −54 to −90 dB, and
an 8 kHz phone-quality copy came back full-band. It runs on voice references (`enhance`, default on), on re-voice input
(denoise only), on `kind: clean` jobs, and on generated lines with `post.enhance: true`. If it can't install or load, the
job warns and falls back to the ffmpeg clean-up instead of failing.
**Story job** `{kind: "story", scenes, ...voice options, platform, visuals, visual_style, captions_look, transition, music_url}`:
voice lines → scene timeline (0.25 s lead-in, 0.3 s between scenes, 0.8 s tail) → Whisper word timing → one Z-Image
still per scene (all stills first, then Wan clips if `visuals: clips`, so models switch once) → Ken Burns segments
(1080×1920 / 1920×1080, 30 fps) → 0.35 s cross-fades → ASS captions (Anton, word-by-word highlight for vertical; Inter
subtitles for wide) → voice + music (levelled, sidechain-ducked) mastered to the platform → H.264/AAC MP4, faststart.
**Voicewalk job** `{kind: "voicewalk", name, voice, ref, rounds?}`: finds the Kokoro style vector closest to a
recording of you (`voice`, synced from `ref`): every English Kokoro voice is auditioned against it (WavLM voice match),
the closest few are blended, then a hill-climb over the mix of voices (10-80 rounds, default 24) keeps every step that
sounds more like you. The result is checked with Whisper on a sentence it was never tuned on (stepping back to a clearer
state if it mumbles) and saved as `voice.npy` + `sample.wav`. Kokoro jobs then speak it as voice `kv_<name>`, with
`kvoices: {kv_<name>: {job, url}}` (the dashboard attaches the links).

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
| `myvoice` | voice | 11.5 GB | 7 GB | `me` / `me` | Your own voice model: Orpheus 3B fine-tuned on 30-60 min of your recordings (Your model page: collect, then Train). Same tags as Orpheus; with flow, a long script is voiced as one continuous take. |
| `whisper` | voice | 4 GB | 2.2 GB | n/a (subtitles) | Whisper large-v3-turbo (OpenAI). Large-v3 accuracy with a 4-layer decoder: several times faster subtitles, review and dataset cuts. Word-level timestamps, 99 languages. |
| `enhance` | voice | 3 GB | 0.7 GB | n/a (clean-up) | Resemble Enhance (MIT). Studio clean-up: removes noise and room echo, restores the detail a cheap mic or phone loses (to 44.1 kHz). |
| `qwen` | voice | 6 GB | 4.6 GB | `female` / `male` | Qwen3-TTS 1.7B Base (Alibaba, Apache-2.0). Best voice cloning: a 10-20 s recording of you becomes your voice. 10 languages (no Hindi: use Chatterbox). |
| `wan` | visual | 20 GB | 23 GB | n/a (video) | Wan 2.2 TI2V 5B (Alibaba, Apache-2.0). Sharp 720p, strong motion and prompt following. Turbo: 4 steps. |
| `wan14` | visual | 62 GB | 69 GB | n/a (video) | Wan 2.2 I2V A14B + Lightning (Alibaba, Apache-2.0). Best motion and detail of the Wan family; animates a start frame. 480p, 4 steps, A100 only. |
| `ltx` | visual | 52 GB | 71 GB | n/a (video) | LTX-2.5 22B distilled (Lightricks). Video *with matching sound* in 8 steps; up to 10 s. Full = two-stage, 2x resolution. |
| `zimage` | visual | 22 GB | 33 GB | n/a (image) | Z-Image-Turbo (Tongyi-MAI, Apache-2.0: commercial use OK). 6B, 8 steps, photoreal, ~2 s per image. |
| `qwenimage` | visual | 40 GB | 47 GB | n/a (image) | Qwen-Image-2.1 (Alibaba Qwen). Native 2K, sharp text in images, edits with up to 10 references, transparent PNGs. |
| `animate` | visual | 48 GB | 85 GB | n/a (video) | Wan 2.2 Animate 14B (Alibaba, Apache-2.0). Your character (one image) performs the motion of a driving video: exercises, dances, gestures. |

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

#### `myvoice` params

| Param | Default | Range | Notes |
|---|---|---|---|
| `temperature` | `0.5` | 0.1 – 1.5 | lower = clearer and steadier (0.45-0.55 for a crisp explainer), higher = more expressive but riskier |
| `top_p` | `0.95` | 0.1 – 1 |  |
| `repetition_penalty` | `1.12` | 1 – 2 |  |
| `seed` | `7` |  | change it to get a different take of the same line |
| `flow` | `True` |  | carry your delivery from one sentence into the next, so a script sounds like one take (needs a model trained with flow; slower on long scripts because sentences are voiced in order) |

#### `whisper` params

| Param | Default | Range | Notes |
|---|---|---|---|

#### `enhance` params

| Param | Default | Range | Notes |
|---|---|---|---|
| `mode` | `'enhance'` |  | enhance = denoise + restore detail; denoise = remove noise only, timbre untouched |
| `strength` | `0.6` | 0 – 1 | how hard the denoiser leads: higher for noisy rooms, lower keeps more of the original |
| `steps` | `48` | 16 – 128 | restoration detail (more = finer, slower) |

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
- Quality: `draft`: 4 steps, CFG 1 (Turbo + tiny decoder: quickest preview, slightly softer); `fast`: 4 steps, CFG 1 (Turbo distill with the full decoder); `full`: 30 steps, CFG 5 (Original model, best detail, ~20-30 min on an L4)

#### `wan14` video

- Sizes: 16:9 = 832×480, 9:16 = 480×832, 1:1 = 640×640
- 16 fps, up to 5 s (frames are multiples of 4 + 1)
- Quality: `draft`: 4 steps, CFG 1 (Lightning + tiny decoder: quickest preview); `fast`: 4 steps, CFG 1 (Lightning distill, 4 steps, full decoder)

#### `ltx` video

- Sizes: 16:9 = 960×544, 9:16 = 544×960, 1:1 = 768×768
- 24 fps, up to 10 s (frames are multiples of 8 + 1)
- Quality: `draft`: 8 steps, CFG 1 (One pass at about half size: quickest preview); `fast`: 8 steps, CFG 1 (Distilled, one pass); `full`: 11 steps, CFG 1 (Two-stage: x2 latent upsample + refine, double resolution (text only))

#### Post-processing (`post`)

| Key | Default |
|---|---|
| `trim` | `True` |
| `trim_db` | `-45.0` |
| `normalize_dbfs` | `-3.0` |
| `sample_rate` | `48000` |
| `tempo` | `1.0` |
| `master` | `'youtube'` |

#### Delivery styles (`style`, default `tech`)

A style sets engine params and `post` defaults; explicit values in the request win. Measured with `scripts/style-bench.py`.

| Style | About | orpheus | qwen | chatterbox | kokoro | post |
|---|---|---|---|---|---|---|
| `tech` | Bright, quick, confident. YouTube-tech pace (~185 wpm). | temperature=0.65, top_p=0.95, repetition_penalty=1.1 | temperature=0.85 | exaggeration=0.9, cfg_weight=0.3, temperature=0.8 | speed=1.1 | tempo=1.05 |
| `hype` | Maximum energy for promos and hooks (~200 wpm). Best with mia or leo. | temperature=0.7, top_p=0.95, repetition_penalty=1.1 | temperature=0.9 | exaggeration=1.05, cfg_weight=0.3, temperature=0.85 | speed=1.2 | tempo=1.08 |
| `narrator` | Measured documentary read with room to breathe (~165 wpm). | temperature=0.6, top_p=0.95, repetition_penalty=1.1 | temperature=0.7 | exaggeration=0.4, cfg_weight=0.5, temperature=0.8 | speed=0.95 | tempo=0.95 |
| `neutral` | Engine defaults, no styling. | defaults | defaults | defaults | defaults | — |

#### Platforms (`platform`, default `youtube`)

Mastering runs the broadcast voice chain (`highpass=f=75,equalizer=f=280:t=q:w=1.1:g=-2.5,equalizer=f=3200:t=q:w=1.0:g=2.0,highshelf=f=9000:g=1.5,deesser=i=0.35:m=0.5:f=0.5:s=o,acompressor=threshold=-20dB:ratio=3:attack=6:release=90:makeup=2:knee=4`) then two-pass EBU R128 loudness to the target. `post.master` / `captions` in the request override it.

| Platform | Loudness | True peak | Captions | About |
|---|---|---|---|---|
| `youtube` | -14 LUFS | -1 dBTP | `subtitles` | Long-form video: -14 LUFS, subtitle-style captions. |
| `shorts` | -14 LUFS | -1 dBTP | `punchy` | Vertical: -14 LUFS, 1-3 word pop-up captions. |
| `reels` | -14 LUFS | -1 dBTP | `punchy` | Vertical: -14 LUFS, 1-3 word pop-up captions. |
| `tiktok` | -14 LUFS | -1 dBTP | `punchy` | Vertical: -14 LUFS, 1-3 word pop-up captions. |
| `podcast` | -16 LUFS | -1.5 dBTP | `subtitles` | Audio-first: -16 LUFS, subtitle-style transcript. |
| `raw` | peak -3 dBFS | — | `subtitles` | No mastering: peak-normalised to -3 dBFS, for mixing yourself. |

| Caption style | Max chars | Max seconds |
|---|---|---|
| `subtitles` | 42 | 3.5 |
| `punchy` | 16 | 1.2 |
<!-- engines:end -->

## Voice quality engine

**Scoring** (`worker/quality.py`). The script, its spoken form and what Whisper heard are normalised the same way
(lexicon, contractions, numbers and decimals spelled out, spelled-out letters joined, compounds reconciled), then compared as
60% sound-alike words (order-aware) + 40% letters. Spelling variants score about 1.0; a skipped, swapped or invented word
costs points and is listed in `diff {missed, added}`.

**Review** (`review`, default on except Kokoro). After the first pass, every sentence is transcribed and compared with the
reference voice (WavLM) and rated for naturalness (UTMOS, when it loads). A sentence below the text gate (0.93) or more
than 0.05 under the voice's usual similarity is re-voiced with a new seed and a temperature nudge, up to 2 rounds; the best
take per sentence wins. Every attempt is reported in `trials`.

**Learning** (`mcp/lib/profiles.ts`). Trials are tallied per engine + voice + style in R2 (`profiles/…`). With at least 10
trials across two or more temperatures (3+ each), the best-scoring temperature is sent as `profile.params` and applied
unless the request sets one; the median voice match becomes `profile.sim_base`.

**Clean-up** (`worker/cleanup.py`). `analyze` measures level, noise floor/SNR, bandwidth (highest frequency where the
voice stands 6 dB above the noise and within 50 dB of its peak), room echo (T60 from post-word decay rates) and clipping.
`cleanup_plan` picks: SNR under 32 dB → DeepFilterNet (attenuation limit 30/60/100 dB by severity); bandwidth under
7 kHz, echo over 0.45 s or SNR under 18 dB → Resemble Enhance (strength by severity). Afterwards the speaker similarity
to the input must stay at least 0.80, or the last step is dropped. DeepFilterNet is the official static CLI, fetched once
into `$VOICEBOX_HOME/bin`.
