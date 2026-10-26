"""Runs ONE engine inside its own virtualenv and serves it on localhost.

  python engine_host.py --engine orpheus --port 8103

POST /synth        {"text", "voice", "params", "ref_path"?, "ref_text"?, "out_path"} -> {"duration", "sample_rate"}
POST /synth_batch  {"items": [<synth payload>, ...]} -> {"results": [{"duration", "sample_rate"} | {"error"}], "codec_s"?}
POST /transcribe   {"paths": [...], "language"?, "prompt"?, "words"?} -> {"results": [{"text", "words", "duration"}]}
                       words: false = text only, short clips batched (the review); words stay []
POST /similarity   {"ref", "paths": [...]} -> {"scores": [cosine, ...]}            (whisper host: speaker match)
POST /mos          {"paths": [...]} -> {"scores": [1-5, ...]}                     (whisper host: predicted naturalness)
POST /enhance      {"src_path", "out_path", "params"} -> {"duration", "sample_rate"}     (enhance host: studio clean-up)
POST /revoice      {"src_path", "ref_path", "out_path"} -> {"duration", "sample_rate"}  (chatterbox host: voice conversion)
POST /video        {"prompt", "width", "height", "num_frames", "fps", "steps", "seed", "out_path", "progress_path", ...}
                   -> {"frames", "width", "height", "fps", "duration", "has_audio"}
POST /park         -> {"parked": true, "secs"}   move the model off the GPU into RAM (another engine needs the GPU)
POST /wake         -> {"parked": false, "secs"}  and back, in seconds instead of a cold start
GET  /ready        -> {"ready": true, "batch": bool, "parked": bool}
Only binds to 127.0.0.1: the gateway is the only thing that talks to engines.
Everything runs under __main__ so engines that spawn worker processes (vLLM) can re-import this file safely.
"""
import argparse, importlib, inspect, json, os, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _modules(engine):
    """The torch modules an engine holds, found through its attributes (pipelines, wrappers, tuples, dicts), outermost
    first and each once."""
    import torch
    seen, out = set(), []

    def walk(x, depth):
        if x is None or id(x) in seen or depth > 4 or isinstance(x, (str, bytes, int, float, bool)):
            return
        seen.add(id(x))
        if isinstance(x, torch.nn.Module):
            out.append(x)
            return
        if isinstance(x, dict):
            for v in x.values():
                walk(v, depth + 1)
        elif isinstance(x, (list, tuple, set)):
            for v in x:
                walk(v, depth + 1)
        elif getattr(x, "components", None) is not None and isinstance(x.components, dict):  # a diffusers pipeline
            for v in x.components.values():
                walk(v, depth + 1)
        elif hasattr(x, "__dict__") and type(x).__module__.split(".")[0] not in ("builtins", "threading", "logging", "vllm"):
            for k, v in vars(x).items():
                if not k.startswith("__"):
                    walk(v, depth + 1)
    walk(engine, 0)
    return out


def park(engine):
    """Off the GPU, into RAM: the engine's own park() if it has one, vLLM's sleep (weights to RAM, cache dropped),
    and every torch module to the CPU. The process, its imports and compiled kernels stay, which is the slow part."""
    import torch
    if hasattr(engine, "park"):
        return engine.park()
    llm = getattr(engine, "llm", None)
    if llm is not None:
        llm.sleep(level=1)  # raises when the engine was built without sleep mode: the gateway then stops it instead
    for m in _modules(engine):
        m.to("cpu")
    torch.cuda.empty_cache()


def wake(engine):
    import torch
    if hasattr(engine, "wake"):
        return engine.wake()
    llm = getattr(engine, "llm", None)
    if llm is not None:
        llm.wake_up()
        try:
            llm.reset_prefix_cache()  # the cache was dropped while asleep
        except Exception:  # noqa: BLE001
            pass
    for m in _modules(engine):
        m.to("cuda")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()

    mod = importlib.import_module(f"engines.{args.engine}")
    t0 = time.time()
    for attempt in range(6):
        try:
            engine = mod.Engine()
            break
        except Exception as e:  # Hugging Face rate limit mid-download: wait it out; finished files stay cached
            if attempt == 5 or not any(k in str(e) for k in ("429", "Too Many Requests", "rate limit")):
                raise
            wait = 60 * (attempt + 1)
            print(f"[{args.engine}] Hugging Face rate limit, retrying the download in {wait}s ({e.__class__.__name__})", flush=True)
            time.sleep(wait)
    print(f"[{args.engine}] loaded in {time.time() - t0:.1f}s", flush=True)
    parked = [False]
    lock = threading.Lock()  # one GPU call at a time per engine
    try:  # audio engines only; image / video venvs don't ship soundfile
        import soundfile as sf
    except ImportError:
        sf = None

    def synth_one(req):
        audio, sr = engine.synth(req["text"], req.get("voice"), req.get("params") or {}, req.get("ref_path"), req.get("ref_text"))
        sf.write(req["out_path"], audio, sr)
        return {"duration": len(audio) / sr, "sample_rate": sr}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/ready":
                return self._send(200, {"ready": True, "batch": hasattr(engine, "synth_batch"), "parked": parked[0]})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            try:
                with lock:
                    if self.path in ("/park", "/wake"):
                        t = time.time()
                        if (self.path == "/park") != parked[0]:
                            park(engine) if self.path == "/park" else wake(engine)
                            parked[0] = self.path == "/park"
                        return self._send(200, {"parked": parked[0], "secs": round(time.time() - t, 2)})
                    if parked[0]:
                        wake(engine)  # a request reached a parked engine: bring it back first
                        parked[0] = False
                    if self.path == "/synth":
                        return self._send(200, synth_one(req))
                    if self.path == "/synth_batch":
                        items = req["items"]
                        if hasattr(engine, "synth_batch"):
                            saved = set()

                            def save(j, out):
                                """Write one chunk; atomically, so the gateway (watching for the first line) never
                                reads half a file. Engines that stream call it as each chunk finishes."""
                                it = items[j]
                                part = it["out_path"][:-4] + ".part.wav"
                                sf.write(part, out[0], out[1])
                                os.replace(part, it["out_path"])
                                if it.get("codes_path") and it.get("key") in getattr(engine, "recent", {}):
                                    json.dump(engine.recent[it["key"]][1], open(it["codes_path"], "w"))  # for preference pairs
                                saved.add(j)
                            streams = "emit" in inspect.signature(engine.synth_batch).parameters
                            outs = engine.synth_batch(items, emit=save) if streams else engine.synth_batch(items)
                            res = []
                            for j, (it, out) in enumerate(zip(items, outs)):
                                if isinstance(out, Exception):
                                    res.append({"error": f"{type(out).__name__}: {out}"})
                                else:
                                    if j not in saved:
                                        save(j, out)
                                    res.append({"duration": len(out[0]) / out[1], "sample_rate": out[1]})
                            # seconds spent turning codes into audio (Orpheus / myvoice): the job's "codec" step
                            return self._send(200, {"results": res, "codec_s": round(getattr(engine, "codec_s", 0.0), 3)})
                        res = []
                        for it in items:
                            try:
                                res.append(synth_one(it))
                            except Exception as e:
                                traceback.print_exc()
                                res.append({"error": f"{type(e).__name__}: {e}"})
                        return self._send(200, {"results": res})
                    if self.path == "/video":
                        return self._send(200, engine.video(req))
                    if self.path == "/image":
                        return self._send(200, engine.image(req))
                    if self.path == "/animate":
                        return self._send(200, engine.animate(req))
                    if self.path == "/similarity":
                        return self._send(200, {"scores": engine.similarity(req["ref"], req["paths"])})
                    if self.path == "/mos":
                        return self._send(200, {"scores": engine.mos(req["paths"])})
                    if self.path == "/enhance":
                        audio, sr = engine.enhance(req["src_path"], req.get("params") or {})
                        sf.write(req["out_path"], audio, sr)
                        return self._send(200, {"duration": len(audio) / sr, "sample_rate": sr})
                    if self.path == "/revoice":
                        audio, sr = engine.revoice(req["src_path"], req["ref_path"])
                        sf.write(req["out_path"], audio, sr)
                        return self._send(200, {"duration": len(audio) / sr, "sample_rate": sr})
                    if self.path == "/transcribe":
                        if req.get("words") is False and hasattr(engine, "transcribe_text"):  # the review: text only, batched
                            return self._send(200, {"results": engine.transcribe_text(req["paths"], req.get("language"))})
                        if hasattr(engine, "transcribe_batch"):
                            return self._send(200, {"results": engine.transcribe_batch(req["paths"], req.get("language"))})
                        return self._send(200, {"results": [engine.transcribe(p, req.get("language"), req.get("prompt"))
                                                            for p in req["paths"]]})
                return self._send(404, {"error": "not found"})
            except Exception as e:  # report, don't crash the engine
                traceback.print_exc()
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

    ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()


if __name__ == "__main__":
    main()
