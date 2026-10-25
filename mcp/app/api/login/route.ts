import { clientIp, emailAllowed, lockedFor, noteAttempt } from "@/lib/access";
import { AppwriteError, ensureMember, hasKey, userFromJwt } from "@/lib/appwrite";
import { endSession, startSession, tokenOk } from "@/lib/session";

export const dynamic = "force-dynamic";

const slow = () => new Promise((r) => setTimeout(r, 600)); // slow down guessing
const locked = (s: number) => Response.json({ error: `Too many tries from here. Try again in ${Math.ceil(s / 60)} min.` }, { status: 429, headers: { "Retry-After": String(s) } });

export async function POST(req: Request) {
  const { token, jwt } = (await req.json().catch(() => ({}))) as { token?: string; jwt?: string };
  if ((process.env.MCP_TOKEN ?? "").length < 24) return Response.json({ error: "MCP_TOKEN is not set on the server (24+ characters)." }, { status: 500 });
  const wait = await lockedFor(clientIp(req));
  if (wait) return locked(wait);

  if (jwt) {
    let email = "?";
    try {
      const user = await userFromJwt(String(jwt));
      email = user.email;
      const ok = await emailAllowed(user.email);
      if (!ok) {
        await noteAttempt(req, false, user.email, "account (not on the list)");
        await slow();
        return Response.json({ error: `${user.email} isn't on this studio's list. Ask the owner to add you in Settings → Security.` }, { status: 403 });
      }
      if (hasKey()) await ensureMember(user);
      await startSession("user", user.email, { id: user.$id, name: user.name || user.email.split("@")[0], email: user.email });
      await noteAttempt(req, true, user.email, ok === "founder" ? "account (founded the studio)" : "account");
      return Response.json({ ok: true, user: { id: user.$id, name: user.name, email: user.email }, workspace: hasKey() });
    } catch (e) {
      await noteAttempt(req, false, email, "account");
      await slow();
      const status = e instanceof AppwriteError && e.status < 500 ? 401 : 502;
      return Response.json({ error: (e as Error).message }, { status });
    }
  }

  if (!tokenOk(String(token ?? "").trim())) {
    await noteAttempt(req, false, "access token", "token");
    await slow();
    return Response.json({ error: "wrong token" }, { status: 401 });
  }
  await startSession("token", "token");
  await noteAttempt(req, true, "access token", "token");
  return Response.json({ ok: true });
}

export async function DELETE() {
  await endSession();
  return Response.json({ ok: true });
}
