// The lean MCP endpoint (/api/mcp/lean): an alias of the adaptive endpoint's core (lib/auto/endpoint.ts), always the
// core list, the rest by toolset, find_tools or call_tool. Same keys as /api/mcp.
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { buildServer } from "@/lib/auto/endpoint";
import { verifyMcp } from "@/lib/auto/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const handler = createMcpHandler(async (server) => { await buildServer(server, "core"); }, {
  serverInfo: { name: "voicebox-lean", version: "3.2.0" },
  instructions: "VoiceBox (lean): find_tools searches every tool (names → summary → schema), call_tool runs one, tools loads a whole set; run executes code on the Colab worker where `import voicebox as vb` calls any tool from a script (vb.gather runs many at once; filter there, print only what matters); playbook search before a task; approvals when a call says NEEDS APPROVAL; get_job follows long jobs; project gives you a folder to work and clean up in.",
});

const authed = withMcpAuth(handler, verifyMcp, { required: true });

export { authed as GET, authed as POST, authed as DELETE };
