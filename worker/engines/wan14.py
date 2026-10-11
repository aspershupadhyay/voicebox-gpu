"""Wan 2.2 I2V A14B (Alibaba, Apache-2.0) with the Lightx2v 4-step Lightning distill merged in, bf16:
magespace/Wan2.2-I2V-A14B-Lightning-Diffusers (~69 GB). Image-to-video only, 480p at 16 fps.

Two 14B experts take turns (`transformer` for the high-noise steps, `transformer_2` for the low-noise ones), so model
CPU offload keeps just the active one on the GPU (~30 GB peak): needs a 40 GB+ card.

Adult mode: an optional community LoRA (lopi999/Wan2.2-I2V_General-NSFW-LoRA, one file per expert, ~1.2 GB),
downloaded the first time it's asked for and then switched on or off per job without reloading anything.
"""
import gc, os
import torch

from engines._video import TILE_VAE, Progress, encode_mp4, load_image

REPO = os.environ.get("WAN14_MODEL", "magespace/Wan2.2-I2V-A14B-Lightning-Diffusers")
ADULT_REPO = os.environ.get("WAN14_ADULT_LORA", "lopi999/Wan2.2-I2V_General-NSFW-LoRA")
ADULT_FILES = ("NSFW-22-H-e8.safetensors", "NSFW-22-L-e8.safetensors")  # high-noise expert, low-noise expert
ADULT_TRIGGER = "nsfwsks"


class Engine:
    def __init__(self):
        from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
        vae = AutoencoderKLWan.from_pretrained(REPO, subfolder="vae", torch_dtype=torch.float32)  # fp32 VAE: cleaner decode
        self.pipe = WanImageToVideoPipeline.from_pretrained(REPO, vae=vae, torch_dtype=torch.bfloat16)
        if TILE_VAE:
            self.pipe.vae.enable_tiling()
        self.pipe.enable_model_cpu_offload()
        self.adult = None  # None: LoRA not loaded; then True/False for its current state

    def _set_adult(self, on):
        if self.adult is None:
            if not on:
                return
            from huggingface_hub import hf_hub_download
            high, low = (hf_hub_download(ADULT_REPO, f) for f in ADULT_FILES)
            self.pipe.remove_all_hooks()
            self.pipe.load_lora_weights(high, adapter_name="adult")
            self.pipe.load_lora_weights(low, adapter_name="adult", load_into_transformer_2=True)
            self.pipe.enable_model_cpu_offload()
            self.adult = True
            return
        if self.adult != on:
            for t in (self.pipe.transformer, self.pipe.transformer_2):
                t.enable_adapters() if on else t.disable_adapters()
            self.adult = on

    def video(self, req):
        if not req.get("image_path"):
            raise ValueError("Wan 2.2 14B is image-to-video only: give it a start frame")
        adult = bool(req.get("adult"))
        w, h, n, steps = int(req["width"]), int(req["height"]), int(req["num_frames"]), int(req["steps"])
        prog = Progress(req.get("progress_path"), steps)
        prog.write("encoding prompt")
        self._set_adult(adult)
        prompt = req["prompt"]
        if adult and ADULT_TRIGGER not in prompt:
            prompt = f"{ADULT_TRIGGER}, {prompt}"
        g = float(req["guidance"])
        kw = dict(image=load_image(req["image_path"], w, h), prompt=prompt, negative_prompt=req.get("negative") or None,
                  width=w, height=h, num_frames=n, num_inference_steps=steps, guidance_scale=g, guidance_scale_2=g,
                  generator=torch.Generator("cpu").manual_seed(int(req.get("seed", 7))),
                  output_type="np", callback_on_step_end=prog.callback())
        with torch.inference_mode():
            frames = self.pipe(**kw).frames[0]
        prog.write("encoding video", steps)
        info = encode_mp4(frames, int(req["fps"]), req["out_path"])
        del frames
        gc.collect(); torch.cuda.empty_cache()
        return info
