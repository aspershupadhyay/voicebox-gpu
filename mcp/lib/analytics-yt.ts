// YouTube in depth (the Analytics page's YouTube tab, and the analytics MCP tool): every channel report the YouTube
// Analytics API offers for a creator, for the window and the one before it. A scorecard of every core metric, daily
// series for each, content types, traffic sources and the search terms, sites and videos behind them, playback
// locations, devices and operating systems, subscribers vs not, sharing services, geography and demographics. A report
// the channel can't answer (too small, a metric YouTube hasn't turned on) is simply left out.
// ytPost() is one video's deep dive, on demand: lifetime totals, the retention curve (how much of the audience is still
// watching at each point), views day by day since it went out (peak day, how front-loaded it is) and its traffic.
import type { AccountSum, Item } from "./analytics";
import { byWeekday, DAY, fold, iso, ratio, report, round, settle, sum, type Bar, type Daily, type Kpi, type Range, type Row, type Win } from "./analytics-util";

export const TRAFFIC: Record<string, string> = {
  YT_SEARCH: "YouTube search", SUGGESTED: "Suggested videos", BROWSE: "Browse & home", SHORTS: "Shorts feed", EXT_URL: "External sites",
  SUBSCRIBER: "Subscriptions", PLAYLIST: "Playlists", YT_CHANNEL: "Channel pages", NOTIFICATION: "Notifications", NO_LINK_OTHER: "Direct or unknown",
  RELATED_VIDEO: "Related videos", YT_OTHER_PAGE: "Other YouTube pages", END_SCREEN: "End screens", ANNOTATION: "Cards", HASHTAGS: "Hashtag pages",
  SOUND_PAGE: "Sound pages", VIDEO_REMIXES: "Remixes", LIVE_REDIRECT: "Live redirects", CAMPAIGN_CARD: "Campaign cards", ADVERTISING: "Ads",
  PRODUCT_PAGE: "Product pages", IMMERSIVE_LIVE: "Live feed", SHORTS_CONTENT_LINKS: "Links in Shorts", NO_LINK_EMBEDDED: "Embedded players",
};
export const DEVICES: Record<string, string> = { MOBILE: "Phone", DESKTOP: "Computer", TABLET: "Tablet", TV: "TV", GAME_CONSOLE: "Console", UNKNOWN_PLATFORM: "Other" };
const PLAYBACK: Record<string, string> = { WATCH: "YouTube watch page", SHORTS: "Shorts player", EMBEDDED: "Embedded on other sites", CHANNEL: "Channel page", BROWSE: "Home & browse", SEARCH: "Search results", EXTERNAL_APP: "Other apps", YT_OTHER: "Other YouTube pages", MOBILE: "Mobile site" };
const OS: Record<string, string> = { ANDROID: "Android", IOS: "iOS", WINDOWS: "Windows", MACINTOSH: "macOS", LINUX: "Linux", CHROMECAST: "Chromecast", SMART_TV: "Smart TV", PLAYSTATION: "PlayStation", XBOX: "Xbox", ROKU: "Roku", FIRE_OS: "Fire OS", KAIOS: "KaiOS", OTHER: "Other" };
const CONTENT: Record<string, string> = { shorts: "Shorts", videoOnDemand: "Videos", liveStream: "Live", story: "Stories", unspecified: "Other" };
const SHARING: Record<string, string> = { WHATS_APP: "WhatsApp", COPY_PASTE: "Copied link", FACEBOOK: "Facebook", TWITTER: "X (Twitter)", REDDIT: "Reddit", TELEGRAM: "Telegram", INSTAGRAM: "Instagram", GMAIL: "Gmail", EMAIL: "Email", LINKEDIN: "LinkedIn", DISCORD: "Discord", SMS: "Text message", OTHER: "Other", ANDROID_MESSENGER: "Messages", FACEBOOK_MESSENGER: "Messenger", SNAPCHAT: "Snapchat", PINTEREST: "Pinterest", SKYPE: "Skype", TUMBLR: "Tumblr", VKONTAKTE: "VK", LINE: "LINE", KAKAO: "KakaoTalk" };
export const AGE = (s: string) => s.replace("age", "").replace("-", "–").replace("65–", "65+");
const name = (map: Record<string, string>, k: string | number) => map[String(k)] ?? String(k).toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export type YtDeep = {
  account: AccountSum;
  kpis: Kpi[];
  daily: Daily[];
  /** average daily views by weekday, Sun first (YouTube gives days, not hours) */
  weekday: number[];
  content: { label: string; views: number; watch_h: number; avg_pct: number | null; likes: number; subs: number }[];
  traffic: { key: string; label: string; views: number; watch_min: number; prev: number }[];
  search: Bar[]; external: Bar[]; related: Bar[]; playlists: Bar[];
  playback: Bar[]; devices: Bar[]; os: Bar[];
  subscribed: { label: string; views: number; watch_min: number; avg_pct: number | null }[];
  sharing: Bar[];
  countries: { code: string; views: number; watch_min: number; avg_s: number | null; subs: number }[];
  ages: Bar[]; genders: Bar[];
};

const CORE = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,dislikes,comments,shares,subscribersGained,subscribersLost,videosAddedToPlaylists,videosRemovedFromPlaylists";

/** One report, or nothing when YouTube won't answer it for this channel. */
const tryReport = (token: string, q: Record<string, string>) => settle(report(token, q)).then((r) => r ?? []);

export async function ytDeep(token: string, account: AccountSum, items: Item[], w: Win, range: Range): Promise<YtDeep> {
  const cur = { startDate: iso(w.start), endDate: iso(w.end) }, prev = { startDate: iso(w.prevStart), endDate: iso(w.prevEnd) };
  const detail = (type: string) => tryReport(token, { ...cur, dimensions: "insightTrafficSourceDetail", metrics: "views", filters: `insightTrafficSourceType==${type}`, sort: "-views", maxResults: "25" });
  const [tot, totPrev, engaged, engagedPrev, cards, cardsPrev, thumbs, thumbsPrev, day, dayPrev, content, traffic, trafficPrev, search, external, related, playlists, playback, devices, os, subscribed, sharing, countries, demo] = await Promise.all([
    tryReport(token, { ...cur, metrics: CORE }), tryReport(token, { ...prev, metrics: CORE }),
    tryReport(token, { ...cur, metrics: "engagedViews" }), tryReport(token, { ...prev, metrics: "engagedViews" }),
    tryReport(token, { ...cur, metrics: "cardImpressions,cardClicks,cardTeaserImpressions,cardTeaserClicks" }), tryReport(token, { ...prev, metrics: "cardImpressions,cardClicks,cardTeaserImpressions,cardTeaserClicks" }),
    tryReport(token, { ...cur, metrics: "videoThumbnailImpressions,videoThumbnailImpressionsClickRate" }), tryReport(token, { ...prev, metrics: "videoThumbnailImpressions,videoThumbnailImpressionsClickRate" }),
    tryReport(token, { ...cur, dimensions: "day", metrics: CORE, sort: "day" }), tryReport(token, { ...prev, dimensions: "day", metrics: CORE, sort: "day" }),
    tryReport(token, { ...cur, dimensions: "creatorContentType", metrics: "views,estimatedMinutesWatched,averageViewPercentage,likes,subscribersGained" }),
    tryReport(token, { ...cur, dimensions: "insightTrafficSourceType", metrics: "views,estimatedMinutesWatched", sort: "-views" }),
    tryReport(token, { ...prev, dimensions: "insightTrafficSourceType", metrics: "views", sort: "-views" }),
    detail("YT_SEARCH"), detail("EXT_URL"), detail("RELATED_VIDEO"), detail("PLAYLIST"),
    tryReport(token, { ...cur, dimensions: "insightPlaybackLocationType", metrics: "views", sort: "-views" }),
    tryReport(token, { ...cur, dimensions: "deviceType", metrics: "views", sort: "-views" }),
    tryReport(token, { ...cur, dimensions: "operatingSystem", metrics: "views", sort: "-views" }),
    tryReport(token, { ...cur, dimensions: "subscribedStatus", metrics: "views,estimatedMinutesWatched,averageViewPercentage" }),
    tryReport(token, { ...cur, dimensions: "sharingService", metrics: "shares", sort: "-shares", maxResults: "15" }),
    tryReport(token, { ...cur, dimensions: "country", metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained", sort: "-views", maxResults: "25" }),
    tryReport(token, { ...cur, dimensions: "ageGroup,gender", metrics: "viewerPercentage" }),
  ]);
  const T = tot[0] ?? {}, P = totPrev[0] ?? {};
  const n = (r: Row, k: string) => (r[k] == null ? null : Number(r[k]));
  const posted = (s: number, e: number) => items.filter((i) => i.at >= s && i.at < e + DAY).length;
  const views = n(T, "views"), pViews = n(P, "views");
  const net = (r: Row) => (r.subscribersGained == null ? null : Number(r.subscribersGained) - Number(r.subscribersLost ?? 0));
  const eng = (r: Row) => (r.likes == null ? null : Number(r.likes) + Number(r.comments ?? 0) + Number(r.shares ?? 0));
  const k = (key: string, label: string, group: string, value: number | null, prevV: number | null, about: string, unit: Kpi["unit"] = "", better: Kpi["better"] = "up"): Kpi => ({ key, label, group, value: round(value, 2), prev: round(prevV, 2), unit, about, better });
  const kpis: Kpi[] = [
    k("views", "Views", "Reach", views, pViews, "Times your videos were watched (Shorts count a view when one starts playing)."),
    k("engaged_views", "Engaged views", "Reach", n(engaged[0] ?? {}, "engagedViews"), n(engagedPrev[0] ?? {}, "engagedViews"), "Views past the first few seconds (Shorts) or meaningful watches: the views YouTube itself trusts."),
    k("impressions", "Thumbnail impressions", "Reach", n(thumbs[0] ?? {}, "videoThumbnailImpressions"), n(thumbsPrev[0] ?? {}, "videoThumbnailImpressions"), "How often YouTube showed your thumbnails to people."),
    k("ctr", "Impressions click rate", "Reach", n(thumbs[0] ?? {}, "videoThumbnailImpressionsClickRate"), n(thumbsPrev[0] ?? {}, "videoThumbnailImpressionsClickRate"), "Of the times a thumbnail was shown, how often it was clicked. Title + thumbnail strength.", "pct"),
    k("watch_h", "Watch time (hours)", "Watch", ratio(n(T, "estimatedMinutesWatched"), 60), ratio(n(P, "estimatedMinutesWatched"), 60), "Total hours people spent watching. YouTube's main ranking signal for long videos.", "h"),
    k("avg_dur", "Average view duration", "Watch", n(T, "averageViewDuration"), n(P, "averageViewDuration"), "How long a view lasts on average.", "s"),
    k("avg_pct", "Average % viewed", "Watch", n(T, "averageViewPercentage"), n(P, "averageViewPercentage"), "How much of a video the average view watches. Above 50% (videos) or 90% (Shorts, with loops) is strong.", "pct"),
    k("likes", "Likes", "Engagement", n(T, "likes"), n(P, "likes"), "Thumbs up."),
    k("dislikes", "Dislikes", "Engagement", n(T, "dislikes"), n(P, "dislikes"), "Thumbs down (only you see these).", "", "down"),
    k("comments", "Comments", "Engagement", n(T, "comments"), n(P, "comments"), "Comments left on your videos."),
    k("shares", "Shares", "Engagement", n(T, "shares"), n(P, "shares"), "Times someone used the Share button. The strongest sign a video travels."),
    k("er", "Engagement rate", "Engagement", ratio(eng(T), views, 100), ratio(eng(P), pViews, 100), "(Likes + comments + shares) ÷ views.", "pct"),
    k("likes_1k", "Likes per 1,000 views", "Engagement", ratio(n(T, "likes"), views, 1000), ratio(n(P, "likes"), pViews, 1000), "How much viewers liked what they saw, at any size.", "per1k"),
    k("shares_1k", "Shares per 1,000 views", "Engagement", ratio(n(T, "shares"), views, 1000), ratio(n(P, "shares"), pViews, 1000), "Shareability at any size. Viral videos sit well above your usual.", "per1k"),
    k("playlist_adds", "Saved to playlists", "Engagement", n(T, "videosAddedToPlaylists") == null ? null : Number(T.videosAddedToPlaylists) - Number(T.videosRemovedFromPlaylists ?? 0), P.videosAddedToPlaylists == null ? null : Number(P.videosAddedToPlaylists) - Number(P.videosRemovedFromPlaylists ?? 0), "Times viewers added your videos to a playlist (Watch later included), minus removals."),
    k("subs_gained", "Subscribers gained", "Growth", n(T, "subscribersGained"), n(P, "subscribersGained"), "New subscribers."),
    k("subs_lost", "Subscribers lost", "Growth", n(T, "subscribersLost"), n(P, "subscribersLost"), "Unsubscribes.", "", "down"),
    k("subs_net", "Net subscribers", "Growth", net(T), net(P), "Gained minus lost."),
    k("subs_1k", "Subscribers per 1,000 views", "Growth", ratio(net(T), views, 1000), ratio(net(P), pViews, 1000), "How well views turn into subscribers.", "per1k"),
    k("posts", "Videos published", "Output", posted(w.start, w.end), posted(w.prevStart, w.prevEnd), "Uploads that went public in the period."),
    k("views_post", "Views per video published", "Output", ratio(views, posted(w.start, w.end)), ratio(pViews, posted(w.prevStart, w.prevEnd)), "Views in the period ÷ videos published in it (old videos still count toward the views)."),
    k("card_clicks", "Card clicks", "Engagement", n(cards[0] ?? {}, "cardClicks"), n(cardsPrev[0] ?? {}, "cardClicks"), "Clicks on info cards in your videos."),
  ].filter((x) => x.value != null || x.prev != null);

  const series = (key: string, label: string, unit: Kpi["unit"], f: (rows: Row[], start: number) => number[]): Daily => ({ key, label, unit, cur: f(day, w.start), prev: f(dayPrev, w.prevStart) });
  const m = (metric: string) => (rows: Row[], start: number) => fold(rows, start, range, metric);
  const daily: Daily[] = day.length ? [
    series("views", "Views", "", m("views")),
    series("watch_h", "Watch hours", "h", (r, s) => fold(r, s, range, "estimatedMinutesWatched").map((v) => Math.round(v / 6) / 10)),
    series("subs_net", "Net subscribers", "", (r, s) => { const lost = fold(r, s, range, "subscribersLost"); return fold(r, s, range, "subscribersGained").map((v, i) => v - lost[i]); }),
    series("likes", "Likes", "", m("likes")), series("comments", "Comments", "", m("comments")), series("shares", "Shares", "", m("shares")),
    series("avg_pct", "Average % viewed", "pct", m("averageViewPercentage")), series("avg_dur", "Average view duration", "s", m("averageViewDuration")),
    series("playlist_adds", "Saved to playlists", "", m("videosAddedToPlaylists")),
  ] : [];

  const prevT = new Map(trafficPrev.map((r) => [String(r.insightTrafficSourceType), Number(r.views)]));
  const titles = new Map(items.map((i) => [i.id, i.title]));
  const bars = (rows: Row[], dim: string, metric: string, map?: Record<string, string>) => rows.map((r) => [map ? name(map, r[dim]) : String(r[dim]), Number(r[metric])] as Bar).filter((b) => b[1] > 0);
  const ages = new Map<string, number>(), genders = new Map<string, number>();
  for (const r of demo) {
    const a = AGE(String(r.ageGroup));
    ages.set(a, (ages.get(a) ?? 0) + Number(r.viewerPercentage));
    const g = String(r.gender) === "female" ? "Women" : String(r.gender) === "male" ? "Men" : "Other";
    genders.set(g, (genders.get(g) ?? 0) + Number(r.viewerPercentage));
  }
  return {
    account, kpis, daily,
    weekday: day.length ? byWeekday(w.days, fold(day, w.start, range, "views")) : [],
    content: content.map((r) => ({ label: name(CONTENT, r.creatorContentType), views: Number(r.views), watch_h: Math.round(Number(r.estimatedMinutesWatched) / 6) / 10, avg_pct: round(Number(r.averageViewPercentage)), likes: Number(r.likes), subs: Number(r.subscribersGained) })).filter((c) => c.views > 0),
    traffic: traffic.map((r) => ({ key: String(r.insightTrafficSourceType), label: name(TRAFFIC, r.insightTrafficSourceType), views: Number(r.views), watch_min: Number(r.estimatedMinutesWatched), prev: prevT.get(String(r.insightTrafficSourceType)) ?? 0 })).filter((t) => t.views > 0),
    search: bars(search, "insightTrafficSourceDetail", "views"),
    external: bars(external, "insightTrafficSourceDetail", "views"),
    related: related.map((r) => [titles.get(String(r.insightTrafficSourceDetail)) ?? `Video ${r.insightTrafficSourceDetail}`, Number(r.views)] as Bar).filter((b) => b[1] > 0),
    playlists: bars(playlists, "insightTrafficSourceDetail", "views"),
    playback: bars(playback, "insightPlaybackLocationType", "views", PLAYBACK),
    devices: bars(devices, "deviceType", "views", DEVICES),
    os: bars(os, "operatingSystem", "views", OS),
    subscribed: subscribed.map((r) => ({ label: String(r.subscribedStatus) === "SUBSCRIBED" ? "Subscribers" : "Not subscribed", views: Number(r.views), watch_min: Number(r.estimatedMinutesWatched), avg_pct: round(Number(r.averageViewPercentage)) })),
    sharing: bars(sharing, "sharingService", "shares", SHARING),
    countries: countries.map((r) => ({ code: String(r.country), views: Number(r.views), watch_min: Number(r.estimatedMinutesWatched), avg_s: round(Number(r.averageViewDuration), 0), subs: Number(r.subscribersGained) })),
    ages: [...ages].sort((x, y) => x[0].localeCompare(y[0])).map(([a, v]) => [a, round(v)!] as Bar),
    genders: [...genders].map(([g, v]) => [g, round(v)!] as Bar),
  };
}

export type PostDetail = {
  network: "youtube" | "instagram"; id: string; title: string; url: string; at: number | null; kind: string;
  kpis: Kpi[];
  /** YouTube: share of the audience still watching at each 1% of the video, and how that compares with similar videos */
  retention: { x: number[]; watch: number[]; relative: number[] } | null;
  /** YouTube: views each day since it went out (up to 60 days) */
  velocity: { days: string[]; views: number[]; peak: string | null; first2: number | null; first7: number | null } | null;
  traffic: Bar[];
  /** Instagram: what people did on the profile after seeing it, story taps, where it was seen */
  actions: Bar[];
  notes: string[];
};

/** One video in depth: lifetime totals, the retention curve, views by day since upload, and its traffic sources. */
export async function ytPost(token: string, id: string, item?: Item): Promise<PostDetail> {
  type V = { items?: { snippet: { title: string; publishedAt: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; favoriteCount?: string }; contentDetails?: { duration?: string } }[] };
  const v = (await (await import("./publish/youtube")).ytGet<V>(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${id}`, token)).items?.[0];
  if (!v) throw new Error("YouTube doesn't know that video");
  const at = Date.parse(v.snippet.publishedAt);
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const end = Math.min(today - DAY, Math.floor(at / DAY) * DAY + 59 * DAY);
  const f = `video==${id}`;
  const [tot, ret, days, traffic] = await Promise.all([
    tryReport(token, { startDate: iso(at), endDate: iso(today), metrics: `${CORE},engagedViews`, filters: f }).then((r) => (r.length ? r : tryReport(token, { startDate: iso(at), endDate: iso(today), metrics: CORE, filters: f }))),
    tryReport(token, { startDate: iso(at), endDate: iso(today), dimensions: "elapsedVideoTimeRatio", metrics: "audienceWatchRatio,relativeRetentionPerformance", filters: f }),
    end >= Math.floor(at / DAY) * DAY ? tryReport(token, { startDate: iso(at), endDate: iso(end), dimensions: "day", metrics: "views", filters: f, sort: "day" }) : Promise.resolve([] as Row[]),
    tryReport(token, { startDate: iso(at), endDate: iso(today), dimensions: "insightTrafficSourceType", metrics: "views", filters: f, sort: "-views" }),
  ]);
  const T = tot[0] ?? {};
  const n = (k: string) => (T[k] == null ? null : Number(T[k]));
  const views = n("views") ?? Number(v.statistics?.viewCount ?? 0);
  const k = (key: string, label: string, value: number | null, about: string, unit: Kpi["unit"] = ""): Kpi => ({ key, label, group: "Lifetime", value: round(value, 2), prev: null, unit, about });
  const eng = (n("likes") ?? 0) + (n("comments") ?? 0) + (n("shares") ?? 0);
  const kpis = [
    k("views", "Views", views, "All-time views."), k("engaged_views", "Engaged views", n("engagedViews"), "Views YouTube counts as meaningful."),
    k("watch_h", "Watch hours", ratio(n("estimatedMinutesWatched"), 60), "All-time hours watched.", "h"),
    k("avg_dur", "Average view duration", n("averageViewDuration"), "How long a view lasts.", "s"), k("avg_pct", "Average % viewed", n("averageViewPercentage"), "How much of it the average view watches.", "pct"),
    k("likes", "Likes", n("likes") ?? Number(v.statistics?.likeCount ?? 0), ""), k("comments", "Comments", n("comments") ?? Number(v.statistics?.commentCount ?? 0), ""),
    k("shares", "Shares", n("shares"), "Share button presses."), k("playlist_adds", "Saved to playlists", n("videosAddedToPlaylists"), ""),
    k("subs", "Subscribers gained", n("subscribersGained"), "People who subscribed from this video."), k("subs_lost", "Subscribers lost", n("subscribersLost"), ""),
    k("er", "Engagement rate", ratio(eng, views, 100), "(Likes + comments + shares) ÷ views.", "pct"),
    k("shares_1k", "Shares per 1,000 views", ratio(n("shares"), views, 1000), "", "per1k"), k("subs_1k", "Subscribers per 1,000 views", ratio(n("subscribersGained"), views, 1000), "", "per1k"),
    ...(item?.score != null ? [k("score", "Score vs your usual", item.score, "Views ÷ the median of your videos of this format.", "x")] : []),
  ].filter((x) => x.value != null);
  const r = ret.sort((a, b) => Number(a.elapsedVideoTimeRatio) - Number(b.elapsedVideoTimeRatio));
  const vd: [string, number][] = days.map((d) => [String(d.day), Number(d.views)]);
  const total = sum(vd.map((d) => d[1]));
  const peak = vd.length ? vd.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null;
  const notes: string[] = [];
  if (r.length) {
    const at30 = r.find((x) => Number(x.elapsedVideoTimeRatio) >= 0.3);
    if (at30) notes.push(`${Math.round(Number(at30.audienceWatchRatio) * 100)}% of viewers are still watching 30% of the way in.`);
    let drop = { d: 0, at: 0 };
    for (let i = 1; i < r.length; i++) {
      const d = Number(r[i - 1].audienceWatchRatio) - Number(r[i].audienceWatchRatio);
      if (d > drop.d) drop = { d, at: Number(r[i].elapsedVideoTimeRatio) };
    }
    if (drop.d > 0.05) notes.push(`The steepest drop is around ${Math.round(drop.at * 100)}% of the way through: look at what happens there.`);
    if (Number(r.at(-1)?.audienceWatchRatio) > 1) notes.push("People rewatch the end: the loop works.");
  }
  if (vd.length >= 3 && total) notes.push(`${Math.round(((vd[0][1] + (vd[1]?.[1] ?? 0)) / total) * 100)}% of its first ${vd.length} days of views came in the first 2 days.`);
  return {
    network: "youtube", id, title: v.snippet.title, url: item?.url ?? `https://youtu.be/${id}`, at, kind: item?.fmt === "yt_short" ? "Short" : "Video", kpis,
    retention: r.length ? { x: r.map((x) => Math.round(Number(x.elapsedVideoTimeRatio) * 100)), watch: r.map((x) => round(Number(x.audienceWatchRatio) * 100)!), relative: r.map((x) => round(Number(x.relativeRetentionPerformance), 2)!) } : null,
    velocity: vd.length ? { days: vd.map((d) => d[0]), views: vd.map((d) => d[1]), peak, first2: total ? round(((vd[0][1] + (vd[1]?.[1] ?? 0)) / total) * 100) : null, first7: total ? round((sum(vd.slice(0, 7).map((d) => d[1])) / total) * 100) : null } : null,
    traffic: traffic.map((t) => [name(TRAFFIC, t.insightTrafficSourceType), Number(t.views)] as Bar).filter((b) => b[1] > 0),
    actions: [], notes,
  };
}
