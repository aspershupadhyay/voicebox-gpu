// Every MCP tool registered the way app/api/mcp/route.ts does it (lib/auto/endpoint.ts on a real McpServer), and the
// tools/list a client gets: the core, everything (?full=1) and the strict schema subset for Gemini and ChatGPT. A
// throw here is a broken MCP in production (#131 shipped one). Run before every PR that touches tools:
//   cd mcp && npx -y tsx scripts/check-register.mts
import { McpServer } from "@modelcontextprotocol/server";
import { strictProblems } from "@/lib/auto/toolsets";

const { buildServer } = await import("@/lib/auto/endpoint");
const server = new McpServer({ name: "check", version: "0" }, {});
await buildServer(server as never, "adaptive");
const list = (server as unknown as { server: { _requestHandlers: Map<string, (r: unknown, c: unknown) => Promise<{ tools: { name: string; inputSchema: unknown }[] }>> } }).server._requestHandlers.get("tools/list")!;
const ctx = (url: string, ua: string) => ({ http: { req: new Request(url, { headers: { "user-agent": ua } }), authInfo: {} } });
const tok = (x: unknown) => Math.round(JSON.stringify(x).length / 4).toLocaleString();
const core = await list({ method: "tools/list", params: {} }, ctx("https://x/api/mcp", "claude-code/2"));
const full = await list({ method: "tools/list", params: {} }, ctx("https://x/api/mcp?full=1", "claude-code/2"));
const strict = await list({ method: "tools/list", params: {} }, ctx("https://x/api/mcp?full=1", "gemini-cli/0.9"));
let bad = 0;
for (const t of strict.tools) {
  const p = strictProblems(t.inputSchema);
  if (p.length) { bad++; console.log("NOT STRICT", t.name, p.slice(0, 4).join(", ")); }
}
console.log(`core: ${core.tools.length} tools, ~${tok(core.tools)} tokens (${core.tools.map((t) => t.name).join(", ")})`);
console.log(`full: ${full.tools.length} tools, ~${tok(full.tools)} tokens; strict for Gemini/ChatGPT: ~${tok(strict.tools)} tokens, ${bad} not strict`);
process.exit(bad ? 1 : 0);
