// RFC 7591 dynamic client registration. The client_id is a signed list of its redirect URIs, so nothing is stored.
import { cors, issueClient, oauthError, okRedirect } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const meta = await req.json().catch(() => null);
  const uris: unknown = meta?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2048 && okRedirect(u)))
    return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs (or http on localhost)");
  const name = typeof meta.client_name === "string" ? meta.client_name.slice(0, 100) : undefined;
  let client_id: string;
  try {
    client_id = issueClient(uris as string[], name);
  } catch (e) {
    return oauthError("server_error", (e as Error).message, 500);
  }
  return Response.json(
    {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201, headers: { ...cors, "Cache-Control": "no-store" } },
  );
}

export const OPTIONS = () => new Response(null, { status: 204, headers: cors });
