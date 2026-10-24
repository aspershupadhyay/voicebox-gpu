"""Qwen3-TTS 1.7B Base (Alibaba, Apache-2.0): zero-shot voice cloning from a short reference + its transcript.

The clone prompt (speaker embedding + reference codes) is built once per reference file and reused, so a
long script in the same voice only pays for that once. Without a transcript it falls back to the
speaker embedding alone (x-vector mode), which is a little less faithful.
"""
import os
import torch

MODEL = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")


class Engine:
    def __init__(self):
        from qwen_tts import Qwen3TTSModel
        dev = "cuda:0" if torch.cuda.is_available() else "cpu"
        bf16 = dev != "cpu" and torch.cuda.get_device_capability(0)[0] >= 8
        attn = "sdpa"
        if bf16:
            try:  # FlashAttention-2 on Ampere+ when it's installed: faster batches, less memory per take
                import flash_attn  # noqa: F401
                attn = "flash_attention_2"
            except ImportError:
                pass
        dtype = torch.bfloat16 if dev != "cpu" else torch.float32
        self.model = Qwen3TTSModel.from_pretrained(MODEL, device_map=dev, dtype=dtype, attn_implementation=attn)
        self.prompts = {}  # (ref_path, mtime, has_text) -> clone prompt

    def _prompt(self, ref_path, ref_text):
        key = (ref_path, os.path.getmtime(ref_path), bool(ref_text))
        if key not in self.prompts:
            self.prompts = {k: v for k, v in self.prompts.items() if k[0] != ref_path}
            self.prompts[key] = self.model.create_voice_clone_prompt(
                ref_audio=ref_path, ref_text=ref_text or None, x_vector_only_mode=not ref_text)
        return self.prompts[key]

    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        if not ref_path:
            raise ValueError("qwen clones a reference voice: pick a recording (or the female/male presets)")
        return self.synth_batch([{"text": text, "params": params, "ref_path": ref_path, "ref_text": ref_text}])[0]

    def synth_batch(self, items):
        """All items of one call share a reference (the gateway sends one voice per job), so they run as one batch."""
        out = []
        groups = {}
        for i, it in enumerate(items):
            groups.setdefault((it["ref_path"], it.get("ref_text")), []).append(i)
        res = [None] * len(items)
        for (ref, rtext), idx in groups.items():
            p = items[idx[0]]["params"]
            torch.manual_seed(int(p.get("seed", 7)))
            try:
                wavs, sr = self.model.generate_voice_clone(
                    text=[items[i]["text"] for i in idx], language=[p.get("language") or "English"] * len(idx),
                    voice_clone_prompt=self._prompt(ref, rtext), do_sample=True,
                    temperature=float(p.get("temperature", 0.8)), top_p=float(p.get("top_p", 0.95)),
                    max_new_tokens=4096)
                for i, w in zip(idx, wavs):
                    res[i] = (w.astype("float32") if hasattr(w, "astype") else w, sr)
            except Exception as e:  # noqa: BLE001
                for i in idx:
                    res[i] = e
            finally:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
        out.extend(res)
        return out
