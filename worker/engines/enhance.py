"""Resemble Enhance (Resemble AI, MIT): studio clean-up for speech recorded on a bad mic.

Two stages: a denoiser removes background noise and room echo, then a latent flow-matching enhancer restores the
detail a cheap mic or a phone loses (bandwidth extension to 44.1 kHz, fuller low end, clearer consonants).
Used for voice references (a better reference = a better clone), re-voice performances, the Studio clean-up tool,
and optionally on generated speech.

The PyPI package pins DeepSpeed and gradio for training and its demo; inference needs neither, so they are not
installed and DeepSpeed is stubbed before import. Weights come from the Hugging Face repo (one 1-file checkpoint)
into this engine's own cache instead of the package's git-lfs clone.
"""
import os
import sys
import types

import torch

REPO = os.environ.get("ENHANCE_REPO", "ResembleAI/resemble-enhance")


def _stub_deepspeed():
    """resemble_enhance imports deepspeed at module level in its training helpers; give it inert stand-ins."""
    try:
        import deepspeed  # noqa: F401
        return
    except ImportError:
        pass
    ds = types.ModuleType("deepspeed")
    ds.init_distributed = lambda *a, **k: None
    ds.DeepSpeedConfig = type("DeepSpeedConfig", (), {"__init__": lambda self, *a, **k: None})
    acc = types.ModuleType("deepspeed.accelerator")
    acc.get_accelerator = lambda: None
    rt = types.ModuleType("deepspeed.runtime")
    eng = types.ModuleType("deepspeed.runtime.engine")
    eng.DeepSpeedEngine = type("DeepSpeedEngine", (torch.nn.Module,), {})
    ut = types.ModuleType("deepspeed.runtime.utils")
    ut.clip_grad_norm_ = torch.nn.utils.clip_grad_norm_
    ds.accelerator, ds.runtime, rt.engine, rt.utils = acc, rt, eng, ut
    sys.modules.update({"deepspeed": ds, "deepspeed.accelerator": acc, "deepspeed.runtime": rt,
                        "deepspeed.runtime.engine": eng, "deepspeed.runtime.utils": ut})


class Engine:
    def __init__(self):
        _stub_deepspeed()
        from pathlib import Path
        from huggingface_hub import snapshot_download
        from resemble_enhance.enhancer.enhancer import Enhancer
        from resemble_enhance.enhancer.hparams import HParams
        from resemble_enhance.inference import inference
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        run_dir = Path(snapshot_download(REPO, allow_patterns=["enhancer_stage2/*"])) / "enhancer_stage2"
        hp = HParams.load(run_dir)
        model = Enhancer(hp)
        state = torch.load(run_dir / "ds" / "G" / "default" / "mp_rank_00_model_states.pt", map_location="cpu")["module"]
        model.load_state_dict(state)
        self.model = model.eval().to(self.dev)
        self._inference = inference

    @torch.inference_mode()
    def enhance(self, src_path, params):
        """-> (float32 mono audio, sample rate). params: mode "enhance" (denoise + restore, default) or "denoise"
        (noise only, keeps the original timbre exactly); strength 0-1 (how much the denoiser leads the restorer);
        steps (flow-matching steps, 16-128: more = finer detail, slower)."""
        import soundfile as sf
        a, sr = sf.read(src_path, dtype="float32", always_2d=False)
        if a.ndim > 1:
            a = a.mean(axis=1)
        dwav = torch.from_numpy(a)
        try:
            if params.get("mode") == "denoise":
                out, osr = self._inference(model=self.model.denoiser, dwav=dwav, sr=sr, device=self.dev)
            else:
                strength = float(params.get("strength", 0.6))
                self.model.configurate_(nfe=int(params.get("steps", 48)), solver="midpoint",
                                        lambd=max(0.0, min(1.0, strength)), tau=0.5)
                out, osr = self._inference(model=self.model, dwav=dwav, sr=sr, device=self.dev)
        finally:
            if self.dev == "cuda":
                torch.cuda.empty_cache()
        return out.float().cpu().numpy(), int(osr)

    @torch.inference_mode()
    def enhance_batch(self, items):
        """Studio polish for many files at once -> [(audio, sr) | Exception]. Clips up to 30 s (a voiceover's lines) of
        the same settings go through the model together, grouped by length and as many at once as the free memory
        takes: the model works on (batch, time) and normalises each clip on its own, and the padding at the end is
        trimmed off, so each comes out as it would alone. Anything else goes the one-file way."""
        import soundfile as sf
        import torch.nn.functional as F
        from torchaudio.functional import resample
        from resemble_enhance.inference import remove_weight_norm_recursively
        out = [None] * len(items)
        model, sr = self.model, self.model.hp.wav_rate
        remove_weight_norm_recursively(model)
        wavs = {}
        for j, it in enumerate(items):
            p = it.get("params") or {}
            if p.get("mode") == "denoise":
                continue
            a, isr = sf.read(it["src_path"], dtype="float32", always_2d=False)
            if a.ndim > 1:
                a = a.mean(axis=1)
            w = resample(torch.from_numpy(a), orig_freq=isr, new_freq=sr, lowpass_filter_width=64, rolloff=0.9475937167399596,
                         resampling_method="sinc_interp_kaiser", beta=14.769656459379492)
            if w.shape[-1] <= 30 * sr and w.numel():
                wavs[j] = w
        by_cfg = {}
        for j in wavs:
            p = items[j].get("params") or {}
            by_cfg.setdefault((int(p.get("steps", 48)), max(0.0, min(1.0, float(p.get("strength", 0.6))))), []).append(j)
        for (steps, lambd), js in by_cfg.items():
            model.configurate_(nfe=steps, solver="midpoint", lambd=lambd, tau=0.5)
            js.sort(key=lambda j: wavs[j].shape[-1])
            free = torch.cuda.mem_get_info()[0] / 2**30 if self.dev == "cuda" else 0
            bs = int(max(1, min(16, (free - 1.5) // 1.5))) if self.dev == "cuda" else 1
            k = 0
            while k < len(js):
                group = js[k:k + bs]
                try:
                    n = max(wavs[j].shape[-1] for j in group) + 441
                    peaks = [wavs[j].abs().max().clamp(min=1e-7) for j in group]
                    x = torch.stack([F.pad(wavs[j] / pk, (0, n - wavs[j].shape[-1])) for j, pk in zip(group, peaks)]).to(self.dev)
                    y = model(x).float().cpu()
                    for row, j, pk in zip(y, group, peaks):
                        out[j] = ((row[: wavs[j].shape[-1]] * pk).numpy(), sr)
                    k += len(group)
                except torch.cuda.OutOfMemoryError:
                    if bs == 1:
                        raise
                    bs = max(1, bs // 2)
                finally:
                    if self.dev == "cuda":
                        torch.cuda.empty_cache()
        for j, it in enumerate(items):  # denoise-only, long or empty files: the one-file way
            if out[j] is None:
                try:
                    out[j] = self.enhance(it["src_path"], it.get("params") or {})
                except Exception as e:  # noqa: BLE001
                    out[j] = e
        return out
