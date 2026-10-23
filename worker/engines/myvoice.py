"""Trained voices: Orpheus 3B fine-tuned on a person's recordings (train.py). Same runtime as the orpheus engine (vLLM
+ SNAC), same tags (<laugh>, <sigh>...).

One engine serves everyone's models: each chunk names its adapter ("lora": a local dir the gateway downloaded from the
dashboard's storage, see gateway.get_adapter), and vLLM switches adapters per request, so both people's voices work in
one job queue without restarting anything. A chunk without one uses the default adapter, first match wins:
  1. MY_VOICE_MODEL: a full Orpheus fine-tune on Hugging Face (private repos read with HF_TOKEN; no adapters then)
  2. $VOICEBOX_HOME/myvoice/adapter: the adapter the last train job on this worker wrote
  3. MY_VOICE_ADAPTER_URL: the newest adapter in the dashboard's storage (a signed link from /api/worker-env)

An adapter trained with flow (voicebox.json "context": true, see train.py) also gets each chunk's previous chunk as
context, so a long script sounds like one take instead of sentences read one at a time.
"""
import io, json, os, shutil, urllib.request, zipfile

MODEL = os.environ.get("MY_VOICE_MODEL", "").strip()
ADAPTER = os.path.join(os.environ.get("VOICEBOX_HOME", "/content/voicebox"), "myvoice", "adapter")

if MODEL:
    os.environ["ORPHEUS_MODEL"] = MODEL  # read by engines.orpheus at import
else:
    os.environ["ORPHEUS_ENABLE_LORA"] = "1"
    if not os.path.exists(os.path.join(ADAPTER, "adapter_config.json")):
        url = os.environ.get("MY_VOICE_ADAPTER_URL", "").strip()
        if url:
            try:
                tmp = ADAPTER + ".part"
                shutil.rmtree(tmp, ignore_errors=True)
                with urllib.request.urlopen(url, timeout=600) as r:
                    zipfile.ZipFile(io.BytesIO(r.read())).extractall(tmp)
                shutil.rmtree(ADAPTER, ignore_errors=True)
                os.replace(tmp, ADAPTER)
            except Exception as e:  # noqa: BLE001  jobs bring their own adapter anyway
                print(f"[myvoice] could not fetch the default model ({type(e).__name__}: {e})", flush=True)
    if os.path.exists(os.path.join(ADAPTER, "adapter_config.json")):
        os.environ["ORPHEUS_LORA"] = ADAPTER
from engines.orpheus import Engine as _Orpheus  # noqa: E402

SPEAKER = os.environ.get("MY_VOICE_SPEAKER", "me")


def trained(path):
    """What train.py recorded about an adapter (voicebox.json), or {} for an older one."""
    try:
        return json.load(open(os.path.join(path, "voicebox.json")))
    except (OSError, ValueError):
        return {}


class Engine(_Orpheus):
    def __init__(self):
        super().__init__()
        self.loras, self.meta, self.loaded = {}, {}, set()
        self.default = None if MODEL or not os.environ.get("ORPHEUS_LORA") else ADAPTER

    def _path(self, item):
        path = item.get("lora") or self.default
        if not path and not MODEL:
            raise RuntimeError("No trained voice yet. Collect 15+ minutes on the Your model page and press Train.")
        return path

    def _flows(self, item):
        path = None if MODEL else (item.get("lora") or self.default)
        if not path:
            return False
        if path not in self.meta:
            self.meta[path] = trained(path)
        return bool(self.meta[path].get("context"))

    def _lora(self, item):
        path = self._path(item)
        if not path:
            return None
        if path == self.default and self.lora_req is not None:
            return self.lora_req
        if path not in self.loras:
            from vllm.lora.request import LoRARequest
            self.loras[path] = LoRARequest(f"voice{len(self.loras) + 2}", len(self.loras) + 2, path)
        return self.loras[path]

    def _activate(self, item):
        path = self._path(item)
        if not path:
            return
        from peft import PeftModel
        name = f"voice{abs(hash(path)) % 10**8}"
        if not isinstance(self.model, PeftModel):
            self.model = PeftModel.from_pretrained(self.model, path, adapter_name=name)
            self.model.train(False)
        elif name not in self.loaded:
            self.model.load_adapter(path, adapter_name=name)
        self.loaded.add(name)
        self.model.set_adapter(name)

    def _prompt(self, text, voice):
        return super()._prompt(text, voice if voice and voice not in ("female", "male", "default") else SPEAKER)
