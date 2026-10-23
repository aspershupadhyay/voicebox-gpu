// RFC 8414 metadata for the stateless OAuth server in lib/oauth.ts.
import { cors, origin, SCOPE } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const o = origin(req);
  return Response.json(
    {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/api/oauth/token`,
      registration_endpoint: `${o}/api/oauth/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    },
    { headers: { ...cors, "Cache-Control": "max-age=3600" } },
  );
}

export const OPTIONS = () => new Response(null, { status: 204, headers: cors });
