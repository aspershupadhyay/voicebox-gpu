// Who may get in, and the record of who tried. Fail closed: an email is let in only when it's on the list
// (WORKSPACE_EMAILS on the Worker, Settings → people with access, or already a member of the shared workspace). The one
// exception is a brand-new studio with nobody on any list: its first sign-in founds it.
// Guessing is slowed per address: 8 failed sign-ins in 15 minutes lock that address out for 15 minutes.
import { createHash } from "node:crypto";
import { getJson, putJson } from "./store";

const FAILS = (ip: string) => `auth/fails/${createHash("sha256").update(`voicebox-ip:${ip}`).digest("hex").slice(0, 24)}.json`;
const LOG = "auth/log.json";
const EPOCH = "auth/epoch.json";
const MAX_FAILS = 8, WINDOW = 15 * 60_000;

const envList = () => (process.env.WORKSPACE_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

let cache: { at: number; emails: string[] } | null = null;

/** Every email allowed in: the Worker's list, Settings' list, and the current workspace members (cached a minute). */
export async function allowedEmails(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.emails;
  const { getSettings } = await import("./settings");
  const [extra, members] = await Promise.all([
    getSettings().then((s) => s.workspace_emails).catch(() => [] as string[]),
    import("./data").then(async (a) => (await a.listMembers()).map((m) => m.email.toLowerCase())).catch(() => null),
  ]);
  if (members === null) { // the database unreachable: keep the last known list, else refuse (never fall open)
    if (cache) return cache.emails;
    throw new Error("can't check who has access right now: try again in a minute");
  }
  const emails = [...new Set([...envList(), ...extra, ...(members ?? [])])];
  cache = { at: Date.now(), emails };
  return emails;
}

export async function emailAllowed(email: string) {
  const list = await allowedEmails(true);
  return list.length ? list.includes(email.toLowerCase()) : "founder" as const;
}

export const clientIp = (req: Request) =>
  (req.headers.get("x-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();

/** Seconds this address must wait before trying again (0 = go ahead). */
export async function lockedFor(ip: string) {
  const f = await getJson<{ n: number; first: number }>(FAILS(ip)).catch(() => null);
  if (!f || Date.now() - f.first > WINDOW || f.n < MAX_FAILS) return 0;
  return Math.ceil((f.first + WINDOW - Date.now()) / 1000);
}

export async function noteAttempt(req: Request, ok: boolean, who: string, how: string) {
  const ip = clientIp(req);
  if (ok) await putJson(FAILS(ip), { n: 0, first: Date.now() }).catch(() => null);
  else {
    const f = await getJson<{ n: number; first: number }>(FAILS(ip)).catch(() => null);
    const fresh = !f || Date.now() - f.first > WINDOW;
    await putJson(FAILS(ip), { n: fresh ? 1 : f.n + 1, first: fresh ? Date.now() : f.first }).catch(() => null);
  }
  const masked = ip.includes(":") ? ip.split(":").slice(0, 3).join(":") + ":…" : ip.split(".").slice(0, 3).join(".") + ".…";
  const entry = { at: Date.now(), ok, who: who.slice(0, 120), how, ip: masked, agent: (req.headers.get("user-agent") ?? "").slice(0, 140) };
  const log = (await getJson<typeof entry[]>(LOG).catch(() => null)) ?? [];
  await putJson(LOG, [entry, ...log].slice(0, 60)).catch(() => null);
}

export const signInLog = async () => (await getJson<{ at: number; ok: boolean; who: string; how: string; ip: string; agent: string }[]>(LOG).catch(() => null)) ?? [];

let epochCache: { at: number; ep: number } | null = null;

/** Sessions issued before this moment are void ("sign out everywhere"). Cached 30 s per server instance. */
export async function sessionEpoch() {
  if (epochCache && Date.now() - epochCache.at < 30_000) return epochCache.ep;
  const ep = (await getJson<{ ep: number }>(EPOCH).catch(() => null))?.ep ?? 0;
  epochCache = { at: Date.now(), ep };
  return ep;
}

export async function signOutEverywhere() {
  const ep = Date.now();
  await putJson(EPOCH, { ep });
  epochCache = { at: Date.now(), ep };
  return ep;
}
