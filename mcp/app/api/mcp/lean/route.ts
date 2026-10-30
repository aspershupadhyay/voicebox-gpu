// The lean MCP endpoint (/api/mcp/lean): six tools listed, the rest found on demand (lib/auto/lean.ts), for cheaper
// models and long sessions. Same keys as /api/mcp.
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerLean } from "@/lib/auto/lean";
import { verifyMcp } from "@/lib/auto/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const handler = createMcpHandler(async (server) => { await registerLean(server); }, {
  serverInfo: { name: "voicebox-lean", version: "3.1.0" },
  instructions: "VoiceBox (lean): find_tools searches every tool (names → summary → schema), call_tool runs one; run executes code on the Colab worker where `import voicebox as vb` calls any tool from a script (filter there, print only what matters); playbook search before a task; approvals when a call says NEEDS APPROVAL; get_job follows long jobs.",
});

const authed = withMcpAuth(handler, verifyMcp, { required: true });

export { authed as GET, authed as POST, authed as DELETE };
