"""Runs ONE engine inside its own virtualenv and serves it on localhost.

  python engine_host.py --engine orpheus --port 8103

POST /synth {"text", "voice", "params", "ref_path"?, "ref_text"?, "out_path"} -> {"duration", "sample_rate"}
GET  /ready -> {"ready": true}
Only binds to 127.0.0.1: the gateway is the only thing that talks to engines.
"""
import argparse, importlib, json, os, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument("--engine", required=True)
ap.add_argument("--port", type=int, required=True)
args = ap.parse_args()

mod = importlib.import_module(f"engines.{args.engine}")
t0 = time.time()
engine = mod.Engine()
print(f"[{args.engine}] loaded in {time.time() - t0:.1f}s", flush=True)
lock = threading.Lock()  # one synthesis at a time per engine (GPU)


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
        self._send(200, {"ready": True}) if self.path == "/ready" else self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synth":
            return self._send(404, {"error": "not found"})
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        try:
            with lock:
                audio, sr = engine.synth(req["text"], req.get("voice"), req.get("params") or {},
                                         req.get("ref_path"), req.get("ref_text"))
            import soundfile as sf
            sf.write(req["out_path"], audio, sr)
            self._send(200, {"duration": len(audio) / sr, "sample_rate": sr})
        except Exception as e:  # report, don't crash the engine
            traceback.print_exc()
            self._send(500, {"error": f"{type(e).__name__}: {e}"})


ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()
