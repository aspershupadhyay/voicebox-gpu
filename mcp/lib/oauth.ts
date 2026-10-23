// OAuth 2.1 for MCP clients that can't send a static header (claude.ai connectors, ChatGPT, ...).
// Stateless: client ids, codes and tokens are HMAC-signed with MCP_TOKEN, so rotating MCP_TOKEN revokes all of them.
import { createHash, createHmac } from "node:crypto";
import { getPublicOrigin } from "mcp-handler";
import { safeEqual } from "./worker";

export const SCOPE = "voicebox";
export const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 90; // 90 days
const CODE_TTL = 5 * 60;

type Claims = { typ: "client" | "code" | "access" | "refresh"; exp?: number; [k: string]: unknown };

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function key() {
  const t = process.env.MCP_TOKEN ?? "";
  if (t.length < 24) throw new Error("MCP_TOKEN not configured");
  return t;
}

const mac = (body: string) => createHmac("sha256", key()).update(`voicebox-oauth-v1.${body}`).digest("base64url");

export function sign(claims: Claims) {
  const body = b64(JSON.stringify(claims));
  return `${body}.${mac(body)}`;
}

export function verify<T extends Claims>(tok: string | null | undefined, typ: Claims["typ"]): T | undefined {
  if (!tok || (process.env.MCP_TOKEN ?? "").length < 24) return undefined;
  const [body, sig, extra] = tok.split(".");
  if (!body || !sig || extra !== undefined || !safeEqual(sig, mac(body))) return undefined;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    if (c.typ !== typ || (c.exp !== undefined && c.exp < now())) return undefined;
    return c;
  } catch {
    return undefined;
  }
}

export const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

/** https anywhere, or http only on loopback (desktop clients). */
export function okRedirect(u: string) {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export type Client = Claims & { typ: "client"; redirect_uris: string[]; name?: string };
export const issueClient = (redirect_uris: string[], name?: string) => sign({ typ: "client", redirect_uris, name, iat: now() });
export const readClient = (id: string | null | undefined) => verify<Client>(id, "client");

export type Code = Claims & { typ: "code"; cid: string; redirect_uri: string; challenge: string };
export const issueCode = (client_id: string, redirect_uri: string, challenge: string) =>
  sign({ typ: "code", cid: sha(client_id), redirect_uri, challenge, exp: now() + CODE_TTL });

export function issueTokens(client_id: string) {
  const cid = sha(client_id);
  return {
    access_token: sign({ typ: "access", cid, exp: now() + ACCESS_TTL }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: sign({ typ: "refresh", cid, exp: now() + REFRESH_TTL }),
    scope: SCOPE,
  };
}

export const pkceOk = (verifier: string, challenge: string) => !!verifier && safeEqual(sha(verifier), challenge);

export const origin = (req: Request) => getPublicOrigin(req);

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

export const oauthError = (error: string, description: string, status = 400) =>
  Response.json({ error, error_description: description }, { status, headers: { ...cors, "Cache-Control": "no-store" } });

/** Authorization request params, validated. Returns an error string for anything that must not redirect back. */
export function checkAuthorize(p: URLSearchParams | Record<string, string | undefined>) {
  const get = (k: string) => (p instanceof URLSearchParams ? p.get(k) : p[k]) ?? "";
  const client_id = get("client_id"), redirect_uri = get("redirect_uri");
  const client = readClient(client_id);
  if (!client) return { error: "Unknown client. Remove the connector and add it again." } as const;
  if (!client.redirect_uris.includes(redirect_uri)) return { error: "redirect_uri isn't registered for this client." } as const;
  return {
    client, client_id, redirect_uri,
    state: get("state"),
    response_type: get("response_type"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
  } as const;
}

/** Protocol errors that are safe to report back to the (already validated) redirect_uri. */
export function requestError(a: { response_type: string; code_challenge: string; code_challenge_method: string }) {
  if (a.response_type !== "code") return "unsupported_response_type";
  if (!a.code_challenge || a.code_challenge_method !== "S256") return "invalid_request";
  return null;
}

/** Clients that may connect without a consent click once the owner is signed in (no other site can get a silent code). */
export function trustedRedirect(u: string) {
  const extra = (process.env.OAUTH_TRUSTED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  try {
    const url = new URL(u);
    return url.protocol === "https:" && ["claude.ai", "claude.com", ...extra].includes(url.hostname);
  } catch {
    return false;
  }
}
