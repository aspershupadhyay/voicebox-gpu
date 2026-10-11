"""Engine catalogue: how to install each engine, what it costs in GPU memory, and its parameters.

Everything the API exposes about voices and parameters comes from here, so this file is the single
source of truth for defaults and ranges (docs/API.md is generated from the same values).
"""
import os

VERSION = "3.0.0"
HOME = os.environ.get("VOICEBOX_HOME", "/content/voicebox")
VENVS = os.environ.get("VOICEBOX_VENVS", os.path.join(HOME, "venvs"))

# Spoken by Orpheus to create the "female"/"male" reference clips that Chatterbox clones.
REF_TEXT = ("Here's the strange thing about maps. They only help if you know exactly where you're "
            "standing, and that turns out to be a surprisingly hard problem.")
PRESET_REFS = {"female": ("orpheus", "tara"), "male": ("orpheus", "dan")}

# Resource groups: the GPU only ever holds one group. Starting a "visual" engine stops every voice engine
# (VRAM *and* RAM are freed because each engine is its own process), and vice versa.
GROUPS = {"voice": "Voice models", "visual": "Video models"}
IDLE_MIN = float(os.environ.get("VOICEBOX_IDLE_MIN", "10"))   # unload an engine after this many idle minutes
DISK_RESERVE_GB = 12.0                                         # keep this much disk free; evict old weights first
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
    "whisper": {
        "group": "voice",
        "disk_gb": 3.2,  # model weights downloaded on first use
        "kind": "asr",
        "port": 8105,
        "gpu_gb": 6.0,  # large-v3 fp16 weights + batch-4 activations
        "packages": "torch transformers accelerate soundfile scipy",
        "about": "Whisper large-v3 (OpenAI). Best open subtitle model: word-level timestamps, 99 languages.",
        "voices": [],
        "presets": {},
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
    "wan": {
        "group": "visual",
        "disk_gb": 23.0,   # Turbo (bf16); "full" quality adds ~20 GB more on first use
        "kind": "video",
        "port": 8110,
        "gpu_gb": 20.0,
        "packages": "torch diffusers>=0.41 transformers accelerate sentencepiece ftfy imageio imageio-ffmpeg pillow soundfile",
        "about": "Wan 2.2 TI2V 5B (Alibaba, Apache-2.0). Sharp 720p, strong motion and prompt following. Turbo: 4 steps.",
        "sizes": {"16:9": [1280, 704], "9:16": [704, 1280], "1:1": [960, 960]},
        "fps": 24, "max_seconds": 5.0, "frame_step": 4,
        "qualities": {"fast": {"steps": 4, "guidance": 1.0, "about": "Turbo distill, ~2-4 min per 5 s clip"},
                      "full": {"steps": 30, "guidance": 5.0, "about": "Original model, best detail, ~20-30 min on an L4"}},
        "voices": [], "presets": {}, "params": {},
    },
    "ltx": {
        "group": "visual",
        "disk_gb": 48.0,   # distilled transformer (bf16) + 4-bit Gemma 3 text encoder
        "kind": "video",
        "port": 8111,
        "gpu_gb": 20.0,
        "packages": "torch diffusers>=0.41 transformers accelerate bitsandbytes sentencepiece imageio imageio-ffmpeg pillow soundfile",
        "about": "LTX-2.3 22B distilled (Lightricks). Video *with matching sound* in 8 steps; up to 10 s. 4-bit on the L4.",
        "sizes": {"16:9": [1024, 576], "9:16": [576, 1024], "1:1": [768, 768]},
        "fps": 24, "max_seconds": 10.0, "frame_step": 8,
        "qualities": {"fast": {"steps": 8, "guidance": 1.0, "about": "Distilled, ~3-5 min per 5 s clip with audio"}},
        "voices": [], "presets": {}, "params": {},
    },
}

POST_DEFAULTS = {
    "trim": True,            # trim leading/trailing silence (keeps 60 ms of air)
    "trim_db": -45.0,
    "normalize_dbfs": -3.0,  # peak-normalise; null to keep the engine's level
    "sample_rate": 48000,    # resample for video timelines; null keeps native
    "tempo": 1.0,            # pitch-preserving pace multiplier (0.5-2.0) applied after synthesis
}


TTS_ENGINES = [n for n, e in ENGINES.items() if e["kind"] == "tts"]
VIDEO_ENGINES = [n for n, e in ENGINES.items() if e["kind"] == "video"]

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
                   "kokoro": {"speed": 1.1}, "qwen": {"temperature": 0.85}},
        "post": {"tempo": 1.05},
        "post_by_engine": {"kokoro": {"tempo": 1.0}},  # kokoro's own speed already sets the pace
        "voices": {"orpheus": ["mia", "leo", "tara"], "chatterbox": ["female", "male"], "kokoro": ["am_fenrir", "af_bella", "am_puck"]},
    },
    "hype": {
        "label": "Launch / hype", "about": "Maximum energy for promos and hooks (~200 wpm). Best with mia or leo.",
        "params": {"orpheus": {"temperature": 0.7, "top_p": 0.95, "repetition_penalty": 1.1},
                   "chatterbox": {"exaggeration": 1.05, "cfg_weight": 0.3, "temperature": 0.85},
                   "kokoro": {"speed": 1.2}, "qwen": {"temperature": 0.9}},
        "post": {"tempo": 1.08},
        "post_by_engine": {"kokoro": {"tempo": 1.0}},
        "voices": {"orpheus": ["mia", "leo"], "chatterbox": ["female", "male"], "kokoro": ["am_fenrir", "af_bella"]},
    },
    "narrator": {
        "label": "Calm narrator", "about": "Measured documentary read with room to breathe (~165 wpm).",
        "params": {"orpheus": {"temperature": 0.6, "top_p": 0.95, "repetition_penalty": 1.1},
                   "chatterbox": {"exaggeration": 0.4, "cfg_weight": 0.5, "temperature": 0.8},
                   "kokoro": {"speed": 0.95}, "qwen": {"temperature": 0.7}},
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
    return dict(st["params"].get(engine, {})), {**st["post"], **st.get("post_by_engine", {}).get(engine, {})}

# Speed priors (seconds of compute per character / per second of audio), refined live by the gateway.
RATE_PRIORS = {"kokoro": 0.004, "chatterbox": 0.06, "orpheus": 0.03, "whisper": 0.06, "qwen": 0.05,
               # video: seconds per (step x frame x megapixel), x2 when CFG doubles the passes
               "wan": 0.3, "ltx": 0.35}
INSTALL_PRIORS = {"kokoro": 40, "chatterbox": 150, "orpheus": 240, "whisper": 120, "qwen": 150, "wan": 300, "ltx": 420}  # first install, seconds
LOAD_PRIORS = {"kokoro": 5, "chatterbox": 45, "orpheus": 120, "whisper": 40, "qwen": 60, "wan": 240, "ltx": 480}  # first load includes the weight download

SUBTITLE_STYLE = {"max_chars": 42, "max_seconds": 3.5, "min_gap": 0.08}


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


def python_for(engine):
    """Each engine gets a venv named after a hash of its package list, so changing packages means a fresh venv."""
    import hashlib
    override = os.environ.get(f"VOICEBOX_PY_{engine.upper()}")
    tag = hashlib.sha1(ENGINES[engine]["packages"].encode()).hexdigest()[:8]
    return override or os.path.join(VENVS, f"{engine}-{tag}", "bin", "python")
