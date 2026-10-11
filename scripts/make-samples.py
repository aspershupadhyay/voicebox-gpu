#!/usr/bin/env python3
"""Record one audition sample per voice (every engine) and store it in R2 (samples/<engine>/<voice>.wav).

The Voices page and the voice tiles in Generate play these, so picking a voice never needs the GPU.
Every voice reads the same line (translated for Kokoro's non-English voices) in the default Tech style.

  scripts/make-samples.py                 # only voices without a sample yet
  scripts/make-samples.py --force         # redo everything
  scripts/make-samples.py --engine orpheus
  scripts/make-samples.py --engine kokoro --voices jf_alpha,jm_kumo
"""
import argparse, json, os, ssl, sys, time, urllib.request

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")

LINES = {
    "en": "Here's how your phone finds you: four satellites, a few billionths of a second, and some seriously clever math.",
    "hi": "आपका फ़ोन आपको ऐसे ढूँढता है: चार सैटेलाइट, एक सेकंड का अरबवाँ हिस्सा, और कमाल का गणित।",
    "es": "Así es como tu teléfono te encuentra: cuatro satélites, unas milmillonésimas de segundo y unas matemáticas muy ingeniosas.",
    "fr": "Voici comment ton téléphone te trouve : quatre satellites, quelques milliardièmes de seconde et des maths vraiment astucieuses.",
    "it": "Ecco come il tuo telefono ti trova: quattro satelliti, pochi miliardesimi di secondo e una matematica davvero geniale.",
    "pt": "É assim que o seu celular te encontra: quatro satélites, alguns bilionésimos de segundo e uma matemática muito esperta.",
    "ja": "スマホがあなたの居場所を見つける方法：四つの衛星、数十億分の一秒、そして本当に賢い数学です。",
    "zh": "你的手机是这样找到你的：四颗卫星，几十亿分之一秒，还有非常巧妙的数学。",
}
KOKORO_LANG = {"a": "en", "b": "en", "e": "es", "f": "fr", "h": "hi", "i": "it", "j": "ja", "p": "pt", "z": "zh"}
ORDER = ["kokoro", "orpheus", "chatterbox", "qwen"]  # cheapest first; voice engines only


def env():
    for ln in open(os.path.join(os.path.dirname(__file__), "..", ".secrets.local")):
        if "=" in ln and not ln.startswith("#"):
            k, v = ln.strip().split("=", 1)
            os.environ.setdefault(k, v.strip('"'))
    return "https://mcp-eta-tawny.vercel.app/api/dash", {"Authorization": f"Bearer {os.environ['MCP_TOKEN']}"}


def http(url, h, body=None):
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                               headers={**h, "Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=120, context=CTX) as res:
        return json.loads(res.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--engine", choices=ORDER)
    ap.add_argument("--voices", help="comma-separated: only these voices (implies --force for them)")
    a = ap.parse_args()
    base, h = env()
    cat = http(f"{base}/voices", h)["engines"]
    have = http(f"{base}/samples", h)["voices"]
    todo = []
    for eng in [a.engine] if a.engine else ORDER:
        voices = [v for v in cat[eng]["voices"] if not v.startswith("<")]
        if eng in ("chatterbox", "qwen"):
            voices = ["female", "male"]
        for v in voices:
            if a.voices and v not in a.voices.split(","):
                continue
            if a.force or a.voices or v not in have.get(eng, {}):
                todo.append((eng, v))
    print(f"{len(todo)} samples to record", flush=True)
    queued = []
    for eng, v in todo:
        lang = KOKORO_LANG.get(v[0], "en") if eng == "kokoro" else "en"
        text = LINES[lang]
        j = http(f"{base}/jobs", h, {"engine": eng, "voice": v, "lines": [{"id": "sample", "text": text}], "style": "tech",
                                      "label": f"sample · {eng} {v}", "language": lang})
        queued.append((j["id"], eng, v, text))
    failed = 0
    for jid, eng, v, text in queued:
        while True:
            # ?raw: status only; a plain jobs/<id> would also archive the sample into the Library
            st = http(f"{base}/jobs/{jid}?raw", h)
            if st["status"] in ("done", "error", "cancelled"):
                break
            time.sleep(3)
        if st["status"] != "done":
            failed += 1
            print(f"  {eng}/{v}: {st['status']} {st.get('error') or ''}", flush=True)
            continue
        dur = st["results"][0]["duration"]
        http(f"{base}/samples/{eng}/{v}", h, {"job": jid, "line": "sample", "duration": dur, "text": text})
        print(f"  {eng}/{v}: {dur:.1f}s", flush=True)
    print(f"done, {len(queued) - failed} stored, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
