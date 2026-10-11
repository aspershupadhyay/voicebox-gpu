#!/usr/bin/env bash
# Create MCP_TOKEN (your MCP client -> Vercel) and WORKER_SECRET (Vercel <-> Colab worker).
# Written to .secrets.local (gitignored). Re-run with --force to rotate.
set -euo pipefail
cd "$(dirname "$0")/.."
f=.secrets.local
if [[ -f $f && ${1:-} != --force ]]; then echo "$f exists (use --force to rotate)"; exit 0; fi
umask 077
{
  echo "MCP_TOKEN=$(openssl rand -hex 32)"
  echo "WORKER_SECRET=$(openssl rand -hex 32)"
} > "$f"
echo "wrote $f (mode 600). Values are never printed; read them from the file when needed."
