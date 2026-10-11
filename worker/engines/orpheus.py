"""Orpheus 3B (Canopy Labs) through plain transformers + the SNAC 24 kHz codec."""
import os
import torch

MODEL = os.environ.get("ORPHEUS_MODEL", "unsloth/orpheus-3b-0.1-ft")  # ungated mirror of canopylabs/orpheus-3b-0.1-ft
START, END_TEXT, END_HUMAN, START_AUDIO, END_AUDIO, CODE_OFFSET = 128259, 128009, 128260, 128257, 128258, 128266


class Engine:
    def __init__(self):
        from transformers import AutoTokenizer, AutoModelForCausalLM
        from snac import SNAC
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if self.dev == "cuda" and torch.cuda.is_bf16_supported() else torch.float16
        self.tok = AutoTokenizer.from_pretrained(MODEL)
        self.model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=dtype).to(self.dev)
        self.model.train(False)
        self.snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to(self.dev)
        self.snac.train(False)

    def synth(self, text, voice, params, ref_path=None, ref_text=None):
        torch.manual_seed(int(params.get("seed", 7)))
        ids = self.tok(f"{voice or 'tara'}: {text}", return_tensors="pt").input_ids
        ids = torch.cat([torch.tensor([[START]]), ids, torch.tensor([[END_TEXT, END_HUMAN]])], dim=1).to(self.dev)
        with torch.no_grad():
            out = self.model.generate(ids, attention_mask=torch.ones_like(ids), do_sample=True,
                                      max_new_tokens=int(params["max_new_tokens"]), temperature=params["temperature"],
                                      top_p=params["top_p"], repetition_penalty=params["repetition_penalty"],
                                      eos_token_id=END_AUDIO)
        gen = out[0][ids.shape[1]:]
        marks = (gen == START_AUDIO).nonzero()
        if len(marks):
            gen = gen[marks[-1].item() + 1:]
        gen = gen[gen != END_AUDIO]
        n = (len(gen) // 7) * 7
        if n == 0:
            raise RuntimeError("Orpheus produced no audio tokens")
        c = [t - CODE_OFFSET for t in gen[:n].tolist()]
        l1, l2, l3 = [], [], []
        for i in range(n // 7):
            b = 7 * i
            l1.append(c[b]); l2.append(c[b + 1] - 4096)
            l3.append(c[b + 2] - 2 * 4096); l3.append(c[b + 3] - 3 * 4096)
            l2.append(c[b + 4] - 4 * 4096)
            l3.append(c[b + 5] - 5 * 4096); l3.append(c[b + 6] - 6 * 4096)
        codes = [torch.tensor(x).unsqueeze(0).clamp(0, 4095).to(self.dev) for x in (l1, l2, l3)]
        with torch.no_grad():
            audio = self.snac.decode(codes)
        return audio.squeeze().float().cpu().numpy(), 24000
