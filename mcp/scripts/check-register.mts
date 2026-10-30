// Every MCP tool registered the way app/api/mcp/route.ts does it (through guarded(), on a stub server), and each input
// schema turned into the JSON clients get. A throw here is a broken MCP in production (#131 shipped one: zod refuses
// extend() over a refined schema's keys). Run before every PR that touches tools: cd mcp && npx -y tsx scripts/check-register.mts
import { z } from "zod";

const reg: [string, { inputSchema?: z.ZodType; description?: string }][] = [];
const stub = { registerTool: (n: string, cfg: { inputSchema?: z.ZodType; description?: string }) => { reg.push([n, cfg]); } };
const { guarded } = await import("@/lib/auto/wrap");
const g = guarded(stub as never);
(await import("@/lib/mcptools")).registerTools(g as never);
(await import("@/lib/auto/tools")).registerAutoTools(g as never);
let bad = 0, chars = 0;
for (const [n, c] of reg) {
  try {
    const s = c.inputSchema ? z.toJSONSchema(c.inputSchema, { io: "input", unrepresentable: "any" }) : {};
    chars += JSON.stringify({ name: n, description: c.description, inputSchema: s }).length;
  } catch (e) { bad++; console.log("SCHEMA FAIL", n, (e as Error).message.slice(0, 200)); }
}
console.log(`${reg.length} tools registered, ${bad} bad schemas, ~${Math.round(chars / 4).toLocaleString()} tokens of definitions`);
process.exit(bad ? 1 : 0);
