// The adaptive MCP endpoint (docs/FACTORY.md C + H): every tool registered and guarded, the listing narrowed to the core
// plus the toolsets this key loaded (lib/auto/toolsets.ts), schemas made safe for the client, hints on every tool.
import { z } from "zod";
import type { ToolServer } from "../mcptools";
import { guarded } from "./wrap";

type Req = { http?: { req?: Request; authInfo?: { token?: string } }; authInfo?: { token?: string } } | undefined;
type Registered = { title?: string; description?: string; inputSchema?: z.ZodType; annotations?: Record<string, unknown>; _meta?: Record<string, unknown>; enabled: boolean };
type Inner = { setRequestHandler: (m: string, h: (req: unknown, ctx: Req) => unknown) => void };

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
const tokenOf = (ctx: Req) => ctx?.http?.authInfo?.token ?? ctx?.authInfo?.token;

export async function buildServer(server: ToolServer, mode: "adaptive" | "core") {
  const ts = await import("./toolsets");
  const g = guarded(server);
  (await import("../mcptools")).registerTools(g);
  (await import("./tools")).registerAutoTools(g);
  (await import("./lean")).registerFinders(server);

  server.registerTool(
    "tools",
    {
      title: "Toolsets: load the tools a task needs",
      description: [
        "This server lists a small core; the other ~80 tools come in sets. action list: the sets and their tools. load (set): adds that set's tools to your list (your client lists again; if it doesn't, call them by name or with call_tool, which always works). unload (set).",
        `Sets: ${Object.entries(ts.SETS).map(([k, v]) => `${k} (${v.about})`).join("; ")}.`,
        "Example: {\"action\":\"load\",\"set\":\"video\"}.",
      ].join(" "),
      inputSchema: z.object({ action: z.enum(["list", "load", "unload"]), set: z.enum(ts.SET_NAMES).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ action, set }, ctx) => {
      const token = tokenOf(ctx as Req);
      const have = await ts.loaded(token);
      if (action === "list") return text({ loaded: have, sets: Object.fromEntries(Object.entries(ts.SETS).map(([k, v]) => [k, { about: v.about, tools: v.tools }])), core: ts.CORE });
      if (!set) return { ...text("ERROR: load and unload need set"), isError: true };
      const next = action === "load" ? [...have, set] : have.filter((s) => s !== set);
      await ts.setLoaded(token, next);
      // tell the client on this request's own stream (each request is a fresh server, so there's no other channel)
      const notify = (ctx as { mcpReq?: { notify?: (n: { method: string }) => Promise<void> } })?.mcpReq?.notify;
      await notify?.({ method: "notifications/tools/list_changed" }).catch(() => {});
      return text({ loaded: next, ...(action === "load" ? { added: ts.SETS[set].tools } : {}), next: action === "load" ? "Your tool list now has them (if it doesn't show them, call by name or use call_tool)." : "Unloaded." });
    },
  );

  // the listing: the core and loaded sets (or everything with ?full=1), each schema safe for this client
  const mcp = server as unknown as { _registeredTools: Record<string, Registered>; server: Inner };
  mcp.server.setRequestHandler("tools/list", async (_req, ctx) => {
    const req = ctx?.http?.req;
    const all = Object.keys(mcp._registeredTools).filter((n) => mcp._registeredTools[n].enabled);
    const full = mode === "adaptive" && req ? new URL(req.url).searchParams.get("full") === "1" : false;
    const show = ts.listed(all, full ? "all" : mode === "core" ? [] : await ts.loaded(tokenOf(ctx)));
    const strictMode = ts.wantsStrict(req);
    return {
      tools: all.filter((n) => show.has(n)).map((name) => {
        const t = mcp._registeredTools[name];
        return { name, title: t.title, description: t.description, inputSchema: ts.jsonSchema(t.inputSchema, strictMode), annotations: { ...ts.hints(name), ...(t.annotations ?? {}) }, ...(t._meta ? { _meta: t._meta } : {}) };
      }),
    };
  });
}
