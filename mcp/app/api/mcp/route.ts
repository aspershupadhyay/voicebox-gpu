// Voicebox MCP: every dashboard tool (lib/mcptools.ts) for Claude and other MCP clients. Ask Voicebox's Antigravity
// runs on the Colab worker come in here too, with their own short-lived token: their deletes, posts and spending wait
// for a person to approve them on the dashboard (lib/ask.ts).
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { INSTRUCTIONS, registerTools } from "@/lib/mcptools";
import { askGate, ASK_ACTOR, verifyAskToken } from "@/lib/ask";
import { safeEqual } from "@/lib/worker";
import { SCOPE, verify } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // starting a Colab GPU waits on the VM to boot (lib/colab.ts)

const handler = createMcpHandler((server) => registerTools(server), {
  serverInfo: { name: "voicebox", version: "3.1.0" },
  instructions: INSTRUCTIONS,
});

const askHandler = createMcpHandler((server) => registerTools(server, ASK_ACTOR, askGate), {
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

// /api/mcp?ask=1: an Ask Voicebox run on the worker (a token minted for that one conversation)
const askAuthed = withMcpAuth(
  askHandler,
  (_req, token) => {
    const t = token ? verifyAskToken(token) : null;
    return t ? { token: token!, clientId: "ask", scopes: [SCOPE], expiresAt: t.exp, extra: { conversation: t.cid } } : undefined;
  },
  { required: true },
);

const route = (req: Request) => (new URL(req.url).searchParams.get("ask") ? askAuthed(req) : authed(req));
export { route as GET, route as POST, route as DELETE };
