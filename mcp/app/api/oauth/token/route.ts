// Token endpoint: authorization_code (PKCE S256) and refresh_token grants. Public clients only.
import { cors, issueTokens, oauthError, pkceOk, sha, verify, type Code } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  const p: Record<string, string> = type.includes("application/json")
    ? await req.json().catch(() => ({}))
    : Object.fromEntries(new URLSearchParams(await req.text()));
  const client_id = p.client_id ?? "";
  if (!client_id) return oauthError("invalid_client", "client_id is required", 401);

  if (p.grant_type === "authorization_code") {
    const code = verify<Code>(p.code, "code");
    if (!code || code.cid !== sha(client_id)) return oauthError("invalid_grant", "code is invalid or expired");
    if (code.redirect_uri !== p.redirect_uri) return oauthError("invalid_grant", "redirect_uri mismatch");
    if (!pkceOk(p.code_verifier ?? "", code.challenge)) return oauthError("invalid_grant", "PKCE verification failed");
  } else if (p.grant_type === "refresh_token") {
    const rt = verify<{ typ: "refresh"; cid: string }>(p.refresh_token, "refresh");
    if (!rt || rt.cid !== sha(client_id)) return oauthError("invalid_grant", "refresh_token is invalid or expired");
  } else {
    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }
  return Response.json(issueTokens(client_id), { headers: { ...cors, "Cache-Control": "no-store", Pragma: "no-cache" } });
}

export const OPTIONS = () => new Response(null, { status: 204, headers: cors });
