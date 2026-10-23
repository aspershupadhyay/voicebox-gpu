"""Fine-tune Orpheus 3B on your own voice: the dataset clips from the Your model page -> a LoRA adapter.

Runs inside its own venv (unsloth), started by the gateway's train job, so it can use the whole GPU:

  python train.py job.json

job.json: {"parts": [{"url"}], "speaker", "epochs"?, "learning_rate"?, "work", "out", "progress"}
Writes <out>/adapter/ (PEFT LoRA for unsloth/orpheus-3b-0.1-ft, loaded by engines/myvoice.py through vLLM's LoRA
support), <out>/adapter.zip and <out>/sample.wav (a line it never heard you say). Progress goes to the "progress" file
as JSON: {phase, step, total, loss?, detail}. Same recipe as notebook/train_my_voice.ipynb.
"""
import io, json, os, shutil, sys, time, urllib.request, zipfile

BASE = "unsloth/orpheus-3b-0.1-ft"  # ungated mirror of canopylabs/orpheus-3b-0.1-ft, also what the orpheus engine serves
OFF = 128266
START_HUMAN, END_HUMAN, START_AI, END_AI, END_TEXT, START_SPEECH, END_SPEECH = 128259, 128260, 128261, 128262, 128009, 128257, 128258
MAX_LEN = 2048
TEST_LINE = "Hey, welcome back to the channel. Today we're breaking down how Kubernetes actually schedules your containers."


def main():
    cfg = json.load(open(sys.argv[1]))
    work, out, prog = cfg["work"], cfg["out"], cfg["progress"]
    speaker = cfg.get("speaker") or "me"
    os.makedirs(work, exist_ok=True)
    os.makedirs(out, exist_ok=True)

    def report(phase, step=0, total=0, **kw):
        tmp = prog + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"phase": phase, "step": step, "total": total, "t": time.time(), **kw}, f)
        os.replace(tmp, prog)

    # ── the dataset: every collected session (24 kHz clips + metadata.csv)
    rows, parts = [], cfg["parts"]
    for n, part in enumerate(parts):
        report("downloading", n, len(parts), detail=f"recording session {n + 1} of {len(parts)}")
        root = os.path.join(work, f"part{n:02d}")
        with urllib.request.urlopen(part["url"], timeout=600) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extractall(root)
        for line in open(os.path.join(root, "metadata.csv"), encoding="utf-8"):
            if "|" in line:
                f, text = line.rstrip("\n").split("|", 1)
                rows.append({"path": os.path.join(root, f), "text": text})
    if not rows:
        raise SystemExit("the dataset has no clips")

    # ── every clip -> Orpheus tokens (SNAC 24 kHz, 7 codes per frame)
    import torch, soundfile as sf
    from snac import SNAC
    snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to("cuda").eval()

    seconds = 0.0

    def codes_for(path):
        nonlocal seconds
        a, sr = sf.read(path, dtype="float32")
        seconds += len(a) / sr
        if a.ndim > 1:
            a = a.mean(1)
        if sr != 24000:
            import librosa
            a = librosa.resample(a, orig_sr=sr, target_sr=24000)
        with torch.inference_mode():
            c = snac.encode(torch.from_numpy(a).unsqueeze(0).unsqueeze(0).to("cuda"))
        seq = []
        for i in range(c[0].shape[1]):
            seq += [c[0][0][i].item() + OFF, c[1][0][2 * i].item() + OFF + 4096, c[2][0][4 * i].item() + OFF + 2 * 4096,
                    c[2][0][4 * i + 1].item() + OFF + 3 * 4096, c[1][0][2 * i + 1].item() + OFF + 4 * 4096,
                    c[2][0][4 * i + 2].item() + OFF + 5 * 4096, c[2][0][4 * i + 3].item() + OFF + 6 * 4096]
        keep = seq[:7]  # drop frames that repeat the previous one exactly (silence padding)
        for i in range(7, len(seq), 7):
            if seq[i] != keep[-7]:
                keep += seq[i:i + 7]
        return keep

    for i, r in enumerate(rows):
        if i % 10 == 0:
            report("encoding", i, len(rows), detail=f"clip {i + 1} of {len(rows)}")
        r["codes"] = codes_for(r["path"])
    minutes = seconds / 60
    del snac
    torch.cuda.empty_cache()

    # ── the model + a LoRA adapter
    report("loading", detail="loading Orpheus 3B")
    from unsloth import FastLanguageModel, is_bfloat16_supported
    model, tok = FastLanguageModel.from_pretrained(BASE, max_seq_length=MAX_LEN, dtype=None, load_in_4bit=False,
                                                   token=os.environ.get("HF_TOKEN") or None)
    model = FastLanguageModel.get_peft_model(model, r=64, lora_alpha=64, lora_dropout=0, bias="none",
                                             target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
                                             use_gradient_checkpointing="unsloth", random_state=3407)
    from datasets import Dataset

    def example(r):
        ids = tok.encode(f"{speaker}: {r['text']}", add_special_tokens=True) + [END_TEXT]
        ids = [START_HUMAN] + ids + [END_HUMAN, START_AI, START_SPEECH] + r["codes"] + [END_SPEECH, END_AI]
        return {"input_ids": ids, "labels": ids, "attention_mask": [1] * len(ids)}
    ds = Dataset.from_list([example(r) for r in rows if len(r["codes"]) + 80 < MAX_LEN])

    # ── train
    from transformers import Trainer, TrainingArguments, TrainerCallback
    epochs = cfg.get("epochs") or (3 if minutes < 40 else 2)

    class Progress(TrainerCallback):
        def on_step_end(self, args, state, control, **kw):
            loss = next((h["loss"] for h in reversed(state.log_history) if "loss" in h), None)
            report("training", state.global_step, state.max_steps, loss=loss,
                   detail=f"step {state.global_step} of {state.max_steps}" + (f" · loss {loss:.3f}" if loss is not None else ""))

    trainer = Trainer(model=model, train_dataset=ds, callbacks=[Progress()], args=TrainingArguments(
        per_device_train_batch_size=1, gradient_accumulation_steps=4, warmup_steps=10, num_train_epochs=epochs,
        learning_rate=float(cfg.get("learning_rate") or 2e-4), logging_steps=5, optim="adamw_8bit", weight_decay=0.01,
        lr_scheduler_type="linear", seed=3407, output_dir=os.path.join(work, "outputs"), report_to="none", save_strategy="no",
        fp16=not is_bfloat16_supported(), bf16=is_bfloat16_supported()))
    stats = trainer.train()

    # ── save the adapter (small: the base model stays the public one)
    report("saving", detail="saving your model")
    adapter = os.path.join(out, "adapter")
    shutil.rmtree(adapter, ignore_errors=True)
    model.save_pretrained(adapter)
    tok.save_pretrained(adapter)
    with zipfile.ZipFile(os.path.join(out, "adapter.zip"), "w", zipfile.ZIP_STORED) as z:  # safetensors don't compress
        for f in sorted(os.listdir(adapter)):
            z.write(os.path.join(adapter, f), f)

    # ── listen: a line it never heard you say
    report("testing", detail="voicing a test line")
    FastLanguageModel.for_inference(model)
    snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to("cuda").eval()
    ids = [START_HUMAN] + tok.encode(f"{speaker}: {TEST_LINE}", add_special_tokens=True) + [END_TEXT, END_HUMAN]
    x = torch.tensor([ids]).to("cuda")
    g = model.generate(input_ids=x, attention_mask=torch.ones_like(x), max_new_tokens=1600, do_sample=True, temperature=0.6,
                       top_p=0.95, repetition_penalty=1.1, eos_token_id=END_SPEECH)[0][len(ids):].tolist()
    if START_SPEECH in g:
        g = g[len(g) - g[::-1].index(START_SPEECH):]
    c = [t - OFF for t in g if t >= OFF]
    c = c[: len(c) // 7 * 7]
    sample = None
    if c:
        l1, l2, l3 = [], [], []
        for i in range(len(c) // 7):
            b = 7 * i
            l1.append(c[b]); l2.append(c[b + 1] - 4096); l3 += [c[b + 2] - 2 * 4096, c[b + 3] - 3 * 4096]
            l2.append(c[b + 4] - 4 * 4096); l3 += [c[b + 5] - 5 * 4096, c[b + 6] - 6 * 4096]
        codes = [torch.tensor(v).unsqueeze(0).clamp(0, 4095).to("cuda") for v in (l1, l2, l3)]
        with torch.inference_mode():
            audio = snac.decode(codes).squeeze().cpu().numpy()
        sf.write(os.path.join(out, "sample.wav"), audio, 24000)
        sample = {"text": TEST_LINE, "duration": round(len(audio) / 24000, 2)}

    json.dump({"clips": len(ds), "minutes": round(minutes, 2), "epochs": epochs, "steps": stats.global_step,
               "loss": round(float(stats.training_loss), 4), "speaker": speaker, "base": BASE, "sample": sample},
              open(os.path.join(out, "result.json"), "w"))
    report("done")


if __name__ == "__main__":
    main()
