"""RLHF polish for a trained voice: Direct Preference Optimisation of its Orpheus LoRA adapter on preference pairs.

Runs in the train venv (train.py's), started by the gateway's train job with method "dpo":

  python train_dpo.py job.json

job.json: {"adapter_url", "pairs_url", "speaker", "minutes", "epochs"?, "learning_rate"?, "work", "out", "progress"}
pairs_url: {"pairs": [{"said", "chosen": [codec tokens], "rejected": [codec tokens], "weight"}]}, built by the dashboard
(lib/pairs.ts) from takes the review scored (the take it kept beats its worst take) and from people's thumbs up / down.

Orpheus is a language model whose answer is audio tokens, so DPO works on it exactly as on a chat model: raise the
likelihood of the preferred take relative to the rejected one, measured against the model before this pass (the
reference), with beta keeping it close to that reference. A small likelihood term on the preferred take (RPO) stops
both takes from drifting down together. The reference log-probabilities are computed once up front with the same
adapter, before any update, so only one copy of the model is in memory.

Writes the same outputs as train.py (<out>/adapter/, adapter.zip, sample.wav, result.json), so the dashboard stores
it like any retrain, and the model check compares it with the model in use before it goes live.
"""
import io, json, os, random, shutil, sys, time, urllib.request, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lexicon import speakable  # noqa: E402

BASE = os.environ.get("ORPHEUS_BASE", "unsloth/orpheus-3b-0.1-ft")  # what train.py trains on (override: tests)
OFF = 128266
START_HUMAN, END_HUMAN, START_AI, END_AI, END_TEXT, START_SPEECH, END_SPEECH, PAD = 128259, 128260, 128261, 128262, 128009, 128257, 128258, 128263
BETA, RPO = 0.1, 0.2
TEST_LINE = "Hey, welcome back to the channel. Today we're breaking down how Kubernetes actually schedules your containers."


def main():
    cfg = json.load(open(sys.argv[1]))
    work, out, prog = cfg["work"], cfg["out"], cfg["progress"]
    speaker = cfg.get("speaker") or "me"
    os.makedirs(work, exist_ok=True)

    def report(phase, step=0, total=0, **kw):
        with open(prog + ".tmp", "w") as f:
            json.dump({"phase": phase, "step": step, "total": total, "t": time.time(), **kw}, f)
        os.replace(prog + ".tmp", prog)

    report("downloading", detail="the model in use and its preference pairs")
    src = os.path.join(work, "adapter")
    with urllib.request.urlopen(cfg["adapter_url"], timeout=900) as r:
        zipfile.ZipFile(io.BytesIO(r.read())).extractall(src)
    with urllib.request.urlopen(cfg["pairs_url"], timeout=300) as r:
        pairs = json.loads(r.read())["pairs"]
    pairs = [p for p in pairs if p.get("chosen") and p.get("rejected") and len(p["chosen"]) + len(p["rejected"]) < 6000]
    if len(pairs) < 10:
        raise SystemExit(f"only {len(pairs)} usable preference pairs")

    report("loading", detail="loading Orpheus 3B with the voice")
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = (torch.bfloat16 if torch.cuda.get_device_capability(0)[0] >= 8 else torch.float16) if dev == "cuda" else torch.float32
    tok = AutoTokenizer.from_pretrained(BASE, token=os.environ.get("HF_TOKEN") or None)
    base = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=dtype, token=os.environ.get("HF_TOKEN") or None).to(dev)
    base.gradient_checkpointing_enable()
    base.enable_input_require_grads()
    model = PeftModel.from_pretrained(base, src, is_trainable=True)
    model.config.use_cache = False

    def seq(said, codes):
        ask = [START_HUMAN] + tok.encode(f"{speaker}: {said}", add_special_tokens=True) + [END_TEXT, END_HUMAN]
        ans = [START_AI, START_SPEECH] + list(codes) + [END_SPEECH, END_AI]
        return ask + ans, len(ask)

    def logp(ids, start):
        """Sum of log-probabilities of the answer tokens (the audio), and how many there are."""
        x = torch.tensor([ids], device=dev)
        logits = model(input_ids=x).logits[0, start - 1:-1].float()
        tgt = x[0, start:]
        return torch.log_softmax(logits, -1).gather(1, tgt[:, None]).squeeze(1).sum(), len(tgt)

    rng = random.Random(7)
    rng.shuffle(pairs)
    n_eval = max(4, len(pairs) // 10)
    evals, train = pairs[:n_eval], pairs[n_eval:]
    data = [(seq(p["said"], p["chosen"]), seq(p["said"], p["rejected"]), float(p.get("weight") or 1)) for p in pairs]

    # the reference: this same adapter before any update
    model.eval()
    ref = []
    with torch.no_grad():
        for i, (c, r, _) in enumerate(data):
            if i % 10 == 0:
                report("encoding", i, len(data), detail=f"scoring pair {i + 1} of {len(data)} with the model in use")
            ref.append((logp(*c)[0].item(), logp(*r)[0].item()))
    ref_eval, ref_train = ref[:n_eval], ref[n_eval:]
    data_eval, data_train = data[:n_eval], data[n_eval:]

    def margins(rows, refs):
        """How often the model prefers the chosen take (above the reference), and by how much."""
        model.eval()
        acc, m = 0, 0.0
        with torch.no_grad():
            for (c, r, _), (rc, rr) in zip(rows, refs):
                d = BETA * ((logp(*c)[0].item() - rc) - (logp(*r)[0].item() - rr))
                acc += d > 0
                m += d
        return acc / max(1, len(rows)), m / max(1, len(rows))

    epochs = int(cfg.get("epochs") or 2)
    accum = 8
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=float(cfg.get("learning_rate") or 1e-5), weight_decay=0.0)
    total = epochs * len(data_train)
    step, losses = 0, []
    model.train()
    for e in range(epochs):
        order = list(range(len(data_train)))
        rng.shuffle(order)
        for n, i in enumerate(order):
            (c, r, w), (rc, rr) = data_train[i], ref_train[i]
            pc, lc = logp(*c)
            pr, _ = logp(*r)
            d = BETA * ((pc - rc) - (pr - rr))
            loss = w * (-torch.nn.functional.logsigmoid(d) + RPO * (-pc / lc))
            (loss / accum).backward()
            losses.append(loss.item())
            if (n + 1) % accum == 0 or n == len(order) - 1:
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
                opt.step()
                opt.zero_grad(set_to_none=True)
            step += 1
            if step % 5 == 0:
                avg = sum(losses[-20:]) / len(losses[-20:])
                report("training", step, total, loss=avg, detail=f"epoch {e + 1} of {epochs} · pair {n + 1} of {len(order)} · loss {avg:.3f}")
    acc, margin = margins(data_eval, ref_eval)
    print(f"[dpo] held-out pairs: prefers the better take {acc:.0%} of the time (margin {margin:.3f})", flush=True)

    report("saving", detail="saving the polished model")
    adapter = os.path.join(out, "adapter")
    shutil.rmtree(adapter, ignore_errors=True)
    model.save_pretrained(adapter)
    tok.save_pretrained(adapter)
    meta = {}
    try:
        meta = json.load(open(os.path.join(src, "voicebox.json")))
    except (OSError, ValueError):
        pass
    meta.update({"speaker": speaker, "dpo": {"pairs": len(pairs), "epochs": epochs, "held_out_accuracy": round(acc, 3)}})
    json.dump(meta, open(os.path.join(adapter, "voicebox.json"), "w"))
    with zipfile.ZipFile(os.path.join(out, "adapter.zip"), "w", zipfile.ZIP_STORED) as z:
        for f in sorted(os.listdir(adapter)):
            z.write(os.path.join(adapter, f), f)

    report("testing", detail="voicing a test line")
    sample = None
    try:
        import soundfile as sf
        from snac import SNAC
        model.eval()
        model.config.use_cache = True
        snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to(dev).eval()
        ids, start = seq(speakable(TEST_LINE, None, tech=True) or TEST_LINE, [])
        x = torch.tensor([ids[:start]], device=dev)  # the prompt: the model writes the answer
        torch.manual_seed(7)
        with torch.no_grad():
            g = model.generate(input_ids=x, attention_mask=torch.ones_like(x), max_new_tokens=2500, do_sample=True, temperature=0.6,
                               top_p=0.95, repetition_penalty=1.1, eos_token_id=END_SPEECH, pad_token_id=PAD)[0][x.shape[1]:].tolist()
        if START_SPEECH in g:
            g = g[len(g) - g[::-1].index(START_SPEECH):]
        c = [t - OFF for t in g if t >= OFF]
        c = c[: len(c) // 7 * 7]
        if c:
            l1, l2, l3 = [], [], []
            for i in range(len(c) // 7):
                b = 7 * i
                l1.append(c[b]); l2.append(c[b + 1] - 4096); l3 += [c[b + 2] - 2 * 4096, c[b + 3] - 3 * 4096]
                l2.append(c[b + 4] - 4 * 4096); l3 += [c[b + 5] - 5 * 4096, c[b + 6] - 6 * 4096]
            with torch.inference_mode():
                audio = snac.decode([torch.tensor(v).unsqueeze(0).clamp(0, 4095).to(dev) for v in (l1, l2, l3)]).squeeze().float().cpu().numpy()
            sf.write(os.path.join(out, "sample.wav"), audio, 24000)
            sample = {"text": TEST_LINE, "duration": round(len(audio) / 24000, 2)}
    except Exception as e:  # noqa: BLE001  the sample is a convenience; the model check is the real test
        print(f"[dpo] test line failed ({type(e).__name__}: {e})", flush=True)

    json.dump({"clips": len(pairs), "pairs": len(pairs), "method": "dpo", "held_out_accuracy": round(acc, 3), "margin": round(margin, 4),
               "minutes": float(cfg.get("minutes") or 0), "epochs": epochs, "steps": step, "batch": accum,
               "loss": round(sum(losses) / max(1, len(losses)), 4), "speaker": speaker, "base": BASE, "sample": sample},
              open(os.path.join(out, "result.json"), "w"))
    report("done")


if __name__ == "__main__":
    main()
