"""Wan 2.2 TI2V 5B (Alibaba, Apache-2.0): text-to-video and image-to-video in one model, 720p at 24 fps.

quality "draft" = the 4-step Turbo distill decoded by the TAEHV tiny decoder (~1 s instead of ~25 s, a little softer);
"fast" = Turbo with the full VAE; "full" = the original transformer (CFG, ~30 steps).
Only one transformer is held at a time; the text encoder and VAE are shared. On 40 GB+ cards the whole pipeline stays
on the GPU; on a 24 GB L4 model CPU offload keeps one component on the GPU at a time.
Speed layer (engines._video.accelerate): SageAttention / Flash-Attention kernels + regional torch.compile, with fallback.
"""
import gc, os
import torch

from engines._video import RESIDENT, TILE_VAE, Progress, accelerate, encode_mp4, load_image, run_fast, tiny_decode, tiny_decoder

TURBO = os.environ.get("WAN_TURBO_MODEL", "yetter-ai/Wan2.2-TI2V-5B-Turbo-Diffusers")
FULL = os.environ.get("WAN_FULL_MODEL", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")


class Engine:
    def __init__(self):
        from diffusers import AutoencoderKLWan, UniPCMultistepScheduler, WanPipeline
        self.dtype = torch.bfloat16
        vae = AutoencoderKLWan.from_pretrained(TURBO, subfolder="vae", torch_dtype=torch.float32)  # fp32 VAE: cleaner decode
        t2v = WanPipeline.from_pretrained(TURBO, vae=vae, torch_dtype=self.dtype)
        t2v.scheduler = UniPCMultistepScheduler.from_config(t2v.scheduler.config, flow_shift=5.0)
        if TILE_VAE and hasattr(t2v.vae, "enable_tiling"):
            t2v.vae.enable_tiling()  # 121 frames of 720p would otherwise need ~20 GB to decode
        self.pipes, self.active, self.weights, self.tae = {"t2v": t2v}, None, "fast", None
        self.fast = accelerate(t2v.transformer)
        self._pipe(False)

    def _pipe(self, i2v):
        """t2v and i2v share every module; only the active one carries the CPU-offload hooks."""
        want = "i2v" if i2v else "t2v"
        if self.active != want:
            if not RESIDENT:
                for p in self.pipes.values():
                    p.remove_all_hooks()
            if want not in self.pipes:
                from diffusers import WanImageToVideoPipeline
                self.pipes[want] = WanImageToVideoPipeline.from_pipe(self.pipes["t2v"])
            if RESIDENT:
                self.pipes[want].to("cuda")
            else:
                self.pipes[want].enable_model_cpu_offload()
            self.active = want
        return self.pipes[want]

    def _use(self, weights):
        """weights: "fast" (Turbo transformer, also used by draft) or "full" (original transformer)."""
        if weights == self.weights:
            return
        from diffusers import WanTransformer3DModel
        if not RESIDENT:
            for p in self.pipes.values():
                p.remove_all_hooks()
        t2v = self.pipes["t2v"]
        t2v.transformer = None
        self.pipes, self.active = {"t2v": t2v}, None
        gc.collect(); torch.cuda.empty_cache()
        t2v.transformer = WanTransformer3DModel.from_pretrained(FULL if weights == "full" else TURBO, subfolder="transformer",
                                                               torch_dtype=self.dtype)
        self.fast = accelerate(t2v.transformer)
        self.weights = weights

    def video(self, req):
        quality = req.get("quality") or "fast"
        draft = quality == "draft"
        self._use("full" if quality == "full" else "fast")
        w, h, n, steps = int(req["width"]), int(req["height"]), int(req["num_frames"]), int(req["steps"])
        prog = Progress(req.get("progress_path"), steps)
        prog.write("encoding prompt")
        pipe = self._pipe(bool(req.get("image_path")))
        kw = dict(prompt=req["prompt"], negative_prompt=req.get("negative") or None, width=w, height=h, num_frames=n,
                  num_inference_steps=steps, guidance_scale=float(req["guidance"]),
                  generator=torch.Generator("cpu").manual_seed(int(req.get("seed", 7))),
                  output_type="latent" if draft else "np", callback_on_step_end=prog.callback())
        if req.get("image_path"):
            kw["image"] = load_image(req["image_path"], w, h)
        with torch.inference_mode():
            out = run_fast(lambda: pipe(**{**kw, "generator": torch.Generator("cpu").manual_seed(int(req.get("seed", 7)))}).frames, [pipe.transformer], self.fast)
        if draft:
            self.tae = self.tae or tiny_decoder("taew2_2_super")
            frames = tiny_decode(self.tae, out)
        else:
            frames = out[0]
        prog.write("encoding video", steps)
        info = encode_mp4(frames, int(req["fps"]), req["out_path"])
        del frames, out
        gc.collect(); torch.cuda.empty_cache()
        return info
