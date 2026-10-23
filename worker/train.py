"""Fine-tune Orpheus 3B on your own voice: the dataset clips from the Your model page -> a LoRA adapter.

Runs inside its own venv (unsloth), started by the gateway's train job, so it can use the whole GPU:

  python train.py job.json

job.json: {"parts": [{"url"}], "speaker", "epochs"?, "learning_rate"?, "work", "out", "progress"}
Writes <out>/adapter/ (PEFT LoRA for unsloth/orpheus-3b-0.1-ft, loaded by engines/myvoice.py through vLLM's LoRA
support), <out>/adapter.zip and <out>/sample.wav (a line it never heard you say). Progress goes to the "progress" file
as JSON: {phase, step, total, loss?, detail}.

What makes it sound like you talking, not you reading one sentence at a time:
  - transcripts go through the same spoken form (lexicon) the engine is given at inference, so "GPU" is learnt as the
    "G P U" it will actually be asked to say;
  - the loss is on the speech only: the model learns how you sound, not to predict the script;
  - flow: about half the clips that follow another clip in the same recording are trained with that clip (its text and
    your audio) as the turn before, so the model learns to carry pitch, pace and energy from one sentence into the next.
    The engine does the same at inference (adapter/voicebox.json says the adapter knows this);
  - a few clips are held out, the adapter is checked against them every epoch, and the best epoch is kept (not just the
    last one, which is often over-fitted on a small dataset).
"""
import io, json, os, random, re, shutil, sys, time, urllib.request, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lexicon import speakable  # noqa: E402

BASE = "unsloth/orpheus-3b-0.1-ft"  # ungated mirror of canopylabs/orpheus-3b-0.1-ft, also what the orpheus engine serves
OFF = 128266
START_HUMAN, END_HUMAN, START_AI, END_AI, END_TEXT, START_SPEECH, END_SPEECH = 128259, 128260, 128261, 128262, 128009, 128257, 128258
MAX_LEN = 4096  # one turn of context (<= ~20 s) + the clip itself (<= ~20 s), ~86 tokens a second
CTX_MAX = 1800  # longest previous clip (codec tokens) used as context; must match engines/orpheus.py
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
                rows.append({"path": os.path.join(root, f), "text": text, "part": n})
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
        r["said"] = speakable(r["text"], None, tech=True) or r["text"]
    # the clip before each one in the same recording (dataset.py names them <source>_<index>.wav, in order)
    where = {}
    for r in rows:
        m = re.match(r"(.+)_(\d+)\.wav$", os.path.basename(r["path"]))
        if m:
            where[(r["part"], m.group(1), int(m.group(2)))] = r
    for r in rows:
        m = re.match(r"(.+)_(\d+)\.wav$", os.path.basename(r["path"]))
        r["prev"] = where.get((r["part"], m.group(1), int(m.group(2)) - 1)) if m else None
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

    def turn(said, codes=None):
        """One Orpheus turn: the prompt (speaker + text) and, when given, the answer (your audio)."""
        ask = [START_HUMAN] + tok.encode(f"{speaker}: {said}", add_special_tokens=True) + [END_TEXT, END_HUMAN]
        return ask, ([START_AI, START_SPEECH] + codes + [END_SPEECH, END_AI] if codes is not None else [])

    def example(r, ctx=None):
        """Loss on the answer only. ctx: the clip before this one, given as an already-answered turn."""
        before = []
        if ctx is not None:
            a, b = turn(ctx["said"], ctx["codes"])
            before = a + b
        ask, answer = turn(r["said"], r["codes"])
        ids = before + ask + answer
        return {"input_ids": ids, "labels": [-100] * (len(before) + len(ask)) + answer, "attention_mask": [1] * len(ids)}

    rng = random.Random(3407)
    usable = [r for r in rows if len(r["codes"]) + 100 < MAX_LEN // 2]
    held = set()
    if len(usable) >= 60:  # hold out ~5% (8-40 clips) to pick the best epoch with
        held = {id(r) for r in rng.sample(usable, max(8, min(40, len(usable) // 20)))}
    train_rows, flow = [], 0
    for r in usable:
        if id(r) in held:
            continue
        p = r.get("prev")
        if p is not None and id(p) not in held and len(p["codes"]) <= CTX_MAX and rng.random() < 0.5:
            train_rows.append(example(r, p))
            flow += 1
        else:
            train_rows.append(example(r))
    rng.shuffle(train_rows)
    ds = Dataset.from_list(train_rows)
    eval_ds = Dataset.from_list([example(r) for r in usable if id(r) in held]) if held else None

    # ── train
    from transformers import Trainer, TrainingArguments, TrainerCallback
    epochs = cfg.get("epochs") or (4 if minutes < 40 else 3)  # one more than strictly needed: the best epoch is kept

    class Progress(TrainerCallback):
        def on_step_end(self, args, state, control, **kw):
            loss = next((h["loss"] for h in reversed(state.log_history) if "loss" in h), None)
            report("training", state.global_step, state.max_steps, loss=loss,
                   detail=f"step {state.global_step} of {state.max_steps}" + (f" · loss {loss:.3f}" if loss is not None else ""))

    pick = {"eval_strategy": "epoch", "save_strategy": "epoch", "save_total_limit": 2, "load_best_model_at_end": True,
            "metric_for_best_model": "eval_loss", "greater_is_better": False, "per_device_eval_batch_size": 1} if eval_ds else {"save_strategy": "no"}
    trainer = Trainer(model=model, train_dataset=ds, eval_dataset=eval_ds, callbacks=[Progress()], args=TrainingArguments(
        per_device_train_batch_size=1, gradient_accumulation_steps=4, warmup_ratio=0.05, num_train_epochs=epochs,
        learning_rate=float(cfg.get("learning_rate") or 2e-4), logging_steps=5, optim="adamw_8bit", weight_decay=0.01,
        lr_scheduler_type="cosine", seed=3407, output_dir=os.path.join(work, "outputs"), report_to="none",
        fp16=not is_bfloat16_supported(), bf16=is_bfloat16_supported(), **pick))
    stats = trainer.train()
    evals = [round(h["eval_loss"], 4) for h in trainer.state.log_history if "eval_loss" in h]
    best_epoch = evals.index(min(evals)) + 1 if evals else epochs

    # ── save the adapter (small: the base model stays the public one)
    report("saving", detail="saving your model")
    adapter = os.path.join(out, "adapter")
    shutil.rmtree(adapter, ignore_errors=True)
    model.save_pretrained(adapter)
    tok.save_pretrained(adapter)
    json.dump({"format": 2, "speaker": speaker, "context": flow > 0, "ctx_max": CTX_MAX, "lexicon": True},
              open(os.path.join(adapter, "voicebox.json"), "w"))
    with zipfile.ZipFile(os.path.join(out, "adapter.zip"), "w", zipfile.ZIP_STORED) as z:  # safetensors don't compress
        for f in sorted(os.listdir(adapter)):
            z.write(os.path.join(adapter, f), f)

    # ── listen: a line it never heard you say
    report("testing", detail="voicing a test line")
    FastLanguageModel.for_inference(model)
    snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to("cuda").eval()
    ids, _ = turn(speakable(TEST_LINE, None, tech=True) or TEST_LINE)
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

    json.dump({"clips": len(ds), "flow_clips": flow, "held_out": len(held), "minutes": round(minutes, 2), "epochs": epochs,
               "best_epoch": best_epoch, "eval_loss": evals, "steps": stats.global_step,
               "loss": round(float(stats.training_loss), 4), "speaker": speaker, "base": BASE, "sample": sample},
              open(os.path.join(out, "result.json"), "w"))
    report("done")


if __name__ == "__main__":
    main()
