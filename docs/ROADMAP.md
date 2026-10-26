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

## Later (not started)
- [ ] Listen to a few of the cut training clips per session on Your model (the worker would push samples next to the zip)
- [ ] Per-target caption overrides (X 280 vs Instagram 2200)
- [ ] Teach trained voices non-verbal tags (laughs, breaths) from the recordings
- [ ] Streaming playback while a voiceover renders
- [ ] Speech super-resolution model (beyond Resemble Enhance) as the polish step; A/B with benchmark_voices
- [ ] Add newer open TTS engines as benchmark candidates (e.g. Higgs Audio, VoxCPM, IndexTTS2) and let the scores pick
- [ ] Full Kokoro / StyleTTS2 fine-tune on your clips (beyond the voicewalk mix)

## Inference (plan in docs/INFERENCE.md; one PR per step, measured on a real GPU, behind a flag)
- [ ] 1. Baseline benchmark script (`scripts/bench_voice.py`) and numbers on L4 and A100 (script and L4 numbers done 2026-10-26; A100 still to run)
- [ ] 2. Compile the SNAC codec (`torch.compile` + CUDA graphs, batched decode)
- [x] 3. Batch the review (Whisper + voice match for all takes at once); best-of-4 ≈ best-of-1 time (L4: review ~10× faster, Orpheus best-of-4 1.6× best-of-1; Qwen's takes still voiced one batch at a time)
- [ ] 4. Use the whole big card (≥ 70 GB): bigger vLLM pool, review models kept resident
- [ ] 5. Stream the first audio (per-line job events; Lines view plays line 1 while the rest generate)
- [ ] 5b. Speculative decoding for Orpheus (n-gram first, then a small draft; vLLM `speculative_config`)
- [ ] 6. Faster cold start (cache tools on the runtime, tunnel in parallel, register early)
- [ ] 7. TensorRT-LLM for Orpheus: only if 1-6 aren't enough

