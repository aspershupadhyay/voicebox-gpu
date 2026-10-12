"""Z-Image-Turbo (Tongyi-MAI, Apache-2.0: commercial use OK): 6B text-to-image, 8 steps, no CFG, ~1-2 s per image on
an A100. Fits anywhere; stays on the GPU. Speed layer (engines._video.accelerate) with automatic fallback."""
import os
import torch

from engines._video import Progress, accelerate, free_gpu, lean_vae, run_fast, save_images

REPO = os.environ.get("ZIMAGE_MODEL", "Tongyi-MAI/Z-Image-Turbo")


class Engine:
    def __init__(self):
        from diffusers import ZImagePipeline
        self.pipe = ZImagePipeline.from_pretrained(REPO, torch_dtype=torch.bfloat16).to("cuda")
        lean_vae(self.pipe.vae)
        self.fast = accelerate(self.pipe.transformer)

    def image(self, req):
        w, h, steps, n = int(req["width"]), int(req["height"]), int(req["steps"]), max(1, min(4, int(req.get("count", 1))))
        seed = int(req.get("seed", 7))
        prog = Progress(req.get("progress_path"), steps)
        prog.write("encoding prompt")

        def render():
            return self.pipe(prompt=req["prompt"], negative_prompt=req.get("negative") or None, width=w, height=h,
                             num_inference_steps=steps + 1,  # Z-Image counts the final sigma: 9 here = 8 DiT forwards
                             guidance_scale=0.0, num_images_per_prompt=n,
                             generator=[torch.Generator("cuda").manual_seed(seed + i) for i in range(n)],
                             callback_on_step_end=prog.callback()).images

        try:
            with torch.inference_mode():
                images = run_fast(render, [self.pipe.transformer], self.fast)
            prog.write("encoding video", steps)
            return {"images": save_images(images, req["out_dir"])}
        finally:
            free_gpu()
