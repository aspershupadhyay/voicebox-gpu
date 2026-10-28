// The Analytics page: how each connected YouTube channel and Instagram account is doing, per format (Videos, Shorts,
// Reels, Posts), and what that says about what to post next. Everything comes from the platforms with the accounts'
// own keys (lib/publish/accounts.ts): the YouTube Data API (videos, counts), the YouTube Analytics API (daily views,
// watch time, retention, traffic, audience) and Instagram's insights (reach, views, saves, shares, audience). Anything a
// connection can't read yet comes back as a `needs` line instead of failing the page.
//
// The overview (every platform together) is here; each platform in depth is lib/analytics-yt.ts and analytics-ig.ts,
// and one post in depth is getPostDetail(). A follower count per account is kept each day (workspace/analytics/
// history.json), so growth shows past the 30 days Instagram remembers.
//
// One report per range is kept in R2 (workspace/analytics/<days>.json) for 30 minutes, so opening the page is quick
// and the platforms' quotas last; `fresh` asks the platforms again.
import { getJson, putJson } from "./store";
import { getAccount, listAccounts, type Account } from "./publish/accounts";
import * as IG from "./publish/instagram";
import { getRules, listPlans } from "./publish/plans";
import * as YT from "./publish/youtube";
import { getSpaces } from "./spacestore";
import { spaceName, type SpaceId } from "./spaces";
import { listPosts } from "./appwrite";
import { DAY, hashtagsOf, iso, median, msg, report, settle, sum, windows, type Bar, type Kpi, type Range, type Win } from "./analytics-util";
import { AGE, DEVICES, TRAFFIC, ytDeep, ytPost, type PostDetail, type YtDeep } from "./analytics-yt";
import { igDeep, igPost, type IgDeep } from "./analytics-ig";

export { RANGES } from "./analytics-util";
export type { Bar, Daily, Kpi, Range } from "./analytics-util";
export type { PostDetail, YtDeep } from "./analytics-yt";
export type { IgDeep } from "./analytics-ig";

export type Fmt = "yt_video" | "yt_short" | "ig_reel" | "ig_post";
export const FMTS: Fmt[] = ["yt_video", "yt_short", "ig_reel", "ig_post"];
/** What the chart can show: a whole network, or one format of it. */
export type SeriesKey = "youtube" | "instagram" | Fmt;

export type Item = {
  id: string; account: string; network: "youtube" | "instagram"; fmt: Fmt;
  title: string; url: string; thumb: string | null; at: number; duration: number | null;
  views: number | null; reach: number | null; likes: number; comments: number; shares: number | null; saves: number | null;
  /** YouTube: minutes watched, average % of the video watched, average seconds; Instagram Reels: average seconds */
  watch_min: number | null; avg_pct: number | null; avg_s: number | null;
  subs: number | null;
  /** (likes + comments + shares + saves) / views (or reach) */
  er: number | null;
  /** views ÷ the median views of the same format: 1 = a usual post, 3 = three times your usual (the viral signal) */
  score: number | null;
  /** the Voicebox post it went out from, when it went out through Voicebox */
  post: string | null; tags: string[];
};
type Pair = { label: string; value: number | null; prev: number | null };
export type FmtSum = { a: Pair; b: Pair; posts: number; prev_posts: number };
export type AccountSum = {
  id: string; network: "youtube" | "instagram"; name: string; handle: string | null; avatar: string | null;
  followers: number | null; gained: number | null; lost: number | null; prev_gained: number | null; posts: number | null;
};
export type Tip = { tone: "ok" | "warn" | "blue" | "violet"; title: string; body: string; href?: string };
export type Need = { network: "youtube" | "instagram"; text: string; action: "reconnect" | "enable" | "wait" };

export type Analytics = {
  at: number; range: Range; from: string; to: string; tz: string;
  accounts: AccountSum[];
  formats: Partial<Record<Fmt, FmtSum>>;
  /** one value a day from `from` to `to`; prev is the same length, the period before */
  days: string[];
  series: Partial<Record<SeriesKey, { label: string; cur: number[]; prev: number[]; exact: boolean }>>;
  items: Item[];
  /** 7 days (Sun first) × 8 three-hour slots (12 AM first), in the studio's time zone: how posts that went out then did */
  heat: { v: number; n: number }[][];
  heat_metric: string;
  /** the same, per network */
  heat_by: Partial<Record<"youtube" | "instagram", { v: number; n: number }[][]>>;
  /** every platform together: views, engagement, followers, output, with the period before */
  overview: Kpi[];
  /** each platform in depth (one per connected account) */
  youtube: YtDeep[]; instagram: IgDeep[];
  /** followers per account, one point a day, kept by Voicebox (newest last) */
  history: { d: string; f: Record<string, number> }[];
  yt: { traffic: Bar[]; countries: Bar[]; ages: Bar[]; genders: Bar[]; devices: Bar[]; subs_per_1k: number | null; avg_pct: number | null } | null;
  ig: { countries: Bar[]; cities: Bar[]; ages: Bar[]; genders: Bar[]; online: number[] | null; reach: number | null; interactions: number | null } | null;
  lengths: { label: string; n: number; median: number }[];
  tags: { tag: string; n: number; score: number }[];
  rhythm: { space: SpaceId; label: string; week: number; goal: number | null; next7: number; last: number | null }[];
  gaps: string[];
  tips: Tip[];
  needs: Need[];
};

/* ───────────── YouTube */

const isoDur = (d?: string) => {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d ?? "");
  return m ? (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0)) : null;
};
type YtOut = { token: string; analytics: boolean; acc: AccountSum; items: Item[]; series: Partial<Record<SeriesKey, { cur: number[]; prev: number[]; exact: boolean }>>; fmt: Partial<Record<Fmt, FmtSum>>; yt: NonNullable<Analytics["yt"]>; needs: Need[] };

async function youtube(a: Account & { tokens: Parameters<typeof YT.accessToken>[0]["tokens"] }, range: Range, shortsOf: Set<string>): Promise<YtOut> {
  const w = windows(range);
  const needs: Need[] = [];
  const token = await YT.accessToken(a);
  type Ch = { items?: { statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] };
  const ch = (await YT.ytGet<Ch>(`https://www.googleapis.com/youtube/v3/channels?part=statistics,contentDetails&id=${a.id}`, token)).items?.[0];
  const uploads = ch?.contentDetails?.relatedPlaylists?.uploads;

  // the latest uploads (up to 100) and their counts
  const ids: string[] = [];
  let page = "";
  for (let i = 0; uploads && i < 2; i++) {
    const r = await YT.ytGet<{ items?: { contentDetails: { videoId: string } }[]; nextPageToken?: string }>(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${page ? `&pageToken=${page}` : ""}`, token).catch(() => null);
    ids.push(...(r?.items ?? []).map((x) => x.contentDetails.videoId));
    if (!r?.nextPageToken) break;
    page = r.nextPageToken;
  }
  type V = { id: string; snippet: { title: string; publishedAt: string; tags?: string[]; description?: string; thumbnails?: Record<string, { url: string }> }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; contentDetails?: { duration?: string }; status?: { privacyStatus?: string } };
  const vids: V[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await YT.ytGet<{ items: V[] }>(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,status&id=${ids.slice(i, i + 50).join(",")}`, token);
    vids.push(...r.items);
  }

  // per video, all time (watch time, retention, shares, subscribers it brought)
  const per = new Map<string, Record<string, string | number>>();
  let analytics = true;
  try {
    for (const r of await report(token, { startDate: "2006-01-01", endDate: iso(w.end), dimensions: "video", metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,shares,subscribersGained", sort: "-views", maxResults: "200" }))
      per.set(String(r.video), r);
  } catch (e) {
    analytics = false;
    const m = msg(e);
    needs.push(/has not been used|disabled|accessNotConfigured/i.test(m)
      ? { network: "youtube", action: "enable", text: "Turn on the YouTube Analytics API in your Google Cloud project to see watch time, retention, traffic and audience." }
      : /insufficient|scope|permission|forbidden/i.test(m)
        ? { network: "youtube", action: "reconnect", text: `Reconnect ${a.name} so Voicebox can read its analytics (watch time, retention, traffic).` }
        : { network: "youtube", action: "wait", text: `YouTube Analytics didn't answer: ${m}` });
  }

  const items: Item[] = vids.filter((v) => v.status?.privacyStatus !== "private" || per.has(v.id)).map((v) => {
    const s = v.statistics ?? {}, x = per.get(v.id);
    const duration = isoDur(v.contentDetails?.duration);
    const short = shortsOf.has(v.id) || (duration !== null && duration <= 180);
    const views = s.viewCount != null ? Number(s.viewCount) : x ? Number(x.views) : null;
    const likes = Number(s.likeCount ?? 0), comments = Number(s.commentCount ?? 0), shares = x ? Number(x.shares) : null;
    return {
      id: v.id, account: a.id, network: "youtube", fmt: short ? "yt_short" : "yt_video", title: v.snippet.title,
      url: YT.watchUrl(v.id, short), thumb: v.snippet.thumbnails?.medium?.url ?? v.snippet.thumbnails?.default?.url ?? null,
      at: Date.parse(v.snippet.publishedAt), duration, views, reach: null, likes, comments, shares, saves: null,
      watch_min: x ? Number(x.estimatedMinutesWatched) : null, avg_pct: x ? Number(x.averageViewPercentage) : null, avg_s: x ? Number(x.averageViewDuration) : null,
      subs: x ? Number(x.subscribersGained) : null,
      er: views ? (likes + comments + (shares ?? 0)) / views : null, score: null, post: null,
      tags: [...new Set([...(v.snippet.tags ?? []).map((t) => `#${t.toLowerCase().replace(/\s+/g, "")}`), ...hashtagsOf(`${v.snippet.title} ${v.snippet.description ?? ""}`)])].slice(0, 30),
    } satisfies Item;
  });

  // daily, this period and the last, split into Shorts and the rest
  const series: YtOut["series"] = {};
  const fmt: YtOut["fmt"] = {};
  let gained: number | null = null, lost: number | null = null, prevGained: number | null = null;
  const yt: YtOut["yt"] = { traffic: [], countries: [], ages: [], genders: [], devices: [], subs_per_1k: null, avg_pct: null };
  if (analytics) {
    const daily = async (s: number, e: number) => {
      const q = { startDate: iso(s), endDate: iso(e), metrics: "views,estimatedMinutesWatched,likes,comments,shares,subscribersGained,subscribersLost,averageViewPercentage", sort: "day" };
      try { return { split: true, rows: await report(token, { ...q, dimensions: "day,creatorContentType" }) }; }
      catch { return { split: false, rows: await report(token, { ...q, dimensions: "day" }).catch(() => []) }; }
    };
    const [cur, prev] = await Promise.all([daily(w.start, w.end), daily(w.prevStart, w.prevEnd)]);
    const fold = (rows: Record<string, string | number>[], start: number, pick: (r: Record<string, string | number>) => boolean, metric: string) => {
      const out = new Array(range).fill(0);
      for (const r of rows) {
        const i = Math.round((Date.parse(String(r.day)) - start) / DAY);
        if (i >= 0 && i < range && pick(r)) out[i] += Number(r[metric] ?? 0);
      }
      return out;
    };
    const isShort = (r: Record<string, string | number>) => /short/i.test(String(r.creatorContentType ?? ""));
    const all = () => true;
    series.youtube = { cur: fold(cur.rows, w.start, all, "views"), prev: fold(prev.rows, w.prevStart, all, "views"), exact: true };
    if (cur.split) {
      series.yt_short = { cur: fold(cur.rows, w.start, isShort, "views"), prev: fold(prev.rows, w.prevStart, isShort, "views"), exact: true };
      series.yt_video = { cur: fold(cur.rows, w.start, (r) => !isShort(r), "views"), prev: fold(prev.rows, w.prevStart, (r) => !isShort(r), "views"), exact: true };
    }
    const tot = (rows: Record<string, string | number>[], pick: (r: Record<string, string | number>) => boolean, m: string) => sum(rows.filter(pick).map((r) => Number(r[m] ?? 0)));
    const posted = (f: Fmt, s: number, e: number) => items.filter((i) => i.fmt === f && i.at >= s && i.at < e + DAY).length;
    for (const [f, pick] of [["yt_video", (r: Record<string, string | number>) => !isShort(r)], ["yt_short", isShort]] as const) {
      if (!cur.split && f === "yt_short") break;
      const p = cur.split ? pick : all;
      fmt[f] = {
        a: { label: "Views", value: tot(cur.rows, p, "views"), prev: tot(prev.rows, p, "views") },
        b: f === "yt_short"
          ? { label: "Engaged", value: tot(cur.rows, p, "likes") + tot(cur.rows, p, "comments") + tot(cur.rows, p, "shares"), prev: tot(prev.rows, p, "likes") + tot(prev.rows, p, "comments") + tot(prev.rows, p, "shares") }
          : { label: "Watch hours", value: Math.round(tot(cur.rows, p, "estimatedMinutesWatched") / 6) / 10, prev: Math.round(tot(prev.rows, p, "estimatedMinutesWatched") / 6) / 10 },
        posts: posted(f, w.start, w.end), prev_posts: posted(f, w.prevStart, w.prevEnd),
      };
    }
    gained = tot(cur.rows, all, "subscribersGained"); lost = tot(cur.rows, all, "subscribersLost"); prevGained = tot(prev.rows, all, "subscribersGained");
    const views = tot(cur.rows, all, "views");
    yt.subs_per_1k = views ? Math.round(((gained - lost) / views) * 10000) / 10 : null;

    const q = { startDate: iso(w.start), endDate: iso(w.end) };
    const [traffic, countries, demo, devices, overall] = await Promise.all([
      settle(report(token, { ...q, dimensions: "insightTrafficSourceType", metrics: "views", sort: "-views" })),
      settle(report(token, { ...q, dimensions: "country", metrics: "views", sort: "-views", maxResults: "8" })),
      settle(report(token, { ...q, dimensions: "ageGroup,gender", metrics: "viewerPercentage" })),
      settle(report(token, { ...q, dimensions: "deviceType", metrics: "views", sort: "-views" })),
      settle(report(token, { ...q, metrics: "averageViewPercentage" })),
    ]);
    yt.traffic = (traffic ?? []).map((r) => [TRAFFIC[String(r.insightTrafficSourceType)] ?? String(r.insightTrafficSourceType), Number(r.views)] as Bar).filter((b) => b[1] > 0).slice(0, 8);
    yt.countries = (countries ?? []).map((r) => [String(r.country), Number(r.views)] as Bar);
    const ages = new Map<string, number>(), genders = new Map<string, number>();
    for (const r of demo ?? []) {
      ages.set(AGE(String(r.ageGroup)), (ages.get(AGE(String(r.ageGroup))) ?? 0) + Number(r.viewerPercentage));
      const g = String(r.gender) === "female" ? "Women" : String(r.gender) === "male" ? "Men" : "Other";
      genders.set(g, (genders.get(g) ?? 0) + Number(r.viewerPercentage));
    }
    yt.ages = [...ages].sort((x, y) => x[0].localeCompare(y[0])).map(([k, v]) => [k, Math.round(v * 10) / 10]);
    yt.genders = [...genders].map(([k, v]) => [k, Math.round(v * 10) / 10]);
    yt.devices = (devices ?? []).map((r) => [DEVICES[String(r.deviceType)] ?? String(r.deviceType), Number(r.views)] as Bar);
    yt.avg_pct = overall?.[0] ? Math.round(Number(overall[0].averageViewPercentage) * 10) / 10 : null;
  } else {
    // no Analytics API: what the video counts alone can say (lifetime views of what went out in each window)
    for (const f of ["yt_video", "yt_short"] as const) {
      const win = (s: number, e: number) => items.filter((i) => i.fmt === f && i.at >= s && i.at < e + DAY);
      const c = win(w.start, w.end), p = win(w.prevStart, w.prevEnd);
      if (!items.some((i) => i.fmt === f)) continue;
      fmt[f] = { a: { label: "Views", value: sum(c.map((i) => i.views)), prev: sum(p.map((i) => i.views)) }, b: { label: "Likes", value: sum(c.map((i) => i.likes)), prev: sum(p.map((i) => i.likes)) }, posts: c.length, prev_posts: p.length };
      series[f] = byPublishDay(items.filter((i) => i.fmt === f), w, range);
    }
  }
  const acc: AccountSum = {
    id: a.id, network: "youtube", name: a.name, handle: a.handle, avatar: a.avatar,
    followers: ch?.statistics?.subscriberCount != null ? Number(ch.statistics.subscriberCount) : a.subscribers ?? null,
    gained, lost, prev_gained: prevGained, posts: ch?.statistics?.videoCount != null ? Number(ch.statistics.videoCount) : null,
  };
  return { token, acc, items, series, fmt, yt, needs, analytics };
}

/** Views of what went out each day (lifetime), for when there's no daily report. */
function byPublishDay(items: Item[], w: Win, range: Range) {
  const cur = new Array(range).fill(0), prev = new Array(range).fill(0);
  for (const i of items) {
    const d = Math.floor((i.at - w.start) / DAY), p = Math.floor((i.at - w.prevStart) / DAY);
    if (d >= 0 && d < range) cur[d] += i.views ?? i.reach ?? i.likes;
    else if (p >= 0 && p < range) prev[p] += i.views ?? i.reach ?? i.likes;
  }
  return { cur, prev, exact: false };
}

/* ───────────── Instagram */

type IgMedia = { id: string; caption?: string; media_type: string; media_product_type?: string; timestamp: string; permalink: string; thumbnail_url?: string; media_url?: string; like_count?: number; comments_count?: number };
type Insight = { name: string; values?: { value: number | Record<string, number>; end_time?: string }[]; total_value?: { value?: number; breakdowns?: { results?: { dimension_values: string[]; value: number }[] }[] } };
const val = (x?: Insight) => (x?.total_value?.value ?? (typeof x?.values?.[0]?.value === "number" ? (x.values[0].value as number) : null));
const isPerm = (m: string) => /permission|\(#10\)|\(#200\)|scope|not authorized/i.test(m);

type IgOut = { token: string; insights: boolean; acc: AccountSum; items: Item[]; series: YtOut["series"]; fmt: Partial<Record<Fmt, FmtSum>>; ig: NonNullable<Analytics["ig"]>; needs: Need[] };

async function instagram(a: Account & { tokens: Parameters<typeof IG.accessToken>[0]["tokens"] }, range: Range): Promise<IgOut> {
  const w = windows(range);
  const needs: Need[] = [];
  const token = await IG.accessToken(a);
  const me = await IG.igGet<{ followers_count?: number; media_count?: number }>("/me", token, { fields: "followers_count,media_count" }).catch(() => ({} as { followers_count?: number; media_count?: number }));

  const media: IgMedia[] = [];
  let at: { path: string; params: Record<string, string> } | null = { path: `/${a.id}/media`, params: { fields: "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count", limit: "50" } };
  for (let i = 0; at && i < 2; i++) {
    const r: { data?: IgMedia[]; paging?: { next?: string } } = await IG.igGet<{ data?: IgMedia[]; paging?: { next?: string } }>(at.path, token, at.params);
    media.push(...(r.data ?? []));
    // the next page's address carries its own cursor (and the key, which igGet adds back)
    const u: URL | null = r.paging?.next ? new URL(r.paging.next) : null;
    u?.searchParams.delete("access_token");
    at = u ? { path: `${u.origin}${u.pathname}`, params: Object.fromEntries(u.searchParams) } : null;
  }

  // per post insights, for what went out in the last 180 days (older posts barely move)
  let insights = true;
  const ins = new Map<string, Record<string, number>>();
  const recent = media.filter((m) => Date.now() - Date.parse(m.timestamp) < 180 * DAY && m.media_product_type !== "STORY").slice(0, 60);
  for (let i = 0; i < recent.length && insights; i += 10) {
    await Promise.all(recent.slice(i, i + 10).map(async (m) => {
      const reel = m.media_product_type === "REELS";
      const metric = ["reach", "views", "saved", "shares", "total_interactions", ...(reel ? ["ig_reels_avg_watch_time"] : [])].join(",");
      try {
        const r = await IG.igGet<{ data: Insight[] }>(`/${m.id}/insights`, token, { metric });
        ins.set(m.id, Object.fromEntries(r.data.map((d) => [d.name, val(d) ?? 0])));
      } catch (e) {
        if (isPerm(msg(e))) insights = false;
      }
    }));
  }
  if (!insights) needs.push({ network: "instagram", action: "reconnect", text: `Reconnect @${a.handle ?? a.name} and allow insights to see reach, views, saves and shares.` });

  const items: Item[] = media.filter((m) => m.media_product_type !== "STORY").map((m) => {
    const x = ins.get(m.id);
    const reel = m.media_product_type === "REELS" || m.media_type === "VIDEO";
    const likes = m.like_count ?? 0, comments = m.comments_count ?? 0;
    const views = x?.views ?? null, reach = x?.reach ?? null, shares = x ? x.shares ?? 0 : null, saves = x ? x.saved ?? 0 : null;
    const base = views || reach;
    return {
      id: m.id, account: a.id, network: "instagram", fmt: reel ? "ig_reel" : "ig_post", title: (m.caption ?? "").split("\n")[0].slice(0, 120) || (reel ? "Reel" : "Post"),
      url: m.permalink, thumb: m.thumbnail_url ?? (m.media_type !== "VIDEO" ? m.media_url ?? null : null), at: Date.parse(m.timestamp), duration: null,
      views, reach, likes, comments, shares, saves, watch_min: null, avg_pct: null,
      avg_s: x?.ig_reels_avg_watch_time ? Math.round(x.ig_reels_avg_watch_time / 100) / 10 : null, subs: null,
      er: base ? (likes + comments + (shares ?? 0) + (saves ?? 0)) / base : null, score: null, post: null, tags: hashtagsOf(m.caption ?? ""),
    } satisfies Item;
  });

  const fmt: IgOut["fmt"] = {};
  const series: IgOut["series"] = {};
  for (const f of ["ig_reel", "ig_post"] as const) {
    if (!items.some((i) => i.fmt === f)) continue;
    const win = (s: number, e: number) => items.filter((i) => i.fmt === f && i.at >= s && i.at < e + DAY);
    const c = win(w.start, w.end), p = win(w.prevStart, w.prevEnd);
    const eng = (xs: Item[]) => sum(xs.map((i) => i.likes + i.comments + (i.shares ?? 0) + (i.saves ?? 0)));
    fmt[f] = insights
      ? { a: { label: "Views", value: sum(c.map((i) => i.views ?? i.reach)), prev: sum(p.map((i) => i.views ?? i.reach)) }, b: { label: "Engaged", value: eng(c), prev: eng(p) }, posts: c.length, prev_posts: p.length }
      : { a: { label: "Likes", value: sum(c.map((i) => i.likes)), prev: sum(p.map((i) => i.likes)) }, b: { label: "Comments", value: sum(c.map((i) => i.comments)), prev: sum(p.map((i) => i.comments)) }, posts: c.length, prev_posts: p.length };
    series[f] = byPublishDay(items.filter((i) => i.fmt === f), w, range);
  }

  // the account: reach every day, follower changes, audience, when followers are online
  const ig: IgOut["ig"] = { countries: [], cities: [], ages: [], genders: [], online: null, reach: null, interactions: null };
  let gained: number | null = null, prevGained: number | null = null;
  if (insights) {
    const daily = async (metric: string, s: number, e: number) => {
      const out = new Array(range).fill(0);
      // the API takes up to 30 days per call
      for (let t = s; t <= e; t += 30 * DAY) {
        const until = Math.min(e, t + 29 * DAY);
        const r = await IG.igGet<{ data: Insight[] }>(`/${a.id}/insights`, token, { metric, period: "day", since: String(Math.floor(t / 1000)), until: String(Math.floor((until + DAY) / 1000)) }).catch(() => null);
        for (const v of r?.data?.[0]?.values ?? []) {
          const i = Math.round((Date.parse(v.end_time ?? "") - DAY - s) / DAY);
          if (i >= 0 && i < range && typeof v.value === "number") out[i] += v.value;
        }
      }
      return out;
    };
    const total = async (metric: string, s: number, e: number) => {
      let n = 0;
      for (let t = s; t <= e; t += 30 * DAY) {
        const until = Math.min(e, t + 29 * DAY);
        const r = await IG.igGet<{ data: Insight[] }>(`/${a.id}/insights`, token, { metric, period: "day", metric_type: "total_value", since: String(Math.floor(t / 1000)), until: String(Math.floor((until + DAY) / 1000)) }).catch(() => null);
        n += val(r?.data?.[0]) ?? 0;
      }
      return n;
    };
    const [reachCur, reachPrev, interactions, fc, fcPrev] = await Promise.all([
      daily("reach", w.start, w.end), daily("reach", w.prevStart, w.prevEnd), total("total_interactions", w.start, w.end),
      range <= 28 ? daily("follower_count", w.start, w.end) : Promise.resolve(null), range <= 14 ? daily("follower_count", w.prevStart, w.prevEnd) : Promise.resolve(null),
    ]);
    series.instagram = { cur: reachCur, prev: reachPrev, exact: true };
    ig.reach = sum(reachCur); ig.interactions = interactions;
    if (fc) gained = sum(fc);
    if (fcPrev) prevGained = sum(fcPrev);
    const demo = async (breakdown: string) => {
      const r = await IG.igGet<{ data: Insight[] }>(`/${a.id}/insights`, token, { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown }).catch(() => null);
      return (r?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? []).map((x) => [x.dimension_values[0], x.value] as Bar).sort((x, y) => y[1] - x[1]);
    };
    const [countries, cities, ages, genders, online] = await Promise.all([
      demo("country"), demo("city"), demo("age"), demo("gender"),
      IG.igGet<{ data: Insight[] }>(`/${a.id}/insights`, token, { metric: "online_followers", period: "lifetime" }).catch(() => null),
    ]);
    ig.countries = countries.slice(0, 8); ig.cities = cities.slice(0, 8);
    ig.ages = ages.sort((x, y) => x[0].localeCompare(y[0]));
    ig.genders = genders.map(([k, v]) => [k === "F" ? "Women" : k === "M" ? "Men" : "Other", v] as Bar);
    const hours = online?.data?.[0]?.values?.at(-1)?.value;
    if (hours && typeof hours === "object" && Object.keys(hours).length) ig.online = Array.from({ length: 24 }, (_, h) => Number((hours as Record<string, number>)[String(h)] ?? 0));
  }
  const acc: AccountSum = {
    id: a.id, network: "instagram", name: a.name, handle: a.handle, avatar: a.avatar,
    followers: me.followers_count ?? a.subscribers ?? null, gained, lost: null, prev_gained: prevGained, posts: me.media_count ?? null,
  };
  return { token, insights, acc, items, series, fmt, ig, needs };
}

/* ───────────── putting it together */

const LENGTHS: [string, number][] = [["Under 15 s", 15], ["15–30 s", 30], ["30–60 s", 60], ["1–3 min", 180], ["3–10 min", 600], ["10–20 min", 1200], ["20 min +", Infinity]];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOT = (i: number) => ["12 AM", "3 AM", "6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"][i];
const NAMES: Record<Fmt, string> = { yt_video: "long videos", yt_short: "Shorts", ig_reel: "Reels", ig_post: "feed posts" };

function zoned(t: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(t));
  return { day: DAYS.indexOf(p.find((x) => x.type === "weekday")?.value ?? "Sun"), hour: Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24 };
}

function sumSeries(xs: ({ cur: number[]; prev: number[]; exact: boolean } | undefined)[], range: Range) {
  const got = xs.filter(Boolean) as { cur: number[]; prev: number[]; exact: boolean }[];
  if (!got.length) return undefined;
  return { cur: Array.from({ length: range }, (_, i) => sum(got.map((s) => s.cur[i]))), prev: Array.from({ length: range }, (_, i) => sum(got.map((s) => s.prev[i]))), exact: got.every((s) => s.exact) };
}

export async function buildAnalytics(range: Range): Promise<Analytics> {
  const w = windows(range);
  const [accounts, plans, rules, spaces] = await Promise.all([listAccounts(), listPlans().catch(() => []), getRules(), getSpaces().catch(() => ({ posts: {} as Record<string, never[]>, goals: {} as Partial<Record<SpaceId, number>> }))]);
  const tz = rules.tz || "UTC";
  const byResult = new Map(plans.filter((p) => p.result?.id).map((p) => [p.result!.id, p]));
  const shortsOf = new Set(plans.filter((p) => p.space === "yt_short" && p.result?.id).map((p) => p.result!.id));

  const out: Analytics = {
    at: Date.now(), range, from: iso(w.start), to: iso(w.end), tz, accounts: [], formats: {}, days: w.days, series: {}, items: [],
    heat: [], heat_metric: "", heat_by: {}, overview: [], youtube: [], instagram: [], history: [],
    yt: null, ig: null, lengths: [], tags: [], rhythm: [], gaps: [], tips: [], needs: [],
  };
  // each platform in depth runs once the posts are scored
  const deep: (() => Promise<void>)[] = [];
  const parts: Partial<Record<SeriesKey, { cur: number[]; prev: number[]; exact: boolean }>>[] = [];
  const fmts: Partial<Record<Fmt, FmtSum>>[] = [];
  await Promise.all(accounts.map(async (acc) => {
    const a = await getAccount(acc.id);
    if (!a) return;
    try {
      if (a.network === "youtube") {
        const r = await youtube(a, range, shortsOf);
        out.accounts.push(r.acc); out.items.push(...r.items); parts.push(r.series); fmts.push(r.fmt); out.needs.push(...r.needs);
        out.yt = out.yt ?? r.yt;
        if (r.analytics) deep.push(async () => { out.youtube.push(await ytDeep(r.token, r.acc, r.items, w, range)); });
      } else {
        const r = await instagram(a, range);
        out.accounts.push(r.acc); out.items.push(...r.items); parts.push(r.series); fmts.push(r.fmt); out.needs.push(...r.needs);
        out.ig = out.ig ?? r.ig;
        if (r.insights) deep.push(async () => { out.instagram.push(await igDeep(r.token, r.acc, r.items, w, range)); });
      }
    } catch (e) {
      out.accounts.push({ id: a.id, network: a.network, name: a.name, handle: a.handle, avatar: a.avatar, followers: a.subscribers ?? null, gained: null, lost: null, prev_gained: null, posts: null });
      out.needs.push({ network: a.network, action: /reconnect|expired|revoked/i.test(msg(e)) ? "reconnect" : "wait", text: `${a.name}: ${msg(e)}` });
    }
  }));
  out.accounts.sort((x, y) => x.network.localeCompare(y.network) || x.name.localeCompare(y.name) * -1);

  // several accounts on one network add up
  for (const f of FMTS) {
    const got = fmts.map((m) => m[f]).filter(Boolean) as FmtSum[];
    if (!got.length) continue;
    const add = (k: "a" | "b") => ({ label: got[0][k].label, value: sum(got.map((g) => g[k].value)), prev: sum(got.map((g) => g[k].prev)) });
    out.formats[f] = { a: add("a"), b: add("b"), posts: sum(got.map((g) => g.posts)), prev_posts: sum(got.map((g) => g.prev_posts)) };
  }
  const LABEL: Record<SeriesKey, string> = { youtube: "YouTube views", instagram: "Instagram reach", yt_video: "Video views", yt_short: "Shorts views", ig_reel: "Reels views", ig_post: "Post views" };
  for (const k of ["youtube", "yt_video", "yt_short", "instagram", "ig_reel", "ig_post"] as SeriesKey[]) {
    const s = sumSeries(parts.map((p) => p[k]), range);
    if (s) out.series[k] = { label: LABEL[k], ...s };
  }

  // the viral signal: each post against the usual for its format
  for (const f of FMTS) {
    const xs = out.items.filter((i) => i.fmt === f);
    const base = median(xs.map((i) => i.views ?? i.reach ?? i.likes).filter((v) => v > 0));
    if (xs.length >= 3 && base > 0) for (const i of xs) i.score = Math.round(((i.views ?? i.reach ?? i.likes) / base) * 100) / 100;
  }
  for (const i of out.items) i.post = byResult.get(i.id)?.post ?? null;
  out.items.sort((x, y) => y.at - x.at);

  // when to post: how posts that went out in each slot did (the viral signal, else engagement)
  const scored = out.items.some((i) => i.score !== null);
  out.heat_metric = scored ? "times your usual views" : "engagements";
  const heatOf = (items: Item[]) => {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => ({ t: 0, n: 0 })));
    for (const i of items) {
      const z = zoned(i.at, tz);
      const v = scored ? i.score : i.likes + i.comments + (i.shares ?? 0) + (i.saves ?? 0);
      if (v == null) continue;
      cells[z.day][Math.floor(z.hour / 3)].t += v; cells[z.day][Math.floor(z.hour / 3)].n++;
    }
    return cells.map((r) => r.map((c) => ({ v: c.n ? Math.round((c.t / c.n) * 100) / 100 : 0, n: c.n })));
  };
  out.heat = heatOf(out.items);
  for (const n of ["youtube", "instagram"] as const) if (out.items.some((i) => i.network === n)) out.heat_by[n] = heatOf(out.items.filter((i) => i.network === n));

  await Promise.all(deep.map((f) => f().catch(() => null)));
  out.youtube.sort((a, b) => a.account.name.localeCompare(b.account.name));
  out.instagram.sort((a, b) => a.account.name.localeCompare(b.account.name));
  out.overview = overviewOf(out, w);
  out.history = await keepHistory(out.accounts);

  // what length works (video, any network that tells the length)
  const timed = out.items.filter((i) => i.duration && (i.views ?? 0) > 0);
  let lo = 0;
  for (const [label, hi] of LENGTHS) {
    const xs = timed.filter((i) => i.duration! > lo && i.duration! <= hi);
    if (xs.length) out.lengths.push({ label, n: xs.length, median: Math.round(median(xs.map((i) => i.views!))) });
    lo = hi;
  }

  // hashtags and tags that go with your best posts (used at least twice)
  const tagMap = new Map<string, number[]>();
  for (const i of out.items) if (i.score !== null) for (const t of i.tags) tagMap.set(t, [...(tagMap.get(t) ?? []), i.score]);
  out.tags = [...tagMap].filter(([, s]) => s.length >= 2).map(([tag, s]) => ({ tag, n: s.length, score: Math.round(median(s) * 100) / 100 })).sort((a, b) => b.score - a.score).slice(0, 12);

  // the studio's rhythm: posted this week vs the goal, booked for the next 7 days, and the empty days ahead
  const now = Date.now();
  const targets = Object.values(spaces.posts).flat();
  const pubSpaces: SpaceId[] = ["yt_video", "yt_short", "ig_reel", "ig_post", "ig_story"];
  const live = out.items;
  for (const s of pubSpaces) {
    const goal = spaces.goals[s] ?? null;
    const mine = targets.filter((t) => t.space === s);
    const fromLive = s === "ig_story" ? [] : live.filter((i) => i.fmt === s);
    const week = Math.max(mine.filter((t) => t.status === "posted" && t.posted_at && now - Date.parse(t.posted_at) < 7 * DAY).length, fromLive.filter((i) => now - i.at < 7 * DAY).length);
    const next7 = mine.filter((t) => t.status !== "posted" && t.due_at && Date.parse(t.due_at) > now && Date.parse(t.due_at) - now < 7 * DAY).length;
    const last = Math.max(0, ...fromLive.map((i) => i.at), ...mine.filter((t) => t.posted_at).map((t) => Date.parse(t.posted_at!))) || null;
    if (goal || week || next7 || last) out.rhythm.push({ space: s, label: spaceName(s), week, goal, next7, last });
  }
  const booked = new Set(targets.filter((t) => t.status !== "posted" && t.due_at).map((t) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t.due_at!))));
  for (let d = 0; d < 7; d++) {
    const t = now + d * DAY;
    if (!booked.has(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t)))) out.gaps.push(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(t)));
  }

  out.tips = tipsFor(out, rules.crosspost.length > 0, await listPosts({ limit: 100 }).catch(() => []));
  return out;
}

/** Every platform together, for the overview scorecard (and for an AI deciding where to put effort). */
function overviewOf(a: Analytics, w: Win): Kpi[] {
  const kp = (deep: { kpis: Kpi[] }[], key: string, which: "value" | "prev") => {
    const got = deep.map((d) => d.kpis.find((k) => k.key === key)?.[which]).filter((v) => v != null) as number[];
    return got.length ? sum(got) : null;
  };
  const both = (yk: string, ik: string, which: "value" | "prev") => {
    const y = kp(a.youtube, yk, which), i = kp(a.instagram, ik, which);
    return y == null && i == null ? null : (y ?? 0) + (i ?? 0);
  };
  // without the deep reports, what the format cards know
  const fmtViews = (which: "value" | "prev") => sum(Object.values(a.formats).map((f) => (f!.a.label === "Views" ? f!.a[which] : 0)));
  const views = both("views", "views", "value") ?? fmtViews("value"), pViews = both("views", "views", "prev") ?? fmtViews("prev");
  const eng = (which: "value" | "prev") => {
    const y = ["likes", "comments", "shares"].map((k) => kp(a.youtube, k, which)), i = kp(a.instagram, "interactions", which);
    return y.every((v) => v == null) && i == null ? null : sum(y) + (i ?? 0);
  };
  const followers = sum(a.accounts.map((x) => x.followers));
  const net = sum(a.accounts.map((x) => (x.gained ?? 0) - (x.lost ?? 0)));
  const posted = (s: number, e: number) => a.items.filter((i) => i.at >= s && i.at < e + DAY).length;
  const score = (s: number, e: number) => { const xs = a.items.filter((i) => i.at >= s && i.at < e + DAY && i.score != null).map((i) => i.score!); return xs.length ? median(xs) : null; };
  const hits = (s: number, e: number) => a.items.filter((i) => i.at >= s && i.at < e + DAY && (i.score ?? 0) >= 2).length;
  const r = (v: number | null, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
  const e = eng("value"), pe = eng("prev");
  const nonF = kp(a.instagram, "non_follower_reach", "value");
  const out: Kpi[] = [
    { key: "views", label: "Views, every platform", group: "Reach", value: views, prev: pViews, about: "YouTube views plus Instagram views." },
    { key: "reach", label: "Instagram accounts reached", group: "Reach", value: kp(a.instagram, "reach", "value"), prev: kp(a.instagram, "reach", "prev"), about: "Unique Instagram accounts that saw something." },
    { key: "non_follower", label: "Instagram reach from non-followers", group: "Reach", value: nonF, prev: null, unit: "pct", about: "How far past your followers Instagram is taking you." },
    { key: "watch_h", label: "YouTube watch hours", group: "Reach", value: kp(a.youtube, "watch_h", "value"), prev: kp(a.youtube, "watch_h", "prev"), unit: "h", about: "Hours watched on YouTube." },
    { key: "engagements", label: "Engagements", group: "Engagement", value: e, prev: pe, about: "YouTube likes, comments and shares plus Instagram interactions." },
    { key: "er", label: "Engagement rate", group: "Engagement", value: r(e != null && views ? (e / views) * 100 : null, 2), prev: r(pe != null && pViews ? (pe / pViews) * 100 : null, 2), unit: "pct", about: "Engagements ÷ views across platforms." },
    { key: "shares", label: "Shares", group: "Engagement", value: both("shares", "shares", "value"), prev: both("shares", "shares", "prev"), about: "Shares on both platforms: the clearest sign content travels." },
    { key: "followers", label: "Followers, every platform", group: "Growth", value: followers, prev: null, about: "YouTube subscribers plus Instagram followers." },
    { key: "net", label: "Net new followers", group: "Growth", value: a.accounts.some((x) => x.gained != null) ? net : null, prev: a.accounts.some((x) => x.prev_gained != null) ? sum(a.accounts.map((x) => x.prev_gained)) : null, about: "Gained minus lost, every platform (Instagram unfollows are counted on its own tab)." },
    { key: "posts", label: "Posts published", group: "Output", value: posted(w.start, w.end), prev: posted(w.prevStart, w.prevEnd), about: "Everything that went out on a connected account." },
    { key: "median_score", label: "Median score of new posts", group: "Output", value: r(score(w.start, w.end), 2), prev: r(score(w.prevStart, w.prevEnd), 2), unit: "x", about: "How the period's posts did against your usual: above 1 means the new work beats the old." },
    { key: "hits", label: "Posts that took off (2× or more)", group: "Output", value: hits(w.start, w.end), prev: hits(w.prevStart, w.prevEnd), about: "Posts with at least twice your usual views." },
  ];
  return out.filter((k) => k.value != null);
}

const HISTORY = "workspace/analytics/history.json";
/** Followers per account, one point a day (the latest reading of the day wins), two years at most. */
async function keepHistory(accounts: AccountSum[]) {
  const h = (await getJson<{ d: string; f: Record<string, number> }[]>(HISTORY).catch(() => null)) ?? [];
  const today = iso(Date.now());
  const f = Object.fromEntries(accounts.filter((x) => x.followers != null).map((x) => [x.id, x.followers!]));
  if (!Object.keys(f).length) return h;
  const last = h.at(-1);
  if (last?.d === today) last.f = { ...last.f, ...f }; else h.push({ d: today, f });
  const kept = h.slice(-730);
  await putJson(HISTORY, kept).catch(() => null);
  return kept;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const times = (n: number) => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}×`;

/** What the numbers say to do next, the strongest first. */
function tipsFor(a: Analytics, crossposting: boolean, posts: { status: string }[]): Tip[] {
  const tips: Tip[] = [];
  const med = (f: Fmt) => median(a.items.filter((i) => i.fmt === f).map((i) => i.views ?? i.reach ?? 0).filter((v) => v > 0));
  const vs = (x: Fmt, y: Fmt) => {
    const mx = med(x), my = med(y);
    if (mx && my && mx / my >= 1.5) tips.push({ tone: "blue", title: `${NAMES[x][0].toUpperCase()}${NAMES[x].slice(1)} get ${times(mx / my)} the views of ${NAMES[y]}`, body: `Your usual ${NAMES[x].replace(/s$/, "")} reaches ${Math.round(mx).toLocaleString()}; your usual ${NAMES[y].replace(/s$/, "")}, ${Math.round(my).toLocaleString()}. Cut more of your long ideas into ${NAMES[x]}.` });
  };
  vs("yt_short", "yt_video"); vs("ig_reel", "ig_post"); vs("yt_video", "yt_short"); vs("ig_post", "ig_reel");

  const top = [...a.items].filter((i) => i.score !== null && i.score >= 2).sort((x, y) => y.score! - x.score!)[0];
  if (top) tips.push({ tone: "ok", title: `“${top.title.slice(0, 60)}” did ${times(top.score!)} your usual`, body: `Make a follow-up while it's fresh: same hook, a new angle, and link back to it.${top.shares ? ` ${top.shares.toLocaleString()} people shared it, the strongest sign a topic travels.` : ""}`, href: top.url });

  let best = { d: -1, s: -1, v: 0 };
  a.heat.forEach((r, d) => r.forEach((c, s) => { if (c.n >= 2 && c.v > best.v) best = { d, s, v: c.v }; }));
  if (best.d >= 0) tips.push({ tone: "violet", title: `Post on ${DAYS[best.d]} around ${SLOT(best.s)}`, body: `Posts that went out ${DAYS[best.d]} ${SLOT(best.s)}–${SLOT((best.s + 1) % 8)} did best (${a.heat_metric === "engagements" ? `${Math.round(best.v)} engagements` : `${times(best.v)} your usual`}). Set a posting slot there in Posts → Autopilot.`, href: "/posts?view=autopilot" });
  if (a.ig?.online) {
    const h = a.ig.online.indexOf(Math.max(...a.ig.online));
    tips.push({ tone: "violet", title: `Your Instagram followers are most online at ${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`, body: "Instagram reports this in Pacific time. Post Reels about an hour before the peak so they've picked up early likes when everyone arrives." });
  }

  const shorts = a.items.filter((i) => i.fmt === "yt_short" && i.avg_pct !== null);
  if (shorts.length >= 3) {
    const m = median(shorts.map((i) => i.avg_pct!));
    tips.push(m < 70
      ? { tone: "warn", title: `People watch ${Math.round(m)}% of your Shorts`, body: "Shorts that spread are watched to the end and looped (often over 90%). Open on the payoff in the first second, cut every pause, and end on a line that loops back to the start." }
      : { tone: "ok", title: `People watch ${Math.round(m)}% of your Shorts`, body: "That's strong retention. Keep the pacing and test longer hooks or a series format to build binge views." });
  }
  const vids = a.items.filter((i) => i.fmt === "yt_video" && i.avg_pct !== null);
  if (vids.length >= 2) {
    const m = median(vids.map((i) => i.avg_pct!));
    if (m < 40) tips.push({ tone: "warn", title: `Viewers watch ${Math.round(m)}% of your long videos`, body: "Tighten the first 30 seconds: show the end result first, skip the intro, and add a reason to stay (\"the last tip is the one that…\")." });
  }
  const best1 = a.lengths.length >= 2 ? [...a.lengths].sort((x, y) => y.median - x.median)[0] : null;
  if (best1) tips.push({ tone: "blue", title: `${best1.label} is your sweet spot`, body: `Your ${best1.label.toLowerCase()} videos get a median of ${best1.median.toLocaleString()} views, more than any other length.` });
  if (a.tags[0] && a.tags[0].score >= 1.3) tips.push({ tone: "blue", title: `${a.tags[0].tag} goes with your best posts`, body: `Posts with it do ${times(a.tags[0].score)} your usual (${a.tags[0].n} posts). Use it where it fits; three to five focused tags beat thirty.` });

  const ig = a.items.filter((i) => i.network === "instagram" && i.saves !== null && (i.views || i.reach));
  if (ig.length >= 3) {
    const saveRate = median(ig.map((i) => (i.saves! + (i.shares ?? 0)) / (i.views || i.reach!)));
    if (saveRate < 0.01) tips.push({ tone: "warn", title: "Few people save or share your Instagram posts", body: `About ${pct(saveRate)} do. Saves and sends to friends are what push a Reel to non-followers: give a checklist, a tip worth keeping, or a line people want to send.` });
  }
  if (a.yt?.subs_per_1k != null && a.yt.subs_per_1k < 2 && a.formats.yt_video?.a.value) tips.push({ tone: "warn", title: `${a.yt.subs_per_1k} new subscribers per 1,000 views`, body: "Tell viewers what the channel gives them next (\"every week I…\") and end with a link to your best video, so viewers turn into subscribers." });
  if (a.yt?.traffic.length) {
    const t = a.yt.traffic[0], all = sum(a.yt.traffic.map((x) => x[1]));
    if (all) tips.push({ tone: "blue", title: `${t[0]} brings ${pct(t[1] / all)} of your YouTube views`, body: t[0] === "YouTube search" ? "Search is working: put the exact phrase people type in the title's first words and the first line of the description." : t[0].startsWith("Shorts") ? "The Shorts feed is your engine. Pin a comment and link a related long video so Shorts viewers find the rest." : t[0].startsWith("Suggested") || t[0].startsWith("Browse") ? "YouTube is recommending you. Titles and thumbnails that promise one clear thing win the click here." : "Look at what's driving it and lean in." });
  }

  for (const r of a.rhythm) {
    if (r.goal && r.week < r.goal) tips.push({ tone: "warn", title: `${r.goal - r.week} more ${r.label} to hit this week's goal`, body: `${r.week} of ${r.goal} out in the last 7 days${r.next7 ? `, ${r.next7} booked` : ", nothing booked yet"}. Consistency is what the feeds reward most.`, href: "/posts" });
    else if (r.last && Date.now() - r.last > 5 * DAY && r.space !== "ig_story") tips.push({ tone: "warn", title: `Nothing on ${r.label} for ${Math.floor((Date.now() - r.last) / DAY)} days`, body: "Accounts that post steadily get shown more. Pick something from Ideas and book it.", href: "/posts" });
  }
  if (a.gaps.length >= 4) tips.push({ tone: "warn", title: `${a.gaps.length} of the next 7 days have nothing booked`, body: `Open days: ${a.gaps.slice(0, 5).join(", ")}${a.gaps.length > 5 ? "…" : ""}. Book from your ${posts.filter((p) => p.status === "idea" || p.status === "draft").length || "list of"} ideas and drafts.`, href: "/posts?view=calendar" });
  const nets = new Set(a.accounts.map((x) => x.network));
  if (!crossposting && nets.has("youtube") && nets.has("instagram")) tips.push({ tone: "violet", title: "Cross-post Shorts to Reels", body: "The same vertical video can win twice. Add a rule in Posts → Autopilot: when a Short goes live, post it as a Reel 2 h later.", href: "/posts?view=autopilot" });
  return tips.slice(0, 12);
}

const KEY = (r: Range) => `workspace/analytics/${r}.json`;
const FRESH_MS = 30 * 60_000;

/** The report for a range: the kept one while it's under 30 minutes old, else a new one (kept for next time). */
export async function getAnalytics(range: Range, fresh = false): Promise<Analytics & { cached: boolean }> {
  if (!fresh) {
    const kept = await getJson<Analytics>(KEY(range)).catch(() => null);
    if (kept && Date.now() - kept.at < FRESH_MS) return { ...kept, cached: true };
  }
  const a = await buildAnalytics(range);
  await putJson(KEY(range), a).catch(() => null);
  return { ...a, cached: false };
}

/** One post in depth (YouTube: retention curve, views by day since upload, traffic; Instagram: every metric for its
 *  type), kept 30 minutes. `id` is the platform's id for it, as in Analytics.items. */
export async function getPostDetail(network: "youtube" | "instagram", id: string, fresh = false): Promise<PostDetail> {
  const key = `workspace/analytics/posts/${network}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
  if (!fresh) {
    const kept = await getJson<PostDetail & { kept: number }>(key).catch(() => null);
    if (kept && Date.now() - kept.kept < FRESH_MS) return kept;
  }
  const report28 = await getJson<Analytics>(KEY(28)).catch(() => null);
  const item = report28?.items.find((i) => i.id === id && i.network === network);
  const accounts = (await listAccounts()).filter((a) => a.network === network && (!item || a.id === item.account));
  let last: unknown = new Error(`No ${network === "youtube" ? "YouTube channel" : "Instagram account"} connected`);
  for (const acc of accounts) {
    const a = await getAccount(acc.id);
    if (!a) continue;
    try {
      const d = network === "youtube" ? await ytPost(await YT.accessToken(a), id, item) : await igPost(await IG.accessToken(a), id, item);
      await putJson(key, { ...d, kept: Date.now() }).catch(() => null);
      return d;
    } catch (e) { last = e; }
  }
  throw last;
}
