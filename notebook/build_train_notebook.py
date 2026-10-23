"""Build notebook/train_my_voice.ipynb: fine-tune Orpheus 3B on your own recordings on a free Colab T4.

  python3 notebook/build_train_notebook.py
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "notebook", "train_my_voice.ipynb")


def md(src):
    return {"cell_type": "markdown", "metadata": {}, "source": src.strip().splitlines(True)}


def code(src):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": src.strip().splitlines(True)}


cells = [
    md("""
# Train your own voice

Fine-tunes **Orpheus 3B** (the most human-sounding open voice model) on the clips you collected on the dashboard's
**Your model** page, with a LoRA adapter (Unsloth), on a **free Colab T4**. Then it pushes the merged model to a private
Hugging Face repo that the voicebox worker loads as the `myvoice` engine.

**Time:** about 1-2 hours for 30-60 minutes of audio. **Cost:** free (Colab free tier, or Kaggle's free 30 GPU-hours a week).

**Before you run:** Runtime → Change runtime type → **T4 GPU**. In 🔑 *Secrets* (left sidebar) add, with notebook access on:

| Secret | What |
|---|---|
| `DASHBOARD_URL` | e.g. `https://your-app.vercel.app` |
| `MCP_TOKEN` | the same token the MCP and the dashboard use |
| `HF_TOKEN` | a Hugging Face token with **write** access (hf.co/settings/tokens) |

Then edit the settings cell and **Run all**.
"""),
    code("""
# ── settings
DATASET = "me"                       # the dataset name on the Your model page
HF_REPO = "your-hf-username/my-voice-orpheus"  # where the trained model goes (created private)
SPEAKER = "me"                       # the speaker name the model learns (set MY_VOICE_SPEAKER to the same)
EPOCHS = None                        # None = automatic (3 for < 40 min of audio, else 2)
LEARNING_RATE = 2e-4
"""),
    code("""
%%capture
!pip install -q unsloth snac soundfile
"""),
    code("""
# ── fetch the dataset (every collected session) from the dashboard
import json, os, urllib.request, zipfile, io
from google.colab import userdata
BASE = userdata.get("DASHBOARD_URL").rstrip("/")
TOKEN = userdata.get("MCP_TOKEN")
HF_TOKEN = userdata.get("HF_TOKEN")
req = urllib.request.Request(f"{BASE}/api/dash/datasets/{DATASET}/manifest", headers={"Authorization": f"Bearer {TOKEN}"})
manifest = json.load(urllib.request.urlopen(req))
print(f"{len(manifest['parts'])} sessions, {manifest['clips']} clips, {manifest['minutes']} min")
rows = []
for part in manifest["parts"]:
    root = f"/content/data/{part['job']}"
    with zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(part["url"]).read())) as z:
        z.extractall(root)
    for line in open(f"{root}/metadata.csv", encoding="utf-8"):
        if "|" in line:
            f, text = line.rstrip("\\n").split("|", 1)
            rows.append({"path": f"{root}/{f}", "text": text})
minutes = manifest["minutes"]
if minutes < 15:
    print(f"⚠️ only {minutes} min: it will train, but 30-60 min gives a far more natural, stable voice")
print(len(rows), "clips ready")
"""),
    code("""
# ── turn every clip into Orpheus tokens (SNAC 24 kHz codec, 7 codes per frame)
import torch, soundfile as sf, numpy as np
from snac import SNAC
snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to("cuda").eval()
OFF = 128266

def codes_for(path):
    a, sr = sf.read(path, dtype="float32")
    if a.ndim > 1: a = a.mean(1)
    if sr != 24000:
        import librosa; a = librosa.resample(a, orig_sr=sr, target_sr=24000)
    w = torch.from_numpy(a).unsqueeze(0).unsqueeze(0).to("cuda")
    with torch.inference_mode():
        c = snac.encode(w)
    out = []
    for i in range(c[0].shape[1]):
        out += [c[0][0][i].item() + OFF, c[1][0][2 * i].item() + OFF + 4096, c[2][0][4 * i].item() + OFF + 2 * 4096,
                c[2][0][4 * i + 1].item() + OFF + 3 * 4096, c[1][0][2 * i + 1].item() + OFF + 4 * 4096,
                c[2][0][4 * i + 2].item() + OFF + 5 * 4096, c[2][0][4 * i + 3].item() + OFF + 6 * 4096]
    # drop frames that repeat the previous one exactly (silence padding): the model learns speech, not hold
    keep = out[:7]
    for i in range(7, len(out), 7):
        if out[i] != keep[-7]:
            keep += out[i:i + 7]
    return keep

from tqdm.auto import tqdm
for r in tqdm(rows):
    r["codes"] = codes_for(r["path"])
del snac; torch.cuda.empty_cache()
"""),
    code("""
# ── the model + a LoRA adapter
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained("unsloth/orpheus-3b-0.1-ft", max_seq_length=2048, dtype=None, load_in_4bit=False, token=HF_TOKEN)
model = FastLanguageModel.get_peft_model(model, r=64, lora_alpha=64, lora_dropout=0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth", random_state=3407)

START_HUMAN, END_HUMAN, START_AI, END_AI, END_TEXT, START_SPEECH, END_SPEECH = 128259, 128260, 128261, 128262, 128009, 128257, 128258
from datasets import Dataset
def example(r):
    ids = tokenizer.encode(f"{SPEAKER}: {r['text']}", add_special_tokens=True) + [END_TEXT]
    ids = [START_HUMAN] + ids + [END_HUMAN, START_AI, START_SPEECH] + r["codes"] + [END_SPEECH, END_AI]
    return {"input_ids": ids, "labels": ids, "attention_mask": [1] * len(ids)}
ds = Dataset.from_list([example(r) for r in rows if len(r["codes"]) + 80 < 2048])
print(len(ds), "training examples")
"""),
    code("""
# ── train
from transformers import Trainer, TrainingArguments
from unsloth import is_bfloat16_supported
epochs = EPOCHS or (3 if minutes < 40 else 2)
trainer = Trainer(model=model, train_dataset=ds, args=TrainingArguments(
    per_device_train_batch_size=1, gradient_accumulation_steps=4, warmup_steps=10, num_train_epochs=epochs,
    learning_rate=LEARNING_RATE, logging_steps=10, optim="adamw_8bit", weight_decay=0.01, lr_scheduler_type="linear",
    seed=3407, output_dir="outputs", report_to="none", fp16=not is_bfloat16_supported(), bf16=is_bfloat16_supported()))
stats = trainer.train()
print(stats)
"""),
    code("""
# ── listen: a line it never heard you say
from IPython.display import Audio, display
FastLanguageModel.for_inference(model)
snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to("cuda").eval()
def say(text, temperature=0.6):
    ids = [START_HUMAN] + tokenizer.encode(f"{SPEAKER}: {text}", add_special_tokens=True) + [END_TEXT, END_HUMAN]
    x = torch.tensor([ids]).to("cuda")
    g = model.generate(input_ids=x, attention_mask=torch.ones_like(x), max_new_tokens=1600, do_sample=True, temperature=temperature,
                       top_p=0.95, repetition_penalty=1.1, eos_token_id=END_SPEECH)[0][len(ids):].tolist()
    if START_SPEECH in g: g = g[len(g) - g[::-1].index(START_SPEECH):]
    c = [t - OFF for t in g if t >= OFF][: (len([t for t in g if t >= OFF]) // 7) * 7]
    l1, l2, l3 = [], [], []
    for i in range(len(c) // 7):
        b = 7 * i
        l1.append(c[b]); l2.append(c[b + 1] - 4096); l3 += [c[b + 2] - 2 * 4096, c[b + 3] - 3 * 4096]
        l2.append(c[b + 4] - 4 * 4096); l3 += [c[b + 5] - 5 * 4096, c[b + 6] - 6 * 4096]
    codes = [torch.tensor(v).unsqueeze(0).clamp(0, 4095).to("cuda") for v in (l1, l2, l3)]
    with torch.inference_mode():
        return snac.decode(codes).squeeze().cpu().numpy()
for line in ["Hey, welcome back to the channel. Today we're breaking down how Kubernetes actually schedules your containers.",
             "Here's the thing nobody tells you about caching. <chuckle> It's always the cache."]:
    display(Audio(say(line), rate=24000))
"""),
    code("""
# ── publish: merged 16-bit weights to your private Hugging Face repo
from huggingface_hub import create_repo
create_repo(HF_REPO, private=True, exist_ok=True, token=HF_TOKEN)
model.push_to_hub_merged(HF_REPO, tokenizer, save_method="merged_16bit", token=HF_TOKEN)
print(f"Done. Now set MY_VOICE_MODEL={HF_REPO} and MY_VOICE_SPEAKER={SPEAKER}:")
print("  - on Vercel (Project → Settings → Environment Variables), then restart the worker notebook; or")
print("  - in the worker notebook's Colab Secrets.")
print("Then open Your model → Benchmark on the dashboard to compare it with your cloned voices.")
"""),
]

nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"},
                                   "kernelspec": {"display_name": "Python 3", "name": "python3"}, "language_info": {"name": "python"}},
      "nbformat": 4, "nbformat_minor": 0}
for path in (OUT, os.path.join(ROOT, "mcp", "public", "train_my_voice.ipynb")):  # the dashboard serves a copy to download
    json.dump(nb, open(path, "w"), indent=1)
    print("wrote", path)
