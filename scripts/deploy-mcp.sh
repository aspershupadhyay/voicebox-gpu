#!/usr/bin/env bash
# Deploy the MCP server to Vercel and push the secrets as env vars.
# Needs: `npx vercel login` done once. Blob store: create it in the Vercel dashboard
# (Storage -> Blob -> Private) and connect it to the project; that adds BLOB_READ_WRITE_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .secrets.local ]] || scripts/gen-secrets.sh
set -a; source .secrets.local; set +a
cd mcp
npx -y vercel@latest link --yes ${VERCEL_SCOPE:+--scope "$VERCEL_SCOPE"} >/dev/null
for name in MCP_TOKEN WORKER_SECRET; do
  for env in production preview; do
    npx -y vercel@latest env rm "$name" "$env" --yes >/dev/null 2>&1 || true
    printf '%s' "${!name}" | npx -y vercel@latest env add "$name" "$env" >/dev/null
  done
done
url=$(npx -y vercel@latest deploy --prod --yes 2>/dev/null | tail -1)
echo "deployed: $url"
echo "MCP endpoint:  $url/api/mcp"
echo "REGISTER_URL:  $url/api/register   (put this in Colab Secrets)"
echo "$url" > ../.local-deploy-url 2>/dev/null || true
