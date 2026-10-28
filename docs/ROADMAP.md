# Roadmap: what's being built, what's done

A working checklist so any session (or person) can pick up where the last one stopped. Tick a box in the same commit
that finishes it. Everything ships to `main`, which deploys the dashboard to Vercel and the worker bundle Colab pulls.

## Voice
- [x] Trained voices sound continuous (flow), speech-only loss, best-epoch pick, mixed-length clips (PR #2)
- [x] One trained model per person, served side by side on one worker; free-T4 float16 (PR #2)
- [x] Any number of trained voices (no cap on models a job can carry)
- [x] Your model → Collect: listen to a recording (or the files you picked) before it's added to the dataset; discard it
- [x] Clean-up: record in the browser, listen, then clean (not only upload)
- [x] Subtitles: "Generated voiceovers" tab lists every voiceover (play, subtitle, redo) + a Record tab

## Content manager (Notion-style spaces per platform)
- [x] Spaces: YouTube (Videos, Shorts, Posts), Instagram (Reels, Posts), X (Posts), TikTok, LinkedIn, Podcast;
      sidebar with counts, board-by-stage and list views per space, "new post" pre-set to the space
- [x] Cross-posting: one post, many targets; each target has its own status, publish time and live link
- [x] Delete posts from the list view (and the drawer, already there)
- [x] Storage: targets live in R2 (`workspace/spaces.json`) because the Appwrite posts table can't get new columns from
      this deployment's key (no tables.write scope); the legacy `platforms` array is kept in sync for filters and MCP
- [x] MCP: create/update posts with targets (spaces), list a space, upload a file to the workspace media (URL or
      base64), delete a file

## Reliability + polish (round 3)
- [x] Jobs survive a refresh / tab switch: every job started from the dashboard is remembered (localStorage), a tray
      follows it from any page (which also finishes archiving it), and each page picks its running job back up
- [x] Recordings are saved while you record (IndexedDB, every second): after a refresh or crash, the take is offered back
      to use, keep recording another, or discard (Voices, Your model, Clean-up, Subtitles)
- [x] Voice-reactive animation while recording (an orb that moves with your voice, a ring for the target length)
- [x] Sidebar: nav scrolls on its own, GPU card is one compact row (details on Engines), name / settings / sign out
      always visible

## Planner redesign (round 4)
- [x] GPU card: compact row in the sidebar that opens the full view (memory, mode, engines, RAM, disk) in place
- [x] Board: Activity is a button top-right that opens a side panel (no longer a list at the bottom)
- [x] Content planner: platform rail with real logos and brand colours; format tabs per platform; the next 7 days as a
      strip (empty days invite a plan, drag a drop to another day to reschedule); momentum (shipped this week vs the
      weekly goal per format, streak, next drop); gallery shaped by format (tall Reels/Shorts/TikTok, wide videos,
      square posts, text cards for X with a 280 counter, audio for podcasts) grouped Up next / In the works / Ideas /
      Shipped; Pipeline and List views; a "New" menu by platform and format
- [x] Weekly goals per format and when each target went live (posted_at) are stored with the targets in R2
- [x] Redone minimal (round 5): no brand gradients; monochrome logos; platforms as a row of logo chips with format tabs
      under them; one-line stats; the week as a hairline timeline; neutral cards (logos · formats, title, two lines of
      words, stage dot, date); orange only for today and late

## Clarity + GPU round (round 7)
- [x] Recorder: pause / resume everywhere (`startRecording().pause()`; Your model also on **P**); time excludes pauses
- [x] Your model → Collect: takes and uploads queue up (listen, remove) and go as one batch; multi-file pick and drop;
      takes are dropped from the device only once the batch is stored, and come back if it fails
- [x] Dataset job: per-file errors skip the file, not the batch; clips cut at long silences; every clip levelled to
      -20 dB; stricter checks (SNR 28, echo, muffled) with SNR measured against the *recording's* noise floor (a clip of
      continuous talking used to read as noisy, which emptied whole batches: "no usable clips"); the error says why
- [x] Dataset job pipelined: download + denoise of the next file on a helper thread while the GPU transcribes, clip
      cutting on a CPU pool
- [x] Train: codec tokens cached per session; length-grouped batches sized to the card; best epoch by listening
      (Whisper turbo + WavLM vs the real take of each held-out sentence), scores shown on the page
- [x] Whisper large-v3-turbo by default, 30 s windows batched to the free VRAM
- [x] vLLM pool sized to the card (`config.vllm_pool_gb`), whole job handed to vLLM at once (64), `ORPHEUS_FP8=1`
      opt-in on Ada/Hopper; Qwen uses FlashAttention-2 when installed
- [x] Sentences loudness-matched before joining; myvoice clarity defaults (temp 0.5, rep 1.12); auto studio polish for
      myvoice kept only when it listens better
- [x] Your voice in Kokoro: `voicewalk` job + `kv_<name>` Kokoro voices (R2 `kvoices/`), Your model card 4, Voiceover picker
- [x] Voices page: the record button is a voiceprint (four palette strands that wake on hover), not a mic

## Notes for whoever picks this up
- Spaces are defined once in `mcp/lib/spaces.ts` (add a space there and it shows everywhere: sidebar, drawer, MCP enum).
- Platform logos, colours and format glyphs: `mcp/components/platform.tsx`. The Posts page is `mcp/components/Posts.tsx`; the drawer and its "Publish to" editor (`TargetsEditor`) are in `PostDrawer.tsx`.
- Targets refresh every 15 s (not Appwrite Realtime): `mcp/components/useTargets.ts`.
- Job tracking: `mcp/components/jobs.ts` (localStorage, `useResumeJob`), the tray `JobTray.tsx`; `api()` tracks every
  POST to `jobs` / `myvoices`. Saved recordings: `takes.ts` (IndexedDB); `startRecording(scope)` in `Recorder.tsx`.

## Viewer and players (2026-10-27)
- [x] File viewer for PDF, Word (.docx), Excel / ODS / CSV, Markdown, JSON, text, subtitles and code; slides (.pptx) download only
- [x] Video player with its own controls (byte-range streaming, buffered bar, speed, PiP, fullscreen, double-tap skip, resume) and an audio stage with the waveform
- [x] Uploads: up to 6 small files at once; the next file starts while the last one is recorded
- [ ] Adaptive streaming (HLS renditions made on the worker) for long uploaded videos on slow connections
- [ ] Slides (.pptx) preview
- [x] The video player takes the video's own shape (vertical Shorts stay tall); photos always fit the screen and open from a screen-sized copy

## Publishing and autopilot (2026-10-27, docs/PUBLISHING.md)
- [x] Connect YouTube channels (Google OAuth) and Instagram Creator/Business accounts (Instagram Login); tokens sealed in R2, Instagram's refreshed automatically
- [x] Composer on each target: every YouTube option (title, description, tags, category, visibility, playlist, language, license, recording date, made for kids, synthetic-content disclosure, embedding, stats, notify, thumbnail) and every Instagram one (caption, carousel up to 20, cover or frame, share to feed, collaborators, tags, trial reels, audio name, alt text, AI label, location, first comment), with a live preview
- [x] Publish now, or set to go at the target's publish time; YouTube uploads early and goes public on the minute
- [x] Resumable YouTube uploads in 32 MB pieces across runs; Instagram containers polled until ready
- [x] Autopilot (every 10 min): starts due posts, carries on unfinished ones, retries with backoff, marks posts Posted with the link, phone push
- [x] Rules: cross-post (live on A → B, N hours later), posting slots, caption footers, default first comment, YouTube defaults
- [x] MCP tools: `publish_accounts`, `publish_post`, `publish_status`, `automation_rules`
- [ ] Pass YouTube's API audit so uploads can go public straight away (until then they stay private)
- [x] Analytics back from YouTube and Instagram on each post (the Analytics page and the `analytics` MCP tool)
- [ ] TikTok (needs its own audit), X (paid API) and LinkedIn publishing; they're hand-offs for now

## Polish round (2026-10-28)
- [x] Premium line icons back (Phosphor duotone), each with its own springy hover move; the soft fill fades in on hover
- [x] YouTube and Instagram drawn as their own marks (the red play tile, the camera glyph on a solid tile)
- [x] Five pixel characters to pick as your profile picture (Nova, Byte, Miso, Boo, Fen), saved to your account
- [x] Custom cursor: Studio (crisp arrow), ASCII (1-bit bitmaps) or System, in Settings → Profile → Look
- [x] Fast loading: every page paints from the last copy (memory, localStorage, IndexedDB for the report and live
      numbers) and swaps in the fresh one; skeletons only show after 180 ms; signing out clears the copies
- [x] Charts: one bright accent, draw-in lines, an end marker, a hover band with the value on the axis, growing bars
- [x] Each video in depth: daily views, watch hours, likes and subs; against your usual for its format; devices,
      countries, subscribers vs not, search terms, playback, sharing, age and gender for that one video

## Next up (agreed with the owner, after the polish round)
- [ ] Trend radar: rising keywords, topics and hashtags (YouTube, Google Trends, Reddit, news), filtered to your niches;
      rising vs fading, how hard each is to rank for, gaps your rivals haven't covered; one click to a new post idea
- [ ] Watcher feeds (World Monitor style): your sources, keywords and cadence; a Cloudflare timer fetches only matches,
      scores and keeps them, alerts on spikes. Fetches only hosts on an allow-list (no internal addresses)
- [ ] All of it over MCP: set preferences, list trends and keywords, check a keyword, turn a trend into a post
- [ ] Security: per-route rate limits, a nonce Content-Security-Policy, an audit log of sign-ins and MCP calls in
      Settings → Security, rotating upload keys
- [ ] Title and thumbnail ideas from your best performers, a hook score on scripts, a weekly digest

## Later (not started)
- [ ] Listen to a few of the cut training clips per session on Your model (the worker would push samples next to the zip)
- [ ] Per-target caption overrides (X 280 vs Instagram 2200)
- [ ] Teach trained voices non-verbal tags (laughs, breaths) from the recordings
- [x] Streaming playback while a voiceover renders: Voiceover shows the latest run as one take (the whole voiceover joined, like ElevenLabs); while it is made it plays by itself, every line in order as the worker makes it (each line's first take, joined and mastered on the CPU beside the generation), for every engine including your trained voice and studio polish. The per-line view is gone from the page. Not yet timed on a GPU
- [ ] Speech super-resolution model (beyond Resemble Enhance) as the polish step; A/B with benchmark_voices
- [ ] Add newer open TTS engines as benchmark candidates (e.g. Higgs Audio, VoxCPM, IndexTTS2) and let the scores pick
- [ ] Full Kokoro / StyleTTS2 fine-tune on your clips (beyond the voicewalk mix)
- [ ] Other cloud storage on the Files page, kept in sync: Google Drive first, then Dropbox, OneDrive, Box (OAuth APIs) and
  S3 / Backblaze B2 (keys). Each shows as its own folder of cards (previews from the service's thumbnails); dragging a
  file in or out copies it across. A scheduled check reads each service's change feed every few minutes and applies new,
  renamed and deleted files both ways; a file changed on both sides keeps both copies. Needs an app registration per
  service (Google's review for Drive access takes longest) and chunked copies for big videos

## Inference (plan in docs/INFERENCE.md; one PR per step, measured on a real GPU, behind a flag)
- [ ] 1. Baseline benchmark script (`scripts/bench_voice.py`) and numbers on L4 and A100 (script and L4 numbers done 2026-10-26; A100 still to run)
- [x] 2. Compile the SNAC codec (`torch.compile` + CUDA graphs, batched decode): measured, not adopted. The codec is ~5% of a job (1.2 s of 26 s on L4) and compiling costs ~1 min per cold load; built behind `VOICEBOX_COMPILE_CODEC`, left off
- [x] 3. Batch the review (Whisper + voice match for all takes at once); best-of-4 ≈ best-of-1 time (L4: review ~10× faster, Orpheus best-of-4 1.6× best-of-1). Follow-up: Qwen batches sized to the card (16 on an L4, was 8): Qwen best-of-4 91.8 → 64.5 s, same scores
- [x] 4. Use the whole big card (≥ 70 GB): bigger vLLM pool, review models kept resident. Review models resident (every card): on, L4 26.7 s → 16.1 s with Whisper unloaded. Bigger pool (`VOICEBOX_WHOLE_CARD`, 48 GB / 256 sequences on 80 GB): built, off until an 80 GB card can be measured
- [x] 5. Stream the first audio (per-line job events; Lines view plays line 1 while the rest generate): L4, line 1 in ≤ 9.4 s (Orpheus best-of-1, was 15.7 s) and ≤ 13 s (Qwen best-of-4, was the whole job); delivered by the job poll, not SSE; per-chunk streaming inside a line still open
- [x] 5b. Speculative decoding for Orpheus (n-gram first, then a small draft; vLLM `speculative_config`): built behind `VOICEBOX_SPEC`; n-gram measured slower on L4 (one request 54 → 51 tokens/s, 10 lines 17.6 → 25.6 s), left off. EAGLE head trained on our own Orpheus outputs (gpu train_draft): learned (28.7% top-1) but only ~17% of guesses accepted, so it measured slower everywhere (one request 55 → 38 tokens/s) and its gate kept it off
- [x] 6. Faster cold start (cache tools on the runtime, tunnel in parallel, register early): online ~110 s → ~68 s on a fresh L4; app starts skip Colab Secrets (51 s of timeouts, re-measure on the next fresh start); voice engines prefetched to disk after a start (`VOICEBOX_PREFETCH`, pauses for jobs)
- [x] 7. TensorRT-LLM for Orpheus: only if 1-6 aren't enough. Looked at, not built: per-GPU engine builds on every fresh Colab machine, and it mostly buys many-stream throughput; one request's speed is the gap, which a trained 5b proposer targets on the vLLM path
- [x] Trained voice made a voiceover one chunk at a time (flow): chains of up to 4 lines side by side, each chunk starts the moment its predecessor finishes (`VOICEBOX_FLOW_CHAIN`, `VOICEBOX_FLOW_STREAM`): 37 lines generating 1041 → 189 s on the L4, same scores. Polish and subtitles (~200 s together) are now the rest
- [x] Faster loads: your voice preloads at start (first voiceover 0 s loading, was ~184 s cold); vLLM compiled kernels and all voice weights kept in R2 per GPU (load 184 -> 62 s with kernels); high-RAM machines park instead of stop. Fresh-runtime pull from R2 still to measure
- [x] Studio polish on AP-BWE: 5.4 s vs Resemble's 89.4 s on 37 lines, kept on 37/37 lines (Resemble 11/37), same voice; polish check fixed (torchaudio)
- [ ] CosyVoice 2: added and measured (same speed as Qwen here, one line at a time); a batched or vLLM path would be needed to make it faster


## Reliability audit (2026-10-26)
Weak points that could fail a job or leave the worker stuck, found reading the worker and dashboard, fixed in #63:
- [x] Engines heal themselves: after a fatal GPU error (illegal memory access, device-side assert, cuBLAS, dead vLLM core) the engine exits instead of failing every later call while showing ready; GPU memory is freed after any failed call; a call whose engine died is retried once on a fresh engine; a dead engine's leftover processes (vLLM's EngineCore) are killed before it starts again
- [x] A hung engine no longer holds the GPU queue for an hour: voice batches time out at 10x their expected time (at least 15 min) and the engine is restarted
- [x] A hung gateway is restarted by the launcher (10 min without answering, 30 while a job runs), with its engines
- [x] Finished jobs' files are pruned (12 h, 1 h when the disk is short): long sessions used to fill the disk
- [x] Engine switching can't get stuck "busy" (the in-flight count is now thread-safe); queued and running jobs are never evicted from the job table
- [x] Qwen halves a batch that runs out of GPU memory instead of failing every line in it
- [x] myvoice shares Orpheus's weights (was a second 6.7 GB download on every fresh runtime)
- [x] Studio polish no longer makes mastering serial (a 19-line voiceover spent 76 s "mastering")
- [x] Downloads take http(s) links only; the usage file is written atomically
- [x] The dashboard says "the worker isn't reachable" instead of quoting Cloudflare's HTML, and retries reads (never resends a job that may have arrived)
- [x] A runtime whose worker died entirely (kernel crash) no longer bills until Colab reclaims it: a sweep every 10 min (GitHub Actions, `sweep.yml`; Vercel Hobby cron is daily only) and every GPU card load stop an app-started runtime with no heartbeat for 20 min. Needs the `WORKER_SECRET` repo secret
