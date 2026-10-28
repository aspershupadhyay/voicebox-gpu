// What the Writing room reads, gathered on the server in one answer: your posts of the last 90 days with their scores
// (from the analytics report, cached 30 min), your rivals' last uploads against their own usual (from Grow's live
// state, read without asking the platforms), the lengths and hashtags that work, and the captions kept per target.
import { getAnalytics } from "./analytics";
import { getCaptions } from "./captions";
import { liveView, loadLive, loadRivals } from "./live";
import type { WItem, WRival } from "./writing";

export type WritingData = {
  at: number; items: WItem[]; rivals: WRival[];
  lengths: { label: string; n: number; median: number }[];
  tags: { tag: string; n: number; score: number }[];
  /** your best-performing length in seconds per format (the median length of your hits) */
  best_len: Record<string, number>;
  captions: Awaited<ReturnType<typeof getCaptions>>;
  needs: string[];
};

export async function writingData(background?: (p: Promise<unknown>) => void): Promise<WritingData> {
  const [a, live, captions] = await Promise.all([
    getAnalytics(90, false, background).catch(() => null),
    Promise.all([loadLive(), loadRivals()]).then(([s, r]) => liveView(s, r)).catch(() => null),
    getCaptions().catch(() => ({})),
  ]);
  const items: WItem[] = (a?.items ?? []).map((i) => ({
    id: i.id, network: i.network, fmt: i.fmt, title: i.title, url: i.url, thumb: i.thumb, at: i.at, views: i.views ?? i.reach,
    score: i.score, duration: i.duration, tags: i.tags.slice(0, 12), post: i.post,
  }));
  const rivals: WRival[] = (live?.chans ?? []).filter((c) => c.rival).flatMap((c) => c.recent.map((v) => ({
    id: v.id, owner: c.id, name: c.name, avatar: c.avatar, title: v.title, thumb: v.thumb, at: v.at, fmt: v.fmt, views: v.views,
    url: c.net === "youtube" ? (v.fmt === "yt_short" ? `https://youtube.com/shorts/${v.id}` : `https://youtu.be/${v.id}`) : `https://instagram.com/${c.handle?.replace(/^@/, "") ?? ""}`,
    x: (v as { score?: number | null }).score ?? null,
  })));
  const best_len: Record<string, number> = {};
  for (const f of ["yt_video", "yt_short", "ig_reel"] as const) {
    const ls = items.filter((i) => i.fmt === f && i.duration && i.score != null && i.score >= 1.5).map((i) => i.duration!).sort((x, y) => x - y);
    if (ls.length >= 2) best_len[f] = Math.round(ls[ls.length >> 1]);
  }
  return {
    at: Date.now(), items, rivals, lengths: a?.lengths ?? [], tags: a?.tags ?? [], best_len, captions,
    needs: [...(a ? [] : ["Analytics couldn't be read: connect YouTube or Instagram in Posts → Autopilot."]), ...(a?.needs ?? []).map((n) => n.text)],
  };
}
