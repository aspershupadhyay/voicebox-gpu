"""Wan 2.2 Animate 14B (Alibaba, Apache-2.0): a character from ONE image performs the motion of a driving video
(an exercise, a dance, a gesture). Animation mode: the output is the character on its own background.

1. Preprocess with Alibaba's official pipeline (Wan2.2 repo, pinned commit): YOLOv10 person detection + ViTPose
   whole-body keypoints -> a skeleton "pose video" and a "face video" (face crops for expressions), optionally
   retargeted to the character's body proportions. SAM2 / FLUX-Kontext are only used by replacement mode and the
   FLUX retarget variant, so they're stubbed out instead of installed.
2. WanAnimatePipeline (diffusers) renders in 77-frame segments, each continuing from the previous one.

The diffusers checkpoint stores the 17B transformer in fp32 (69 GB on disk); it loads as bf16 (~35 GB) and stays on
the GPU on 70 GB+ cards (only the text encoder is offloaded).
"""
import gc, os, subprocess, sys, types, urllib.request
import torch

from engines._video import GPU_GB, Progress, accelerate, encode_mp4, run_fast

REPO = os.environ.get("ANIMATE_MODEL", "Wan-AI/Wan2.2-Animate-14B-Diffusers")
PREP_REPO = "Wan-AI/Wan2.2-Animate-14B"   # its process_checkpoint/ holds the detector + pose ONNX models
WAN_SHA = "1ea34ff48f87168174e12956e200b1d908b1c5ff"  # Wan-Video/Wan2.2 commit the preprocessing code is pinned to
PREP_FILES = ["process_pipepline.py", "pose2d.py", "pose2d_utils.py", "utils.py", "human_visualization.py", "retarget_pose.py"]
SEGMENT = 77


def _prep_class():
    """Fetch the official preprocessing code (pinned) and import ProcessPipeline with the SAM2 bits stubbed."""
    root = os.path.join(os.environ.get("HF_HOME", "/tmp"), f"wan-animate-preprocess-{WAN_SHA[:10]}")
    if not all(os.path.exists(os.path.join(root, f)) for f in PREP_FILES):
        os.makedirs(root, exist_ok=True)
        for f in PREP_FILES:
            url = f"https://raw.githubusercontent.com/Wan-Video/Wan2.2/{WAN_SHA}/wan/modules/animate/preprocess/{f}"
            urllib.request.urlretrieve(url, os.path.join(root, f + ".part"))
            os.replace(os.path.join(root, f + ".part"), os.path.join(root, f))
    for name in ("sam2", "sam2.modeling", "sam2.modeling.sam", "sam2.modeling.sam.transformer"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sam_utils = types.ModuleType("sam_utils")

    def _no_sam(*a, **k):
        raise RuntimeError("replacement mode (SAM2) isn't installed; animation mode only")
    sam_utils.build_sam2_video_predictor = _no_sam
    sys.modules["sam_utils"] = sam_utils
    if root not in sys.path:
        sys.path.insert(0, root)
    from process_pipepline import ProcessPipeline
    return ProcessPipeline


def _frames(path):
    from PIL import Image
    from decord import VideoReader
    vr = VideoReader(path)
    return [Image.fromarray(vr[i].asnumpy()) for i in range(len(vr))]


class Engine:
    def __init__(self):
        from diffusers import WanAnimatePipeline
        from huggingface_hub import snapshot_download
        ck = os.path.join(snapshot_download(PREP_REPO, allow_patterns=["process_checkpoint/det/*", "process_checkpoint/pose2d/*",
                                                                        "process_checkpoint/pose2d/**"]), "process_checkpoint")
        self.prep = _prep_class()(det_checkpoint_path=os.path.join(ck, "det", "yolov10m.onnx"),
                                  pose2d_checkpoint_path=os.path.join(ck, "pose2d", "vitpose_h_wholebody.onnx"),
                                  sam_checkpoint_path=None, flux_kontext_path=None)
        self.pipe = WanAnimatePipeline.from_pretrained(REPO, torch_dtype=torch.bfloat16)
        self.pipe.vae.to(torch.float32)  # recommended: cleaner decode
        if GPU_GB >= 70:
            self.pipe._exclude_from_cpu_offload = ["transformer"]
        self.pipe.enable_model_cpu_offload()
        self.fast = accelerate(self.pipe.transformer)

    def animate(self, req):
        from PIL import Image
        work = req["work_dir"]
        os.makedirs(work, exist_ok=True)
        fps, want = int(req["fps"]), int(req["num_frames"])
        prog = Progress(req.get("progress_path"), 1)
        prog.write("encoding prompt")  # shown as "preparing": pose extraction comes first
        clip = os.path.join(work, "driving.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", req["video_path"], "-t", f"{(want - 1) / fps + 0.5:.2f}", "-an",
                        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", clip], check=True)
        self.prep(video_path=clip, refer_image_path=req["image_path"], output_path=work,
                  resolution_area=[int(req["width"]), int(req["height"])], fps=fps, retarget_flag=bool(req.get("retarget")))
        pose, face = _frames(os.path.join(work, "src_pose.mp4")), _frames(os.path.join(work, "src_face.mp4"))
        n = min(len(pose), len(face), want)
        if n < 5:
            raise ValueError("couldn't find a person moving in the driving video (need a clear, single, full-body subject)")
        pose, face = pose[:n], face[:n]
        w, h = pose[0].size
        w, h = w - w % 16, h - h % 16
        ref = Image.open(req["image_path"]).convert("RGB")
        steps, seed = int(req["steps"]), int(req.get("seed", 7))
        eff = SEGMENT - 1
        segments = max(1, (n + (eff - (n - 1) % eff) % eff) // eff)
        prog = Progress(req.get("progress_path"), steps * segments)
        count = [0]

        def cb(pipe, i, t, kwargs):
            count[0] += 1
            prog.write("decoding" if count[0] >= prog.total else "denoising", min(count[0], prog.total))
            return kwargs

        def render():
            count[0] = 0
            return self.pipe(image=ref, pose_video=pose, face_video=face, prompt=req.get("prompt") or "",
                             negative_prompt=req.get("negative") or None, height=h, width=w, segment_frame_length=SEGMENT,
                             num_inference_steps=steps, guidance_scale=1.0, mode="animate",
                             generator=torch.Generator("cpu").manual_seed(seed), output_type="np",
                             callback_on_step_end=cb).frames[0]

        with torch.inference_mode():
            frames = run_fast(render, [self.pipe.transformer], self.fast)
        frames = frames[:n]
        prog.write("encoding video", prog.total)
        info = encode_mp4(frames, fps, req["out_path"])
        del frames
        gc.collect(); torch.cuda.empty_cache()
        return info
