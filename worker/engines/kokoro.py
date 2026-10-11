"""Kokoro-82M via kokoro-onnx (CPU)."""
import os, urllib.request

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"


def _fetch(name, folder):
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        os.makedirs(folder, exist_ok=True)
        urllib.request.urlretrieve(f"{BASE}/{name}", path + ".part")
        os.replace(path + ".part", path)
    return path


LANG_BY_PREFIX = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}


class Engine:
    def __init__(self):
        from kokoro_onnx import Kokoro
        folder = os.environ.get("KOKORO_MODEL_DIR", os.path.join(os.environ.get("VOICEBOX_HOME", "/content/voicebox"), "models", "kokoro"))
        model = os.environ.get("KOKORO_MODEL") or _fetch("kokoro-v1.0.onnx", folder)
        voices = os.environ.get("KOKORO_VOICES") or _fetch("voices-v1.0.bin", folder)
        self.k = Kokoro(model, voices)

    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        voice = voice or "af_heart"
        # the voice's first letter is its language: a=US English, b=UK English, e=Spanish, f=French, h=Hindi,
        # i=Italian, j=Japanese, p=Brazilian Portuguese, z=Mandarin
        lang = params.get("lang") or LANG_BY_PREFIX.get(voice[0], "en-us")
        audio, sr = self.k.create(text, voice=voice, speed=float(params.get("speed", 1.0)), lang=lang)
        return audio, sr
