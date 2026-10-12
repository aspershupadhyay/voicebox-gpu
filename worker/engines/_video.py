"""Shared bits for the video engines: step progress, cancellation and MP4 encoding."""
import json, os, subprocess, tempfile, time

import numpy as np
import torch

# TF32 matmuls/convs: several times faster for the fp32 VAE decode on Ampere/Ada, no visible quality change.
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True

GPU_GB = torch.cuda.get_device_properties(0).total_memory / 1e9 if torch.cuda.is_available() else 0
# A100 / H100 class: keep the whole pipeline on the GPU (no per-call CPU<->GPU offload round-trips).
RESIDENT = GPU_GB >= 38
# 80 GB cards decode the whole clip in one pass; tiling (overlapping tiles) only pays off when memory is tight.
TILE_VAE = GPU_GB < 70

FAST = os.environ.get("VOICEBOX_FAST", "1") != "0"


def accelerate(*models, compile=True):
    """Speed layer for the diffusion transformer(s), all with automatic fallback:
    - attention: SageAttention 2 (prebuilt kernel from the Hub via `kernels`, ~1.3-2x faster attention on Ampere),
      else Flash-Attention 2 (also prebuilt), else PyTorch's own SDPA;
    - regional torch.compile of the repeated transformer blocks (compiles in ~1 min on the first render, then
      10-30% faster; a new resolution recompiles once).
    Returns what got switched on."""
    on = []
    if not FAST:
        return on
    for m in models:
        if m is None:
            continue
        for backend in ("sage_hub", "flash_hub"):
            try:
                m.set_attention_backend(backend)
                on.append(backend)
                break
            except Exception as e:
                print(f"[fast] {backend} unavailable: {str(e)[:160]}", flush=True)
        if compile:
            try:
                m.compile_repeated_blocks(fullgraph=False)
                on.append("compile")
            except Exception as e:
                print(f"[fast] regional compile unavailable: {str(e)[:160]}", flush=True)
    if on:
        print(f"[fast] on: {sorted(set(on))}", flush=True)
    return on


def plain(*models):
    """Undo accelerate(): default attention, no compiled blocks."""
    for m in models:
        if m is None:
            continue
        try:
            m.reset_attention_backend()
        except Exception:
            pass
        for sub in m.modules():
            if getattr(sub, "_compiled_call_impl", None) is not None:
                sub._compiled_call_impl = None


def run_fast(fn, models, fast):
    """Run a render; if it fails with the speed layer on (an attention kernel that can't handle this model's
    masks, a compile error...), switch it off for good and run once more the plain way."""
    try:
        return fn()
    except Cancelled:
        raise
    except Exception as e:
        if not fast or e.__class__.__name__ == "Cancelled":
            raise
        print(f"[fast] render failed with the speed layer on ({e.__class__.__name__}: {str(e)[:200]}); retrying plain",
              flush=True)
        plain(*models)
        fast.clear()
        import gc
        gc.collect(); torch.cuda.empty_cache()
        return fn()


TAEHV_SHA = "011dfc2112197741c540e0bdd5b7b67bcc930771"


def tiny_decoder(name):
    """TAEHV tiny video decoder (madebyollin/taehv, MIT; ~50x faster than the full VAE, slightly softer):
    "taew2_2_super" for Wan 2.2 5B latents, "taew2_1" for Wan 2.1-VAE models (Wan 2.2 14B). Pinned to a commit."""
    import urllib.request
    from engines._taehv import TAEHV
    folder = os.path.join(os.environ.get("HF_HOME", "/tmp"), "taehv")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{name}.safetensors")
    if not os.path.exists(path):
        urllib.request.urlretrieve(f"https://raw.githubusercontent.com/madebyollin/taehv/{TAEHV_SHA}/safetensors/{name}.safetensors", path + ".part")
        os.replace(path + ".part", path)
    return TAEHV(path, arch_name=name).to("cuda", torch.float16).eval()


def tiny_decode(tae, latents):
    """Diffusers' normalised video latents (N C T H W) -> list of HxWx3 float frames in [0, 1] (what encode_mp4 takes)."""
    with torch.inference_mode():
        x = tae.decode_video(latents.to("cuda", torch.float16).permute(0, 2, 1, 3, 4), parallel=True, show_progress_bar=False)
    return x[0].permute(0, 2, 3, 1).float().cpu().numpy()

class Cancelled(Exception):
    pass


class Progress:
    """Writes {phase, step, total} (phase: encoding prompt, denoising, decoding, encoding video) to a JSON file the gateway reads; a sibling `.cancel` file aborts the run."""

    def __init__(self, path, total):
        self.path, self.total, self.t0 = path, total, time.time()

    def write(self, phase, step=0):
        if not self.path:
            return
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"phase": phase, "step": step, "total": self.total, "t": round(time.time() - self.t0, 1)}, f)
        os.replace(tmp, self.path)
        if os.path.exists(self.path + ".cancel"):
            raise Cancelled("cancelled")

    def callback(self, offset=0):
        """offset: steps already done by an earlier stage (two-stage renders count both stages in one bar)."""
        def cb(pipe, i, t, kwargs):
            n = offset + i + 1
            self.write("decoding" if n >= self.total else "denoising", n)
            return kwargs
        return cb


def to_uint8(frames):
    """(F, H, W, 3) floats in [0, 1] (or PIL images) -> uint8 array."""
    if isinstance(frames, list) and frames and hasattr(frames[0], "size"):
        return np.stack([np.asarray(f.convert("RGB")) for f in frames])
    a = np.asarray(frames)
    if a.dtype != np.uint8:
        a = (np.clip(a, 0, 1) * 255).round().astype(np.uint8)
    return a


def encode_mp4(frames, fps, out_path, audio=None, audio_sr=None):
    """H.264 (yuv420p, faststart) via ffmpeg; muxes AAC audio when given (samples, ) or (channels, samples)."""
    a = to_uint8(frames)
    n, h, w = a.shape[:3]
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-"]
    wav = None
    if audio is not None and audio_sr:
        import soundfile as sf
        au = np.asarray(audio, dtype="float32")
        if au.ndim == 2 and au.shape[0] <= 8:  # (channels, samples) -> (samples, channels)
            au = au.T
        wav = tempfile.mktemp(suffix=".wav")
        sf.write(wav, au, int(audio_sr))
        cmd += ["-i", wav, "-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    p.stdin.write(a.tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg failed to encode the video")
    if wav:
        os.remove(wav)
    return {"frames": int(n), "width": int(w), "height": int(h), "fps": fps, "duration": round(n / fps, 3), "has_audio": wav is not None}


def load_image(path, width, height):
    """Open the source image and centre-crop it to the target aspect, then resize (no stretching)."""
    from PIL import Image
    im = Image.open(path).convert("RGB")
    tw, th = width, height
    scale = max(tw / im.width, th / im.height)
    im = im.resize((max(tw, round(im.width * scale)), max(th, round(im.height * scale))), Image.LANCZOS)
    left, top = (im.width - tw) // 2, (im.height - th) // 2
    return im.crop((left, top, left + tw, top + th))


def save_images(images, out_dir):
    """PIL images -> out_dir/image-<n>.png (keeps transparency) + a small JPEG thumbnail; returns their metadata."""
    os.makedirs(out_dir, exist_ok=True)
    out = []
    for i, im in enumerate(images, 1):
        name = f"image-{i}.png"
        im.save(os.path.join(out_dir, name), optimize=False)
        th = im.convert("RGB")
        th.thumbnail((512, 512))
        th.save(os.path.join(out_dir, f"thumb-{i}.jpg"), quality=85)
        out.append({"file": name, "thumb": f"thumb-{i}.jpg", "width": im.width, "height": im.height,
                    "transparent": im.mode in ("RGBA", "LA")})
    return out
