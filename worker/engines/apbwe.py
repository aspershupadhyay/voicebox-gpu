"""AP-BWE (Lu, Ai, Du, Ling 2024; MIT, code and weights): speech bandwidth extension, 24 kHz -> 48 kHz.

Studio polish for generated speech: the voice engines speak at 24 kHz, so nothing above 12 kHz is there; AP-BWE
predicts the missing high band's amplitude and phase in one pass of a small all-convolutional network (no diffusion
or flow steps: hundreds of times faster than real time on a GPU). The low band passes through as it was, so it
can't change who the voice sounds like, unlike Resemble Enhance, which redraws the whole spectrum.

The generator below is the paper's (github.com/yxlu-0102/AP-BWE, models/model.py), trimmed to inference. Weights:
the authors' VCTK 24k->48k checkpoint, from an MIT mirror on Hugging Face in safetensors (no pickle).
"""
import json
import os

import numpy as np
import torch
import torch.nn as nn

REPO = os.environ.get("APBWE_REPO", "rsxdalv/AP-BWE")
SUB = "weights/24kto48k"


class ConvNeXtBlock(nn.Module):
    def __init__(self, dim, layer_scale_init_value):
        super().__init__()
        self.dwconv = nn.Conv1d(dim, dim, kernel_size=7, padding=3, groups=dim)
        self.norm = nn.LayerNorm(dim, eps=1e-6)
        self.pwconv1 = nn.Linear(dim, dim * 3)
        self.act = nn.GELU()
        self.pwconv2 = nn.Linear(dim * 3, dim)
        self.gamma = nn.Parameter(layer_scale_init_value * torch.ones(dim)) if layer_scale_init_value > 0 else None

    def forward(self, x):
        residual = x
        x = self.dwconv(x).transpose(1, 2)
        x = self.pwconv2(self.act(self.pwconv1(self.norm(x))))
        if self.gamma is not None:
            x = self.gamma * x
        return residual + x.transpose(1, 2)


class APNetBWE(nn.Module):
    def __init__(self, h):
        super().__init__()
        ch, bins, layers = h["ConvNeXt_channels"], h["n_fft"] // 2 + 1, h["ConvNeXt_layers"]
        self.conv_pre_mag = nn.Conv1d(bins, ch, 7, 1, padding=3)
        self.norm_pre_mag = nn.LayerNorm(ch, eps=1e-6)
        self.conv_pre_pha = nn.Conv1d(bins, ch, 7, 1, padding=3)
        self.norm_pre_pha = nn.LayerNorm(ch, eps=1e-6)
        self.convnext_mag = nn.ModuleList([ConvNeXtBlock(ch, 1 / layers) for _ in range(layers)])
        self.convnext_pha = nn.ModuleList([ConvNeXtBlock(ch, 1 / layers) for _ in range(layers)])
        self.norm_post_mag = nn.LayerNorm(ch, eps=1e-6)
        self.norm_post_pha = nn.LayerNorm(ch, eps=1e-6)
        self.linear_post_mag = nn.Linear(ch, bins)
        self.linear_post_pha_r = nn.Linear(ch, bins)
        self.linear_post_pha_i = nn.Linear(ch, bins)

    def forward(self, mag_nb, pha_nb):
        x_mag = self.norm_pre_mag(self.conv_pre_mag(mag_nb).transpose(1, 2)).transpose(1, 2)
        x_pha = self.norm_pre_pha(self.conv_pre_pha(pha_nb).transpose(1, 2)).transpose(1, 2)
        for block_mag, block_pha in zip(self.convnext_mag, self.convnext_pha):
            x_mag = x_mag + x_pha
            x_pha = x_pha + x_mag
            x_mag = block_mag(x_mag)
            x_pha = block_pha(x_pha)
        mag_wb = mag_nb + self.linear_post_mag(self.norm_post_mag(x_mag.transpose(1, 2))).transpose(1, 2)
        x_pha = self.norm_post_pha(x_pha.transpose(1, 2))
        pha_wb = torch.atan2(self.linear_post_pha_i(x_pha), self.linear_post_pha_r(x_pha)).transpose(1, 2)
        return mag_wb, pha_wb


class Engine:
    def __init__(self):
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.h = json.load(open(hf_hub_download(REPO, f"{SUB}/config.json")))
        self.model = APNetBWE(self.h)
        self.model.load_state_dict(load_file(hf_hub_download(REPO, f"{SUB}/g_24kto48k.safetensors")))
        self.model = self.model.eval().to(self.dev)
        self.window = torch.hann_window(self.h["win_size"]).to(self.dev)

    def _stft(self, a):
        spec = torch.stft(a, self.h["n_fft"], hop_length=self.h["hop_size"], win_length=self.h["win_size"],
                          window=self.window, center=True, pad_mode="reflect", return_complex=True)
        return torch.log(spec.abs() + 1e-4), torch.angle(spec)

    def _istft(self, log_amp, pha):
        amp = torch.exp(log_amp)
        return torch.istft(torch.complex(amp * torch.cos(pha), amp * torch.sin(pha)), self.h["n_fft"],
                           hop_length=self.h["hop_size"], win_length=self.h["win_size"], window=self.window, center=True)

    @torch.inference_mode()
    def extend(self, audio, sr):
        """float32 mono audio at any rate -> (48 kHz audio, 48000). The input is brought to the model's narrow band
        (24 kHz) and back up to 48 kHz first, as in training; long files go through in 60 s pieces with a short
        overlap, crossfaded, so memory stays flat."""
        import torchaudio.functional as aF
        hr, lr = self.h["hr_sampling_rate"], self.h["lr_sampling_rate"]
        x = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).to(self.dev)[None]
        if sr != lr:
            x = aF.resample(x, sr, lr)
        x = aF.resample(x, lr, hr)
        n = x.shape[1]
        seg, ov = 60 * hr, hr // 4
        if n <= seg + ov:
            return self._run(x)[0, :n].float().cpu().numpy(), hr
        out = torch.zeros(n, device=self.dev)
        fade = torch.linspace(0, 1, ov, device=self.dev)
        start = 0
        while True:  # each piece after the first starts ov samples before the previous one ended
            end = min(n, start + seg + ov)
            y = self._run(x[:, start:end])[0, : end - start]
            if start:
                y[:ov] *= fade
                out[start:start + ov] *= 1 - fade
            out[start:end] += y
            if end >= n:
                break
            start += seg
        return out.float().cpu().numpy(), hr

    def _run(self, x):
        log_amp, pha = self._stft(x)
        mag_wb, pha_wb = self.model(log_amp, pha)
        return self._istft(mag_wb, pha_wb)

    def enhance(self, src_path, params):
        """The enhance engine's interface (studio polish): -> (float32 mono audio, sample rate)."""
        import soundfile as sf
        a, sr = sf.read(src_path, dtype="float32", always_2d=False)
        if a.ndim > 1:
            a = a.mean(axis=1)
        try:
            return self.extend(a, sr)
        finally:
            if self.dev == "cuda":
                torch.cuda.empty_cache()

    def enhance_batch(self, items):
        out = []
        for it in items:
            try:
                out.append(self.enhance(it["src_path"], it.get("params") or {}))
            except Exception as e:  # noqa: BLE001
                out.append(e)
        return out
