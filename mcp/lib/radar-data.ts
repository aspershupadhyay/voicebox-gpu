// Radar on the server: reads the free sources (lib/radar-sources.ts), keeps them in R2 so a keyword costs nothing the
// second time that day, scores them against your own numbers (lib/radar.ts, the Writing room's data) and keeps the
// watchlist, its history and every prediction with what actually happened. Files under workspace/radar/:
//   config.json        your seeds (the lane the sweep watches) and the countries it reads
//   kw/<key>.json      one keyword's raw signals, 6 hours
//   sweep.json         the last sweep, 20 minutes
//   watch.json         keywords you follow, each with its scores over time
//   preds.json         every prediction made for a post or a watched keyword, settled against the post once it's out
import { createHash } from "node:crypto";
import { getJson, getJsonTagged, putJson, putJsonIf } from "./store";
import { gather, sweepSignals } from "./radar-sources";
import { norm, record, research, settle, strength, sweep, type Pred, type Research, type Signals, type Sweep, type SweepSignal } from "./radar";
import { titleModel, topicWords, type TitleModel } from "./writing";
import type { Fmt } from "./analytics";

const DIR = "workspace/radar";
const KW_TTL = 6 * 3600_000, SWEEP_TTL = 20 * 60_000, WATCH_TTL = 24 * 3600_000;
export const GEOS = ["US", "IN", "GB", "CA", "AU", "DE", "FR", "BR", "ID", "PH", "NG", "PK", "AE", "SG"] as const;

export type RadarConfig = { seeds: string[]; geos: string[] };
export type Watch = { q: string; added: number; by: string; fmt?: Fmt | null; history: { at: number; opp: number; d: number; m: number; c: number; f: number; x: number }[] };

const keyOf = (q: string, geo: string) => createHash("sha1").update(`${norm(q)}|${geo}`).digest("hex").slice(0, 20);
export const cleanQ = (q: string) => q.replace(/\s+/g, " ").trim().slice(0, 80);

/** Your lane, until you set one: the words of your hits and your rivals' hits, else an AI-creator starter set. */
export async function getConfig(me?: Me | null): Promise<RadarConfig & { auto: boolean }> {
  const c = await getJson<RadarConfig>(`${DIR}/config.json`).catch(() => null);
  if (c?.seeds?.length) return { seeds: c.seeds, geos: c.geos?.length ? c.geos : ["US", "IN"], auto: false };
  const m = me ?? await mine().catch(() => null);
  const words = [...(m?.model?.words ?? []).map((w) => w.word), ...rivalWords(m)].slice(0, 8);
  return { seeds: words.length >= 3 ? words : ["AI agents", "ChatGPT", "Claude", "AI tools", "automation", "OpenAI"], geos: c?.geos?.length ? c.geos : ["US", "IN"], auto: true };
}
export async function setConfig(p: Partial<RadarConfig>) {
  const have = await getJson<RadarConfig>(`${DIR}/config.json`).catch(() => null);
  const seeds = p.seeds ? [...new Set(p.seeds.map(cleanQ).filter(Boolean))].slice(0, 16) : have?.seeds ?? [];
  const geos = p.geos ? [...new Set(p.geos.map((g) => g.toUpperCase()).filter((g) => /^[A-Z]{2}$/.test(g)))].slice(0, 4) : have?.geos ?? ["US", "IN"];
  await putJson(`${DIR}/config.json`, { seeds, geos });
  await putJson(`${DIR}/sweep.json`, null).catch(() => null); // the lane changed: the next sweep reads afresh
  return getConfig();
}

/* ───────────── your numbers (the Writing room's) */

type Me = Awaited<ReturnType<typeof mine>>;
async function mine() {
  const d = await (await import("./writing-data")).writingData();
  return { items: d.items, rivals: d.rivals, model: titleModel(d.items) as TitleModel | null, needs: d.needs };
}
function rivalWords(m: Me | null) {
  const n = new Map<string, number>();
  for (const r of m?.rivals ?? []) if (r.x != null && r.x >= 1.5) for (const w of topicWords(r.title)) n.set(w, (n.get(w) ?? 0) + 1);
  return [...n].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

/* ───────────── one keyword */

async function signals(q: string, geo: string, o: { deep?: boolean; fresh?: boolean; geos?: string[] }): Promise<Signals & { cached?: boolean }> {
  const key = `${DIR}/kw/${keyOf(q, geo)}${o.deep ? "-deep" : ""}.json`;
  const have = await getJson<Signals>(key).catch(() => null);
  if (have && !o.fresh && Date.now() - have.at < KW_TTL) return { ...have, cached: true };
  // a deep read from earlier today serves a plain request too
  if (!o.deep && !o.fresh) { const deep = await getJson<Signals>(`${DIR}/kw/${keyOf(q, geo)}-deep.json`).catch(() => null); if (deep && Date.now() - deep.at < KW_TTL) return { ...deep, cached: true }; }
  const s = await gather(q, { geo, deep: o.deep, geos: o.geos });
  const answered = s.sources.filter((x) => x.ok).length;
  if (answered >= 3) await putJson(key, s).catch(() => null);
  else if (have) return { ...have, cached: true, sources: s.sources }; // nearly everything failed: yesterday's read beats nothing
  return s;
}

export type KwResult = Research & { cached: boolean; needs: string[]; record: ReturnType<typeof record> };

/** Everything about one keyword (keyword_research and the Keyword view). */
export async function keyword(qRaw: string, o: { geo?: string; fmt?: Fmt | null; deep?: boolean; fresh?: boolean; me?: Me } = {}): Promise<KwResult> {
  const q = cleanQ(qRaw);
  if (q.length < 2) throw new Error("give a keyword of at least 2 characters");
  const [cfg, me, preds] = await Promise.all([getConfig(), o.me ?? mine().catch(() => ({ items: [], rivals: [], model: null, needs: ["Your analytics couldn't be read, so fit and the prediction use general rules."] })), loadPreds()]);
  const geo = (o.geo ?? cfg.geos[0] ?? "US").toUpperCase();
  const s = await signals(q, geo, { deep: o.deep, fresh: o.fresh, geos: cfg.geos });
  const settled = settle(preds, me.items);
  const rec = record(settled);
  const r = research(s, { items: me.items, rivals: me.rivals, model: me.model, fmt: o.fmt ?? null, calib: rec.calib });
  return { ...r, cached: !!s.cached, needs: me.needs, record: rec };
}

/** Several keywords side by side, best first. */
export async function compare(qs: string[], o: { geo?: string; fmt?: Fmt | null } = {}) {
  const me = await mine().catch(() => undefined);
  const rs = await Promise.all(qs.slice(0, 5).map((q) => keyword(q, { ...o, me }).catch((e: Error) => ({ q, error: e.message }))));
  return rs.sort((a, b) => ("opportunity" in b ? b.opportunity : -1) - ("opportunity" in a ? a.opportunity : -1));
}

/* ───────────── the sweep */

export async function getSweep(fresh = false): Promise<Sweep & { cached: boolean; auto_seeds: boolean }> {
  const have = await getJson<Sweep | null>(`${DIR}/sweep.json`).catch(() => null);
  const me = await mine().catch(() => null);
  const cfg = await getConfig(me);
  if (have && !fresh && Date.now() - have.at < SWEEP_TTL) return { ...have, cached: true, auto_seeds: cfg.auto };
  const D = 86_400_000;
  const rivals: SweepSignal[] = (me?.rivals ?? []).filter((r) => r.x != null && r.x >= 1.5 && Date.now() - r.at < 10 * D)
    .map((r) => ({ src: "rival", title: r.title, url: r.url, at: r.at, w: strength.rival(r.x!), metric: `${r.name}: ${r.x! >= 10 ? Math.round(r.x!) : r.x!.toFixed(1)}× their usual` }));
  const { signals: sig, sources } = await sweepSignals(cfg.seeds, cfg.geos, rivals);
  const lane = [...cfg.seeds, ...(me?.model?.words ?? []).map((w) => w.word), ...rivalWords(me)];
  const sw = sweep(sig, lane, { seeds: cfg.seeds, geos: cfg.geos, sources });
  if (sources.filter((x) => x.ok).length >= 2) await putJson(`${DIR}/sweep.json`, sw).catch(() => null);
  else if (have) return { ...have, cached: true, auto_seeds: cfg.auto, sources };
  return { ...sw, cached: false, auto_seeds: cfg.auto };
}

/* ───────────── the watchlist */

async function edit<T>(key: string, f: (v: T | null) => T): Promise<T> {
  for (let i = 0; i < 4; i++) {
    const { value, etag } = await getJsonTagged<T>(key);
    const next = f(value);
    if (await putJsonIf(key, next, etag)) return next;
  }
  throw new Error("Radar is busy: try again");
}

export const loadWatch = async () => (await getJson<Watch[]>(`${DIR}/watch.json`).catch(() => null)) ?? [];
const point = (r: Research) => ({ at: r.at, opp: r.opportunity, d: r.demand.score, m: r.momentum.score, c: r.competition.score, f: r.fit.score, x: r.prediction.x });

export async function watch(qRaw: string, by: string, fmt?: Fmt | null) {
  const q = cleanQ(qRaw);
  const r = await keyword(q, { fmt });
  await edit<Watch[]>(`${DIR}/watch.json`, (w) => {
    const list = w ?? [];
    const have = list.find((x) => norm(x.q) === norm(q));
    if (have) { if (!have.history.some((h) => h.at === r.at)) have.history.push(point(r)); return list; }
    if (list.length >= 40) throw new Error("The watchlist holds 40 keywords: remove one first");
    return [...list, { q, added: Date.now(), by, fmt: fmt ?? null, history: [point(r)] }];
  });
  await predictFor(r, null, by);
  return r;
}
export async function unwatch(q: string) {
  return edit<Watch[]>(`${DIR}/watch.json`, (w) => (w ?? []).filter((x) => norm(x.q) !== norm(q)));
}

/** Re-read the watched keywords whose last point is over a day old (a few at a time, so it stays light). */
export async function refreshWatch(limit = 2) {
  const list = await loadWatch();
  const due = list.filter((w) => Date.now() - (w.history.at(-1)?.at ?? 0) > WATCH_TTL).slice(0, limit);
  if (!due.length) return 0;
  const me = await mine().catch(() => undefined);
  const rs = await Promise.all(due.map((w) => keyword(w.q, { fmt: w.fmt ?? null, me }).catch(() => null)));
  await edit<Watch[]>(`${DIR}/watch.json`, (cur) => (cur ?? []).map((w) => {
    const r = rs.find((x) => x && norm(x.q) === norm(w.q));
    if (r && !w.history.some((h) => h.at === r.at)) w.history = [...w.history, point(r)].slice(-120);
    return w;
  }));
  return rs.filter(Boolean).length;
}

/* ───────────── predictions and the track record */

export const loadPreds = async () => (await getJson<Pred[]>(`${DIR}/preds.json`).catch(() => null)) ?? [];

/** Keep a prediction to judge later: one per keyword and post (or per keyword a week, for a watched keyword). */
export async function predictFor(r: Research, postId: string | null, by: string) {
  const p: Pred = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, q: r.q, at: Date.now(), fmt: r.fmt, x: r.prediction.x, hit_chance: r.prediction.hit_chance, opp: r.opportunity, post_id: postId, by };
  await edit<Pred[]>(`${DIR}/preds.json`, (cur) => {
    const list = cur ?? [];
    const dup = list.find((x) => !x.actual && norm(x.q) === norm(p.q) && x.fmt === p.fmt && (postId ? x.post_id === postId : !x.post_id && Date.now() - x.at < 7 * 86_400_000));
    if (dup) { Object.assign(dup, { x: p.x, hit_chance: p.hit_chance, opp: p.opp, at: dup.post_id ? dup.at : p.at }); return list; }
    return [...list, p].slice(-400);
  });
  return p;
}

/** The track record, with any predictions that have now played out written back. */
export async function trackRecord(me?: Me) {
  const [preds, m] = await Promise.all([loadPreds(), me ? Promise.resolve(me) : mine().catch(() => null)]);
  const settled = settle(preds, m?.items ?? []);
  if (settled.some((p, i) => p.actual && !preds[i].actual)) await edit<Pred[]>(`${DIR}/preds.json`, (cur) => (cur ?? []).map((p) => settled.find((s) => s.id === p.id && s.actual) ?? p)).catch(() => null);
  return record(settled);
}

/** The Radar page in one answer: the sweep, the watchlist, the track record and the lane. */
export async function overview(fresh = false) {
  const me = await mine().catch(() => null);
  const [sw, watchList, rec, cfg] = await Promise.all([getSweep(fresh), loadWatch(), trackRecord(me ?? undefined), getConfig(me)]);
  return { sweep: sw, watch: watchList, record: rec, config: cfg, needs: me?.needs ?? ["Your analytics couldn't be read: fit and predictions use general rules."] };
}
