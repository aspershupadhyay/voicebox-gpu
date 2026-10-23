import { cookies } from "next/headers";
import { AppwriteError, ensureMember, hasKey, userFromJwt } from "@/lib/appwrite";
import { COOKIE, USER_COOKIE, sessionValue, tokenOk, userValue } from "@/lib/session";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const KEEP = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 30 };
const slow = () => new Promise((r) => setTimeout(r, 600)); // slow down guessing

/** Optional allow-list (WORKSPACE_EMAILS="a@x.com,b@y.com" on Vercel). People added in Settings → Claude / MCP access
 *  are always let in on top of it, so adding someone there never needs a redeploy. (Sign-ups themselves are capped at 4 in
 *  the Appwrite console: Auth → Security → Users limit.) */
async function allowed(email: string) {
  const list = (process.env.WORKSPACE_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const extra = await getSettings().then((s) => s.workspace_emails).catch(() => [] as string[]);
  const e = email.toLowerCase();
  return !list.length || list.includes(e) || extra.includes(e);
}

export async function POST(req: Request) {
  const { token, jwt } = (await req.json().catch(() => ({}))) as { token?: string; jwt?: string };
  const jar = await cookies();
  if (!sessionValue()) return Response.json({ error: "MCP_TOKEN is not set on the server (24+ characters)." }, { status: 500 });

  if (jwt) {
    try {
      const user = await userFromJwt(String(jwt));
      if (!(await allowed(user.email))) { await slow(); return Response.json({ error: `${user.email} isn't on this studio's list.` }, { status: 403 }); }
      if (hasKey()) await ensureMember(user);
      jar.set(COOKIE, sessionValue(), KEEP);
      jar.set(USER_COOKIE, userValue({ id: user.$id, name: user.name || user.email.split("@")[0], email: user.email }), KEEP);
      return Response.json({ ok: true, user: { id: user.$id, name: user.name, email: user.email }, workspace: hasKey() });
    } catch (e) {
      await slow();
      const status = e instanceof AppwriteError && e.status < 500 ? 401 : 502;
      return Response.json({ error: (e as Error).message }, { status });
    }
  }

  if (!tokenOk(String(token ?? "").trim())) {
    await slow();
    return Response.json({ error: "wrong token" }, { status: 401 });
  }
  jar.set(COOKIE, sessionValue(), KEEP);
  jar.delete(USER_COOKIE);
  return Response.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(USER_COOKIE);
  return Response.json({ ok: true });
}
