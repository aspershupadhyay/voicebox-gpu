"""LTX-2.5 22B distilled (Lightricks): video with synchronised audio, 8 steps, unguided.

Lightricks/LTX-2.5-Diffusers is gated (accept the license on Hugging Face once; the worker needs HF_TOKEN) and
needs diffusers from main. Only the files the distilled pipeline loads are fetched (~71 GB of the 174 GB repo). On 40 GB+ cards everything runs in
bf16 with model CPU offload (one component on the GPU at a time); on smaller cards the transformer and the
Gemma 4 text encoder are quantised to 4-bit NF4 while loading.

quality "fast": one distilled pass at the chosen size. "full": the official two-stage recipe — the same pass,
a x2 latent upsample, then a 3-sigma refine at double resolution (text-to-video only; with a start frame it
falls back to one pass so the frame isn't redrawn).
"""
import gc, os
import torch

from engines._video import RESIDENT, TILE_VAE, Progress, encode_mp4, load_image

REPO = os.environ.get("LTX_MODEL", "Lightricks/LTX-2.5-Diffusers")
# The repo is 174 GB: it holds the transformer twice (4- and 8-shard copies), a non-distilled transformer_full,
# a prompt enhancer, a LoRA and a diffusion decoder we don't use. Fetch only what the distilled pipeline loads (~71 GB).
NEEDED = ["model_index.json", "scheduler/*", "tokenizer/*", "text_encoder/*", "vae/*", "audio_vae/*", "vocoder/*",
          "latent_upsampler/*", "transformer/config.json", "transformer/diffusion_pytorch_model.safetensors.index.json",
          "transformer/diffusion_pytorch_model-*-of-00004.safetensors", "connectors/config.json",
          "connectors/diffusion_pytorch_model.safetensors.index.json", "connectors/diffusion_pytorch_model-*-of-00002.safetensors"]


def _prune(local):
    """Delete files of this repo already on disk that the pipeline doesn't load (an earlier full download), plus
    interrupted partial downloads, BEFORE fetching: otherwise they hold the space the missing files need."""
    import fnmatch
    freed = 0
    for root, _, files in os.walk(local):
        for f in files:
            link = os.path.join(root, f)
            if not any(fnmatch.fnmatch(os.path.relpath(link, local), pat) for pat in NEEDED):
                blob = os.path.realpath(link)
                if os.path.exists(blob):
                    freed += os.path.getsize(blob)
                    os.remove(blob)
                os.remove(link)
    blobs = os.path.join(os.path.dirname(os.path.dirname(local)), "blobs")
    for f in os.listdir(blobs) if os.path.isdir(blobs) else []:
        if f.endswith(".incomplete"):
            freed += os.path.getsize(os.path.join(blobs, f))
            os.remove(os.path.join(blobs, f))
    if freed:
        print(f"[ltx] removed {freed / 1e9:.1f} GB of unused or partial files from an earlier download", flush=True)


def _fetch():
    from huggingface_hub import snapshot_download
    _prune(snapshot_download(REPO, allow_patterns=["model_index.json"]))  # tiny call: just locates the snapshot folder
    return snapshot_download(REPO, allow_patterns=NEEDED)

# distilled LTX runs unguided: CFG, STG and modality guidance all off (the pipeline defaults are the SFT values)
UNGUIDED = dict(guidance_scale=1.0, audio_guidance_scale=1.0, stg_scale=0.0, audio_stg_scale=0.0,
                modality_scale=1.0, audio_modality_scale=1.0)



class Engine:
    def __init__(self):
        from diffusers import LTX2Pipeline
        from diffusers.pipelines.ltx2.utils import DEFAULT_NEGATIVE_PROMPT, DISTILLED_SIGMA_VALUES, STAGE_2_DISTILLED_SIGMA_VALUES
        kw = {}
        if not RESIDENT:
            from diffusers.quantizers import PipelineQuantizationConfig
            kw["quantization_config"] = PipelineQuantizationConfig(
                quant_backend="bitsandbytes_4bit", components_to_quantize=["transformer", "text_encoder"],
                quant_kwargs={"load_in_4bit": True, "bnb_4bit_quant_type": "nf4", "bnb_4bit_compute_dtype": torch.bfloat16})
        self.local = _fetch()
        t2v = LTX2Pipeline.from_pretrained(self.local, dtype=torch.bfloat16, prompt_enhancer=None, processor=None, duration_head=None, **kw)
        if TILE_VAE:
            t2v.vae.enable_tiling()
        self.sigmas, self.sigmas2, self.negative = DISTILLED_SIGMA_VALUES, STAGE_2_DISTILLED_SIGMA_VALUES, DEFAULT_NEGATIVE_PROMPT
        self.pipes, self.active, self.upsample = {"t2v": t2v}, None, None
        self._pipe(False)

    def _pipe(self, i2v):
        """t2v and i2v share every module; only the active one carries the CPU-offload hooks."""
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

    def _upsampler(self):
        if self.upsample is None:
            from diffusers import LTX2LatentUpsamplePipeline
            from diffusers.pipelines.ltx2.latent_upsampler import LTX2LatentUpsamplerModel
            up = LTX2LatentUpsamplerModel.from_pretrained(self.local, subfolder="latent_upsampler", dtype=torch.bfloat16).to("cuda")
            self.upsample = LTX2LatentUpsamplePipeline(vae=self.pipes["t2v"].vae, latent_upsampler=up)
        return self.upsample

    def video(self, req):
        w, h, n, fps = int(req["width"]), int(req["height"]), int(req["num_frames"]), float(req["fps"])
        i2v = bool(req.get("image_path"))
        two_stage = req.get("quality") == "full" and not i2v
        s1, s2 = len(self.sigmas), len(self.sigmas2)
        prog = Progress(req.get("progress_path"), s1 + (s2 if two_stage else 0))
        prog.write("encoding prompt")
        pipe = self._pipe(i2v)
        gen = torch.Generator("cuda").manual_seed(int(req.get("seed", 7)))
        shared = dict(prompt=req["prompt"], negative_prompt=req.get("negative") or self.negative, frame_rate=fps,
                      generator=gen, return_dict=False, **UNGUIDED)
        if i2v:
            shared["image"] = load_image(req["image_path"], w, h)
        with torch.inference_mode():
            if not two_stage:
                video, audio = pipe(width=w, height=h, num_frames=n, sigmas=self.sigmas, output_type="np",
                                    callback_on_step_end=prog.callback(), **shared)
            else:
                lat, audio_lat = pipe(width=w, height=h, num_frames=n, sigmas=self.sigmas, output_type="latent",
                                      callback_on_step_end=prog.callback(), **shared)
                lat = self._upsampler()(latents=lat, output_type="latent", return_dict=False)[0]
                video, audio = pipe(num_frames=n, sigmas=self.sigmas2, latents=lat, audio_latents=audio_lat,
                                    noise_scale=self.sigmas2[0], output_type="np", callback_on_step_end=prog.callback(s1), **shared)
        prog.write("encoding video", prog.total)
        au = None
        if audio is not None and req.get("audio", True):
            au = audio[0].float().cpu().numpy()
        info = encode_mp4(video[0], fps, req["out_path"], audio=au, audio_sr=pipe.vocoder.config.output_sampling_rate)
        del video, audio
        gc.collect(); torch.cuda.empty_cache()
        return info
