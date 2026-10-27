"""Engine catalogue: how to install each engine, what it costs in GPU memory, and its parameters.

Everything the API exposes about voices and parameters comes from here, so this file is the single
source of truth for defaults and ranges (docs/API.md is generated from the same values).
"""
import os

VERSION = "3.6.0"
HOME = os.environ.get("VOICEBOX_HOME", "/content/voicebox")
VENVS = os.environ.get("VOICEBOX_VENVS", os.path.join(HOME, "venvs"))

# Spoken by Orpheus to create the "female"/"male" reference clips that Chatterbox clones.
REF_TEXT = ("Here's the strange thing about maps. They only help if you know exactly where you're "
            "standing, and that turns out to be a surprisingly hard problem.")
PRESET_REFS = {"female": ("orpheus", "tara"), "male": ("orpheus", "dan")}

# Resource groups: the GPU only ever holds one group. Starting a "visual" engine stops every voice engine
# (VRAM *and* RAM are freed because each engine is its own process), and vice versa.
GROUPS = {"voice": "Voice models", "visual": "Video models"}
IDLE_MIN = float(os.environ.get("VOICEBOX_IDLE_MIN", "30"))   # unload an engine after this many idle minutes


def _ram_gb():
    try:
        return int(next(l for l in open("/proc/meminfo") if l.startswith("MemTotal")).split()[1]) / 2**20
    except (OSError, StopIteration, ValueError):
        return 0.0


# A high-RAM machine (Colab's A100 high-RAM: 167 GB) has room to keep the voice models parked all session: an idle
# engine is parked in RAM instead of stopped, and a parked one stays until RAM runs low, so every load after the
# first is a ~1 s wake. Below that, idle engines stop and parked ones stop after PARK_MIN, as before.
HIGH_RAM = _ram_gb() >= float(os.environ.get("VOICEBOX_HIGH_RAM_GB", "100"))
# a model parked in RAM is stopped after this many minutes (0 = only when RAM runs low)
PARK_MIN = float(os.environ.get("VOICEBOX_PARK_MIN") or (0 if HIGH_RAM else 60))
IDLE_PARK = os.environ.get("VOICEBOX_IDLE_PARK", "1" if HIGH_RAM else "0") == "1"  # idle: park instead of stop
RAM_RESERVE_GB = 16.0                                          # never park when it would leave less RAM free than this
NO_PARK = {"wan", "wan14", "ltx", "animate"}                   # video engines that page themselves in and out (cpu offload)
DISK_RESERVE_GB = 12.0                                         # keep this much disk free; evict old weights first

# Inference speed-ups (docs/INFERENCE.md): each behind a flag, default on only once measured on a real GPU.
# Step 3: the review hears every take of a voiceover in one batched, text-only Whisper call instead of four word-timed
# files at a time (VOICEBOX_BATCH_REVIEW=0 brings back the old path). A job can still ask for either path with
# review_batch (bench_voice.py --batch-review on|off).
BATCH_REVIEW = os.environ.get("VOICEBOX_BATCH_REVIEW", "1") == "1"
# Step 2: Orpheus / myvoice decode audio with SNAC folded, compiled for any length and batched per wave instead of one
# chunk at a time (engines/orpheus.py). Read by the engine at load: a change needs an engine restart.
# Measured on an L4: the codec is ~5% of a job and compiling adds ~1 min to a cold load, so it stays off (INFERENCE.md).
# Step 5: the first line of a voiceover is reviewed, mastered and published (job results) while the rest still generate,
# so the dashboard can play it at once. Orpheus hands back chunks as vLLM finishes them; batch engines voice the first
# line as their own first group. A job can still ask with stream (true / false); VOICEBOX_STREAM=0 turns it off.
STREAM = os.environ.get("VOICEBOX_STREAM", "1") == "1"
# Step 4, two parts that are measured separately:
# WHOLE_CARD: on 70 GB+ cards the vLLM pool grows from 30 to 48 GB and takes 256 sentences at once.
# RESIDENT_REVIEW: on every card the review models (Whisper with its voice-match and naturalness models; the enhancer
# too on 70 GB+) stay resident: never unloaded for idling, evicted last, and loaded in the background at the start of a
# voiceover when they fit beside it, so the review never waits for a load. Off: the plain LRU of before.
WHOLE_CARD = os.environ.get("VOICEBOX_WHOLE_CARD", "0") == "1"
RESIDENT_REVIEW = os.environ.get("VOICEBOX_RESIDENT_REVIEW", "1") == "1"  # VOICEBOX_RESIDENT_REVIEW=0: plain LRU
COMPILE_CODEC = os.environ.get("VOICEBOX_COMPILE_CODEC", "0") == "1"
# Step 5b: speculative decoding for Orpheus / myvoice (engines/orpheus.py). "ngram": the next few codec tokens are
# guessed from repeats earlier in the sequence and checked in one forward pass (no extra model, same distribution);
# "<method>:<model>" plugs in a trained proposer (e.g. an EAGLE head); "0" turns it off. VOICEBOX_SPEC_TOKENS sets how
# many tokens are guessed a step. Read at engine load: a change needs an engine restart.
# Measured on an L4: n-gram guesses rarely match audio codes (one request 54 -> 51 tokens/s) and checking them slows the
# batch (10 lines generating 13.7 -> 21.8 s), so n-gram stays off. "auto" (the default): the EAGLE draft an eagle job
# trained and measured faster on this worker, if any (gateway run_eagle writes eagle/current.json); else plain decoding.
# a trained voice's flow runs in chains of at most this many lines, side by side (gateway._chain); 0 = one chain
FLOW_CHAIN = int(os.environ.get("VOICEBOX_FLOW_CHAIN", "4") or 0)
SPEC = os.environ.get("VOICEBOX_SPEC", "auto")
# Step 6: right after the gateway starts, install these engines' venvs and download their weights (ENGINES[...]["prefetch"])
# to disk in the background, one at a time, without loading anything on the GPU: on a fresh runtime the first voiceover
# then skips the install and the download. Already there (a worker restart): nothing to do. "" turns it off. Whisper
# first (every review needs it, and it's small), then your own voice (its cold load took 311 s on a fresh L4), then the
# rest. It pauses while a job fetches anything, so it never slows a real job down.
PREFETCH = [n.strip() for n in os.environ.get("VOICEBOX_PREFETCH", "whisper,myvoice,qwen,orpheus").split(",") if n.strip()]
# Load these on the GPU right after their prefetch, while the worker comes online, so the first voiceover doesn't wait
# for a load. myvoice only when a trained voice exists; never while a job runs or the video models hold the GPU.
PRELOAD = [n.strip() for n in os.environ.get("VOICEBOX_PRELOAD", "myvoice").split(",") if n.strip()]
# Step 7 (docs/INFERENCE.md): the dashboard's R2 bucket as a cache across runtimes (worker/r2cache.py).
# R2_WEIGHTS: the voice engines' Hugging Face repos come from R2 when it has them (mirrored by the first runtime that
# downloaded them); R2_COMPILE: vLLM's compiled kernels, kept per GPU model and vLLM version.
# Studio polish (post.enhance) runs on this engine: "resemble" (Resemble Enhance: denoise + flow-matching restore to
# 44.1 kHz, ~0.2 s per second of audio) or "apbwe" (AP-BWE: one-pass 24 -> 48 kHz bandwidth extension that leaves the
# low band as it was). A job can pick with post.polish_engine; if AP-BWE fails, Resemble does the job.
# Measured on the L4, 37 lines (564 s of audio): AP-BWE 5.4 s and 37/37 kept vs Resemble 89.4 s and 11/37 kept.
POLISH = os.environ.get("VOICEBOX_POLISH", "apbwe")
POLISH_ENGINE = {"resemble": "enhance", "apbwe": "apbwe"}
R2_WEIGHTS = os.environ.get("VOICEBOX_R2_WEIGHTS", "1") == "1"
R2_COMPILE = os.environ.get("VOICEBOX_R2_COMPILE", "1") == "1"
VIDEO_ASPECTS = ("16:9", "9:16", "1:1")

ENGINES = {
    "kokoro": {
        "group": "voice",
        "disk_gb": 0.4,  # model weights downloaded on first use
        "kind": "tts",
        "port": 8101,
        "gpu_gb": 0.0,
        "chunk_chars": 0,  # kokoro-onnx splits long text itself  # onnxruntime on CPU: instant drafts, never competes for VRAM
        "packages": "kokoro-onnx soundfile numpy",
        "about": "Kokoro-82M. Fast, clean, flat delivery. Best for drafts and timing.",
        "voices": ["af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "af_alloy", "af_nova",
                   "af_sky", "af_jessica", "af_river", "am_fenrir", "am_michael", "am_puck", "am_echo", "am_eric",
                   "am_liam", "am_onyx", "am_santa", "am_adam", "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
                   "bm_fable", "bm_george", "bm_lewis", "bm_daniel", "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
                   "ff_siwis", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune", "jm_kumo", "ef_dora", "em_alex", "pf_dora", "pm_alex",
                   "zf_xiaobei", "zf_xiaoxiao", "zm_yunjian", "zm_yunxi"],
        "presets": {"female": "af_heart", "male": "am_michael"},
        "params": {
            "speed": {"type": "number", "default": 1.0, "min": 0.5, "max": 2.0, "about": "speaking rate"},
            "lang": {"type": "string", "default": "", "about": "leave empty: picked from the voice (h* = Hindi, b* = British...)"},
        },
    },
    "chatterbox": {
        "group": "voice",
        "disk_gb": 4.0,  # model weights downloaded on first use
        "kind": "tts",
        "port": 8102,
        "gpu_gb": 4.0,
        "chunk_chars": 280,  # ~20 s; Chatterbox drifts on very long prompts
        "packages": 'chatterbox-tts "setuptools<81"',
        "about": "Chatterbox 0.5B (Resemble AI, MIT). Emotion dial + zero-shot cloning; 23 languages incl. Hindi.",
        "voices": ["default", "female", "male", "<any reference name>"],
        "presets": {"female": "female", "male": "male"},
        "params": {
            "exaggeration": {"type": "number", "default": 0.5, "min": 0.0, "max": 2.0,
                             "about": "emotion intensity: 0.25 calm, 0.5 natural, 0.8+ dramatic"},
            "cfg_weight": {"type": "number", "default": 0.5, "min": 0.0, "max": 1.0,
                           "about": "lower = slower, more deliberate pacing"},
            "temperature": {"type": "number", "default": 0.8, "min": 0.05, "max": 2.0},
            "language": {"type": "string", "default": "en", "about": "ISO code; non-English uses the multilingual model"},
            "seed": {"type": "integer", "default": 7},
        },
    },
    "orpheus": {
        "group": "voice",
        "disk_gb": 7.0,  # model weights downloaded on first use
        "kind": "tts",
        "port": 8103,
        "gpu_gb": 11.5,  # vLLM pool (ORPHEUS_VRAM_GB, default 9) + SNAC decoder + CUDA context
        "chunk_chars": 260,  # sentences are grouped up to this size, then batched together on vLLM
        "packages": "vllm snac soundfile",
        "prefetch": [os.environ.get("ORPHEUS_MODEL", "unsloth/orpheus-3b-0.1-ft"), "hubertsiuzdak/snac_24khz"],
        "about": "Orpheus 3B on vLLM. Most human-sounding; inline tags <laugh> <chuckle> <sigh> <cough> <sniffle> <groan> <yawn> <gasp>.",
        "voices": ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"],
        "presets": {"female": "tara", "male": "dan"},
        "params": {
            "temperature": {"type": "number", "default": 0.6, "min": 0.1, "max": 1.5,
                            "about": "lower = steadier and more literal, higher = more expressive but riskier"},
            "top_p": {"type": "number", "default": 0.95, "min": 0.1, "max": 1.0},
            "repetition_penalty": {"type": "number", "default": 1.1, "min": 1.0, "max": 2.0,
                                   "about": ">= 1.1 needed for stable output; raise if words repeat"},
            "seed": {"type": "integer", "default": 7, "about": "change it to get a different take of the same line"},
        },
    },
    "myvoice": {
        "group": "voice",
        "disk_gb": 7.0,
        "kind": "tts",
        "port": 8108,
        "gpu_gb": 11.5,
        "chunk_chars": 260,
        "packages": "vllm snac soundfile peft",  # orpheus + peft (the transformers fallback merges your LoRA adapter)
        "prefetch": [os.environ.get("ORPHEUS_MODEL", "unsloth/orpheus-3b-0.1-ft"), "hubertsiuzdak/snac_24khz"],
        "about": "Your own voice model: Orpheus 3B fine-tuned on 30-60 min of your recordings (Your model page: collect, then Train). "
                 "Same tags as Orpheus; with flow, a long script is voiced as one continuous take.",
        "voices": ["me"],
        "presets": {"female": "me", "male": "me"},
        "params": {
            "temperature": {"type": "number", "default": 0.5, "min": 0.1, "max": 1.5,
                            "about": "lower = clearer and steadier (0.45-0.55 for a crisp explainer), higher = more expressive but riskier"},
            "top_p": {"type": "number", "default": 0.95, "min": 0.1, "max": 1.0},
            "repetition_penalty": {"type": "number", "default": 1.12, "min": 1.0, "max": 2.0},
            "seed": {"type": "integer", "default": 7, "about": "change it to get a different take of the same line"},
            "flow": {"type": "boolean", "default": True,
                     "about": "carry your delivery from one sentence into the next, so a script sounds like one take (needs a "
                              "model trained with flow; slower on long scripts because sentences are voiced in order)"},
        },
    },
    "whisper": {
        "group": "voice",
        "disk_gb": 2.2,  # model weights downloaded on first use
        "kind": "asr",
        "port": 8105,
        "gpu_gb": 4.0,  # large-v3-turbo fp16 weights (1.6 GB) + batched 30 s windows, voice match and naturalness models
        # torchaudio: the naturalness model (UTMOS via SpeechMOS) imports it; without it every polish check failed
        "packages": "torch torchaudio transformers accelerate soundfile scipy",
        "prefetch": [os.environ.get("WHISPER_MODEL", "openai/whisper-large-v3-turbo"),
                     os.environ.get("VOICE_MATCH_MODEL", "microsoft/wavlm-base-plus-sv")],
        "about": "Whisper large-v3-turbo (OpenAI). Large-v3 accuracy with a 4-layer decoder: several times faster subtitles, review and dataset cuts. Word-level timestamps, 99 languages.",
        "voices": [],
        "presets": {},
        "params": {},
    },
    "enhance": {
        "group": "voice",
        "disk_gb": 0.7,
        "kind": "enhance",
        "port": 8107,
        "gpu_gb": 3.0,
        # resemble-enhance pins torch 2.1 + DeepSpeed + gradio for training/demo; inference runs on these, and the
        # package itself goes in without its pins (see engines/enhance.py). numpy<2: its flow solver predates numpy 2.
        "packages": 'torch==2.5.1 torchaudio==2.5.1 "numpy<2" "pandas<2.3" "scipy<1.14" librosa omegaconf rich matplotlib '
                    'soundfile tqdm resampy huggingface_hub celluloid tabulate',
        "nodeps": "resemble-enhance==0.0.1",
        "about": "Resemble Enhance (MIT). Studio clean-up: removes noise and room echo, restores the detail a cheap mic or phone loses (to 44.1 kHz).",
        "voices": [], "presets": {},
        "params": {
            "mode": {"type": "string", "default": "enhance", "about": "enhance = denoise + restore detail; denoise = remove noise only, timbre untouched"},
            "strength": {"type": "number", "default": 0.6, "min": 0.0, "max": 1.0, "about": "how hard the denoiser leads: higher for noisy rooms, lower keeps more of the original"},
            "steps": {"type": "integer", "default": 48, "min": 16, "max": 128, "about": "restoration detail (more = finer, slower)"},
        },
    },
    "apbwe": {
        "group": "voice",
        "disk_gb": 0.12,
        "kind": "enhance",
        "port": 8114,
        "gpu_gb": 1.0,
        "packages": "torch torchaudio safetensors huggingface_hub soundfile numpy",
        "about": "AP-BWE (MIT). Studio polish in one pass: 24 -> 48 kHz bandwidth extension that only adds the missing high band, so the voice itself is untouched.",
        "voices": [], "presets": {},
        "params": {},
    },
    "qwen": {
        "group": "voice",
        "disk_gb": 4.6,
        "kind": "tts",
        "port": 8106,
        "gpu_gb": 6.0,
        "chunk_chars": 400,
        "clone": True,  # voices are reference recordings (yours, or the female/male presets)
        "packages": "qwen-tts soundfile",
        "prefetch": [os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")],
        "apt": "sox",
        "about": "Qwen3-TTS 1.7B Base (Alibaba, Apache-2.0). Best voice cloning: a 10-20 s recording of you becomes your voice. 10 languages (no Hindi: use Chatterbox).",
        "voices": ["female", "male", "<any reference name>"],
        "presets": {"female": "female", "male": "male"},
        "languages": ["English", "Chinese", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"],
        "params": {
            "language": {"type": "string", "default": "English", "about": "English, Chinese, Japanese, Korean, German, French, Russian, Portuguese, Spanish or Italian"},
            "temperature": {"type": "number", "default": 0.8, "min": 0.1, "max": 1.5, "about": "lower = closer to your reference delivery, higher = livelier"},
            "top_p": {"type": "number", "default": 0.95, "min": 0.1, "max": 1.0},
            "seed": {"type": "integer", "default": 7, "about": "change it for a different take"},
        },
    },
    "cosyvoice": {
        "group": "voice",
        "disk_gb": 3.8,
        "kind": "tts",
        "port": 8115,
        "gpu_gb": 5.0,
        "chunk_chars": 300,
        "clone": True,  # like qwen: your recordings (or the female/male presets) are the voices
        # CosyVoice's own pins for inference (its training, TensorRT and gradio extras left out); its code is fetched by
        # the engine at a pinned commit. onnxruntime on the CPU: the reference is tokenised once per recording.
        "packages": 'torch==2.3.1 torchaudio==2.3.1 conformer==0.3.2 diffusers==0.29.0 hydra-core==1.3.2 HyperPyYAML==1.2.3 '
                    'inflect==7.3.1 librosa==0.10.2 lightning==2.2.4 omegaconf==2.3.0 onnxruntime==1.18.0 openai-whisper==20250625 '
                    'transformers==4.51.3 x-transformers==2.11.24 wetext==0.0.4 numpy==1.26.4 pyarrow==18.1.0 pyworld==0.3.4 '
                    '"setuptools<70" gdown wget soundfile einops tiktoken huggingface_hub matplotlib rich',
        "prefetch": [os.environ.get("COSYVOICE_MODEL", "FunAudioLLM/CosyVoice2-0.5B")],
        "about": "CosyVoice 2 0.5B (Alibaba, Apache-2.0). Fast zero-shot cloning of your recorded voice; English, Chinese, Japanese, Korean and more.",
        "voices": ["female", "male", "<any reference name>"],
        "presets": {"female": "female", "male": "male"},
        "params": {
            "speed": {"type": "number", "default": 1.0, "min": 0.5, "max": 2.0, "about": "speaking rate"},
            "seed": {"type": "integer", "default": 7, "about": "change it for a different take"},
        },
    },
    "wan": {
        "group": "visual",
        "disk_gb": 23.0,   # Turbo (bf16); "full" quality adds ~20 GB more on first use
        "kind": "video",
        "port": 8110,
        "gpu_gb": 20.0,
        "packages": "torch diffusers>=0.41 transformers accelerate kernels sentencepiece ftfy imageio imageio-ffmpeg pillow soundfile",
        "about": "Wan 2.2 TI2V 5B (Alibaba, Apache-2.0). Sharp 720p, strong motion and prompt following. Turbo: 4 steps.",
        "sizes": {"16:9": [1280, 704], "9:16": [704, 1280], "1:1": [960, 960]},
        "fps": 24, "max_seconds": 5.0, "frame_step": 4,
        "qualities": {"draft": {"steps": 4, "guidance": 1.0, "about": "Turbo + tiny decoder: quickest preview, slightly softer"},
                      "fast": {"steps": 4, "guidance": 1.0, "about": "Turbo distill with the full decoder"},
                      "full": {"steps": 30, "guidance": 5.0, "about": "Original model, best detail, ~20-30 min on an L4"}},
        "voices": [], "presets": {}, "params": {},
    },
    "wan14": {
        "group": "visual",
        "disk_gb": 69.0,   # both 14B experts in bf16 (Lightning merged) + UMT5 text encoder; adult LoRA adds ~1.2 GB
        "kind": "video",
        "port": 8112,
        "gpu_gb": 62.0,   # both experts resident on 70 GB+ cards (57 GB) + VAE decode
        "min_gpu_gb": 38.0,  # one 14B expert on the GPU at a time: A100 / H100 class only
        "image_only": True,
        "adult": True,       # accepts adult: true (community LoRA, opt-in per job)
        "packages": "torch diffusers>=0.41 transformers accelerate peft kernels sentencepiece ftfy imageio imageio-ffmpeg pillow soundfile",
        "about": "Wan 2.2 I2V A14B + Lightning (Alibaba, Apache-2.0). Best motion and detail of the Wan family; animates a start frame. 480p, 4 steps, A100 only.",
        "sizes": {"16:9": [832, 480], "9:16": [480, 832], "1:1": [640, 640]},
        "fps": 16, "max_seconds": 5.0, "frame_step": 4,
        "qualities": {"draft": {"steps": 4, "guidance": 1.0, "about": "Lightning + tiny decoder: quickest preview"},
                      "fast": {"steps": 4, "guidance": 1.0, "about": "Lightning distill, 4 steps, full decoder"}},
        "voices": [], "presets": {}, "params": {},
    },
    "ltx": {
        "group": "visual",
        "disk_gb": 71.0,   # LTX-2.5: distilled transformer 38 + Gemma 4 text encoder 24 + connectors 6.3 + VAEs, vocoder, upsampler
        "kind": "video",
        "port": 8111,
        "gpu_gb": 52.0,   # transformer + connectors resident (44 GB); the 24 GB text encoder swaps in for the prompt
        # LTX-2.5 isn't in a diffusers release yet: install from main
        "packages": "torch git+https://github.com/huggingface/diffusers transformers accelerate bitsandbytes kernels sentencepiece imageio imageio-ffmpeg pillow soundfile",
        "about": "LTX-2.5 22B distilled (Lightricks). Video *with matching sound* in 8 steps; up to 10 s. Full = two-stage, 2x resolution.",
        "sizes": {"16:9": [960, 544], "9:16": [544, 960], "1:1": [768, 768]},
        "fps": 24, "max_seconds": 10.0, "frame_step": 8,
        "qualities": {"draft": {"steps": 8, "guidance": 1.0, "about": "One pass at about half size: quickest preview",
                                "sizes": {"16:9": [640, 352], "9:16": [352, 640], "1:1": [512, 512]}},
                      "fast": {"steps": 8, "guidance": 1.0, "about": "Distilled, one pass"},
                      "full": {"steps": 11, "guidance": 1.0, "about": "Two-stage: x2 latent upsample + refine, double resolution (text only)"}},
        "voices": [], "presets": {}, "params": {},
    },
    # ── image models ──────────────────────────────────────────────────────────────────────────────────────────────
    "zimage": {
        "group": "visual",
        "disk_gb": 33.0,
        "kind": "image",
        "port": 8120,
        "gpu_gb": 22.0,
        "packages": "torch torchvision diffusers>=0.41 transformers accelerate kernels sentencepiece pillow",
        "about": "Z-Image-Turbo (Tongyi-MAI, Apache-2.0: commercial use OK). 6B, 8 steps, photoreal, ~2 s per image.",
        "license": "Apache-2.0 · commercial use OK", "commercial": True,
        "sizes": {"1:1": [1024, 1024], "4:3": [1152, 864], "3:4": [864, 1152], "3:2": [1248, 832], "2:3": [832, 1248],
                  "16:9": [1344, 768], "9:16": [768, 1344]},
        "qualities": {"turbo": {"steps": 8, "guidance": 0.0, "about": "8 steps, no CFG"}},
        "max_count": 4,
        "voices": [], "presets": {}, "params": {},
    },
    "qwenimage": {
        "group": "visual",
        "disk_gb": 47.0,   # Turbo pipeline 33 GB + the base transformer (14 GB) the first time "quality" is used
        "kind": "image",
        "port": 8121,
        "gpu_gb": 40.0,
        "packages": "torch torchvision diffusers>=0.41 transformers accelerate kernels sentencepiece pillow",
        "about": "Qwen-Image-2.1 (Alibaba Qwen). Native 2K, sharp text in images, edits with up to 10 references, transparent PNGs.",
        "license": "Qwen Research License · NON-commercial only", "commercial": False,
        "sizes": {"1:1": [2048, 2048], "4:3": [2400, 1792], "3:4": [1792, 2400], "3:2": [2528, 1696], "2:3": [1696, 2528],
                  "16:9": [2752, 1536], "9:16": [1536, 2752]},
        "qualities": {"turbo": {"steps": 8, "guidance": 1.0, "about": "Turbo: 8 steps"},
                      "quality": {"steps": 40, "guidance": 1.0, "about": "Base model: 40 steps, finest detail"}},
        "max_count": 4, "edit": True, "max_refs": 10, "transparent": True,
        "voices": [], "presets": {}, "params": {},
    },
    # ── animate: a character image performs the motion of a driving video ─────────────────────────────────────────
    "animate": {
        "group": "visual",
        "disk_gb": 85.0,   # Wan2.2-Animate-14B diffusers (transformer stored fp32: 69 GB) + text/image encoders + pose ONNX (3 GB)
        "kind": "animate",
        "port": 8113,
        "gpu_gb": 48.0,
        "min_gpu_gb": 38.0,
        "packages": "torch torchvision diffusers>=0.41 transformers accelerate peft kernels sentencepiece ftfy imageio imageio-ffmpeg pillow soundfile "
                    "onnxruntime-gpu opencv-python-headless decord loguru matplotlib moviepy tqdm",
        "about": "Wan 2.2 Animate 14B (Alibaba, Apache-2.0). Your character (one image) performs the motion of a driving video: exercises, dances, gestures.",
        "sizes": {"9:16": [480, 832], "16:9": [832, 480], "1:1": [640, 640]},
        "fps": 16, "max_seconds": 10.0, "frame_step": 4,
        "qualities": {"fast": {"steps": 20, "guidance": 1.0, "about": "20 steps"}},
        "voices": [], "presets": {}, "params": {},
    },

}

POST_DEFAULTS = {
    "trim": True,            # trim leading/trailing silence (keeps 60 ms of air)
    "trim_db": -45.0,
    "normalize_dbfs": -3.0,  # peak-normalise; only used when master is "raw"/null
    "sample_rate": 48000,    # resample for video timelines; null keeps native
    "tempo": 1.0,            # pitch-preserving pace multiplier (0.5-2.0) applied after synthesis
    "master": "youtube",     # voice chain + loudness target from PLATFORMS; "raw"/null = peak-normalise only
}

# Where the voiceover is going. Each platform sets the mastering loudness and the caption cut.
#  - Loudness: YouTube, Instagram and TikTok all turn louder uploads down to about -14 LUFS, so mastering there
#    keeps the full dynamic range on playback; podcasts sit at -16 (Apple / Spotify spec). True peak stays under
#    -1 dBTP so the platforms' lossy re-encode doesn't clip.
#  - Captions: long-form gets two-line subtitles; vertical shorts get 1-3 punchy words at a time, read at a glance.
PLATFORMS = {
    "youtube": {"label": "YouTube", "about": "Long-form video: -14 LUFS, subtitle-style captions.", "lufs": -14.0, "tp": -1.0, "captions": "subtitles"},
    "shorts": {"label": "YouTube Shorts", "about": "Vertical: -14 LUFS, 1-3 word pop-up captions.", "lufs": -14.0, "tp": -1.0, "captions": "punchy"},
    "reels": {"label": "Instagram Reels", "about": "Vertical: -14 LUFS, 1-3 word pop-up captions.", "lufs": -14.0, "tp": -1.0, "captions": "punchy"},
    "tiktok": {"label": "TikTok", "about": "Vertical: -14 LUFS, 1-3 word pop-up captions.", "lufs": -14.0, "tp": -1.0, "captions": "punchy"},
    "podcast": {"label": "Podcast", "about": "Audio-first: -16 LUFS, subtitle-style transcript.", "lufs": -16.0, "tp": -1.5, "captions": "subtitles"},
    "raw": {"label": "Raw", "about": "No mastering: peak-normalised to -3 dBFS, for mixing yourself.", "lufs": None, "tp": None, "captions": "subtitles"},
}
DEFAULT_PLATFORM = "youtube"

# The broadcast voice chain that runs before the loudness target (ffmpeg filters, in order): cut rumble, clear
# boxiness, lift presence and air, tame sibilance, then gentle 3:1 compression so every word sits at one level.
VOICE_CHAIN = ("highpass=f=75,equalizer=f=280:t=q:w=1.1:g=-2.5,equalizer=f=3200:t=q:w=1.0:g=2.0,"
               "highshelf=f=9000:g=1.5,deesser=i=0.35:m=0.5:f=0.5:s=o,"
               "acompressor=threshold=-20dB:ratio=3:attack=6:release=90:makeup=2:knee=4")


TTS_ENGINES = [n for n, e in ENGINES.items() if e["kind"] == "tts"]
VIDEO_ENGINES = [n for n, e in ENGINES.items() if e["kind"] == "video"]
IMAGE_ENGINES = [n for n, e in ENGINES.items() if e["kind"] == "image"]

# Delivery styles: per-engine settings measured with scripts/style-bench.py (pitch movement, words per minute,
# Whisper accuracy). A style sets defaults; explicit params / post values in a request still win.
# Findings (8-line tech script, validated):
#  - Orpheus: temperature is NOT an energy dial. tara at 0.6 / 0.85 / 0.9 ran 176 / 173 / 180 wpm with pitch range
#    7.3 / 6.6 / 5.8 semitones, while accuracy fell to 95% at 0.9. The voice is the lever: mia at 0.85 was
#    9.9 st and 192 wpm, word-perfect. So Orpheus keeps a safe temperature and gets pace from `tempo`.
#  - Chatterbox: exaggeration widens pitch (female 6 -> 11 semitones from 0.5 to 1.2); male slurs past ~1.0.
#  - Kokoro: liveliness is mostly the voice (am_fenrir, af_bella, am_puck); speed adds pace.
STYLES = {
    "tech": {
        "label": "Tech explainer", "about": "Bright, quick, confident. YouTube-tech pace (~185 wpm).",
        "params": {"orpheus": {"temperature": 0.65, "top_p": 0.95, "repetition_penalty": 1.1},
                   "chatterbox": {"exaggeration": 0.9, "cfg_weight": 0.3, "temperature": 0.8},
                   "kokoro": {"speed": 1.1}, "qwen": {"temperature": 0.85},
                   "myvoice": {"temperature": 0.5, "top_p": 0.95, "repetition_penalty": 1.12}},
        "post": {"tempo": 1.05},
        "post_by_engine": {"kokoro": {"tempo": 1.0}},  # kokoro's own speed already sets the pace
        "voices": {"orpheus": ["mia", "leo", "tara"], "chatterbox": ["female", "male"], "kokoro": ["am_fenrir", "af_bella", "am_puck"]},
    },
    "hype": {
        "label": "Launch / hype", "about": "Maximum energy for promos and hooks (~200 wpm). Best with mia or leo.",
        "params": {"orpheus": {"temperature": 0.7, "top_p": 0.95, "repetition_penalty": 1.1},
                   "chatterbox": {"exaggeration": 1.05, "cfg_weight": 0.3, "temperature": 0.85},
                   "kokoro": {"speed": 1.2}, "qwen": {"temperature": 0.9},
                   "myvoice": {"temperature": 0.6, "top_p": 0.95, "repetition_penalty": 1.12}},
        "post": {"tempo": 1.08},
        "post_by_engine": {"kokoro": {"tempo": 1.0}},
        "voices": {"orpheus": ["mia", "leo"], "chatterbox": ["female", "male"], "kokoro": ["am_fenrir", "af_bella"]},
    },
    "narrator": {
        "label": "Calm narrator", "about": "Measured documentary read with room to breathe (~165 wpm).",
        "params": {"orpheus": {"temperature": 0.6, "top_p": 0.95, "repetition_penalty": 1.1},
                   "chatterbox": {"exaggeration": 0.4, "cfg_weight": 0.5, "temperature": 0.8},
                   "kokoro": {"speed": 0.95}, "qwen": {"temperature": 0.7},
                   "myvoice": {"temperature": 0.45, "top_p": 0.95, "repetition_penalty": 1.12}},
        "post": {"tempo": 0.95},
        "post_by_engine": {"kokoro": {"tempo": 1.0}},
        "voices": {"orpheus": ["tara", "leah", "dan"], "chatterbox": ["female", "male"], "kokoro": ["af_heart", "bm_george", "af_nicole"]},
    },
    "neutral": {
        "label": "Neutral", "about": "Engine defaults, no styling.",
        "params": {}, "post": {}, "voices": {},
    },
}
DEFAULT_STYLE = "tech"


def style_settings(style, engine):
    """(params, post) defaults for a style on an engine; raises on unknown style names."""
    if style not in STYLES:
        raise ValueError(f"style must be one of {list(STYLES)}")
    st = STYLES[style]
    like = "orpheus" if engine == "myvoice" else engine  # your fine-tuned Orpheus takes Orpheus's style settings...
    params = st["params"].get(engine) or st["params"].get(like, {})  # ...unless the style tunes it (lower temperature: clearer)
    return dict(params), {**st["post"], **st.get("post_by_engine", {}).get(like, {})}

# Speed priors (seconds of compute per character / per second of audio), refined live by the gateway.
RATE_PRIORS = {"kokoro": 0.004, "chatterbox": 0.06, "orpheus": 0.03, "myvoice": 0.03, "whisper": 0.06, "qwen": 0.05,
               "listen": 0.06,  # the batched review (text only), seconds per second of takes
               "revoice": 0.25, "enhance": 0.4, "apbwe": 0.01, "cosyvoice": 0.03,  # per second of audio  # Chatterbox VC: seconds per second of performance
               # video: seconds per (step x frame x megapixel), x2 when CFG doubles the passes
               "wan": 0.3, "ltx": 0.35, "wan14": 1.2,
               # image: seconds per (step x megapixel x image); animate: per (step x frame x megapixel)
               "zimage": 0.08, "qwenimage": 0.1, "animate": 1.5}
INSTALL_PRIORS = {"enhance": 150, "apbwe": 90, "cosyvoice": 200, "kokoro": 40, "chatterbox": 150, "orpheus": 240, "myvoice": 240, "whisper": 120, "qwen": 150, "wan": 300, "ltx": 600, "wan14": 300, "zimage": 120, "qwenimage": 120, "animate": 300}  # first install, seconds
LOAD_PRIORS = {"enhance": 40, "apbwe": 10, "cosyvoice": 90, "kokoro": 5, "chatterbox": 45, "orpheus": 120, "myvoice": 120, "whisper": 40, "qwen": 60, "wan": 240, "ltx": 480, "wan14": 600, "zimage": 150, "qwenimage": 240, "animate": 600}  # first load includes the weight download

SUBTITLE_STYLE = {"max_chars": 42, "max_seconds": 3.5, "min_gap": 0.08}
CAPTION_STYLES = {
    "subtitles": SUBTITLE_STYLE,                                       # one or two lines, sentence by sentence
    "punchy": {"max_chars": 16, "max_seconds": 1.2, "min_gap": 0.0},   # Shorts / Reels / TikTok: 1-3 words at a time
}

MAX_TAKES = 4  # best-of-N: each chunk is voiced N times and the take Whisper (and the voice match) likes best wins


def resolve_params(engine, given):
    """Merge user params over defaults and clamp to the declared range."""
    out = {}
    for k, spec in ENGINES[engine]["params"].items():
        v = (given or {}).get(k, spec["default"])
        if spec["type"] in ("number", "integer") and v is not None:
            v = float(v) if spec["type"] == "number" else int(v)
            v = max(spec.get("min", v), min(spec.get("max", v), v))
        out[k] = v
    return out


# Your own voice model, trained on the worker (gateway train job -> train.py). Its own venv: unsloth pins its own torch.
TRAIN_PACKAGES = "unsloth snac soundfile librosa"
TRAIN_INSTALL_S = 420  # first run: installing unsloth + torch into the train venv
MYVOICE_DIR = os.path.join(HOME, "myvoice")  # the trained LoRA adapter the myvoice engine loads (adapter/)
QWENFT_DIR = os.path.join(HOME, "qwenft")  # fine-tuned Qwen3-TTS voices (models/<train job>/), voice ft_<name> on qwen
QWENFT_PACKAGES = "accelerate librosa"  # on top of the qwen engine's venv, for train_qwen.py


def vllm_pool_gb(total_gb, whole=None):
    """GPU memory for the vLLM engines (weights ~6.5 GB + KV cache). More cache = more sentences generated at once, so
    bigger cards get more, but always leave room for Whisper (review) next to it: a 24 GB L4 keeps both loaded.
    whole (WHOLE_CARD): an 80 GB card gives vLLM 48 GB and still keeps Whisper, the enhancer and Qwen beside it."""
    if total_gb >= 70:
        return 48.0 if (WHOLE_CARD if whole is None else whole) else 30.0
    if total_gb >= 38:
        return 18.0
    if total_gb >= 20:
        return 12.0
    return 9.0


# Lines Qwen voices in one batch (plain transformers, not vLLM: memory grows with the batch, but each line's cache is
# small next to the 1.7B weights). Was a fixed 8, which kept best-of-4 generation-bound (40 takes = 5 batches);
# engines/qwen.py halves a batch that runs out of memory, so a bigger one can't fail a job. VOICEBOX_QWEN_BATCH sets it.
def qwen_batch(total_gb):
    if os.environ.get("VOICEBOX_QWEN_BATCH"):
        return max(1, int(os.environ["VOICEBOX_QWEN_BATCH"]))
    return 32 if total_gb >= 70 else 24 if total_gb >= 38 else 16 if total_gb >= 20 else 8


def vllm_max_seqs(pool_gb):
    """How many sentences vLLM may generate at once. Each one holds up to ~2.5k tokens of KV cache (~0.3 GB at 16 bit),
    and vLLM only admits what its cache fits, so a big pool (80 GB card) can take twice the default 64. A typical
    sentence holds ~600 tokens (~70 MB), so the 48 GB pool of WHOLE_CARD fits 256 at once: a 60-line script at best-of-4
    in one batch."""
    return 256 if pool_gb >= 40 else 128 if pool_gb >= 24 else 64


def resident_engines(total_gb, on=None):
    """RESIDENT_REVIEW: the engines a voiceover's review needs, kept loaded (never idle-unloaded, evicted last)."""
    if not (RESIDENT_REVIEW if on is None else on):
        return set()
    return {"whisper"} | ({POLISH_ENGINE.get(POLISH, "enhance")} if total_gb >= 70 or POLISH == "apbwe" else set())


def python_for(engine):
    """Each engine gets a venv named after a hash of its package list, so changing packages means a fresh venv."""
    import hashlib
    override = os.environ.get(f"VOICEBOX_PY_{engine.upper()}")
    tag = hashlib.sha1((ENGINES[engine]["packages"] + ENGINES[engine].get("nodeps", "")).encode()).hexdigest()[:8]
    return override or os.path.join(VENVS, f"{engine}-{tag}", "bin", "python")
