"""Dia 1.6B (Nari Labs). Speaks as [S1]; clones a voice from a reference clip + its transcript."""
import inspect
import numpy as np
import torch

SR = 44100


class Engine:
    def __init__(self):
        from dia.model import Dia
        dtype = "float16" if torch.cuda.is_available() else "float32"
        self.model = Dia.from_pretrained("nari-labs/Dia-1.6B-0626", compute_dtype=dtype)
        self.accepts = set(inspect.signature(self.model.generate).parameters)

    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        torch.manual_seed(int(params.get("seed", 7)))
        line = text if text.lstrip().startswith("[S") else f"[S1] {text}"
        prompt = line
        if ref_path:
            if not ref_text:
                raise ValueError("Dia needs the reference transcript to clone a voice")
            prompt = (ref_text if ref_text.lstrip().startswith("[S") else f"[S1] {ref_text}") + " " + line
        kw = {"audio_prompt": ref_path, "use_torch_compile": False, "verbose": False,
              "cfg_scale": params["cfg_scale"], "temperature": params["temperature"],
              "top_p": params["top_p"], "cfg_filter_top_k": params["cfg_filter_top_k"]}
        kw = {k: v for k, v in kw.items() if k in self.accepts and v is not None}
        audio = self.model.generate(prompt, **kw)
        if isinstance(audio, list):
            audio = audio[0]
        return np.asarray(audio, dtype=np.float32).squeeze(), SR
