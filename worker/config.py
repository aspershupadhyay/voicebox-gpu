"""Engine catalogue: how to install each engine, what it costs in GPU memory, and its parameters.

Everything the API exposes about voices and parameters comes from here, so this file is the single
source of truth for defaults and ranges (docs/API.md is generated from the same values).
"""
import os

VERSION = "1.0.0"
HOME = os.environ.get("VOICEBOX_HOME", "/content/voicebox")
VENVS = os.environ.get("VOICEBOX_VENVS", os.path.join(HOME, "venvs"))

# Spoken by Orpheus to create the "female"/"male" reference clips that Dia and Chatterbox clone.
REF_TEXT = ("Here's the strange thing about maps. They only help if you know exactly where you're "
            "standing, and that turns out to be a surprisingly hard problem.")
PRESET_REFS = {"female": ("orpheus", "tara"), "male": ("orpheus", "dan")}

ENGINES = {
    "kokoro": {
        "port": 8101,
        "gpu_gb": 0.0,  # onnxruntime on CPU: instant drafts, never competes for VRAM
        "packages": "kokoro-onnx soundfile numpy",
        "about": "Kokoro-82M. Fast, clean, flat delivery. Best for drafts and timing.",
        "voices": ["af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "af_alloy", "af_nova",
                   "af_sky", "af_jessica", "af_river", "am_fenrir", "am_michael", "am_puck", "am_echo", "am_eric",
                   "am_liam", "am_onyx", "am_santa", "am_adam", "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
                   "bm_fable", "bm_george", "bm_lewis", "bm_daniel", "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
                   "ff_siwis", "if_sara", "im_nicola", "jf_alpha", "ef_dora", "em_alex", "pf_dora", "pm_alex"],
        "presets": {"female": "af_heart", "male": "am_michael"},
        "params": {
            "speed": {"type": "number", "default": 1.0, "min": 0.5, "max": 2.0, "about": "speaking rate"},
            "lang": {"type": "string", "default": "", "about": "phonemizer override, e.g. en-us, en-gb, hi"},
        },
    },
    "chatterbox": {
        "port": 8102,
        "gpu_gb": 4.0,
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
        "port": 8103,
        "gpu_gb": 9.0,
        "packages": "torch transformers accelerate snac soundfile",
        "about": "Orpheus 3B. Most human-sounding; inline tags <laugh> <chuckle> <sigh> <cough> <sniffle> <groan> <yawn> <gasp>.",
        "voices": ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"],
        "presets": {"female": "tara", "male": "dan"},
        "params": {
            "temperature": {"type": "number", "default": 0.6, "min": 0.1, "max": 1.5},
            "top_p": {"type": "number", "default": 0.95, "min": 0.1, "max": 1.0},
            "repetition_penalty": {"type": "number", "default": 1.1, "min": 1.0, "max": 2.0,
                                   "about": ">= 1.1 needed for stable output"},
            "max_new_tokens": {"type": "integer", "default": 1800, "min": 200, "max": 4000},
            "seed": {"type": "integer", "default": 7},
        },
    },
    "dia": {
        "port": 8104,
        "gpu_gb": 7.0,
        "packages": "git+https://github.com/nari-labs/dia.git soundfile",
        "about": "Dia 1.6B (Nari Labs). Dialogue-native ([S1]/[S2]), non-verbals like (laughs) (sighs); clones from a reference.",
        "voices": ["female", "male", "<any reference name with a transcript>"],
        "presets": {"female": "female", "male": "male"},
        "params": {
            "cfg_scale": {"type": "number", "default": 3.0, "min": 1.0, "max": 5.0},
            "temperature": {"type": "number", "default": 1.3, "min": 0.5, "max": 2.0},
            "top_p": {"type": "number", "default": 0.95, "min": 0.5, "max": 1.0},
            "cfg_filter_top_k": {"type": "integer", "default": 45, "min": 10, "max": 100},
            "seed": {"type": "integer", "default": 7},
        },
    },
}

POST_DEFAULTS = {
    "trim": True,            # trim leading/trailing silence (keeps 60 ms of air)
    "trim_db": -45.0,
    "normalize_dbfs": -3.0,  # peak-normalise; null to keep the engine's level
    "sample_rate": 48000,    # resample for video timelines; null keeps native
}


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
    override = os.environ.get(f"VOICEBOX_PY_{engine.upper()}")
    return override or os.path.join(VENVS, engine, "bin", "python")
