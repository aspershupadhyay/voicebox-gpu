// Who may call the MCP (/api/mcp and /api/mcp/lean): MCP_TOKEN (the owner), an OAuth access token (claude.ai
// connectors), a model key (lib/auto/keys.ts) or a sandbox script's run key (code mode, lib/auto/bench.ts).
import type { AuthInfo } from "@modelcontextprotocol/server";
import { safeEqual } from "../worker";
import { SCOPE, verify } from "../oauth";
import { modelKey } from "./keys";

export async function verifyMcp(_req: Request, token?: string): Promise<AuthInfo | undefined> {
  const expected = process.env.MCP_TOKEN ?? "";
  if (expected.length < 24 || !token) return undefined;
  if (safeEqual(token, expected)) return { token, clientId: "owner", scopes: [SCOPE] };
  const at = verify<{ typ: "access"; cid: string; exp: number }>(token, "access");
  if (at) return { token, clientId: at.cid, scopes: [SCOPE], expiresAt: at.exp };
  // a script keeps its caller's role, so a key held to a role can't step out of it through code mode
  const run = verify<{ typ: "run"; model: string; role?: string; exp: number }>(token, "run");
  if (run) return { token, clientId: `run:${run.model}`, scopes: [SCOPE], expiresAt: run.exp, ...(run.role ? { extra: { role: run.role } } : {}) };
  const k = await modelKey(token).catch(() => null);
  return k ? { token, clientId: `key:${k.id}`, scopes: [SCOPE], extra: { model: k.name, role: k.role } } : undefined;
}
