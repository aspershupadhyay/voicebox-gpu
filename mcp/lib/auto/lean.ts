// The lean endpoint (/api/mcp/lean, docs/AUTOMATION.md, after Anthropic's "Code execution with MCP"): a client sees
// six tools instead of ~90, so a cheaper model doesn't spend its context on tool definitions it won't use. find_tools
// searches the full catalogue (names, then a line each, then the full schema of the ones it picks); call_tool runs any
// of them, guarded and logged exactly as a direct call. run (with code mode), get_job, playbook and approvals are
// there directly because almost every task needs them.
import { toJSONSchema, z } from "zod";
import type { ToolServer } from "../mcptools";
import { callTool, registry } from "./flows";
import { guarded, modelOf } from "./wrap";

export const LEAN_DIRECT = ["run", "get_job", "playbook", "approvals"];

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const first = (d = "") => d.split(/(?<=\.)\s/)[0].slice(0, 200);

export async function registerLean(server: ToolServer) {
  // the everyday tools, guarded like the full endpoint
  const g = guarded(server);
  const only = new Proxy(g, { get: (o, k) => (k === "registerTool" ? (name: string, ...rest: unknown[]) => (LEAN_DIRECT.includes(name) ? (o.registerTool as (...a: unknown[]) => unknown)(name, ...rest) : undefined) : Reflect.get(o, k)) }) as ToolServer;
  (await import("../mcptools")).registerTools(only);
  (await import("./tools")).registerAutoTools(only);
  registerFinders(server);
}

/** find_tools and call_tool, on the lean endpoint and the adaptive one (lib/auto/endpoint.ts). */
export function registerFinders(server: ToolServer) {
  // find_tools and call_tool themselves aren't logged: the call they make is, under its own name
  server.registerTool(
    "find_tools",
    {
      title: "Find a tool",
      description: "Search VoiceBox's ~90 tools (voice, video, files, posts, publishing, analytics, Radar, repos, the web, workflows, memory). detail names (default): matching names by area; summary: a line each; schema: the full description and input schema of the tools you name (up to 6), to call with call_tool. Example: {\"query\":\"subtitles\",\"detail\":\"summary\"} then {\"tools\":[\"transcribe\"],\"detail\":\"schema\"}.",
      inputSchema: z.object({ query: z.string().max(100).optional(), detail: z.enum(["names", "summary", "schema"]).optional(), tools: z.array(z.string().max(60)).max(6).optional() }),
    },
    async ({ query, detail = "names", tools }) => {
      const reg = await registry("lean") as Map<string, { description?: string; title?: string; schema?: unknown }>;
      if (detail === "schema") {
        const names = tools?.length ? tools : [...reg.keys()].filter((n) => !query || n.includes(query.toLowerCase())).slice(0, 6);
        return text(names.map((n) => {
          const e = reg.get(n);
          if (!e) return { tool: n, error: "no such tool" };
          let schema: unknown = null;
          try { schema = toJSONSchema(e.schema as z.ZodType, { unrepresentable: "any" }); } catch { schema = "(see the description)"; }
          return { tool: n, description: e.description, input: schema };
        }));
      }
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      // a word in the name counts most, then the title, then the first sentence, then anywhere in the description
      const hits = [...reg.entries()].map(([n, e]) => ({ n, d: e.description ?? "", s: words.length ? words.reduce((a, w) => a + (n.includes(w) ? 4 : 0) + ((e.title ?? "").toLowerCase().includes(w) ? 3 : 0)
        + (first(e.description).toLowerCase().includes(w) ? 2 : 0) + ((e.description ?? "").toLowerCase().includes(w) ? 1 : 0), 0) : 1 }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      if (detail === "summary") return text(hits.slice(0, 25).map((x) => `${x.n}: ${first(x.d)}`));
      return text({ tools: hits.map((x) => x.n), next: "detail summary for a line each, schema for how to call one" });
    },
  );

  server.registerTool(
    "call_tool",
    {
      title: "Call any tool",
      description: "Run any VoiceBox tool by name with its arguments (find_tools shows them). Same checks and answers as calling it directly: approvals, the units cap, the kill switch, the call log. Example: {\"name\":\"list_files\",\"args\":{\"query\":\"reel\"}}.",
      inputSchema: z.object({ name: z.string().max(60), args: z.record(z.string(), z.unknown()).optional() }),
    },
    async ({ name, args }, ctx) => {
      const r = await callTool(name, args ?? {}, modelOf(ctx as never), "lean", ctx);
      return { ...text(r.text), ...(r.ok ? {} : { isError: true }) };
    },
  );
}
