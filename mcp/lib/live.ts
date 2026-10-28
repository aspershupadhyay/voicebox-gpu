// Live numbers (Grow → Live and Competitors): a check every minute, driven by a Cloudflare cron that knocks on
// /api/cron/live (and by the Live page itself while it is open). Each check reads the public counters of every post
// younger than 72 hours, yours and your rivals' (one YouTube call covers 50 videos, so a minute costs 1 quota unit),
// and keeps the points in one R2 file (workspace/live/state.json). When a post turns 72 hours old its curve (views at
// 15 min, 30 min, 1 h … 72 h) is kept, and those curves become "your usual post at the same age" that a new post is
// drawn against. Every few minutes it also reads subscriber counts; every 10 minutes it looks for new uploads; every
// 3 hours it reads each channel's last 50 uploads, which give the outlier feed (a video beating its channel's usual).
// Rivals are public numbers only: YouTube rounds their subscriber counts, and watch time, retention and CTR stay private.
// Instagram rivals need Facebook Login (Business Discovery), which the Instagram Login connection here doesn't have.
import { getAccount, listAccounts } from "./publish/accounts";
import * as IG from "./publish/instagram";
import * as YT from "./publish/youtube";
import { getJson, putJson } from "./store";
import type { Fmt } from "./analytics";
import { median } from "./analytics-util";
import { AGES, bandAt, type Band, type Chan, type Curve, type LiveChan, type LivePost, type LiveState, type LiveView, type Net, type Pt, type Rival, type Track, type Verdict, type Vid } from "./live-shared";

export * from "./live-shared";
const rkey = (r: Pick<Rival, "net" | "handle">) => `${r.net}:${r.handle.toLowerCase()}`;

const KEY = "workspace/live/state.json";
const RIVALS = "workspace/live/rivals.json";
const LOCK = "workspace/live/running.json";
const MIN = 60_000, H = 3600_000;
/** How long a post is followed minute by minute. */
export const WINDOW_H = 72;
/** YouTube Data API: 10,000 units a day for the whole project (publishing and analytics included); live stays under this. */
const BUDGET = 5000;

export const DEFAULT_RIVALS: Rival[] = [
  ...["@TwoMinutePapers", "@mreflow", "@nicksaraev", "@VarunMayya", "@nateherk"].map((handle) => ({ handle, net: "youtube" as const, pinned: true })),
  ...["varunmayya", "nick_saraev", "mreflow", "anshmehra.in"].map((handle) => ({ handle, net: "instagram" as const, pinned: false })),
];

const empty = (): LiveState => ({ v: 1, at: 0, runs: 0, quota: { day: "", units: 0 }, found: {}, chans: {}, tracks: {}, curves: [], errors: [] });
export async function loadLive(): Promise<LiveState> {
  const s = await getJson<LiveState>(KEY).catch(() => null);
  return s?.v === 1 ? { ...empty(), ...s } : empty();
}
/** The rivals you follow (their own small file, so an edit never races a check). */
export async function loadRivals(): Promise<Rival[]> {
  return (await getJson<Rival[]>(RIVALS).catch(() => null)) ?? DEFAULT_RIVALS;
}

const minute = (t = Date.now()) => Math.floor(t / MIN);
const pacific = () => new Date(Date.now() - 8 * H).toISOString().slice(0, 10); // the quota resets at midnight Pacific
const isoDur = (d?: string) => {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d ?? "");
  return m ? (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0)) : null;
};
/** Shorts can run to 3 minutes; the Data API doesn't say which is which, so length decides. */
const ytFmt = (dur: number | null): Fmt => (dur !== null && dur <= 180 ? "yt_short" : "yt_video");

type YV = { id: string; snippet: { title: string; publishedAt: string; channelId: string; thumbnails?: Record<string, { url: string }> }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; contentDetails?: { duration?: string } };
type YC = { id: string; snippet?: { title: string; customUrl?: string; thumbnails?: Record<string, { url: string }> }; statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } };
const API = "https://www.googleapis.com/youtube/v3";

/** Thin a post's points as it ages: every minute for 6 hours, every 5 minutes to a day, every 15 after. */
function thin(pts: Pt[], at: number) {
  const out: Pt[] = [];
  for (const p of pts) {
    const age = p[0] - minute(at);
    const step = age < 360 ? 1 : age < 1440 ? 5 : 15;
    const last = out.at(-1);
    if (last && p[0] - last[0] < step && p !== pts.at(-1)) continue;
    out.push(p);
  }
  return out;
}

/** Views at a given age (minutes) from a post's points, straight-line between checks; null before the first one. */
export function viewsAt(pts: Pt[], at: number, age: number): number | null {
  const m = minute(at) + age;
  if (!pts.length || pts[0][0] > m + 2) return null;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] >= m) {
      const [a, b] = [pts[i - 1], pts[i]];
      return Math.round(a[1] + ((b[1] - a[1]) * (m - a[0])) / Math.max(1, b[0] - a[0]));
    }
  }
  return pts.at(-1)![0] >= m - 2 ? pts.at(-1)![1] : null;
}

function point(t: Track, views: number, likes: number, comments: number) {
  const now = minute();
  const last = t.pts.at(-1);
  if (last && last[0] === now) { t.pts[t.pts.length - 1] = [now, views, likes, comments]; return; }
  t.pts.push([now, views, likes, comments]);
  t.pts = thin(t.pts, t.at);
}

/** One check. `n` is the run number: some reads happen every run, others every few. */
export async function tick(budgetMs = 45_000): Promise<{ ran: boolean; at: number; tracks: number; units: number; errors: string[] }> {
  const started = Date.now();
  const lock = await getJson<{ at: number }>(LOCK).catch(() => null);
  if (lock && started - lock.at < 50_000) return { ran: false, at: lock.at, tracks: 0, units: 0, errors: [] };
  await putJson(LOCK, { at: started });
  const [s, rivals] = await Promise.all([loadLive(), loadRivals()]);
  const errors: string[] = [];
  const note = (where: string, e: unknown) => errors.push(`${where}: ${(e as Error)?.message ?? e}`);
  if (s.quota.day !== pacific()) s.quota = { day: pacific(), units: 0 };
  let units = 0;
  const spend = (n: number) => { units += n; s.quota.units += n; };
  const n = s.runs++;
  const every = (k: number) => n % k === 0;
  const left = () => budgetMs - (Date.now() - started);

  try {
    const accounts = await listAccounts();
    const ytAccs = accounts.filter((a) => a.network === "youtube"), ytAcc = ytAccs[0];
    const own = new Set(accounts.map((a) => a.id));
    const igAccs = accounts.filter((a) => a.network === "instagram");
    let yt: string | null = null;
    if (ytAcc) {
      try { const a = await getAccount(ytAcc.id); if (a) yt = await YT.accessToken(a); } catch (e) { note("YouTube", e); }
    }
    const thrifty = s.quota.units > BUDGET; // past the day's share: every 5 minutes instead of every minute

    // ── YouTube: your channel and your rivals'
    if (yt && (!thrifty || every(5))) {
      const get = <T>(path: string) => { spend(1); return YT.ytGet<T>(`${API}/${path}`, yt!); };
      // rivals named by @handle: find their channel once
      for (const r of rivals.filter((r) => r.net === "youtube" && !s.found[rkey(r)]?.id && left() > 20_000)) {
        const was = s.found[rkey(r)];
        if (was?.error && !every(60)) continue; // a handle YouTube didn't know: ask again hourly
        try {
          const c = (await get<{ items?: YC[] }>(`channels?part=id&forHandle=${encodeURIComponent(r.handle)}`)).items?.[0];
          s.found[rkey(r)] = { id: c?.id ?? null, error: c ? null : "YouTube doesn't know this handle" };
        } catch (e) { s.found[rkey(r)] = { id: null, error: (e as Error).message }; }
      }
      const ids = [...new Set([...ytAccs.map((a) => a.id), ...rivals.filter((r) => r.net === "youtube").map((r) => s.found[rkey(r)]?.id).filter((x): x is string => !!x)])];
      for (const id of Object.keys(s.chans)) if (s.chans[id].net === "youtube" && !ids.includes(id)) delete s.chans[id];
      for (const t of Object.values(s.tracks)) if (t.net === "youtube" && !ids.includes(t.owner)) delete s.tracks[t.id];
      // channel counts, every 5 minutes (and at once for a channel just added)
      if (every(5) || ids.some((id) => !s.chans[id])) {
        try {
          const cs = (await get<{ items?: YC[] }>(`channels?part=snippet,statistics,contentDetails&id=${ids.join(",")}`)).items ?? [];
          for (const c of cs) {
            const ch: Chan = s.chans[c.id] ?? { id: c.id, net: "youtube", rival: !own.has(c.id), name: "", handle: null, avatar: null, uploads: null, subs: null, views: null, videos: null, pts: [], recent: [], recent_at: 0 };
            ch.name = c.snippet?.title ?? ch.name; ch.handle = c.snippet?.customUrl ?? ch.handle;
            ch.avatar = c.snippet?.thumbnails?.medium?.url ?? c.snippet?.thumbnails?.default?.url ?? ch.avatar;
            ch.uploads = c.contentDetails?.relatedPlaylists?.uploads ?? ch.uploads;
            const st = c.statistics ?? {};
            ch.subs = st.subscriberCount != null ? Number(st.subscriberCount) : ch.subs;
            ch.views = st.viewCount != null ? Number(st.viewCount) : ch.views;
            ch.videos = st.videoCount != null ? Number(st.videoCount) : ch.videos;
            ch.pts.push([minute(), ch.subs ?? 0, ch.views ?? 0]);
            // every 5 minutes for 2 days, then one an hour, for 90 days
            ch.pts = ch.pts.filter((p, i, all) => minute() - p[0] < 2880 || (minute() - p[0] < 90 * 1440 && (i === 0 || Math.floor(p[0] / 60) !== Math.floor(all[i - 1][0] / 60))));
            s.chans[c.id] = ch;
          }
        } catch (e) { note("YouTube channels", e); }
      }
      // the last 50 uploads with counts, every 3 hours per channel (one channel a run, so a run stays small)
      const due = ids.map((id) => s.chans[id]).filter((c) => c?.uploads && Date.now() - c.recent_at > 3 * H).sort((a, b) => a.recent_at - b.recent_at)[0];
      if (due && left() > 15_000) {
        try {
          const pl = await get<{ items?: { contentDetails: { videoId: string } }[] }>(`playlistItems?part=contentDetails&maxResults=50&playlistId=${due.uploads}`);
          const vids = (await get<{ items?: YV[] }>(`videos?part=snippet,statistics,contentDetails&id=${(pl.items ?? []).map((x) => x.contentDetails.videoId).join(",")}`)).items ?? [];
          due.recent = vids.map((v) => {
            const dur = isoDur(v.contentDetails?.duration);
            return { id: v.id, title: v.snippet.title, thumb: v.snippet.thumbnails?.medium?.url ?? null, at: Date.parse(v.snippet.publishedAt), dur, fmt: ytFmt(dur),
              views: Number(v.statistics?.viewCount ?? 0), likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0) };
          }).sort((a, b) => b.at - a.at);
          due.recent_at = Date.now();
        } catch (e) { note(`YouTube uploads (${due.name})`, e); }
      }
      // new uploads, every 10 minutes: the newest 3 of each channel, followed if under 72 hours old
      if ((every(10) || !Object.values(s.tracks).some((t) => t.net === "youtube")) && left() > 15_000) {
        const fresh: string[] = [];
        await Promise.all(ids.map(async (id) => {
          const c = s.chans[id];
          if (!c?.uploads) return;
          try {
            const pl = await get<{ items?: { contentDetails: { videoId: string; videoPublishedAt?: string } }[] }>(`playlistItems?part=contentDetails&maxResults=3&playlistId=${c.uploads}`);
            for (const x of pl.items ?? []) {
              const at = Date.parse(x.contentDetails.videoPublishedAt ?? "");
              if (!s.tracks[x.contentDetails.videoId] && at && Date.now() - at < WINDOW_H * H) fresh.push(x.contentDetails.videoId);
            }
          } catch (e) { note(`YouTube new uploads (${c.name})`, e); }
        }));
        if (fresh.length) {
          try {
            for (const v of (await get<{ items?: YV[] }>(`videos?part=snippet,statistics,contentDetails&id=${fresh.slice(0, 50).join(",")}`)).items ?? []) {
              const dur = isoDur(v.contentDetails?.duration), fmt = ytFmt(dur);
              s.tracks[v.id] = { id: v.id, net: "youtube", owner: v.snippet.channelId, fmt, title: v.snippet.title, thumb: v.snippet.thumbnails?.medium?.url ?? null,
                url: YT.watchUrl(v.id, fmt === "yt_short"), at: Date.parse(v.snippet.publishedAt), dur, pts: [] };
            }
          } catch (e) { note("YouTube new videos", e); }
        }
      }
      // every followed video's counters: one call for up to 50
      const follow = Object.values(s.tracks).filter((t) => t.net === "youtube").map((t) => t.id);
      for (let i = 0; i < follow.length && left() > 5000; i += 50) {
        try {
          for (const v of (await get<{ items?: YV[] }>(`videos?part=statistics&id=${follow.slice(i, i + 50).join(",")}`)).items ?? []) {
            const t = s.tracks[v.id];
            if (t) point(t, Number(v.statistics?.viewCount ?? 0), Number(v.statistics?.likeCount ?? 0), Number(v.statistics?.commentCount ?? 0));
          }
        } catch (e) { note("YouTube counters", e); }
      }
    }

    // ── Instagram: your accounts (rivals' need Facebook Login, see the top of this file)
    for (const acc of igAccs) {
      if (left() < 8000) break;
      let token: string;
      try { const a = await getAccount(acc.id); if (!a) continue; token = await IG.accessToken(a); } catch (e) { note("Instagram", e); continue; }
      const ch: Chan = s.chans[acc.id] ?? { id: acc.id, net: "instagram", rival: false, name: acc.name, handle: acc.handle, avatar: acc.avatar, uploads: null, subs: null, views: null, videos: null, pts: [], recent: [], recent_at: 0 };
      s.chans[acc.id] = ch;
      try {
        if (every(5) || !ch.pts.length) {
          const me = await IG.igGet<{ followers_count?: number; media_count?: number }>("/me", token, { fields: "followers_count,media_count" });
          ch.subs = me.followers_count ?? ch.subs; ch.videos = me.media_count ?? ch.videos;
          ch.pts.push([minute(), ch.subs ?? 0, 0]);
          ch.pts = ch.pts.filter((p, i, all) => minute() - p[0] < 2880 || (minute() - p[0] < 90 * 1440 && (i === 0 || Math.floor(p[0] / 60) !== Math.floor(all[i - 1][0] / 60))));
        }
        if (every(10) || !Object.values(s.tracks).some((t) => t.owner === acc.id)) {
          type M = { id: string; caption?: string; media_type: string; media_product_type?: string; timestamp: string; permalink: string; thumbnail_url?: string; media_url?: string };
          const r = await IG.igGet<{ data?: M[] }>(`/${acc.id}/media`, token, { fields: "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url", limit: "5" });
          for (const m of r.data ?? []) {
            const at = Date.parse(m.timestamp);
            if (s.tracks[m.id] || m.media_product_type === "STORY" || Date.now() - at > WINDOW_H * H) continue;
            const reel = m.media_product_type === "REELS" || m.media_type === "VIDEO";
            s.tracks[m.id] = { id: m.id, net: "instagram", owner: acc.id, fmt: reel ? "ig_reel" : "ig_post", title: (m.caption ?? "").split("\n")[0].slice(0, 120) || (reel ? "Reel" : "Post"),
              thumb: m.thumbnail_url ?? (m.media_type !== "VIDEO" ? m.media_url ?? null : null), url: m.permalink, at, dur: null, pts: [] };
          }
        }
        // posts under 48 hours every minute, older ones every 15 (Instagram allows about 200 calls an hour)
        const mine = Object.values(s.tracks).filter((t) => t.owner === acc.id && (Date.now() - t.at < 48 * H || every(15)));
        await Promise.all(mine.map(async (t) => {
          try {
            const r = await IG.igGet<{ data: { name: string; values?: { value: number }[]; total_value?: { value?: number } }[] }>(`/${t.id}/insights`, token, { metric: "views,likes,comments" });
            const v = (k: string) => { const d = r.data.find((x) => x.name === k); return d?.total_value?.value ?? d?.values?.[0]?.value ?? 0; };
            point(t, v("views"), v("likes"), v("comments"));
          } catch (e) { note(`Instagram post ${t.id}`, e); }
        }));
      } catch (e) { note(`Instagram @${acc.handle ?? acc.name}`, e); }
    }

    // ── posts past 72 hours: keep their curve, stop following
    for (const t of Object.values(s.tracks)) {
      if (Date.now() - t.at < WINDOW_H * H) continue;
      if (t.pts.length) s.curves.push({ id: t.id, owner: t.owner, fmt: t.fmt, at: t.at, title: t.title, v: AGES.map((a) => viewsAt(t.pts, t.at, a)) });
      delete s.tracks[t.id];
    }
    s.curves = s.curves.slice(-400);
  } catch (e) {
    note("Live check", e);
  }
  s.at = Date.now();
  s.errors = [...errors.map((text) => ({ at: s.at, text })), ...s.errors].slice(0, 20);
  await putJson(KEY, s);
  await putJson(LOCK, { at: 0 }).catch(() => {});
  return { ran: true, at: s.at, tracks: Object.keys(s.tracks).length, units, errors };
}

// ───────────── what the pages read

const q = (xs: number[], p: number) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * p, lo = Math.floor(i);
  return Math.round(a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo));
};
/** "Your usual post at this age": the middle half of an owner's finished curves of one format. Needs 3. */
function bandOf(curves: Curve[]): Band | null {
  if (curves.length < 3) return null;
  const col = (i: number) => curves.map((c) => c.v[i]).filter((v): v is number => v != null);
  return { ages: AGES, lo: AGES.map((_, i) => q(col(i), 0.25)), mid: AGES.map((_, i) => q(col(i), 0.5)), hi: AGES.map((_, i) => q(col(i), 0.75)), n: curves.length };
}
function verdictOf(views: number, age: number, band: Band | null, life: number | null): Verdict {
  const mid = band ? bandAt(band, "mid", age) : null;
  if (mid) {
    const x = views / Math.max(1, mid);
    return { x: Math.round(x * 10) / 10, basis: "curve", ...(x >= 2 ? { tone: "ok", label: "Taking off" } : x >= 1.2 ? { tone: "blue", label: "Ahead of your usual" } : x >= 0.8 ? { tone: "dim", label: "On par" } : { tone: "warn", label: "Behind your usual" }) } as Verdict;
  }
  if (life) {
    const x = views / life;
    return { x: Math.round(x * 100) / 100, basis: "lifetime", ...(x >= 1 ? { tone: "ok", label: "Already past a usual video's lifetime" } : x >= 0.5 ? { tone: "blue", label: "Halfway to a usual video's lifetime" } : { tone: "dim", label: "Building" }) } as Verdict;
  }
  return { tone: "dim", label: "Learning your usual", x: null, basis: "none" };
}

const gainOver = (pts: [number, number, number][], mins: number) => {
  if (pts.length < 2) return null;
  const now = pts.at(-1)!, then = [...pts].reverse().find((p) => now[0] - p[0] >= mins * 0.9);
  return then ? now[1] - then[1] : null;
};

/** The state, shaped for the Live and Competitors pages. */
export function liveView(s: LiveState, rivals: Rival[]): LiveView {
  const usualLife = (c: Chan | undefined, fmt: Fmt) => {
    const done = (c?.recent ?? []).filter((v) => v.fmt === fmt && Date.now() - v.at > 7 * 864e5).map((v) => v.views);
    return done.length >= 3 ? median(done) : null;
  };
  const posts: LivePost[] = Object.values(s.tracks).filter((t) => t.pts.length).map((t) => {
    const last = t.pts.at(-1)!, age = minute() - minute(t.at);
    const hourAgo = [...t.pts].reverse().find((p) => last[0] - p[0] >= 55) ?? t.pts[0];
    const band = bandOf(s.curves.filter((c) => c.owner === t.owner && c.fmt === t.fmt).slice(-30));
    const life = usualLife(s.chans[t.owner], t.fmt);
    return { ...t, views: last[1], likes: last[2], comments: last[3], age_min: age, band, usual_life: life,
      last_hour: last[1] - hourAgo[1], per_hour: Math.round(last[1] / Math.max(1, age / 60)), verdict: verdictOf(last[1], age, band, life) };
  }).sort((a, b) => b.at - a.at);

  const chans: LiveChan[] = Object.values(s.chans).map((c) => {
    const usual: LiveChan["usual"] = {}, avg_len: LiveChan["avg_len"] = {};
    for (const f of ["yt_short", "yt_video", "ig_reel", "ig_post"] as Fmt[]) {
      const u = usualLife(c, f); if (u != null) usual[f] = u;
      const lens = c.recent.filter((v) => v.fmt === f && v.dur).map((v) => v.dur!);
      if (lens.length) avg_len[f] = median(lens);
    }
    const span = c.recent.length > 1 ? (c.recent[0].at - c.recent.at(-1)!.at) / (7 * 864e5) : 0;
    const days = new Array(7).fill(0), slots = new Array(8).fill(0);
    for (const v of c.recent) { const d = new Date(v.at); days[d.getUTCDay()]++; slots[Math.floor(d.getUTCHours() / 3)]++; }
    const settled = c.recent.filter((v) => Date.now() - v.at > 2 * 864e5 && v.views);
    const er = settled.length ? median(settled.map((v) => ((v.likes + v.comments) / v.views) * 100)) : null;
    return {
      ...c, pts: c.pts.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 300)) === 0 || i === a.length - 1),
      d1: gainOver(c.pts, 1440), d7: gainOver(c.pts, 7 * 1440), d28: gainOver(c.pts, 28 * 1440), usual, avg_len,
      per_week: span > 0 ? Math.round(((c.recent.length - 1) / span) * 10) / 10 : null, days, slots, er: er == null ? null : Math.round(er * 100) / 100,
      recent: c.recent.map((v) => ({ ...v, score: usual[v.fmt] && Date.now() - v.at > 864e5 ? Math.round((v.views / usual[v.fmt]!) * 10) / 10 : null })),
    };
  });
  const outliers = chans.filter((c) => c.rival).flatMap((c) => c.recent.filter((v) => v.score != null && v.score >= 1.5 && Date.now() - v.at < 45 * 864e5).map((v) => ({ ...v, owner: c.id, score: v.score! })))
    .sort((a, b) => b.score - a.score).slice(0, 30);
  return { at: s.at, age_s: Math.round((Date.now() - s.at) / 1000), quota: s.quota, rivals: rivals.map((r) => ({ ...r, ...s.found[rkey(r)] })), errors: s.errors, posts, chans, outliers, curves: s.curves.length };
}

/** Add, remove or pin a rival (Grow → Competitors). */
export async function editRivals(change: { add?: { handle: string; net: Net }; remove?: string; pin?: { handle: string; on: boolean } }) {
  let rivals = await loadRivals();
  const norm = (h: string, net: Net) => (net === "youtube" ? `@${h.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0]}` : h.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0]);
  if (change.add) {
    const add = { handle: norm(change.add.handle, change.add.net), net: change.add.net };
    if (!/^@?[A-Za-z0-9._-]{2,60}$/.test(add.handle)) throw new Error("That doesn't look like a channel handle.");
    if (rivals.length >= 20) throw new Error("Follow up to 20 rivals.");
    if (!rivals.some((r) => rkey(r) === rkey(add))) rivals = [...rivals, { ...add, pinned: true }];
  }
  if (change.remove) rivals = rivals.filter((r) => rkey(r) !== change.remove!.toLowerCase());
  if (change.pin) rivals = rivals.map((r) => (rkey(r) === change.pin!.handle.toLowerCase() ? { ...r, pinned: change.pin!.on } : r));
  await putJson(RIVALS, rivals.map(({ handle, net, pinned }) => ({ handle, net, pinned })));
  return rivals;
}
