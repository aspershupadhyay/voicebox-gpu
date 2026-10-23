"""Your own voice model: Orpheus 3B fine-tuned on your recordings (notebook/train_my_voice.ipynb), loaded from the
Hugging Face repo the training notebook pushed (MY_VOICE_MODEL, private repos read with HF_TOKEN). Same runtime as the
orpheus engine (vLLM + SNAC), same tags (<laugh>, <sigh>...), one speaker: the name you trained with (MY_VOICE_SPEAKER)."""
import os

MODEL = os.environ.get("MY_VOICE_MODEL", "").strip()
if not MODEL:
    raise RuntimeError("MY_VOICE_MODEL is not set. Train your voice (dashboard: Your model), then set MY_VOICE_MODEL to the "
                       "Hugging Face repo the training notebook pushed (Vercel env, or Colab Secrets).")
os.environ["ORPHEUS_MODEL"] = MODEL  # read by engines.orpheus at import
from engines.orpheus import Engine as _Orpheus  # noqa: E402

SPEAKER = os.environ.get("MY_VOICE_SPEAKER", "me")


class Engine(_Orpheus):
    def _prompt(self, text, voice):
        return super()._prompt(text, voice if voice and voice not in ("female", "male", "default") else SPEAKER)
