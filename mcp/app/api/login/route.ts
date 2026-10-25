import { clientIp, emailAllowed, lockedFor, noteAttempt } from "@/lib/access";
import { AppwriteError, createUser, ensureMember, hasKey, userFromJwt } from "@/lib/appwrite";
import { endSession, startSession, tokenOk } from "@/lib/session";

export const dynamic = "force-dynamic";

const slow = () => new Promise((r) => setTimeout(r, 600)); // slow down guessing
const locked = (s: number) => Response.json({ error: `Too many tries from here. Try again in ${Math.ceil(s / 60)} min.` }, { status: 429, headers: { "Retry-After": String(s) } });

const NO_SEAT = "We couldn't create a seat for that email. Ask the owner to add it in Settings → Security, then try again.";

export async function POST(req: Request) {
  const { token, jwt, signup } = (await req.json().catch(() => ({}))) as { token?: string; jwt?: string; signup?: { name?: string; email?: string; password?: string } };
  if ((process.env.MCP_TOKEN ?? "").length < 24) return Response.json({ error: "MCP_TOKEN is not set on the server (24+ characters)." }, { status: 500 });
  const wait = await lockedFor(clientIp(req));
  if (wait) return locked(wait);

  // sign-up: the list is checked before any account exists, so an uninvited email never gets one
  if (signup) {
    const site = req.headers.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) return Response.json({ error: "forbidden" }, { status: 403 });
    const email = String(signup.email ?? "").trim().toLowerCase(), password = String(signup.password ?? ""), name = String(signup.name ?? "").trim().slice(0, 120);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
    if (password.length < 8) return Response.json({ error: "Use at least 8 characters for the password." }, { status: 400 });
    const ok = await emailAllowed(email).catch(() => false);
    if (!ok) {
      await noteAttempt(req, false, email, "sign-up (not on the list)");
      await slow();
      return Response.json({ error: NO_SEAT }, { status: 403 });
    }
    if (!hasKey()) return Response.json({ ok: true, create: "client" }); // no server key: the browser creates it (already checked)
    try {
      await createUser(email, password, name || email.split("@")[0]);
      return Response.json({ ok: true });
    } catch (e) {
      if (e instanceof AppwriteError && e.status === 409) return Response.json({ error: "That email already has a seat. Sign in instead.", exists: true }, { status: 409 });
      await slow();
      return Response.json({ error: e instanceof AppwriteError && e.status < 500 ? e.message : "Couldn't create the account right now. Try again in a minute." }, { status: e instanceof AppwriteError && e.status < 500 ? 400 : 502 });
    }
  }

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
