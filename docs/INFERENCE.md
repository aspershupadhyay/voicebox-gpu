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

| Step | Card | Time to first audio | 10 lines, best-of-1 | 10 lines, best-of-4 | Peak VRAM | Match / voice |
|---|---|---|---|---|---|---|
| Baseline | | | | | | |

## Sources

- Baseten, Inference Engineering, TTS models: https://www.baseten.co/inference-engineering/book/06-modalities/tts-models/
- Baseten, Orpheus TTS on TensorRT-LLM: https://www.baseten.co/blog/canopy-labs-selects-baseten-as-preferred-inference-provider-for-orpheus-tts-model/
- AI Engineer talk, optimizing inference for voice models: https://ai.engineer/talks/optimizing-inference-for-voice-models-in-production
- TensorRT-LLM, torch.compile and piecewise CUDA graphs: https://nvidia.github.io/TensorRT-LLM/1.3.0rc18/features/torch_compile_and_piecewise_cuda_graph.html
