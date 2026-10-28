// Instagram in depth (the Analytics page's Instagram tab, and the analytics MCP tool): every account insight the
// Instagram API with Instagram Login offers, for the window and the one before it. Views, reach, accounts engaged,
// interactions and each kind (likes, comments, shares, saves, replies), follows and unfollows, profile link taps, each
// split by followers vs non-followers (how far past your followers you travel) and by format, daily reach and
// follower growth, when followers are online, the audience three ways (followers, engaged, reached) by age, gender,
// country and city, and the Stories that are live now with taps forward, back and exits.
// igPost() is one post's deep dive, on demand: every metric Instagram has for its type.
import type { AccountSum, Item } from "./analytics";
import { byWeekday, DAY, ratio, round, settle, sum, type Bar, type Daily, type Kpi, type Range, type Win } from "./analytics-util";
import type { PostDetail } from "./analytics-yt";
import * as IG from "./publish/instagram";

type Insight = { name: string; values?: { value: number | Record<string, number>; end_time?: string }[]; total_value?: { value?: number; breakdowns?: { dimension_keys?: string[]; results?: { dimension_values: string[]; value: number }[] }[] } };
export const val = (x?: Insight) => (x?.total_value?.value ?? (typeof x?.values?.[0]?.value === "number" ? (x.values[0].value as number) : null));
const label = (s: string) => ({ FOLLOWER: "Followers", NON_FOLLOWER: "Non-followers", UNKNOWN: "Unknown", POST: "Posts", REEL: "Reels", STORY: "Stories", AD: "Ads", CAROUSEL_CONTAINER: "Carousels", IGTV: "Video", LIVE: "Live", DEFAULT_DO_NOT_USE: "Other",
  BOOK_NOW: "Book now", CALL: "Call", DIRECTION: "Directions", EMAIL: "Email", INSTANT_EXPERIENCE: "Instant experience", TEXT: "Text", WEBSITE: "Website link", BIO_LINK_CLICKED: "Bio link", PROFILE_VISIT: "Profile visit",
  F: "Women", M: "Men", U: "Other", tap_forward: "Tapped forward", tap_back: "Tapped back", tap_exit: "Exited", swipe_forward: "Swiped to next account", automatic_forward: "Moved on automatically",
  follow: "Followed", unfollow: "Unfollowed", FOLLOWS: "Follows", UNFOLLOWS: "Unfollows", call: "Call", direction: "Directions", email: "Email", bio_link_clicked: "Bio link", text: "Text", other: "Other" } as Record<string, string>)[s] ?? s;

export type Demo = Record<"age" | "gender" | "country" | "city", Bar[]>;
export type IgDeep = {
  account: AccountSum;
  kpis: Kpi[];
  daily: Daily[];
  /** average daily reach by weekday, Sun first */
  weekday: number[];
  /** reach and views split by followers vs non-followers */
  audience_split: { metric: string; parts: Bar[] }[];
  /** views, reach and interactions by format (Reels, posts, Stories…) */
  by_format: { label: string; views: number; reach: number; interactions: number }[];
  taps: Bar[];
  /** how many followers are online in each hour of the day (Instagram reports it in Pacific time) */
  online: number[] | null;
  demo: Partial<Record<"followers" | "engaged" | "reached", Demo>>;
  stories: { id: string; url: string; thumb: string | null; at: number; reach: number | null; views: number | null; replies: number | null; shares: number | null; follows: number | null; nav: Bar[] }[];
};

const chunks = (s: number, e: number) => {
  const out: [number, number][] = [];
  for (let t = s; t <= e; t += 30 * DAY) out.push([t, Math.min(e, t + 29 * DAY)]);
  return out;
};
const unix = (t: number) => String(Math.floor(t / 1000));

/** A window's total for each metric (and its breakdown), summed over Instagram's 30-day pieces. One call per piece
 *  for the lot; when Instagram refuses one metric in a batch, each is asked on its own so the rest still come back. */
async function totals(token: string, user: string, metrics: string[], s: number, e: number, breakdown?: string) {
  const out = new Map<string, { value: number; parts: Map<string, number> }>();
  const add = (d: Insight) => {
    const cur = out.get(d.name) ?? { value: 0, parts: new Map<string, number>() };
    cur.value += d.total_value?.value ?? 0;
    for (const b of d.total_value?.breakdowns ?? []) for (const r of b.results ?? []) cur.parts.set(r.dimension_values.join(" · "), (cur.parts.get(r.dimension_values.join(" · ")) ?? 0) + r.value);
    out.set(d.name, cur);
  };
  for (const [a, b] of chunks(s, e)) {
    const q = (m: string) => IG.igGet<{ data: Insight[] }>(`/${user}/insights`, token, { metric: m, period: "day", metric_type: "total_value", since: unix(a), until: unix(b + DAY), ...(breakdown ? { breakdown } : {}) });
    const all = await settle(q(metrics.join(",")));
    if (all) all.data.forEach(add);
    else (await Promise.all(metrics.map((m) => settle(q(m))))).forEach((r) => r?.data.forEach(add));
  }
  return out;
}

async function series(token: string, user: string, metric: string, s: number, e: number, range: number) {
  const out = new Array(range).fill(0);
  let got = false;
  for (const [a, b] of chunks(s, e)) {
    const r = await settle(IG.igGet<{ data: Insight[] }>(`/${user}/insights`, token, { metric, period: "day", since: unix(a), until: unix(b + DAY) }));
    for (const v of r?.data?.[0]?.values ?? []) {
      const i = Math.round((Date.parse(v.end_time ?? "") - DAY - s) / DAY);
      if (i >= 0 && i < range && typeof v.value === "number") { out[i] += v.value; got = true; }
    }
  }
  return got ? out : null;
}

async function demographics(token: string, user: string, metric: string, timeframe?: string): Promise<Demo | undefined> {
  const one = async (breakdown: string) => {
    const r = await settle(IG.igGet<{ data: Insight[] }>(`/${user}/insights`, token, { metric, period: "lifetime", metric_type: "total_value", breakdown, ...(timeframe ? { timeframe } : {}) }));
    return (r?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? []).map((x) => [label(x.dimension_values[0]), x.value] as Bar).sort((a, b) => b[1] - a[1]);
  };
  const [age, gender, country, city] = await Promise.all([one("age"), one("gender"), one("country"), one("city")]);
  if (!age.length && !gender.length && !country.length && !city.length) return undefined;
  return { age: age.sort((a, b) => a[0].localeCompare(b[0])), gender, country: country.slice(0, 12), city: city.slice(0, 12) };
}

const ACCOUNT = ["views", "reach", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves", "replies", "profile_links_taps", "follows_and_unfollows"];

export async function igDeep(token: string, account: AccountSum, items: Item[], w: Win, range: Range): Promise<IgDeep> {
  const user = account.id;
  const [cur, prev, byFollow, byFormat, byTap, follows, reachDay, reachPrev, fc, online, followersDemo, engagedDemo, reachedDemo, stories] = await Promise.all([
    totals(token, user, ACCOUNT, w.start, w.end), totals(token, user, ACCOUNT, w.prevStart, w.prevEnd),
    totals(token, user, ["reach", "views"], w.start, w.end, "follow_type"),
    totals(token, user, ["views", "reach", "total_interactions"], w.start, w.end, "media_product_type"),
    totals(token, user, ["profile_links_taps"], w.start, w.end, "contact_button_type"),
    totals(token, user, ["follows_and_unfollows"], w.start, w.end, "follow_type"),
    series(token, user, "reach", w.start, w.end, range), series(token, user, "reach", w.prevStart, w.prevEnd, range),
    range <= 30 ? series(token, user, "follower_count", w.start, w.end, range) : Promise.resolve(null),
    settle(IG.igGet<{ data: Insight[] }>(`/${user}/insights`, token, { metric: "online_followers", period: "lifetime" })),
    demographics(token, user, "follower_demographics"),
    demographics(token, user, "engaged_audience_demographics", range <= 7 ? "this_week" : "this_month"),
    demographics(token, user, "reached_audience_demographics", range <= 7 ? "this_week" : "this_month"),
    storiesNow(token, user),
  ]);
  const g = (m: Map<string, { value: number }>, k: string) => (m.has(k) ? m.get(k)!.value : null);
  const posted = (s: number, e: number) => items.filter((i) => i.at >= s && i.at < e + DAY).length;
  const fParts = follows.get("follows_and_unfollows")?.parts;
  const fl = fParts ? [...fParts].find(([k]) => /^FOLLOW/i.test(k) && !/UN/i.test(k))?.[1] ?? null : null;
  const ufl = fParts ? [...fParts].find(([k]) => /UNFOLLOW/i.test(k))?.[1] ?? null : null;
  const nonF = (m: string) => { const p = byFollow.get(m)?.parts; if (!p) return null; const t = sum([...p.values()]); return t ? ((p.get("NON_FOLLOWER") ?? 0) / t) * 100 : null; };
  const reach = g(cur, "reach"), pReach = g(prev, "reach");
  const saveShare = (m: Map<string, { value: number }>) => (g(m, "saves") == null ? null : (g(m, "saves") ?? 0) + (g(m, "shares") ?? 0));
  const k = (key: string, lbl: string, group: string, value: number | null, prevV: number | null, about: string, unit: Kpi["unit"] = "", better: Kpi["better"] = "up"): Kpi => ({ key, label: lbl, group, value: round(value, 2), prev: round(prevV, 2), unit, about, better });
  const igItems = (s: number, e: number) => items.filter((i) => i.at >= s && i.at < e + DAY);
  const avgWatch = (xs: Item[]) => { const r = xs.filter((i) => i.avg_s != null); return r.length ? sum(r.map((i) => i.avg_s)) / r.length : null; };
  const kpis: Kpi[] = [
    k("views", "Views", "Reach", g(cur, "views"), g(prev, "views"), "Times your posts, Reels and Stories were played or shown (replays count)."),
    k("reach", "Accounts reached", "Reach", reach, pReach, "Unique accounts that saw your content at least once (summed over 30-day pieces for 90 days)."),
    k("non_follower_reach", "Reach from non-followers", "Reach", nonF("reach"), null, "Share of reached accounts that don't follow you. The clearest sign of going viral: above 50% means the feed is pushing you to new people.", "pct"),
    k("non_follower_views", "Views from non-followers", "Reach", nonF("views"), null, "Share of views from people who don't follow you.", "pct"),
    k("accounts_engaged", "Accounts engaged", "Engagement", g(cur, "accounts_engaged"), g(prev, "accounts_engaged"), "Unique accounts that liked, commented, saved, shared or replied."),
    k("interactions", "Interactions", "Engagement", g(cur, "total_interactions"), g(prev, "total_interactions"), "Likes, comments, saves, shares and replies together."),
    k("er_reach", "Engagement rate (by reach)", "Engagement", ratio(g(cur, "total_interactions"), reach, 100), ratio(g(prev, "total_interactions"), pReach, 100), "Interactions ÷ accounts reached.", "pct"),
    k("likes", "Likes", "Engagement", g(cur, "likes"), g(prev, "likes"), ""),
    k("comments", "Comments", "Engagement", g(cur, "comments"), g(prev, "comments"), ""),
    k("shares", "Shares", "Engagement", g(cur, "shares"), g(prev, "shares"), "Sends to friends and to Stories. The strongest signal for reaching non-followers."),
    k("saves", "Saves", "Engagement", g(cur, "saves"), g(prev, "saves"), "Bookmarks: people want to come back to it."),
    k("replies", "Story replies", "Engagement", g(cur, "replies"), g(prev, "replies"), "Messages sent in reply to your Stories."),
    k("send_save_rate", "Shares + saves per 1,000 reached", "Engagement", ratio(saveShare(cur), reach, 1000), ratio(saveShare(prev), pReach, 1000), "How worth-keeping and worth-sending your content is, at any size.", "per1k"),
    k("followers", "Followers", "Growth", account.followers, null, "Followers now."),
    k("follows", "Follows", "Growth", fl, null, "Accounts that followed you in the period."),
    k("unfollows", "Unfollows", "Growth", ufl, null, "Accounts that unfollowed you in the period.", "", "down"),
    k("follows_net", "Net followers", "Growth", fl == null ? null : fl - (ufl ?? 0), null, "Follows minus unfollows."),
    k("follows_1k", "Follows per 1,000 reached", "Growth", ratio(fl, reach, 1000), null, "How well reach turns into followers.", "per1k"),
    k("link_taps", "Profile link taps", "Growth", g(cur, "profile_links_taps"), g(prev, "profile_links_taps"), "Taps on your bio link and contact buttons."),
    k("posts", "Posts published", "Output", posted(w.start, w.end), posted(w.prevStart, w.prevEnd), "Feed posts and Reels that went out in the period."),
    k("reel_watch", "Average Reel watch time", "Watch", avgWatch(igItems(w.start, w.end).filter((i) => i.fmt === "ig_reel")), avgWatch(igItems(w.prevStart, w.prevEnd).filter((i) => i.fmt === "ig_reel")), "How long a Reel play lasts on average.", "s"),
  ].filter((x) => x.value != null || x.prev != null);

  const daily: Daily[] = [];
  if (reachDay) daily.push({ key: "reach", label: "Accounts reached", cur: reachDay, prev: reachPrev ?? new Array(range).fill(0) });
  if (fc) daily.push({ key: "followers", label: "New followers", cur: fc, prev: new Array(range).fill(0) });
  // what went out each day, by the engagement it has gathered so far
  const byDay = (s: number, f: (i: Item) => number) => { const out = new Array(range).fill(0); for (const i of items) { const d = Math.floor((i.at - s) / DAY); if (d >= 0 && d < range) out[d] += f(i); } return out; };
  daily.push({ key: "post_views", label: "Views of posts, by the day they went out", cur: byDay(w.start, (i) => i.views ?? 0), prev: byDay(w.prevStart, (i) => i.views ?? 0) });
  daily.push({ key: "post_eng", label: "Interactions on posts, by the day they went out", cur: byDay(w.start, (i) => i.likes + i.comments + (i.shares ?? 0) + (i.saves ?? 0)), prev: byDay(w.prevStart, (i) => i.likes + i.comments + (i.shares ?? 0) + (i.saves ?? 0)) });

  const hours = online?.data?.[0]?.values?.at(-1)?.value;
  const parts = (m: Map<string, { parts: Map<string, number> }>, metric: string) => [...(m.get(metric)?.parts ?? new Map<string, number>())].map(([kk, v]) => [label(kk), v] as Bar).sort((a, b) => b[1] - a[1]);
  const fmts = new Set([...(byFormat.get("views")?.parts.keys() ?? []), ...(byFormat.get("reach")?.parts.keys() ?? []), ...(byFormat.get("total_interactions")?.parts.keys() ?? [])]);
  return {
    account, kpis, daily,
    weekday: reachDay ? byWeekday(w.days, reachDay) : [],
    audience_split: [{ metric: "Accounts reached", parts: parts(byFollow, "reach") }, { metric: "Views", parts: parts(byFollow, "views") }].filter((x) => x.parts.length),
    by_format: [...fmts].map((f) => ({ label: label(f), views: byFormat.get("views")?.parts.get(f) ?? 0, reach: byFormat.get("reach")?.parts.get(f) ?? 0, interactions: byFormat.get("total_interactions")?.parts.get(f) ?? 0 })).sort((a, b) => b.views - a.views),
    taps: parts(byTap, "profile_links_taps"),
    online: hours && typeof hours === "object" && Object.keys(hours).length ? Array.from({ length: 24 }, (_, h) => Number((hours as Record<string, number>)[String(h)] ?? 0)) : null,
    demo: { ...(followersDemo ? { followers: followersDemo } : {}), ...(engagedDemo ? { engaged: engagedDemo } : {}), ...(reachedDemo ? { reached: reachedDemo } : {}) },
    stories,
  };
}

/** Stories live right now (Instagram keeps their insights for 24 h), with how people moved through them. */
async function storiesNow(token: string, user: string) {
  const r = await settle(IG.igGet<{ data: { id: string; media_type: string; timestamp: string; permalink: string; media_url?: string; thumbnail_url?: string }[] }>(`/${user}/stories`, token, { fields: "id,media_type,timestamp,permalink,media_url,thumbnail_url" }));
  return Promise.all((r?.data ?? []).slice(0, 20).map(async (s) => {
    const [base, nav] = await Promise.all([
      settle(IG.igGet<{ data: Insight[] }>(`/${s.id}/insights`, token, { metric: "reach,views,replies,shares,follows,total_interactions" })),
      settle(IG.igGet<{ data: Insight[] }>(`/${s.id}/insights`, token, { metric: "navigation", breakdown: "story_navigation_action_type" })),
    ]);
    const m = Object.fromEntries((base?.data ?? []).map((d) => [d.name, val(d)]));
    return {
      id: s.id, url: s.permalink, thumb: s.thumbnail_url ?? (s.media_type !== "VIDEO" ? s.media_url ?? null : null), at: Date.parse(s.timestamp),
      reach: m.reach ?? null, views: m.views ?? null, replies: m.replies ?? null, shares: m.shares ?? null, follows: m.follows ?? null,
      nav: (nav?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? []).map((x) => [label(x.dimension_values[0]), x.value] as Bar).sort((a, b) => b[1] - a[1]),
    };
  }));
}

/** One post or Reel in depth: every metric Instagram has for its type, asked one by one so one it lacks can't hide the rest. */
export async function igPost(token: string, id: string, item?: Item): Promise<PostDetail> {
  const m = await IG.igGet<{ caption?: string; media_type: string; media_product_type?: string; timestamp: string; permalink: string; like_count?: number; comments_count?: number }>(`/${id}`, token, { fields: "caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count" });
  const reel = m.media_product_type === "REELS";
  const names = ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "follows", "profile_visits", "profile_activity", "crossposted_views", "facebook_views",
    ...(reel ? ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time", "reels_skip_rate"] : [])];
  const got = new Map<string, number>();
  const batch = await settle(IG.igGet<{ data: Insight[] }>(`/${id}/insights`, token, { metric: names.join(",") }));
  if (batch) batch.data.forEach((d) => { const v = val(d); if (v != null) got.set(d.name, v); });
  else await Promise.all(names.map(async (n) => { const r = await settle(IG.igGet<{ data: Insight[] }>(`/${id}/insights`, token, { metric: n })); const v = val(r?.data?.[0]); if (v != null) got.set(n, v); }));
  const act = await settle(IG.igGet<{ data: Insight[] }>(`/${id}/insights`, token, { metric: "profile_activity", breakdown: "action_type" }));
  const g = (n: string) => got.get(n) ?? null;
  const base = g("views") || g("reach");
  const k = (key: string, lbl: string, value: number | null, about = "", unit: Kpi["unit"] = ""): Kpi => ({ key, label: lbl, group: "Lifetime", value: round(value, 2), prev: null, unit, about });
  const inter = g("total_interactions") ?? (m.like_count ?? 0) + (m.comments_count ?? 0) + (g("shares") ?? 0) + (g("saved") ?? 0);
  const kpis = [
    k("views", "Views", g("views"), "Plays and shows, replays included."), k("reach", "Accounts reached", g("reach"), "Unique accounts that saw it."),
    k("likes", "Likes", g("likes") ?? m.like_count ?? null), k("comments", "Comments", g("comments") ?? m.comments_count ?? null),
    k("shares", "Shares", g("shares"), "Sends to friends and Stories."), k("saves", "Saves", g("saved"), "Bookmarks."),
    k("interactions", "Interactions", inter), k("er", "Engagement rate", ratio(inter, base, 100), "Interactions ÷ views (or reach).", "pct"),
    k("share_rate", "Shares per 1,000 views", ratio(g("shares"), base, 1000), "", "per1k"), k("save_rate", "Saves per 1,000 views", ratio(g("saved"), base, 1000), "", "per1k"),
    k("follows", "Follows from it", g("follows"), "People who followed you after seeing it."), k("profile_visits", "Profile visits", g("profile_visits")),
    k("profile_activity", "Actions on your profile", g("profile_activity"), "Taps on your bio link, email, call and the like after seeing it."),
    k("avg_watch", "Average watch time", g("ig_reels_avg_watch_time") != null ? g("ig_reels_avg_watch_time")! / 1000 : null, "How long a play lasts.", "s"),
    k("total_watch", "Total watch time (hours)", g("ig_reels_video_view_total_time") != null ? g("ig_reels_video_view_total_time")! / 3.6e6 : null, "", "h"),
    k("skip_rate", "Skip rate", g("reels_skip_rate"), "Share of plays swiped away in the first seconds. Lower is better.", "pct"),
    k("fb_views", "Facebook views", g("facebook_views") ?? g("crossposted_views"), "Views from the Facebook cross-post."),
    ...(item?.score != null ? [k("score", "Score vs your usual", item.score, "Views ÷ the median of your posts of this format.", "x")] : []),
  ].filter((x) => x.value != null);
  const notes: string[] = [];
  if (g("shares") != null && g("saved") != null && base) {
    const r = ((g("shares")! + g("saved")!) / base) * 1000;
    notes.push(r >= 20 ? `${Math.round(r)} shares + saves per 1,000 views: people find this worth keeping and sending.` : `${Math.round(r)} shares + saves per 1,000 views. Give people a reason to send it (a tip, a list, a line to quote).`);
  }
  if (g("follows") && g("reach")) notes.push(`${Math.round((g("follows")! / g("reach")!) * 10000) / 10} follows per 1,000 accounts reached.`);
  return {
    network: "instagram", id, title: (m.caption ?? "").split("\n")[0].slice(0, 140) || (reel ? "Reel" : "Post"), url: m.permalink, at: Date.parse(m.timestamp),
    kind: reel ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carousel" : m.media_type === "VIDEO" ? "Video" : "Photo",
    kpis, retention: null, velocity: null, traffic: [],
    actions: (act?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? []).map((x) => [label(x.dimension_values[0]), x.value] as Bar).filter((b) => b[1] > 0),
    notes,
  };
}
