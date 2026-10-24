"""Voice a long-form markdown script with ElevenLabs, rotating API keys as each one runs out of credits.

  python3 scripts/elevenlabs-longform.py SCRIPT.md OUT_DIR [--voice ID] [--model eleven_v4_turbo] [--dry-run]

Keys come from ELEVENLABS_API_KEYS (comma-separated) or ELEVENLABS_API_KEY, in the environment or .env.local.
"## " headings are chapter markers (not spoken); paragraphs are never split across requests. Each chunk is saved as
OUT_DIR/chunks/NNN.mp3 and skipped on re-run, so a crash or a spent key never pays for the same text twice.
Writes OUT_DIR/episode.mp3 (-16 LUFS, chapter metadata) and OUT_DIR/chapters.txt (YouTube-style timestamps).
"""
import argparse, json, os, re, subprocess, sys

from dotenv import load_dotenv
from elevenlabs import VoiceSettings
from elevenlabs.client import ElevenLabs
from elevenlabs.core import ApiError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHAPTER_GAP = 1.2   # seconds of silence before each new chapter
PARA_GAP = 0.35     # seconds between chunks inside a chapter


def load_env():
    load_dotenv(os.path.join(ROOT, ".env.local"))
    keys = os.environ.get("ELEVENLABS_API_KEYS") or os.environ.get("ELEVENLABS_API_KEY", "")
    return [k.strip() for k in keys.split(",") if k.strip()]


def parse(path, max_chars):
    """[(chapter_title, [chunk, ...]), ...] with chunks packed from whole paragraphs."""
    text = re.sub(r"<!--.*?-->", "", open(path).read(), flags=re.S)
    chapters, title, paras = [], None, []
    for block in re.split(r"\n\s*\n", text):
        block = " ".join(block.split())
        if not block or block.startswith("# "):
            continue
        if block.startswith("## "):
            if paras:
                chapters.append((title, paras))
            title, paras = block[3:].strip(), []
        else:
            paras.append(block)
    if paras:
        chapters.append((title, paras))
    out = []
    for title, ps in chapters:
        chunks, cur = [], ""
        for p in ps:
            if cur and len(cur) + 1 + len(p) > max_chars:
                chunks.append(cur)
                cur = p
            else:
                cur = f"{cur} {p}".strip()
        chunks.append(cur)
        out.append((title, chunks))
    return out


class Keys:
    """Hands out a key with enough credits left; moves to the next one when it runs dry."""

    def __init__(self, keys, multiplier):
        self.keys, self.mult, self.i = keys, multiplier, 0

    def left(self, k):
        s = ElevenLabs(api_key=k).user.subscription.get()
        return s.character_limit - s.character_count

    def balances(self):
        return [self.left(k) for k in self.keys]

    def client_for(self, n_chars):
        need = n_chars * self.mult
        while self.i < len(self.keys):
            k = self.keys[self.i]
            left = self.left(k)
            if left >= need:
                return ElevenLabs(api_key=k), k
            print(f"  key …{k[-4:]} has {left} credits, chunk needs {need:.0f}: switching", flush=True)
            self.i += 1
        sys.exit("All keys are out of credits. Re-run later or add a key; finished chunks are kept.")

    def spent(self):
        self.i += 1


def duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


def silence(path, secs):
    if not os.path.exists(path):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", str(secs),
                        "-c:a", "libmp3lame", "-b:a", "128k", path], check=True)
    return path


def stamp(t):
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("script")
    ap.add_argument("out")
    ap.add_argument("--voice", default="FZkK3TvQ0pjyDmT8fzIW")
    ap.add_argument("--model", default="eleven_v4_turbo")
    ap.add_argument("--max-chars", type=int, default=2400)
    ap.add_argument("--stability", type=float, default=0.45)
    ap.add_argument("--similarity", type=float, default=0.8)
    ap.add_argument("--style", type=float, default=0.25)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    keys = load_env()
    if not keys:
        sys.exit("Set ELEVENLABS_API_KEYS or ELEVENLABS_API_KEY (in the environment or .env.local).")
    model = next(m for m in ElevenLabs(api_key=keys[0]).models.list() if m.model_id == a.model)
    mult = model.model_rates.character_cost_multiplier if model.model_rates else 1.0
    chapters = parse(a.script, a.max_chars)
    flat = [(ci, c) for ci, (_, cs) in enumerate(chapters) for c in cs]
    os.makedirs(os.path.join(a.out, "chunks"), exist_ok=True)
    todo = [i for i in range(len(flat)) if not os.path.exists(os.path.join(a.out, "chunks", f"{i:03d}.mp3"))]
    need = sum(len(flat[i][1]) for i in todo) * mult
    pool = Keys(keys, mult)
    bal = pool.balances()
    print(f"{len(chapters)} chapters, {len(flat)} chunks, {sum(len(c) for _, c in flat)} chars; "
          f"{len(todo)} chunks to voice = {need:.0f} credits on {a.model} (x{mult}); keys have {bal} = {sum(bal)}")
    if a.dry_run:
        return
    if need > sum(bal):
        sys.exit("Not enough credits across all keys for the remaining chunks.")

    settings = VoiceSettings(stability=a.stability, similarity_boost=a.similarity, style=a.style,
                             use_speaker_boost=True, speed=a.speed)
    for i in todo:
        text = flat[i][1]
        dest = os.path.join(a.out, "chunks", f"{i:03d}.mp3")
        while True:
            client, k = pool.client_for(len(text))
            try:
                audio = b"".join(client.text_to_speech.convert(
                    voice_id=a.voice, model_id=a.model, text=text, output_format="mp3_44100_128",
                    voice_settings=settings,
                    previous_text=flat[i - 1][1][-600:] if i > 0 else None,
                    next_text=flat[i + 1][1][:300] if i + 1 < len(flat) else None))
                break
            except ApiError as e:
                body = json.dumps(e.body) if not isinstance(e.body, str) else e.body
                if "quota_exceeded" in body or "insufficient" in body:
                    print(f"  key …{k[-4:]} refused ({e.status_code}): switching", flush=True)
                    pool.spent()
                    continue
                sys.exit(f"ElevenLabs error {e.status_code}: {body[:400]}")
        with open(dest + ".part", "wb") as f:
            f.write(audio)
        os.replace(dest + ".part", dest)
        print(f"  [{i + 1}/{len(flat)}] {len(text)} chars, {duration(dest):.1f}s (key …{k[-4:]})", flush=True)

    # Stitch: chunk audio with short gaps, longer gaps at chapter starts, then two-pass-free loudnorm to podcast level.
    gap_p = silence(os.path.join(a.out, "chunks", "gap_para.mp3"), PARA_GAP)
    gap_c = silence(os.path.join(a.out, "chunks", "gap_chapter.mp3"), CHAPTER_GAP)
    parts, marks, t = [], [], 0.0
    for i, (ci, _) in enumerate(flat):
        if i > 0:
            g = gap_c if ci != flat[i - 1][0] else gap_p
            parts.append(g)
            t += duration(g)
        if i == 0 or ci != flat[i - 1][0]:
            marks.append((t, chapters[ci][0] or "Intro"))
        p = os.path.join(a.out, "chunks", f"{i:03d}.mp3")
        parts.append(p)
        t += duration(p)
    lst = os.path.join(a.out, "concat.txt")
    with open(lst, "w") as f:
        f.writelines(f"file '{os.path.abspath(p)}'\n" for p in parts)
    meta = os.path.join(a.out, "chapters.ffmeta")
    with open(meta, "w") as f:
        f.write(";FFMETADATA1\n")
        for n, (start, title) in enumerate(marks):
            end = marks[n + 1][0] if n + 1 < len(marks) else t
            f.write(f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={int(start * 1000)}\nEND={int(end * 1000)}\ntitle={title}\n")
    final = os.path.join(a.out, "episode.mp3")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-i", meta,
                    "-map_metadata", "1", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100",
                    "-c:a", "libmp3lame", "-b:a", "192k", final], check=True)
    with open(os.path.join(a.out, "chapters.txt"), "w") as f:
        f.writelines(f"{stamp(s)} {title}\n" for s, title in marks)
    print(f"Wrote {final} ({stamp(duration(final))}); keys now have {pool.balances()} credits left")


if __name__ == "__main__":
    main()
