"""Your own voice model: Orpheus 3B fine-tuned on your recordings. Same runtime as the orpheus engine (vLLM + SNAC),
same tags (<laugh>, <sigh>...), one speaker: the name you trained with (MY_VOICE_SPEAKER, default "me").

An adapter trained with flow (adapter/voicebox.json "context": true, see train.py) also gets each chunk's previous
chunk as context, so a long script sounds like one take instead of sentences read one at a time.

Where the model comes from, first match wins:
  1. MY_VOICE_MODEL: a full Orpheus fine-tune on Hugging Face (private repos read with HF_TOKEN)
  2. $VOICEBOX_HOME/myvoice/adapter: the LoRA adapter a train job on this worker just wrote
  3. MY_VOICE_ADAPTER_URL: the same adapter kept in R2 by the dashboard (a signed link from /api/worker-env), for a fresh runtime
"""
import io, json, os, shutil, urllib.request, zipfile

MODEL = os.environ.get("MY_VOICE_MODEL", "").strip()
ADAPTER = os.path.join(os.environ.get("VOICEBOX_HOME", "/content/voicebox"), "myvoice", "adapter")

if MODEL:
    os.environ["ORPHEUS_MODEL"] = MODEL  # read by engines.orpheus at import
else:
    if not os.path.exists(os.path.join(ADAPTER, "adapter_config.json")):
        url = os.environ.get("MY_VOICE_ADAPTER_URL", "").strip()
        if not url:
            raise RuntimeError("No trained voice yet. Collect 15+ minutes on the Your model page and press Train.")
        tmp = ADAPTER + ".part"
        shutil.rmtree(tmp, ignore_errors=True)
        with urllib.request.urlopen(url, timeout=600) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extractall(tmp)
        shutil.rmtree(ADAPTER, ignore_errors=True)
        os.replace(tmp, ADAPTER)
    os.environ["ORPHEUS_LORA"] = ADAPTER
from engines.orpheus import Engine as _Orpheus  # noqa: E402

SPEAKER = os.environ.get("MY_VOICE_SPEAKER", "me")


def _trained():
    try:
        return json.load(open(os.path.join(ADAPTER, "voicebox.json")))
    except (OSError, ValueError):
        return {}


class Engine(_Orpheus):
    def __init__(self):
        super().__init__()
        self.context = not MODEL and bool(_trained().get("context"))
        print(f"[myvoice] flow between chunks: {'on' if self.context else 'off (retrain to turn it on)'}", flush=True)

    def _prompt(self, text, voice):
        return super()._prompt(text, voice if voice and voice not in ("female", "male", "default") else SPEAKER)
