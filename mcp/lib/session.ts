// Dashboard login: the MCP_TOKEN is the password; the cookie holds an HMAC of it, never the token itself.
import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { safeEqual } from "./worker";

export const COOKIE = "vb_session";

export function sessionValue() {
  const t = process.env.MCP_TOKEN ?? "";
  return t.length >= 24 ? createHmac("sha256", t).update("voicebox-dashboard-v1").digest("hex") : "";
}

export function tokenOk(token: string | null | undefined) {
  const t = process.env.MCP_TOKEN ?? "";
  return t.length >= 24 && !!token && safeEqual(token, t);
}

/** Cookie session (browser) or Bearer MCP_TOKEN (scripts). */
export async function isAuthed(req?: Request) {
  const bearer = req?.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && tokenOk(bearer)) return true;
  const v = (await cookies()).get(COOKIE)?.value ?? "";
  const want = sessionValue();
  return !!want && safeEqual(v, want);
}
