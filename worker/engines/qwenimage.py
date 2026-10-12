"""Qwen-Image-2.1 (Alibaba Qwen, Qwen RESEARCH license: non-commercial only): 7B text-to-image + editing, native 2K,
reliable text rendering, up to 10 reference images, native transparent (RGBA) output.

quality "turbo" = Qwen-Image-2.1-Turbo (8 steps, its own saved schedule, prefix KV cache);
"quality" = the base Qwen-Image-2.1 transformer + scheduler (40 steps), swapped in on top of the Turbo pipeline (both
share the text encoder and VAE, so "quality" only adds the 14 GB transformer). Stays on the GPU (~33 GB).
"""
import gc, os
import torch

from engines._video import Progress, accelerate, run_fast, save_images

TURBO = os.environ.get("QWENIMAGE_TURBO_MODEL", "Qwen/Qwen-Image-2.1-Turbo")
BASE = os.environ.get("QWENIMAGE_MODEL", "Qwen/Qwen-Image-2.1")
TRANSPARENT_PREFIX = "This is an RGBA image with transparency. "
TRANSPARENT_SUFFIX = " The image has alpha channel and the background is transparent."


class Engine:
    def __init__(self):
        from diffusers import QwenImage21Pipeline
        self.pipe = QwenImage21Pipeline.from_pretrained(TURBO, torch_dtype=torch.bfloat16).to("cuda")
        self.turbo = (self.pipe.transformer, self.pipe.scheduler)
        self.base = None
        self.weights = "turbo"
        self.fast = accelerate(self.pipe.transformer)

    def _use(self, weights):
        if weights == self.weights:
            return
        if weights == "quality":
            if self.base is None:
                from diffusers import FlowMatchEulerDiscreteScheduler, QwenImage21Transformer2DModel
                t = QwenImage21Transformer2DModel.from_pretrained(BASE, subfolder="transformer", torch_dtype=torch.bfloat16)
                s = FlowMatchEulerDiscreteScheduler.from_pretrained(BASE, subfolder="scheduler")
                self.base = (t.to("cuda"), s)
                accelerate(t)
            self.pipe.transformer, self.pipe.scheduler = self.base
        else:
            self.pipe.transformer, self.pipe.scheduler = self.turbo
        self.weights = weights
        gc.collect(); torch.cuda.empty_cache()

    def image(self, req):
        quality = req.get("quality") or "turbo"
        self._use("quality" if quality == "quality" else "turbo")
        w, h, steps, n = int(req["width"]), int(req["height"]), int(req["steps"]), max(1, min(4, int(req.get("count", 1))))
        seed = int(req.get("seed", 7))
        prompt = req["prompt"]
        if req.get("transparent"):
            prompt = TRANSPARENT_PREFIX + prompt.rstrip(".") + "." + TRANSPARENT_SUFFIX
        refs = []
        if req.get("image_paths"):
            from PIL import Image
            refs = [Image.open(p).convert("RGBA") for p in req["image_paths"]]
        prog = Progress(req.get("progress_path"), steps)
        prog.write("encoding prompt")

        def render():
            kw = dict(prompt=prompt, negative_prompt=req.get("negative") or None, width=w, height=h,
                      num_images_per_prompt=n, generator=[torch.Generator("cpu").manual_seed(seed + i) for i in range(n)],
                      callback_on_step_end=prog.callback(), use_kv_cache=True)
            if self.weights == "quality":
                kw["num_inference_steps"] = steps  # turbo uses its saved 8-step schedule instead
            if refs:
                kw["image"] = refs if len(refs) > 1 else refs[0]
            return self.pipe(**kw).images

        with torch.inference_mode():
            images = run_fast(render, [self.pipe.transformer], self.fast)
        prog.write("encoding video", steps)
        out = save_images(images, req["out_dir"])
        del images
        gc.collect(); torch.cuda.empty_cache()
        return {"images": out}
