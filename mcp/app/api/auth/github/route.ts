// Starts GitHub sign-in; the state cookie ties the callback to this browser and remembers where to return.
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { githubEnabled, safeNext, STATE_COOKIE } from "@/lib/github";
import { origin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!githubEnabled()) return new Response("GitHub sign-in isn't configured", { status: 404 });
  const state = randomBytes(24).toString("base64url");
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  (await cookies()).set(STATE_COOKIE, `${state}.${Buffer.from(next).toString("base64url")}`, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/api/auth/github", maxAge: 600,
  });
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
  gh.searchParams.set("redirect_uri", `${origin(req)}/api/auth/github/callback`);
  gh.searchParams.set("state", state);
  gh.searchParams.set("allow_signup", "false");
  return Response.redirect(gh, 302);
}
