// Radar's rules (Grow → Radar and the radar, keyword_research, seo_score and radar_watch MCP tools): what people are
// searching for, how fast it's moving, how crowded it is and how well it suits you, read from free public signals
// (lib/radar-sources.ts) and your own numbers, then scored with plain rules you can read below. No AI model and no
// guesswork dressed up as data: every score says what it's made of, which sources answered, and how sure it is; the
// prediction is your own usual views moved by what the evidence says, and its track record is kept and shown, so you
// can see whether to trust it. Pure and browser-safe (the page and the server share it).
import type { Fmt } from "./analytics";
import { HIT, scoreTitle, STOP, topicWords, type TitleModel, type WItem, type WRival } from "./writing";

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** log10 of v placed between lo and hi (both log10), 0 to 1 */
const logPart = (v: number | null | undefined, lo: number, hi: number) => (v == null || v <= 0 ? 0 : clamp((Math.log10(v) - lo) / (hi - lo), 0, 1));
/** a ratio of now to before as 0-100, 50 = steady, 75 = doubled, 100 = four times, 25 = halved */
const ratioPart = (r: number) => clamp(50 + 25 * Math.log2(Math.max(r, 1 / 16)), 0, 100);
const D = 86_400_000;
export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s+#.'-]/gu, " ").replace(/\s+/g, " ").trim();

/* ───────────── what the sources bring back (lib/radar-sources.ts fills these) */

export type SrcId = "yt_suggest" | "google_suggest" | "bing_suggest" | "ddg_suggest" | "youtube" | "youtube_api" | "news" | "hn" | "wiki" | "trends" | "yours";
export const SRC_NAME: Record<SrcId, string> = {
  yt_suggest: "YouTube autocomplete", google_suggest: "Google autocomplete", bing_suggest: "Bing autocomplete", ddg_suggest: "DuckDuckGo autocomplete",
  youtube: "YouTube search", youtube_api: "YouTube Data API", news: "Google News", hn: "Hacker News", wiki: "Wikipedia pageviews", trends: "Google Trends", yours: "Your analytics",
};
export type SrcState = { id: SrcId; ok: boolean; ms: number; note?: string };

export type YtHit = { id: string; title: string; channel: string; channel_id: string | null; views: number | null; age_days: number | null; secs: number | null; subs?: number | null };
export type NewsHit = { title: string; url: string; source: string; at: number };
export type HnHit = { title: string; url: string; points: number; comments: number; at: number };

export type Signals = {
  q: string; geo: string; at: number;
  /** what each autocomplete offers for the keyword itself (popular searches come first, and a busy topic fills all 10) */
  suggest: { yt: string[]; google: string[]; bing: string[]; ddg: string[] };
  /** where the keyword sits when only its start is typed (0 = the first thing offered; null = not offered) */
  prefix_rank: number | null;
  /** long-tail searches found by expanding the keyword (questions, modifiers, a-z) on YouTube's autocomplete */
  expand: string[];
  youtube: { total: number | null; top: YtHit[]; month: YtHit[] } | null;
  news: { n7: number; n30: number; span: number; items: NewsHit[] } | null;
  hn: { n7: number; n30: number; top: HnHit[] } | null;
  wiki: { article: string; daily: number[] } | null;
  trends: { title: string; traffic: string; geo: string }[];
  sources: SrcState[];
};

/* ───────────── the four scores */

export type Part = { label: string; value: string; weight: number; score: number };
export type Score = { score: number; parts: Part[]; /** how much of this score had data behind it, 0 to 1 */ cover: number; line: string };

function blend(parts: (Part & { has: boolean })[], fallback = 50): Score {
  const live = parts.filter((p) => p.has);
  const w = live.reduce((s, p) => s + p.weight, 0), all = parts.reduce((s, p) => s + p.weight, 0);
  const score = w ? Math.round(live.reduce((s, p) => s + p.score * p.weight, 0) / w) : fallback;
  return { score, parts: live.map(({ has: _, ...p }) => p), cover: all ? w / all : 0, line: "" };
}
const vpd = (h: YtHit) => (h.views != null && h.age_days != null ? h.views / Math.max(1, h.age_days) : null);
const words = (s: string) => norm(s).split(" ").filter((w) => w && !STOP.has(w));
/** every one of the keyword's own words is in the text */
export const covers = (text: string, q: string) => { const t = ` ${norm(text)} `; return words(q).every((w) => t.includes(` ${w} `) || t.includes(` ${w}s `)); };

/** How much people search for it: autocomplete depth and rank, the views YouTube's top results earn per day, and
 *  Wikipedia's daily readers. */
export function demand(s: Signals): Score {
  const sug = s.suggest;
  const fill = (xs: string[]) => Math.min(xs.length, 10) / 10;
  const vs = (s.youtube?.top ?? []).slice(0, 10).map(vpd).filter((v): v is number => v != null);
  const mv = median(vs);
  const month = (s.youtube?.month ?? []).slice(0, 10).map((h) => h.views ?? 0);
  const mm = median(month);
  const wd = s.wiki?.daily.length ? median(s.wiki.daily.slice(-28)) : null;
  const r = blend([
    { label: "Autocomplete depth", value: `YouTube ${sug.yt.length}, Google ${sug.google.length}, Bing ${sug.bing.length} of 10`, weight: 15, score: Math.round(100 * (0.55 * fill(sug.yt) + 0.25 * fill(sug.google) + 0.2 * fill(sug.bing))), has: sug.yt.length + sug.google.length + sug.bing.length > 0 || s.sources.some((x) => x.id === "yt_suggest" && x.ok) },
    { label: "Autocomplete rank", value: s.prefix_rank == null ? "not offered while typing" : `#${s.prefix_rank + 1} while typing`, weight: 15, score: s.prefix_rank == null ? 10 : Math.round(100 - s.prefix_rank * 9), has: s.sources.some((x) => x.id === "yt_suggest" && x.ok) },
    { label: "Long-tail searches", value: `${s.expand.length} found`, weight: 10, score: Math.round(100 * Math.min(1, s.expand.length / 60)), has: s.sources.some((x) => x.id === "yt_suggest" && x.ok) },
    { label: "Views a day, top results", value: mv == null ? "—" : `${Math.round(mv).toLocaleString("en")} median`, weight: 35, score: Math.round(100 * logPart(mv, 1, 5.3)), has: mv != null },
    { label: "Views, this month's uploads", value: mm == null ? "—" : `${Math.round(mm).toLocaleString("en")} median`, weight: 10, score: Math.round(100 * logPart(mm, 2, 6)), has: mm != null && month.length >= 3 },
    { label: "Wikipedia readers a day", value: wd == null ? "—" : `${Math.round(wd).toLocaleString("en")} (${s.wiki!.article.replace(/_/g, " ")})`, weight: 15, score: Math.round(100 * logPart(wd, 1, 5)), has: wd != null },
  ], 0);
  r.line = r.score >= 70 ? "Lots of people look for this" : r.score >= 45 ? "A healthy number of searches" : r.score >= 25 ? "A niche: few searches, but they're specific" : "Very few people search for this";
  return r;
}

/** Is it rising: news and Hacker News this week against the three weeks before, Wikipedia readers this week against
 *  the four before, how fast this month's uploads pull views next to older ones, and Google's trending searches. */
export function momentum(s: Signals): Score {
  const rate = (n7: number, n30: number, span = 30) => { const before = Math.max(0.5, (n30 - n7) / Math.max(1, span - 7)); return (n7 / 7) / before; };
  const w = s.wiki?.daily ?? [];
  const wk = w.length >= 35 ? (w.slice(-7).reduce((a, b) => a + b, 0) / 7) / Math.max(1, w.slice(-35, -7).reduce((a, b) => a + b, 0) / 28) : null;
  const fresh = (s.youtube?.month ?? []).map(vpd).filter((v): v is number => v != null);
  const old = (s.youtube?.top ?? []).filter((h) => (h.age_days ?? 0) > 60).map(vpd).filter((v): v is number => v != null);
  const yr = fresh.length >= 3 && old.length >= 3 ? median(fresh)! / Math.max(1, median(old)!) : null;
  const tr = s.trends.find((t) => covers(t.title, s.q) || covers(s.q, t.title));
  const r = blend([
    { label: "News this week", value: s.news ? `${s.news.n7} stories (${s.news.n30} in 30 days)` : "—", weight: 25, score: s.news ? Math.round(ratioPart(rate(s.news.n7, s.news.n30, s.news.span))) : 50, has: !!s.news && s.news.n30 >= 3 },
    { label: "Hacker News this week", value: s.hn ? `${s.hn.n7} posts (${s.hn.n30} in 30 days)` : "—", weight: 15, score: s.hn ? Math.round(ratioPart(rate(s.hn.n7, s.hn.n30))) : 50, has: !!s.hn && s.hn.n30 >= 3 },
    { label: "Wikipedia readers this week", value: wk == null ? "—" : `${wk >= 1 ? "+" : ""}${Math.round((wk - 1) * 100)}% on the month`, weight: 25, score: wk == null ? 50 : Math.round(ratioPart(wk)), has: wk != null },
    { label: "New uploads' pull", value: yr == null ? "—" : `${yr >= 10 ? Math.round(yr) : yr.toFixed(1)}× the views a day of older ones`, weight: 25, score: yr == null ? 50 : Math.round(ratioPart(yr)), has: yr != null },
    { label: "Google trending searches", value: tr ? `trending in ${tr.geo} (${tr.traffic})` : "not trending today", weight: 10, score: tr ? 100 : 45, has: s.sources.some((x) => x.id === "trends" && x.ok) },
  ]);
  r.line = r.score >= 70 ? "Rising fast: post soon" : r.score >= 56 ? "Picking up" : r.score >= 44 ? "Steady" : r.score >= 30 ? "Cooling off" : "Fading";
  return r;
}

/** How crowded it is (higher is harder): how many videos YouTube has, how many of the top results already target the
 *  exact words, how big the channels at the top are, and how fresh the top results are (old results are an opening). */
export function competition(s: Signals): Score {
  const top = (s.youtube?.top ?? []).slice(0, 20);
  const exact = top.length ? top.filter((h) => covers(h.title, s.q)).length / top.length : null;
  const subs = top.slice(0, 10).map((h) => h.subs).filter((v): v is number => v != null);
  const ms = median(subs);
  const mv = median(top.slice(0, 10).map((h) => h.views ?? 0));
  const stale = top.slice(0, 10).filter((h) => h.age_days != null);
  const old = stale.length ? stale.filter((h) => h.age_days! > 365).length / stale.length : null;
  const r = blend([
    { label: "Videos on YouTube", value: s.youtube?.total == null ? "—" : `about ${s.youtube.total.toLocaleString("en")}`, weight: 15, score: Math.round(100 * logPart(s.youtube?.total, 3, 8.5)), has: s.youtube?.total != null },
    { label: "Top results aimed at it", value: exact == null ? "—" : `${Math.round(exact * 100)}% of the top ${top.length} use every word`, weight: 30, score: Math.round(100 * (exact ?? 0)), has: exact != null },
    ms != null
      ? { label: "Size of the channels on top", value: `${Math.round(ms).toLocaleString("en")} subscribers (median)`, weight: 35, score: Math.round(100 * logPart(ms, 3, 7)), has: subs.length >= 3 }
      : { label: "Views of the top results", value: mv == null ? "—" : `${Math.round(mv).toLocaleString("en")} (median)`, weight: 35, score: Math.round(100 * logPart(mv, 3, 7)), has: mv != null && top.length >= 3 },
    { label: "Fresh top results", value: old == null ? "—" : `${Math.round(old * 100)}% of the top 10 are over a year old`, weight: 20, score: Math.round(100 * (1 - (old ?? 0))), has: old != null },
  ]);
  r.line = r.score >= 70 ? "Crowded: big channels already own it" : r.score >= 50 ? "Contested: you need a sharper angle" : r.score >= 30 ? "Open: room for a new video" : "Wide open";
  return r;
}

/** How well it suits you: your own posts on these words (against your usual), your hits' words, and your rivals' hits. */
export function fit(q: string, related: string[], me: { items: WItem[]; rivals: WRival[]; model: TitleModel | null }): Score & { history: { n: number; x: number | null; titles: { title: string; score: number | null; url: string }[] } } {
  const kw = new Set(topicWords(q));
  const near = new Set([...kw, ...related.flatMap((r) => topicWords(r)).slice(0, 40)]);
  const mine = me.items.filter((i) => topicWords(i.title).some((w) => kw.has(w)));
  const scored = mine.filter((i) => i.score != null && i.score > 0);
  const gm = scored.length ? Math.exp(scored.reduce((s, i) => s + Math.log(i.score!), 0) / scored.length) : null;
  const hitWords = (me.model?.words ?? []).filter((w) => near.has(w.word));
  const rivalHits = me.rivals.filter((r) => r.x != null && r.x >= HIT && topicWords(r.title).some((w) => kw.has(w)));
  const r = blend([
    { label: "Your posts on it", value: scored.length ? `${scored.length} post${scored.length === 1 ? "" : "s"}, ${gm! >= 10 ? Math.round(gm!) : gm!.toFixed(1)}× your usual` : "none yet", weight: 45, score: gm == null ? 50 : Math.round(clamp(50 + 30 * Math.log2(gm))), has: scored.length > 0 },
    { label: "Your hits' words", value: hitWords.length ? hitWords.slice(0, 4).map((w) => w.word).join(", ") : "none shared", weight: 30, score: Math.min(100, 35 + hitWords.length * 22), has: !!me.model && me.model.words.length > 0 },
    { label: "Your rivals' hits", value: rivalHits.length ? `${rivalHits.length} hit${rivalHits.length === 1 ? "" : "s"} (${rivalHits[0].name})` : "none on it", weight: 25, score: Math.min(100, 40 + rivalHits.length * 20), has: me.rivals.length > 0 },
  ]);
  r.line = r.score >= 70 ? "Right in your lane" : r.score >= 50 ? "Close to what you do" : "A stretch from what you usually post";
  return { ...r, history: { n: scored.length, x: gm, titles: mine.slice(0, 6).map((i) => ({ title: i.title, score: i.score, url: i.url })) } };
}

/* ───────────── the verdict and the prediction */

export type Verdict = "Go now" | "Strong" | "Maybe" | "Skip";
export type Prediction = {
  fmt: Fmt; basis: string;
  /** your median views for the format, the views expected, and the middle half of where it should land */
  usual: number | null; views: number | null; low: number | null; high: number | null;
  /** expected views against your usual */
  x: number; x_low: number; x_high: number;
  /** the chance it beats 1.5× your usual */
  hit_chance: number;
  /** what moved it from your usual */
  factors: { label: string; x: number }[];
};
export type Research = {
  q: string; geo: string; at: number; fmt: Fmt;
  opportunity: number; verdict: Verdict; confidence: "high" | "medium" | "low"; confidence_n: number;
  demand: Score; momentum: Score; competition: Score; fit: ReturnType<typeof fit>;
  prediction: Prediction;
  longtail: { q: string; opp: number; why: string }[];
  questions: string[];
  /** the words searchers add to it, most common first (SEO: cover the top ones in the title, description and tags) */
  related: { word: string; n: number }[];
  /** what's ranking now, and the freshest uploads */
  top: YtHit[]; month: YtHit[]; news: NewsHit[]; hn: HnHit[];
  titles: TitleIdea[];
  sources: SrcState[];
  why: string[];
};

const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const above = (mu: number, sigma: number, at: number) => 0.5 * (1 - erf((at - mu) / (sigma * Math.SQRT2)));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** The track record's correction: actual ÷ predicted over the predictions that have played out, trusted more as they
 *  add up (none at first). */
export type Calib = { n: number; x: number };

/** Expected views on your next post about it: your usual for the format, moved by how your own posts on it did, the
 *  opportunity and the momentum, then by the track record. The spread is how much your own posts usually vary. */
export function predict(o: { fmt: Fmt; items: WItem[]; opp: number; mom: number; history: { n: number; x: number | null }; calib?: Calib | null }): Prediction {
  const same = o.items.filter((i) => i.fmt === o.fmt && (i.views ?? 0) > 0);
  const usual = median(same.map((i) => i.views!));
  const logs = o.items.filter((i) => i.score != null && i.score > 0).map((i) => Math.log(i.score!)).sort((a, b) => a - b);
  // the spread of your own results (the middle half), wide when there's little to go on
  const iqr = logs.length >= 8 ? logs[Math.floor(logs.length * 0.75)] - logs[Math.floor(logs.length * 0.25)] : 1.2;
  const sigma = clamp(iqr / 1.349, 0.35, 1.4);
  const factors: { label: string; x: number }[] = [];
  const k = o.history.n / (o.history.n + 3);
  if (o.history.x != null && o.history.n) factors.push({ label: `Your ${o.history.n} post${o.history.n === 1 ? "" : "s"} on it`, x: round2(Math.exp(k * Math.log(o.history.x))) });
  factors.push({ label: "Opportunity", x: round2(Math.exp(((o.opp - 50) / 50) * Math.log(1.8))) });
  factors.push({ label: "Momentum", x: round2(Math.exp(((o.mom - 50) / 50) * Math.log(1.4))) });
  if (o.calib && o.calib.n) { const c = o.calib.n / (o.calib.n + 5); factors.push({ label: `Track record (${o.calib.n} played out)`, x: round2(Math.exp(c * Math.log(o.calib.x))) }); }
  const lx = factors.reduce((s, f) => s + Math.log(f.x), 0);
  const x = Math.exp(lx), lo = Math.exp(lx - 0.674 * sigma), hi = Math.exp(lx + 0.674 * sigma);
  return {
    fmt: o.fmt, basis: usual == null ? "No posts in this format to learn your usual from yet: the prediction is against a usual post" : `Your median ${same.length} ${o.fmt} posts get ${Math.round(usual).toLocaleString("en")} views`,
    usual, views: usual == null ? null : Math.round(usual * x), low: usual == null ? null : Math.round(usual * lo), high: usual == null ? null : Math.round(usual * hi),
    x: round2(x), x_low: round2(lo), x_high: round2(hi), hit_chance: round2(above(lx, sigma, Math.log(HIT))), factors,
  };
}

export const verdictOf = (opp: number): Verdict => (opp >= 72 ? "Go now" : opp >= 58 ? "Strong" : opp >= 44 ? "Maybe" : "Skip");
export const opportunityOf = (d: number, m: number, c: number, f: number) => Math.round(clamp(0.35 * d + 0.2 * m + 0.3 * (100 - c) + 0.15 * f));

/** The words searchers add to the keyword across every suggestion, most common first. */
export function relatedWords(q: string, sugg: string[]) {
  const own = new Set([...words(q), "make", "use", "using", "get", "like", "way", "ways", "one", "really", "much"]);
  const n = new Map<string, number>();
  for (const s of new Set(sugg.map(norm))) for (const w of new Set(words(s))) if (!own.has(w) && w.length > 1 && !/^\d{1,3}$/.test(w)) n.set(w, (n.get(w) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([word, c]) => ({ word, n: c }));
}
const QUESTION = /^(how|why|what|when|where|which|who|is|are|can|does|do|should|will)\b/;

/** Everything about one keyword from its signals and your numbers. */
export function research(s: Signals, me: { items: WItem[]; rivals: WRival[]; model: TitleModel | null; fmt?: Fmt | null; calib?: Calib | null }): Research {
  const dm = demand(s), mo = momentum(s), co = competition(s);
  const all = [...s.suggest.yt, ...s.suggest.google, ...s.suggest.bing, ...s.suggest.ddg, ...s.expand];
  const related = relatedWords(s.q, all);
  const fi = fit(s.q, related.map((r) => r.word), me);
  const opp = opportunityOf(dm.score, mo.score, co.score, fi.score);
  const fmt: Fmt = me.fmt ?? (() => {
    const yt = me.items.filter((i) => i.network === "youtube");
    const shorts = yt.filter((i) => i.fmt === "yt_short").length;
    return shorts > yt.length / 2 ? "yt_short" : "yt_video";
  })();
  const pr = predict({ fmt, items: me.items, opp, mom: mo.score, history: fi.history, calib: me.calib });
  // sources that answered with something, of the ones that matter for the scores
  const key: SrcId[] = ["yt_suggest", "youtube", "news", "hn", "wiki", "google_suggest"];
  const okN = key.filter((k) => s.sources.some((x) => x.id === k && x.ok)).length;
  const cover = (dm.cover + mo.cover + co.cover) / 3;
  const confidence = cover >= 0.75 && okN >= 5 ? "high" : cover >= 0.5 && okN >= 3 ? "medium" : "low";
  // long tail: each expansion rated on what's cheap to know about it (its place in the list and its specificity)
  const seen = new Set<string>([norm(s.q)]);
  const tail = [...s.suggest.yt, ...s.expand].map(norm).filter((x) => x && !seen.has(x) && (seen.add(x), true));
  const longtail = tail.slice(0, 40).map((q, i) => {
    const extra = words(q).length - words(s.q).length;
    const top = s.suggest.yt.map(norm).indexOf(q);
    const score = clamp(opp + (top >= 0 ? 12 - top * 1.5 : 0) + Math.min(10, extra * 4) - i * 0.4 + (QUESTION.test(q) ? 4 : 0));
    return { q, opp: Math.round(score), why: top >= 0 ? `#${top + 1} on YouTube's autocomplete` : QUESTION.test(q) ? "A question people ask" : "A longer, more specific search" };
  }).sort((a, b) => b.opp - a.opp).slice(0, 18);
  // "how to <keyword>" on its own is only the expansion echoing back, not a question anyone asked
  const echo = new Set(["how to", "why", "what is", "is", "best", "how", "what"].map((p) => norm(`${p} ${s.q}`)));
  const questions = [...new Set(all.map(norm).filter((x) => (QUESTION.test(x) || /\?$/.test(x)) && !echo.has(x)))].slice(0, 12);
  const why = [
    `${dm.line}. ${mo.line}. ${co.line}. ${fi.line}.`,
    ...(co.score >= 65 && fi.score < 60 ? ["Crowded and outside your lane: a long-tail angle below is the better bet"] : []),
    ...(mo.score >= 65 && co.score < 55 ? ["Rising and still open: this is the window"] : []),
    ...(dm.score < 25 ? ["Few searches: it can still work as a Short or Reel, where the feed decides, not search"] : []),
    ...(confidence === "low" ? [`Only ${okN} of ${key.length} sources answered: treat this as a rough read`] : []),
  ];
  const r: Research = {
    q: s.q, geo: s.geo, at: s.at, fmt, opportunity: opp, verdict: verdictOf(opp), confidence, confidence_n: okN,
    demand: dm, momentum: mo, competition: co, fit: fi, prediction: pr, longtail, questions, related,
    top: (s.youtube?.top ?? []).slice(0, 12), month: (s.youtube?.month ?? []).slice(0, 8), news: (s.news?.items ?? []).slice(0, 8), hn: (s.hn?.top ?? []).slice(0, 6),
    titles: [], sources: s.sources, why,
  };
  r.titles = titleIdeas(r, me.model);
  return r;
}

/* ───────────── titles and SEO */

export type SeoCheck = { id: string; label: string; ok: boolean; part: number; weight: number; why: string };
export type SeoResult = { score: number; checks: SeoCheck[]; missing: string[]; partial: boolean };

const titleCase = (s: string) => s.replace(/(?<![\p{L}\p{N}])([a-z])([a-z']*)(?![\p{N}])/gu, (m, a: string, b: string, i: number) => (i > 0 && /^(a|an|the|and|or|of|to|in|on|for|vs|with|at|by)$/.test(m) ? m : a.toUpperCase() + b))
  .replace(/\b(ai|gpt|api|llm|mcp|seo|ui|ux|ios|cli|sdk|agi|rag|vs)\b/gi, (m) => (m.toLowerCase() === "vs" ? "vs" : m.toUpperCase()));

/** A title, description and tags against a keyword the way search reads them. Leave the description or tags out and
 *  their checks are skipped (the score says it's partial). */
export function seoScore(o: { q: string; title: string; description?: string | null; tags?: string[] | null; related?: string[]; fmt?: Fmt | null }): SeoResult {
  const q = norm(o.q), t = o.title.trim(), tn = norm(t), desc = o.description ?? null, tags = o.tags ?? null;
  const exact = !!q && ` ${tn} `.includes(` ${q} `);
  const all = !!q && covers(t, q);
  const pos = exact ? tn.indexOf(q) : -1;
  const short = o.fmt === "yt_short" || o.fmt === "ig_reel";
  const checks: SeoCheck[] = [
    { id: "in_title", label: "Keyword in the title", weight: 24, part: exact ? 1 : all ? 0.6 : 0, ok: exact, why: exact ? "The exact words are in the title." : all ? "Every word is there, but not as one phrase: search matches the phrase best." : `“${o.q}” isn't in the title.` },
    { id: "front", label: "Keyword up front", weight: 10, part: pos < 0 ? 0 : pos <= 25 ? 1 : pos <= 45 ? 0.5 : 0, ok: pos >= 0 && pos <= 25, why: pos < 0 ? "Put the keyword in the first few words." : pos <= 25 ? "It's in the first few words, where search and eyes look first." : "It's late in the title: phones cut titles at about 60 characters." },
    { id: "length", label: "Title length", weight: 10, part: t.length >= 30 && t.length <= 60 ? 1 : t.length <= 70 && t.length >= 20 ? 0.5 : 0, ok: t.length >= 30 && t.length <= 60, why: `${t.length} characters. 30 to 60 shows whole on a phone and still says enough.` },
  ];
  const related = (o.related ?? []).slice(0, 8);
  const body = norm([t, desc ?? "", ...(tags ?? [])].join(" "));
  const hit = related.filter((w) => ` ${body} `.includes(` ${norm(w)} `));
  if (related.length) checks.push({ id: "related", label: "Related searches covered", weight: 14, part: Math.min(1, hit.length / Math.min(4, related.length)), ok: hit.length >= Math.min(4, related.length), why: `${hit.length} of the top ${related.length} words searchers add (${related.slice(0, 5).join(", ")}) are in the title${desc != null ? ", description" : ""}${tags ? " or tags" : ""}.` });
  if (desc != null) {
    const dn = norm(desc), first = norm(desc.slice(0, 160)), dw = dn.split(" ").filter(Boolean).length;
    const reps = q ? (` ${dn} `.split(` ${q} `).length - 1) : 0;
    const tagsIn = (desc.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
    checks.push(
      { id: "desc_front", label: "Keyword early in the description", weight: 10, part: q && ` ${first} `.includes(` ${q} `) ? 1 : covers(desc.slice(0, 160), q) ? 0.5 : 0, ok: !!q && ` ${first} `.includes(` ${q} `), why: "The first two lines show under the video and in search: say the keyword there." },
      { id: "desc_depth", label: "Description says enough", weight: 8, part: short ? (dw >= 15 ? 1 : dw >= 5 ? 0.5 : 0) : dw >= 200 ? 1 : dw >= 80 ? 0.5 : 0, ok: short ? dw >= 15 : dw >= 200, why: `${dw} words. ${short ? "A line or two is enough for a Short." : "200 or more gives search something to read."}` },
      { id: "stuffing", label: "No keyword stuffing", weight: 6, part: reps <= (short ? 2 : 4) ? 1 : 0, ok: reps <= (short ? 2 : 4), why: `The keyword appears ${reps} time${reps === 1 ? "" : "s"} in the description. More than a few reads as spam.` },
      { id: "hashtags", label: "A few hashtags", weight: 5, part: tagsIn >= 1 && tagsIn <= 5 ? 1 : 0, ok: tagsIn >= 1 && tagsIn <= 5, why: `${tagsIn} hashtag${tagsIn === 1 ? "" : "s"}. One to five; YouTube ignores them all past 15.${short ? " #shorts helps a Short find the feed." : ""}` },
    );
    if (!short) checks.push({ id: "chapters", label: "Chapters", weight: 5, part: /(^|\n)\s*0?0:00\b/.test(desc) ? 1 : 0, ok: /(^|\n)\s*0?0:00\b/.test(desc), why: "Timestamps from 0:00 become chapters, which show up in search as key moments." });
  }
  if (tags) {
    const len = tags.join(",").length, has = tags.some((g) => norm(g) === q);
    checks.push({ id: "tags", label: "Tags", weight: 8, part: (has ? 0.5 : 0) + (tags.length >= 5 && len <= 500 ? 0.5 : 0), ok: has && tags.length >= 5 && len <= 500, why: `${tags.length} tags, ${len} of 500 characters${has ? ", the keyword among them" : "; add the keyword itself as a tag"}. Tags matter little, but they catch misspellings.` });
  }
  const w = checks.reduce((s, c) => s + c.weight, 0);
  const score = t ? Math.round((checks.reduce((s, c) => s + c.weight * c.part, 0) / w) * 100) : 0;
  return { score, checks, missing: related.filter((w) => !hit.includes(w)).slice(0, 5), partial: desc == null || !tags };
}

export type TitleIdea = { title: string; seo: number; click: number; score: number; from: string };

/** A title's overall score: search (SEO) and click (what your hits do, lib/writing.ts) together. Shorts and Reels live
 *  in the feed more than in search, so click counts for more there. */
export function titleScore(title: string, q: string, model: TitleModel | null, o: { related?: string[]; fmt?: Fmt | null } = {}) {
  const seo = seoScore({ q, title, related: o.related, fmt: o.fmt }).score;
  const click = model ? scoreTitle(title, model).score : 50;
  const w = o.fmt === "yt_short" || o.fmt === "ig_reel" ? 0.35 : 0.55;
  return { seo, click, score: Math.round(seo * w + click * (1 - w)) };
}

/** Rule-made starting titles built from the keyword and what searchers ask, scored. Starters, not finished writing:
 *  Claude writes better ones over MCP (seo_score scores them). */
export function titleIdeas(r: Pick<Research, "q" | "questions" | "related" | "momentum" | "fmt" | "longtail">, model: TitleModel | null): TitleIdea[] {
  const K = titleCase(r.q), year = new Date().getFullYear();
  const vs = r.longtail.map((l) => l.q).find((x) => / vs /.test(x));
  const q1 = r.questions.find((x) => x.startsWith("how") && x.split(" ").length >= norm(r.q).split(" ").length + 3) ?? r.questions.find((x) => x.split(" ").length >= norm(r.q).split(" ").length + 3);
  const add = r.related.slice(0, 2).map((x) => x.word);
  const cands: [string, string][] = [
    [`${K}: ${add[0] ? `The ${titleCase(add[0])} Guide` : "Everything You Need to Know"} (${year})`, "Keyword first, a dated guide"],
    [`${K} in 10 Minutes (Beginner to Pro)`, "Keyword first, a clear payoff"],
    [`I Tried ${K} for 30 Days. Here's What Happened`, "A personal test"],
    [`${K}: 5 Mistakes Everyone Makes`, "A number and a stake"],
    [`Stop Using ${K} Wrong (Do This Instead)`, "Contrast"],
    [`Why Everyone's Talking About ${K}`, "Rides the moment"],
    [`${K} Explained Simply`, "Plain and short"],
    ...(q1 ? [[`${titleCase(q1)}? (The Real Answer)`, "A question people type"] as [string, string]] : []),
    ...(vs ? [[`${titleCase(vs)}: Which One Wins?`, "A comparison people search"] as [string, string]] : []),
    ...(r.momentum.score >= 60 ? [[`${K} Just Changed Everything`, "News angle while it's rising"] as [string, string]] : []),
  ];
  const related = r.related.slice(0, 8).map((x) => x.word);
  return cands.map(([title, from]) => ({ title, from, ...titleScore(title, r.q, model, { related, fmt: r.fmt }) })).sort((a, b) => b.score - a.score).slice(0, 8);
}

/* ───────────── the sweep: what's moving in your lane right now */

export type SweepSignal = { src: "trends" | "news" | "hn" | "rival" | "suggest" | "wiki" | "yt_chart"; title: string; url: string; at: number; /** how strong this one signal is, 0 to 1 */ w: number; metric: string; geo?: string };
export type Blip = {
  topic: string; heat: number; fit: number; score: number; verdict: Verdict;
  sources: SweepSignal["src"][]; signals: SweepSignal[]; why: string; angles: string[];
};
export type Sweep = { at: number; seeds: string[]; geos: string[]; blips: Blip[]; trending: SweepSignal[]; sources: SrcState[] };

export const SWEEP_NAME: Record<SweepSignal["src"], string> = { trends: "Google Trends", news: "Google News", hn: "Hacker News", rival: "A rival's outlier", suggest: "Autocomplete", wiki: "Wikipedia", yt_chart: "YouTube trending" };

/** Headline words that say nothing about the topic. */
const NOISE = new Set("each other more most now after over says said could would should get gets got new first top best using use uses used make makes made launch launches launched announces announced report reports study finds found here why how what know things thing way ways people today week year years day days time back still also amid via vs plus inside latest update updates news live video watch full official business pro plus free max mini team enterprise tool tools app apps model models company users user world".split(" "));
/** Words that are names: capitalised mid-sentence in a headline that isn't Title Case, or shaped like one (OpenAI,
 *  GPT-6, iPhone). One word alone is only a topic if it's a name; "tasks" or "month" isn't. */
function namesOf(titles: string[]) {
  const out = new Set<string>();
  for (const t of titles) {
    const tok = t.split(/[\s:;,|·()"“”]+/).filter((x) => /\p{L}/u.test(x));
    const caps = tok.filter((x) => /^\p{Lu}/u.test(x)).length;
    const sentence = tok.length >= 4 && caps / tok.length < 0.5;
    tok.forEach((x, i) => {
      const w = norm(x).replace(/['’]s$/, "");
      if (!w || STOP.has(w) || NOISE.has(w)) return;
      if (/\d/.test(x) && /\p{L}/u.test(x) || /\p{Ll}\p{Lu}/u.test(x) || /^\p{Lu}{2,}$/u.test(x) || (sentence && i > 0 && /^\p{Lu}/u.test(x))) out.add(w);
    });
  }
  return out;
}
/** Two-word phrases and names worth grouping signals by. */
function phrases(t: string, names: Set<string>): string[] {
  const ws = norm(t).replace(/['’]s\b/g, "").split(" ").filter((w) => w.length > 1);
  const out = new Set<string>();
  const skip = (w: string) => STOP.has(w) || NOISE.has(w) || /^\d+$/.test(w);
  for (let i = 0; i < ws.length - 1; i++) if (!skip(ws[i]) && !skip(ws[i + 1])) out.add(`${ws[i]} ${ws[i + 1]}`);
  for (const w of ws) if (!skip(w) && w.length > 2 && names.has(w)) out.add(w);
  return [...out];
}

/** Signals from every source grouped by what they're about, each group scored by how many independent sources carry
 *  it, how strong and fresh they are, and how close it is to your lane (your seeds and your hits' words). */
export function sweep(signals: SweepSignal[], lane: string[], o: { now?: number; seeds: string[]; geos: string[]; sources: SrcState[] }): Sweep {
  const now = o.now ?? Date.now();
  const laneW = new Set(lane.flatMap((l) => norm(l).split(" ")).filter((w) => w.length > 2 && !STOP.has(w)));
  const inLane = (t: string) => norm(t).replace(/['’]s\b/g, "").split(" ").some((w) => laneW.has(w) || laneW.has(w.replace(/s$/, "")));
  // the same story often comes back for two seeds: count it once
  const seen = new Set<string>();
  signals = signals.filter((x) => { const k = norm(x.title).slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });
  // a seed on its own says nothing new (every story about it matches): a topic is what's happening around it
  const seedW = new Set(o.seeds.flatMap((x) => norm(x).split(" ")));
  const byP = new Map<string, SweepSignal[]>();
  const names = namesOf(signals.map((x) => x.title));
  for (const s of signals) for (const p of phrases(s.title, names)) {
    if (p.split(" ").every((w) => seedW.has(w) || seedW.has(w.replace(/s$/, "")) || seedW.has(`${w}s`))) continue;
    const a = byP.get(p) ?? []; a.push(s); byP.set(p, a);
  }
  const groups = [...byP].map(([p, ss]) => {
    const srcs = [...new Set(ss.map((s) => s.src))];
    const multi = p.includes(" ") ? 1.5 : 1;
    return { p, ss, srcs, rank: (srcs.length * 2 + ss.length * 0.5 + ss.reduce((a, s) => a + s.w, 0)) * multi };
  }).filter((g) => g.ss.length >= 2 || g.ss.some((s) => s.w >= 0.75)).sort((a, b) => b.rank - a.rank);
  const used = new Set<SweepSignal>();
  const blips: Blip[] = [];
  for (const g of groups) {
    const fresh = g.ss.filter((s) => !used.has(s));
    if (fresh.length < Math.max(1, Math.ceil(g.ss.length / 2))) continue;
    // fit: how many of its signals are about your lane (a rival's hit counts as yours)
    const share = g.ss.filter((s) => s.src === "rival" || inLane(s.title)).length / g.ss.length;
    const f = Math.round(clamp(share * 75 + (g.p.split(" ").some((w) => laneW.has(w)) ? 15 : 0) + (g.ss.some((s) => s.src === "rival") ? 15 : 0) + 5));
    if (f < 30 && g.srcs.length < 3) continue;
    const rec = g.ss.reduce((a, s) => a + Math.exp(-(now - s.at) / (2 * D)), 0) / g.ss.length;
    const heat = Math.round(clamp(g.srcs.length * 16 + Math.min(20, (g.ss.length - 1) * 5) + Math.min(25, g.ss.reduce((a, s) => a + s.w, 0) * 8) + rec * 25 - 10));
    const score = Math.round(0.6 * heat + 0.4 * f);
    g.ss.forEach((s) => used.add(s));
    // one word alone ("legal") reads better with the lane word most of its signals share ("claude legal")
    let topic = g.p;
    if (!g.p.includes(" ") && !laneW.has(g.p)) {
      const n = new Map<string, number>();
      for (const x of g.ss) for (const w of new Set(norm(x.title).replace(/['’]s\b/g, "").split(" "))) if (w !== g.p && laneW.has(w)) n.set(w, (n.get(w) ?? 0) + 1);
      const best = [...n].sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= g.ss.length / 2) topic = `${best[0]} ${g.p}`;
    }
    if (blips.some((b) => b.topic === topic)) continue;
    const K = titleCase(topic);
    blips.push({
      topic, heat, fit: f, score, verdict: verdictOf(score), sources: g.srcs, signals: g.ss.sort((a, b) => b.w - a.w).slice(0, 8),
      why: `${g.ss.length} signal${g.ss.length === 1 ? "" : "s"} from ${g.srcs.map((s) => SWEEP_NAME[s]).join(", ")}${rec > 0.6 ? ", most in the last day" : ""}${f >= 60 ? "; right in your lane" : f >= 40 ? "; near your lane" : ""}.`,
      angles: [`What ${K} means for you`, `${K}: what nobody's saying yet`, `I tested ${K} so you don't have to`],
    });
    if (blips.length >= 14) break;
  }
  blips.sort((a, b) => b.score - a.score);
  const trending = signals.filter((s) => s.src === "trends").sort((a, b) => b.w - a.w).slice(0, 12);
  return { at: now, seeds: o.seeds, geos: o.geos, blips, trending, sources: o.sources };
}

/** Google Trends' "200+", "5K+", "1M+" as a number. */
export const trafficOf = (t: string) => { const m = /([\d.]+)\s*([KM])?/i.exec(t); return m ? +m[1] * (m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "K" ? 1e3 : 1) : 0; };
export const strength = { trends: (t: string) => logPart(trafficOf(t), 2, 6), hn: (pts: number) => logPart(pts, 1.3, 3.2), rival: (x: number) => clamp((x - 1) / 4, 0, 1), news: () => 0.35, suggest: () => 0.3 };

/* ───────────── the track record */

export type Pred = { id: string; q: string; at: number; fmt: Fmt; x: number; hit_chance: number; opp: number; post_id: string | null; by: string;
  /** filled once it has played out */ actual?: { x: number; title: string; url: string; at: number } | null };
export type TrackRecord = { n: number; open: number; median_err: number | null; within: number | null; hit_calls: number | null; calib: Calib; recent: Pred[] };

/** Each prediction matched to what went out: the post it was made for, or else the first post within three weeks whose
 *  title covers the keyword. A post is only judged once it's a week old, when its numbers have mostly settled. */
export function settle(preds: Pred[], items: WItem[], now = Date.now()): Pred[] {
  return preds.map((p) => {
    if (p.actual) return p;
    const it = items.find((i) => i.fmt === p.fmt && i.score != null && i.at >= p.at - D && i.at <= p.at + 21 * D && now - i.at >= 7 * D && (p.post_id ? i.post === p.post_id : covers(i.title, p.q)));
    return it ? { ...p, actual: { x: it.score!, title: it.title, url: it.url, at: it.at } } : p;
  });
}

export function record(preds: Pred[]): TrackRecord {
  const done = preds.filter((p) => p.actual);
  const err = done.map((p) => Math.abs(Math.log(p.actual!.x / p.x)));
  const me = median(err);
  const within = done.length ? done.filter((p) => p.actual!.x >= p.x / 2 && p.actual!.x <= p.x * 2).length / done.length : null;
  const calls = done.filter((p) => (p.hit_chance >= 0.5) === (p.actual!.x >= HIT)).length;
  const lg = done.length ? done.reduce((s, p) => s + Math.log(p.actual!.x / p.x), 0) / done.length : 0;
  return {
    n: done.length, open: preds.length - done.length, median_err: me == null ? null : round2(Math.exp(me)), within: within == null ? null : round2(within),
    hit_calls: done.length ? round2(calls / done.length) : null, calib: { n: done.length, x: round2(Math.exp(lg)) },
    recent: [...preds].sort((a, b) => b.at - a.at).slice(0, 12),
  };
}
