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

    def enhance_batch(self, items):
        """Studio polish for many files -> [(audio, sr) | Exception], one after another. Batching them through the
        model was measured slower on an L4 (37 lines: 107 s vs 88 s one at a time): its flow-matching steps already
        keep the GPU busy, and padding clips to a shared length only adds work."""
        out = []
        for it in items:
            try:
                out.append(self.enhance(it["src_path"], it.get("params") or {}))
            except Exception as e:  # noqa: BLE001
                out.append(e)
        return out
