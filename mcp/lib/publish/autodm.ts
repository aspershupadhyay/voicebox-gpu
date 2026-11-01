// Auto-DM for Instagram (Posts → Auto-DM): someone comments a keyword ("CATCH") on a post or reel, or sends it in a DM or
// a story reply, and Voicebox sends them a message (with an optional link button) and can answer the comment in public.
// Instagram calls /api/ig/webhook on every new comment and message (signed with the app secret); this file decides what
// to do with each one. Rules, the "already answered" markers and the log live in R2 under workspace/publish/autodm/.
//
// It stays off until three things are true: INSTAGRAM_DM=1 (so Instagram Login asks for instagram_business_manage_messages,
// which needs Meta's App Review for anyone who isn't a tester), the account was reconnected with that permission, and the
// switch on the Auto-DM view is on. Instagram's own limits: one private reply per comment, within 7 days of it; a DM
// conversation is open for 24 hours after the person's last message.
import { delObjs, getJson, listDirs, listObjs, putJson, putJsonIf } from "../store";
import { getAccount, listAccounts, patchAccount, type Account } from "./accounts";
import * as IG from "./instagram";

const DIR = "workspace/publish/autodm/";
const SETTINGS = `${DIR}settings.json`;
const LAST = `${DIR}last-event.json`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MEDIA_ID = /^\d{3,40}$/;

export const MESSAGES_SCOPE = "instagram_business_manage_messages";
/** The switch that makes Instagram Login ask for the messaging permission. Off until the Meta app has it. */
export const dmFlag = () => process.env.INSTAGRAM_DM === "1";

export type DmMatch = "word" | "exact" | "any";
export type DmRule = {
  id: string; on: boolean; name: string;
  /** an Instagram account id; null = every connected account */
  account: string | null;
  /** one post or reel (Instagram media id); null = every post and reel */
  media: string | null;
  /** what the dashboard shows for that post: the start of its caption */
  media_label: string | null;
  /** case-insensitive; empty with match "any" answers every comment */
  keywords: string[];
  /** word: a keyword appears as a word anywhere ("I want it CATCH!"); exact: the whole comment is the keyword; any: every comment */
  match: DmMatch;
  /** the DM */
  message: string;
  /** an optional link button under the DM */
  button: { label: string; url: string } | null;
  /** answers under the comment in public, one picked at random each time (empty: no public answer) */
  public_replies: string[];
  /** also answer a DM or a story reply that has the keyword */
  dms: boolean;
  /** one DM per person for this rule, however many times they comment */
  once_per_person: boolean;
};
export type DmSettings = { on: boolean; rules: DmRule[]; updated: number; by: string | null };
export type DmLog = {
  at: number; rule: string; rule_name: string; account: string; kind: "comment" | "dm";
  ref: string; from: string | null; text: string; ok: boolean; replied: boolean; error: string | null; note: string | null;
};

export const LIMITS = { rules: 50, keywords: 20, keyword: 60, message: 1000, button_label: 20, reply: 300, replies: 5 };
const DEFAULTS: DmSettings = { on: false, rules: [], updated: 0, by: null };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const rid = () => Math.random().toString(36).slice(2, 10);

export async function getSettings(): Promise<DmSettings> {
  const s = await getJson<Partial<DmSettings>>(SETTINGS).catch(() => null);
  return { ...DEFAULTS, ...(s ?? {}), rules: (s?.rules ?? []).map((r) => cleanRule(r, r.id)) };
}

function cleanUrl(v: unknown) {
  const s = str(v, 1000);
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : ""; } catch { return ""; }
}

export function cleanRule(g: Partial<DmRule> | undefined, id?: string): DmRule {
  const r = g ?? {};
  const kw = (Array.isArray(r.keywords) ? r.keywords : typeof r.keywords === "string" ? String(r.keywords).split(",") : [])
    .map((k) => String(k).trim().slice(0, LIMITS.keyword)).filter(Boolean).slice(0, LIMITS.keywords);
  const url = cleanUrl(r.button?.url);
  const replies = (Array.isArray(r.public_replies) ? r.public_replies : typeof r.public_replies === "string" ? String(r.public_replies).split("\n") : [])
    .map((x) => String(x).trim().slice(0, LIMITS.reply)).filter(Boolean).slice(0, LIMITS.replies);
  return {
    id: typeof id === "string" && ID.test(id) ? id : rid(),
    on: typeof r.on === "boolean" ? r.on : true,
    name: str(r.name, 80) || (kw[0] ? `Comment ${kw[0].toUpperCase()}` : "Every comment"),
    account: typeof r.account === "string" && /^\d{3,40}$/.test(r.account) ? r.account : null,
    media: typeof r.media === "string" && MEDIA_ID.test(r.media) ? r.media : null,
    media_label: r.media ? str(r.media_label, 120) || null : null,
    keywords: kw,
    match: r.match === "exact" || r.match === "any" ? r.match : "word",
    message: str(r.message, LIMITS.message),
    button: url ? { label: str(r.button?.label, LIMITS.button_label) || "Open", url } : null,
    public_replies: replies,
    dms: typeof r.dms === "boolean" ? r.dms : false,
    once_per_person: typeof r.once_per_person === "boolean" ? r.once_per_person : true,
  };
}

/** Save the switch and/or the rules (a list replaces the whole list; rule ids are kept so the log still names them). */
export async function setSettings(given: { on?: unknown; rules?: unknown }, by: string): Promise<DmSettings> {
  const cur = await getSettings();
  const seen = new Set<string>();
  const rules = Array.isArray(given.rules)
    ? (given.rules as Partial<DmRule>[]).slice(0, LIMITS.rules).map((r) => {
      const id = typeof r?.id === "string" && ID.test(r.id) && !seen.has(r.id) ? r.id : rid();
      seen.add(id);
      return cleanRule(r, id);
    })
    : cur.rules;
  for (const r of rules) if (r.on && !r.message) throw new Error(`"${r.name}" has no message: write the DM, or switch the rule off.`);
  for (const r of rules) if (r.on && r.match !== "any" && !r.keywords.length) throw new Error(`"${r.name}" has no keyword: add one, or set it to answer every comment.`);
  const next: DmSettings = { on: typeof given.on === "boolean" ? given.on : cur.on, rules, updated: Date.now(), by };
  await putJson(SETTINGS, next);
  return next;
}

// ── matching

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function matches(rule: DmRule, text: string) {
  if (rule.match === "any") return true;
  const t = norm(text);
  return rule.keywords.some((k) => {
    const kw = norm(k);
    if (!kw) return false;
    if (rule.match === "exact") return t.replace(/[^\p{L}\p{N} ]+/gu, "").trim() === kw.replace(/[^\p{L}\p{N} ]+/gu, "").trim();
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(kw)}($|[^\\p{L}\\p{N}])`, "u").test(t);
  });
}

/** The first rule, top to bottom, that answers this comment or DM. */
export function pick(rules: DmRule[], ev: { account: string; media?: string | null; text: string; kind: "comment" | "dm" }) {
  return rules.find((r) => r.on && r.message && (!r.account || r.account === ev.account)
    && (ev.kind === "dm" ? r.dms : !r.media || r.media === ev.media) && matches(r, ev.text)) ?? null;
}

// ── sending

const GRAPH = "https://graph.instagram.com/v24.0";

async function send(token: string, account: string, recipient: Record<string, string>, rule: DmRule) {
  const post = async (message: unknown) => {
    const r = await fetch(`${GRAPH}/${account}/messages`, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipient, message }),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } };
    if (!r.ok || j.error) throw Object.assign(new Error(dmError(j.error)), { code: j.error?.code ?? 0 });
  };
  if (!rule.button) return post({ text: rule.message });
  try {
    await post({ attachment: { type: "template", payload: { template_type: "button", text: rule.message.slice(0, 640), buttons: [{ type: "web_url", url: rule.button.url, title: rule.button.label }] } } });
  } catch (e) {
    // a button Instagram won't take (or a message over its 640 characters): the link goes in the text instead
    if ((e as { code?: number }).code === 10 || (e as { code?: number }).code === 190) throw e;
    await post({ text: `${rule.message}\n\n${rule.button.label}: ${rule.button.url}`.slice(0, 1000) });
  }
}

function dmError(e?: { message?: string; code?: number; error_subcode?: number }) {
  const code = e?.code ?? 0, sub = e?.error_subcode ?? 0;
  if (code === 190) return "The Instagram connection expired. Reconnect the account.";
  if (code === 10 || code === 200 || code === 3) return "Instagram didn't give Voicebox permission to send messages. Reconnect the account and allow messages (the Meta app needs instagram_business_manage_messages).";
  if (sub === 2534022 || /outside of allowed window/i.test(e?.message ?? "")) return "Too late: Instagram allows a reply only within 7 days of a comment, or 24 hours after someone's last DM.";
  if (code === 4 || code === 613 || sub === 2534034) return "Instagram is rate limiting messages from this account.";
  if (sub === 2018001 || /no matching user/i.test(e?.message ?? "")) return "Instagram couldn't find that person (the comment was deleted, or they block messages).";
  if (/already/i.test(e?.message ?? "") && /repl/i.test(e?.message ?? "")) return "That comment already has a private reply (Instagram allows one).";
  return e?.message ?? "Instagram didn't take the message";
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

async function log(entry: DmLog) {
  await putJson(`${DIR}log/${day(entry.at)}/${entry.at.toString(36)}-${entry.ref.replace(/[^A-Za-z0-9_-]/g, "_").slice(-40)}.json`, entry).catch(() => null);
}

/** Claim a marker once: false when it's already there (Instagram sent the same event twice, or the person already got it). */
const claim = (key: string, value: unknown) => putJsonIf(key, value, null).catch(() => true);

type Ev = { kind: "comment" | "dm"; account: string; ref: string; media: string | null; from: { id: string; username?: string | null }; text: string };

async function handle(ev: Ev, s: DmSettings) {
  if (!ev.text || !ev.from?.id || ev.from.id === ev.account) return; // our own comments and replies never trigger anything
  const rule = pick(s.rules, ev);
  if (!rule) return;
  const at = Date.now();
  const base: DmLog = { at, rule: rule.id, rule_name: rule.name, account: ev.account, kind: ev.kind, ref: ev.ref, from: ev.from.username ?? null, text: ev.text.slice(0, 200), ok: false, replied: false, error: null, note: null };
  if (!(await claim(`${DIR}seen/${ev.kind === "comment" ? "c" : "m"}-${ev.ref.replace(/[^A-Za-z0-9_-]/g, "_")}.json`, { at }))) return;
  if (rule.once_per_person && !(await claim(`${DIR}people/${rule.id}/${ev.from.id.replace(/\D/g, "")}.json`, { at, ref: ev.ref }))) {
    return log({ ...base, ok: true, note: "Already sent to this person for this rule" });
  }
  const acc = await getAccount(ev.account);
  if (!acc || acc.network !== "instagram") return log({ ...base, error: "That Instagram account isn't connected to Voicebox" });
  let token: string;
  try { token = await IG.accessToken(acc); } catch (e) { return log({ ...base, error: (e as Error).message }); }
  try {
    await send(token, acc.id, ev.kind === "comment" ? { comment_id: ev.ref } : { id: ev.from.id }, rule);
    base.ok = true;
  } catch (e) {
    base.error = (e as Error).message;
    if (/permission|expired/i.test(base.error)) await patchAccount(acc.id, { error: base.error }).catch(() => null);
  }
  if (ev.kind === "comment" && rule.public_replies.length && base.ok) {
    const reply = rule.public_replies[Math.floor(Math.random() * rule.public_replies.length)];
    await IG.reply(token, ev.ref, reply).then(() => { base.replied = true; }).catch((e) => { base.note = `Public answer not posted: ${(e as Error).message}`; });
  }
  await log(base);
}

type Hook = {
  object?: string;
  entry?: {
    id?: string; time?: number;
    changes?: { field?: string; value?: { id?: string; text?: string; from?: { id?: string; username?: string }; media?: { id?: string } } }[];
    messaging?: { sender?: { id?: string }; recipient?: { id?: string }; message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean } }[];
  }[];
};

/** Everything one webhook delivery holds: new comments and new messages, each answered at most once. */
export async function onWebhook(body: Hook) {
  if (body.object !== "instagram" || !Array.isArray(body.entry)) return { handled: 0 };
  await putJson(LAST, { at: Date.now(), entries: body.entry.length }).catch(() => null);
  const s = await getSettings();
  if (!s.on || !dmFlag()) return { handled: 0, off: true };
  const evs: Ev[] = [];
  for (const e of body.entry) {
    const account = String(e.id ?? "");
    if (!/^\d{3,40}$/.test(account)) continue;
    for (const c of e.changes ?? []) {
      const v = c.value;
      if ((c.field === "comments" || c.field === "live_comments") && v?.id && v.from?.id && typeof v.text === "string")
        evs.push({ kind: "comment", account, ref: v.id, media: v.media?.id ?? null, from: { id: v.from.id, username: v.from.username }, text: v.text });
    }
    for (const m of e.messaging ?? []) {
      if (!m.message || m.message.is_echo || m.message.is_deleted || !m.message.mid || typeof m.message.text !== "string" || !m.sender?.id) continue;
      evs.push({ kind: "dm", account, ref: m.message.mid, media: null, from: { id: m.sender.id }, text: m.message.text });
    }
  }
  for (const ev of evs.slice(0, 50)) await handle(ev, s).catch((e) => log({ at: Date.now(), rule: "", rule_name: "", account: ev.account, kind: ev.kind, ref: ev.ref, from: ev.from.username ?? null, text: ev.text.slice(0, 200), ok: false, replied: false, error: (e as Error).message, note: null }));
  return { handled: evs.length };
}

// ── what the dashboard and the MCP read

export async function readLog(limit = 60): Promise<DmLog[]> {
  const days = (await listDirs(`${DIR}log/`).catch(() => [])).sort().reverse().slice(0, 7);
  const out: DmLog[] = [];
  for (const d of days) {
    const objs = (await listObjs(`${DIR}log/${d}/`).catch(() => [])).sort((a, b) => b.key.localeCompare(a.key));
    const got = await Promise.all(objs.slice(0, limit - out.length).map((o) => getJson<DmLog>(o.key).catch(() => null)));
    out.push(...(got.filter(Boolean) as DmLog[]));
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Everything the setup checklist needs: the switch, the secrets, each account's permission and subscription. */
export async function status() {
  const accounts = (await listAccounts()).filter((a) => a.network === "instagram");
  const last = await getJson<{ at: number }>(LAST).catch(() => null);
  return {
    flag: dmFlag(),
    app_secret: !!process.env.INSTAGRAM_APP_SECRET,
    verify_token: !!process.env.INSTAGRAM_WEBHOOK_TOKEN,
    last_event: last?.at ?? null,
    accounts: accounts.map((a) => ({
      id: a.id, handle: a.handle, name: a.name, error: a.error ?? null,
      messages: a.scopes ? a.scopes.includes(MESSAGES_SCOPE) : null,
      subscribed: a.dm_subscribed ?? null,
    })),
  };
}

/** Tell Instagram to send this account's comments and messages to our webhook. */
export async function subscribe(id?: string) {
  const all = (await listAccounts()).filter((a) => a.network === "instagram" && (!id || a.id === id));
  if (!all.length) throw new Error(id ? "That Instagram account isn't connected" : "Connect an Instagram account first");
  const out: { id: string; handle: string | null; ok: boolean; error?: string }[] = [];
  for (const a of all) {
    const acc = await getAccount(a.id);
    if (!acc) continue;
    try {
      const token = await IG.accessToken(acc);
      await IG.subscribeApp(token, dmFlag() ? ["comments", "messages"] : ["comments"]);
      await patchAccount(a.id, { dm_subscribed: Date.now() });
      out.push({ id: a.id, handle: a.handle, ok: true });
    } catch (e) {
      out.push({ id: a.id, handle: a.handle, ok: false, error: (e as Error).message });
    }
  }
  return out;
}

/** The account's recent posts and reels, to pick one for a rule. */
export async function recentMedia(id: string) {
  const acc = await getAccount(id);
  if (!acc || acc.network !== "instagram") throw new Error("not an Instagram account");
  const r = await IG.igGet<{ data: { id: string; caption?: string; media_type?: string; media_product_type?: string; thumbnail_url?: string; media_url?: string; permalink?: string; timestamp?: string }[] }>(
    `/${acc.id}/media`, await IG.accessToken(acc), { fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp", limit: "30" });
  return r.data.map((m) => ({
    id: m.id, caption: (m.caption ?? "").slice(0, 120), kind: m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : m.media_type === "VIDEO" ? "video" : "photo",
    thumb: m.thumbnail_url ?? (m.media_type === "IMAGE" ? m.media_url ?? null : null), url: m.permalink ?? null, at: m.timestamp ?? null,
  }));
}

/** A dry run: which rule a comment (or DM) would trigger, and what would be sent. Nothing goes out. */
export async function test(text: string, opts: { account?: string | null; media?: string | null; kind?: "comment" | "dm" } = {}) {
  const s = await getSettings();
  const accounts = (await listAccounts()).filter((a: Account) => a.network === "instagram");
  const account = opts.account ?? accounts[0]?.id ?? "0";
  const rule = pick(s.rules, { account, media: opts.media ?? null, text, kind: opts.kind ?? "comment" });
  return {
    switched_on: s.on && dmFlag(),
    rule: rule ? { id: rule.id, name: rule.name } : null,
    would_send: rule ? { message: rule.message, button: rule.button, public_reply: opts.kind === "dm" ? null : rule.public_replies[0] ?? null } : null,
    note: rule ? (s.on && dmFlag() ? "This would be sent." : "This would be sent once Auto-DM is switched on.") : "No rule answers that.",
  };
}

/** Forget who already got a rule's DM, so everyone can get it again (after changing the link, say). */
export async function resetPeople(ruleId: string) {
  if (!ID.test(ruleId)) throw new Error("bad rule id");
  const objs = await listObjs(`${DIR}people/${ruleId}/`).catch(() => []);
  if (objs.length) await delObjs(objs.map((o) => o.key));
  return { cleared: objs.length };
}
