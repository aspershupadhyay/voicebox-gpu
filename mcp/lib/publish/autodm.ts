// Auto-DM for Instagram (the Auto-DM page, /auto-dm): automations that answer a comment, a DM or a story reply with a
// message (and a link button), optionally after checking the person follows you, and can answer the comment in public.
// Built to run hundreds at once across every connected account: each automation is for every post, chosen posts or
// studio posts (resolved to their live Instagram post when they go out), with its own matching (a keyword as a word, the
// whole comment, fuzzy for typos, or any comment) and exclude words. Instagram calls /api/ig/webhook on every comment,
// message and button tap (signed); this file decides what to send. Automations live in R2
// (workspace/publish/autodm/settings.json, saved one automation at a time under an ETag); what happened is in Postgres
// (lib/publish/dmstore.ts: the "answered once" guarantee, Activity, Contacts and each automation's numbers).
//
// Nothing is sent until: INSTAGRAM_DM=1 (Instagram Login asks for instagram_business_manage_messages, which needs Meta's
// App Review for anyone who isn't a tester), the account was reconnected with that permission and subscribed, and the
// master switch is on. Instagram's limits: one private reply per comment within 7 days of it; after someone messages
// you (a DM, a story reply, a button tap) you have 24 hours to answer.
import { createHmac } from "node:crypto";
import { getJsonTagged, putJsonIf } from "../store";
import { getAccount, listAccounts, patchAccount } from "./accounts";
import * as DB from "./dmstore";
import * as IG from "./instagram";
import { getPlan } from "./plans";

const SETTINGS = "workspace/publish/autodm/settings.json";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const IGID = /^\d{3,40}$/;

export const MESSAGES_SCOPE = "instagram_business_manage_messages";
/** The switch that makes Instagram Login ask for the messaging permission. Off until the Meta app has it. */
export const dmFlag = () => process.env.INSTAGRAM_DM === "1";

export type DmMatch = "word" | "exact" | "fuzzy" | "any";
export type DmTarget = { id: string; label: string; thumb?: string | null };
export type Automation = {
  id: string; name: string; on: boolean; created: number; updated: number; by: string | null;
  /** Instagram account ids; empty = every connected account */
  accounts: string[];
  /** every post and reel, or only the chosen ones */
  where: "all" | "some";
  /** chosen Instagram posts and reels */
  media: DmTarget[];
  /** chosen studio posts: they count once they're live on Instagram (resolved below) */
  posts: DmTarget[];
  /** studio post id → its Instagram media id, filled in once it's live */
  resolved: Record<string, string>;
  triggers: { comments: boolean; dms: boolean; story_replies: boolean };
  match: DmMatch;
  keywords: string[];
  /** a comment with any of these is ignored ("stop", "spam") */
  exclude: string[];
  /** fuzzy: how many typos a keyword may have; 0 = by length (1 for 4-6 letters, 2 for 7+) */
  typos: number;
  /** only comments on the post itself, not replies under other comments */
  top_level_only: boolean;
  message: string;
  button: { label: string; url: string } | null;
  public_replies: string[];
  follow_gate: { on: boolean; message: string; button: string; not_following: string };
  once_per_person: boolean;
};
export type DmDefaults = { public_replies: string[]; gate_message: string; gate_button: string; not_following: string };
export type DmSettings = { on: boolean; paused: string[]; defaults: DmDefaults; automations: Automation[]; updated: number; by: string | null };

export const LIMITS = { automations: 1000, keywords: 30, keyword: 60, message: 1000, button_message: 640, button_label: 20, reply: 300, replies: 8, targets: 200 };
export const DEFAULT_DEFAULTS: DmDefaults = {
  public_replies: ["Sent! Check your DMs 📩", "Just sent it to your DMs 🙌", "Check your inbox 📬"],
  gate_message: "Almost there! Follow @{handle}, then tap the button below and I'll send it right away 👇",
  gate_button: "I'm following ✅",
  not_following: "Looks like you're not following @{handle} yet 🙈 Follow, then tap the button again.",
};
const EMPTY: DmSettings = { on: false, paused: [], defaults: DEFAULT_DEFAULTS, automations: [], updated: 0, by: null };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const rid = () => Math.random().toString(36).slice(2, 10);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const words = (v: unknown, max: number, each: number) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((k) => String(k).trim().slice(0, each)).filter(Boolean).slice(0, max);
const lines = (v: unknown, max: number, each: number) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : []).map((k) => String(k).trim().slice(0, each)).filter(Boolean).slice(0, max);
function cleanUrl(v: unknown) {
  const s = str(v, 1000);
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : ""; } catch { return ""; }
}
const targets = (v: unknown, ok: RegExp) => (Array.isArray(v) ? v : []).flatMap((t) => {
  const id = typeof t === "string" ? t : (t as DmTarget)?.id;
  return typeof id === "string" && ok.test(id) ? [{ id, label: str((t as DmTarget)?.label, 140) || id, thumb: typeof (t as DmTarget)?.thumb === "string" ? (t as DmTarget).thumb!.slice(0, 1000) : null }] : [];
}).slice(0, LIMITS.targets);

/** An automation as given (the dashboard, the MCP, an older saved shape), made safe and complete. */
export function cleanAutomation(g: Record<string, unknown> | undefined, cur?: Automation): Automation {
  const r = (g ?? {}) as Partial<Automation> & { media?: unknown; dms?: boolean; account?: string | null };
  const base = cur;
  const kw = words(r.keywords ?? base?.keywords, LIMITS.keywords, LIMITS.keyword);
  const url = cleanUrl((r.button ?? base?.button)?.url);
  // the first version kept one post as a string, one account and a dms flag
  const oldMedia = typeof r.media === "string" ? [{ id: r.media, label: str((r as { media_label?: string }).media_label, 140) || r.media }] : null;
  const media = oldMedia ?? (r.media !== undefined ? targets(r.media, IGID) : base?.media ?? []);
  const posts = r.posts !== undefined ? targets(r.posts, ID) : base?.posts ?? [];
  const tr = (r.triggers ?? {}) as Partial<Automation["triggers"]>;
  const fg = (r.follow_gate ?? {}) as Partial<Automation["follow_gate"]>;
  const match: DmMatch = ["word", "exact", "fuzzy", "any"].includes(String(r.match)) ? (r.match as DmMatch) : base?.match ?? "word";
  return {
    id: typeof r.id === "string" && ID.test(r.id) ? r.id : base?.id ?? rid(),
    name: str(r.name, 80) || base?.name || (kw[0] ? `Comment ${kw[0].toUpperCase()}` : "Every comment"),
    on: bool(r.on, base?.on ?? false),
    created: base?.created ?? Date.now(), updated: Date.now(), by: base?.by ?? null,
    accounts: r.account !== undefined ? (r.account && IGID.test(r.account) ? [r.account] : []) : r.accounts !== undefined ? words(r.accounts, 20, 40).filter((a) => IGID.test(a)) : base?.accounts ?? [],
    where: r.where === "all" || r.where === "some" ? r.where : oldMedia ? "some" : r.media !== undefined || r.posts !== undefined ? (media.length || posts.length ? "some" : "all") : base?.where ?? "all",
    media, posts,
    resolved: Object.fromEntries(Object.entries(base?.resolved ?? {}).filter(([k]) => posts.some((p) => p.id === k))),
    triggers: {
      comments: bool(tr.comments, base?.triggers.comments ?? true),
      dms: bool(tr.dms, typeof r.dms === "boolean" ? r.dms : base?.triggers.dms ?? false),
      story_replies: bool(tr.story_replies, typeof r.dms === "boolean" ? r.dms : base?.triggers.story_replies ?? false),
    },
    match, keywords: kw,
    exclude: words(r.exclude ?? base?.exclude, LIMITS.keywords, LIMITS.keyword),
    typos: Math.max(0, Math.min(3, Math.round(Number(r.typos ?? base?.typos ?? 0)) || 0)),
    top_level_only: bool(r.top_level_only, base?.top_level_only ?? false),
    message: r.message !== undefined ? str(r.message, LIMITS.message) : base?.message ?? "",
    button: url ? { label: str((r.button ?? base?.button)?.label, LIMITS.button_label) || "Open", url } : null,
    public_replies: lines(r.public_replies ?? base?.public_replies, LIMITS.replies, LIMITS.reply),
    follow_gate: {
      on: bool(fg.on, base?.follow_gate.on ?? false),
      message: fg.message !== undefined ? str(fg.message, LIMITS.button_message) : base?.follow_gate.message ?? "",
      button: fg.button !== undefined ? str(fg.button, LIMITS.button_label) : base?.follow_gate.button ?? "",
      not_following: fg.not_following !== undefined ? str(fg.not_following, LIMITS.button_message) : base?.follow_gate.not_following ?? "",
    },
    once_per_person: bool(r.once_per_person, base?.once_per_person ?? true),
  };
}

/** What stops an automation from being switched on. */
export function problems(a: Automation) {
  const out: string[] = [];
  if (!a.message) out.push("Write the DM.");
  if (a.match !== "any" && !a.keywords.length) out.push("Add a keyword, or set it to answer any comment.");
  if (!a.triggers.comments && !a.triggers.dms && !a.triggers.story_replies) out.push("Pick at least one trigger: comments, DMs or story replies.");
  if (a.where === "some" && !a.media.length && !a.posts.length) out.push("Choose the posts, or set it to every post.");
  if (a.button && a.message.length > LIMITS.button_message) out.push(`With a button the DM can be up to ${LIMITS.button_message} characters.`);
  return out;
}

function cleanDefaults(g: Partial<DmDefaults> | undefined, cur: DmDefaults): DmDefaults {
  const d = g ?? {};
  return {
    public_replies: d.public_replies !== undefined ? lines(d.public_replies, LIMITS.replies, LIMITS.reply) : cur.public_replies,
    gate_message: d.gate_message !== undefined ? str(d.gate_message, LIMITS.button_message) || DEFAULT_DEFAULTS.gate_message : cur.gate_message,
    gate_button: d.gate_button !== undefined ? str(d.gate_button, LIMITS.button_label) || DEFAULT_DEFAULTS.gate_button : cur.gate_button,
    not_following: d.not_following !== undefined ? str(d.not_following, LIMITS.button_message) || DEFAULT_DEFAULTS.not_following : cur.not_following,
  };
}

async function read() {
  const { value, etag } = await getJsonTagged<Partial<DmSettings> & { rules?: Record<string, unknown>[] }>(SETTINGS).catch(() => ({ value: null, etag: null }));
  const v = value ?? {};
  const list = (v.automations ?? v.rules ?? []) as Record<string, unknown>[];
  const s: DmSettings = {
    ...EMPTY, on: !!v.on, paused: words(v.paused, 50, 40), updated: v.updated ?? 0, by: v.by ?? null,
    defaults: cleanDefaults(v.defaults, DEFAULT_DEFAULTS),
    automations: list.map((a) => { const c = cleanAutomation(a); return { ...c, created: Number(a.created) || c.created, updated: Number(a.updated) || c.updated, by: (a.by as string) ?? null, resolved: (a.resolved as Record<string, string>) ?? {} }; }),
  };
  return { s, etag };
}
export const getSettings = async () => (await read()).s;

/** Change the settings under their ETag, trying again when someone else saved in between. */
async function mutate<T>(fn: (s: DmSettings) => T): Promise<{ s: DmSettings; out: T }> {
  for (let i = 0; i < 5; i++) {
    const { s, etag } = await read();
    const out = fn(s);
    if (await putJsonIf(SETTINGS, s, etag)) return { s, out };
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 300));
  }
  throw new Error("Someone else is saving Auto-DM right now. Try again.");
}

export async function setGeneral(g: { on?: unknown; paused?: unknown; defaults?: unknown }, by: string) {
  return (await mutate((s) => {
    if (typeof g.on === "boolean") s.on = g.on;
    if (g.paused !== undefined) s.paused = words(g.paused, 50, 40).filter((a) => IGID.test(a));
    if (g.defaults && typeof g.defaults === "object") s.defaults = cleanDefaults(g.defaults as Partial<DmDefaults>, s.defaults);
    s.updated = Date.now(); s.by = by;
  })).s;
}

/** Save one automation (new or changed). One that can't work yet is saved switched off, with what's missing. */
export async function saveAutomation(g: Record<string, unknown>, by: string) {
  const { out } = await mutate((s) => {
    const i = s.automations.findIndex((a) => a.id === g.id);
    if (i < 0 && s.automations.length >= LIMITS.automations) throw new Error(`Up to ${LIMITS.automations} automations`);
    const a = cleanAutomation(g, i >= 0 ? s.automations[i] : undefined);
    a.by = by;
    const missing = problems(a);
    if (a.on && missing.length) a.on = false;
    if (i >= 0) s.automations[i] = a; else s.automations.unshift(a);
    s.updated = Date.now();
    return { automation: a, problems: missing };
  });
  return out;
}

export async function removeAutomations(ids: string[]) {
  return (await mutate((s) => { const n = s.automations.length; s.automations = s.automations.filter((a) => !ids.includes(a.id)); return n - s.automations.length; })).out;
}

export async function switchAutomations(ids: string[], on: boolean) {
  return (await mutate((s) => {
    let n = 0;
    for (const a of s.automations) if (ids.includes(a.id) && (!on || !problems(a).length)) { a.on = on; a.updated = Date.now(); n++; }
    return n;
  })).out;
}

/** Move automations up or down: the first one that matches answers, so order is priority (chosen posts come first anyway). */
export async function reorder(ids: string[]) {
  return (await mutate((s) => {
    const by = new Map(s.automations.map((a) => [a.id, a]));
    const head = ids.map((id) => by.get(id)).filter(Boolean) as Automation[];
    s.automations = [...head, ...s.automations.filter((a) => !ids.includes(a.id))];
    return head.length;
  })).out;
}

// ── matching

const norm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/(\p{L})\1{2,}/gu, "$1$1").replace(/\s+/g, " ").trim();
const tokens = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Damerau-Levenshtein (optimal string alignment), stopping early past `max`. */
export function distance(a: string, b: string, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}
const allowed = (kw: string, typos: number) => (typos > 0 ? typos : kw.length <= 3 ? 0 : kw.length <= 6 ? 1 : 2);

function hasWord(t: string, kw: string) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(kw)}($|[^\\p{L}\\p{N}])`, "u").test(t);
}

/** Which keyword a text matches under an automation's settings, or null. "any" answers "*". */
export function matchText(a: Pick<Automation, "match" | "keywords" | "exclude" | "typos">, text: string): string | null {
  const t = norm(text);
  if (a.exclude.some((x) => x && hasWord(t, norm(x)))) return null;
  if (a.match === "any") return t || text ? "*" : null;
  const toks = tokens(text);
  for (const k of a.keywords) {
    const kw = norm(k);
    if (!kw) continue;
    if (a.match === "exact") { if (toks.join(" ") === tokens(k).join(" ")) return k; continue; }
    if (hasWord(t, kw)) return k;
    if (a.match === "fuzzy") {
      const kt = tokens(k), n = kt.length, joined = kt.join(" "), max = allowed(joined.replace(/ /g, ""), a.typos);
      if (!max) continue;
      // a typo almost never changes the first letter, and keeping it stops look-alike words ("match" for CATCH)
      const near = (w: string) => w[0] === joined[0] && distance(w, joined, max) <= max;
      for (let i = 0; i + n <= toks.length; i++) if (near(toks.slice(i, i + n).join(" "))) return k;
      // "c a t c h" spelled out
      if (n === 1 && toks.length > 1 && toks.every((x) => x.length === 1) && near(toks.join(""))) return k;
    }
  }
  return null;
}

export type Incoming = { account: string; kind: DB.DmKind; media?: string | null; text: string; parent?: string | null };

/** The automation that answers, chosen posts first, then every-post ones, each in list order. */
export function pick(s: Pick<DmSettings, "automations" | "paused">, ev: Incoming, onlyOn = true) {
  if (s.paused.includes(ev.account)) return null;
  const fits = (a: Automation) => (!onlyOn || a.on) && !problems(a).length && (!a.accounts.length || a.accounts.includes(ev.account))
    && (ev.kind === "comment" ? a.triggers.comments && !(a.top_level_only && ev.parent) : ev.kind === "dm" ? a.triggers.dms : a.triggers.story_replies);
  const onPost = (a: Automation) => !!ev.media && (a.media.some((m) => m.id === ev.media) || Object.values(a.resolved).includes(ev.media));
  const list = s.automations.filter(fits);
  // comments: automations for this very post first, then the every-post ones; DMs and story replies aren't on a post
  const ordered = ev.kind === "comment" ? [...list.filter((a) => a.where === "some" && onPost(a)), ...list.filter((a) => a.where === "all")] : list;
  for (const a of ordered) { const k = matchText(a, ev.text); if (k) return { automation: a, keyword: k }; }
  return null;
}

/** Studio posts chosen in automations that went live on Instagram since: their media ids, saved for next time. */
async function resolvePosts(s: DmSettings) {
  const open = s.automations.filter((a) => a.on && a.posts.some((p) => !a.resolved[p.id]));
  if (!open.length) return s;
  const found: Record<string, string> = {};
  for (const id of [...new Set(open.flatMap((a) => a.posts.filter((p) => !a.resolved[p.id]).map((p) => p.id)))].slice(0, 40)) {
    for (const space of ["ig_reel", "ig_post"]) {
      const p = await getPlan(id, space);
      if (p?.state === "published" && p.result?.id) { found[id] = p.result.id; break; }
    }
  }
  if (!Object.keys(found).length) return s;
  const apply = (x: DmSettings) => { for (const a of x.automations) for (const p of a.posts) if (found[p.id]) a.resolved[p.id] = found[p.id]; };
  apply(s);
  await mutate(apply).catch(() => null);
  return s;
}

// ── sending

const GRAPH = "https://graph.instagram.com/v24.0";
type Msg = { text: string; button?: { label: string; url: string } | null; postback?: { title: string; payload: string } | null };

async function send(token: string, account: string, recipient: Record<string, string>, m: Msg) {
  const post = async (message: unknown) => {
    const r = await fetch(`${GRAPH}/${account}/messages`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipient, message }),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } };
    if (!r.ok || j.error) throw Object.assign(new Error(dmError(j.error)), { code: j.error?.code ?? 0 });
  };
  const btn = m.postback ? { type: "postback", title: m.postback.title, payload: m.postback.payload } : m.button ? { type: "web_url", url: m.button.url, title: m.button.label } : null;
  if (!btn) return post({ text: m.text });
  try {
    await post({ attachment: { type: "template", payload: { template_type: "button", text: m.text.slice(0, LIMITS.button_message), buttons: [btn] } } });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 10 || code === 190 || code === 200 || m.postback) throw e;
    // a button Instagram won't take: the link goes in the text instead
    await post({ text: `${m.text}\n\n${m.button!.label}: ${m.button!.url}`.slice(0, LIMITS.message) });
  }
}

function dmError(e?: { message?: string; code?: number; error_subcode?: number }) {
  const code = e?.code ?? 0, sub = e?.error_subcode ?? 0, msg = e?.message ?? "";
  if (code === 190) return "The Instagram connection expired. Reconnect the account.";
  if (code === 10 || code === 200 || code === 3) return "Instagram didn't give Voicebox permission to send messages. Reconnect the account and allow messages (the Meta app needs instagram_business_manage_messages).";
  if (sub === 2534022 || /outside of allowed window/i.test(msg)) return "Too late: Instagram allows a reply only within 7 days of a comment, or 24 hours after someone's last message.";
  if (code === 4 || code === 613 || sub === 2534034) return "Instagram is rate limiting messages from this account.";
  if (sub === 2018001 || /no matching user/i.test(msg)) return "Instagram couldn't find that person (the comment was deleted, or they block messages).";
  if (/already/i.test(msg) && /repl/i.test(msg)) return "That comment already has a private reply (Instagram allows one).";
  return msg || "Instagram didn't take the message";
}

const fill = (t: string, v: { handle: string; username: string | null }) => t.replace(/\{handle\}/g, v.handle).replace(/\{username\}/g, v.username ?? "there");

/** Does this person follow the account? Instagram answers for people who've messaged it or tapped its buttons. */
async function follows(token: string, user: string): Promise<boolean | null> {
  const r = await fetch(`${GRAPH}/${user}?fields=is_user_follow_business&access_token=${encodeURIComponent(token)}`, { cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as { is_user_follow_business?: boolean };
  return typeof j.is_user_follow_business === "boolean" ? j.is_user_follow_business : null;
}

type Ev = Incoming & { ref: string; from: { id: string; username?: string | null } };

async function tokenFor(account: string) {
  const acc = await getAccount(account);
  if (!acc || acc.network !== "instagram") throw new Error("That Instagram account isn't connected to Voicebox");
  return { acc, token: await IG.accessToken(acc) };
}

async function handle(ev: Ev, s: DmSettings) {
  if (!ev.text || !ev.from?.id || ev.from.id === ev.account) return; // our own comments and replies never trigger anything
  const hit = pick(s, ev);
  if (!hit) return;
  const a = hit.automation;
  const id = await DB.claim({ account: ev.account, kind: ev.kind, ref: ev.ref, automation: a.id, automation_name: a.name, media: ev.media ?? null, from_id: ev.from.id, from_name: ev.from.username ?? null, text: ev.text });
  if (!id) return; // Instagram sent it twice
  if (a.once_per_person) {
    const before = await DB.already(a.id, ev.account, ev.from.id, id);
    if (before === "sent") return DB.finish(id, { status: "skipped", note: "Already sent to this person" });
  }
  let acc, token: string;
  try { ({ acc, token } = await tokenFor(ev.account)); } catch (e) { return DB.finish(id, { status: "failed", error: (e as Error).message }); }
  const to: Record<string, string> = ev.kind === "comment" ? { comment_id: ev.ref } : { id: ev.from.id };
  const vars = { handle: acc.handle ?? acc.name, username: ev.from.username ?? null };
  let status: DB.DmStatus = "sent", following: boolean | null = null, error: string | null = null, replied = false, note: string | null = null;
  try {
    if (a.follow_gate.on) {
      // someone who wrote to us can be checked straight away; a commenter is asked first (Instagram only answers about
      // people who've messaged the account or tapped one of its buttons)
      following = ev.kind === "comment" ? null : await follows(token, ev.from.id).catch(() => null);
      if (following) await send(token, acc.id, to, { text: fill(a.message, vars), button: a.button });
      else {
        status = "gated";
        await send(token, acc.id, to, { text: fill(a.follow_gate.message || s.defaults.gate_message, vars), postback: { title: a.follow_gate.button || s.defaults.gate_button, payload: tapPayload(id) } });
      }
    } else await send(token, acc.id, to, { text: fill(a.message, vars), button: a.button });
  } catch (e) {
    status = "failed"; error = (e as Error).message;
    if (/permission|expired/i.test(error)) await patchAccount(acc.id, { error }).catch(() => null);
  }
  if (ev.kind === "comment" && status !== "failed") {
    const pool = a.public_replies.length ? a.public_replies : [];
    if (pool.length) await IG.reply(token, ev.ref, fill(pool[Math.floor(Math.random() * pool.length)], vars)).then(() => { replied = true; }).catch((e) => { note = `Public answer not posted: ${(e as Error).message}`; });
  }
  await DB.finish(id, { status, following, error, replied, note });
}

/** The follow button's payload: the event's row id, signed, so a tap can't be forged for someone else's row. */
const tapSig = (id: number) => createHmac("sha256", `${process.env.INSTAGRAM_APP_SECRET ?? ""}|${process.env.PUBLISH_KEY ?? process.env.MCP_TOKEN ?? ""}|vbdm`).update(String(id)).digest("base64url").slice(0, 16);
const tapPayload = (id: number) => `vbdm:${id}:${tapSig(id)}`;

/** "I'm following" tapped: check, then send what the automation promised, or ask again. */
async function onTap(account: string, from: string, payload: string, s: DmSettings) {
  const m = /^vbdm:(\d{1,18}):([A-Za-z0-9_-]{16})$/.exec(payload);
  if (!m || tapSig(Number(m[1])) !== m[2]) return;
  const e = await DB.getEvent(Number(m[1]));
  // a commenter's id in comments can differ from their id in messages; the signed payload is the claim
  if (!e || e.account !== account || !e.automation || (e.kind !== "comment" && e.from_id !== from)) return;
  const a = s.automations.find((x) => x.id === e.automation);
  if (!a) return;
  const { acc, token } = await tokenFor(account);
  const vars = { handle: acc.handle ?? acc.name, username: e.from_name };
  const ok = await follows(token, from).catch(() => null);
  try {
    if (ok === false) {
      await send(token, acc.id, { id: from }, { text: fill(a.follow_gate.not_following || s.defaults.not_following, vars), postback: { title: a.follow_gate.button || s.defaults.gate_button, payload } });
      await DB.finish(e.id, { status: "gated", following: false, note: "Tapped, not following yet" });
    } else {
      await send(token, acc.id, { id: from }, { text: fill(a.message, vars), button: a.button });
      await DB.finish(e.id, { status: "sent", following: ok ?? null, note: ok === null ? "Sent: Instagram didn't say whether they follow" : null });
    }
  } catch (err) {
    await DB.finish(e.id, { status: "failed", error: (err as Error).message });
  }
}

type Hook = {
  object?: string;
  entry?: {
    id?: string; time?: number;
    changes?: { field?: string; value?: { id?: string; text?: string; parent_id?: string; from?: { id?: string; username?: string }; media?: { id?: string } } }[];
    messaging?: {
      sender?: { id?: string }; recipient?: { id?: string };
      message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; reply_to?: { story?: { id?: string } } };
      postback?: { mid?: string; title?: string; payload?: string };
    }[];
  }[];
};

/** Everything one webhook delivery holds: comments, messages, story replies and button taps. */
export async function onWebhook(body: Hook) {
  if (body.object !== "instagram" || !Array.isArray(body.entry)) return { handled: 0 };
  const { putJson } = await import("../store");
  await putJson("workspace/publish/autodm/last-event.json", { at: Date.now(), entries: body.entry.length }).catch(() => null);
  let s = await getSettings();
  if (!s.on || !dmFlag()) return { handled: 0, off: true };
  const evs: Ev[] = [], taps: { account: string; from: string; payload: string }[] = [];
  for (const e of body.entry) {
    const account = String(e.id ?? "");
    if (!IGID.test(account)) continue;
    for (const c of e.changes ?? []) {
      const v = c.value;
      if ((c.field === "comments" || c.field === "live_comments") && v?.id && v.from?.id && typeof v.text === "string")
        evs.push({ kind: "comment", account, ref: v.id, media: v.media?.id ?? null, parent: v.parent_id ?? null, from: { id: v.from.id, username: v.from.username }, text: v.text });
    }
    for (const m of e.messaging ?? []) {
      if (!m.sender?.id || m.sender.id === account) continue;
      if (m.postback?.payload) { taps.push({ account, from: m.sender.id, payload: m.postback.payload }); continue; }
      if (!m.message || m.message.is_echo || m.message.is_deleted || !m.message.mid || typeof m.message.text !== "string") continue;
      evs.push({ kind: m.message.reply_to?.story ? "story" : "dm", account, ref: m.message.mid, from: { id: m.sender.id }, text: m.message.text });
    }
  }
  if (evs.some((e) => e.kind === "comment")) s = await resolvePosts(s);
  for (const ev of evs.slice(0, 50)) await handle(ev, s).catch((e) => console.error("autodm", (e as Error).message));
  for (const t of taps.slice(0, 50)) await onTap(t.account, t.from, t.payload, s).catch((e) => console.error("autodm tap", (e as Error).message));
  return { handled: evs.length + taps.length };
}

// ── what the dashboard and the MCP read

/** The setup checklist: the switch, the secrets, each account's permission and subscription. */
export async function status() {
  const accounts = (await listAccounts()).filter((a) => a.network === "instagram");
  const { getJson } = await import("../store");
  const last = await getJson<{ at: number }>("workspace/publish/autodm/last-event.json").catch(() => null);
  return {
    flag: dmFlag(), app_secret: !!process.env.INSTAGRAM_APP_SECRET, verify_token: !!process.env.INSTAGRAM_WEBHOOK_TOKEN,
    last_event: last?.at ?? null,
    accounts: accounts.map((a) => ({
      id: a.id, handle: a.handle, name: a.name, avatar: a.avatar, error: a.error ?? null,
      messages: a.scopes ? a.scopes.includes(MESSAGES_SCOPE) : null, subscribed: a.dm_subscribed ?? null,
    })),
  };
}

export async function overview() {
  const [s, st, stats, totals] = await Promise.all([getSettings(), status(), DB.stats(30).catch(() => ({})), DB.totals(30).catch(() => null)]);
  return { settings: s, status: st, stats, totals, limits: LIMITS, defaults: DEFAULT_DEFAULTS };
}

/** Tell Instagram to send this account's comments, messages and button taps to our webhook. */
export async function subscribe(id?: string) {
  const all = (await listAccounts()).filter((a) => a.network === "instagram" && (!id || a.id === id));
  if (!all.length) throw new Error(id ? "That Instagram account isn't connected" : "Connect an Instagram account first");
  const out: { id: string; handle: string | null; ok: boolean; error?: string }[] = [];
  for (const a of all) {
    try {
      const { token } = await tokenFor(a.id);
      await IG.subscribeApp(token, dmFlag() ? ["comments", "messages", "messaging_postbacks"] : ["comments"]);
      await patchAccount(a.id, { dm_subscribed: Date.now() });
      out.push({ id: a.id, handle: a.handle, ok: true });
    } catch (e) {
      out.push({ id: a.id, handle: a.handle, ok: false, error: (e as Error).message });
    }
  }
  return out;
}

/** An account's posts and reels, newest first, a page at a time, to choose for an automation. */
export async function recentMedia(id: string, after?: string) {
  const { token, acc } = await tokenFor(id);
  const r = await IG.igGet<{ data: { id: string; caption?: string; media_type?: string; media_product_type?: string; thumbnail_url?: string; media_url?: string; permalink?: string; timestamp?: string; comments_count?: number }[]; paging?: { cursors?: { after?: string }; next?: string } }>(
    `/${acc.id}/media`, token, { fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count", limit: "36", after: after && /^[A-Za-z0-9_=-]{1,400}$/.test(after) ? after : undefined });
  return {
    media: r.data.map((m) => ({
      id: m.id, caption: (m.caption ?? "").replace(/\s+/g, " ").slice(0, 140), kind: m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : m.media_type === "VIDEO" ? "video" : "photo",
      thumb: m.thumbnail_url ?? (m.media_type !== "VIDEO" ? m.media_url ?? null : null), url: m.permalink ?? null, at: m.timestamp ?? null, comments: m.comments_count ?? null,
    })),
    after: r.paging?.next ? r.paging.cursors?.after ?? null : null,
  };
}

/** Studio posts with an Instagram Reel or Post set up: choosable before they're live. */
export async function studioPosts() {
  const { listPlans } = await import("./plans");
  const plans = (await listPlans()).filter((p) => p.space === "ig_reel" || p.space === "ig_post");
  const ids = [...new Set(plans.map((p) => p.post))].slice(0, 500);
  const { listRows } = await import("../db");
  const posts = ids.length ? await listRows<{ $id: string; title: string }>("posts", [{ method: "equal", attribute: "$id", values: ids }, { method: "limit", values: [500] }]).catch(() => []) : [];
  const title = new Map(posts.map((p) => [p.$id, p.title]));
  return plans.filter((p) => title.has(p.post)).map((p) => ({
    id: p.post, title: title.get(p.post)!, space: p.space, state: p.state, account: p.account, media: p.state === "published" ? p.result?.id ?? null : null, url: p.result?.url ?? null,
  })).sort((a, b) => (a.state === "published" ? 0 : 1) - (b.state === "published" ? 0 : 1) || a.title.localeCompare(b.title));
}

/** A dry run: which automation a comment (or DM) would trigger and what would go out. Nothing is sent. */
export async function test(text: string, opts: { account?: string | null; media?: string | null; kind?: DB.DmKind; automation?: Record<string, unknown> } = {}) {
  const s = await getSettings();
  const accounts = (await listAccounts()).filter((a) => a.network === "instagram");
  const account = opts.account && IGID.test(opts.account) ? opts.account : accounts[0]?.id ?? "0";
  const handle = accounts.find((a) => a.id === account)?.handle ?? "you";
  // testing an automation as it's being edited: just that one, switched on
  const list = opts.automation ? [{ ...cleanAutomation(opts.automation), on: true }] : s.automations;
  const hit = pick({ automations: list, paused: [] }, { account, media: opts.media ?? null, text, kind: opts.kind ?? "comment" }, !opts.automation);
  if (!hit) return { automation: null, keyword: null, steps: [], note: "No automation answers that." };
  const a = hit.automation, vars = { handle, username: "them" };
  const steps = a.follow_gate.on
    ? [{ to: "DM", text: fill(a.follow_gate.message || s.defaults.gate_message, vars), button: a.follow_gate.button || s.defaults.gate_button },
      { to: "DM, once they tap and follow", text: fill(a.message, vars), button: a.button?.label ?? null }]
    : [{ to: "DM", text: fill(a.message, vars), button: a.button?.label ?? null }];
  if ((opts.kind ?? "comment") === "comment" && a.public_replies.length) steps.push({ to: "Public answer", text: fill(a.public_replies[0], vars), button: null });
  return {
    automation: { id: a.id, name: a.name }, keyword: hit.keyword, steps,
    note: s.on && dmFlag() ? (s.paused.includes(account) ? "This account is paused." : "This would be sent.") : "This would be sent once Auto-DM is switched on.",
  };
}

export { activity, contacts } from "./dmstore";
