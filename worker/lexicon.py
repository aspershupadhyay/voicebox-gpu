"""What the voice actually reads: tech pronunciation, markdown clean-up and [pause] markers.

The script the user wrote stays untouched (subtitles and the match score compare against it); only the
text handed to the TTS engine is rewritten. English only: other languages pass through unchanged.

  speakable("Run SQL on 2 GPUs, e.g. via the API.")
    -> "Run sequel on 2 G P U's, for example via the A P I."
  segments("Ready? [pause 0.8] Let's go.")
    -> [("Ready?", 0.8), ("Let's go.", None)]
"""
import re

# Spelled letter by letter. Case-sensitive, so "IT" or "US" written as words are left alone.
LETTERS = """AI AGI ML LLM NLP GPU CPU NPU TPU APU VRAM DRAM API SDK CLI IDE UI UX URL HTML CSS JS PHP AWS GCP HTTP HTTPS
SSH SSL TLS TCP UDP DNS VPN RAM ROM SSD HDD NVMe USB HDMI PDF CSV XML SVG PNG MP3 MP4 RGB LED LCD CEO CTO MVP AMD TSMC
IBM HP LG CNN RNN GAN SoC IoT AR VR XR EV PC IPO ROI KPI SEO CMS CDN ORM JWT UUID MCP RLHF TTS STT OCR GPS NFC LTE
QA CI CD OS NPM PNPM AV1 HEVC FPS RTX GTX NAS""".split()

# Said as a word, or a better spoken form. Matched on word boundaries, case-sensitive.
SAY = {
    "SQL": "sequel", "MySQL": "my sequel", "NoSQL": "no sequel", "SQLite": "sequel light", "PostgreSQL": "postgres",
    "GraphQL": "graph Q L", "JSON": "jay-son", "YAML": "yammel", "GUI": "gooey", "SaaS": "sass", "PaaS": "pass",
    "NGINX": "engine X", "Nginx": "engine X", "nginx": "engine X", "CUDA": "koo-dah", "k8s": "kubernetes",
    "K8s": "kubernetes", "LLaMA": "llama", "PyPI": "pie P I", "iOS": "eye O S", "iPadOS": "eye pad O S",
    "macOS": "mac O S", "watchOS": "watch O S", "OAuth": "oh auth", "ChatGPT": "chat G P T", "OpenAI": "open A I",
    "gRPC": "G R P C", "WebRTC": "web R T C", "WebGPU": "web G P U", "WASM": "wazum", "Wasm": "wazum",
    "ASCII": "ask-ee", "LaTeX": "lay-tech", "README": "read me", "localhost": "local host", "sudo": "soo-doo",
    "regex": "rej-ex", "async": "ay-sink", "JPEG": "jay-peg", "JPG": "jay-peg", "OLED": "oh-led", "Qwen": "Chwen", "npm": "N P M", "pnpm": "P N P M",
    "NVIDIA": "en-vidia", "Nvidia": "en-vidia", "x86": "x eighty-six", "x64": "x sixty-four", "arm64": "arm sixty-four",
    "B2B": "B to B", "B2C": "B to C", "e.g.": "for example", "i.e.": "that is", "etc.": "et cetera", "vs.": "versus",
    "vs": "versus", "w/": "with", "w/o": "without",
}
# Symbols that read badly; tried after the words above.
PUNCT = [(r"C\+\+", "C plus plus"), (r"C#", "C sharp"), (r"F#", "F sharp"), (r"\.NET\b", "dot net"),
         (r"(?<=\w)\.js\b", " J S"), (r"(?<=\w)\.ts\b", " T S"), (r"(?<=\w)\.py\b", " dot pie"),
         (r"\s&\s", " and "), (r"\s?→\s?", " to "), (r"\s?->\s?", " to "), (r"(?<=\d)\s?[x×](?=\s|$|[.,!?])", " X")]
# Units after a number: 16GB -> 16 gigabytes, 1080p -> 1080 p.
UNITS = {"TB": "terabytes", "GB": "gigabytes", "MB": "megabytes", "KB": "kilobytes", "Gb": "gigabits",
         "Mbps": "megabits per second", "Gbps": "gigabits per second", "GHz": "gigahertz", "MHz": "megahertz",
         "kHz": "kilohertz", "Hz": "hertz", "ms": "milliseconds", "fps": "F P S", "W": "watts", "mAh": "milliamp hours",
         "nm": "nanometers", "K": "K", "p": "p", "B": "billion", "M": "million", "T": "trillion"}

PAUSE_RE = re.compile(r"\[\s*(pause|beat|breath)(?:\s+(\d+(?:\.\d+)?)\s*(ms|s)?)?\s*\]", re.I)
PAUSE_DEFAULT = {"pause": 0.6, "beat": 0.35, "breath": 0.25}


def _wb(word):
    """Word-boundary pattern that also works for words starting/ending with symbols (e.g. "e.g.", "w/")."""
    return (r"(?<![\w.])" if word[0].isalnum() else r"(?<!\w)") + re.escape(word) + (r"(?![\w])" if word[-1].isalnum() else r"(?!\w)")


def _letters(m):
    word, plural = m.group(1), m.group(2)
    spoken = " ".join(word.upper()) if not word[-1].isdigit() else " ".join(word[:-1].upper()) + " " + word[-1]
    return spoken + ("'s" if plural else "")


_LETTERS_RE = re.compile(r"(?<![\w.])(" + "|".join(sorted(map(re.escape, LETTERS), key=len, reverse=True)) + r")(s)?(?![\w])")
# multi-letter units may follow a space ("16 GB"); single letters only stick to the number ("4K", "8B")
_UNITS_RE = re.compile(r"(\d(?:[\d,]*\d)?(?:\.\d+)?)(?:\s?(" + "|".join(sorted((u for u in UNITS if len(u) > 1), key=len, reverse=True))
                       + r")|(" + "|".join(u for u in UNITS if len(u) == 1) + r"))(?![\w])")


def strip_markdown(text):
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)          # images
    text = re.sub(r"\[([^\]]+)\]\((?:[^)]*)\)", r"\1", text)         # [label](url) -> label
    text = re.sub(r"(\*\*|__)(.+?)\1", r"\2", text)                  # bold
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"\1", text)  # *emphasis*
    text = re.sub(r"`([^`]+)`", r"\1", text)                         # inline code
    text = re.sub(r"^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s+)", "", text, flags=re.M)  # headings, bullets, quotes
    return text


def _url(m):
    u = re.sub(r"^https?://(www\.)?", "", m.group(0)).rstrip("/")
    return u.replace(".", " dot ").replace("/", " slash ").replace("-", " ")


def speakable(text, pronounce=None, tech=True):
    """Rewrite text for the engine. pronounce = {"word": "how to say it"} wins over the built-in list."""
    text = strip_markdown(text)
    text = re.sub(r"\bhttps?://\S+[^\s.,!?;:)]|\bwww\.\S+[^\s.,!?;:)]", _url, text)
    for word, say in sorted((pronounce or {}).items(), key=lambda kv: -len(kv[0])):
        if word.strip():
            text = re.sub(_wb(word.strip()), say, text)
    if not tech:
        return re.sub(r"[ \t]+", " ", text).strip()
    text = re.sub(r"(?<![\w.])etc\.(?=\s+[A-Z]|\s*$)", "et cetera.", text)  # keep the full stop that ends a sentence
    for word, say in sorted(SAY.items(), key=lambda kv: -len(kv[0])):
        text = re.sub(_wb(word), say, text)
    for pat, say in PUNCT:
        text = re.sub(pat, say, text)
    text = re.sub(r"\bv(\d+(?:\.\d+)*)\b", r"version \1", text)
    text = _UNITS_RE.sub(lambda m: f"{m.group(1)} {UNITS[m.group(2) or m.group(3)]}", text)
    text = _LETTERS_RE.sub(_letters, text)
    return re.sub(r"[ \t]+", " ", text).strip()


def segments(text):
    """Split at [pause], [pause 0.8], [pause 800ms], [beat], [breath] markers.
    Returns [(text, gap_after_seconds | None)]: None means the normal gap between sentences."""
    out, pos = [], 0
    for m in PAUSE_RE.finditer(text):
        kind, num, unit = m.group(1).lower(), m.group(2), (m.group(3) or "s").lower()
        gap = PAUSE_DEFAULT[kind] if num is None else float(num) / (1000 if unit == "ms" else 1)
        gap = max(0.05, min(5.0, gap))
        piece = text[pos:m.start()].strip()
        if piece:
            out.append([piece, gap])
        elif out:
            out[-1][1] = (out[-1][1] or 0) + gap  # two markers in a row add up
        pos = m.end()
    tail = text[pos:].strip()
    if tail:
        out.append([tail, None])
    return [tuple(x) for x in out]


def is_devanagari(text):
    return bool(re.search(r"[ऀ-ॿ]", text))
