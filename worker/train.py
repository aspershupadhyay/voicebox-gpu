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
  - a few clips are held out and the best epoch is chosen by *listening*: every epoch's adapter voices the held-out
    sentences, Whisper checks the words landed and a speaker model compares each one with your real recording of that
    very sentence. The epoch that sounds most like you saying the right words wins (eval loss on codec tokens only
    breaks ties: it tracks clarity loosely).

Speed: each session's clips are turned into codec tokens once and cached on the worker (job.json "cache"), so training
again skips the download and the encode; clips of similar length are batched together, as many as the GPU holds.
"""
import glob, hashlib, io, json, os, random, re, shutil, sys, time, urllib.request, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lexicon import speakable  # noqa: E402

BASE = "unsloth/orpheus-3b-0.1-ft"  # ungated mirror of canopylabs/orpheus-3b-0.1-ft, also what the orpheus engine serves
OFF = 128266
START_HUMAN, END_HUMAN, START_AI, END_AI, END_TEXT, START_SPEECH, END_SPEECH = 128259, 128260, 128261, 128262, 128009, 128257, 128258
MAX_LEN = 4096  # one turn of context (<= ~20 s) + the clip itself (<= ~20 s), ~86 tokens a second
CTX_MAX = 1800  # longest previous clip (codec tokens) used as context; must match engines/orpheus.py
PAD = 128263  # Orpheus's pad token
LISTEN_LINES = 6  # held-out sentences each epoch voices when picking the best one
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

    # ── the dataset: every collected session (24 kHz clips + metadata.csv), as codec tokens. A session's tokens are
    # cached by its storage path, so training again (or after collecting more) only encodes the new sessions.
    import torch, soundfile as sf
    from snac import SNAC
    cache = cfg.get("cache")
    if cache:
        os.makedirs(cache, exist_ok=True)
    snac = None
    seconds = 0.0
    rows, parts = [], cfg["parts"]

    def codes_for(a, sr):
        if a.ndim > 1:
            a = a.mean(1)
        if sr != 24000:
            import librosa
            a = librosa.resample(a, orig_sr=sr, target_sr=24000)
        with torch.inference_mode():
            c = snac.encode(torch.from_numpy(a).unsqueeze(0).unsqueeze(0).to("cuda"))
        c0, c1, c2 = (x[0].tolist() for x in c)
        seq = []
        for i in range(len(c0)):
            seq += [c0[i] + OFF, c1[2 * i] + OFF + 4096, c2[4 * i] + OFF + 2 * 4096, c2[4 * i + 1] + OFF + 3 * 4096,
                    c1[2 * i + 1] + OFF + 4 * 4096, c2[4 * i + 2] + OFF + 5 * 4096, c2[4 * i + 3] + OFF + 6 * 4096]
        keep = seq[:7]  # drop frames that repeat the previous one exactly (silence padding)
        for i in range(7, len(seq), 7):
            if seq[i] != keep[-7]:
                keep += seq[i:i + 7]
        return keep

    for n, part in enumerate(parts):
        key = hashlib.sha1(part["url"].split("?")[0].encode()).hexdigest()[:16]
        cached = os.path.join(cache, f"{key}.json") if cache else None
        root = os.path.join(work, f"part{n:02d}")
        if cached and os.path.exists(cached):
            report("encoding", n, len(parts), detail=f"session {n + 1} of {len(parts)} (already encoded)")
            got = json.load(open(cached))
            for r in got["rows"]:
                rows.append({"path": os.path.join(root, r["file"]), "file": r["file"], "text": r["text"], "codes": r["codes"],
                             "secs": r["secs"], "part": n})
                seconds += r["secs"]
            continue
        report("downloading", n, len(parts), detail=f"recording session {n + 1} of {len(parts)}")
        with urllib.request.urlopen(part["url"], timeout=600) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extractall(root)
        if snac is None:
            snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to("cuda").eval()
        mine = []
        lines = [ln.rstrip("\n").split("|", 1) for ln in open(os.path.join(root, "metadata.csv"), encoding="utf-8") if "|" in ln]
        for k, (f, text) in enumerate(lines):
            if k % 10 == 0:
                report("encoding", n, len(parts), detail=f"session {n + 1} of {len(parts)}: clip {k + 1} of {len(lines)}")
            a, sr = sf.read(os.path.join(root, f), dtype="float32")
            secs = len(a) / sr
            mine.append({"path": os.path.join(root, f), "file": f, "text": text, "codes": codes_for(a, sr), "secs": secs, "part": n})
            seconds += secs
        rows += mine
        if cached:
            tmp = cached + ".tmp"
            json.dump({"rows": [{k: r[k] for k in ("file", "text", "codes", "secs")} for r in mine]}, open(tmp, "w"))
            os.replace(tmp, cached)
    if not rows:
        raise SystemExit("the dataset has no clips")
    for r in rows:
        r["said"] = speakable(r["text"], None, tech=True) or r["text"]
    # the clip before each one in the same recording (dataset.py names them <source>_<index>.wav, in order)
    where = {}
    for r in rows:
        m = re.match(r"(.+)_(\d+)\.wav$", os.path.basename(r["file"]))
        if m:
            where[(r["part"], m.group(1), int(m.group(2)))] = r
    for r in rows:
        m = re.match(r"(.+)_(\d+)\.wav$", os.path.basename(r["file"]))
        r["prev"] = where.get((r["part"], m.group(1), int(m.group(2)) - 1)) if m else None
    minutes = seconds / 60
    snac = None
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
        return {"input_ids": ids, "labels": [-100] * (len(before) + len(ask)) + answer, "attention_mask": [1] * len(ids), "length": len(ids)}

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
    held_rows = [r for r in usable if id(r) in held]
    eval_ds = Dataset.from_list([example(r) for r in held_rows]) if held else None

    # ── train: clips of similar length share a batch (little padding), as many per batch as the card holds
    from transformers import Trainer, TrainingArguments, TrainerCallback
    # one more than strictly needed (the best epoch is kept); a small dataset needs more passes to learn the voice
    epochs = cfg.get("epochs") or (10 if minutes < 5 else 6 if minutes < 15 else 4 if minutes < 40 else 3)
    vram = torch.cuda.get_device_properties(0).total_memory / 2**30
    bs = 4 if vram >= 38 else 2 if vram >= 20 else 1
    accum = max(1, 4 // bs)  # an effective batch of 4 clips everywhere, so the learning rate means the same thing

    def collate(batch):
        n = max(len(x["input_ids"]) for x in batch)
        pad = lambda xs, v: [x + [v] * (n - len(x)) for x in xs]  # noqa: E731
        return {"input_ids": torch.tensor(pad([x["input_ids"] for x in batch], PAD)),
                "labels": torch.tensor(pad([x["labels"] for x in batch], -100)),
                "attention_mask": torch.tensor(pad([x["attention_mask"] for x in batch], 0))}

    class Progress(TrainerCallback):
        def on_step_end(self, args, state, control, **kw):
            loss = next((h["loss"] for h in reversed(state.log_history) if "loss" in h), None)
            report("training", state.global_step, state.max_steps, loss=loss,
                   detail=f"step {state.global_step} of {state.max_steps}" + (f" · loss {loss:.3f}" if loss is not None else ""))

    ckpts = os.path.join(work, "outputs")
    pick = {"eval_strategy": "epoch", "save_strategy": "epoch", "save_only_model": True, "per_device_eval_batch_size": bs} if eval_ds else {"save_strategy": "no"}
    # Transformers 5 dropped group_by_length and warmup_ratio (the train venv installs the latest): use them where they
    # exist, else group lengths with our own sampler and give the warmup as steps, so both versions train the same way
    import inspect
    from transformers.trainer_pt_utils import LengthGroupedSampler
    known = inspect.signature(TrainingArguments.__init__).parameters
    steps = -(-len(ds) // (bs * accum)) * epochs
    opts = {"group_by_length": bs > 1, "length_column_name": "length"} if "group_by_length" in known else {}
    opts.update({"warmup_ratio": 0.05} if "warmup_ratio" in known else {"warmup_steps": max(1, round(0.05 * steps))})
    lengths = list(ds["length"])

    class Grouped(Trainer):
        def _get_train_sampler(self, *a, **k):  # clips of similar length together: less padding, more clips per step
            if "group_by_length" in known or bs == 1:
                return super()._get_train_sampler(*a, **k)
            return LengthGroupedSampler(bs * accum, lengths=lengths)

    trainer = Grouped(model=model, train_dataset=ds, eval_dataset=eval_ds, callbacks=[Progress()], data_collator=collate, args=TrainingArguments(
        per_device_train_batch_size=bs, gradient_accumulation_steps=accum, num_train_epochs=epochs, remove_unused_columns=False,
        dataloader_num_workers=min(8, max(2, (os.cpu_count() or 4) // 2)), dataloader_pin_memory=True, learning_rate=float(cfg.get("learning_rate") or 2e-4), logging_steps=5, optim="adamw_8bit",
        weight_decay=0.01, lr_scheduler_type="cosine", seed=3407, output_dir=ckpts, report_to="none",
        fp16=not is_bfloat16_supported(), bf16=is_bfloat16_supported(), **opts, **pick))
    stats = trainer.train()
    evals = [round(h["eval_loss"], 4) for h in trainer.state.log_history if "eval_loss" in h]
    trainer = None  # the optimizer's memory back for listening
    torch.cuda.empty_cache()

    # ── voices: a few helpers shared by the listening test and the sample line
    FastLanguageModel.for_inference(model)
    snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to("cuda").eval()

    def decode(c):
        c = [t - OFF for t in c if t >= OFF]
        c = c[: len(c) // 7 * 7]
        if not c:
            return None
        l1, l2, l3 = [], [], []
        for i in range(len(c) // 7):
            b = 7 * i
            l1.append(c[b]); l2.append(c[b + 1] - 4096); l3 += [c[b + 2] - 2 * 4096, c[b + 3] - 3 * 4096]
            l2.append(c[b + 4] - 4 * 4096); l3 += [c[b + 5] - 5 * 4096, c[b + 6] - 6 * 4096]
        codes = [torch.tensor(v).unsqueeze(0).clamp(0, 4095).to("cuda") for v in (l1, l2, l3)]
        with torch.inference_mode():
            return snac.decode(codes).squeeze().float().cpu().numpy()

    def speak(said, temperature=0.5, seed=7):
        ids, _ = turn(said)
        x = torch.tensor([ids]).to("cuda")
        torch.manual_seed(seed)
        g = model.generate(input_ids=x, attention_mask=torch.ones_like(x), max_new_tokens=min(3000, 300 + 12 * len(said)), do_sample=True,
                           temperature=temperature, top_p=0.95, repetition_penalty=1.12, eos_token_id=END_SPEECH, pad_token_id=PAD)[0][len(ids):].tolist()
        if START_SPEECH in g:
            g = g[len(g) - g[::-1].index(START_SPEECH):]
        return decode(g)

    # ── pick the epoch by listening: each epoch's adapter voices held-out sentences; Whisper checks the words, a
    # speaker model compares each take with your real recording of that same sentence (through the same codec)
    listen, best_epoch = [], (evals.index(min(evals)) + 1 if evals else epochs)
    saved = sorted(glob.glob(os.path.join(ckpts, "checkpoint-*")), key=lambda d: int(d.rsplit("-", 1)[1]))
    if len(saved) > 1 and held_rows:
        try:
            listen = pick_by_listening(model, saved, held_rows, speak, decode, report, work)
            scored = [x for x in listen if x.get("score") is not None]
            if scored:
                top = max(scored, key=lambda x: (x["score"], -(evals[x["epoch"] - 1] if x["epoch"] - 1 < len(evals) else 0)))
                best_epoch = top["epoch"]
        except Exception as e:  # noqa: BLE001  the listening test is a refinement: fall back to the eval loss
            print(f"[train] listening test failed ({type(e).__name__}: {e}); picking by eval loss", flush=True)
        load_epoch(model, saved[min(best_epoch, len(saved)) - 1])
    elif len(saved) == 1:
        load_epoch(model, saved[0])

    # ── save the adapter (small: the base model stays the public one)
    report("saving", detail=f"saving your model (epoch {best_epoch})")
    adapter = os.path.join(out, "adapter")
    shutil.rmtree(adapter, ignore_errors=True)
    model.save_pretrained(adapter)
    tok.save_pretrained(adapter)
    json.dump({"format": 2, "speaker": speaker, "context": flow > 0, "ctx_max": CTX_MAX, "lexicon": True, "epoch": best_epoch},
              open(os.path.join(adapter, "voicebox.json"), "w"))
    with zipfile.ZipFile(os.path.join(out, "adapter.zip"), "w", zipfile.ZIP_STORED) as z:  # safetensors don't compress
        for f in sorted(os.listdir(adapter)):
            z.write(os.path.join(adapter, f), f)

    # ── listen: a line it never heard you say
    report("testing", detail="voicing a test line")
    audio = speak(speakable(TEST_LINE, None, tech=True) or TEST_LINE)
    sample = None
    if audio is not None and len(audio):
        sf.write(os.path.join(out, "sample.wav"), audio, 24000)
        sample = {"text": TEST_LINE, "duration": round(len(audio) / 24000, 2)}

    json.dump({"clips": len(ds), "flow_clips": flow, "held_out": len(held), "minutes": round(minutes, 2), "epochs": epochs,
               "best_epoch": best_epoch, "eval_loss": evals, "listening": listen, "steps": stats.global_step, "batch": bs,
               "loss": round(float(stats.training_loss), 4), "speaker": speaker, "base": BASE, "sample": sample},
              open(os.path.join(out, "result.json"), "w"))
    report("done")


def load_epoch(model, ckpt):
    """Put one saved epoch's LoRA weights into the live model."""
    from peft import set_peft_model_state_dict
    from safetensors.torch import load_file
    f = os.path.join(ckpt, "adapter_model.safetensors")
    if os.path.exists(f):
        set_peft_model_state_dict(model, load_file(f))


def pick_by_listening(model, saved, held_rows, speak, decode, report, work):
    """Score every saved epoch on the same held-out sentences: script accuracy (Whisper large-v3-turbo) and voice match
    (WavLM speaker embeddings vs your real take of that sentence, decoded through the same codec so only the voice
    differs). Returns [{epoch, match, similarity, score}]."""
    import numpy as np
    import torch
    import quality
    from transformers import AutoFeatureExtractor, WavLMForXVector, pipeline
    from scipy.signal import resample_poly

    lines = sorted(held_rows, key=lambda r: abs(len(r["codes"]) - 7 * 86 * 5))[:LISTEN_LINES]  # ~5 s sentences
    asr = pipeline("automatic-speech-recognition", model="openai/whisper-large-v3-turbo", torch_dtype=torch.float16, device="cuda")
    fe = AutoFeatureExtractor.from_pretrained("microsoft/wavlm-base-plus-sv")
    sv = WavLMForXVector.from_pretrained("microsoft/wavlm-base-plus-sv").to("cuda").eval()
    to16 = lambda a: resample_poly(a, 2, 3).astype("float32")  # noqa: E731  24 kHz -> 16 kHz

    def emb(a):
        x = fe(to16(a), sampling_rate=16000, return_tensors="pt").to("cuda")
        with torch.inference_mode():
            return torch.nn.functional.normalize(sv(**x).embeddings, dim=-1)[0]

    refs = []
    for r in lines:
        real = decode(r["codes"])
        refs.append(emb(real) if real is not None and len(real) > 2400 else None)
    out = []
    for e, ck in enumerate(saved, 1):
        report("listening", e - 1, len(saved), detail=f"listening to epoch {e} of {len(saved)}")
        load_epoch(model, ck)
        texts, sims = [], []
        for k, r in enumerate(lines):
            a = speak(r["said"], seed=11 + k)
            if a is None or len(a) < 2400:
                texts.append(0.0)
                continue
            heard = asr({"raw": to16(a), "sampling_rate": 16000}, generate_kwargs={"task": "transcribe", "language": "en"})["text"]
            texts.append(quality.score_text(r["text"], heard, r["said"])["score"] or 0.0)
            if refs[k] is not None:
                sims.append(float((refs[k] * emb(a)).sum()))
        match = float(np.mean(texts)) if texts else None
        sim = float(np.mean(sims)) if sims else None
        out.append({"epoch": e, "match": round(match, 3) if match is not None else None, "similarity": round(sim, 3) if sim is not None else None,
                    "score": quality.take_score(match, sim, None) if match is not None else None})
        print(f"[train] epoch {e}: {out[-1]}", flush=True)
    del asr, sv
    torch.cuda.empty_cache()
    return out

if __name__ == "__main__":
    main()
