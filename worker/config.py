"""Engine catalogue: how to install each engine, what it costs in GPU memory, and its parameters.

Everything the API exposes about voices and parameters comes from here, so this file is the single
source of truth for defaults and ranges (docs/API.md is generated from the same values).
"""
import os

VERSION = "2.0.0"
HOME = os.environ.get("VOICEBOX_HOME", "/content/voicebox")
VENVS = os.environ.get("VOICEBOX_VENVS", os.path.join(HOME, "venvs"))

# Spoken by Orpheus to create the "female"/"male" reference clips that Chatterbox clones.
REF_TEXT = ("Here's the strange thing about maps. They only help if you know exactly where you're "
            "standing, and that turns out to be a surprisingly hard problem.")
PRESET_REFS = {"female": ("orpheus", "tara"), "male": ("orpheus", "dan")}

ENGINES = {
    "kokoro": {
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
        "kind": "asr",
        "port": 8105,
        "gpu_gb": 6.0,  # large-v3 fp16 weights + batch-4 activations
        "packages": "torch transformers accelerate soundfile scipy",
        "about": "Whisper large-v3 (OpenAI). Best open subtitle model: word-level timestamps, 99 languages.",
        "voices": [],
        "presets": {},
        "params": {},
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

# Delivery styles: per-engine settings measured with scripts/style-bench.py (pitch movement, words per minute,
# Whisper accuracy). A style sets defaults; explicit params / post values in a request still win.
# Findings: Orpheus temperature drives pace and energy (tara 0.6 = 131 wpm with long pauses, 0.9 = 191 wpm, still
# word-perfect); Chatterbox exaggeration widens pitch (female 6 -> 11 semitones) but slurs past ~1.0 on male refs;
# Kokoro's liveliness is mostly the voice (am_fenrir, af_bella, am_puck), speed adds pace.
STYLES = {
    "tech": {
        "label": "Tech explainer", "about": "Bright, quick, confident. YouTube-tech pace (~180 wpm).",
        "params": {"orpheus": {"temperature": 0.85, "top_p": 0.95, "repetition_penalty": 1.1},
                   "chatterbox": {"exaggeration": 0.9, "cfg_weight": 0.3, "temperature": 0.8},
                   "kokoro": {"speed": 1.1}},
        "post": {},
        "voices": {"orpheus": ["tara", "mia", "leo"], "chatterbox": ["female", "male"], "kokoro": ["am_fenrir", "af_bella", "am_puck"]},
    },
    "hype": {
        "label": "Launch / hype", "about": "Maximum energy for promos and hooks (~200 wpm). Check takes: more variation.",
        "params": {"orpheus": {"temperature": 0.9, "top_p": 0.95, "repetition_penalty": 1.1},
                   "chatterbox": {"exaggeration": 1.05, "cfg_weight": 0.3, "temperature": 0.85},
                   "kokoro": {"speed": 1.2}},
        "post": {"tempo": 1.05},
        "voices": {"orpheus": ["mia", "leo", "tara"], "chatterbox": ["female", "male"], "kokoro": ["am_fenrir", "af_bella"]},
    },
    "narrator": {
        "label": "Calm narrator", "about": "Measured documentary read with room to breathe (~135 wpm).",
        "params": {"orpheus": {"temperature": 0.6, "top_p": 0.95, "repetition_penalty": 1.1},
                   "chatterbox": {"exaggeration": 0.4, "cfg_weight": 0.5, "temperature": 0.8},
                   "kokoro": {"speed": 0.95}},
        "post": {},
        "voices": {"orpheus": ["tara", "dan", "leah"], "chatterbox": ["female", "male"], "kokoro": ["af_heart", "bm_george", "af_nicole"]},
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
    return dict(st["params"].get(engine, {})), dict(st["post"])

# Speed priors (seconds of compute per character / per second of audio), refined live by the gateway.
RATE_PRIORS = {"kokoro": 0.004, "chatterbox": 0.06, "orpheus": 0.03, "whisper": 0.06}
INSTALL_PRIORS = {"kokoro": 40, "chatterbox": 150, "orpheus": 240, "whisper": 120}  # first install, seconds
LOAD_PRIORS = {"kokoro": 5, "chatterbox": 45, "orpheus": 120, "whisper": 40}

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
