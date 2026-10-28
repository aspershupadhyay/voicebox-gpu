"use client";
// The Analytics page's parts, shared by the overview and the YouTube and Instagram tabs: number formats, the trend
// arrow, a line chart (this period solid over the one before dashed, hover and arrow-key read-out), a column chart, bar
// rows, the day × time heatmap, the score pill, the KPI scorecard, a sparkline, the trend board (metric tiles that pick
// the big chart, as YouTube Studio does) and the performance quadrant. Styles: the .an-* block in app/globals.css.
import { ArrowDownRight, ArrowUpRight, ChartLineUp, Fire } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Bar, Daily, Item, Kpi } from "@/lib/analytics";
import { Select } from "./pop";
import { Empty } from "./ui";

export const compact = (n: number | null | undefined) => (n == null ? "—" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n));
export const full = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString());
export const change = (cur: number | null | undefined, prev: number | null | undefined) => (cur == null || !prev ? null : (cur - prev) / Math.abs(prev));
export const pct = (x: number | null | undefined, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
export const day = (s: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...opts });
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const SLOTS = ["12 AM", "3 AM", "6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"];
export const hour = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`);

/** A number in its unit: 12.4% · 1:23 · 8.2K h · 2.1× · 4.3 per 1k. */
export function fmtUnit(v: number | null | undefined, unit: Kpi["unit"] = "", short = true) {
  if (v == null || !isFinite(v)) return "—";
  if (unit === "pct") return `${v >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, "")}%`;
  if (unit === "s") return dur(v);
  if (unit === "h") return `${short ? compact(v) : full(v)} h`;
  if (unit === "x") return `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`;
  if (unit === "per1k") return v >= 100 ? Math.round(v).toString() : v.toFixed(1);
  return short ? compact(v) : full(v);
}

/** ↗ 34% in green, ↘ 12% in red (or the other way for things that should go down), or "new". */
export function Trend({ v, size = "md", better = "up" }: { v: number | null; size?: "md" | "sm"; better?: "up" | "down" }) {
  if (v == null || !isFinite(v)) return <span className={`an-trend flat ${size}`}>new</span>;
  const up = v >= 0, good = better === "up" ? up : !up;
  const Ic = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`an-trend ${v === 0 ? "flat" : good ? "up" : "down"} ${size}`}>
      <Ic size={size === "sm" ? 12 : 14} weight="bold" aria-hidden /><span className="sr-only">{up ? "up" : "down"}</span>
      {Math.abs(v) >= 10 ? `${Math.round(Math.abs(v) + 1)}×` : `${Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`}
    </span>
  );
}

/** A smooth line through the points (monotone, so it never overshoots below zero). */
function curve(pts: [number, number][]) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  const n = pts.length, d: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  let s = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (pts[i + 1][0] - pts[i][0]) / 3;
    s += ` C${pts[i][0] + h},${pts[i][1] + m[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - m[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return s;
}
const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v)), r = v / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
};

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const o = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    o.observe(ref.current);
    return () => o.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A line over x labels: `cur` solid, `prev` (the period before) dashed. Hover or arrow keys read each point. */
export function LineChart({ labels, cur, prev, unit = "", name, prevName = "the period before", tipLabel, height = 240, mark, minMax }: {
  labels: string[]; cur: number[]; prev?: number[] | null; unit?: Kpi["unit"]; name: string; prevName?: string; tipLabel?: (i: number) => string; height?: number;
  /** a point to call out (the peak, say), as an index */
  mark?: number | null; minMax?: number;
}) {
  const [box, W] = useWidth<HTMLDivElement>();
  const [h, setH] = useState<number | null>(null);
  const H = height, L = 46, R = 10, T = 26, B = 26;
  const n = cur.length;
  const max = niceMax(Math.max(minMax ?? 1, ...cur, ...(prev ?? [])));
  const x = (i: number) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - Math.max(0, v) / max) * (H - T - B);
  const pc = cur.map((v, i) => [x(i), y(v)] as [number, number]);
  const pp = prev?.map((v, i) => [x(i), y(v)] as [number, number]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L) / 72))));
  const pick = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    setH(Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left - L) / (W - L - R)) * (n - 1)))));
  };
  const totalCur = cur.reduce((a, b) => a + b, 0), totalPrev = prev?.reduce((a, b) => a + b, 0) ?? null;
  if (!n) return <Empty icon={<ChartLineUp size={22} />} title="Nothing to chart yet" />;
  return (
    <>
      <div ref={box} className="an-chart" onPointerMove={(e) => pick(e.clientX)} onPointerLeave={() => setH(null)} tabIndex={0} role="img"
        aria-label={`${name}: ${unit === "" ? `${full(totalCur)} in all${totalPrev != null ? `, against ${full(totalPrev)} ${prevName}` : ""}` : `${n} points`}. Arrow keys read each point.`}
        onKeyDown={(e) => { if (e.key === "ArrowRight") setH((v) => Math.min(n - 1, (v ?? -1) + 1)); if (e.key === "ArrowLeft") setH((v) => Math.max(0, (v ?? n) - 1)); if (e.key === "Escape") setH(null); }}>
        <svg width={W} height={H} aria-hidden>
          {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="an-grid" /><text x={L - 8} y={y(t) + 4} className="an-axis" textAnchor="end">{fmtUnit(t, unit)}</text></g>)}
          {labels.map((lb, i) => (i % every === 0 || i === n - 1) && (n - 1 - i > every / 2 || i === n - 1) ? <text key={i} x={x(i)} y={H - 6} className="an-axis" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{lb}</text> : null)}
          <path d={`${curve(pc)} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`} className="an-area" />
          {pp && <path d={curve(pp)} className="an-line prev" />}
          <path d={curve(pc)} className="an-line" />
          {mark != null && mark >= 0 && mark < n && <circle cx={x(mark)} cy={y(cur[mark])} r={4.5} className="an-dot mark" />}
          {h !== null && <>
            <line x1={x(h)} x2={x(h)} y1={T - 6} y2={y(0)} className="an-cross" />
            {prev && <circle cx={x(h)} cy={y(prev[h])} r={3.5} className="an-dot prev" />}
            <circle cx={x(h)} cy={y(cur[h])} r={4.5} className="an-dot" />
          </>}
        </svg>
        {h !== null && (
          <div className="an-tip" style={{ left: Math.min(Math.max(x(h), 96), W - 96), top: Math.max(0, y(Math.max(cur[h], prev?.[h] ?? 0)) - 74) }} aria-live="polite">
            <span className="an-tip-d">{tipLabel ? tipLabel(h) : labels[h]}</span>
            <span className="an-tip-row"><i className="k" /><b className="mono">{fmtUnit(cur[h], unit, false)}</b> {name.toLowerCase()}</span>
            {prev && <span className="an-tip-row"><i className="k prev" /><b className="mono">{fmtUnit(prev[h], unit, false)}</b> {prevName}</span>}
            {prev && cur[h] !== prev[h] && <span className={`an-delta ${cur[h] >= prev[h] ? "up" : "down"}`}>{cur[h] >= prev[h] ? "+" : "−"}{fmtUnit(Math.abs(cur[h] - prev[h]), unit)}</span>}
          </div>
        )}
      </div>
    </>
  );
}

/** Upright columns, one per label, the best one marked. Hover or focus a column to read it. */
export function Columns({ labels, values, unit = "", name, best = true, every = 1 }: { labels: string[]; values: number[]; unit?: Kpi["unit"]; name: string; best?: boolean; every?: number }) {
  const max = Math.max(1, ...values);
  const top = best ? values.indexOf(Math.max(...values)) : -1;
  const [tip, setTip] = useState<number | null>(null);
  return (
    <div className="an-cols" role="list" aria-label={name}>
      {values.map((v, i) => (
        <div key={i} role="listitem" className="an-col" tabIndex={0} aria-label={`${labels[i]}: ${fmtUnit(v, unit, false)}`}
          onPointerEnter={() => setTip(i)} onPointerLeave={() => setTip(null)} onFocus={() => setTip(i)} onBlur={() => setTip(null)}>
          <span className="an-col-bar"><i className={i === top && v > 0 ? "top" : ""} style={{ height: `${Math.max(2, (v / max) * 100)}%` }} /></span>
          <span className="an-col-l">{i % every === 0 ? labels[i] : ""}</span>
          {tip === i && <span className="an-cell-tip" role="presentation"><b className="mono">{fmtUnit(v, unit, false)}</b>{labels[i]}</span>}
        </div>
      ))}
    </div>
  );
}

/** A labelled horizontal bar per row, one hue; the value is written beside it, never only in the bar. */
export function Bars({ rows, unit, tone = "c-youtube", limit = 10 }: { rows: Bar[]; unit?: (v: number) => string; tone?: string; limit?: number }) {
  const [more, setMore] = useState(false);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const shown = more ? rows : rows.slice(0, limit);
  return (
    <div className="an-bars">
      {shown.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="an-bar-r">
          <span className="ellipsis" title={k}>{k}</span>
          <span className="an-bar"><i className={tone} style={{ width: `${Math.max(2, (v / max) * 100)}%` }} /></span>
          <span className="mono">{unit ? unit(v) : compact(v)}</span>
        </div>
      ))}
      {rows.length > limit && <button type="button" className="quiet xs an-more" onClick={() => setMore((m) => !m)}>{more ? "Show fewer" : `Show all ${rows.length}`}</button>}
    </div>
  );
}
export const share = (rows: Bar[]) => { const t = rows.reduce((a, b) => a + b[1], 0); return (v: number) => pct(t ? v / t : 0); };

export function Heatmap({ heat, metric, tz, title = "When to post", id, action, sub, format }: { heat: { v: number; n: number }[][]; metric: string; tz: string; title?: string; id: string; action?: React.ReactNode;
  /** the line under the title (default: how posts did by when they went out) */ sub?: string; format?: (v: number) => string }) {
  const vals = heat.flat().filter((c) => c.n).map((c) => c.v).sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
  const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const level = (c: { v: number; n: number }) => (!c.n ? 0 : 1 + cuts.filter((t) => c.v > t).length);
  const fmt = format ?? ((v: number) => (metric === "engagements" ? compact(v) : `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`));
  const [tip, setTip] = useState<{ d: number; s: number } | null>(null);
  let best = { d: -1, s: -1, v: -1 };
  heat.forEach((r, d) => r.forEach((c, s) => { if (c.n && c.v > best.v) best = { d, s, v: c.v }; }));
  return (
    <section className="card an-card" aria-labelledby={id}>
      <div className="card-head">
        <div><h2 id={id}>{title}</h2><p className="sub">{sub ?? `How posts did by when they went out (${metric})`}, {tz.replace("_", " ")} time</p></div>
        <div className="row" style={{ gap: 12 }}>
          {!!vals.length && <div className="an-heat-key" aria-hidden><span><i className="h0" />No posts</span><span><i className="h1" />Low</span><span><i className="h5" />Best</span></div>}
          {action}
        </div>
      </div>
      {!vals.length ? <Empty icon={<Fire size={22} />} title="Not enough posts yet">After a few posts this shows the days and times that work for you.</Empty> : (
        <div className="an-heat" role="table" aria-label="Average result by day and time">
          {heat.map((row, d) => (
            <div role="row" key={d} className="an-heat-r">
              <span role="rowheader">{DAYS[d]}</span>
              {row.map((c, s) => (
                <span key={s} role="cell" tabIndex={c.n ? 0 : -1} className={`an-cell h${level(c)} ${tip?.d === d && tip.s === s ? "hot" : ""}`}
                  aria-label={`${DAYS[d]} ${SLOTS[s]}: ${c.n ? `${c.n} post${c.n > 1 ? "s" : ""}, ${fmt(c.v)}` : "no posts"}`}
                  onPointerEnter={() => setTip({ d, s })} onPointerLeave={() => setTip(null)} onFocus={() => setTip({ d, s })} onBlur={() => setTip(null)}>
                  {tip?.d === d && tip.s === s && <span className="an-cell-tip" role="presentation"><b className="mono">{c.n ? fmt(c.v) : "—"}</b>{DAYS[d]} {SLOTS[s]}–{SLOTS[(s + 1) % 8]} · {c.n} post{c.n === 1 ? "" : "s"}</span>}
                </span>
              ))}
            </div>
          ))}
          <div role="row" className="an-heat-r head"><span role="columnheader" />{SLOTS.map((s) => <span role="columnheader" key={s}>{s}</span>)}</div>
          {best.d >= 0 && <p className="small dim" style={{ margin: "10px 0 0" }}>Best slot: <b className="an-ink">{DAYS[best.d]} {SLOTS[best.s]}–{SLOTS[(best.s + 1) % 8]}</b> ({fmt(best.v)}). Brighter is better.</p>}
        </div>
      )}
    </section>
  );
}

export function Score({ v }: { v: number | null }) {
  if (v == null) return <span className="tiny dim">—</span>;
  const tone = v >= 3 ? "ok" : v >= 1.5 ? "blue" : v >= 0.7 ? "" : "warn";
  return <span className={`pill ${tone} mono`} title="Views against the usual for this format">{v >= 3 && <Fire size={12} weight="fill" aria-hidden />}{v >= 10 ? Math.round(v) : v.toFixed(1)}×</span>;
}

/** Every KPI as one grid of tinted cards, in group order (Reach, Watch, Engagement, Growth, Output), each with its
 *  group, its value, the trend against the period before and what it was then. Hover a card for what it counts. */
export function Scorecard({ kpis, range, cols = 4 }: { kpis: Kpi[]; range: number; cols?: number }) {
  const order = [...new Set(kpis.map((k) => k.group))];
  const sorted = [...kpis].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  return (
    <div className="an-kpis" style={{ "--cols": cols } as React.CSSProperties}>
      {sorted.map((k) => (
        <div key={k.key} className="an-kpi" title={k.about}>
          <span className="an-kpi-g">{k.group}</span>
          <span className="an-k">{k.label}</span>
          <div className="an-kpi-v">
            <span className="mono">{fmtUnit(k.value, k.unit)}</span>
            {k.prev != null && <Trend v={change(k.value, k.prev)} size="sm" better={k.better} />}
          </div>
          <span className="an-kpi-a">{k.prev != null ? `${fmtUnit(k.prev, k.unit)} the ${range} days before` : k.about.split(". ")[0]}</span>
        </div>
      ))}
    </div>
  );
}

/** A metric picker over daily series, then the chart. */
export function DailyCard({ id, title, daily, days, range, extra }: { id: string; title: string; daily: { key: string; label: string; cur: number[]; prev: number[]; unit?: Kpi["unit"] }[]; days: string[]; range: number; extra?: React.ReactNode }) {
  const [k, setK] = useState(daily[0]?.key ?? "");
  const s = daily.find((d) => d.key === k) ?? daily[0];
  if (!s) return null;
  const avg = s.unit === "pct" || s.unit === "s";
  const tot = (xs: number[]) => (avg ? xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.filter((v) => v > 0).length) : xs.reduce((a, b) => a + b, 0));
  const hasPrev = s.prev.some((v) => v !== 0);
  return (
    <section className="card an-card" aria-labelledby={id}>
      <div className="card-head">
        <div><h2 id={id}>{title}</h2><p className="sub">{fmtUnit(tot(s.cur), s.unit, false)} {avg ? "on average" : `in ${range} days`} {hasPrev && <Trend v={change(tot(s.cur), tot(s.prev))} size="sm" />}</p></div>
        {daily.length > 1 && <Select className="an-sel" size="sm" label={`${title}: metric`} value={s.key} onChange={setK} options={daily.map((d) => [d.key, d.label] as const)} />}
      </div>
      <LineChart labels={days.map((d) => day(d))} cur={s.cur} prev={hasPrev ? s.prev : null} unit={s.unit} name={s.label} tipLabel={(i) => day(days[i], { weekday: "short", month: "short", day: "numeric" })} />
      <div className="an-legend"><span><i className="k" />Last {range} days</span>{hasPrev && <span><i className="k prev" />The {range} days before</span>}{extra}</div>
    </section>
  );
}

/** A small line of the period, no axes: the shape at a glance. */
export function Sparkline({ values, w = 96, h = 28, label, fit }: { values: number[]; w?: number; h?: number; label?: string; /** scale to the values' own range, not from 0 (a follower count) */ fit?: boolean }) {
  if (values.length < 2) return null;
  const max = Math.max(fit ? -Infinity : 1, ...values), min = fit ? Math.min(...values) : Math.min(0, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / (max - min || 1)) * (h - 4)] as [number, number]);
  return (
    <svg className="an-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={`${curve(pts)} L${w},${h} L0,${h} Z`} className="an-area" />
      <path d={curve(pts)} className="an-line thin" />
    </svg>
  );
}

const total = (d: Daily, xs: number[]) => (d.unit === "pct" || d.unit === "s" ? xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.filter((v) => v > 0).length) : xs.reduce((a, b) => a + b, 0));

/** The headline metrics as tiles (total, trend, sparkline); the chosen one fills the chart under them, this period
 *  against the one before. `extra` adds a line under a tile's number (engagement rate under engagements, say). */
export function TrendBoard({ id, trend, days, range, extra, height = 260 }: { id: string; trend: Daily[]; days: string[]; range: number; extra?: Partial<Record<string, React.ReactNode>>; height?: number }) {
  const [k, setK] = useState(trend[0]?.key ?? "");
  const s = trend.find((d) => d.key === k) ?? trend[0];
  if (!s) return <section className="card an-card"><Empty icon={<ChartLineUp size={22} />} title="No daily numbers yet">They appear once a connected account has posts.</Empty></section>;
  const hasPrev = s.prev.some((v) => v !== 0);
  return (
    <section className="card an-card flush an-board-trend" aria-labelledby={id}>
      <h2 id={id} className="sr-only">Headline metrics</h2>
      <div className="an-kt" role="tablist" aria-label="Metric on the chart">
        {trend.map((d) => {
          const on = d.key === s.key;
          const t = total(d, d.cur), p = total(d, d.prev);
          return (
            <button key={d.key} type="button" role="tab" aria-selected={on} className={`an-kt-b ${on ? "on" : ""}`} onClick={() => setK(d.key)}>
              <span className="an-k">{d.label}</span>
              <span className="an-kt-v"><span className="mono">{fmtUnit(t, d.unit)}</span>{d.prev.some((v) => v !== 0) && <Trend v={change(t, p)} size="sm" />}</span>
              <span className="an-kt-f"><span className="tiny dim">{extra?.[d.key] ?? (d.prev.some((v) => v !== 0) ? `${fmtUnit(p, d.unit)} before` : "\u00a0")}</span><Sparkline values={d.cur} w={72} h={22} /></span>
            </button>
          );
        })}
      </div>
      <div className="an-kt-chart" role="tabpanel" aria-label={s.label}>
        <LineChart labels={days.map((d) => day(d))} cur={s.cur} prev={hasPrev ? s.prev : null} unit={s.unit} name={s.label} height={height} tipLabel={(i) => day(days[i], { weekday: "short", month: "short", day: "numeric" })} />
        <div className="an-legend"><span><i className="k" />Last {range} days</span>{hasPrev && <span><i className="k prev" />The {range} days before</span>}</div>
      </div>
    </section>
  );
}

/** Every post as a dot: across, views against the usual for its format (log scale, 1× in the middle); up, its
 *  engagement rate. The lines at 1× and the median rate split posts into four kinds. Hover, or arrow keys, read a
 *  dot; a click or Enter opens it. */
export function Quadrant({ items, open }: { items: Item[]; open: (i: Item) => void }) {
  const [box, W] = useWidth<HTMLDivElement>();
  const pts = items.filter((i) => i.score != null && i.score > 0 && i.er != null).sort((a, b) => a.score! - b.score!);
  const [h, setH] = useState<number | null>(null);
  const H = 320, L = 44, R = 12, T = 14, B = 30;
  const ers = pts.map((i) => i.er!).sort((a, b) => a - b);
  const medEr = ers.length ? ers[ers.length >> 1] : 0;
  const yMax = Math.max(0.01, ers[Math.min(ers.length - 1, Math.floor(ers.length * 0.96))] ?? 0.01) * 1.1;
  const lx = (v: number) => Math.log2(Math.min(16, Math.max(1 / 16, v)));
  const x = (v: number) => L + ((lx(v) + 4) / 8) * (W - L - R);
  const y = (v: number) => T + (1 - Math.min(v, yMax) / yMax) * (H - T - B);
  if (pts.length < 3) return <Empty icon={<ChartLineUp size={22} />} title="Not enough scored posts yet">After three posts in a format, each one is placed here.</Empty>;
  const p = h != null ? pts[h] : null;
  const kind = (i: Item) => (i.score! >= 1 ? (i.er! >= medEr ? "Hit" : "Seen, not loved") : i.er! >= medEr ? "Loved, not seen" : "Missed");
  const count = (k: string) => pts.filter((i) => kind(i) === k).length;
  const xt = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];
  const yt = [0, 0.5, 1].map((t) => t * yMax);
  return (
    <div ref={box} className="an-chart an-quad-chart" tabIndex={0} role="img"
      aria-label={`${pts.length} posts. ${["Hit", "Seen, not loved", "Loved, not seen", "Missed"].map((k) => `${k}: ${count(k)}`).join(", ")}. Arrow keys read each post, Enter opens it.`}
      onPointerLeave={() => setH(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); setH((v) => Math.min(pts.length - 1, (v ?? -1) + 1)); }
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); setH((v) => Math.max(0, (v ?? pts.length) - 1)); }
        if (e.key === "Enter" && p) open(p);
        if (e.key === "Escape") setH(null);
      }}>
      <svg width={W} height={H} aria-hidden>
        <rect x={x(1)} y={T} width={W - R - x(1)} height={y(medEr) - T} className="an-qbg" />
        {yt.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="an-grid" /><text x={L - 8} y={y(t) + 4} className="an-axis" textAnchor="end">{pct(t, t && t < 0.1 ? 1 : 0)}</text></g>)}
        {xt.map((t) => <text key={t} x={x(t)} y={H - 8} className="an-axis" textAnchor="middle">{t < 1 ? `1/${1 / t}` : t}×</text>)}
        <line x1={x(1)} x2={x(1)} y1={T} y2={H - B} className="an-qline" />
        <line x1={L} x2={W - R} y1={y(medEr)} y2={y(medEr)} className="an-qline" />
        <text x={W - R - 6} y={T + 14} className="an-qlab" textAnchor="end">Hits · {count("Hit")}</text>
        <text x={L + 6} y={T + 14} className="an-qlab">Loved, not seen · {count("Loved, not seen")}</text>
        <text x={W - R - 6} y={H - B - 8} className="an-qlab" textAnchor="end">Seen, not loved · {count("Seen, not loved")}</text>
        <text x={L + 6} y={H - B - 8} className="an-qlab">Missed · {count("Missed")}</text>
        {pts.map((i, k) => (
          <circle key={i.id} cx={x(i.score!)} cy={y(i.er!)} r={h === k ? 7 : 5} className={`an-qdot ${i.network} ${h === k ? "on" : ""}`}
            onPointerEnter={() => setH(k)} onClick={() => open(i)} />
        ))}
      </svg>
      {p && (
        <div className="an-tip" style={{ left: Math.min(Math.max(x(p.score!), 120), W - 120), top: Math.max(0, y(p.er!) - 92) }} aria-live="polite">
          <span className="an-tip-d ellipsis" style={{ maxWidth: 220 }}>{p.title}</span>
          <span className="an-tip-row"><b className="mono">{p.score! >= 10 ? Math.round(p.score!) : p.score!.toFixed(1)}×</b> your usual views</span>
          <span className="an-tip-row"><b className="mono">{pct(p.er, 1)}</b> engagement · {kind(p)}</span>
        </div>
      )}
    </div>
  );
}
