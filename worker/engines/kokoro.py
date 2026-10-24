"""Kokoro-82M via kokoro-onnx (CPU)."""
import os, subprocess, sys, urllib.request

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"


def _fetch(name, folder):
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        os.makedirs(folder, exist_ok=True)
        urllib.request.urlretrieve(f"{BASE}/{name}", path + ".part")
        os.replace(path + ".part", path)
    return path


LANG_BY_PREFIX = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}


def _ja_g2p():
    """espeak-ng (kokoro-onnx's phonemizer) can't read kanji and spells them out one by one; misaki's
    pyopenjtalk front end is what Kokoro was trained with. Installed on first Japanese use only."""
    try:
        from misaki import ja
    except ImportError:
        subprocess.check_call(["uv", "pip", "install", "--python", sys.executable, "-q", "misaki", "pyopenjtalk", "jaconv", "mojimoji"])  # venvs are uv-made: no pip
        from misaki import ja
    return ja.JAG2P(version="pyopenjtalk")


class Engine:
    def __init__(self):
        from kokoro_onnx import Kokoro
        folder = os.environ.get("KOKORO_MODEL_DIR", os.path.join(os.environ.get("VOICEBOX_HOME", "/content/voicebox"), "models", "kokoro"))
        model = os.environ.get("KOKORO_MODEL") or _fetch("kokoro-v1.0.onnx", folder)
        voices = os.environ.get("KOKORO_VOICES") or _fetch("voices-v1.0.bin", folder)
        self.k = Kokoro(model, voices)
        self.ja = None
        self.styles = {}

    def _style(self, path):
        """A voice found for someone (voicewalk.py): its style tensor, read once per file."""
        import numpy as np
        key = (path, os.path.getmtime(path))
        if key not in self.styles:
            self.styles = {k: v for k, v in self.styles.items() if k[0] != path}
            self.styles[key] = np.load(path).astype("float32")
        return self.styles[key]

    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        voice = voice or "af_heart"
        # the voice's first letter is its language: a=US English, b=UK English, e=Spanish, f=French, h=Hindi,
        # i=Italian, j=Japanese, p=Brazilian Portuguese, z=Mandarin. A found voice (kv_*, ref_path = its .npy) is English.
        lang = params.get("lang") or LANG_BY_PREFIX.get(voice[0], "en-us")
        if ref_path and ref_path.endswith(".npy"):
            voice = self._style(ref_path)
        speed = float(params.get("speed", 1.0))
        if lang == "ja":
            self.ja = self.ja or _ja_g2p()
            phonemes, _ = self.ja(text)
            audio, sr = self.k.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
        else:
            audio, sr = self.k.create(text, voice=voice, speed=speed, lang=lang)
        return audio, sr
