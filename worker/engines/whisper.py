"""Whisper large-v3 (OpenAI) for subtitles: word-level timestamps, 99 languages, long files chunked at 30 s."""
import os
import numpy as np
import torch

MODEL = os.environ.get("WHISPER_MODEL", "openai/whisper-large-v3")


def load_16k(path):
    import soundfile as sf
    try:
        a, sr = sf.read(path, dtype="float32", always_2d=False)
    except Exception:
        import subprocess, tempfile
        tmp = tempfile.mktemp(suffix=".wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", "16000", tmp], check=True)
        a, sr = sf.read(tmp, dtype="float32", always_2d=False)
        os.remove(tmp)
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != 16000:
        from math import gcd
        from scipy.signal import resample_poly
        g = gcd(16000, sr)
        a = resample_poly(a, 16000 // g, sr // g).astype("float32")
    return a


class Engine:
    def __init__(self):
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if self.dev == "cuda" else torch.float32
        model = AutoModelForSpeechSeq2Seq.from_pretrained(MODEL, torch_dtype=dtype, low_cpu_mem_usage=True).to(self.dev)
        proc = AutoProcessor.from_pretrained(MODEL)
        self.pipe = pipeline("automatic-speech-recognition", model=model, tokenizer=proc.tokenizer,
                             feature_extractor=proc.feature_extractor, torch_dtype=dtype, device=self.dev)

    def transcribe(self, path, language=None, prompt=None):
        a = load_16k(path)
        dur = len(a) / 16000
        gen = {} if MODEL.endswith(".en") else {"task": "transcribe"}
        if language and not MODEL.endswith(".en"):
            gen["language"] = language
        out = self.pipe({"raw": a, "sampling_rate": 16000}, return_timestamps="word",
                        chunk_length_s=30, batch_size=8, generate_kwargs=gen)
        words = []
        for c in out.get("chunks", []):
            s, e = c["timestamp"]
            t = c["text"].strip()
            if not t:
                continue
            s = float(s or (words[-1]["e"] if words else 0.0))
            e = float(e if e is not None else min(dur, s + 0.4))
            words.append({"w": t, "s": round(s, 3), "e": round(max(e, s + 0.05), 3)})
        return {"text": out["text"].strip(), "words": words, "duration": round(dur, 3), "language": language or "auto"}
