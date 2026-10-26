"""Orpheus 3B (Canopy Labs) + the SNAC 24 kHz codec.

Runs on vLLM when available: every chunk of a job is generated in one continuous batch, which is
several times faster than token-by-token transformers. Falls back to transformers if vLLM can't start.
The token budget is sized from the text (Orpheus emits ~86 codec tokens per second of speech), so
there's no fixed length cap; the gateway also splits long text into sentence chunks.
On a GPU without bfloat16 (the free Colab T4) it runs in float16, so vLLM still starts there.

Trained voices (engines/myvoice.py): LoRA adapters on top of the same model, chosen per chunk, so two people's models
are served by one engine.

Flow (trained voices whose adapter was trained for it: voicebox.json "context"): a chunk is generated with the chunk
before it (its text and the audio just made for it) as the previous turn, so pitch, pace and energy carry on from one
sentence into the next instead of resetting at every chunk. Chunks of one line then run in waves (first chunks of every
line together, then the second ones...), still batched across lines.
"""
import json, os, time
from collections import OrderedDict
import torch

MODEL = os.environ.get("ORPHEUS_MODEL", "unsloth/orpheus-3b-0.1-ft")  # ungated mirror of canopylabs/orpheus-3b-0.1-ft
LORA = os.environ.get("ORPHEUS_LORA")  # the default LoRA adapter dir on top of MODEL (see engines/myvoice.py)
MULTI_LORA = bool(os.environ.get("ORPHEUS_ENABLE_LORA"))  # adapters chosen per chunk (engines/myvoice.py)
LORA_RANK = 64  # train.py's rank; the largest an adapter may have
START, END_TEXT, END_HUMAN, START_AUDIO, END_AUDIO, CODE_OFFSET = 128259, 128009, 128260, 128257, 128258, 128266
TOKENS_PER_SEC = 86
START_AI = 128261
END_AI = 128262
CTX_MAX = 1800  # longest previous chunk (codec tokens, ~20 s) used as context; train.py trains with the same bound
# INFERENCE.md step 2 (gateway passes config.COMPILE_CODEC): fold SNAC's weight norm into plain weights (exact), compile it
# for any length, and decode a wave's chunks together, sorted by length, instead of one at a time.
COMPILE_CODEC = os.environ.get("VOICEBOX_COMPILE_CODEC", "0") == "1"
CODEC_BATCH_S = 60  # most audio (padded) one batched decode makes: bounds its memory next to vLLM
SAMPLES_PER_FRAME = 2048  # SNAC 24 kHz: one level-1 code (7 Orpheus tokens) = 2048 samples
# INFERENCE.md step 5 (gateway passes config.STREAM): hand back each chunk the moment vLLM finishes it (synth_batch's
# emit), so the gateway can play the first line while the rest are still generating. Same batch, same sampling.
STREAM = os.environ.get("VOICEBOX_STREAM", "0") == "1"
# INFERENCE.md step 5b (gateway passes config.SPEC): speculative decoding. A cheap proposer guesses the next few codec
# tokens and Orpheus checks them all in one forward pass, so a step can move several tokens instead of one. Rejection
# sampling keeps the output distribution the same. "ngram" proposes from repeats earlier in the sequence (no extra model);
# "<method>:<model>" (e.g. "eagle:/path/to/head", "draft:org/model") uses a trained proposer that shares the vocabulary.
SPEC = os.environ.get("VOICEBOX_SPEC", "0")
SPEC_TOKENS = int(os.environ.get("VOICEBOX_SPEC_TOKENS", "4"))


def spec_config():
    """vLLM's speculative_config for SPEC, or None for plain decoding. "auto": the EAGLE draft a train job measured
    faster on this worker (eagle/current.json, written by the gateway's eagle job), if there is one."""
    global SPEC, SPEC_TOKENS
    if SPEC == "auto":
        if LORA or MULTI_LORA:  # trained voices (myvoice): the draft learned base Orpheus, and LoRA + drafts is fragile
            return None
        try:
            cur = json.load(open(os.path.join(os.environ.get("VOICEBOX_HOME", "/content/voicebox"), "eagle", "current.json")))
            if not os.path.isfile(os.path.join(cur["path"], "config.json")):
                return None
            SPEC, SPEC_TOKENS = f"eagle:{cur['path']}", int(cur.get("k") or SPEC_TOKENS)
        except (OSError, ValueError, KeyError):
            return None
    if SPEC in ("", "0", "off"):
        return None
    if SPEC == "ngram":
        return {"method": "ngram", "num_speculative_tokens": SPEC_TOKENS, "prompt_lookup_max": 4, "prompt_lookup_min": 2}
    method, _, model = SPEC.partition(":")
    return {"method": method, "model": model, "num_speculative_tokens": SPEC_TOKENS}


def token_budget(text, params):
    if params.get("max_new_tokens"):
        return int(params["max_new_tokens"])
    est_seconds = max(2.0, len(text) / 11.0)  # generous: slow, dramatic reads run ~11 chars/s
    return int(min(8000, est_seconds * TOKENS_PER_SEC * 1.5 + 300))


def has_bf16():
    """Real bfloat16 (Ampere and newer). torch reports emulated support on a T4, which vLLM refuses."""
    return torch.cuda.is_available() and torch.cuda.get_device_capability(0)[0] >= 8


def fp8_ok():
    """8-bit weights: half the memory traffic per generated token, which is what bounds Orpheus's speed. On by default
    on Ampere and newer (A100, L4, A10, H100: vLLM runs fp8 natively from compute 8.9, weight-only on 8.0-8.6); ORPHEUS_FP8=0
    turns it off. If this vLLM can't start fp8 (e.g. with LoRA adapters) the engine falls back to 16-bit by itself."""
    return (os.environ.get("ORPHEUS_FP8", "1") == "1" and torch.cuda.is_available()
            and torch.cuda.get_device_capability(0) >= (8, 0))


class Engine:
    def __init__(self):
        from snac import SNAC
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to(self.dev)
        self.snac.train(False)
        self.codec_s = 0.0  # time spent decoding codes to audio in the last synth_batch (reported to the job)
        self.gen_tokens, self.gen_s = 0, 0.0  # codec tokens vLLM made in the last synth_batch, and its seconds (codec excluded)
        self.codec_batch = COMPILE_CODEC and self.dev == "cuda"
        if self.codec_batch:
            self._fast_codec()
        self.mode = "transformers"
        self.spec = None  # the speculative decoding actually running (SPEC, if this vLLM took it)
        self.lora_req = None
        if self.dev == "cuda" and os.environ.get("ORPHEUS_BACKEND", "vllm") == "vllm":
            try:
                from vllm import LLM
                total = torch.cuda.get_device_properties(0).total_memory / 2**30
                util = min(0.9, float(os.environ.get("ORPHEUS_VRAM_GB", "9")) / total)
                lora = {}
                if LORA or MULTI_LORA:
                    rank = int(json.load(open(os.path.join(LORA, "adapter_config.json"))).get("r", LORA_RANK)) if LORA else LORA_RANK
                    lora = {"enable_lora": True, "max_lora_rank": max(16, rank, LORA_RANK if MULTI_LORA else 0), "max_loras": 2 if MULTI_LORA else 1}
                kw = dict(model=MODEL, dtype="bfloat16" if has_bf16() else "float16", gpu_memory_utilization=util,
                          max_model_len=8192, enable_prefix_caching=True, max_num_seqs=int(os.environ.get("ORPHEUS_MAX_SEQS", "64")), **lora)

                spec = spec_config()

                def build(**q):
                    """Sleep mode lets the gateway park this engine in RAM (llm.sleep) when another model needs the GPU,
                    and wake it in seconds instead of a cold start; without it, parking falls back to stopping.
                    Speculative decoding the same way: if this vLLM can't start it with these settings, plain decoding."""
                    nonlocal spec
                    if spec:
                        try:
                            return build_plain(speculative_config=spec, **q)
                        except Exception as e:  # noqa: BLE001
                            print(f"[orpheus] speculative decoding unavailable ({type(e).__name__}: {e})", flush=True)
                            spec = None
                            torch.cuda.empty_cache()
                    return build_plain(**q)

                def build_plain(**q):
                    if os.environ.get("ORPHEUS_SLEEP", "1") != "0":
                        try:
                            return LLM(enable_sleep_mode=True, **q, **kw)
                        except Exception as e:  # noqa: BLE001
                            print(f"[orpheus] sleep mode unavailable ({type(e).__name__}: {e})", flush=True)
                            torch.cuda.empty_cache()
                    return LLM(**q, **kw)
                if fp8_ok():  # Ada / Hopper: 8-bit weights, half the memory traffic, ~1.5x the tokens a second
                    try:
                        self.llm = build(quantization="fp8")
                        print("[orpheus] fp8 weights", flush=True)
                    except Exception as e:  # noqa: BLE001  e.g. this vLLM can't mix fp8 with LoRA: plain weights then
                        print(f"[orpheus] fp8 unavailable ({type(e).__name__}: {e}); 16-bit weights", flush=True)
                        torch.cuda.empty_cache()
                        self.llm = build()
                else:
                    self.llm = build()
                if LORA:
                    from vllm.lora.request import LoRARequest
                    self.lora_req = LoRARequest("myvoice", 1, LORA)
                self.tok = self.llm.get_tokenizer()
                self.mode = "vllm"
                self.spec = SPEC if spec else None
                if spec:
                    print(f"[orpheus] speculative decoding: {SPEC}, {SPEC_TOKENS} tokens a step", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[orpheus] vLLM unavailable ({type(e).__name__}: {e}); using transformers", flush=True)
        if self.mode == "transformers":
            from transformers import AutoTokenizer, AutoModelForCausalLM
            dtype = torch.bfloat16 if has_bf16() else torch.float16
            self.tok = AutoTokenizer.from_pretrained(MODEL)
            self.model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=dtype).to(self.dev)
            if LORA and not MULTI_LORA:
                from peft import PeftModel
                self.model = PeftModel.from_pretrained(self.model, LORA).merge_and_unload()
            self.model.train(False)
        self.recent = OrderedDict()  # chunk key -> (spoken text, codec tokens): the context for the chunk after it
        print(f"[orpheus] backend: {self.mode}", flush=True)

    # ── hooks a trained voice (engines/myvoice.py) overrides
    def _flows(self, item):
        """Was this chunk's model trained to carry on from the previous chunk?"""
        return False

    def _lora(self, item):
        """The vLLM LoRA request for this chunk (None = the base model)."""
        return self.lora_req

    def _activate(self, item):
        """transformers backend: switch to this chunk's adapter."""

    # ── prompts
    def _prompt(self, text, voice):
        ids = self.tok(f"{voice or 'tara'}: {text}").input_ids
        return [START, *ids, END_TEXT, END_HUMAN]

    def _context(self, item):
        """The previous turn for this item, as prompt tokens, or [] (flow off, first chunk, or not in memory)."""
        p = item.get("params") or {}
        if not self._flows(item) or p.get("flow") is False:
            return []
        for key in item.get("ctx") or []:
            hit = self.recent.get(key)
            if hit and len(hit[1]) <= CTX_MAX:
                return self._prompt(hit[0], item.get("voice")) + [START_AI, START_AUDIO, *hit[1], END_AUDIO, END_AI]
        return []

    def _remember(self, item, gen):
        if not item.get("key"):
            return
        self.recent[item["key"]] = (item["text"], self._codes(gen))
        self.recent.move_to_end(item["key"])
        while len(self.recent) > 256:
            self.recent.popitem(last=False)

    @staticmethod
    def _codes(gen):
        gen = list(gen)
        if START_AUDIO in gen:
            gen = gen[len(gen) - gen[::-1].index(START_AUDIO):]
        gen = [t for t in gen if t != END_AUDIO and t >= CODE_OFFSET]
        return gen[: (len(gen) // 7) * 7]

    @staticmethod
    def _levels(gen):
        """Orpheus tokens -> SNAC's three code levels (n, 2n and 4n codes for n frames of 7 tokens)."""
        gen = Engine._codes(gen)
        n = len(gen)
        if n == 0:
            raise RuntimeError("Orpheus produced no audio tokens")
        c = [t - CODE_OFFSET for t in gen[:n]]
        l1, l2, l3 = [], [], []
        for i in range(n // 7):
            b = 7 * i
            l1.append(c[b]); l2.append(c[b + 1] - 4096)
            l3.append(c[b + 2] - 2 * 4096); l3.append(c[b + 3] - 3 * 4096)
            l2.append(c[b + 4] - 4 * 4096)
            l3.append(c[b + 5] - 5 * 4096); l3.append(c[b + 6] - 6 * 4096)
        return [torch.tensor(x).clamp(0, 4095) for x in (l1, l2, l3)]

    def _decode(self, gen):
        codes = [x.unsqueeze(0).to(self.dev) for x in self._levels(gen)]
        with torch.no_grad():
            audio = self.snac.decode(codes)
        return audio.squeeze().float().cpu().numpy(), 24000

    def _fast_codec(self):
        """Fold the weight norm (the same weights, computed once instead of on every call), compile the decoder for any
        length and batch, and warm it so the first job doesn't pay for compiling. Eager if this torch can't compile."""
        from torch.nn.utils import parametrize
        t = time.time()
        for mod in self.snac.decoder.modules():
            if parametrize.is_parametrized(mod, "weight"):
                parametrize.remove_parametrizations(mod, "weight", leave_parametrized=True)
        try:
            self.snac.decoder = torch.compile(self.snac.decoder, dynamic=True)
            for b, n in ((2, 24), (3, 40), (1, 31)):  # varied batch and length: one dynamic graph covers them all
                codes = [torch.zeros(b, n * 2 ** k, dtype=torch.long, device=self.dev) for k in range(3)]
                with torch.inference_mode():
                    self.snac.decode(codes)
            print(f"[orpheus] codec compiled in {time.time() - t:.0f} s", flush=True)
        except Exception as e:  # noqa: BLE001  the folded eager decoder still batches
            self.snac.decoder = getattr(self.snac.decoder, "_orig_mod", self.snac.decoder)
            print(f"[orpheus] codec compile unavailable ({type(e).__name__}: {e}); eager", flush=True)

    def _decode_many(self, gens):
        """Decode many chunks in a few batched calls: sorted by length so little is padded, each batch capped at
        CODEC_BATCH_S of audio, each chunk trimmed back to its own length. Padding repeats the last code; it only
        touches the last ~0.2 s, less than SNAC's own noise changes between two decodes of the same codes."""
        out = [None] * len(gens)
        lv = []
        for j, g in enumerate(gens):
            try:
                lv.append((j, self._levels(g)))
            except Exception as e:  # noqa: BLE001
                out[j] = e
        lv.sort(key=lambda x: len(x[1][0]))
        cap = CODEC_BATCH_S * 24000 // SAMPLES_PER_FRAME
        i = 0
        while i < len(lv):
            k = i + 1
            while k < len(lv) and len(lv[k][1][0]) * (k + 1 - i) <= cap:  # the longest (last) sets the padded length
                k += 1
            group, i = lv[i:k], k
            n = len(group[-1][1][0])
            codes = [torch.stack([torch.cat([x[1][d], x[1][d][-1:].repeat(n * 2 ** d - len(x[1][d]))]) for x in group]).to(self.dev)
                     for d in range(3)]
            try:
                with torch.inference_mode():
                    audio = self.snac.decode(codes)[:, 0].float().cpu().numpy()
                for r, (j, x) in enumerate(group):
                    out[j] = (audio[r, : len(x[0]) * SAMPLES_PER_FRAME], 24000)
            except torch.cuda.OutOfMemoryError:  # vLLM left less room than planned: one at a time, never fail
                torch.cuda.empty_cache()
                for j, x in group:
                    with torch.inference_mode():
                        out[j] = (self.snac.decode([y.unsqueeze(0).to(self.dev) for y in x])[0, 0].float().cpu().numpy(), 24000)
        return out

    # ── generation
    def synth_batch(self, items, emit=None):
        """emit(j, audio): called for each chunk as soon as it's ready (step 5); the return value has them all too."""
        self.codec_s = 0.0
        self.gen_tokens, self.gen_s = 0, 0.0
        self.emit = emit if STREAM else None
        outs = [None] * len(items)
        made = {it.get("key") for it in items if it.get("key")}
        todo = list(range(len(items)))
        while todo:
            # a chunk waits while the chunk it follows is still to be made in this batch; everything else goes now
            done_keys = {items[j].get("key") for j in range(len(items)) if outs[j] is not None}
            wave = [j for j in todo if not (self._flows(items[j]) and any(k in made and k not in done_keys for k in (items[j].get("ctx") or [])[:1]))]
            wave = wave or todo
            if self.mode == "vllm":
                self._vllm_wave(items, wave, outs)
            else:
                for j in wave:
                    try:
                        outs[j] = self._hf(items[j])
                    except Exception as e:  # noqa: BLE001
                        outs[j] = e
            todo = [j for j in todo if j not in wave]
        return outs

    def _vllm_wave(self, items, wave, outs):
        from vllm import SamplingParams
        prompts, sps, loras, ok = [], [], [], []
        for j in wave:
            it = items[j]
            p = it.get("params") or {}
            try:
                loras.append(self._lora(it))
            except Exception as e:  # noqa: BLE001  e.g. no trained model for this voice
                outs[j] = e
                continue
            ok.append(j)
            prompts.append({"prompt_token_ids": self._context(it) + self._prompt(it["text"], it.get("voice"))})
            sps.append(SamplingParams(temperature=float(p.get("temperature", 0.6)), top_p=float(p.get("top_p", 0.95)),
                                      repetition_penalty=float(p.get("repetition_penalty", 1.1)),
                                      max_tokens=token_budget(it["text"], p), stop_token_ids=[END_AUDIO],
                                      seed=int(p.get("seed", 7))))
        if not ok:
            return
        lora = loras if any(loras) else None
        t0, c0 = time.time(), self.codec_s
        if self.emit and self._vllm_stream(items, ok, prompts, sps, loras, outs):
            self.gen_s += time.time() - t0 - (self.codec_s - c0)
            return
        results = self.llm.generate(prompts, sps, use_tqdm=False, lora_request=lora)
        gens = [r.outputs[0].token_ids for r in results]
        self.gen_s += time.time() - t0
        self.gen_tokens += sum(len(g) for g in gens)
        t = time.time()
        if self.codec_batch:
            for j, g, a in zip(ok, gens, self._decode_many(gens)):
                outs[j] = a
                if not isinstance(a, Exception):
                    self._remember(items[j], g)
        else:
            for j, gen in zip(ok, gens):
                try:
                    outs[j] = self._decode(gen)
                    self._remember(items[j], gen)
                except Exception as e:  # noqa: BLE001
                    outs[j] = e
        self.codec_s += time.time() - t

    def _vllm_stream(self, items, ok, prompts, sps, loras, outs):
        """The loop LLM.generate runs inside, driven here so each chunk is decoded and handed on (emit) the moment it
        finishes instead of when the whole batch does. False (and nothing queued) if this vLLM doesn't offer it."""
        eng = getattr(self.llm, "llm_engine", None)
        if eng is None or not all(hasattr(eng, a) for a in ("add_request", "step", "has_unfinished_requests")):
            return False
        ids = {}
        try:
            from vllm.sampling_params import RequestOutputKind  # as LLM.generate: only the finished output, not every step's
            for sp in sps:
                sp.output_kind = RequestOutputKind.FINAL_ONLY
        except ImportError:
            pass
        try:
            for j, pr, sp, lr in zip(ok, prompts, sps, loras):
                rid = f"vb{j}-{time.time_ns()}"
                eng.add_request(rid, pr, sp, lora_request=lr)
                ids[rid] = j
        except Exception as e:  # noqa: BLE001  an engine API this code doesn't know: take back what was queued
            print(f"[orpheus] streaming unavailable ({type(e).__name__}: {e}); whole batch at once", flush=True)
            if ids and hasattr(eng, "abort_request"):
                eng.abort_request(list(ids))
            return False
        while eng.has_unfinished_requests():
            for r in eng.step():
                if not r.finished or r.request_id not in ids:
                    continue
                j, gen = ids.pop(r.request_id), r.outputs[0].token_ids
                self.gen_tokens += len(gen)
                t = time.time()
                try:
                    outs[j] = self._decode(gen)
                    self._remember(items[j], gen)
                except Exception as e:  # noqa: BLE001
                    outs[j] = e
                self.codec_s += time.time() - t
                if not isinstance(outs[j], Exception):
                    self.emit(j, outs[j])
        return True

    def _hf(self, item):
        p = item.get("params") or {}
        self._activate(item)
        torch.manual_seed(int(p.get("seed", 7)))
        ids = torch.tensor([self._context(item) + self._prompt(item["text"], item.get("voice"))]).to(self.dev)
        with torch.no_grad():
            out = self.model.generate(ids, attention_mask=torch.ones_like(ids), do_sample=True,
                                      max_new_tokens=token_budget(item["text"], p), temperature=float(p.get("temperature", 0.6)),
                                      top_p=float(p.get("top_p", 0.95)), repetition_penalty=float(p.get("repetition_penalty", 1.1)),
                                      eos_token_id=END_AUDIO)
        gen = out[0][ids.shape[1]:].tolist()
        audio = self._decode(gen)
        self._remember(item, gen)
        return audio

    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        out = self.synth_batch([{"text": text, "voice": voice, "params": params}])[0]
        if isinstance(out, Exception):
            raise out
        return out
