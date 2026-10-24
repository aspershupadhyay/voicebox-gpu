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
import json, os
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


def token_budget(text, params):
    if params.get("max_new_tokens"):
        return int(params["max_new_tokens"])
    est_seconds = max(2.0, len(text) / 11.0)  # generous: slow, dramatic reads run ~11 chars/s
    return int(min(8000, est_seconds * TOKENS_PER_SEC * 1.5 + 300))


def has_bf16():
    """Real bfloat16 (Ampere and newer). torch reports emulated support on a T4, which vLLM refuses."""
    return torch.cuda.is_available() and torch.cuda.get_device_capability(0)[0] >= 8


def fp8_ok():
    """ORPHEUS_FP8=1 on a GPU with fp8 tensor cores (L4, RTX 40xx, H100: compute 8.9+). Off by default: 8-bit weights
    are faster but can cost a little clarity, so turn it on, run benchmark_voices, and keep it if the scores hold."""
    return (os.environ.get("ORPHEUS_FP8", "0") == "1" and torch.cuda.is_available()
            and torch.cuda.get_device_capability(0) >= (8, 9))


class Engine:
    def __init__(self):
        from snac import SNAC
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to(self.dev)
        self.snac.train(False)
        self.mode = "transformers"
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
                          max_model_len=8192, enable_prefix_caching=True, max_num_seqs=64, **lora)
                if fp8_ok():  # Ada / Hopper: 8-bit weights, half the memory traffic, ~1.5x the tokens a second
                    try:
                        self.llm = LLM(quantization="fp8", **kw)
                        print("[orpheus] fp8 weights", flush=True)
                    except Exception as e:  # noqa: BLE001  e.g. this vLLM can't mix fp8 with LoRA: plain weights then
                        print(f"[orpheus] fp8 unavailable ({type(e).__name__}: {e}); 16-bit weights", flush=True)
                        torch.cuda.empty_cache()
                        self.llm = LLM(**kw)
                else:
                    self.llm = LLM(**kw)
                if LORA:
                    from vllm.lora.request import LoRARequest
                    self.lora_req = LoRARequest("myvoice", 1, LORA)
                self.tok = self.llm.get_tokenizer()
                self.mode = "vllm"
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

    def _decode(self, gen):
        gen = self._codes(gen)
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
        codes = [torch.tensor(x).unsqueeze(0).clamp(0, 4095).to(self.dev) for x in (l1, l2, l3)]
        with torch.no_grad():
            audio = self.snac.decode(codes)
        return audio.squeeze().float().cpu().numpy(), 24000

    # ── generation
    def synth_batch(self, items):
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
        results = self.llm.generate(prompts, sps, use_tqdm=False, lora_request=lora)
        for j, r in zip(ok, results):
            gen = r.outputs[0].token_ids
            try:
                outs[j] = self._decode(gen)
                self._remember(items[j], gen)
            except Exception as e:  # noqa: BLE001
                outs[j] = e

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
