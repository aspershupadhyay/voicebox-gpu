// Auto-DM for Instagram (the Auto-DM page, /auto-dm): automations that answer a comment, a DM, a story reply or a story
// mention with a message, the way ManyChat does, on every connected account. Each automation has a trigger (which
// posts, which accounts), matching (lib/publish/dmmatch.ts: a keyword as a word, the whole comment, fuzzy for typos,
// or anything), and a flow: an optional follow check, an optional "send me your email" before or after, the DM itself
// (a link button, counted through a short link, up to three choice buttons that each answer with their own reply, and
// an optional B version that wins by itself once it's clearly better), a public answer under the comment, and AI
// answers to follow-up questions (lib/publish/autodm-more.ts, with comment rules, auto-attach on publish, the weekly
// report, the sync to a sheet or CRM, and the hourly limit's queue).
//
// Instagram calls /api/ig/webhook on every comment, message and button tap (signed); this file decides what to send.
// Automations and settings live in R2 (workspace/publish/autodm/settings.json, written under an ETag); what happened
// is in Postgres (lib/publish/dmstore.ts).
//
// Nothing is sent until: INSTAGRAM_DM=1 (Instagram Login asks for instagram_business_manage_messages, which needs Meta's
// App Review for anyone who isn't a tester), the account was reconnected with that permission and subscribed, and the
// master switch is on. Instagram's limits: one private reply per comment within 7 days of it, and nothing more until
// they write back; after someone messages you (a DM, a story reply, a button tap) you have 24 hours to answer.
import { createHmac } from "node:crypto";
import { getJsonTagged, putJsonIf } from "../store";
import { getAccount, listAccounts, patchAccount } from "./accounts";
import { emailIn, matchText, type DmMatch } from "./dmmatch";
import * as DB from "./dmstore";
import * as IG from "./instagram";
import { getPlan } from "./plans";

export { distance, matchText, keywordFrom, modMatch } from "./dmmatch";
export type { DmMatch } from "./dmmatch";

const SETTINGS = "workspace/publish/autodm/settings.json";
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const IGID = /^\d{3,40}$/;

export const MESSAGES_SCOPE = "instagram_business_manage_messages";
/** The switch that makes Instagram Login ask for the messaging permission. Off until the Meta app has it. */
export const dmFlag = () => process.env.INSTAGRAM_DM === "1";

export type DmTarget = { id: string; label: string; thumb?: string | null };
export type DmButton = { label: string; url: string };
export type DmChoice = { id: string; label: string; reply: string; button: DmButton | null };
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
  triggers: { comments: boolean; dms: boolean; story_replies: boolean; mentions: boolean };
  match: DmMatch;
  keywords: string[];
  /** a comment with any of these is ignored ("stop", "spam") */
  exclude: string[];
  /** fuzzy: how many typos a keyword may have; 0 = by length (1 for 4-6 letters, 2 for 7+) */
  typos: number;
  /** only comments on the post itself, not replies under other comments */
  top_level_only: boolean;
  message: string;
  button: DmButton | null;
  /** the button goes through a short link of ours, so opens are counted */
  track: boolean;
  /** an A/B test: half get this version until one is clearly opened more, then everyone gets the winner */
  ab: { on: boolean; message: string; button_label: string; min: number; winner: "a" | "b" | null; decided: number | null };
  /** up to three buttons under the DM, each answering with its own reply ("The prompt" / "The tutorial") */
  choices: DmChoice[];
  public_replies: string[];
  follow_gate: { on: boolean; message: string; button: string; not_following: string };
  /** ask for an email: before the DM (they get it once they send one) or after it */
  collect: { on: boolean; when: "before" | "after"; ask: string; thanks: string };
  /** AI answers to follow-up questions, from the post's script and these notes */
  ai: { on: boolean; notes: string };
  once_per_person: boolean;
  /** made by auto-attach, from this studio post */
  made_from: string | null;
};
export type ModRule = { id: string; name: string; on: boolean; accounts: string[]; words: string[]; match: "word" | "fuzzy"; links: boolean; action: "hide" | "delete" | "flag" };
export type DmDefaults = { public_replies: string[]; gate_message: string; gate_button: string; not_following: string; ask_email: string; thanks_email: string };
export type DmSettings = {
  on: boolean; paused: string[]; defaults: DmDefaults; automations: Automation[]; updated: number; by: string | null;
  safety: { per_hour: number; per_person_day: number; blocklist: string[] };
  moderation: { on: boolean; rules: ModRule[] };
  auto_attach: { on: boolean; template: string | null; live: boolean };
  report: { on: boolean; day: number; last: number };
  sync: { on: boolean; url: string; leads: boolean; dms: boolean };
  ai: { persona: string; per_person_day: number };
};

export const LIMITS = {
  automations: 1000, keywords: 30, keyword: 60, message: 1000, button_message: 640, button_label: 20, reply: 300, replies: 8, targets: 200,
  buttons: 3, rules: 100, blocklist: 2000, persona: 1000, notes: 4000, per_hour: 750,
};
export const DEFAULT_DEFAULTS: DmDefaults = {
  public_replies: ["Sent! Check your DMs 📩", "Just sent it to your DMs 🙌", "Check your inbox 📬"],
  gate_message: "Almost there! Follow @{handle}, then tap the button below and I'll send it right away 👇",
  gate_button: "I'm following ✅",
  not_following: "Looks like you're not following @{handle} yet 🙈 Follow, then tap the button again.",
  ask_email: "Want the next one straight to your inbox? Reply with your email 📩",
  thanks_email: "Got it, thanks {username}! You're on the list ✅",
};
export const AI_MODEL = "claude-opus-5-5";
const EMPTY: DmSettings = {
  on: false, paused: [], defaults: DEFAULT_DEFAULTS, automations: [], updated: 0, by: null,
  safety: { per_hour: 150, per_person_day: 5, blocklist: [] },
  moderation: { on: false, rules: [] },
  auto_attach: { on: false, template: null, live: false },
  report: { on: true, day: 1, last: 0 },
  sync: { on: false, url: "", leads: true, dms: false },
  ai: { persona: "", per_person_day: 5 },
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const rid = () => Math.random().toString(36).slice(2, 10);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const int = (v: unknown, d: number, lo: number, hi: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const words = (v: unknown, max: number, each: number) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((k) => String(k).trim().slice(0, each)).filter(Boolean).slice(0, max);
const lines = (v: unknown, max: number, each: number) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : []).map((k) => String(k).trim().slice(0, each)).filter(Boolean).slice(0, max);
export function cleanUrl(v: unknown) {
  const s = str(v, 1000);
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : ""; } catch { return ""; }
}
const targets = (v: unknown, ok: RegExp) => (Array.isArray(v) ? v : []).flatMap((t) => {
  const id = typeof t === "string" ? t : (t as DmTarget)?.id;
  return typeof id === "string" && ok.test(id) ? [{ id, label: str((t as DmTarget)?.label, 140) || id, thumb: typeof (t as DmTarget)?.thumb === "string" ? (t as DmTarget).thumb!.slice(0, 1000) : null }] : [];
}).slice(0, LIMITS.targets);
/** A button as given: its link must be http(s); without one it's kept with an empty link (problems() says so). */
const button = (v: unknown, keepEmpty: boolean): DmButton | null => {
  if (!v || typeof v !== "object") return null;
  const b = v as Partial<DmButton>, url = cleanUrl(b.url);
  return url || (keepEmpty && typeof b.label === "string") ? { label: str(b.label, LIMITS.button_label) || "Open", url } : null;
};
const handles = (v: unknown) => words(v, LIMITS.blocklist, 40).map((h) => h.replace(/^@/, "").toLowerCase()).filter((h) => /^[a-z0-9._]{1,30}$/.test(h));

/** An automation as given (the dashboard, the MCP, an older saved shape), made safe and complete. */
export function cleanAutomation(g: Record<string, unknown> | undefined, cur?: Automation): Automation {
  const r = (g ?? {}) as Partial<Automation> & { media?: unknown; dms?: boolean; account?: string | null };
  const base = cur;
  const kw = words(r.keywords ?? base?.keywords, LIMITS.keywords, LIMITS.keyword);
  // the first version kept one post as a string, one account and a dms flag
  const oldMedia = typeof r.media === "string" ? [{ id: r.media, label: str((r as { media_label?: string }).media_label, 140) || r.media }] : null;
  const media = oldMedia ?? (r.media !== undefined ? targets(r.media, IGID) : base?.media ?? []);
  const posts = r.posts !== undefined ? targets(r.posts, ID) : base?.posts ?? [];
  const tr = (r.triggers ?? {}) as Partial<Automation["triggers"]>;
  const fg = (r.follow_gate ?? {}) as Partial<Automation["follow_gate"]>;
  const ab = (r.ab ?? {}) as Partial<Automation["ab"]>;
  const co = (r.collect ?? {}) as Partial<Automation["collect"]>;
  const ai = (r.ai ?? {}) as Partial<Automation["ai"]>;
  const match: DmMatch = ["word", "exact", "fuzzy", "any"].includes(String(r.match)) ? (r.match as DmMatch) : base?.match ?? "word";
  const btn = r.button !== undefined ? button(r.button, true) : base?.button ?? null;
  const choices = (r.choices !== undefined ? (Array.isArray(r.choices) ? r.choices : []) : base?.choices ?? []).slice(0, LIMITS.buttons).map((c) => {
    const x = (c ?? {}) as Partial<DmChoice>;
    return { id: typeof x.id === "string" && ID.test(x.id) ? x.id : rid(), label: str(x.label, LIMITS.button_label), reply: str(x.reply, LIMITS.button_message), button: button(x.button, true) };
  });
  const abMessage = ab.message !== undefined ? str(ab.message, LIMITS.message) : base?.ab.message ?? "";
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
      mentions: bool(tr.mentions, base?.triggers.mentions ?? false),
    },
    match, keywords: kw,
    exclude: words(r.exclude ?? base?.exclude, LIMITS.keywords, LIMITS.keyword),
    typos: int(r.typos ?? base?.typos, 0, 0, 3),
    top_level_only: bool(r.top_level_only, base?.top_level_only ?? false),
    message: r.message !== undefined ? str(r.message, LIMITS.message) : base?.message ?? "",
    button: btn,
    track: bool(r.track, base?.track ?? true),
    ab: {
      on: bool(ab.on, base?.ab.on ?? false), message: abMessage,
      button_label: ab.button_label !== undefined ? str(ab.button_label, LIMITS.button_label) : base?.ab.button_label ?? "",
      min: int(ab.min ?? base?.ab.min, 50, 10, 5000),
      // a changed B starts the test again
      winner: ab.winner === "a" || ab.winner === "b" || ab.winner === null ? ab.winner : base && abMessage !== base.ab.message ? null : base?.ab.winner ?? null,
      decided: typeof ab.decided === "number" ? ab.decided : ab.winner === null ? null : base && abMessage !== base.ab.message ? null : base?.ab.decided ?? null,
    },
    choices,
    public_replies: lines(r.public_replies ?? base?.public_replies, LIMITS.replies, LIMITS.reply),
    follow_gate: {
      on: bool(fg.on, base?.follow_gate.on ?? false),
      message: fg.message !== undefined ? str(fg.message, LIMITS.button_message) : base?.follow_gate.message ?? "",
      button: fg.button !== undefined ? str(fg.button, LIMITS.button_label) : base?.follow_gate.button ?? "",
      not_following: fg.not_following !== undefined ? str(fg.not_following, LIMITS.button_message) : base?.follow_gate.not_following ?? "",
    },
    collect: {
      on: bool(co.on, base?.collect.on ?? false), when: co.when === "before" || co.when === "after" ? co.when : base?.collect.when ?? "after",
      ask: co.ask !== undefined ? str(co.ask, LIMITS.button_message) : base?.collect.ask ?? "",
      thanks: co.thanks !== undefined ? str(co.thanks, LIMITS.button_message) : base?.collect.thanks ?? "",
    },
    ai: { on: bool(ai.on, base?.ai.on ?? false), notes: ai.notes !== undefined ? str(ai.notes, LIMITS.notes) : base?.ai.notes ?? "" },
    once_per_person: bool(r.once_per_person, base?.once_per_person ?? true),
    made_from: typeof r.made_from === "string" && ID.test(r.made_from) ? r.made_from : base?.made_from ?? null,
  };
}

/** What stops an automation from being switched on. */
export function problems(a: Automation) {
  const out: string[] = [];
  if (!a.message) out.push("Write the DM.");
  if (a.match !== "any" && !a.keywords.length && (a.triggers.comments || a.triggers.dms || a.triggers.story_replies)) out.push("Add a keyword, or set it to answer anything.");
  if (!a.triggers.comments && !a.triggers.dms && !a.triggers.story_replies && !a.triggers.mentions) out.push("Pick at least one trigger.");
  if (a.triggers.comments && a.where === "some" && !a.media.length && !a.posts.length) out.push("Choose the posts, or set it to every post.");
  if (a.button && !a.button.url) out.push("Add the button's link, or remove the button.");
  if ((a.button || a.choices.length) && a.message.length > LIMITS.button_message) out.push(`With buttons the DM can be up to ${LIMITS.button_message} characters.`);
  if ((a.button ? 1 : 0) + a.choices.length > LIMITS.buttons) out.push("Instagram shows up to 3 buttons: the link counts as one.");
  a.choices.forEach((c, i) => {
    if (!c.label || !c.reply) out.push(`Choice ${i + 1} needs a button text and a reply.`);
    if (c.button && !c.button.url) out.push(`Choice ${i + 1}'s button needs a link.`);
  });
  if (a.ab.on && !a.ab.message) out.push("Write version B, or switch the A/B test off.");
  return out;
}

const cleanRule = (g: Partial<ModRule>, i: number): ModRule => ({
  id: typeof g.id === "string" && ID.test(g.id) ? g.id : rid(), name: str(g.name, 60) || `Rule ${i + 1}`, on: bool(g.on, true),
  accounts: words(g.accounts, 20, 40).filter((a) => IGID.test(a)), words: words(g.words, 100, LIMITS.keyword),
  match: g.match === "fuzzy" ? "fuzzy" : "word", links: bool(g.links, false), action: g.action === "delete" || g.action === "flag" ? g.action : "hide",
});

function cleanDefaults(g: Partial<DmDefaults> | undefined, cur: DmDefaults): DmDefaults {
  const d = g ?? {};
  const t = (k: keyof DmDefaults, max: number) => (d[k] !== undefined ? str(d[k], max) || (DEFAULT_DEFAULTS[k] as string) : (cur[k] as string) || (DEFAULT_DEFAULTS[k] as string));
  return {
    public_replies: d.public_replies !== undefined ? lines(d.public_replies, LIMITS.replies, LIMITS.reply) : cur.public_replies,
    gate_message: t("gate_message", LIMITS.button_message), gate_button: t("gate_button", LIMITS.button_label), not_following: t("not_following", LIMITS.button_message),
    ask_email: t("ask_email", LIMITS.button_message), thanks_email: t("thanks_email", LIMITS.button_message),
  };
}

type Raw = Partial<DmSettings> & { rules?: Record<string, unknown>[] };
async function read() {
  const { value, etag } = await getJsonTagged<Raw>(SETTINGS).catch(() => ({ value: null, etag: null }));
  const v = value ?? {};
  const list = (v.automations ?? v.rules ?? []) as Record<string, unknown>[];
  const sf = (v.safety ?? {}) as Partial<DmSettings["safety"]>, md = (v.moderation ?? {}) as Partial<DmSettings["moderation"]>;
  const at = (v.auto_attach ?? {}) as Partial<DmSettings["auto_attach"]>, rp = (v.report ?? {}) as Partial<DmSettings["report"]>;
  const sy = (v.sync ?? {}) as Partial<DmSettings["sync"]>, ai = (v.ai ?? {}) as Partial<DmSettings["ai"]>;
  const s: DmSettings = {
    on: !!v.on, paused: words(v.paused, 50, 40), updated: v.updated ?? 0, by: v.by ?? null,
    defaults: cleanDefaults(v.defaults, DEFAULT_DEFAULTS),
    automations: list.map((a) => { const c = cleanAutomation(a); return { ...c, created: Number(a.created) || c.created, updated: Number(a.updated) || c.updated, by: (a.by as string) ?? null, resolved: (a.resolved as Record<string, string>) ?? {} }; }),
    safety: { per_hour: int(sf.per_hour, EMPTY.safety.per_hour, 1, LIMITS.per_hour), per_person_day: int(sf.per_person_day, EMPTY.safety.per_person_day, 1, 100), blocklist: handles(sf.blocklist) },
    moderation: { on: !!md.on, rules: (Array.isArray(md.rules) ? md.rules : []).slice(0, LIMITS.rules).map(cleanRule) },
    auto_attach: { on: !!at.on, template: typeof at.template === "string" && ID.test(at.template) ? at.template : null, live: !!at.live },
    report: { on: bool(rp.on, true), day: int(rp.day, 1, 0, 6), last: Number(rp.last) || 0 },
    sync: { on: !!sy.on, url: cleanUrl(sy.url).startsWith("https://") ? cleanUrl(sy.url) : "", leads: bool(sy.leads, true), dms: bool(sy.dms, false) },
    ai: { persona: str(ai.persona, LIMITS.persona), per_person_day: int(ai.per_person_day, 5, 1, 50) },
  };
  return { s, etag };
}
export const getSettings = async () => (await read()).s;

/** Change the settings under their ETag, trying again when someone else saved in between. */
export async function mutate<T>(fn: (s: DmSettings) => T): Promise<{ s: DmSettings; out: T }> {
  for (let i = 0; i < 5; i++) {
    const { s, etag } = await read();
    const out = fn(s);
    if (await putJsonIf(SETTINGS, s, etag)) return { s, out };
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 300));
  }
  throw new Error("Someone else is saving Auto-DM right now. Try again.");
}

type General = { on?: unknown; paused?: unknown; defaults?: unknown; safety?: unknown; moderation?: unknown; auto_attach?: unknown; report?: unknown; sync?: unknown; ai?: unknown; block?: unknown; unblock?: unknown };
/** The settings that aren't one automation: switches, defaults, safety, comment rules, auto-attach, report, sync, AI. */
export async function setGeneral(g: General, by: string) {
  return (await mutate((s) => {
    if (typeof g.on === "boolean") s.on = g.on;
    if (g.paused !== undefined) s.paused = words(g.paused, 50, 40).filter((a) => IGID.test(a));
    if (g.defaults && typeof g.defaults === "object") s.defaults = cleanDefaults(g.defaults as Partial<DmDefaults>, s.defaults);
    const o = <T>(v: unknown) => (v && typeof v === "object" ? (v as Partial<T>) : null);
    const sf = o<DmSettings["safety"]>(g.safety);
    if (sf) s.safety = { per_hour: int(sf.per_hour ?? s.safety.per_hour, s.safety.per_hour, 1, LIMITS.per_hour), per_person_day: int(sf.per_person_day ?? s.safety.per_person_day, s.safety.per_person_day, 1, 100), blocklist: sf.blocklist !== undefined ? handles(sf.blocklist) : s.safety.blocklist };
    if (g.block !== undefined) s.safety.blocklist = [...new Set([...s.safety.blocklist, ...handles(g.block)])].slice(0, LIMITS.blocklist);
    if (g.unblock !== undefined) { const un = handles(g.unblock); s.safety.blocklist = s.safety.blocklist.filter((h) => !un.includes(h)); }
    const md = o<DmSettings["moderation"]>(g.moderation);
    if (md) s.moderation = { on: typeof md.on === "boolean" ? md.on : s.moderation.on, rules: Array.isArray(md.rules) ? md.rules.slice(0, LIMITS.rules).map(cleanRule) : s.moderation.rules };
    const at = o<DmSettings["auto_attach"]>(g.auto_attach);
    if (at) s.auto_attach = { on: bool(at.on, s.auto_attach.on), live: bool(at.live, s.auto_attach.live), template: at.template === null ? null : typeof at.template === "string" && ID.test(at.template) ? at.template : s.auto_attach.template };
    const rp = o<DmSettings["report"]>(g.report);
    if (rp) s.report = { ...s.report, on: bool(rp.on, s.report.on), day: int(rp.day ?? s.report.day, s.report.day, 0, 6) };
    const sy = o<DmSettings["sync"]>(g.sync);
    if (sy) {
      const url = sy.url !== undefined ? cleanUrl(sy.url) : s.sync.url;
      if (url && !url.startsWith("https://")) throw new Error("The sync address must start with https://");
      s.sync = { url, on: bool(sy.on, s.sync.on) && !!url, leads: bool(sy.leads, s.sync.leads), dms: bool(sy.dms, s.sync.dms) };
    }
    const ai = o<DmSettings["ai"]>(g.ai);
    if (ai) s.ai = { persona: ai.persona !== undefined ? str(ai.persona, LIMITS.persona) : s.ai.persona, per_person_day: int(ai.per_person_day ?? s.ai.per_person_day, s.ai.per_person_day, 1, 50) };
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
  return (await mutate((s) => { const n = s.automations.length; s.automations = s.automations.filter((a) => !ids.includes(a.id)); if (s.auto_attach.template && ids.includes(s.auto_attach.template)) s.auto_attach.template = null; return n - s.automations.length; })).out;
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

// ── which automation answers

export type Incoming = { account: string; kind: DB.DmKind; media?: string | null; text: string; parent?: string | null };

/** The automation that answers, chosen posts first, then every-post ones, each in list order. */
export function pick(s: Pick<DmSettings, "automations" | "paused">, ev: Incoming, onlyOn = true) {
  if (s.paused.includes(ev.account)) return null;
  const fits = (a: Automation) => (!onlyOn || a.on) && !problems(a).length && (!a.accounts.length || a.accounts.includes(ev.account))
    && (ev.kind === "comment" ? a.triggers.comments && !(a.top_level_only && ev.parent) : ev.kind === "dm" ? a.triggers.dms : ev.kind === "story" ? a.triggers.story_replies : ev.kind === "mention" ? a.triggers.mentions : false);
  const onPost = (a: Automation) => !!ev.media && (a.media.some((m) => m.id === ev.media) || Object.values(a.resolved).includes(ev.media));
  const list = s.automations.filter(fits);
  // comments: automations for this very post first, then the every-post ones; DMs and story replies aren't on a post
  const ordered = ev.kind === "comment" ? [...list.filter((a) => a.where === "some" && onPost(a)), ...list.filter((a) => a.where === "all")] : list;
  // a story mention has no words: the first automation that answers mentions does
  if (ev.kind === "mention") return ordered[0] ? { automation: ordered[0], keyword: "*" } : null;
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
export type Btn = { type: "web_url"; url: string; title: string } | { type: "postback"; title: string; payload: string };
export type Msg = { text: string; buttons?: Btn[] };

/** One message. Answers Instagram's id for the person in messages (what later messages go to). */
export async function send(token: string, account: string, recipient: Record<string, string>, m: Msg): Promise<string | null> {
  const post = async (message: unknown) => {
    const r = await fetch(`${GRAPH}/${account}/messages`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipient, message }),
    });
    const j = (await r.json().catch(() => ({}))) as { recipient_id?: string; error?: { message?: string; code?: number; error_subcode?: number } };
    if (!r.ok || j.error) throw Object.assign(new Error(dmError(j.error)), { code: j.error?.code ?? 0 });
    return typeof j.recipient_id === "string" ? j.recipient_id : null;
  };
  const btns = (m.buttons ?? []).slice(0, LIMITS.buttons);
  if (!btns.length) return post({ text: m.text.slice(0, LIMITS.message) });
  try {
    return await post({ attachment: { type: "template", payload: { template_type: "button", text: m.text.slice(0, LIMITS.button_message), buttons: btns } } });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 10 || code === 190 || code === 200 || btns.some((b) => b.type === "postback")) throw e;
    // buttons Instagram won't take: the links go in the text instead
    return post({ text: [m.text, ...btns.map((b) => `${b.title}: ${(b as { url: string }).url}`)].join("\n\n").slice(0, LIMITS.message) });
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

export const fill = (t: string, v: { handle: string; username: string | null }) => t.replace(/\{handle\}/g, v.handle).replace(/\{username\}/g, v.username ?? "there");

/** Does this person follow the account? Instagram answers for people who've messaged it or tapped its buttons. */
async function follows(token: string, user: string): Promise<boolean | null> {
  const r = await fetch(`${GRAPH}/${user}?fields=is_user_follow_business&access_token=${encodeURIComponent(token)}`, { cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as { is_user_follow_business?: boolean };
  return typeof j.is_user_follow_business === "boolean" ? j.is_user_follow_business : null;
}

export async function tokenFor(account: string) {
  const acc = await getAccount(account);
  if (!acc || acc.network !== "instagram") throw new Error("That Instagram account isn't connected to Voicebox");
  return { acc, token: await IG.accessToken(acc) };
}

// signed payloads and links: a tap or a click can't be forged for someone else's row
const key = () => `${process.env.INSTAGRAM_APP_SECRET ?? ""}|${process.env.PUBLISH_KEY ?? process.env.MCP_TOKEN ?? ""}|vbdm`;
export const sign = (s: string, n = 16) => createHmac("sha256", key()).update(s).digest("base64url").slice(0, n);
const tapPayload = (id: number) => `vbdm:${id}:${sign(String(id))}`;
const choicePayload = (id: number, i: number) => `vbdc:${id}:${i}:${sign(`c${id}:${i}`)}`;
/** The short link a DM's button points to: /l/<row in base 36>-<which link>-<signature>. */
export function trackUrl(id: number, k: number) {
  const base = process.env.APP_URL?.replace(/\/$/, "") || "https://voiceboxstudio.pages.dev";
  const t = `${id.toString(36)}-${k}`;
  return `${base}/l/${t}-${sign(`l${t}`, 12)}`;
}
/** A short link's row and which of its links, or null when the signature is wrong. */
export function readTrack(token: string) {
  const m = /^([0-9a-z]{1,12})-([0-3])-([A-Za-z0-9_-]{12})$/.exec(token);
  if (!m || sign(`l${m[1]}-${m[2]}`, 12) !== m[3]) return null;
  const id = parseInt(m[1], 36);
  return Number.isSafeInteger(id) && id > 0 ? { id, k: Number(m[2]) } : null;
}

/** Version A or B of the DM: the winner once there is one, else half and half. */
export function variantOf(a: Automation): "a" | "b" {
  if (!a.ab.on || !a.ab.message) return "a";
  return a.ab.winner ?? (Math.random() < 0.5 ? "a" : "b");
}

/** One person going through one automation: who, where messages go, and whether Instagram lets us write freely yet. */
type Flow = {
  id: number; a: Automation; s: DmSettings; account: string; token: string; vars: { handle: string; username: string | null };
  /** where the next message goes: their messaging id, or the comment (a private reply) */
  to: Record<string, string>;
  /** they wrote to us or tapped a button: more than one message is allowed (a private reply allows one) */
  open: boolean;
  psid: string | null;
};
type Out = DB.Patch;

async function step(f: Flow, m: Msg): Promise<string | null> {
  const r = await send(f.token, f.account, f.to, m);
  // after the first message Instagram tells us who they are in messages; later ones go there
  if (r) { f.psid = r; f.to = { id: r }; }
  return r;
}

/** The start of the flow: the follow check, then the email (when asked for first), then the DM. */
async function start(f: Flow): Promise<Out> {
  const { a, s } = f;
  let following: boolean | null = null;
  if (a.follow_gate.on) {
    // someone who wrote to us can be checked straight away; a commenter is asked first (Instagram only answers about
    // people who've messaged the account or tapped one of its buttons)
    following = f.open && f.psid ? await follows(f.token, f.psid).catch(() => null) : null;
    if (following !== true) {
      await step(f, { text: fill(a.follow_gate.message || s.defaults.gate_message, f.vars), buttons: [{ type: "postback", title: a.follow_gate.button || s.defaults.gate_button, payload: tapPayload(f.id) }] });
      return { status: "gated", awaiting: "follow", following, psid: f.psid };
    }
  }
  return afterFollow(f, following);
}

async function afterFollow(f: Flow, following: boolean | null): Promise<Out> {
  const { a, s } = f;
  if (a.collect.on && a.collect.when === "before") {
    await step(f, { text: fill(a.collect.ask || s.defaults.ask_email, f.vars) });
    return { status: "gated", awaiting: "email", following, psid: f.psid };
  }
  return main(f, following);
}

/** The DM: version A or B, the tracked link, the choices, and the email question when it comes after. */
async function main(f: Flow, following: boolean | null, before?: string): Promise<Out> {
  const { a, s } = f;
  const variant = variantOf(a);
  let text = variant === "b" ? a.ab.message : a.message;
  const label = (variant === "b" && a.ab.button_label) || a.button?.label || "Open";
  const links = [a.button?.url ?? "", ...a.choices.map((c) => c.button?.url ?? "")];
  const buttons: Btn[] = [];
  if (a.button?.url) buttons.push({ type: "web_url", title: label, url: a.track ? trackUrl(f.id, 0) : a.button.url });
  a.choices.forEach((c, i) => buttons.push({ type: "postback", title: c.label, payload: choicePayload(f.id, i) }));
  const askAfter = a.collect.on && a.collect.when === "after";
  const ask = fill(a.collect.ask || s.defaults.ask_email, f.vars);
  // a private reply is the only message until they write back, so the question rides along in it
  if (askAfter && !f.open) text = `${text}\n\n${ask}`;
  if (before) text = `${before}\n\n${text}`;
  await DB.finish(f.id, { links, variant });
  await step(f, { text: fill(text, f.vars), buttons });
  if (askAfter && f.open) await step(f, { text: ask });
  return { status: "sent", variant, links, reply: fill(text, f.vars), awaiting: askAfter ? "email" : null, following, psid: f.psid };
}

type Ev = Incoming & { ref: string; from: { id: string; username?: string | null } };
const varsOf = (acc: { handle: string | null; name: string }, username: string | null | undefined) => ({ handle: acc.handle ?? acc.name, username: username ?? null });

async function handle(ev: Ev, s: DmSettings) {
  if (!ev.from?.id || ev.from.id === ev.account) return; // our own comments and replies never trigger anything
  if (!ev.text && ev.kind !== "mention") return;
  const hit = pick(s, ev);
  if (!hit) return;
  const a = hit.automation;
  const psid = ev.kind === "comment" ? null : ev.from.id;
  const id = await DB.claim({ account: ev.account, kind: ev.kind, ref: ev.ref, automation: a.id, automation_name: a.name, media: ev.media ?? null, from_id: ev.from.id, from_name: ev.from.username ?? null, text: ev.text, psid });
  if (!id) return; // Instagram sent it twice
  const who = (ev.from.username ?? "").toLowerCase();
  if (who && s.safety.blocklist.includes(who)) return DB.finish(id, { status: "skipped", note: "Blocked (Settings → Safety)" });
  if (a.once_per_person && (await DB.already(a.id, ev.account, ev.from.id, id))) return DB.finish(id, { status: "skipped", note: "Already sent to this person" });
  if ((await DB.sentToPerson(ev.account, ev.from.id)) >= s.safety.per_person_day) return DB.finish(id, { status: "skipped", note: `Daily limit for one person (${s.safety.per_person_day})` });
  if ((await DB.sentLastHour(ev.account)) >= s.safety.per_hour) {
    await DB.finish(id, { status: "held", note: `Waiting: the hourly limit (${s.safety.per_hour}) is reached; it goes out when there's room` });
    return (await import("./autodm-more")).markHeld();
  }
  await run(id, a, s, { account: ev.account, kind: ev.kind, ref: ev.ref, psid, username: ev.from.username ?? null });
}

/** Send an automation to the person on a claimed row, then answer the comment in public. Also used for held rows. */
export async function run(id: number, a: Automation, s: DmSettings, e: { account: string; kind: DB.DmKind; ref: string; psid: string | null; username: string | null }) {
  let acc, token: string;
  try { ({ acc, token } = await tokenFor(e.account)); } catch (err) { return DB.finish(id, { status: "failed", error: (err as Error).message }); }
  const f: Flow = { id, a, s, account: acc.id, token, vars: varsOf(acc, e.username), to: e.psid ? { id: e.psid } : { comment_id: e.ref }, open: e.kind !== "comment", psid: e.psid };
  let out: Out;
  try { out = await start(f); } catch (err) {
    const error = (err as Error).message;
    if (/permission|expired/i.test(error)) await patchAccount(acc.id, { error }).catch(() => null);
    return DB.finish(id, { status: "failed", error, psid: f.psid });
  }
  if (e.kind === "comment" && a.public_replies.length) {
    await IG.reply(token, e.ref, fill(a.public_replies[Math.floor(Math.random() * a.public_replies.length)], f.vars))
      .then(() => { out.replied = true; }).catch((err) => { out.note = `Public answer not posted: ${(err as Error).message}`; });
  }
  await DB.finish(id, out);
  await (await import("./autodm-more")).synced("dm", { account: acc, username: e.username, automation: a.name, text: out.reply ?? "" }).catch(() => null);
}

/** A row's flow, picked up again after a tap or a reply (the window is open: they wrote to us). */
async function resume(e: DB.DmEvent, s: DmSettings, psid: string) {
  const a = s.automations.find((x) => x.id === e.automation);
  if (!a) return null;
  const { acc, token } = await tokenFor(e.account);
  const f: Flow = { id: e.id, a, s, account: acc.id, token, vars: varsOf(acc, e.from_name), to: { id: psid }, open: true, psid };
  return { a, f, acc, token };
}

/** "I'm following" tapped: check, then go on with the flow, or ask again. */
async function onFollowTap(account: string, from: string, payload: string, s: DmSettings) {
  const m = /^vbdm:(\d{1,18}):([A-Za-z0-9_-]{16})$/.exec(payload);
  if (!m || sign(m[1]) !== m[2]) return;
  const e = await DB.getEvent(Number(m[1]));
  // a commenter's id in comments differs from their id in messages; the signed payload is the claim
  if (!e || e.account !== account || e.awaiting !== "follow" || (e.kind !== "comment" && e.from_id !== from && e.psid !== from)) return;
  const r = await resume(e, s, from);
  if (!r) return;
  const ok = await follows(r.token, from).catch(() => null);
  try {
    if (ok === false) {
      await step(r.f, { text: fill(r.a.follow_gate.not_following || s.defaults.not_following, r.f.vars), buttons: [{ type: "postback", title: r.a.follow_gate.button || s.defaults.gate_button, payload }] });
      await DB.finish(e.id, { status: "gated", following: false, psid: from, note: "Tapped, not following yet" });
    } else {
      const out = await afterFollow(r.f, ok);
      await DB.finish(e.id, { ...out, note: ok === null ? "Instagram didn't say whether they follow: sent anyway" : null });
    }
  } catch (err) {
    await DB.finish(e.id, { status: "failed", error: (err as Error).message });
  }
}

/** A choice button tapped: its reply (and its link, counted). */
async function onChoiceTap(account: string, from: string, payload: string, s: DmSettings) {
  const m = /^vbdc:(\d{1,18}):([0-2]):([A-Za-z0-9_-]{16})$/.exec(payload);
  if (!m || sign(`c${m[1]}:${m[2]}`) !== m[3]) return;
  const e = await DB.getEvent(Number(m[1]));
  if (!e || e.account !== account || e.status !== "sent") return;
  const r = await resume(e, s, from);
  const c = r?.a.choices[Number(m[2])];
  if (!r || !c) return;
  const k = Number(m[2]) + 1;
  try {
    await step(r.f, { text: fill(c.reply, r.f.vars), buttons: c.button?.url ? [{ type: "web_url", title: c.button.label, url: r.a.track ? trackUrl(e.id, k) : c.button.url }] : [] });
    await DB.finish(e.id, { psid: from, note: `Chose "${c.label}"`, reply: `${e.reply ?? ""}\n\n→ ${c.label}: ${fill(c.reply, r.f.vars)}` });
  } catch (err) {
    await DB.finish(e.id, { note: `Choice "${c.label}" not sent: ${(err as Error).message}` });
  }
}

/** An email in a DM from someone an automation asked for one: kept, thanked, and the DM when it was waiting on it. */
async function onEmail(account: string, from: string, text: string, s: DmSettings): Promise<boolean> {
  const email = emailIn(text);
  if (!email) return false;
  const e = await DB.waitingOn(account, from, "email");
  if (!e) return false;
  const r = await resume(e, s, from);
  if (!r) return false;
  await DB.addLead({ account, from_id: e.from_id ?? from, from_name: e.from_name, email, automation: e.automation, automation_name: e.automation_name, event: e.id });
  await (await import("./autodm-more")).synced("lead", { account: r.acc, username: e.from_name, automation: r.a.name, email }).catch(() => null);
  const thanks = fill(r.a.collect.thanks || s.defaults.thanks_email, r.f.vars);
  try {
    if (e.status === "gated") {
      const out = await main(r.f, e.following, thanks);
      await DB.finish(e.id, { ...out, note: `Email: ${email}` });
    } else {
      await step(r.f, { text: thanks });
      await DB.finish(e.id, { awaiting: null, psid: from, note: `Email: ${email}` });
    }
  } catch (err) {
    await DB.finish(e.id, { awaiting: null, note: `Email kept (${email}); the answer failed: ${(err as Error).message}` });
  }
  return true;
}

type Hook = {
  object?: string;
  entry?: {
    id?: string; time?: number;
    changes?: { field?: string; value?: { id?: string; text?: string; parent_id?: string; from?: { id?: string; username?: string }; media?: { id?: string } } }[];
    messaging?: {
      sender?: { id?: string }; recipient?: { id?: string };
      message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; reply_to?: { story?: { id?: string } }; attachments?: { type?: string; payload?: { url?: string } }[] };
      postback?: { mid?: string; title?: string; payload?: string };
    }[];
  }[];
};

/** Everything one webhook delivery holds: comments (comment rules first), messages, story replies, mentions and taps. */
export async function onWebhook(body: Hook) {
  if (body.object !== "instagram" || !Array.isArray(body.entry)) return { handled: 0 };
  const { putJson } = await import("../store");
  await putJson("workspace/publish/autodm/last-event.json", { at: Date.now(), entries: body.entry.length }).catch(() => null);
  let s = await getSettings();
  let evs: Ev[] = [];
  const taps: { account: string; from: string; payload: string }[] = [];
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
      const msg = m.message;
      if (!msg || msg.is_echo || msg.is_deleted || !msg.mid) continue;
      if (msg.attachments?.some((x) => x.type === "story_mention")) { evs.push({ kind: "mention", account, ref: msg.mid, from: { id: m.sender.id }, text: typeof msg.text === "string" ? msg.text : "" }); continue; }
      if (typeof msg.text !== "string") continue;
      evs.push({ kind: msg.reply_to?.story ? "story" : "dm", account, ref: msg.mid, from: { id: m.sender.id }, text: msg.text });
    }
  }
  const more = await import("./autodm-more");
  // comment rules run even with Auto-DM off, and a comment they hide or delete gets nothing else
  if (s.moderation.on && evs.some((e) => e.kind === "comment")) {
    const gone = await more.moderate(evs.filter((e) => e.kind === "comment").slice(0, 50), s).catch((e) => { console.error("autodm rules", (e as Error).message); return new Set<string>(); });
    evs = evs.filter((e) => !(e.kind === "comment" && gone.has(e.ref)));
  }
  if (!s.on || !dmFlag()) return { handled: 0, off: true };
  if (evs.some((e) => e.kind === "comment")) s = await resolvePosts(s);
  for (const ev of evs.slice(0, 50)) {
    try {
      // an email someone was asked for, then the automations, then an AI answer to a follow-up question
      if (ev.kind === "dm" && !s.paused.includes(ev.account) && (await onEmail(ev.account, ev.from.id, ev.text, s))) continue;
      if (ev.kind !== "comment" && ev.kind !== "mention" && !pick(s, ev) && !s.paused.includes(ev.account)) { await more.answerWithAi(ev, s); continue; }
      await handle(ev, s);
    } catch (e) { console.error("autodm", (e as Error).message); }
  }
  for (const t of taps.slice(0, 50)) {
    if (s.paused.includes(t.account)) continue;
    const on = t.payload.startsWith("vbdc:") ? onChoiceTap : onFollowTap;
    await on(t.account, t.from, t.payload, s).catch((e) => console.error("autodm tap", (e as Error).message));
  }
  return { handled: evs.length + taps.length };
}

// ── what the dashboard and the MCP read

/** The setup checklist: the switch, the secrets, each account's permission and subscription. */
export async function status() {
  const accounts = (await listAccounts()).filter((a) => a.network === "instagram");
  const { getJson } = await import("../store");
  const last = await getJson<{ at: number }>("workspace/publish/autodm/last-event.json").catch(() => null);
  const { secretsStatus } = await import("../auto/secrets");
  const keys = await secretsStatus().catch(() => null);
  return {
    flag: dmFlag(), app_secret: !!process.env.INSTAGRAM_APP_SECRET, verify_token: !!process.env.INSTAGRAM_WEBHOOK_TOKEN,
    last_event: last?.at ?? null,
    ai_key: keys ? keys.anthropic.from === "dashboard" || keys.anthropic.from === "vercel" : false,
    ai_key_last4: keys?.anthropic.last4 ?? null,
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

export type IgMedia = { id: string; caption: string; full: string; kind: string; thumb: string | null; url: string | null; at: string | null; comments: number | null };
/** An account's posts and reels, newest first, a page at a time, to choose for an automation. */
export async function recentMedia(id: string, after?: string): Promise<{ media: IgMedia[]; after: string | null }> {
  const { token, acc } = await tokenFor(id);
  const r = await IG.igGet<{ data: { id: string; caption?: string; media_type?: string; media_product_type?: string; thumbnail_url?: string; media_url?: string; permalink?: string; timestamp?: string; comments_count?: number }[]; paging?: { cursors?: { after?: string }; next?: string } }>(
    `/${acc.id}/media`, token, { fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count", limit: "36", after: after && /^[A-Za-z0-9_=-]{1,400}$/.test(after) ? after : undefined });
  return {
    media: r.data.map((m) => ({
      id: m.id, caption: (m.caption ?? "").replace(/\s+/g, " ").slice(0, 140), full: (m.caption ?? "").slice(0, 2200), kind: m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : m.media_type === "VIDEO" ? "video" : "photo",
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

export type Step = { to: string; text: string; buttons: string[] };
/** What one automation sends, step by step, for the tester and the MCP (nothing is sent). */
export function flowSteps(a: Automation, d: DmDefaults, vars: { handle: string; username: string | null }, kind: DB.DmKind = "comment"): Step[] {
  const f = (t: string) => fill(t, vars);
  const out: Step[] = [];
  if (a.follow_gate.on) out.push({ to: "DM", text: f(a.follow_gate.message || d.gate_message), buttons: [a.follow_gate.button || d.gate_button] });
  if (a.collect.on && a.collect.when === "before") out.push({ to: out.length ? "DM, once they follow" : "DM", text: f(a.collect.ask || d.ask_email), buttons: [] });
  const askAfter = a.collect.on && a.collect.when === "after";
  const main = `${a.message}${askAfter && kind === "comment" && !out.length ? `\n\n${a.collect.ask || d.ask_email}` : ""}`;
  out.push({ to: out.length ? (a.collect.on && a.collect.when === "before" ? "DM, once they send their email" : "DM, once they tap and follow") : "DM", text: f(main), buttons: [...(a.button ? [a.button.label] : []), ...a.choices.map((c) => c.label)] });
  if (a.ab.on && a.ab.message) out.push({ to: "Or version B (half of people until one wins)", text: f(a.ab.message), buttons: [...(a.button ? [a.ab.button_label || a.button.label] : []), ...a.choices.map((c) => c.label)] });
  for (const c of a.choices) out.push({ to: `If they tap "${c.label}"`, text: f(c.reply), buttons: c.button ? [c.button.label] : [] });
  if (kind === "comment" && a.public_replies.length) out.push({ to: "Public answer", text: f(a.public_replies[0]), buttons: [] });
  return out;
}

/** A dry run: which automation a comment (or DM) would trigger and what would go out. Nothing is sent. */
export async function test(text: string, opts: { account?: string | null; media?: string | null; kind?: DB.DmKind; automation?: Record<string, unknown> } = {}) {
  const s = await getSettings();
  const accounts = (await listAccounts()).filter((a) => a.network === "instagram");
  const account = opts.account && IGID.test(opts.account) ? opts.account : accounts[0]?.id ?? "0";
  const handle = accounts.find((a) => a.id === account)?.handle ?? "you";
  const kind = opts.kind ?? "comment";
  // testing an automation as it's being edited: just that one, switched on
  const list = opts.automation ? [{ ...cleanAutomation(opts.automation), on: true }] : s.automations;
  const hit = pick({ automations: list, paused: [] }, { account, media: opts.media ?? null, text, kind }, !opts.automation);
  if (!hit) return { automation: null, keyword: null, steps: [], note: "No automation answers that." };
  const a = hit.automation;
  return {
    automation: { id: a.id, name: a.name }, keyword: hit.keyword, steps: flowSteps(a, s.defaults, { handle, username: "them" }, kind),
    note: `${s.on && dmFlag() ? (s.paused.includes(account) ? "This account is paused." : "This would be sent.") : "This would be sent once Auto-DM is switched on."}`,
  };
}

export { activity, contacts, leads } from "./dmstore";
