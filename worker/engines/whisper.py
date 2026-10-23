"""Whisper large-v3 (OpenAI) for subtitles: word-level timestamps, 99 languages, long files chunked at 30 s."""
import os
import numpy as np
import torch

MODEL = os.environ.get("WHISPER_MODEL", "openai/whisper-large-v3")
# Speaker verification for the "sounds like you" score (and best-of-N takes). Small (~380 MB), loaded on first use.
SV_MODEL = os.environ.get("VOICE_MATCH_MODEL", "microsoft/wavlm-base-plus-sv")


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
        self.sv = None

    def similarity(self, ref, paths):
        """Cosine similarity of WavLM x-vectors, each file vs the reference. ~0.86+ is the model card's same-speaker
        threshold; a good clone of a clean recording usually lands around 0.90-0.97."""
        if self.sv is None:
            from transformers import AutoFeatureExtractor, WavLMForXVector
            self.sv = (AutoFeatureExtractor.from_pretrained(SV_MODEL), WavLMForXVector.from_pretrained(SV_MODEL).to(self.dev).eval())
        fe, model = self.sv

        def emb(p):
            a = load_16k(p)[: 16000 * 20]  # 20 s is plenty for a voice print
            x = fe(a, sampling_rate=16000, return_tensors="pt").to(self.dev)
            with torch.inference_mode():
                return torch.nn.functional.normalize(model(**x).embeddings, dim=-1)[0]
        r = emb(ref)
        return [round(float((r * emb(p)).sum()), 3) for p in paths]

    def _gen(self, language):
        gen = {} if MODEL.endswith(".en") else {"task": "transcribe"}
        if language and not MODEL.endswith(".en"):
            gen["language"] = language
        return gen

    def transcribe_batch(self, paths, language=None):
        """One file at a time: word timestamps need the attention maps, which are large, so batching
        windows would blow past the GPU memory left next to Orpheus. Long files are chunked at 30 s."""
        out = []
        for p in paths:
            a = load_16k(p)
            try:
                with torch.inference_mode():
                    o = self.pipe({"raw": a, "sampling_rate": 16000}, return_timestamps="word",
                                  chunk_length_s=30, batch_size=1, generate_kwargs=self._gen(language))
                out.append(self._words(o, len(a) / 16000, language))
            finally:
                if self.dev == "cuda":
                    torch.cuda.empty_cache()
        return out

    def transcribe(self, path, language=None, prompt=None):
        return self.transcribe_batch([path], language)[0]

    def _words(self, out, dur, language):
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
