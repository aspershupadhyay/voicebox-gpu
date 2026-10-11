#!/usr/bin/env bash
# Run the worker gateway on this machine (no tunnel) for development.
# Uses existing Python envs via VOICEBOX_PY_<ENGINE>, e.g.
#   VOICEBOX_PY_KOKORO=~/.cache/hyperframes/kokoro-venv/bin/python scripts/local-worker.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .secrets.local; set +a
export VOICEBOX_HOME=${VOICEBOX_HOME:-$PWD/.local/voicebox}
mkdir -p "$VOICEBOX_HOME"
echo "http://127.0.0.1:${PORT:-8000}" > "$VOICEBOX_HOME/public_url"
# the gateway needs numpy + soundfile (+ scipy optional); reuse an engine venv if the system python lacks them
exec "${VOICEBOX_GATEWAY_PY:-${VOICEBOX_PY_KOKORO:-python3}}" worker/gateway.py --port "${PORT:-8000}"
