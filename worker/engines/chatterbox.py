"""Chatterbox (Resemble AI). English model + lazily-loaded multilingual model + lazily-loaded voice conversion (VC)."""
import torch


def _device():
    if torch.cuda.is_available():
        return "cuda"
    return "mps" if torch.backends.mps.is_available() else "cpu"


class Engine:
    def __init__(self):
        self.device = _device()
        if self.device != "cuda":  # checkpoints were saved on CUDA
            _load = torch.load
            torch.load = lambda *a, **kw: _load(*a, **{**kw, "map_location": torch.device(self.device)})
        from chatterbox.tts import ChatterboxTTS
        self.en = ChatterboxTTS.from_pretrained(device=self.device)
        self.mtl = None
        self.vc = None

    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        torch.manual_seed(int(params.get("seed", 7)))
        kw = dict(exaggeration=params["exaggeration"], cfg_weight=params["cfg_weight"], temperature=params["temperature"])
        lang = (params.get("language") or "en").lower()
        if lang != "en":
            if self.mtl is None:
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS
                self.mtl = ChatterboxMultilingualTTS.from_pretrained(device=self.device)
            wav = self.mtl.generate(text, language_id=lang, audio_prompt_path=ref_path, **kw)
            sr = self.mtl.sr
        else:
            wav = self.en.generate(text, audio_prompt_path=ref_path, **kw)
            sr = self.en.sr
        return wav.squeeze().float().cpu().numpy(), sr

    def revoice(self, src_path, ref_path):
        """Speech-to-speech: the words, timing and delivery of src_path in the voice of ref_path."""
        if self.vc is None:
            from chatterbox.vc import ChatterboxVC
            self.vc = ChatterboxVC.from_pretrained(self.device)
        wav = self.vc.generate(audio=src_path, target_voice_path=ref_path)
        if self.device == "cuda":
            torch.cuda.empty_cache()
        return wav.squeeze().float().cpu().numpy(), self.vc.sr
