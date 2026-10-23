#!/usr/bin/env bash
# Deploy the MCP server to Vercel and push the secrets as env vars.
# Needs: `npx vercel login` done once, and a private Cloudflare R2 bucket whose R2_* keys are in .secrets.local
# (bucket CORS: docs/r2-cors.json). Optional in .secrets.local: HF_TOKEN, APPWRITE_API_KEY (workspace, docs/WORKSPACE.md), WORKSPACE_EMAILS.
set -euo pipefail
cd "$(dirname "$0")/.."
# SKIP_ENV=1 ships code only and keeps the env vars already on Vercel (no .secrets.local needed)
if [[ ${SKIP_ENV:-} != 1 ]]; then
  [[ -f .secrets.local ]] || scripts/gen-secrets.sh
  set -a; source .secrets.local; set +a
fi
python3 notebook/build_notebook.py >/dev/null  # the worker bundle Colab pulls from /api/bundle: always ship the current worker/
cd mcp
npx -y vercel@latest link --yes ${VERCEL_SCOPE:+--scope "$VERCEL_SCOPE"} >/dev/null
for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  [[ ${SKIP_ENV:-} == 1 || -n "${!name:-}" ]] || { echo "missing $name in .secrets.local" >&2; exit 1; }
done
names="MCP_TOKEN WORKER_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET ${HF_TOKEN:+HF_TOKEN} ${APPWRITE_API_KEY:+APPWRITE_API_KEY} ${WORKSPACE_EMAILS:+WORKSPACE_EMAILS} ${GITHUB_CLIENT_ID:+GITHUB_CLIENT_ID} ${GITHUB_CLIENT_SECRET:+GITHUB_CLIENT_SECRET} ${OWNER_GITHUB:+OWNER_GITHUB}"
# `vercel env pull` writes "[SENSITIVE]" for secrets it can't read: never push those over the real values
for name in $names; do
  [[ ${!name:-} != *SENSITIVE* ]] || { echo "$name is a placeholder from \`vercel env pull\`; put the real value in .secrets.local" >&2; exit 1; }
done
if [[ ${SKIP_ENV:-} == 1 ]]; then echo "SKIP_ENV=1: keeping the env vars already on Vercel"; else
  for name in $names; do
    printf '%s' "${!name}" | npx -y vercel@latest env add "$name" --environment production,preview --force --yes >/dev/null
  done
fi
# deploy from a git-free copy: Vercel blocks CLI deploys whose commit author has no linked Git account
tmp=$(mktemp -d)/mcp; mkdir -p "$tmp"
rsync -a --exclude node_modules --exclude .next --exclude '.env*' ./ "$tmp/"
(cd "$tmp" && npx -y vercel@latest deploy --prod --yes)
# stable production alias (deployment URLs sit behind Vercel deployment protection)
# newer CLIs link a git checkout through ../.vercel/repo.json instead of .vercel/project.json
project=$(python3 -c 'import json;print(json.load(open(".vercel/project.json"))["projectName"])' 2>/dev/null \
  || python3 -c 'import json;print(next(p["name"] for p in json.load(open("../.vercel/repo.json"))["projects"] if p.get("directory") in ("mcp","mcp/")))' 2>/dev/null \
  || echo mcp)
url=$(npx -y vercel@latest project inspect "$project" 2>/dev/null | grep -o "https://[a-z0-9.-]*vercel.app" | head -1 || true)
url=${PUBLIC_URL:-${url:-$(cat ../.local-deploy-url 2>/dev/null || true)}}
echo "deployed: $url"
echo "MCP endpoint:  $url/api/mcp"
echo "REGISTER_URL:  $url/api/register   (put this in Colab Secrets)"
echo "$url" > ../.local-deploy-url 2>/dev/null || true
