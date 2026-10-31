// Publish plans (one per post × space) and the studio's automation rules, in R2: workspace/publish/plans/<post>--<space>.json
// and workspace/publish/rules.json. One file per plan, so the runner and a person editing another post never collide.
import { getJson, listObjs, putJson, delObjs } from "../store";
import { spaceOf, type SpaceId } from "../spaces";
import { DEFAULT_RULES, LIMITS, networkOf, type IgOptions, type Plan, type Rules, type YtOptions } from "./shared";

const DIR = "workspace/publish/plans/";
const RULES = "workspace/publish/rules.json";
const keyOf = (post: string, space: string) => `${DIR}${post}--${space}.json`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function getPlan(post: string, space: string) {
  if (!ID.test(post) || !spaceOf(space)) return null;
  return getJson<Plan>(keyOf(post, space)).catch(() => null);
}
export async function putPlan(p: Plan) {
  p.updated = Date.now();
  p.log = p.log.slice(-60);
  await putJson(keyOf(p.post, p.space), p);
  return p;
}
export async function dropPlan(post: string, space: string) {
  await delObjs([keyOf(post, space)]);
}
export async function dropPlansOf(post: string) {
  const objs = await listObjs(`${DIR}${post}--`).catch(() => []);
  if (objs.length) await delObjs(objs.map((o) => o.key));
}
export async function listPlans(): Promise<Plan[]> {
  const objs = await listObjs(DIR).catch(() => []);
  const out: Plan[] = [];
  for (let i = 0; i < objs.length; i += 24) {
    const got = await Promise.all(objs.slice(i, i + 24).map((o) => getJson<Plan>(o.key).catch(() => null)));
    out.push(...(got.filter(Boolean) as Plan[]));
  }
  return out;
}

export async function getRules(): Promise<Rules> {
  const r = await getJson<Partial<Rules>>(RULES).catch(() => null);
  // rules saved with a missing or repeated id (the text "undefined") read with stable ones, so each slot can be removed
  const fix = <T extends { id: string }>(xs: T[] | undefined, pre: string) => { const seen = new Set<string>();
    return (xs ?? []).map((x, i) => { const id = x.id && x.id !== "undefined" && !seen.has(x.id) ? x.id : `${pre}${i}`; seen.add(id); return { ...x, id }; }); };
  const base = { ...DEFAULT_RULES, ...(r ?? {}) };
  return { ...base, slots: fix(base.slots, "s"), crosspost: fix(base.crosspost, "c"), yt_defaults: { ...DEFAULT_RULES.yt_defaults, ...(r?.yt_defaults ?? {}) }, footer: { ...(r?.footer ?? {}) } };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const list = (v: unknown, max: number, each: number) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim().replace(/^[@#]/, "").slice(0, each)).filter(Boolean).slice(0, max);
const rid = () => Math.random().toString(36).slice(2, 10);
const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz.length < 64; } catch { return false; } };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function setRules(given: Partial<Rules>): Promise<Rules> {
  const cur = await getRules();
  const g = given ?? {};
  const sp = (v: unknown) => (spaceOf(String(v)) ? (String(v) as SpaceId) : null);
  // an id kept as it was, unless it's missing, the leftover text "undefined", or one already used in this list
  const seen = new Set<string>();
  const idOf = (v: unknown) => { const id = typeof v === "string" && v !== "undefined" && ID.test(v) && !seen.has(v) ? v : rid(); seen.add(id); return id; };
  const next: Rules = {
    autopilot: bool(g.autopilot, cur.autopilot),
    retries: typeof g.retries === "number" ? Math.max(0, Math.min(8, Math.round(g.retries))) : cur.retries,
    mark_posted: bool(g.mark_posted, cur.mark_posted),
    notify: bool(g.notify, cur.notify),
    tz: typeof g.tz === "string" && validTz(g.tz) ? g.tz : cur.tz,
    crosspost: Array.isArray(g.crosspost)
      ? g.crosspost.slice(0, 20).flatMap((c) => { const from = sp(c?.from), to = sp(c?.to); return from && to && from !== to ? [{ id: idOf(c.id), from, to, hours: Math.max(0, Math.min(168, Number(c.hours) || 0)), on: bool(c.on, true) }] : []; })
      : cur.crosspost,
    slots: Array.isArray(g.slots)
      ? g.slots.slice(0, 60).flatMap((s) => { const space = sp(s?.space); return space && TIME.test(String(s.time)) && Number(s.day) >= 0 && Number(s.day) <= 6 ? [{ id: idOf(s.id), space, day: Number(s.day), time: String(s.time) }] : []; })
      : cur.slots,
    footer: g.footer && typeof g.footer === "object"
      ? Object.fromEntries(Object.entries(g.footer).flatMap(([k, v]) => (spaceOf(k) && typeof v === "string" && v.trim() ? [[k, v.slice(0, 1000)]] : [])))
      : cur.footer,
    first_comment: g.first_comment !== undefined ? str(g.first_comment, LIMITS.ig_comment) : cur.first_comment,
    yt_defaults: g.yt_defaults ? { ...cur.yt_defaults, ...cleanYt({ ...cur.yt_defaults, title: "x", description: "", ...g.yt_defaults }, cur.yt_defaults), tags: list(g.yt_defaults.tags ?? cur.yt_defaults.tags, 40, 60) } : cur.yt_defaults,
  };
  await putJson(RULES, next);
  return next;
}

function cleanYt(v: Partial<YtOptions>, d: Partial<YtOptions> = {}): YtOptions {
  const privacy = ["public", "unlisted", "private"].includes(String(v.privacy)) ? (v.privacy as YtOptions["privacy"]) : (d.privacy ?? "public");
  const rec = typeof v.recording_date === "string" && !Number.isNaN(Date.parse(v.recording_date)) ? new Date(v.recording_date).toISOString() : null;
  return {
    title: str(v.title, LIMITS.yt_title).replace(/[<>]/g, ""), description: str(v.description, LIMITS.yt_description).replace(/[<>]/g, ""),
    tags: list(v.tags, 60, 100), category: /^\d{1,3}$/.test(String(v.category)) ? String(v.category) : (d.category ?? "28"), privacy,
    youtube_schedules: bool(v.youtube_schedules, d.youtube_schedules ?? true), made_for_kids: bool(v.made_for_kids, d.made_for_kids ?? false),
    synthetic: bool(v.synthetic, d.synthetic ?? false), license: v.license === "creativeCommon" ? "creativeCommon" : "youtube",
    embeddable: bool(v.embeddable, true), public_stats: bool(v.public_stats, true), notify: bool(v.notify, d.notify ?? true),
    playlist: typeof v.playlist === "string" && /^[A-Za-z0-9_-]{2,64}$/.test(v.playlist) ? v.playlist : (v.playlist === null ? null : d.playlist ?? null),
    language: typeof v.language === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(v.language) ? v.language : null, recording_date: rec,
  };
}

function cleanIg(v: Partial<IgOptions>): IgOptions {
  return {
    caption: str(v.caption, LIMITS.ig_caption + 200), share_to_feed: bool(v.share_to_feed, true),
    collaborators: list(v.collaborators, LIMITS.ig_collaborators, 30), user_tags: list(v.user_tags, 20, 30),
    location_id: typeof v.location_id === "string" && /^\d{3,30}$/.test(v.location_id) ? v.location_id : null,
    audio_name: str(v.audio_name, 100).trim() || null, trial: v.trial === "MANUAL" || v.trial === "SS_PERFORMANCE" ? v.trial : null,
    thumb_offset_ms: typeof v.thumb_offset_ms === "number" && v.thumb_offset_ms >= 0 ? Math.round(v.thumb_offset_ms) : null,
    alt_text: str(v.alt_text, 1000).trim() || null, ai_generated: bool(v.ai_generated, false), first_comment: str(v.first_comment, LIMITS.ig_comment).trim() || null,
    story_style: v.story_style === "fit" || v.story_style === "fill" ? v.story_style : "card",
  };
}

const MEDIA_REF = /^(m|j):[A-Za-z0-9_-]{1,64}$/;

/** Merge an edit into a plan (or start one). Only fields a person may set; state stays with the runner. */
export function editPlan(cur: Plan | null, post: string, space: SpaceId, given: Record<string, unknown>, by: string, rules: Rules, seed: { title: string; caption: string }): Plan {
  const network = networkOf(space);
  if (!network) throw new Error(`Voicebox can't post to ${space} by itself yet`);
  const base: Plan = cur ?? {
    post, space, network, account: null, media: [], cover: null, when: "scheduled", state: "draft", progress: 0, step: null, error: null,
    attempts: 0, next_try: null, run: null, result: null, log: [], updated: Date.now(), by,
    ...(network === "youtube"
      ? { yt: cleanYt({ ...rules.yt_defaults, title: seed.title, description: [seed.caption, rules.footer[space]].filter(Boolean).join("\n\n") }, rules.yt_defaults) }
      : { ig: cleanIg({ caption: [seed.caption, rules.footer[space]].filter(Boolean).join("\n\n"), share_to_feed: true, first_comment: rules.first_comment || null }) }),
  };
  const p: Plan = { ...base, by };
  if ("account" in given) p.account = typeof given.account === "string" && ID.test(given.account) ? given.account : null;
  if ("media" in given) p.media = (Array.isArray(given.media) ? given.media : []).map(String).filter((m) => MEDIA_REF.test(m)).slice(0, LIMITS.ig_carousel);
  if ("cover" in given) p.cover = typeof given.cover === "string" && /^m:[A-Za-z0-9_-]{1,64}$/.test(given.cover) ? given.cover : null;
  if (given.when === "now" || given.when === "scheduled") p.when = given.when;
  if (network === "youtube" && given.yt && typeof given.yt === "object") p.yt = cleanYt({ ...p.yt, ...(given.yt as object) }, p.yt);
  if (network === "instagram" && given.ig && typeof given.ig === "object") p.ig = cleanIg({ ...p.ig, ...(given.ig as object) });
  return p;
}
