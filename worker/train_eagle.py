"""Train an EAGLE draft head for Orpheus (docs/INFERENCE.md step 5b), in the orpheus venv (vLLM + torch).

A draft head is one decoder layer that reads Orpheus's last hidden state and the next token, and guesses the hidden
state after it; vLLM checks a few of its guesses per forward pass of the big model (speculative_config method "eagle"),
so one step can move several codec tokens. The layout is EAGLE-1 for Llama, as vLLM loads it (llama_eagle.py):
fc (2H -> H, no bias) over [token embedding, hidden state], one Llama layer without its input norm, no final norm; the
embeddings and lm_head are Orpheus's own.

Three stages, each its own process so vLLM and the training model never share the GPU:

  gen    voice --sentences sentences from a public text corpus with vLLM, every voice, the sampling Orpheus is used with
         (temperature 0.5-0.8, top_p 0.95, repetition penalty 1.1), and keep the token ids (prompt + audio codes)
  train  Orpheus frozen in bf16 gives the hidden states; the head learns to predict the next one (smooth L1) and the
         same next-token distribution over the audio vocabulary (soft cross-entropy), with noise on its inputs so it
         copes with its own guesses. Starts from Orpheus's last layer. Reports how often its top guess is the model's
         and the acceptance it would get at temperature 0.65 on held-out sequences.
  bench  vLLM as the engine runs it (same pool, fp8 where the engine uses it), plain or with the head, on lines it never
         trained on: one request alone, 10 lines together, 40 together. Codec tokens a second for each.

  python train_eagle.py <stage> <config.json>

config: {"out": dir, "progress": file, "sentences": 6000, "epochs": 2, "spec": null | {"model": dir, "k": 3}}
Writes <out>/data.jsonl (gen), <out>/head/ (config.json + model.safetensors) and <out>/train.json (train),
<out>/bench-<name>.json (bench).
"""
import json, math, os, random, re, sys, time

MODEL = os.environ.get("ORPHEUS_MODEL", "unsloth/orpheus-3b-0.1-ft")
START, END_TEXT, END_HUMAN, END_AUDIO = 128259, 128009, 128260, 128258
AUDIO_LO = 128256  # Orpheus's added tokens start here: the audio codes (from 128266) and their markers
VOICES = ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"]
TEMP_SERVED = 0.65  # the tech style's temperature: what the acceptance estimate assumes
# Lines the head never trains on (the benchmark script of scripts/bench_voice.py, plus long ones for a lone request)
HELD_OUT = [
    "Here's how your phone finds you, anywhere on Earth.",
    "Above us, about thirty satellites circle the planet twice a day.",
    "Each one keeps shouting the time, measured by an atomic clock on board.",
    "Your phone listens for at least four of them at once.",
    "A signal from a satellite overhead takes about sixty-seven milliseconds to arrive.",
    "The tiny differences between those arrival times tell your phone how far away each satellite is.",
    "Four distances, one point where they all meet: that's you.",
    "But there's a catch. The clocks up there run faster than ours, by about thirty-eight microseconds a day.",
    "Einstein saw it coming, and every satellite is corrected for it.",
    "Without that fix, your map would drift by about ten kilometres every single day.",
]
LONE = ["The tiny differences between those arrival times, measured in billionths of a second by the receiver inside "
        "your phone, tell it exactly how far away each satellite is right now.",
        "Most of what makes a voice sound human is not the words at all, but the small pauses, breaths and changes of "
        "pace between them, and that is exactly what the model has to learn."]


def progress(cfg, phase, step=0, total=0, detail=""):
    try:
        with open(cfg["progress"] + ".part", "w") as f:
            json.dump({"phase": phase, "step": step, "total": total, "detail": detail, "t": time.time()}, f)
        os.replace(cfg["progress"] + ".part", cfg["progress"])
    except OSError:
        pass


def token_budget(text):  # as engines/orpheus.py
    return int(min(8000, max(2.0, len(text) / 11.0) * 86 * 1.5 + 300))


def fp8_ok():
    import torch
    return os.environ.get("ORPHEUS_FP8", "1") == "1" and torch.cuda.get_device_capability(0) >= (8, 0)


# ── text: public-domain-licensed sentences of voiceover length (WikiText-103, CC BY-SA)
def sentences(n, seed=7):
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download
    path = hf_hub_download("Salesforce/wikitext", "wikitext-103-raw-v1/train-00000-of-00002.parquet", repo_type="dataset")
    fix = [(" @-@ ", "-"), (" @,@ ", ","), (" @.@ ", "."), (" ,", ","), (" .", "."), (" ;", ";"), (" :", ":"),
           (" 's", "'s"), (" n't", "n't"), ("( ", "("), (" )", ")"), (" ?", "?"), (" !", "!"), (' " ', ' "')]
    out, held = [], set(HELD_OUT + LONE)
    for line in pq.read_table(path, columns=["text"]).column("text").to_pylist():
        line = line.strip()
        if not line or line.startswith("="):
            continue
        for a, b in fix:
            line = line.replace(a, b)
        for s in re.split(r"(?<=[.!?])\s+", line):
            s = s.strip()
            if 30 <= len(s) <= 220 and s[0].isupper() and s[-1] in ".!?" and "<unk>" not in s and s not in held \
                    and not re.search(r"[\[\]{}|=@#]", s):
                out.append(s)
    random.Random(seed).shuffle(out)
    return out[:n]


def build_llm(spec=None, util=None, seqs=None):
    import torch
    from vllm import LLM
    total = torch.cuda.get_device_properties(0).total_memory / 2**30
    kw = dict(model=MODEL, dtype="bfloat16" if torch.cuda.get_device_capability(0)[0] >= 8 else "float16",
              gpu_memory_utilization=util or min(0.9, float(os.environ.get("ORPHEUS_VRAM_GB", "12")) / total),
              max_model_len=8192, enable_prefix_caching=True, max_num_seqs=seqs or int(os.environ.get("ORPHEUS_MAX_SEQS", "128")))
    if spec:
        kw["speculative_config"] = {"method": "eagle", "model": spec["model"], "num_speculative_tokens": int(spec["k"])}
    if fp8_ok():
        try:
            return LLM(quantization="fp8", **kw)
        except Exception as e:  # noqa: BLE001  as the engine: 16-bit when fp8 won't start
            print(f"fp8 unavailable ({type(e).__name__}: {e})", flush=True)
            torch.cuda.empty_cache()
    return LLM(**kw)


def prompt_ids(tok, voice, text):
    return [START, *tok(f"{voice}: {text}").input_ids, END_TEXT, END_HUMAN]


# ── gen
def gen(cfg):
    from vllm import SamplingParams
    progress(cfg, "downloading", 0, 1, "fetching sentences")
    texts = sentences(int(cfg.get("sentences") or 6000))
    progress(cfg, "loading", 0, 1, "loading Orpheus on vLLM")
    llm = build_llm(util=0.85, seqs=256)  # the whole card is ours: as many sentences at once as the cache takes
    tok = llm.get_tokenizer()
    rng = random.Random(11)
    out = os.path.join(cfg["out"], "data.jsonl")
    made, t0 = 0, time.time()
    with open(out, "w") as f:
        step = 512
        for b in range(0, len(texts), step):
            chunk = texts[b:b + step]
            voices = [VOICES[(b + i) % len(VOICES)] for i in range(len(chunk))]
            prompts = [{"prompt_token_ids": prompt_ids(tok, v, t)} for v, t in zip(voices, chunk)]
            sps = [SamplingParams(temperature=rng.uniform(0.5, 0.8), top_p=0.95, repetition_penalty=1.1,
                                  max_tokens=token_budget(t), stop_token_ids=[END_AUDIO], seed=rng.randrange(1 << 30))
                   for t in chunk]
            for p, r in zip(prompts, llm.generate(prompts, sps, use_tqdm=False)):
                g = list(r.outputs[0].token_ids)
                if len(g) < 30 or r.outputs[0].finish_reason != "stop":
                    continue  # a take that ran to its budget (rambling) teaches nothing useful
                f.write(json.dumps({"p": len(p["prompt_token_ids"]), "ids": p["prompt_token_ids"] + g}) + "\n")
                made += len(g)
            progress(cfg, "generating", min(len(texts), b + step), len(texts),
                     f"{min(len(texts), b + step)} of {len(texts)} sentences voiced · {made / max(1e-3, time.time() - t0):.0f} tokens/s")
    json.dump({"sentences": len(texts), "tokens": made, "secs": round(time.time() - t0, 1)}, open(os.path.join(cfg["out"], "gen.json"), "w"))


# ── the head (EAGLE-1 for Llama, vLLM's names)
def make_head(tcfg):
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from transformers.models.llama.modeling_llama import apply_rotary_pos_emb
    H, nh, nkv = tcfg.hidden_size, tcfg.num_attention_heads, tcfg.num_key_value_heads
    hd = getattr(tcfg, "head_dim", None) or H // nh
    bias = bool(getattr(tcfg, "attention_bias", False))

    class RMSNorm(nn.Module):
        def __init__(self):
            super().__init__()
            self.weight = nn.Parameter(torch.ones(H))

        def forward(self, x):
            v = x.float()
            v = v * torch.rsqrt(v.pow(2).mean(-1, keepdim=True) + tcfg.rms_norm_eps)
            return (self.weight * v).to(x.dtype)

    class Attn(nn.Module):
        def __init__(self):
            super().__init__()
            self.q_proj = nn.Linear(H, nh * hd, bias=bias)
            self.k_proj = nn.Linear(H, nkv * hd, bias=bias)
            self.v_proj = nn.Linear(H, nkv * hd, bias=bias)
            self.o_proj = nn.Linear(nh * hd, H, bias=False)

        def forward(self, x, cos, sin):
            B, T, _ = x.shape
            q = self.q_proj(x).view(B, T, nh, hd).transpose(1, 2)
            k = self.k_proj(x).view(B, T, nkv, hd).transpose(1, 2)
            v = self.v_proj(x).view(B, T, nkv, hd).transpose(1, 2)
            q, k = apply_rotary_pos_emb(q, k, cos, sin)
            k, v = k.repeat_interleave(nh // nkv, 1), v.repeat_interleave(nh // nkv, 1)
            o = F.scaled_dot_product_attention(q, k, v, is_causal=True)  # right padding: real tokens never see it
            return self.o_proj(o.transpose(1, 2).reshape(B, T, nh * hd))

    class MLP(nn.Module):
        def __init__(self):
            super().__init__()
            I = tcfg.intermediate_size
            self.gate_proj, self.up_proj, self.down_proj = nn.Linear(H, I, bias=False), nn.Linear(H, I, bias=False), nn.Linear(I, H, bias=False)

        def forward(self, x):
            return self.down_proj(F.silu(self.gate_proj(x)) * self.up_proj(x))

    class Layer(nn.Module):  # vLLM's EAGLE layer 0: no input norm
        def __init__(self):
            super().__init__()
            self.self_attn, self.mlp, self.post_attention_layernorm = Attn(), MLP(), RMSNorm()

        def forward(self, h, cos, sin):
            h = h + self.self_attn(h, cos, sin)
            return h + self.mlp(self.post_attention_layernorm(h))

    class Head(nn.Module):
        def __init__(self):
            super().__init__()
            self.fc = nn.Linear(2 * H, H, bias=False)
            self.layers = nn.ModuleList([Layer()])

        def forward(self, emb, feat, cos, sin):
            return self.layers[0](self.fc(torch.cat((emb, feat), -1)), cos, sin)

    return Head()


def batches(rows, budget, shuffle, rng):
    """Sequences of similar length together, up to budget tokens a batch (padding included)."""
    order = sorted(range(len(rows)), key=lambda i: len(rows[i]["ids"]))
    out, cur, longest = [], [], 0
    for i in order:
        n = len(rows[i]["ids"])
        if cur and max(longest, n) * (len(cur) + 1) > budget:
            out.append(cur)
            cur, longest = [], 0
        cur.append(i)
        longest = max(longest, n)
    if cur:
        out.append(cur)
    if shuffle:
        rng.shuffle(out)
    return out


def train(cfg):
    import torch
    import torch.nn.functional as F
    from safetensors.torch import save_file
    from transformers import AutoConfig, AutoModelForCausalLM
    from transformers.models.llama.modeling_llama import LlamaRotaryEmbedding
    progress(cfg, "loading", 0, 1, "loading Orpheus to teach the draft")
    torch.manual_seed(7)
    rng = random.Random(7)
    rows = [json.loads(ln) for ln in open(os.path.join(cfg["out"], "data.jsonl"))]
    rows = [r for r in rows if len(r["ids"]) <= 4096]
    rng.shuffle(rows)
    n_val = max(8, len(rows) // 50)
    val, rows = rows[:n_val], rows[n_val:]
    tcfg = AutoConfig.from_pretrained(MODEL)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    target = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.bfloat16).to(dev).eval()
    for p in target.parameters():
        p.requires_grad_(False)
    rope = LlamaRotaryEmbedding(config=tcfg).to(dev)  # the same RoPE (llama3 scaling) as Orpheus and vLLM
    W = target.get_output_embeddings().weight[AUDIO_LO:].detach().float()  # the audio vocabulary's rows of lm_head
    emb_layer = target.get_input_embeddings()
    head = make_head(tcfg).to(dev)
    with torch.no_grad():  # start from Orpheus's last layer; fc passes the hidden state through
        last = target.model.layers[-1]
        for name in ("q_proj", "k_proj", "v_proj", "o_proj"):
            getattr(head.layers[0].self_attn, name).weight.copy_(getattr(last.self_attn, name).weight.float())
        for name in ("gate_proj", "up_proj", "down_proj"):
            getattr(head.layers[0].mlp, name).weight.copy_(getattr(last.mlp, name).weight.float())
        head.layers[0].post_attention_layernorm.weight.copy_(last.post_attention_layernorm.weight.float())
        H = tcfg.hidden_size
        head.fc.weight.zero_()
        head.fc.weight[:, :H].normal_(0, 0.02)
        head.fc.weight[:, H:].copy_(torch.eye(H))
    epochs = int(cfg.get("epochs") or 2)
    big = dev == "cuda" and torch.cuda.get_device_properties(0).total_memory > 60 * 2**30
    budget = int(cfg.get("batch_tokens") or (24000 if big else 12000))
    plan = [batches(rows, budget, True, rng) for _ in range(epochs)]
    total = sum(len(p) for p in plan)
    opt = torch.optim.AdamW(head.parameters(), lr=float(cfg.get("lr") or 3e-4), betas=(0.9, 0.95), weight_decay=0.0)
    warm = min(100, total // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: (s + 1) / warm if s < warm else
                                              0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * (s - warm) / max(1, total - warm))))

    def batch_tensors(idx, data):
        seqs = [data[i]["ids"] for i in idx]
        T = max(len(s) for s in seqs)
        ids = torch.full((len(seqs), T), END_AUDIO, dtype=torch.long)
        mask = torch.zeros((len(seqs), T - 1), dtype=torch.bool)  # position j predicts hidden state j+1
        for b, s in enumerate(seqs):
            ids[b, :len(s)] = torch.tensor(s)
            mask[b, data[idx[b]]["p"] - 1:len(s) - 2] = True  # the audio part: hidden states whose next token is a code
        return ids.to(dev), mask.to(dev)

    def step_losses(ids, mask, noise):
        with torch.no_grad():
            feat = target.model(input_ids=ids).last_hidden_state  # after Orpheus's final norm, as vLLM hands it over
            emb = emb_layer(ids)
            if noise:
                scale = feat.float().pow(2).mean(-1, keepdim=True).sqrt()
                inp = feat[:, :-1] + ((torch.rand_like(feat[:, :-1], dtype=torch.float32) - 0.5) * 0.2 * scale[:, :-1]).to(feat.dtype)
            else:
                inp = feat[:, :-1]
        pos = torch.arange(ids.shape[1] - 1, device=dev).unsqueeze(0).expand(ids.shape[0], -1)
        cos, sin = rope(inp, pos)
        with torch.autocast(dev, dtype=torch.bfloat16):
            pred = head(emb[:, 1:], inp, cos, sin)
        want = feat[:, 1:]
        p, w = pred[mask].float(), want[mask].float()
        if not p.shape[0]:
            return pred.sum() * 0, 0.0, 0, 0.0, 0
        vloss = F.smooth_l1_loss(p, w)
        ploss, agree, accept, n = 0.0, 0, 0.0, p.shape[0]
        for c in range(0, n, 4096):  # the audio vocabulary is ~29k rows: chunks keep the logits small
            lp = p[c:c + 4096] @ W.T
            with torch.no_grad():
                lw = w[c:c + 4096] @ W.T
                tgt = lw.softmax(-1)
                guess = lp.argmax(-1)
                agree += (guess == lw.argmax(-1)).sum().item()
                accept += (lw / TEMP_SERVED).softmax(-1).gather(1, guess[:, None]).sum().item()
            ploss = ploss - (tgt * lp.log_softmax(-1)).sum()
        ploss = ploss / max(1, n)
        return vloss, ploss, agree, accept, n

    def evaluate():
        head.eval()
        tot = {"agree": 0, "accept": 0.0, "n": 0, "vloss": 0.0}
        with torch.no_grad():
            for idx in batches(val, budget, False, rng):
                ids, mask = batch_tensors(idx, val)
                v, _, a, acc, n = step_losses(ids, mask, False)
                tot["agree"] += a
                tot["accept"] += acc
                tot["n"] += n
                tot["vloss"] += v.item() * n
        head.train()
        n = max(1, tot["n"])
        return {"top1": round(tot["agree"] / n, 4), "accept_t065": round(tot["accept"] / n, 4), "vloss": round(tot["vloss"] / n, 4)}

    before = evaluate()
    print("before training:", before, flush=True)
    step, t0, hist = 0, time.time(), []
    for ep in range(epochs):
        for idx in plan[ep]:
            ids, mask = batch_tensors(idx, rows)
            if not mask.any():
                continue
            v, pl, a, acc, n = step_losses(ids, mask, True)
            loss = v + 0.1 * pl
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), 0.5)
            opt.step()
            sched.step()
            step += 1
            hist.append((a / max(1, n), acc / max(1, n)))
            if step % 20 == 0 or step == total:
                t1, a1 = (sum(x[0] for x in hist[-50:]) / len(hist[-50:]), sum(x[1] for x in hist[-50:]) / len(hist[-50:]))
                progress(cfg, "training", step, total, f"epoch {ep + 1} of {epochs} · top guess right {t1:.0%} · "
                                                       f"accepted ~{a1:.0%} at temperature {TEMP_SERVED}")
                print(f"step {step}/{total} loss {loss.item():.4f} v {v.item():.4f} p {float(pl):.3f} top1 {t1:.3f} accept {a1:.3f} "
                      f"{(time.time() - t0) / step:.2f}s/step", flush=True)
    after = evaluate()
    print("after training:", after, flush=True)
    progress(cfg, "saving", 0, 1, "saving the draft")
    hdir = os.path.join(cfg["out"], "head")
    os.makedirs(hdir, exist_ok=True)
    d = tcfg.to_dict()
    d.update(num_hidden_layers=1, architectures=["LlamaForCausalLM"], torch_dtype="bfloat16")
    json.dump(d, open(os.path.join(hdir, "config.json"), "w"), indent=2)
    sd = {k: v.detach().to(torch.bfloat16).contiguous().cpu() for k, v in head.state_dict().items()}
    sd["embed_tokens.weight"] = emb_layer.weight.detach().to(torch.bfloat16).contiguous().cpu()  # vLLM shares Orpheus's own
    save_file(sd, os.path.join(hdir, "model.safetensors"), metadata={"format": "pt"})
    json.dump({"before": before, "after": after, "steps": total, "epochs": epochs, "sequences": len(rows),
               "tokens": sum(len(r["ids"]) - r["p"] for r in rows), "secs": round(time.time() - t0, 1)},
              open(os.path.join(cfg["out"], "train.json"), "w"), indent=2)


# ── bench
def bench(cfg):
    from vllm import SamplingParams
    spec = cfg.get("spec")
    name = f"eagle-k{spec['k']}" if spec else "plain"
    progress(cfg, "testing", 0, 1, f"loading Orpheus ({name})")
    llm = build_llm(spec)
    tok = llm.get_tokenizer()

    def run(texts, seed0):
        prompts = [{"prompt_token_ids": prompt_ids(tok, "tara", t)} for t in texts]
        sps = [SamplingParams(temperature=TEMP_SERVED, top_p=0.95, repetition_penalty=1.1, max_tokens=token_budget(t),
                              stop_token_ids=[END_AUDIO], seed=seed0 + i) for i, t in enumerate(texts)]
        t = time.time()
        res = llm.generate(prompts, sps, use_tqdm=False)
        secs = time.time() - t
        toks = sum(len(r.outputs[0].token_ids) for r in res)
        return {"tokens": toks, "secs": round(secs, 2), "tokens_per_s": round(toks / secs, 1)}

    run(HELD_OUT[:2], 1)  # warm-up: CUDA graphs and caches, not timed
    out = {"name": name, "lone": [run([t], 7) for t in LONE], "ten": run(HELD_OUT, 7), "forty": run(HELD_OUT * 4, 7)}
    try:  # vLLM's own count of guesses accepted, where this version keeps it
        m = {x.name: x for x in llm.get_metrics()}
        drafted = getattr(m.get("vllm:spec_decode_num_draft_tokens"), "value", None)
        accepted = getattr(m.get("vllm:spec_decode_num_accepted_tokens"), "value", None)
        if drafted:
            out["acceptance"] = round(accepted / drafted, 4)
    except Exception:  # noqa: BLE001
        pass
    out["lone_tokens_per_s"] = round(sum(x["tokens"] for x in out["lone"]) / sum(x["secs"] for x in out["lone"]), 1)
    json.dump(out, open(os.path.join(cfg["out"], f"bench-{name}.json"), "w"), indent=2)
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    stage, cfg = sys.argv[1], json.load(open(sys.argv[2]))
    {"gen": gen, "train": train, "bench": bench}[stage](cfg)
