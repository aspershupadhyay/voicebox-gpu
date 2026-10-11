#!/usr/bin/env bash
# End-to-end check against a deployed (or local) MCP server.
#   scripts/smoke.sh https://your-app.vercel.app      # tools/list + worker_status
#   scripts/smoke.sh http://localhost:3000 voice      # also synthesise one Kokoro line
set -euo pipefail
cd "$(dirname "$0")/.."
base=${1:?usage: smoke.sh <base-url> [voice]}
set -a; source .secrets.local; set +a
rpc() {
  curl -sS "$base/api/mcp" -H "Authorization: Bearer $MCP_TOKEN" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-06-18' -d "$1" | sed -n 's/^data: //;/^{/p'
}
echo "-- unauthenticated request should be 401:"
curl -s -o /dev/null -w '%{http_code}\n' "$base/api/mcp" -X POST -H 'Content-Type: application/json' -d '{}'
echo "-- tools:"
rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c 'import json,sys; print(" ".join(t["name"] for t in json.load(sys.stdin)["result"]["tools"]))'
echo "-- worker_status:"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"worker_status","arguments":{}}}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["content"][0]["text"])'
if [[ ${2:-} == voice ]]; then
  echo "-- voice_lines (kokoro):"
  rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"voice_lines","arguments":{"engine":"kokoro","voice":"female","lines":[{"id":"smoke","text":"Voicebox is online.","window":3}]}}}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["content"][0]["text"])'
fi
