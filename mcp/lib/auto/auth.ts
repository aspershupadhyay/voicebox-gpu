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

/** The same keys, also read from `X-VoiceBox-Key` (a script's backup path when a connector relay is down): a sandbox
 *  proxy can inject that header while `Authorization` carries an upload key for the Files routes on the same host.
 *  It's the same check as the bearer token, only another place to carry it. */
export const withKeyHeader = (h: (req: Request) => Response | Promise<Response>) => async (req: Request) => {
  // a proxy may store the key with a "Bearer " in front; the key itself is what counts
  const k = req.headers.get("x-voicebox-key")?.trim().replace(/^bearer\s+/i, "");
  // an upload key (vbup_) never opens the MCP: a proxy that injects one here must not hide the real key in Authorization
  if (!k || k.startsWith("vbup_")) return h(req);
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${k}`);
  headers.delete("x-voicebox-key");
  const res = await h(new Request(req, { headers }));
  if (res.status !== 401) return res;
  // a refusal says what arrived (the prefix and length only, never the key), so a script can tell a wrong key
  // from one a proxy never sent
  const out = new Response(res.body, res);
  out.headers.set("x-voicebox-key-seen", `${k.slice(0, 5)}… (${k.length} chars)`);
  return out;
};
