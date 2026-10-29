// Radar's free sources, read on the server (lib/radar.ts scores what they bring back). No paid APIs and no keys: the
// autocompletes of YouTube, Google, Bing and DuckDuckGo (what people type), YouTube's own search page (what ranks, its
// views and age), Google News and Hacker News (what's being written about, this week against the month), Wikipedia's
// pageviews (how many people read up on it a day), and Google Trends' daily searches. The connected YouTube channel
// adds the subscriber counts of the channels on top (one quota unit for fifty). Each source has its own short time
// limit and fails on its own: the scores use whatever answered and say what didn't. Reddit is left out: it refuses
// servers without a paid key.
import type { HnHit, NewsHit, Signals, SrcId, SrcState, SweepSignal, YtHit } from "./radar";
import { norm, strength } from "./radar";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const BOT = "VoiceboxStudio/1.0 (https://voiceboxstudio.vercel.app; radar)"; // Wikimedia asks for a named client
const D = 86_400_000;

class Track {
  states: SrcState[] = [];
  async run<T>(id: SrcId, f: () => Promise<T>, empty: T, ok: (v: T) => boolean = () => true): Promise<T> {
    const t = Date.now();
    try {
      const v = await f();
      const good = ok(v);
      this.merge({ id, ok: good, ms: Date.now() - t, note: good ? undefined : "no results" });
      return v;
    } catch (e) {
      this.merge({ id, ok: false, ms: Date.now() - t, note: ((e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message).slice(0, 120) });
      return empty;
    }
  }
  /** one source can be asked several times (the a-z expansion): it counts as answering if any call did */
  private merge(s: SrcState) {
    const have = this.states.find((x) => x.id === s.id);
    if (!have) this.states.push(s);
    else { have.ok ||= s.ok; have.ms = Math.max(have.ms, s.ms); if (have.ok) delete have.note; }
  }
}

async function get(url: string, o: { ms?: number; ua?: string; headers?: Record<string, string> } = {}) {
  const r = await fetch(url, { headers: { "User-Agent": o.ua ?? UA, "Accept-Language": "en-US,en;q=0.9", ...o.headers }, cache: "no-store", signal: AbortSignal.timeout(o.ms ?? 6000) });
  if (!r.ok) throw new Error(r.status === 429 ? "rate limited, try later" : `HTTP ${r.status}`);
  return r;
}
const json = async <T>(url: string, o?: Parameters<typeof get>[1]) => (await get(url, o)).json() as Promise<T>;
const text = async (url: string, o?: Parameters<typeof get>[1]) => (await get(url, o)).text();
const enc = encodeURIComponent;

/** a few at a time, so a long list of calls doesn't trip anyone's rate limit */
async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

/* ───────────── autocomplete */

const ytSuggest = (q: string, geo: string) => json<[string, string[]]>(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=${geo}&q=${enc(q)}`, { ms: 4000 }).then((r) => r[1] ?? []);
const googleSuggest = (q: string, geo: string) => json<[string, string[]]>(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=${geo}&q=${enc(q)}`, { ms: 4000 }).then((r) => r[1] ?? []);
const bingSuggest = (q: string) => json<[string, string[]]>(`https://api.bing.com/osjson.aspx?query=${enc(q)}`, { ms: 4000 }).then((r) => (r[1] ?? []).slice(0, 10));
const ddgSuggest = (q: string) => json<[string, string[]] | { phrase: string }[]>(`https://duckduckgo.com/ac/?q=${enc(q)}&type=list`, { ms: 4000 }).then((r) => (Array.isArray(r[1]) ? (r[1] as string[]) : (r as { phrase: string }[]).map((x) => x.phrase)).slice(0, 10));

const PRE = ["how to", "why", "what is", "is", "best"];
const POST = ["vs", "for", "tutorial", "free", "not working", "alternative", "explained", "tips"];

/** The long tail: the keyword with question words in front, modifiers after, and (deep) every letter after it. */
async function expand(t: Track, q: string, geo: string, deep: boolean) {
  const qs = [...PRE.map((p) => `${p} ${q}`), ...POST.map((p) => `${q} ${p}`), ...(deep ? "abcdefghijklmnopqrstuvwxyz".split("").map((c) => `${q} ${c}`) : [])];
  const res = await pool(qs, 6, (x) => t.run("yt_suggest", () => ytSuggest(x, geo), [] as string[]));
  const base = norm(q).split(" ")[0];
  return [...new Set(res.flat().map(norm))].filter((s) => s.includes(base));
}

/* ───────────── YouTube's search page (no quota) */

const num = (s?: string) => { if (!s) return null; const m = /([\d,.]+)\s*([KMB])?/i.exec(s.replace(/ /g, " ")); if (!m) return /no views/i.test(s) ? 0 : null; const v = parseFloat(m[1].replace(/,/g, "")); const k = m[2]?.toUpperCase(); return Math.round(v * (k === "B" ? 1e9 : k === "M" ? 1e6 : k === "K" ? 1e3 : 1)); };
const ageDays = (s?: string) => {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year|s|mo|min|h|d|w|y)\w*\s+ago/i.exec(s ?? "");
  if (!m) return null;
  const n = +m[1], u = m[2].toLowerCase();
  return u.startsWith("y") ? n * 365 : u === "mo" || u.startsWith("month") ? n * 30 : u.startsWith("w") ? n * 7 : u.startsWith("d") ? n : 0.5;
};
const secsOf = (s?: string) => (s ? s.split(":").reduce((a, b) => a * 60 + +b, 0) : null);

type VR = { videoId: string; title?: { runs?: { text: string }[] }; viewCountText?: { simpleText?: string; runs?: { text: string }[] }; publishedTimeText?: { simpleText?: string }; lengthText?: { simpleText?: string }; ownerText?: { runs?: { text: string; navigationEndpoint?: { browseEndpoint?: { browseId?: string } } }[] } };

async function ytSearch(q: string, geo: string, month: boolean): Promise<{ total: number | null; hits: YtHit[] }> {
  // sp=EgIIBA%3D%3D is YouTube's own "Upload date: this month" filter
  const html = await text(`https://www.youtube.com/results?search_query=${enc(q)}&hl=en&gl=${geo}${month ? "&sp=EgIIBA%253D%253D" : ""}`, { ms: 8000, headers: { Cookie: "CONSENT=YES+cb; SOCS=CAI" } });
  const at = html.indexOf("var ytInitialData = ");
  if (at < 0) throw new Error("YouTube changed its page");
  const end = html.indexOf(";</script>", at);
  const data = JSON.parse(html.slice(at + 20, end));
  const hits: YtHit[] = [];
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object" || hits.length >= 30) return;
    const v = (o as { videoRenderer?: VR }).videoRenderer;
    if (v?.videoId) {
      const own = v.ownerText?.runs?.[0];
      hits.push({ id: v.videoId, title: v.title?.runs?.map((r) => r.text).join("") ?? "", channel: own?.text ?? "", channel_id: own?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
        views: num(v.viewCountText?.simpleText ?? v.viewCountText?.runs?.map((r) => r.text).join("")), age_days: ageDays(v.publishedTimeText?.simpleText), secs: secsOf(v.lengthText?.simpleText) });
      return;
    }
    for (const k in o as object) walk((o as Record<string, unknown>)[k]);
  };
  walk(data);
  const total = /"estimatedResults":"(\d+)"/.exec(html);
  return { total: total ? +total[1] : null, hits };
}

/** Subscriber counts for the channels on top, from the connected YouTube channel (1 quota unit for up to 50). */
async function subsOf(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { listAccounts, getAccount } = await import("./publish/accounts");
  const acc = (await listAccounts()).find((a) => a.network === "youtube");
  if (!acc) throw new Error("no YouTube channel connected");
  const YT = await import("./publish/youtube");
  const a = await getAccount(acc.id);
  if (!a) throw new Error("no YouTube channel connected");
  const token = await YT.accessToken(a);
  const r = await YT.ytGet<{ items?: { id: string; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }[] }>(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${[...new Set(ids)].slice(0, 50).join(",")}`, token);
  for (const c of r.items ?? []) if (c.statistics?.subscriberCount && !c.statistics.hiddenSubscriberCount) out.set(c.id, +c.statistics.subscriberCount);
  return out;
}

/* ───────────── news, Hacker News, Wikipedia, Trends */

const tag = (x: string, t: string) => { const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(x); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : ""; };
const items = (xml: string) => xml.split("<item>").slice(1).map((x) => x.split("</item>")[0]);

async function news(q: string, geo: string, days = 30): Promise<{ n7: number; n30: number; span: number; items: NewsHit[] }> {
  const xml = await text(`https://news.google.com/rss/search?q=${enc(`"${q}" when:${days}d`)}&hl=en-${geo}&gl=${geo}&ceid=${geo}:en`, { ms: 6000 });
  const now = Date.now();
  const all = items(xml).map((x) => ({ title: tag(x, "title").replace(/\s+-\s+[^-]+$/, ""), url: tag(x, "link"), source: tag(x, "source"), at: Date.parse(tag(x, "pubDate")) || 0 })).filter((x) => x.at);
  all.sort((a, b) => b.at - a.at);
  // Google News sends at most 100: if it's full, the month is however far back the 100th story goes
  const span = all.length >= 100 ? Math.max(8, (now - all[all.length - 1].at) / D) : days;
  return { n7: all.filter((x) => now - x.at <= 7 * D).length, n30: all.length, span, items: all.slice(0, 10) };
}

async function hn(q: string): Promise<{ n7: number; n30: number; top: HnHit[] }> {
  const now = Math.floor(Date.now() / 1000);
  const base = `https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story`;
  type H = { nbHits: number; hits: { title: string; url: string | null; objectID: string; points: number; num_comments: number; created_at_i: number }[] };
  const [w, m] = await Promise.all([
    json<H>(`${base}&hitsPerPage=0&numericFilters=${enc(`created_at_i>${now - 7 * 86400}`)}`, { ms: 5000 }),
    json<H>(`${base}&hitsPerPage=6&numericFilters=${enc(`created_at_i>${now - 30 * 86400}`)}`, { ms: 5000 }),
  ]);
  return { n7: w.nbHits, n30: m.nbHits, top: m.hits.map((h) => ({ title: h.title, url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points, comments: h.num_comments, at: h.created_at_i * 1000 })) };
}

async function wiki(q: string): Promise<{ article: string; daily: number[] } | null> {
  const s = await json<[string, string[], string[], string[]]>(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${enc(q)}&limit=3&namespace=0&format=json`, { ms: 4000, ua: BOT });
  const words = norm(q).split(" ").filter((w) => w.length > 2);
  const title = (s[1] ?? []).find((t) => { const n = norm(t); return words.length && words.every((w) => n.includes(w)); });
  if (!title) return null;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
  const art = enc(title.replace(/ /g, "_"));
  const r = await json<{ items?: { views: number }[] }>(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${art}/daily/${day(Date.now() - 61 * D)}/${day(Date.now() - D)}`, { ms: 5000, ua: BOT });
  return { article: title.replace(/ /g, "_"), daily: (r.items ?? []).map((x) => x.views) };
}

/** Google Trends' daily searches for one country. */
export async function trends(geo: string): Promise<{ title: string; traffic: string; geo: string; news: { title: string; url: string }[]; at: number }[]> {
  const xml = await text(`https://trends.google.com/trending/rss?geo=${geo}`, { ms: 5000 });
  return items(xml).map((x) => ({
    title: tag(x, "title"), traffic: tag(x, "ht:approx_traffic"), geo, at: Date.parse(tag(x, "pubDate")) || Date.now(),
    news: x.split("<ht:news_item>").slice(1, 3).map((n) => ({ title: tag(n, "ht:news_item_title"), url: tag(n, "ht:news_item_url") })),
  }));
}

/* ───────────── everything about one keyword */

export async function gather(q: string, o: { geo: string; deep?: boolean; geos?: string[] }): Promise<Signals> {
  const t = new Track();
  const geo = o.geo;
  const words = q.trim().split(/\s+/);
  // what's offered when the keyword is only half typed: its last word cut to its first letter (or 3 letters for one word)
  const prefix = words.length > 1 ? `${words.slice(0, -1).join(" ")} ${words[words.length - 1][0]}` : q.slice(0, Math.min(3, q.length - 1));
  const [yt, google, bing, ddg, pre, exp, top, month, nw, h, wk, tr] = await Promise.all([
    t.run("yt_suggest", () => ytSuggest(q, geo), [] as string[]),
    t.run("google_suggest", () => googleSuggest(q, geo), [] as string[]),
    t.run("bing_suggest", () => bingSuggest(q), [] as string[]),
    t.run("ddg_suggest", () => ddgSuggest(q), [] as string[]),
    t.run("yt_suggest", () => ytSuggest(prefix, geo), [] as string[]),
    expand(t, q, geo, !!o.deep),
    t.run("youtube", () => ytSearch(q, geo, false), null, (v) => !!v?.hits.length),
    t.run("youtube", () => ytSearch(q, geo, true), null),
    t.run("news", () => news(q, geo), null),
    t.run("hn", () => hn(q), null),
    t.run("wiki", () => wiki(q), null, (v) => !!v?.daily.length),
    t.run("trends", async () => (await Promise.all((o.geos ?? [geo]).map((g) => trends(g).catch(() => [])))).flat(), [] as Awaited<ReturnType<typeof trends>>, (v) => v.length > 0),
  ]);
  const nq = norm(q);
  const rank = pre.map(norm).indexOf(nq);
  const youtube = top ? { total: top.total, top: top.hits, month: month?.hits ?? [] } : null;
  if (youtube) {
    const ids = [...youtube.top.slice(0, 12), ...youtube.month.slice(0, 6)].map((h) => h.channel_id).filter((x): x is string => !!x);
    const subs = await t.run("youtube_api", () => subsOf(ids), new Map<string, number>(), (m) => m.size > 0);
    for (const hh of [...youtube.top, ...youtube.month]) if (hh.channel_id && subs.has(hh.channel_id)) hh.subs = subs.get(hh.channel_id)!;
  }
  return {
    q: q.trim(), geo, at: Date.now(), suggest: { yt, google, bing, ddg }, prefix_rank: rank >= 0 ? rank : null, expand: exp,
    youtube, news: nw, hn: h, wiki: wk, trends: tr.map(({ title, traffic, geo }) => ({ title, traffic, geo })), sources: t.states,
  };
}

/* ───────────── the sweep's signals */

/** What's moving right now around your seeds: Google's trending searches, the news about each seed this week, Hacker
 *  News' front page, what YouTube's autocomplete offers for each seed, YouTube's trending tech videos (connected
 *  channel), and your rivals' outliers (passed in from Grow's live numbers). */
export async function sweepSignals(seeds: string[], geos: string[], rivals: SweepSignal[]): Promise<{ signals: SweepSignal[]; sources: SrcState[] }> {
  const t = new Track();
  const now = Date.now();
  const [tr, nw, front, sug, chart] = await Promise.all([
    t.run("trends", async () => (await Promise.all(geos.map((g) => trends(g).catch(() => [])))).flat(), [] as Awaited<ReturnType<typeof trends>>, (v) => v.length > 0),
    t.run("news", async () => (await pool(seeds.slice(0, 6), 3, (s) => news(s, geos[0] ?? "US", 2).catch(() => null))).flatMap((r) => r?.items ?? []), [] as NewsHit[], (v) => v.length > 0),
    t.run("hn", async () => (await json<{ hits: { title: string; url: string | null; objectID: string; points: number; created_at_i: number }[] }>("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30", { ms: 5000 })).hits, []),
    t.run("yt_suggest", async () => (await pool(seeds.slice(0, 8), 4, (s) => ytSuggest(s, geos[0] ?? "US").catch(() => [] as string[]))).flat(), [] as string[]),
    t.run("youtube_api", async () => {
      const { listAccounts, getAccount } = await import("./publish/accounts");
      const acc = (await listAccounts()).find((a) => a.network === "youtube");
      if (!acc) throw new Error("no YouTube channel connected");
      const YT = await import("./publish/youtube");
      const a = await getAccount(acc.id);
      if (!a) throw new Error("no YouTube channel connected");
      const r = await YT.ytGet<{ items?: { id: string; snippet: { title: string; publishedAt: string }; statistics?: { viewCount?: string } }[] }>(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&videoCategoryId=28&maxResults=25&regionCode=${geos[0] ?? "US"}`, await YT.accessToken(a));
      return r.items ?? [];
    }, []),
  ]);
  const signals: SweepSignal[] = [
    ...tr.map((x) => ({ src: "trends" as const, title: [x.title, ...x.news.map((n) => n.title)].join(" · "), url: x.news[0]?.url || `https://trends.google.com/trending?geo=${x.geo}`, at: x.at, w: strength.trends(x.traffic), metric: `${x.traffic} searches`, geo: x.geo })),
    ...nw.map((x) => ({ src: "news" as const, title: x.title, url: x.url, at: x.at, w: strength.news(), metric: x.source })),
    ...front.map((x) => ({ src: "hn" as const, title: x.title, url: x.url ?? `https://news.ycombinator.com/item?id=${x.objectID}`, at: x.created_at_i * 1000, w: strength.hn(x.points), metric: `${x.points} points` })),
    ...[...new Set(sug.map(norm))].map((x) => ({ src: "suggest" as const, title: x, url: `https://www.youtube.com/results?search_query=${enc(x)}`, at: now, w: strength.suggest(), metric: "typed on YouTube" })),
    ...chart.map((v) => ({ src: "yt_chart" as const, title: v.snippet.title, url: `https://youtu.be/${v.id}`, at: Date.parse(v.snippet.publishedAt), w: 0.5, metric: `${Number(v.statistics?.viewCount ?? 0).toLocaleString("en")} views` })),
    ...rivals,
  ];
  return { signals, sources: t.states };
}
