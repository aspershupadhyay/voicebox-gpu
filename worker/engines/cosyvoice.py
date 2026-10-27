"""CosyVoice 2 (Alibaba FunAudioLLM, Apache-2.0): zero-shot voice cloning built for speed, a 0.5B Qwen2 LM that
writes 25 Hz speech tokens and a flow-matching decoder that turns them into 24 kHz audio, chunk by chunk.

Clones your recorded voice like Qwen does (a 10-20 s reference and its transcript; without a transcript it clones
the timbre only, cross-lingual mode). The reference is turned into its prompt once and kept (one per recording).

CosyVoice isn't on PyPI: its code is fetched at a pinned commit, with Matcha-TTS (its decoder's building blocks),
into the venv's folder on the first load. ModelScope is only used by its own downloader, so it is stubbed and the
weights come from Hugging Face (COSYVOICE_MODEL; FunAudioLLM/Fun-CosyVoice3-0.5B-2512 works too).
"""
import os
import subprocess
import sys
import types

import torch

MODEL = os.environ.get("COSYVOICE_MODEL", "FunAudioLLM/CosyVoice2-0.5B")
COMMIT = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
SRC = os.environ.get("COSYVOICE_SRC") or os.path.join(os.path.dirname(os.path.dirname(sys.executable)), "CosyVoice")


def _fetch_code():
    """The CosyVoice repo at COMMIT (and its Matcha-TTS submodule), shallow."""
    if os.path.exists(os.path.join(SRC, "cosyvoice", "cli", "cosyvoice.py")) and \
            os.path.exists(os.path.join(SRC, "third_party", "Matcha-TTS", "matcha")):
        return
    tmp = SRC + ".part"
    subprocess.run(["rm", "-rf", tmp], check=True)
    run = lambda *a: subprocess.run(["git", "-C", tmp, *a], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.makedirs(tmp)
    run("init", "-q")
    run("remote", "add", "origin", "https://github.com/FunAudioLLM/CosyVoice.git")
    run("fetch", "-q", "--depth", "1", "origin", COMMIT)
    run("checkout", "-q", "FETCH_HEAD")
    run("submodule", "update", "--init", "--depth", "1")
    subprocess.run(["rm", "-rf", SRC], check=True)
    os.replace(tmp, SRC)


def _stub_modelscope():
    try:
        import modelscope  # noqa: F401
    except ImportError:
        ms = types.ModuleType("modelscope")
        ms.snapshot_download = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("modelscope downloads are off; pass a local folder"))
        sys.modules["modelscope"] = ms


class Engine:
    def __init__(self):
        _fetch_code()
        _stub_modelscope()
        sys.path[:0] = [SRC, os.path.join(SRC, "third_party", "Matcha-TTS")]
        from huggingface_hub import snapshot_download
        from cosyvoice.cli.cosyvoice import AutoModel
        path = MODEL if os.path.isdir(MODEL) else snapshot_download(MODEL, ignore_patterns=["*.fp32.onnx", "*.batch.onnx", "asset/*"])
        cuda = torch.cuda.is_available()
        self.model = AutoModel(model_dir=path, fp16=cuda)
        self.sr = self.model.sample_rate
        self.spk = {}  # (ref_path, mtime, has transcript) -> prompt id in the model's speaker table

    def _speaker(self, ref_path, ref_text):
        key = (ref_path, os.path.getmtime(ref_path), bool(ref_text))
        if key not in self.spk:
            sid = f"ref{len(self.spk)}"
            # no transcript: synth uses cross-lingual mode, which leaves the reference out of the LM prompt (timbre only)
            self.model.add_zero_shot_spk(ref_text or "", ref_path, sid)
            self.spk[key] = sid
        return self.spk[key]

    @torch.inference_mode()
    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        import numpy as np
        if not ref_path:
            raise ValueError("cosyvoice clones a reference voice: pick a recording (or the female/male presets)")
        sid = self._speaker(ref_path, ref_text)
        torch.manual_seed(int(params.get("seed", 7)))
        speed = float(params.get("speed", 1.0))
        run = self.model.inference_zero_shot(text, "", "", zero_shot_spk_id=sid, stream=False, speed=speed) if ref_text \
            else self.model.inference_cross_lingual(text, "", zero_shot_spk_id=sid, stream=False, speed=speed)
        parts = [out["tts_speech"].squeeze(0).float().cpu().numpy() for out in run]
        if not parts:
            raise RuntimeError("CosyVoice returned no audio")
        return np.concatenate(parts).astype("float32"), self.sr

    def synth_batch(self, items, emit=None):
        """One line after another (CosyVoice decodes one request at a time), each handed to emit the moment it's done
        so a voiceover plays while the rest is made; a failing line fails alone."""
        out = []
        for j, it in enumerate(items):
            try:
                out.append(self.synth(it["text"], it.get("voice"), it.get("params") or {}, it.get("ref_path"), it.get("ref_text")))
                if emit:
                    emit(j, out[-1])
            except Exception as e:  # noqa: BLE001
                out.append(e)
        return out
