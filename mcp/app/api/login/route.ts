// Sign-in and sign-up for the dashboard: accounts in Postgres (lib/users.ts, scrypt hashes), the invite list
// (lib/access.ts) decides who gets in, and the dashboard's own cookie is the session (lib/session.ts). Built to be quick:
// the lockout, the list and the password are checked together, and the record of the try is written after the reply.
import { after } from "next/server";
import { allowedEmails, clientIp, emailAllowed, lockedFor, noteAttempt } from "@/lib/access";
import { endSession, startSession, tokenOk } from "@/lib/session";

export const dynamic = "force-dynamic";

const slow = () => new Promise((r) => setTimeout(r, 600)); // slow down guessing
const locked = (s: number) => Response.json({ error: `Too many tries from here. Try again in ${Math.ceil(s / 60)} min.` }, { status: 429, headers: { "Retry-After": String(s) } });
const note = (req: Request, ok: boolean, who: string, how: string) => after(() => noteAttempt(req, ok, who, how).catch(() => null));

const NO_SEAT = "We couldn't create a seat for that email. Ask the owner to add it in Settings → Security, then try again.";

export async function POST(req: Request) {
  const { token, signup, email: loginEmail, password: loginPassword } = (await req.json().catch(() => ({}))) as { token?: string; email?: string; password?: string; signup?: { name?: string; email?: string; password?: string } };
  if ((process.env.MCP_TOKEN ?? "").length < 24) return Response.json({ error: "MCP_TOKEN is not set on the server (24+ characters)." }, { status: 500 });

  // sign-up: the list is checked before any account exists, so an uninvited email never gets one
  if (signup) {
    const wait = await lockedFor(clientIp(req));
    if (wait) return locked(wait);
    const site = req.headers.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) return Response.json({ error: "forbidden" }, { status: 403 });
    const email = String(signup.email ?? "").trim().toLowerCase(), password = String(signup.password ?? ""), name = String(signup.name ?? "").trim().slice(0, 120);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
    if (password.length < 8) return Response.json({ error: "Use at least 8 characters for the password." }, { status: 400 });
    const ok = await emailAllowed(email).catch(() => false);
    if (!ok) {
      note(req, false, email, "sign-up (not on the list)");
      await slow();
      return Response.json({ error: NO_SEAT }, { status: 403 });
    }
    try {
      const user = await (await import("@/lib/users")).createAccount(email, password, name);
      await startSession("user", user.email, user);
      note(req, true, user.email, "sign-up");
      return Response.json({ ok: true, user, workspace: true });
    } catch (e) {
      const status = (e as { status?: number }).status === 409 ? 409 : 502;
      return Response.json({ error: status === 409 ? (e as Error).message : "Couldn't create the account right now. Try again in a minute.", exists: status === 409 }, { status });
    }
  }

  // email and password
  if (loginEmail !== undefined) {
    const email = String(loginEmail).trim().toLowerCase();
    try {
      const { setMember, verify } = await import("@/lib/users");
      const [wait, user, list] = await Promise.all([lockedFor(clientIp(req)), verify(email, String(loginPassword ?? "")), allowedEmails(true)]);
      if (wait) return locked(wait);
      if (!user) {
        note(req, false, email, "account");
        await slow();
        return Response.json({ error: "Wrong email or password." }, { status: 401 });
      }
      const ok = list.length ? list.includes(user.email) : "founder";
      if (!ok) {
        note(req, false, user.email, "account (not on the list)");
        await slow();
        return Response.json({ error: `${user.email} isn't on this studio's list. Ask the owner to add you in Settings → Security.` }, { status: 403 });
      }
      await Promise.all([user.member ? null : setMember(user.email, true), startSession("user", user.email, { id: user.id, name: user.name, email: user.email })]);
      note(req, true, user.email, ok === "founder" ? "account (founded the studio)" : "account");
      return Response.json({ ok: true, user: { id: user.id, name: user.name, email: user.email }, workspace: true });
    } catch (e) {
      note(req, false, email, "account");
      return Response.json({ error: `Couldn't sign in right now: ${(e as Error).message}` }, { status: 502 });
    }
  }

  const wait = await lockedFor(clientIp(req));
  if (wait) return locked(wait);
  if (!tokenOk(String(token ?? "").trim())) {
    note(req, false, "access token", "token");
    await slow();
    return Response.json({ error: "wrong token" }, { status: 401 });
  }
  await startSession("token", "token");
  note(req, true, "access token", "token");
  return Response.json({ ok: true });
}

export async function DELETE() {
  await endSession();
  return Response.json({ ok: true });
}
