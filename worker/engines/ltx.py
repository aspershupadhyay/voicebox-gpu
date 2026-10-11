"""LTX-2.3 22B distilled (Lightricks): video with synchronised audio, 8 steps, CFG 1.

Fitted to a 24 GB L4: the transformer is quantised to 4-bit NF4 while loading, and the Gemma 3 12B text
encoder comes from a pre-quantised 4-bit copy (8 GB) instead of the repo's 48 GB fp32 one, so the first
download is ~48 GB instead of ~100 GB. Model CPU offload keeps one component on the GPU at a time.
"""
import gc, os
import torch

from engines._video import Progress, encode_mp4, load_image

REPO = os.environ.get("LTX_MODEL", "diffusers/LTX-2.3-Distilled-Diffusers")
TEXT_ENCODER = os.environ.get("LTX_TEXT_ENCODER", "unsloth/gemma-3-12b-it-bnb-4bit")  # "repo" = use the repo's own


class Engine:
    def __init__(self):
        from diffusers import BitsAndBytesConfig, LTX2Pipeline, LTX2VideoTransformer3DModel
        from huggingface_hub import snapshot_download
        own_te = TEXT_ENCODER == "repo"
        local = snapshot_download(REPO, ignore_patterns=[] if own_te else ["text_encoder/*"])
        q4 = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16)
        transformer = LTX2VideoTransformer3DModel.from_pretrained(local, subfolder="transformer", quantization_config=q4,
                                                                  torch_dtype=torch.bfloat16)
        extra = {}
        if not own_te:
            from transformers import Gemma3ForConditionalGeneration
            extra["text_encoder"] = Gemma3ForConditionalGeneration.from_pretrained(TEXT_ENCODER, torch_dtype=torch.bfloat16)
        t2v = LTX2Pipeline.from_pretrained(local, transformer=transformer, torch_dtype=torch.bfloat16, **extra)
        t2v.vae.enable_tiling()
        from diffusers.pipelines.ltx2.utils import DEFAULT_NEGATIVE_PROMPT, DISTILLED_SIGMA_VALUES
        self.sigmas, self.negative = DISTILLED_SIGMA_VALUES, DEFAULT_NEGATIVE_PROMPT
        self.pipes, self.active = {"t2v": t2v}, None
        self._pipe(False)

    def _pipe(self, i2v):
        want = "i2v" if i2v else "t2v"
        if self.active != want:
            for p in self.pipes.values():
                p.remove_all_hooks()
            if want not in self.pipes:
                from diffusers import LTX2ImageToVideoPipeline
                self.pipes[want] = LTX2ImageToVideoPipeline.from_pipe(self.pipes["t2v"])
            self.pipes[want].enable_model_cpu_offload()
            self.active = want
        return self.pipes[want]

    def video(self, req):
        w, h, n, steps = int(req["width"]), int(req["height"]), int(req["num_frames"]), len(self.sigmas)
        prog = Progress(req.get("progress_path"), steps)
        prog.write("encoding prompt")
        pipe = self._pipe(bool(req.get("image_path")))
        fps = float(req["fps"])
        kw = dict(prompt=req["prompt"], negative_prompt=req.get("negative") or self.negative, width=w, height=h,
                  num_frames=n, frame_rate=fps, num_inference_steps=steps, sigmas=self.sigmas, guidance_scale=1.0,
                  generator=torch.Generator("cpu").manual_seed(int(req.get("seed", 7))),
                  output_type="np", return_dict=False, callback_on_step_end=prog.callback())
        if req.get("image_path"):
            kw["image"] = load_image(req["image_path"], w, h)
        with torch.inference_mode():
            video, audio = pipe(**kw)
        prog.write("encoding video", steps)
        au = None
        if audio is not None and req.get("audio", True):
            au = audio[0].float().cpu().numpy()
        info = encode_mp4(video[0], fps, req["out_path"], audio=au, audio_sr=pipe.vocoder.config.output_sampling_rate)
        del video, audio
        gc.collect(); torch.cuda.empty_cache()
        return info
