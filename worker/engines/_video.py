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
