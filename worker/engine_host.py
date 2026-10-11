"""Runs ONE engine inside its own virtualenv and serves it on localhost.

  python engine_host.py --engine orpheus --port 8103

POST /synth        {"text", "voice", "params", "ref_path"?, "ref_text"?, "out_path"} -> {"duration", "sample_rate"}
POST /synth_batch  {"items": [<synth payload>, ...]} -> {"results": [{"duration", "sample_rate"} | {"error"}]}
POST /transcribe   {"paths": [...], "language"?, "prompt"?} -> {"results": [{"text", "words", "duration"}]}
GET  /ready        -> {"ready": true, "batch": bool}
Only binds to 127.0.0.1: the gateway is the only thing that talks to engines.
Everything runs under __main__ so engines that spawn worker processes (vLLM) can re-import this file safely.
"""
import argparse, importlib, json, os, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()

    mod = importlib.import_module(f"engines.{args.engine}")
    t0 = time.time()
    engine = mod.Engine()
    print(f"[{args.engine}] loaded in {time.time() - t0:.1f}s", flush=True)
    lock = threading.Lock()  # one GPU call at a time per engine
    import soundfile as sf

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
                return self._send(200, {"ready": True, "batch": hasattr(engine, "synth_batch")})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            try:
                with lock:
                    if self.path == "/synth":
                        return self._send(200, synth_one(req))
                    if self.path == "/synth_batch":
                        items = req["items"]
                        if hasattr(engine, "synth_batch"):
                            outs = engine.synth_batch(items)
                            res = []
                            for it, out in zip(items, outs):
                                if isinstance(out, Exception):
                                    res.append({"error": f"{type(out).__name__}: {out}"})
                                else:
                                    sf.write(it["out_path"], out[0], out[1])
                                    res.append({"duration": len(out[0]) / out[1], "sample_rate": out[1]})
                            return self._send(200, {"results": res})
                        res = []
                        for it in items:
                            try:
                                res.append(synth_one(it))
                            except Exception as e:
                                traceback.print_exc()
                                res.append({"error": f"{type(e).__name__}: {e}"})
                        return self._send(200, {"results": res})
                    if self.path == "/transcribe":
                        return self._send(200, {"results": [engine.transcribe(p, req.get("language"), req.get("prompt"))
                                                            for p in req["paths"]]})
                return self._send(404, {"error": "not found"})
            except Exception as e:  # report, don't crash the engine
                traceback.print_exc()
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

    ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()


if __name__ == "__main__":
    main()
