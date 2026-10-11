"""Regenerate the engine/parameter tables in docs/API.md from worker/config.py."""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "worker"))
import config as C  # noqa: E402

rows = ["| Engine | VRAM | Presets (female / male) | About |", "|---|---|---|---|"]
for name, e in C.ENGINES.items():
    rows.append(f"| `{name}` | {e['gpu_gb']:g} GB | {('`' + e['presets']['female'] + '` / `' + e['presets']['male'] + '`') if e['presets'] else 'n/a (subtitles)'} | {e['about']} |")
out = ["\n".join(rows), ""]
for name, e in C.ENGINES.items():
    out.append(f"#### `{name}` params\n\n| Param | Default | Range | Notes |\n|---|---|---|---|")
    for k, p in e["params"].items():
        rng = f"{p['min']:g} – {p['max']:g}" if "min" in p else ""
        out.append(f"| `{k}` | `{p['default']!r}` | {rng} | {p.get('about', '')} |")
    out.append("")
out.append("#### Post-processing (`post`)\n\n| Key | Default |\n|---|---|")
out += [f"| `{k}` | `{v!r}` |" for k, v in C.POST_DEFAULTS.items()]
out.append(f"\n#### Delivery styles (`style`, default `{C.DEFAULT_STYLE}`)\n\nA style sets engine params and `post` defaults; explicit values in the request win. "
           "Measured with `scripts/style-bench.py`.\n\n| Style | About | orpheus | chatterbox | kokoro | post |\n|---|---|---|---|---|---|")
for k, st in C.STYLES.items():
    cell = lambda e: ", ".join(f"{a}={b}" for a, b in st["params"].get(e, {}).items()) or "defaults"
    out.append(f"| `{k}` | {st['about']} | {cell('orpheus')} | {cell('chatterbox')} | {cell('kokoro')} | "
               f"{', '.join(f'{a}={b}' for a, b in st['post'].items()) or '—'} |")
block = "<!-- engines:start -->\n" + "\n".join(out) + "\n<!-- engines:end -->"

path = os.path.join(ROOT, "docs", "API.md")
doc = open(path).read()
doc = re.sub(r"<!-- engines:start -->.*<!-- engines:end -->", lambda _: block, doc, flags=re.S)
open(path, "w").write(doc)
print("updated", path)
