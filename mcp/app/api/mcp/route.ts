// Voicebox MCP: every dashboard tool (lib/mcptools.ts) and the automation suite (lib/auto/tools.ts) for Claude and
// other MCP clients. Each call is guarded and logged with the model that made it (lib/auto/wrap.ts).
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { INSTRUCTIONS, registerTools } from "@/lib/mcptools";
import { registerAutoTools } from "@/lib/auto/tools";
import { guarded } from "@/lib/auto/wrap";
import { safeEqual } from "@/lib/worker";
import { SCOPE, verify } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // starting a Colab GPU waits on the VM to boot (lib/colab.ts)

const handler = createMcpHandler((server) => {
  const g = guarded(server);
  registerTools(g);
  registerAutoTools(g);
}, {
  serverInfo: { name: "voicebox", version: "3.1.0" },
  instructions: INSTRUCTIONS,
});

const authed = withMcpAuth(
  handler,
  (_req, token) => {
    const expected = process.env.MCP_TOKEN ?? "";
    if (expected.length < 24 || !token) return undefined;
    if (safeEqual(token, expected)) return { token, clientId: "owner", scopes: [SCOPE] };
    // OAuth access token from /api/oauth/token (claude.ai connectors and other header-less clients)
    const at = verify<{ typ: "access"; cid: string; exp: number }>(token, "access");
    return at && { token, clientId: at.cid, scopes: [SCOPE], expiresAt: at.exp };
  },
  { required: true },
);

export { authed as GET, authed as POST, authed as DELETE };
