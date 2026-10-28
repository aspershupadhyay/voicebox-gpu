// What the Grow pages share with lib/live.ts (types and small pure helpers), safe to import in the browser.
import type { Fmt } from "./analytics";

/** The ages (minutes) a finished curve keeps: what "your usual post at this age" is made of. */
export const AGES = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320];

export type Net = "youtube" | "instagram";
/** [minute (epoch ms / 60 000), views, likes, comments] */
export type Pt = [number, number, number, number];
export type Track = {
  id: string; net: Net; owner: string; fmt: Fmt; title: string; thumb: string | null; url: string; at: number; dur: number | null; pts: Pt[];
};
export type Vid = { id: string; title: string; thumb: string | null; at: number; dur: number | null; fmt: Fmt; views: number; likes: number; comments: number };
export type Chan = {
  id: string; net: Net; rival: boolean; name: string; handle: string | null; avatar: string | null; uploads: string | null;
  subs: number | null; views: number | null; videos: number | null;
  /** [minute, subscribers, total views], one every 5 minutes for 2 days, then hourly, for 90 days */
  pts: [number, number, number][];
  /** the last 50 uploads with their counts (every 3 hours) */
  recent: Vid[]; recent_at: number;
};
export type Curve = { id: string; owner: string; fmt: Fmt; at: number; title: string; v: (number | null)[] };
export type Rival = { handle: string; net: Net; pinned: boolean; id?: string | null; error?: string | null };
/** A rival's address under /analytics/competitors/ (the handle without its @; Instagram ones carry "ig-"). */
export const rivalSlug = (r: Pick<Rival, "net" | "handle">) => `${r.net === "instagram" ? "ig-" : ""}${r.handle.replace(/^@/, "")}`;
export type LiveState = {
  v: 1; at: number; runs: number; quota: { day: string; units: number };
  /** each rival handle's channel, once found ("youtube:@handle" → id) */
  found: Record<string, { id: string | null; error: string | null }>;
  chans: Record<string, Chan>;
  tracks: Record<string, Track>;
  curves: Curve[];
  errors: { at: number; text: string }[];
};

export type Band = { ages: number[]; lo: (number | null)[]; mid: (number | null)[]; hi: (number | null)[]; n: number };
/** A band's value at any age, straight-line between the kept ages. */
export function bandAt(b: Band, k: "lo" | "mid" | "hi", age: number) {
  const xs = b.ages, ys = b[k];
  if (age <= xs[0]) return ys[0] == null ? null : Math.round((ys[0] * age) / xs[0]);
  for (let i = 1; i < xs.length; i++) {
    if (age <= xs[i]) {
      const [a, c] = [ys[i - 1], ys[i]];
      if (a == null || c == null) return null;
      return Math.round(a + ((c - a) * (age - xs[i - 1])) / (xs[i] - xs[i - 1]));
    }
  }
  return ys.at(-1) ?? null;
}

export type Verdict = { tone: "ok" | "blue" | "warn" | "bad" | "dim"; label: string; x: number | null; basis: "curve" | "lifetime" | "none" };
export type LivePost = Omit<Track, "pts"> & {
  pts: Pt[]; views: number; likes: number; comments: number; last_hour: number; per_hour: number; age_min: number;
  band: Band | null; verdict: Verdict; usual_life: number | null;
};
export type LiveChan = Omit<Chan, "recent" | "pts"> & {
  pts: [number, number, number][];
  /** subscribers gained in the last 24 hours, 7 days and 28 days (from Voicebox's own points) */
  d1: number | null; d7: number | null; d28: number | null;
  usual: Partial<Record<Fmt, number>>; per_week: number | null; avg_len: Partial<Record<Fmt, number>>;
  /** when they post: uploads by weekday (Sun first) and by 3-hour slot (UTC) */
  days: number[]; slots: number[];
  er: number | null; recent: (Vid & { score: number | null })[];
};
export type LiveView = {
  at: number; age_s: number; quota: LiveState["quota"]; rivals: Rival[]; errors: LiveState["errors"];
  posts: LivePost[]; chans: LiveChan[]; outliers: (Vid & { owner: string; score: number })[]; curves: number;
};

