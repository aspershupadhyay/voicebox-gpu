// Small pieces the analytics modules share (lib/analytics.ts, analytics-yt.ts, analytics-ig.ts): dates and windows, the
// YouTube Analytics report call, the KPI shape and a few number helpers.
import * as YT from "./publish/youtube";

export const RANGES = [7, 28, 90] as const;
export type Range = (typeof RANGES)[number];
export type Bar = [string, number];
/** One number on a scorecard: this period, the period before, how to show it and what it means. */
export type Kpi = {
  key: string; label: string; group: string; value: number | null; prev: number | null;
  unit?: "" | "pct" | "s" | "h" | "x" | "per1k";
  /** what it counts, in a sentence (shown on hover and handed to MCP clients) */
  about: string;
  /** which way is good (most are up) */
  better?: "up" | "down";
};
/** A daily metric for a chart: one value a day, and the same days of the period before. */
export type Daily = { key: string; label: string; cur: number[]; prev: number[]; unit?: Kpi["unit"] };

export const DAY = 864e5;
export const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
export const settle = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
export const msg = (e: unknown) => (e as Error)?.message ?? String(e);
export const hashtagsOf = (s: string) => [...new Set((s.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.toLowerCase()))];
export const ratio = (a: number | null | undefined, b: number | null | undefined, k = 1) => (a == null || !b ? null : (a / b) * k);
export const round = (n: number | null, d = 1) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

/** The window: `range` whole days ending yesterday (today's numbers are still coming in), and the one before it. */
export function windows(range: Range) {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY;
  const start = end - (range - 1) * DAY;
  const days = Array.from({ length: range }, (_, i) => iso(start + i * DAY));
  return { start, end, prevStart: start - range * DAY, prevEnd: start - DAY, days };
}
export type Win = ReturnType<typeof windows>;

/** Rows keyed by column: [{ day: "2026-10-01", views: 120, … }] (YouTube Analytics API reports.query). */
export type Row = Record<string, string | number>;
const YTA = "https://youtubeanalytics.googleapis.com/v2/reports";
export function report(token: string, q: Record<string, string>): Promise<Row[]> {
  return YT.ytGet<{ columnHeaders?: { name: string }[]; rows?: (string | number)[][] }>(`${YTA}?${new URLSearchParams({ ids: "channel==MINE", ...q })}`, token).then((r) => {
    const cols = (r.columnHeaders ?? []).map((c) => c.name);
    return (r.rows ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])) as Row);
  });
}

/** A metric across the window's days (missing days are 0). */
export function fold(rows: Row[], start: number, range: number, metric: string, pick: (r: Row) => boolean = () => true) {
  const out = new Array(range).fill(0);
  for (const r of rows) {
    const i = Math.round((Date.parse(String(r.day)) - start) / DAY);
    if (i >= 0 && i < range && pick(r)) out[i] += Number(r[metric] ?? 0);
  }
  return out;
}

/** The same weekday, averaged: which days of the week the numbers land on (Sun first). */
export function byWeekday(days: string[], values: number[]) {
  const t = new Array(7).fill(0), n = new Array(7).fill(0);
  days.forEach((d, i) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); t[w] += values[i] ?? 0; n[w]++; });
  return t.map((v, i) => (n[i] ? Math.round(v / n[i]) : 0));
}
