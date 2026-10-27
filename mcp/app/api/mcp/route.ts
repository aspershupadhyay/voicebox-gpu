// Voicebox MCP: every dashboard tool (lib/mcptools.ts) for Claude and other MCP clients.
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { INSTRUCTIONS, registerTools } from "@/lib/mcptools";
import { safeEqual } from "@/lib/worker";
import { SCOPE, verify } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // starting a Colab GPU waits on the VM to boot (lib/colab.ts)

const handler = createMcpHandler((server) => registerTools(server), {
  serverInfo: { name: "voicebox", version: "3.0.0" },
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
