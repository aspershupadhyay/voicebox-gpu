// Auto-DM's history in Postgres (schema: db/003_autodm.sql, created here on first use). One row per comment, DM, story
// reply or button tap an automation answered, skipped or failed on. The unique (account, kind, ref) key is the "answered
// at most once" guarantee, even when Instagram delivers the same event twice at the same moment.
import { sql } from "../db";

let ready: Promise<void> | null = null;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS autodm_events (
    id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    account text NOT NULL, kind text NOT NULL, ref text NOT NULL, automation text, automation_name text, media text,
    from_id text, from_name text, text text, status text NOT NULL, replied boolean NOT NULL DEFAULT false, following boolean,
    error text, note text, UNIQUE (account, kind, ref))`,
  "CREATE INDEX IF NOT EXISTS autodm_events_at ON autodm_events (at DESC)",
  "CREATE INDEX IF NOT EXISTS autodm_events_automation ON autodm_events (automation, at DESC)",
  "CREATE INDEX IF NOT EXISTS autodm_events_person ON autodm_events (account, from_id)",
];
export function ensure() {
  return (ready ??= (async () => { for (const q of SCHEMA) await sql().query(q, []); })().catch((e) => { ready = null; throw e; }));
}

export type DmStatus = "pending" | "sent" | "gated" | "failed" | "skipped";
export type DmKind = "comment" | "dm" | "story";
export type DmEvent = {
  id: number; at: string; account: string; kind: DmKind; ref: string; automation: string | null; automation_name: string | null;
  media: string | null; from_id: string | null; from_name: string | null; text: string | null; status: DmStatus; replied: boolean;
  following: boolean | null; error: string | null; note: string | null;
};

const rows = <T>(r: unknown) => r as T[];

/** Take a comment or message for answering: its row, or null when it was already taken (a repeat delivery). */
export async function claim(e: { account: string; kind: DmKind; ref: string; automation: string; automation_name: string; media: string | null; from_id: string; from_name: string | null; text: string }) {
  await ensure();
  const [row] = rows<{ id: number }>(await sql().query(
    `insert into autodm_events (account, kind, ref, automation, automation_name, media, from_id, from_name, text, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') on conflict (account, kind, ref) do nothing returning id`,
    [e.account, e.kind, e.ref.slice(0, 200), e.automation, e.automation_name.slice(0, 120), e.media, e.from_id, e.from_name, e.text.slice(0, 500)]));
  return row?.id ?? null;
}

export async function finish(id: number, p: { status: DmStatus; replied?: boolean; following?: boolean | null; error?: string | null; note?: string | null }) {
  await sql().query(
    `update autodm_events set status = $2, replied = coalesce($3, replied), following = coalesce($4, following), error = $5,
       note = coalesce($6, note), updated_at = now() where id = $1`,
    [id, p.status, p.replied ?? null, p.following ?? null, p.error ?? null, p.note ?? null]);
}

export async function getEvent(id: number) {
  await ensure();
  const [row] = rows<DmEvent>(await sql().query("select * from autodm_events where id = $1", [id]));
  return row ?? null;
}

/** Has this person already been sent (or is waiting on the follow gate of) this automation? */
export async function already(automation: string, account: string, from: string, except: number) {
  const r = rows<{ status: DmStatus }>(await sql().query(
    "select status from autodm_events where automation = $1 and account = $2 and from_id = $3 and id <> $4 and status in ('sent', 'gated') order by id desc limit 1",
    [automation, account, from, except]));
  return r[0]?.status ?? null;
}

/** Each automation's numbers over the last N days. */
export async function stats(days = 30) {
  await ensure();
  const r = rows<{ automation: string; total: string; sent: string; gated: string; failed: string; last: string | null }>(await sql().query(
    `select automation, count(*) total, count(*) filter (where status = 'sent') sent, count(*) filter (where status = 'gated') gated,
       count(*) filter (where status = 'failed') failed, max(at) last
     from autodm_events where at > now() - make_interval(days => $1) and automation is not null group by automation`, [days]));
  return Object.fromEntries(r.map((x) => [x.automation, { total: +x.total, sent: +x.sent, gated: +x.gated, failed: +x.failed, last: x.last }]));
}

export async function totals(days = 30) {
  await ensure();
  const [r] = rows<{ total: string; sent: string; gated: string; failed: string; people: string }>(await sql().query(
    `select count(*) total, count(*) filter (where status = 'sent') sent, count(*) filter (where status = 'gated') gated,
       count(*) filter (where status = 'failed') failed, count(distinct (account, from_id)) people
     from autodm_events where at > now() - make_interval(days => $1)`, [days]));
  return { total: +(r?.total ?? 0), sent: +(r?.sent ?? 0), gated: +(r?.gated ?? 0), failed: +(r?.failed ?? 0), people: +(r?.people ?? 0) };
}

export async function activity(f: { automation?: string; account?: string; status?: string; q?: string; before?: number; limit?: number }) {
  await ensure();
  const where: string[] = [], v: unknown[] = [];
  const at = (x: unknown) => { v.push(x); return `$${v.length}`; };
  if (f.automation) where.push(`automation = ${at(f.automation)}`);
  if (f.account) where.push(`account = ${at(f.account)}`);
  if (f.status) where.push(`status = ${at(f.status)}`);
  if (f.q) { const p = at(`%${f.q.replace(/[%_\\]/g, "\\$&")}%`); where.push(`(from_name ilike ${p} or text ilike ${p} or automation_name ilike ${p})`); }
  if (f.before) where.push(`id < ${at(f.before)}`);
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  return rows<DmEvent>(await sql().query(`select * from autodm_events${where.length ? ` where ${where.join(" and ")}` : ""} order by id desc limit ${limit}`, v));
}

/** Everyone who triggered an automation: how often, what they got, whether they follow (when a gate checked). */
export async function contacts(f: { account?: string; q?: string; limit?: number }) {
  await ensure();
  const where = ["from_id is not null"], v: unknown[] = [];
  if (f.account) { v.push(f.account); where.push(`account = $${v.length}`); }
  if (f.q) { v.push(`%${f.q.replace(/[%_\\]/g, "\\$&")}%`); where.push(`from_name ilike $${v.length}`); }
  const limit = Math.max(1, Math.min(500, f.limit ?? 200));
  const r = rows<{ account: string; from_id: string; from_name: string | null; times: string; got: string; last: string; following: boolean | null; automations: string[] }>(await sql().query(
    `select account, from_id, max(from_name) from_name, count(*) times, count(*) filter (where status = 'sent') got, max(at) last,
       (array_agg(following order by id desc) filter (where following is not null))[1] following,
       array_agg(distinct automation_name) filter (where automation_name is not null) automations
     from autodm_events where ${where.join(" and ")} group by account, from_id order by max(at) desc limit ${limit}`, v));
  return r.map((x) => ({ ...x, times: +x.times, got: +x.got }));
}
