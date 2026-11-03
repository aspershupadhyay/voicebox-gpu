// An Instagram rival in depth (Grow → Competitors → a rival's page, and the analytics MCP tool's view "rival"): their
// public profile and latest posts from Instagram's Business Discovery (lib/publish/facebook.ts), and what that says.
// How often they post, which posts beat their own usual, which formats, times and hashtags go with their hits.
// Instagram shares likes and comments for other accounts, never views, reach, shares or saves, so a rival's post is
// scored by likes against the median likes of their own posts of the same kind (likes with likes, never mixed).
// Kept 3 hours per account in R2 (workspace/live/ig-rivals/<username>.json); `fresh` asks Instagram again.
import { getJson, putJson } from "./store";
import { discover } from "./publish/facebook";
import { getRules } from "./publish/plans";
import { hashtagsOf, median } from "./analytics-util";

const DAY = 864e5, KEEP_MS = 3 * 3600_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOT = ["12 AM", "3 AM", "6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"];

export type RivalKind = "reel" | "post" | "carousel";
export type RivalPost = {
  id: string; url: string | null; thumb: string | null; at: number; kind: RivalKind; title: string; caption_len: number;
  likes: number | null; comments: number | null; tags: string[];
  /** likes ÷ the median likes of their posts of the same kind: 2 = twice their usual */
  score: number | null;
};
export type IgRival = {
  at: number; username: string; name: string | null; bio: string | null; website: string | null; avatar: string | null;
  followers: number | null; following: number | null; posts_total: number | null; tz: string;
  posts: RivalPost[];
  rhythm: { last7: number; last30: number; per_week: number | null; median_gap_h: number | null; last_post: number | null; first_seen: number | null };
  kinds: { kind: RivalKind; n: number; share: number; median_likes: number | null; median_comments: number | null }[];
  usual: { likes: number | null; comments: number | null; er: number | null; hits: number; hit_rate: number | null };
  /** 7 days (Sun first) × 8 three-hour slots, in the studio's time zone: posts that went out then (n) and their median score (v) */
  heat: { v: number; n: number }[][];
  best_slots: { day: string; slot: string; n: number; score: number }[];
  tags: { tag: string; n: number; score: number }[];
  /** what the hits have in common against the rest */
  hits_vs_rest: { caption_len: [number | null, number | null]; questions: [number, number]; numbers: [number, number] };
  likes_hidden: boolean;
};

const kindOf = (m: { media_type: string; media_product_type?: string }): RivalKind =>
  m.media_product_type === "REELS" || m.media_type === "VIDEO" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : "post";
const r2 = (n: number | null) => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);

function zoned(t: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(t));
  return { day: Math.max(0, DAYS.indexOf(p.find((x) => x.type === "weekday")?.value ?? "Sun")), hour: Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24 };
}

export async function igRival(username: string, fresh = false): Promise<IgRival> {
  const u = username.replace(/^@/, "").trim().toLowerCase();
  const key = `workspace/live/ig-rivals/${u.replace(/[^a-z0-9._]/g, "_")}.json`;
  if (!fresh) {
    const kept = await getJson<IgRival>(key).catch(() => null);
    if (kept && Date.now() - kept.at < KEEP_MS) return kept;
  }
  const [d, rules] = await Promise.all([discover(u, 100), getRules().catch(() => ({ tz: "UTC" }))]);
  const tz = (rules as { tz?: string }).tz || "UTC";
  const media = d.media?.data ?? [];
  const likesHidden = media.length > 0 && media.every((m) => m.like_count == null);

  const posts: RivalPost[] = media.map((m) => {
    const cap = m.caption ?? "";
    return {
      id: m.id, url: m.permalink ?? null, thumb: m.thumbnail_url ?? (m.media_type !== "VIDEO" ? m.media_url ?? null : null), at: Date.parse(m.timestamp),
      kind: kindOf(m), title: cap.split("\n")[0].slice(0, 140) || "(no caption)", caption_len: cap.length,
      likes: m.like_count ?? null, comments: m.comments_count ?? null, tags: hashtagsOf(cap), score: null,
    };
  }).sort((a, b) => b.at - a.at);

  // each post against their own usual for the same kind: likes with likes
  const kinds: IgRival["kinds"] = [];
  for (const k of ["reel", "carousel", "post"] as RivalKind[]) {
    const xs = posts.filter((p) => p.kind === k);
    if (!xs.length) continue;
    const likes = xs.map((p) => p.likes).filter((v): v is number => v != null && v > 0);
    const usual = likes.length ? median(likes) : null;
    if (likes.length >= 3 && usual) for (const p of xs) p.score = p.likes != null ? r2(p.likes / usual) : null;
    const coms = xs.map((p) => p.comments).filter((v): v is number => v != null);
    kinds.push({ kind: k, n: xs.length, share: r2(xs.length / posts.length) ?? 0, median_likes: usual, median_comments: coms.length ? median(coms) : null });
  }

  const now = Date.now();
  const times = posts.map((p) => p.at);
  const gaps = times.slice(0, -1).map((t, i) => (t - times[i + 1]) / 3600_000).filter((g) => g >= 0);
  const span = times.length >= 2 ? (times[0] - times.at(-1)!) / DAY : null;
  const last30 = posts.filter((p) => now - p.at < 30 * DAY).length;
  const rhythm: IgRival["rhythm"] = {
    last7: posts.filter((p) => now - p.at < 7 * DAY).length, last30,
    // over the last 30 days when they posted in it, else over the span the fetched posts cover
    per_week: last30 ? r2((last30 / 30) * 7) : span ? r2((posts.length / Math.max(span, 1)) * 7) : null,
    median_gap_h: gaps.length ? r2(median(gaps)) : null, last_post: times[0] ?? null, first_seen: times.at(-1) ?? null,
  };

  const scored = posts.filter((p) => p.score != null);
  const hits = scored.filter((p) => p.score! >= 1.5);
  const allLikes = posts.map((p) => p.likes).filter((v): v is number => v != null);
  const allComs = posts.map((p) => p.comments).filter((v): v is number => v != null);
  const usualLikes = allLikes.length ? median(allLikes) : null, usualComs = allComs.length ? median(allComs) : null;
  const usual: IgRival["usual"] = {
    likes: usualLikes, comments: usualComs,
    er: d.followers_count && usualLikes != null ? r2(((usualLikes + (usualComs ?? 0)) / d.followers_count) * 100) : null,
    hits: hits.length, hit_rate: scored.length ? r2(hits.length / scored.length) : null,
  };

  const cells = Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => [] as number[]));
  for (const p of posts) { const z = zoned(p.at, tz); cells[z.day][Math.floor(z.hour / 3)].push(p.score ?? 1); }
  const heat = cells.map((r) => r.map((c) => ({ v: c.length ? r2(median(c)) ?? 0 : 0, n: c.length })));
  const best_slots = heat.flatMap((r, d) => r.map((c, s) => ({ day: DAYS[d], slot: SLOT[s], n: c.n, score: c.v })))
    .filter((c) => c.n >= 2).sort((a, b) => b.score - a.score).slice(0, 3);

  const tagMap = new Map<string, number[]>();
  for (const p of scored) for (const t of p.tags) tagMap.set(t, [...(tagMap.get(t) ?? []), p.score!]);
  const tags = [...tagMap].filter(([, s]) => s.length >= 2).map(([tag, s]) => ({ tag, n: s.length, score: r2(median(s)) ?? 0 })).sort((a, b) => b.score - a.score).slice(0, 15);

  const rest = scored.filter((p) => p.score! < 1.5);
  const share = (xs: RivalPost[], f: (p: RivalPost) => boolean) => (xs.length ? r2(xs.filter(f).length / xs.length) ?? 0 : 0);
  const q = (p: RivalPost) => p.title.includes("?"), num = (p: RivalPost) => /\d/.test(p.title);
  const out: IgRival = {
    at: now, username: d.username, name: d.name ?? null, bio: d.biography ?? null, website: d.website ?? null, avatar: d.profile_picture_url ?? null,
    followers: d.followers_count ?? null, following: d.follows_count ?? null, posts_total: d.media_count ?? null, tz,
    posts, rhythm, kinds, usual, heat, best_slots, tags,
    hits_vs_rest: {
      caption_len: [hits.length ? median(hits.map((p) => p.caption_len)) : null, rest.length ? median(rest.map((p) => p.caption_len)) : null],
      questions: [share(hits, q), share(rest, q)], numbers: [share(hits, num), share(rest, num)],
    },
    likes_hidden: likesHidden,
  };
  await putJson(key, out).catch(() => null);
  return out;
}
