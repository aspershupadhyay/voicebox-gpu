// Sign-in accounts in Postgres. Passwords are scrypt hashes; the password itself is never stored. The invite list
// (lib/access.ts) still decides who gets in. A teammate row without a password yet (copied from Appwrite before it went,
// 2026-10-31) gets one from someone already signed in (Settings → Security: setPassword), never by itself.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { sql } from "./db";
import type { Member } from "./workspace";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${PARAMS.N}$${salt.toString("base64")}$${(await scrypt(pw, salt, 64, PARAMS)).toString("base64")}`;
}
async function matches(pw: string, stored: string) {
  const [kind, n, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { ...PARAMS, N: Number(n) });
  return got.length === want.length && timingSafeEqual(got, want);
}

export type User = { id: string; email: string; name: string };
type Row = User & { password_hash: string | null; member: boolean };
const byEmail = async (email: string) => ((await sql().query("select id, email, name, password_hash, member from users where email = $1", [email.toLowerCase()])) as Row[])[0] ?? null;

/** The account for this email and password, or null. */
export async function verify(email: string, password: string): Promise<(User & { member: boolean }) | null> {
  const row = await byEmail(email.trim().toLowerCase());
  if (!row?.password_hash) {
    await hashPassword(password); // same time either way: no telling which emails have accounts
    return null;
  }
  return (await matches(password, row.password_hash)) ? { id: row.id, email: row.email, name: row.name, member: row.member } : null;
}

/** A new account (the caller has checked the invite list). Throws 409 when the email has one already. */
export async function createAccount(email: string, password: string, name: string): Promise<User> {
  email = email.trim().toLowerCase();
  const taken = () => Object.assign(new Error("That email already has a seat. Sign in instead."), { status: 409 });
  if (await byEmail(email)) throw taken();
  const { newId } = await import("./db");
  const user = { id: newId(), email, name: name || email.split("@")[0] };
  await sql().query("insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)", [user.id, email, user.name, await hashPassword(password)]);
  return user;
}

/** On the studio team again (a sign-in) or off it (Settings → Security). */
export async function setMember(email: string, member: boolean) {
  const r = (await sql().query("update users set member = $2, updated_at = now() where email = $1 returning id", [email.toLowerCase(), member])) as unknown[];
  return r.length > 0;
}

export async function listUsers(): Promise<Member[]> {
  return ((await sql().query("select id, name, email from users where member order by created_at limit 25")) as Member[]);
}

/** Accounts on the team that have no password yet (copied over without one): Settings → Security lists them. */
export async function withoutPassword(): Promise<string[]> {
  return ((await sql().query("select email from users where member and password_hash is null order by created_at")) as { email: string }[]).map((r) => r.email);
}

/** Set a password. Your own (the current one must match when you have one), or a teammate's that has none yet. Never
 *  replaces someone else's password. Returns why not, or null when it's set. */
export async function setPassword(me: string, email: string, password: string, current?: string): Promise<string | null> {
  if (password.length < 8) return "Use at least 8 characters for the password.";
  email = email.trim().toLowerCase();
  const row = await byEmail(email);
  if (!row) return "No account with that email.";
  if (email === me.toLowerCase()) {
    if (row.password_hash && !(await matches(current ?? "", row.password_hash))) return "Your current password doesn't match.";
  } else if (row.password_hash || !row.member) return "You can only set a password for a teammate who doesn't have one yet.";
  await sql().query("update users set password_hash = $2, updated_at = now() where email = $1", [email, await hashPassword(password)]);
  return null;
}
