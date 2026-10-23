"""Orpheus 3B (Canopy Labs) + the SNAC 24 kHz codec.

Runs on vLLM when available: every chunk of a job is generated in one continuous batch, which is
several times faster than token-by-token transformers. Falls back to transformers if vLLM can't start.
The token budget is sized from the text (Orpheus emits ~86 codec tokens per second of speech), so
there's no fixed length cap; the gateway also splits long text into sentence chunks.
"""
import json, os
import torch

MODEL = os.environ.get("ORPHEUS_MODEL", "unsloth/orpheus-3b-0.1-ft")  # ungated mirror of canopylabs/orpheus-3b-0.1-ft
LORA = os.environ.get("ORPHEUS_LORA")  # a LoRA adapter dir on top of MODEL (your trained voice, see engines/myvoice.py)
START, END_TEXT, END_HUMAN, START_AUDIO, END_AUDIO, CODE_OFFSET = 128259, 128009, 128260, 128257, 128258, 128266
TOKENS_PER_SEC = 86


def token_budget(text, params):
    if params.get("max_new_tokens"):
        return int(params["max_new_tokens"])
    est_seconds = max(2.0, len(text) / 11.0)  # generous: slow, dramatic reads run ~11 chars/s
    return int(min(8000, est_seconds * TOKENS_PER_SEC * 1.5 + 300))


class Engine:
    def __init__(self):
        from snac import SNAC
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to(self.dev)
        self.snac.train(False)
        self.mode = "transformers"
        if self.dev == "cuda" and os.environ.get("ORPHEUS_BACKEND", "vllm") == "vllm":
            try:
                from vllm import LLM
                total = torch.cuda.get_device_properties(0).total_memory / 2**30
                util = min(0.9, float(os.environ.get("ORPHEUS_VRAM_GB", "9")) / total)
                lora = {}
                if LORA:
                    rank = int(json.load(open(os.path.join(LORA, "adapter_config.json"))).get("r", 64))
                    lora = {"enable_lora": True, "max_lora_rank": max(16, rank), "max_loras": 1}
                self.llm = LLM(model=MODEL, dtype="bfloat16", gpu_memory_utilization=util, max_model_len=8192,
                               enable_prefix_caching=True, **lora)
                if LORA:
                    from vllm.lora.request import LoRARequest
                    self.lora_req = LoRARequest("myvoice", 1, LORA)
                self.tok = self.llm.get_tokenizer()
                self.mode = "vllm"
            except Exception as e:  # noqa: BLE001
                print(f"[orpheus] vLLM unavailable ({type(e).__name__}: {e}); using transformers", flush=True)
        if self.mode == "transformers":
            from transformers import AutoTokenizer, AutoModelForCausalLM
            dtype = torch.bfloat16 if self.dev == "cuda" and torch.cuda.is_bf16_supported() else torch.float16
            self.tok = AutoTokenizer.from_pretrained(MODEL)
            self.model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=dtype).to(self.dev)
            if LORA:
                from peft import PeftModel
                self.model = PeftModel.from_pretrained(self.model, LORA).merge_and_unload()
            self.model.train(False)
        print(f"[orpheus] backend: {self.mode}", flush=True)

    def _prompt(self, text, voice):
        ids = self.tok(f"{voice or 'tara'}: {text}").input_ids
        return [START, *ids, END_TEXT, END_HUMAN]

    def _decode(self, gen):
        gen = list(gen)
        if START_AUDIO in gen:
            gen = gen[len(gen) - gen[::-1].index(START_AUDIO):]
        gen = [t for t in gen if t != END_AUDIO and t >= CODE_OFFSET]
        n = (len(gen) // 7) * 7
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

    def synth_batch(self, items):
        if self.mode != "vllm":
            outs = []
            for it in items:
                try:
                    outs.append(self.synth(it["text"], it.get("voice"), it.get("params") or {}))
                except Exception as e:  # noqa: BLE001
                    outs.append(e)
            return outs
        from vllm import SamplingParams
        prompts, sps = [], []
        for it in items:
            p = it.get("params") or {}
            prompts.append({"prompt_token_ids": self._prompt(it["text"], it.get("voice"))})
            sps.append(SamplingParams(temperature=float(p.get("temperature", 0.6)), top_p=float(p.get("top_p", 0.95)),
                                      repetition_penalty=float(p.get("repetition_penalty", 1.1)),
                                      max_tokens=token_budget(it["text"], p), stop_token_ids=[END_AUDIO],
                                      seed=int(p.get("seed", 7))))
        results = self.llm.generate(prompts, sps, use_tqdm=False, lora_request=getattr(self, "lora_req", None))
        outs = []
        for r in results:
            try:
                outs.append(self._decode(r.outputs[0].token_ids))
            except Exception as e:  # noqa: BLE001
                outs.append(e)
        return outs

    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        if self.mode == "vllm":
            out = self.synth_batch([{"text": text, "voice": voice, "params": params}])[0]
            if isinstance(out, Exception):
                raise out
            return out
        torch.manual_seed(int(params.get("seed", 7)))
        ids = torch.tensor([self._prompt(text, voice)]).to(self.dev)
        with torch.no_grad():
            out = self.model.generate(ids, attention_mask=torch.ones_like(ids), do_sample=True,
                                      max_new_tokens=token_budget(text, params), temperature=params.get("temperature", 0.6),
                                      top_p=params.get("top_p", 0.95), repetition_penalty=params.get("repetition_penalty", 1.1),
                                      eos_token_id=END_AUDIO)
        return self._decode(out[0][ids.shape[1]:].tolist())
