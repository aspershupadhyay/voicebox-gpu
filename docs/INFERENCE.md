# Inference plan: faster voice on big GPUs

Make the voice engines faster and cheaper without changing what they sound like. The goal for this studio is not
serving many users: it's a voiceover that starts playing almost at once, best-of-N quality at about the cost of one
take, and no waiting when you switch voice or engine. Written 2026-10-26; work through it in order, one PR per step,
and tick the boxes in `docs/ROADMAP.md` (section "Inference").

## Rules (read first)

- **Don't break what works.** Every step is behind a flag in `worker/config.py` (env override, e.g.
  `VOICEBOX_STREAM=0`), default on only after it's measured on a real GPU. The old path stays until the new one has
  run a full voiceover with review and subtitles.
- **Work on every card, best on 80 GB.** The owner can't get an H100 right now. Each step must run on L4 (24 GB) and
  A100 (40/80 GB); budgets come from the measured card (`config.vllm_pool_gb`, `vllm_max_seqs`), never a hardcoded
  GPU name. H100 is a bonus, not a requirement.
- **Measure before and after.** Use the same script on the same card and record the numbers in this file under
  "Results": time to first audio, wall time for a 10-line script at best-of-1 and best-of-4, GPU memory. The worker
  already logs per-engine rates (`/health` → `rates`, `loads`).
- **Same output.** Script match and voice match (the review's scores) must not drop. Compare a fixed script, fixed
  seeds, before and after.
- **No custom CUDA kernels.** The wins here are configuration, batching and compilation. Hand-written kernels break
  on every model update and gain the last 10-20% only at a scale this studio doesn't have.

## Where things stand (checked in the code)

- Orpheus runs on vLLM with continuous batching (`worker/engines/orpheus.py`), FP8 where the card supports it
  (`fp8_ok`), prefix caching on, `max_num_seqs` 64 (128 on a big pool).
- Best-of-N takes are already generated as one batch on vLLM: `gateway.py` (~line 1822) flattens every chunk x take
  into one list. What still scales with N is the review: Whisper and the voice match score every take.
- The SNAC codec (codes → audio) runs eagerly, chunk by chunk (`orpheus.py` ~line 170): no `torch.compile`, no
  CUDA graphs, no batching across chunks.
- The vLLM pool is capped at 30 GB even on an 80 GB card (`config.vllm_pool_gb`), so most of a big card sits idle.
- Idle models are parked in RAM and come back in seconds; nothing is kept resident just because there's room.
- Nothing streams: the dashboard gets audio only when a whole line (or job) is done.

## The plan, in order

### 1. Measure (baseline)
Add `scripts/bench_voice.py` (runs against a live worker through the dashboard API, like `scripts/make-samples.py`):
a fixed 10-line script, Orpheus and Qwen, best-of-1 and best-of-4, review on. Record time to first line, total wall
time, per-stage times from the job's progress, peak VRAM. Run it on L4 and on an A100; paste the numbers below.
Done: `scripts/bench_voice.py` (needs `MCP_TOKEN` in `.secrets.local`; `--label "step 2"` names the row, `--runs 3`
takes the median, every number lands in `bench/<date>-<gpu>.json`). L4 numbers are below; A100 still to run.

### 2. Compile the audio codec
In `orpheus.py`, wrap the SNAC decoder in `torch.inference_mode()` and `torch.compile(mode="reduce-overhead")`
(CUDA graphs), decode all chunks of a batch together (pad to the longest), and warm it once at load with the common
lengths. Same for the codecs of `myvoice` (shares the Orpheus path). Flag `VOICEBOX_COMPILE_CODEC`. Expected: the
fixed per-chunk overhead mostly gone; measurable on long scripts.

### 3. Batch the review
The review (Whisper + voice match + naturalness) should score all takes of all chunks in one or two batched calls,
not one per take. Whisper runs on `transformers` (`worker/engines/whisper.py`): pass all takes to its pipeline in one call with a
`batch_size` from the card's free memory (or try faster-whisper's batched pipeline if it measures faster). This is what makes best-of-4 cost about the same as best-of-1, since generation is already batched. Update the
dashboard's "N× slower" hint (Voiceover → Best of) to the measured cost.
Done (2026-10-26): `VOICEBOX_BATCH_REVIEW`, on by default. Whisper hears every take of a job in one text-only call
(the review never read the word timestamps it was asking for); clips over 30 s keep the word-timed path. The review is
about 10× faster on the L4 with identical scores (Results). Still open: Qwen voices takes one batch of lines at a time,
so its best-of-4 stays generation-bound (2.7× best-of-1); batching Qwen's takes is the follow-up.

### 4. Use the whole big card
On cards ≥ 70 GB: raise `vllm_pool_gb` (e.g. 45-50 GB) and `max_num_seqs`, and keep Whisper, the voice-match model
and the enhancer resident next to it instead of parking them, so a voiceover with review never loads anything
mid-job. Derive it from total VRAM, not the GPU name; keep the current numbers for smaller cards.

### 5. Stream the first audio
Let the worker push each line (then each chunk) as soon as it's mastered: a job event stream
(`GET /jobs/<id>/events`, server-sent events through the dashboard proxy, auth as today) and, in the Lines view, play
line 1 while the rest generate. Mastering (loudness) needs the whole line, so stream per line first; per-chunk
streaming with a fixed gain is a later option. Expected: first audio in about a second instead of after the whole job.

### 5b. Speculative decoding for Orpheus
Groq-style single-request speed on a GPU: a small draft guesses the next few audio tokens and Orpheus checks them all
in one forward pass, so each step moves 2-3 tokens instead of 1 (same output distribution, fewer memory reads per
token). vLLM supports it (`speculative_config`): try n-gram first (no extra model; audio codes repeat a lot), then a
small draft (EAGLE head or a ~150-500M model trained on our own Orpheus outputs). Flag `VOICEBOX_SPEC`. Measure tokens
per second for one request and the review scores; keep it only if the scores hold. Pairs with step 5: faster tokens
plus streaming is what makes it feel instant.

### 6. Faster cold start
The worker comes online in about 2 min (measured 2026-10-26 on an L4: ~90 s to the worker process, ~110 s online).
Cache the `uv` environment and `cloudflared` on the runtime disk between restarts, start the tunnel in parallel with
the gateway, and register as soon as the tunnel is up (engines load on first use anyway).

### 7. Later, only if needed
TensorRT-LLM for Orpheus (NVIDIA's engine; Baseten went from 7 to 16-24 real-time streams per H100 with it). Worth it
for many simultaneous users; for two people it's a heavy setup for a modest single-take gain. Revisit after 1-6.

## Results

Measured with `scripts/bench_voice.py` (fixed 10-line script, seed 7, style tech, review on, subtitles off, engine
warmed up first so loading isn't timed). Times are the worker's own (job start to finish). Peak VRAM is the whole card
while the job ran, so it includes whatever else was resident (Whisper, the enhancer).

| Step | Card | Time to first audio | 10 lines, best-of-1 | 10 lines, best-of-4 | Peak VRAM | Match / voice |
|---|---|---|---|---|---|---|
| Baseline · orpheus (tara) | L4 (22.5 GB) | 47.4 s | 47.4 s | 125.8 s | 18.2 GB | 0.993 / — (b1), 0.999 / — (b4) |
| Baseline · qwen (female) | L4 (22.5 GB) | 55.4 s | 55.4 s | 177.3 s | 11.4 GB | 0.999 / 0.949 (b1), 0.999 / 0.958 (b4) |
| Step 3 · orpheus (tara) | L4 (22.5 GB) | 15.7 s | 15.7 s | 25.2 s | 16.9 GB | 0.993 / — (b1), 0.999 / — (b4) |
| Step 3 · qwen (female) | L4 (22.5 GB) | 29.1 s | 29.1 s | 78.3 s | 10.9 GB | 0.999 / 0.949 (b1), 0.999 / 0.958 (b4) |
| Baseline · orpheus | A100 | | | | | |
| Baseline · qwen | A100 | | | | | |

Where the time went (seconds, L4, 2026-10-26, worker 3.3.0; about 40 s of audio per run):

| Case | Generating | Listening (review) | Mastering | Total | Job |
|---|---|---|---|---|---|
| orpheus best-of-1 | 20.1 | 26.0 | 1.2 | 47.4 | `a4e45fad30f8` |
| orpheus best-of-4 | 21.1 | 103.5 | 1.1 | 125.8 | `9195e6439d98` |
| qwen best-of-1 | 27.1 | 26.7 | 1.1 | 55.4 | `a7164fc66c97` |
| qwen best-of-4 | 70.5 | 105.6 | 1.1 | 177.3 | `a281da963b32` |

What the baseline says:

- **The review is the biggest stage, even at one take.** About 2.6 s per take (26 s for 10, 104 s for 40), on both
  engines, working through the takes four at a time. That's step 3, and it's worth more than the plan assumed: it
  speeds up best-of-1 too.
- **Orpheus generation is already batched**: 40 takes in 21 s, 10 in 20 s. With the review batched, Orpheus
  best-of-4 should land near best-of-1.
- **Qwen generation is not**: 2.6× longer for 4 takes (it runs two lines at a time, not on vLLM). Batching the review
  alone leaves Qwen best-of-4 at about 1.7× best-of-1; batching Qwen's takes is a follow-up to step 3.
- **First audio = the whole job.** Every line arrives together after mastering, so time to first audio equals the
  total (step 5).
- **Cold loads on a fresh runtime**: Orpheus 161 s (mostly the 7 GB download), Qwen 71 s. Step 6 territory.
- No sentence needed a retry in any run, so the review cost above is the floor, not inflated by re-voicing.

Step 3, batched review (L4, same runtime and script as the baseline, worker 3.3.0 + `VOICEBOX_BATCH_REVIEW`, the tech
style's temperatures pinned):

| Case | Generating | Listening (review) | Mastering | Total | Before | Job |
|---|---|---|---|---|---|---|
| orpheus best-of-1 | 11.7 | 2.7 | 1.3 | 15.7 | 47.4 | `7217c09fdc7a` |
| orpheus best-of-4 | 15.7 | 8.2 | 1.2 | 25.2 | 125.8 | `d10fe0b0d2c3` |
| qwen best-of-1 | 25.4 | 2.5 | 1.1 | 29.1 | 55.4 | `994034b27011` |
| qwen best-of-4 | 67.8 | 9.3 | 1.1 | 78.3 | 177.3 | `ea50ddb6bb93` |

- **Review 26 s → 2.6 s for 10 takes, 104 s → 9 s for 40**, on both engines.
- **Same output.** Qwen (its takes come out the same for the same seed): every one of the 40 takes scored exactly as before
  (match and voice match) and every line picked the same take. Orpheus best-of-1: the same scores line for line.
  Orpheus best-of-4: match 0.999 both times; two lines picked take 1 instead of 2 or 3 because take 1 came out better
  this time (vLLM sampling varies a little between runs), not because a score was read differently.
- Orpheus best-of-4 is now 1.6× best-of-1 (was 2.65×). Qwen best-of-4 is 2.7× (was 3.2×): its generation is the rest.
- Orpheus generating was also faster in this run (11.7 s vs 20.1 s) without any change to it; compare the review
  column, not the totals, for this step's effect on Orpheus.
- The benchmark runs taught the dashboard "learned" temperatures for these voices (Tara 0.7, Qwen female 0.9), which
  it adds to every job; `bench_voice.py` now pins the style's temperatures so runs stay comparable.

## Sources

- Baseten, Inference Engineering, TTS models: https://www.baseten.co/inference-engineering/book/06-modalities/tts-models/
- Baseten, Orpheus TTS on TensorRT-LLM: https://www.baseten.co/blog/canopy-labs-selects-baseten-as-preferred-inference-provider-for-orpheus-tts-model/
- AI Engineer talk, optimizing inference for voice models: https://ai.engineer/talks/optimizing-inference-for-voice-models-in-production
- TensorRT-LLM, torch.compile and piecewise CUDA graphs: https://nvidia.github.io/TensorRT-LLM/1.3.0rc18/features/torch_compile_and_piecewise_cuda_graph.html
