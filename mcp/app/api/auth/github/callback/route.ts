// GitHub sign-in callback: only allowed logins (OWNER_GITHUB + Settings → Claude / MCP access) get the session cookie.
import { cookies } from "next/headers";
import { allowedLogins, githubEnabled, githubLogin, safeNext, STATE_COOKIE } from "@/lib/github";
import { origin } from "@/lib/oauth";
import { COOKIE, sessionValue } from "@/lib/session";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";

const deny = (msg: string, status = 403) =>
  new Response(`${msg}\n\nGo back to /login and try again.`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(req: Request) {
  if (!githubEnabled()) return deny("GitHub sign-in isn't configured", 404);
  const q = new URL(req.url).searchParams;
  const jar = await cookies();
  const [state, nextB64] = (jar.get(STATE_COOKIE)?.value ?? "").split(".");
  jar.delete({ name: STATE_COOKIE, path: "/api/auth/github" });
  if (!state || !safeEqual(state, q.get("state") ?? "")) return deny("Sign-in expired or was started in another browser.", 400);
  if (q.get("error")) return deny(`GitHub said: ${q.get("error_description") || q.get("error")}`, 400);

  let login: string;
  try {
    login = await githubLogin(q.get("code") ?? "", `${origin(req)}/api/auth/github/callback`);
  } catch (e) {
    return deny((e as Error).message, 502);
  }
  if (!login || !(await allowedLogins()).includes(login)) return deny(`GitHub account "${login || "?"}" isn't allowed on this voicebox.`);

  jar.set(COOKIE, sessionValue(), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  const next = safeNext(Buffer.from(nextB64 ?? "", "base64url").toString());
  return Response.redirect(new URL(next, origin(req)), 303);
}
