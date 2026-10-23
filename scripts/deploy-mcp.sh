#!/usr/bin/env bash
# Deploy the MCP server to Vercel and push the secrets as env vars.
# Needs: `npx vercel login` done once, and a private Cloudflare R2 bucket whose R2_* keys are in .secrets.local
# (bucket CORS: docs/r2-cors.json). Optional in .secrets.local: HF_TOKEN, APPWRITE_API_KEY (workspace, docs/WORKSPACE.md), WORKSPACE_EMAILS.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .secrets.local ]] || scripts/gen-secrets.sh
set -a; source .secrets.local; set +a
python3 notebook/build_notebook.py >/dev/null  # the worker bundle Colab pulls from /api/bundle: always ship the current worker/
cd mcp
npx -y vercel@latest link --yes ${VERCEL_SCOPE:+--scope "$VERCEL_SCOPE"} >/dev/null
for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  [[ -n "${!name:-}" ]] || { echo "missing $name in .secrets.local" >&2; exit 1; }
done
for name in MCP_TOKEN WORKER_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET ${HF_TOKEN:+HF_TOKEN} ${APPWRITE_API_KEY:+APPWRITE_API_KEY} ${WORKSPACE_EMAILS:+WORKSPACE_EMAILS}; do
  for env in production preview; do
    npx -y vercel@latest env rm "$name" "$env" --yes >/dev/null 2>&1 || true
    printf '%s' "${!name}" | npx -y vercel@latest env add "$name" "$env" >/dev/null
  done
done
# deploy from a git-free copy: Vercel blocks CLI deploys whose commit author has no linked Git account
tmp=$(mktemp -d)/mcp; mkdir -p "$tmp"
rsync -a --exclude node_modules --exclude .next --exclude '.env*' ./ "$tmp/"
(cd "$tmp" && npx -y vercel@latest deploy --prod --yes >/dev/null 2>&1)
# stable production alias (deployment URLs sit behind Vercel deployment protection)
project=$(python3 -c 'import json;print(json.load(open(".vercel/project.json"))["projectName"])')
url=$(npx -y vercel@latest project inspect "$project" 2>/dev/null | grep -o "https://[a-z0-9.-]*vercel.app" | head -1 || true)
url=${PUBLIC_URL:-${url:-$(cat ../.local-deploy-url 2>/dev/null || true)}}
echo "deployed: $url"
echo "MCP endpoint:  $url/api/mcp"
echo "REGISTER_URL:  $url/api/register   (put this in Colab Secrets)"
echo "$url" > ../.local-deploy-url 2>/dev/null || true
