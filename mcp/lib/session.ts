// Dashboard login. Two ways in:
//  - your Appwrite account (email + password): the browser proves who it is with a short-lived JWT, and we remember the
//    person in a signed cookie so every job, post and comment says who made it;
//  - the MCP_TOKEN as a password (scripts and the old single-user flow): signed in, but anonymous.
// Cookies hold HMACs, never the token itself.
import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { safeEqual } from "./worker";

export const COOKIE = "vb_session";
export const USER_COOKIE = "vb_user";

const secret = () => process.env.MCP_TOKEN ?? "";

export function sessionValue() {
  const t = secret();
  return t.length >= 24 ? createHmac("sha256", t).update("voicebox-dashboard-v1").digest("hex") : "";
}

export function tokenOk(token: string | null | undefined) {
  const t = secret();
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

export type Who = { id: string; name: string; email: string };

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (body: string) => createHmac("sha256", secret()).update(`voicebox-user-v1:${body}`).digest("base64url");

export function userValue(w: Who) {
  const body = b64(JSON.stringify(w));
  return `${body}.${sign(body)}`;
}

/** The signed-in person, or null for a token login. */
export async function currentUser(): Promise<Who | null> {
  const v = (await cookies()).get(USER_COOKIE)?.value ?? "";
  const [body, mac] = v.split(".");
  if (!body || !mac || !secret() || !safeEqual(mac, sign(body))) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()) as Who; } catch { return null; }
}
