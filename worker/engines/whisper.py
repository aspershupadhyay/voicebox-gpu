"""Whisper large-v3-turbo (OpenAI) for subtitles, review and dataset cuts: word-level timestamps, 99 languages, long
files chunked at 30 s and the windows batched as wide as the free GPU memory allows. WHISPER_MODEL=openai/whisper-large-v3
brings back the full decoder (slower, marginally better on hard accents)."""
import os
import numpy as np
import torch

MODEL = os.environ.get("WHISPER_MODEL", "openai/whisper-large-v3-turbo")
# Speaker verification for the "sounds like you" score (and best-of-N takes). Small (~380 MB), loaded on first use.
SV_MODEL = os.environ.get("VOICE_MATCH_MODEL", "microsoft/wavlm-base-plus-sv")
# Naturalness (predicted MOS, 1-5): UTMOS22 "strong" via the SpeechMOS port (pure torch, ~400 MB, first use only).
MOS_REPO, MOS_TAG = os.environ.get("MOS_REPO", "tarepan/SpeechMOS:v1.2.0"), "utmos22_strong"


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
        self.mos_model = None

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

    def mos(self, paths):
        """Predicted naturalness per file (UTMOS22, ~1-5; studio speech ~4+, robotic or glitchy takes < 3.5)."""
        if self.mos_model is None:
            self.mos_model = torch.hub.load(MOS_REPO, MOS_TAG, trust_repo=True).to(self.dev).eval()
        out = []
        for p in paths:
            a = torch.from_numpy(load_16k(p)[: 16000 * 20]).unsqueeze(0).to(self.dev)
            with torch.inference_mode():
                out.append(round(float(self.mos_model(a, 16000)[0]), 3))
        return out

    def _gen(self, language):
        gen = {} if MODEL.endswith(".en") else {"task": "transcribe"}
        if language and not MODEL.endswith(".en"):
            gen["language"] = language
        return gen

    def _batch(self, seconds):
        """How many 30 s windows to decode at once: word timestamps keep the cross-attention maps, ~3.5 GB a window
        (measured: 14 windows of a 7 min file took 47 GB and ran an 80 GB card out), so the batch follows the memory
        actually free right now (Orpheus / vLLM may be sharing the card), capped at 8."""
        if self.dev != "cuda" or seconds <= 30:
            return 1
        free = torch.cuda.mem_get_info()[0] / 2**30
        return int(max(1, min(8, (free - 2.0) // 3.5, seconds // 30 + 1)))

    def _text_batch(self, n):
        """How many short clips to decode at once when only the text is wanted: no word timestamps means no
        cross-attention maps kept, so a clip costs well under 0.5 GB; the batch follows the free memory, capped at 16."""
        if self.dev != "cuda":
            return 1
        free = torch.cuda.mem_get_info()[0] / 2**30
        return int(max(1, min(16, n, (free - 2.0) // 0.5)))

    def transcribe_text(self, paths, language=None):
        """Text only, for the review: every clip up to 30 s goes through one batched pipeline call (Whisper pads each
        to a 30 s window anyway, so batching doesn't change what it hears). Longer clips take the word-timed path."""
        audio = [load_16k(p) for p in paths]
        out = [None] * len(paths)
        short = [i for i, a in enumerate(audio) if len(a) <= 30 * 16000]
        bs = self._text_batch(len(short))
        while short:
            try:
                with torch.inference_mode():
                    res = self.pipe([{"raw": audio[i], "sampling_rate": 16000} for i in short], batch_size=bs,
                                    generate_kwargs=self._gen(language))
                for i, o in zip(short, res):
                    out[i] = {"text": o["text"].strip(), "words": [], "duration": round(len(audio[i]) / 16000, 3),
                              "language": language or "auto"}
                break
            except torch.cuda.OutOfMemoryError:  # another engine took memory meanwhile: halve the batch, never fail
                if bs == 1:
                    raise
                bs = max(1, bs // 2)
            finally:
                if self.dev == "cuda":
                    torch.cuda.empty_cache()
        rest = [i for i in range(len(paths)) if out[i] is None]
        for i, r in zip(rest, self.transcribe_batch([paths[i] for i in rest], language)):
            out[i] = r
        return out

    def transcribe_batch(self, paths, language=None):
        """Word-timed. Clips up to 30 s (a voiceover's lines) go through the pipeline together, as many at once as the
        free GPU memory takes (one 30 s window each, so batching doesn't change what it hears); longer files one at a
        time, their 30 s windows decoded in a batch sized to the free GPU memory."""
        audio = [load_16k(p) for p in paths]
        out = [None] * len(paths)
        short = [i for i, a in enumerate(audio) if len(a) <= 30 * 16000]
        if len(short) > 1 and self.dev == "cuda":
            free = torch.cuda.mem_get_info()[0] / 2**30
            bs = int(max(1, min(16, len(short), (free - 2.0) // 3.5)))
            k = 0
            while k < len(short):
                group = short[k:k + bs]
                try:
                    with torch.inference_mode():
                        res = self.pipe([{"raw": audio[i], "sampling_rate": 16000} for i in group], return_timestamps="word",
                                        batch_size=len(group), generate_kwargs=self._gen(language))
                    for i, o in zip(group, res):
                        out[i] = self._words(o, len(audio[i]) / 16000, language)
                    k += len(group)
                except torch.cuda.OutOfMemoryError:  # another engine took memory meanwhile: halve the batch, never fail
                    if bs == 1:
                        raise
                    bs = max(1, bs // 2)
                finally:
                    torch.cuda.empty_cache()
        for i, p in enumerate(paths):
            if out[i] is not None:
                continue
            a = audio[i]
            bs = self._batch(len(a) / 16000)
            while True:
                try:
                    with torch.inference_mode():
                        o = self.pipe({"raw": a, "sampling_rate": 16000}, return_timestamps="word",
                                      chunk_length_s=30, batch_size=bs, generate_kwargs=self._gen(language))
                    break
                except torch.cuda.OutOfMemoryError:  # another engine took memory meanwhile: halve the batch, never fail
                    if bs == 1:
                        raise
                    bs = max(1, bs // 2)
                finally:
                    if self.dev == "cuda":
                        torch.cuda.empty_cache()
            out[i] = self._words(o, len(a) / 16000, language)
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
