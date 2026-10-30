// Voicebox MCP: every dashboard tool (lib/mcptools.ts) and the automation suite (lib/auto/tools.ts) for Claude and
// other MCP clients. One endpoint that adapts (docs/FACTORY.md C): it lists a small core and the toolsets a model
// loads (`tools action=load`); ?full=1 lists every tool. Each call is guarded and logged (lib/auto/wrap.ts).
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { INSTRUCTIONS } from "@/lib/mcptools";
import { buildServer } from "@/lib/auto/endpoint";
import { verifyMcp } from "@/lib/auto/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // starting a Colab GPU waits on the VM to boot (lib/colab.ts)

const handler = createMcpHandler(async (server) => { await buildServer(server, "adaptive"); }, {
  serverInfo: { name: "voicebox", version: "3.2.0" },
  instructions: `${INSTRUCTIONS}\nTools come in sets: the list starts with a small core; \`tools action=load set=<video|voice|files|posts|analytics|repo>\` adds a set, and any tool can be called by name or through call_tool (find_tools searches them all). Answers are short; pass detail: "full" for everything.`,
});

const authed = withMcpAuth(handler, verifyMcp, { required: true });

export { authed as GET, authed as POST, authed as DELETE };
