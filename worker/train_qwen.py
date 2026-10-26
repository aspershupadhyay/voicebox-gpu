"""Fine-tune Qwen3-TTS 1.7B Base on one person's dataset (Your model page): a single-speaker custom voice.

Runs in the qwen engine's venv (qwen-tts + accelerate + librosa), started by the gateway's train job with engine "qwen":

  python train_qwen.py job.json

job.json: {"parts": [{"url"}], "name", "epochs"?, "learning_rate"?, "work", "out", "progress"}
Uses Qwen's own recipe (qwen_ft/, vendored from QwenLM/Qwen3-TTS finetuning/): every clip with its transcript and one
fixed reference clip -> 12 Hz codec tokens (prepare_data.py) -> full fine-tune of the talker (sft_12hz.py) -> a
custom-voice checkpoint whose speaker is <name>. Writes <out>/qmodel.zip (config.json + model.safetensors + ref.wav: the
qwen engine rebuilds the rest from the base model), <out>/sample.wav (a line it never heard) and <out>/result.json.
Needs a bf16 GPU (Ampere or newer: A100, L4, A10) and ~25 GB free: it trains every weight, not an adapter.
"""
import glob, json, os, shutil, subprocess, sys, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from resume import Resume  # noqa: E402
BASE = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
TEST_LINE = "Hey, welcome back to the channel. Today we're breaking down how Kubernetes actually schedules your containers."


def main():
    cfg = json.load(open(sys.argv[1]))
    work, out, prog, name = cfg["work"], cfg["out"], cfg["progress"], cfg["name"]
    os.makedirs(work, exist_ok=True)

    def report(phase, step=0, total=0, **kw):
        with open(prog + ".tmp", "w") as f:
            json.dump({"phase": phase, "step": step, "total": total, "t": time.time(), **kw}, f)
        os.replace(prog + ".tmp", prog)

    # ── the dataset: every session's clips (24 kHz WAV + metadata.csv "wavs/x.wav|text")
    import soundfile as sf
    rows = []
    for i, p in enumerate(cfg["parts"]):
        report("downloading", i, len(cfg["parts"]), detail=f"session {i + 1} of {len(cfg['parts'])}")
        d = os.path.join(work, f"part{i}")
        with urllib.request.urlopen(p["url"], timeout=900) as r, open(d + ".zip", "wb") as f:
            shutil.copyfileobj(r, f)
        zipfile.ZipFile(d + ".zip").extractall(d)
        os.remove(d + ".zip")
        for ln in open(os.path.join(d, "metadata.csv"), encoding="utf-8"):
            f_, _, text = ln.rstrip("\n").partition("|")
            path = os.path.join(d, f_)
            if text.strip() and os.path.exists(path):
                rows.append({"audio": path, "text": text.strip(), "dur": sf.info(path).duration})
    if not rows:
        raise SystemExit("the dataset has no clips")
    minutes = sum(r["dur"] for r in rows) / 60

    # one reference for every clip (Qwen's advice: it keeps the speaker steady): a 6-12 s clip from mid-dataset
    mid = len(rows) // 2
    ref = min(enumerate(rows), key=lambda ir: (not 6 <= ir[1]["dur"] <= 12, abs(ir[0] - mid)))[1]["audio"]
    os.makedirs(out, exist_ok=True)
    shutil.copy(ref, os.path.join(out, "ref.wav"))
    raw = os.path.join(work, "train_raw.jsonl")
    with open(raw, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps({"audio": r["audio"], "text": r["text"], "ref_audio": ref}, ensure_ascii=False) + "\n")

    # ── codec tokens, then the fine-tune (Qwen's scripts, in their own process each so the GPU is clean between them)
    report("encoding", 0, len(rows), detail=f"{len(rows)} clips into codec tokens")
    codes = os.path.join(work, "train_with_codes.jsonl")
    ft = os.path.join(HERE, "qwen_ft")
    subprocess.run([sys.executable, "prepare_data.py", "--device", "cuda:0", "--input_jsonl", raw, "--output_jsonl", codes],
                   cwd=ft, check=True)
    report("loading", detail="loading Qwen3-TTS 1.7B")
    from huggingface_hub import snapshot_download
    base_dir = snapshot_download(BASE)  # local: the trainer copies it into the checkpoint
    epochs = int(cfg.get("epochs") or (6 if minutes < 10 else 4 if minutes < 30 else 3))
    bs = 2
    per_epoch = -(-len(rows) // bs)
    sft_prog = os.path.join(work, "sft.json")
    # the weights after every epoch go to storage as they land; a run started again carries on from there (resume.py)
    rdir = os.path.join(work, "resume")
    saver = Resume(cfg)
    resumed = saver.fetch(rdir)
    pushed = (resumed or {}).get("epoch", 0)
    p = subprocess.Popen([sys.executable, "sft_12hz.py", "--init_model_path", base_dir, "--output_model_path", os.path.join(work, "out"),
                          "--train_jsonl", codes, "--batch_size", str(bs), "--lr", str(cfg.get("learning_rate") or 2e-5),
                          "--num_epochs", str(epochs), "--speaker_name", name, "--progress", sft_prog, "--resume_dir", rdir], cwd=ft)
    loss = None
    while p.poll() is None:
        time.sleep(5)
        try:
            e = json.load(open(os.path.join(rdir, "epoch.json")))["epoch"]
            if e > pushed:
                pushed = e
                saver.push(rdir, {"epoch": e}, skip=lambda f: f.endswith(".tmp"))
        except (OSError, ValueError, KeyError):
            pass
        try:
            s = json.load(open(sft_prog))
        except Exception:  # noqa: BLE001
            continue
        loss = s.get("loss", loss)
        step = s["epoch"] * per_epoch + s["step"]
        report("training", step, epochs * per_epoch, loss=loss,
               detail=f"epoch {s['epoch'] + 1} of {epochs} · step {s['step']} of {per_epoch}" + (f" · loss {loss:.3f}" if loss else ""))
    if p.returncode != 0:
        raise SystemExit(f"fine-tuning stopped (exit {p.returncode})")
    ckpt = os.path.join(work, "out", "checkpoint-final")

    # ── a line it never heard, in the new voice
    report("testing", detail="voicing a test line")
    import torch
    from qwen_tts import Qwen3TTSModel
    tts = Qwen3TTSModel.from_pretrained(ckpt, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
    torch.manual_seed(7)
    wavs, sr = tts.generate_custom_voice(text=TEST_LINE, language="English", speaker=name)
    sf.write(os.path.join(out, "sample.wav"), wavs[0], sr)
    sample = {"text": TEST_LINE, "duration": round(len(wavs[0]) / sr, 2)}
    del tts
    torch.cuda.empty_cache()

    # ── the model: only what differs from the base (the engine links the rest back in)
    report("saving", detail="packing the model")
    with zipfile.ZipFile(os.path.join(out, "qmodel.zip"), "w", zipfile.ZIP_STORED) as z:
        for f in ("config.json", "model.safetensors"):
            z.write(os.path.join(ckpt, f), f)
        z.write(os.path.join(out, "ref.wav"), "ref.wav")
    json.dump({"engine": "qwen", "clips": len(rows), "minutes": round(minutes, 2), "epochs": epochs, "steps": epochs * per_epoch,
               "batch": bs, "loss": round(loss or 0.0, 4), "speaker": name, "base": BASE, "sample": sample},
              open(os.path.join(out, "result.json"), "w"))
    saver.wait()
    shutil.rmtree(work, ignore_errors=True)
    report("done")


if __name__ == "__main__":
    main()
