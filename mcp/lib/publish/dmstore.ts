// Auto-DM's history in Postgres (schema: db/003_autodm.sql and 004_autodm_more.sql, created here on first use). One row
// per comment, DM, story reply, story mention, button tap, AI answer or comment-rule action. The unique
// (account, kind, ref) key is the "answered at most once" guarantee, even when Instagram delivers the same event twice
// at the same moment. Emails people send are in autodm_leads.
import { sql } from "../db";

let ready: Promise<void> | null = null;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS autodm_events (
    id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    account text NOT NULL, kind text NOT NULL, ref text NOT NULL, automation text, automation_name text, media text,
    from_id text, from_name text, text text, status text NOT NULL, replied boolean NOT NULL DEFAULT false, following boolean,
    error text, note text, UNIQUE (account, kind, ref))`,
  `ALTER TABLE autodm_events ADD COLUMN IF NOT EXISTS psid text, ADD COLUMN IF NOT EXISTS variant text,
    ADD COLUMN IF NOT EXISTS awaiting text, ADD COLUMN IF NOT EXISTS reply text, ADD COLUMN IF NOT EXISTS links text[],
    ADD COLUMN IF NOT EXISTS clicks integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS clicked_at timestamptz`,
  "CREATE INDEX IF NOT EXISTS autodm_events_at ON autodm_events (at DESC)",
  "CREATE INDEX IF NOT EXISTS autodm_events_automation ON autodm_events (automation, at DESC)",
  "CREATE INDEX IF NOT EXISTS autodm_events_person ON autodm_events (account, from_id)",
  "CREATE INDEX IF NOT EXISTS autodm_events_psid ON autodm_events (account, psid, id DESC)",
  "CREATE INDEX IF NOT EXISTS autodm_events_waiting ON autodm_events (status) WHERE status IN ('held', 'gated')",
  `CREATE TABLE IF NOT EXISTS autodm_leads (
    id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), account text NOT NULL, from_id text NOT NULL,
    from_name text, email text NOT NULL, automation text, automation_name text, event bigint, UNIQUE (account, from_id, email))`,
  "CREATE INDEX IF NOT EXISTS autodm_leads_at ON autodm_leads (at DESC)",
];
export function ensure() {
  return (ready ??= (async () => { for (const q of SCHEMA) await sql().query(q, []); })().catch((e) => { ready = null; throw e; }));
}

export type DmStatus = "pending" | "sent" | "gated" | "held" | "failed" | "skipped" | "hidden" | "deleted" | "flagged" | "dismissed";
/** comment, dm, story (a story reply), mention (a story mention), ai (an AI answer), mod (a comment rule acted) */
export type DmKind = "comment" | "dm" | "story" | "mention" | "ai" | "mod";
export type DmEvent = {
  id: number; at: string; updated_at: string; account: string; kind: DmKind; ref: string; automation: string | null; automation_name: string | null;
  media: string | null; from_id: string | null; from_name: string | null; text: string | null; status: DmStatus; replied: boolean;
  following: boolean | null; error: string | null; note: string | null; psid: string | null; variant: string | null;
  awaiting: "follow" | "email" | null; reply: string | null; links: string[] | null; clicks: number; clicked_at: string | null;
};

const rows = <T>(r: unknown) => r as T[];
const like = (q: string) => `%${q.replace(/[%_\\]/g, "\\$&")}%`;
/** a person in history: their id in comments or their id in messages */
const PERSON = "(from_id = $2 or psid = $2)";

/** Take a comment or message for answering: its row, or null when it was already taken (a repeat delivery). */
export async function claim(e: { account: string; kind: DmKind; ref: string; automation: string | null; automation_name: string | null; media?: string | null; from_id: string; from_name?: string | null; text: string; psid?: string | null; status?: DmStatus }) {
  await ensure();
  const [row] = rows<{ id: number }>(await sql().query(
    `insert into autodm_events (account, kind, ref, automation, automation_name, media, from_id, from_name, text, psid, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (account, kind, ref) do nothing returning id`,
    [e.account, e.kind, e.ref.slice(0, 200), e.automation, e.automation_name?.slice(0, 120) ?? null, e.media ?? null, e.from_id, e.from_name ?? null, e.text.slice(0, 1000), e.psid ?? null, e.status ?? "pending"]));
  return row?.id ?? null;
}

export type Patch = Partial<Pick<DmEvent, "status" | "replied" | "following" | "error" | "note" | "psid" | "variant" | "awaiting" | "reply" | "links" | "automation" | "automation_name">>;
/** Change a row: only the fields given (null clears one). */
export async function finish(id: number, p: Patch) {
  const set: string[] = ["updated_at = now()"], v: unknown[] = [id];
  for (const [k, x] of Object.entries(p)) {
    if (x === undefined || !/^[a-z_]+$/.test(k)) continue;
    v.push(k === "reply" && typeof x === "string" ? x.slice(0, 2000) : x);
    set.push(`${k} = $${v.length}`);
  }
  await sql().query(`update autodm_events set ${set.join(", ")} where id = $1`, v);
}

export async function getEvent(id: number) {
  await ensure();
  const [row] = rows<DmEvent>(await sql().query("select * from autodm_events where id = $1", [id]));
  return row ?? null;
}

/** Has this person already been sent (or is waiting on) this automation? */
export async function already(automation: string, account: string, from: string, except: number) {
  const r = rows<{ status: DmStatus }>(await sql().query(
    `select status from autodm_events where automation = $3 and account = $1 and ${PERSON} and id <> $4 and status in ('sent', 'gated', 'held') order by id desc limit 1`,
    [account, from, automation, except]));
  return r[0]?.status ?? null;
}

/** DMs sent to one person over the last 24 hours, every automation together. */
export async function sentToPerson(account: string, from: string) {
  const [r] = rows<{ n: string }>(await sql().query(
    `select count(*) n from autodm_events where account = $1 and ${PERSON} and status = 'sent' and kind <> 'mod' and at > now() - interval '24 hours'`, [account, from]));
  return +(r?.n ?? 0);
}

/** DMs this account sent in the last hour. */
export async function sentLastHour(account: string) {
  const [r] = rows<{ n: string }>(await sql().query(
    "select count(*) n from autodm_events where account = $1 and status = 'sent' and kind <> 'mod' and updated_at > now() - interval '1 hour'", [account]));
  return +(r?.n ?? 0);
}

/** The newest row waiting on this person (a follow tap or an email), within Instagram's reply windows. */
export async function waitingOn(account: string, psid: string, what: "email" | "follow") {
  const [r] = rows<DmEvent>(await sql().query(
    `select * from autodm_events where account = $1 and ${PERSON} and awaiting = $3 and at > now() - interval '7 days' order by id desc limit 1`, [account, psid, what]));
  return r ?? null;
}

/** What was said with this person lately (oldest first): their messages and what we answered. */
export async function conversation(account: string, psid: string, limit = 8) {
  const r = rows<DmEvent>(await sql().query(
    `select * from autodm_events where account = $1 and ${PERSON} and kind <> 'mod' and at > now() - interval '24 hours' order by id desc limit ${Math.max(1, Math.min(20, limit))}`, [account, psid]));
  return r.reverse();
}

/** The newest DM an automation sent this person in the last 24 hours (an AI answer follows up on it). */
export async function lastSent(account: string, psid: string) {
  const [r] = rows<DmEvent>(await sql().query(
    `select * from autodm_events where account = $1 and ${PERSON} and status = 'sent' and automation is not null and kind not in ('mod', 'ai') and at > now() - interval '24 hours' order by id desc limit 1`, [account, psid]));
  return r ?? null;
}

export async function aiToPerson(account: string, psid: string) {
  const [r] = rows<{ n: string }>(await sql().query(
    `select count(*) n from autodm_events where account = $1 and ${PERSON} and kind = 'ai' and status = 'sent' and at > now() - interval '24 hours'`, [account, psid]));
  return +(r?.n ?? 0);
}

/** A tracked link opened: counted on its row; the row's links say where it goes. */
export async function click(id: number, count: boolean) {
  await ensure();
  const [r] = rows<{ links: string[] | null; automation: string | null }>(await sql().query(
    count ? "update autodm_events set clicks = clicks + 1, clicked_at = coalesce(clicked_at, now()) where id = $1 returning links, automation"
      : "select links, automation from autodm_events where id = $1", [id]));
  return r ?? null;
}

/** Per variant: how many got it and how many opened the link (an A/B test's numbers). */
export async function variants(automation: string) {
  await ensure();
  const r = rows<{ variant: string; sent: string; clicked: string }>(await sql().query(
    `select coalesce(variant, 'a') variant, count(*) sent, count(clicked_at) clicked from autodm_events
     where automation = $1 and status = 'sent' and kind not in ('ai', 'mod') group by 1`, [automation]));
  const out = { a: { sent: 0, clicked: 0 }, b: { sent: 0, clicked: 0 } };
  for (const x of r) if (x.variant === "a" || x.variant === "b") out[x.variant] = { sent: +x.sent, clicked: +x.clicked };
  return out;
}

export type Stat = { total: number; sent: number; gated: number; failed: number; held: number; clicked: number; leads: number; last: string | null; a: { sent: number; clicked: number }; b: { sent: number; clicked: number } };
/** Each automation's numbers over the last N days. */
export async function stats(days = 30): Promise<Record<string, Stat>> {
  await ensure();
  const [r, l] = await Promise.all([
    sql().query(
      `select automation, count(*) total, count(*) filter (where status = 'sent') sent, count(*) filter (where status = 'gated') gated,
         count(*) filter (where status = 'failed') failed, count(*) filter (where status = 'held') held, count(clicked_at) clicked, max(at) last,
         count(*) filter (where status = 'sent' and coalesce(variant, 'a') = 'a') a_sent, count(clicked_at) filter (where coalesce(variant, 'a') = 'a') a_clicked,
         count(*) filter (where status = 'sent' and variant = 'b') b_sent, count(clicked_at) filter (where variant = 'b') b_clicked
       from autodm_events where at > now() - make_interval(days => $1::int) and automation is not null and kind not in ('ai', 'mod') group by automation`, [days]),
    sql().query("select automation, count(*) n from autodm_leads where at > now() - make_interval(days => $1::int) and automation is not null group by automation", [days]),
  ]);
  const leads = new Map(rows<{ automation: string; n: string }>(l).map((x) => [x.automation, +x.n]));
  return Object.fromEntries(rows<Record<string, string>>(r).map((x) => [x.automation, {
    total: +x.total, sent: +x.sent, gated: +x.gated, failed: +x.failed, held: +x.held, clicked: +x.clicked, leads: leads.get(x.automation) ?? 0, last: x.last,
    a: { sent: +x.a_sent, clicked: +x.a_clicked }, b: { sent: +x.b_sent, clicked: +x.b_clicked },
  }]));
}

export type Totals = { total: number; sent: number; gated: number; failed: number; held: number; clicked: number; people: number; leads: number; ai: number; moderated: number };
/** Everything together over a window of days, ending `ago` days back. */
export async function totals(days = 30, ago = 0): Promise<Totals> {
  await ensure();
  const w = "at > now() - make_interval(days => $1::int + $2::int) and at <= now() - make_interval(days => $2::int)";
  const [[r], [l]] = await Promise.all([
    sql().query(
      `select count(*) filter (where kind not in ('ai', 'mod')) total, count(*) filter (where status = 'sent' and kind not in ('ai', 'mod')) sent,
         count(*) filter (where status = 'gated') gated, count(*) filter (where status = 'failed') failed, count(*) filter (where status = 'held') held,
         count(clicked_at) clicked, count(distinct (account, coalesce(psid, from_id))) filter (where kind not in ('mod')) people,
         count(*) filter (where kind = 'ai' and status = 'sent') ai, count(*) filter (where kind = 'mod' and status in ('hidden', 'deleted', 'flagged')) moderated
       from autodm_events where ${w}`, [days, ago]).then((x) => rows<Record<string, string>>(x)),
    sql().query(`select count(*) n from autodm_leads where ${w}`, [days, ago]).then((x) => rows<{ n: string }>(x)),
  ]);
  return { total: +(r?.total ?? 0), sent: +(r?.sent ?? 0), gated: +(r?.gated ?? 0), failed: +(r?.failed ?? 0), held: +(r?.held ?? 0), clicked: +(r?.clicked ?? 0), people: +(r?.people ?? 0), leads: +(l?.n ?? 0), ai: +(r?.ai ?? 0), moderated: +(r?.moderated ?? 0) };
}

/** DMs sent and links opened per day (UTC), oldest first, every day present. */
export async function daily(days = 30) {
  await ensure();
  const r = rows<{ day: string; sent: string; clicked: string }>(await sql().query(
    `select to_char(d, 'YYYY-MM-DD') as day, coalesce(e.sent, 0) sent, coalesce(e.clicked, 0) clicked
     from generate_series(date_trunc('day', now()) - make_interval(days => $1::int - 1), date_trunc('day', now()), interval '1 day') d
     left join (select date_trunc('day', at) as day, count(*) filter (where status = 'sent' and kind not in ('mod')) sent, count(clicked_at) clicked
       from autodm_events where at > now() - make_interval(days => $1::int + 1) group by 1) e on e.day = d order by d`, [days]));
  return r.map((x) => ({ day: x.day, sent: +x.sent, clicked: +x.clicked }));
}

export async function activity(f: { automation?: string; account?: string; status?: string; kind?: string; q?: string; before?: number; limit?: number }) {
  await ensure();
  const where: string[] = [], v: unknown[] = [];
  const at = (x: unknown) => { v.push(x); return `$${v.length}`; };
  if (f.automation) where.push(`automation = ${at(f.automation)}`);
  if (f.account) where.push(`account = ${at(f.account)}`);
  if (f.status) where.push(`status = ${at(f.status)}`);
  if (f.kind) where.push(`kind = ${at(f.kind)}`); else where.push("kind <> 'mod'");
  if (f.q) { const p = at(like(f.q)); where.push(`(from_name ilike ${p} or text ilike ${p} or automation_name ilike ${p})`); }
  if (f.before) where.push(`id < ${at(f.before)}`);
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  return rows<DmEvent>(await sql().query(`select * from autodm_events where ${where.join(" and ")} order by id desc limit ${limit}`, v));
}

/** Everyone who triggered an automation: how often, what they got, whether they follow (when a gate checked), their email. */
export async function contacts(f: { account?: string; q?: string; limit?: number }) {
  await ensure();
  const where = ["from_id is not null", "e.kind <> 'mod'"], v: unknown[] = [];
  if (f.account) { v.push(f.account); where.push(`e.account = $${v.length}`); }
  if (f.q) { v.push(like(f.q)); where.push(`e.from_name ilike $${v.length}`); }
  const limit = Math.max(1, Math.min(1000, f.limit ?? 300));
  const r = rows<{ account: string; from_id: string; from_name: string | null; times: string; got: string; clicked: string; last: string; following: boolean | null; automations: string[]; email: string | null }>(await sql().query(
    `select e.account, e.from_id, max(e.from_name) from_name, count(*) times, count(*) filter (where e.status = 'sent') got, count(e.clicked_at) clicked, max(e.at) last,
       (array_agg(e.following order by e.id desc) filter (where e.following is not null))[1] following,
       array_agg(distinct e.automation_name) filter (where e.automation_name is not null) automations,
       (select l.email from autodm_leads l where l.account = e.account and (l.from_id = e.from_id or l.from_id = max(e.psid)) order by l.id desc limit 1) email
     from autodm_events e where ${where.join(" and ")} group by e.account, e.from_id order by max(e.at) desc limit ${limit}`, v));
  return r.map((x) => ({ ...x, times: +x.times, got: +x.got, clicked: +x.clicked }));
}

export type Lead = { id: number; at: string; account: string; from_id: string; from_name: string | null; email: string; automation: string | null; automation_name: string | null };
/** An email someone sent: kept once per person and address. True when it's new. */
export async function addLead(l: Omit<Lead, "id" | "at"> & { event: number | null }) {
  await ensure();
  const r = rows<{ id: number }>(await sql().query(
    `insert into autodm_leads (account, from_id, from_name, email, automation, automation_name, event) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (account, from_id, email) do nothing returning id`, [l.account, l.from_id, l.from_name, l.email.slice(0, 200), l.automation, l.automation_name, l.event]));
  return r.length > 0;
}

export async function leads(f: { account?: string; q?: string; automation?: string; limit?: number }) {
  await ensure();
  const where: string[] = ["true"], v: unknown[] = [];
  if (f.account) { v.push(f.account); where.push(`account = $${v.length}`); }
  if (f.automation) { v.push(f.automation); where.push(`automation = $${v.length}`); }
  if (f.q) { v.push(like(f.q)); where.push(`(email ilike $${v.length} or from_name ilike $${v.length})`); }
  const limit = Math.max(1, Math.min(5000, f.limit ?? 500));
  return rows<Lead>(await sql().query(`select id, at, account, from_id, from_name, email, automation, automation_name from autodm_leads where ${where.join(" and ")} order by id desc limit ${limit}`, v));
}

/** Rows held back by the hourly limit, oldest first, still inside Instagram's windows (7 days for a comment, 24 h else). */
export async function held(limit = 20) {
  await ensure();
  return rows<DmEvent>(await sql().query(
    `select * from autodm_events where status = 'held' and ((kind = 'comment' and at > now() - interval '6 days 20 hours') or at > now() - interval '23 hours')
     order by id limit ${Math.max(1, Math.min(100, limit))}`, []));
}
/** Held rows past their window: given up on. */
export async function expireHeld() {
  await sql().query(
    `update autodm_events set status = 'skipped', note = 'Held by the hourly limit past Instagram''s reply window', updated_at = now()
     where status = 'held' and ((kind = 'comment' and at <= now() - interval '6 days 20 hours') or (kind <> 'comment' and at <= now() - interval '23 hours'))`, []);
}

/** The most-sent automations over a window (the weekly report). */
export async function top(days = 7, limit = 5) {
  await ensure();
  return rows<{ automation: string; name: string; sent: string; clicked: string }>(await sql().query(
    `select automation, max(automation_name) name, count(*) filter (where status = 'sent') sent, count(clicked_at) clicked from autodm_events
     where at > now() - make_interval(days => $1::int) and automation is not null and kind not in ('ai', 'mod') group by automation order by 3 desc limit ${limit}`, [days])).map((x) => ({ ...x, sent: +x.sent, clicked: +x.clicked }));
}
