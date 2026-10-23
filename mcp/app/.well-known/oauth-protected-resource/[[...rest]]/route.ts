// RFC 9728: tells MCP clients that /api/mcp is protected by this app's own OAuth server.
import { cors, origin, SCOPE } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const o = origin(req);
  return Response.json(
    { resource: `${o}/api/mcp`, authorization_servers: [o], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "voicebox" },
    { headers: { ...cors, "Cache-Control": "max-age=3600" } },
  );
}

export const OPTIONS = () => new Response(null, { status: 204, headers: cors });
