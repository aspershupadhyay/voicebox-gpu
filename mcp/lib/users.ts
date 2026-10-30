// Sign-in accounts in Postgres (docs/MIGRATION.md 2b), used once AUTH_BACKEND=neon. Passwords are scrypt hashes.
// Nobody resets anything: the first time someone signs in here, an account still only in Appwrite is checked against
// Appwrite once and moved over with the same id (so their posts and files stay theirs) and the hash of the password
// that just worked. The invite list (lib/access.ts) still decides who gets in.
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

/** The account for this email and password, or null. Moves an Appwrite account over on its first sign-in here. */
export async function verify(email: string, password: string): Promise<User | null> {
  email = email.trim().toLowerCase();
  const row = await byEmail(email);
  if (row?.password_hash) return (await matches(password, row.password_hash)) ? { id: row.id, email: row.email, name: row.name } : null;
  const { checkAppwritePassword, hasKey } = await import("./appwrite");
  if (!hasKey()) return null;
  const aw = await checkAppwritePassword(email, password);
  if (!aw) return null;
  const user = { id: aw.$id, email, name: aw.name || email.split("@")[0] };
  await sql().query(`insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)
    on conflict (email) do update set password_hash = excluded.password_hash, updated_at = now()`, [user.id, email, user.name, await hashPassword(password)]);
  return user;
}

/** A new account (the caller has checked the invite list). Throws 409 when the email has one here or in Appwrite. */
export async function createAccount(email: string, password: string, name: string): Promise<User> {
  email = email.trim().toLowerCase();
  const taken = () => Object.assign(new Error("That email already has a seat. Sign in instead."), { status: 409 });
  if (await byEmail(email)) throw taken();
  const { findAppwriteUser, hasKey } = await import("./appwrite");
  if (hasKey() && (await findAppwriteUser(email).catch(() => null))) throw taken(); // moves over on its first sign-in
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

/** Copy the Appwrite team into Postgres (no passwords: each gets one on their first sign-in here). Safe to run again. */
export async function copyTeam() {
  const { appwriteMembers } = await import("./appwrite");
  const team = await appwriteMembers();
  for (const m of team) await sql().query("insert into users (id, email, name) values ($1, $2, $3) on conflict (email) do nothing", [m.id, m.email.toLowerCase(), m.name]);
  return team.length;
}
