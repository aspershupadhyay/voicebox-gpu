"use client";
// Grow Overview's headline pieces (the Flux layout): the KPI strip (five numbers with a hatched bar each), follower growth
// as a step chart by platform, how people responded (likes, comments, shares, saves), and the top posts as a ranked
// table with a performance gauge and a live dot for posts still being followed minute by minute.
import { ArrowDownRight, ArrowUpRight, ChartLineUp } from "@phosphor-icons/react";
import { useState } from "react";
import type { Analytics as Data, Daily, Item, Kpi } from "@/lib/analytics";
import { compact, fmtUnit, full, useWidth } from "./anparts";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { Empty } from "./ui";

const DAY = 864e5;
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const kpi = (d: Data, k: string) => d.overview.find((x) => x.key === k);
/** One metric summed over the deep reports of a platform. */
const deep = (rows: { kpis: Kpi[] }[], key: string, which: "value" | "prev") => {
  const got = rows.map((r) => r.kpis.find((k) => k.key === key)?.[which]).filter((v): v is number => v != null);
  return got.length ? sum(got) : null;
};

function Delta({ cur, prev, unit, better = "up", goal }: { cur: number | null; prev: number | null; unit?: Kpi["unit"]; better?: "up" | "down"; goal?: number | null }) {
  if (goal != null && cur != null) {
    const left = goal - cur;
    return left > 0 ? <span className="fx-d down"><ArrowDownRight size={11} weight="bold" />{full(left)} to goal</span> : <span className="fx-d up"><ArrowUpRight size={11} weight="bold" />Goal met</span>;
  }
  if (cur == null || prev == null || (!prev && unit !== "pct")) return <span className="fx-vs">no earlier period</span>;
  const pts = unit === "pct";
  const ch = pts ? cur - prev : (cur - prev) / Math.abs(prev);
  if (!isFinite(ch)) return null;
  const good = (ch >= 0) === (better === "up");
  const text = pts ? `${Math.abs(ch).toFixed(1)} pt` : Math.abs(ch) >= 10 ? `${Math.round(Math.abs(ch) + 1)}×` : `${Math.round(Math.abs(ch) * 100)}%`;
  return <><span className={`fx-d ${Math.abs(ch) < 0.005 ? "flat" : good ? "up" : "down"}`}>{ch >= 0 ? <ArrowUpRight size={11} weight="bold" /> : <ArrowDownRight size={11} weight="bold" />}{text}</span><span className="fx-vs">vs last period</span></>;
}

/** Five numbers in one strip. The hatched bar is this period's share of this period plus the last one (past the middle
 *  means up), or for posts how far along the goal is. */
export function KpiStrip({ data }: { data: Data }) {
  const v = kpi(data, "views"), er = kpi(data, "er"), net = kpi(data, "net"), wh = kpi(data, "watch_h"), posts = kpi(data, "posts");
  const goal = data.rhythm.some((r) => r.goal) ? Math.round((sum(data.rhythm.map((r) => r.goal)) * data.range) / 7) : null;
  const items: { k: Kpi | undefined; label: string; tone: string; goal?: number | null; show?: (x: number) => string }[] = [
    { k: v, label: "Views and reach", tone: "violet" },
    { k: er, label: "Engagement rate", tone: "warn" },
    { k: net, label: "Net new followers", tone: "blue", show: (x) => `${x > 0 ? "+" : ""}${full(x)}` },
    { k: wh, label: "Watch hours", tone: "bad" },
    { k: posts, label: "Posts published", tone: "ok", goal },
  ];
  return (
    <section className="fx-kpis" aria-label="Headline numbers">
      {items.map(({ k, label, tone, goal: g, show }) => {
        const cur = k?.value ?? null, prev = k?.prev ?? null;
        const fill = g ? Math.min(1, (cur ?? 0) / g) : cur != null && prev != null && cur + prev > 0 ? cur / (cur + prev) : cur ? 1 : 0;
        return (
          <div key={label} className="fx-kpi" title={k?.about}>
            <span className="fx-k">{label}</span>
            <span className="fx-v">{cur == null ? "—" : show ? show(cur) : fmtUnit(cur, k?.unit ?? "")}{g ? <small> / {g}</small> : null}</span>
            <span className="fx-ds"><Delta cur={cur} prev={prev} unit={k?.unit} better={k?.better} goal={g} /></span>
            <span className={`fx-hatch t-${tone}`} role="meter" aria-label={g ? `${label}: ${Math.round(fill * 100)}% of the goal` : `${label}: this period's share of the last two`} aria-valuenow={Math.round(fill * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(fill ? 4 : 0, fill * 100)}%` }} /></span>
          </div>
        );
      })}
    </section>
  );
}

/* ───────────── follower growth, stepped */

type Series = { name: string; tone: string; values: number[] };

/** Stepped lines (each bucket a flat step), the first one shaded. Hover or arrow keys read a bucket. */
function StepChart({ labels, series, height = 230, tip }: { labels: string[]; series: Series[]; height?: number; tip: (i: number) => string }) {
  const [box, W] = useWidth<HTMLDivElement>();
  const [h, setH] = useState<number | null>(null);
  const n = labels.length, H = height, L = 40, R = 8, T = 14, B = 24;
  const all = series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all), hiRaw = Math.max(1, ...all);
  const step = (() => { const e = 10 ** Math.floor(Math.log10(Math.max(1, hiRaw - lo))), r = (hiRaw - lo) / e; return (r <= 2 ? 0.5 : r <= 5 ? 1 : 2) * e; })();
  const hi = Math.ceil(hiRaw / step) * step, low = Math.floor(lo / step) * step;
  const bw = (W - L - R) / Math.max(1, n);
  const x = (i: number) => L + i * bw, y = (v: number) => T + (1 - (v - low) / (hi - low || 1)) * (H - T - B);
  const path = (vs: number[]) => vs.map((v, i) => `${i ? "H" : "M"}${x(i).toFixed(1)}${i ? ` V${y(v).toFixed(1)}` : `,${y(v).toFixed(1)}`} H${x(i + 1).toFixed(1)}`).join(" ");
  const ticks: number[] = []; for (let t = low; t <= hi + 1e-9; t += step) ticks.push(t);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L) / 70))));
  return (
    <div ref={box} className="an-chart" style={{ height: H }} tabIndex={0} role="img" aria-label={`${series.map((s) => `${s.name}: ${full(sum(s.values))} in all`).join("; ")}. Arrow keys read each step.`}
      onPointerMove={(e) => { const r = box.current!.getBoundingClientRect(); setH(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left - L) / bw)))); }} onPointerLeave={() => setH(null)}
      onKeyDown={(e) => { if (e.key === "ArrowRight") setH((v) => Math.min(n - 1, (v ?? -1) + 1)); if (e.key === "ArrowLeft") setH((v) => Math.max(0, (v ?? n) - 1)); if (e.key === "Escape") setH(null); }}>
      <svg width={W} height={H} aria-hidden>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="an-grid" /><text x={L - 8} y={y(t) + 4} className="an-axis" textAnchor="end">{compact(t)}</text></g>)}
        {labels.map((lb, i) => i % every === 0 ? <text key={i} x={x(i) + bw / 2} y={H - 6} className="an-axis" textAnchor="middle">{lb}</text> : null)}
        {series[0] && <path d={`${path(series[0].values)} V${y(Math.max(low, 0))} H${x(0)} Z`} className={`fx-area t-${series[0].tone}`} />}
        {series.map((s) => <path key={s.name} d={path(s.values)} className={`fx-step draw t-${s.tone}`} pathLength={1} />)}
        {h != null && <><line x1={x(h) + bw / 2} x2={x(h) + bw / 2} y1={T} y2={H - B} className="fx-cross" />{series.map((s) => <circle key={s.name} cx={x(h) + bw / 2} cy={y(s.values[h])} r={4} className={`fx-dot t-${s.tone}`} />)}</>}
      </svg>
      {h != null && (
        <div className="an-tip" style={{ left: Math.min(Math.max(x(h) + bw / 2, 90), W - 90), top: Math.max(0, y(Math.max(...series.map((s) => s.values[h]))) - 78) }}>
          <span className="an-tip-d">{tip(h)}</span>
          {series.map((s) => <span key={s.name} className="an-tip-row"><i className={`fx-sw t-${s.tone}`} /><b className="mono">{s.values[h] > 0 ? "+" : ""}{full(s.values[h])}</b> {s.name}</span>)}
        </div>
      )}
    </div>
  );
}

const pick = (rows: { daily: Daily[] }[], key: string) => {
  const got = rows.map((r) => r.daily.find((d) => d.key === key)?.cur).filter((x): x is number[] => !!x);
  return got.length ? got.reduce((t, x) => t.map((v, i) => v + (x[i] ?? 0))) : null;
};

export function FollowerGrowth({ data }: { data: Data }) {
  const [by, setBy] = useState<"week" | "day">(data.range > 14 ? "week" : "day");
  const yt = pick(data.youtube, "subs_net"), ig = pick(data.instagram, "followers");
  const days = data.days;
  const bucket = (xs: number[] | null) => {
    if (!xs) return null;
    if (by === "day") return xs;
    const out: number[] = [];
    for (let i = 0; i < xs.length; i += 7) out.push(sum(xs.slice(i, i + 7)));
    return out;
  };
  const fmt = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const starts = by === "day" ? days : days.filter((_, i) => i % 7 === 0);
  const series: Series[] = [
    ...(yt ? [{ name: "YouTube subscribers", tone: "violet", values: bucket(yt)! }] : []),
    ...(ig ? [{ name: "Instagram followers", tone: "ig", values: bucket(ig)! }] : []),
  ];
  const total = sum(series.flatMap((s) => s.values));
  const best = series.length ? starts.map((_, i) => sum(series.map((s) => s.values[i]))).reduce((b, v, i, a) => (v > a[b] ? i : b), 0) : -1;
  return (
    <section className="card an-card" aria-labelledby="fx-fg-h">
      <div className="card-head">
        <div><h2 id="fx-fg-h">Follower growth</h2><p className="sub">Net new followers by {by}, each platform</p></div>
        <Select className="fx-chip-sel" size="sm" label="Group by" value={by} onChange={setBy} options={[["week", "Weekly"], ["day", "Daily"]]} />
      </div>
      {!series.length ? <Empty icon={<ChartLineUp size={22} />} title="No daily follower numbers yet">YouTube Analytics and Instagram insights fill this in.</Empty> : <>
        <StepChart labels={starts.map(fmt)} series={series} tip={(i) => (by === "week" ? `Week of ${fmt(starts[i])}` : fmt(starts[i]))} />
        <div className="an-legend">{series.map((s) => <span key={s.name}><i className={`fx-sw t-${s.tone}`} />{s.name}</span>)}</div>
        <p className="small dim" style={{ margin: "10px 0 0" }}>{total >= 0 ? "+" : ""}{full(total)} in {data.range} days{best >= 0 && total > 0 ? <>; the best {by} was <b className="an-ink">{by === "week" ? `the week of ${fmt(starts[best])}` : fmt(starts[best])}</b>. Look at what went out just before it.</> : "."}</p>
      </>}
    </section>
  );
}

/* ───────────── how people responded */

export function Responses({ data }: { data: Data }) {
  const both = (k: string, w: "value" | "prev") => { const a = deep(data.youtube, k, w), b = deep(data.instagram, k, w); return a == null && b == null ? null : (a ?? 0) + (b ?? 0); };
  const rows = ([["Likes", "likes", 1], ["Comments", "comments", 0.62], ["Shares", "shares", 0.36], ["Saves", "saves", 0.2]] as const)
    .map(([label, key, mix]) => ({ label, mix, cur: both(key, "value"), prev: both(key, "prev") })).filter((r) => r.cur != null);
  const tot = sum(rows.map((r) => r.cur));
  const ch = (r: (typeof rows)[number]) => (r.cur != null && r.prev ? (r.cur - r.prev) / r.prev : null);
  const likes = rows.find((r) => r.label === "Likes"), shares = rows.find((r) => r.label === "Shares");
  const lc = likes ? ch(likes) : null, sc = shares ? ch(shares) : null;
  const note = lc != null && sc != null
    ? sc < 0 && lc > 0 ? `Shares are down ${Math.round(-sc * 100)}% while likes are up: the posts entertain but don't get passed on. Give people a reason to send it (a tip worth keeping, a take worth arguing with).`
      : sc > lc ? `Shares grew faster than likes (${Math.round(sc * 100)}% against ${Math.round(lc * 100)}%): your posts travel. Shares are the strongest sign a topic will spread.`
        : `Likes ${lc >= 0 ? "up" : "down"} ${Math.round(Math.abs(lc) * 100)}%, shares ${sc >= 0 ? "up" : "down"} ${Math.round(Math.abs(sc) * 100)}%. Shares are the strongest sign a topic travels.`
    : "Shares are the strongest sign a topic travels; comments, that it starts a conversation.";
  return (
    <section className="card an-card" aria-labelledby="fx-resp-h">
      <div className="card-head"><div><h2 id="fx-resp-h">Likes, comments, shares</h2><p className="sub">How people responded</p></div></div>
      {!rows.length ? <Empty icon={<ChartLineUp size={22} />} title="Nothing yet" /> : <>
        <div className="fx-split" aria-hidden>{rows.map((r) => <i key={r.label} style={{ flex: Math.max(0.02, (r.cur ?? 0) / (tot || 1)), background: `color-mix(in srgb, var(--warn) ${Math.round(r.mix * 100)}%, var(--surface))` }} />)}</div>
        <table className="fx-tbl">
          <tbody>
            {rows.map((r) => {
              const c = ch(r);
              return (
                <tr key={r.label}>
                  <th scope="row"><i className="fx-sw" style={{ background: `color-mix(in srgb, var(--warn) ${Math.round(r.mix * 100)}%, var(--surface))` }} />{r.label}</th>
                  <td className="mono">{full(r.cur)}</td>
                  <td>{c == null ? <span className="dim tiny">—</span> : <span className={`fx-d ${c >= 0 ? "up" : "down"}`}>{c >= 0 ? <ArrowUpRight size={11} weight="bold" /> : <ArrowDownRight size={11} weight="bold" />}{Math.round(Math.abs(c) * 100)}%</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small dim" style={{ margin: "12px 0 0" }}>{note}</p>
      </>}
    </section>
  );
}

/* ───────────── top posts, ranked */

/** A half-ring that fills with the score (3× your usual and up is full). */
export function Gauge({ v }: { v: number | null }) {
  const f = v == null ? 0 : Math.max(0, Math.min(1, v / 3));
  const r = 15, c = Math.PI * r;
  const tone = v == null ? "mute" : v >= 2 ? "ok" : v >= 1 ? "blue" : v >= 0.7 ? "warn" : "bad";
  return (
    <span className="fx-gauge" title="Views against your usual for the format">
      <svg width="38" height="22" viewBox="0 0 38 22" aria-hidden>
        <path d="M4 19 A15 15 0 0 1 34 19" className="fx-g-bg" />
        <path d="M4 19 A15 15 0 0 1 34 19" className={`fx-g-fg t-${tone}`} strokeDasharray={`${c * f} ${c}`} />
      </svg>
      <b className="mono">{v == null ? "—" : `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`}</b>
    </span>
  );
}

const FMT: Record<string, string> = { yt_video: "Video", yt_short: "Short", ig_reel: "Reel", ig_post: "Post" };

export function TopTable({ data, open, n = 8 }: { data: Data; open: (i: Item) => void; n?: number }) {
  const from = Date.parse(`${data.from}T00:00:00Z`);
  const rows = data.items.filter((i) => i.at >= from && i.score != null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, n);
  return (
    <section className="card an-card flush" aria-labelledby="fx-top-h">
      <div className="card-head an-pad"><div><h2 id="fx-top-h">Top posts</h2><p className="sub">Posted in the last {data.range} days, ranked by how far they beat your usual</p></div></div>
      {!rows.length ? <div className="an-pad" style={{ paddingBottom: 20 }}><Empty icon={<ChartLineUp size={22} />} title="No posts in this period yet" /></div> : (
        <div className="gr-tbl-wrap">
          <table className="gr-tbl fx-top">
            <thead><tr><th scope="col">Post</th><th scope="col" className="hide-sm">Published</th><th scope="col">Views</th><th scope="col" className="hide-sm">Engagement</th><th scope="col" className="hide-sm">Likes</th><th scope="col">Performance</th></tr></thead>
            <tbody>
              {rows.map((i, k) => {
                const live = Date.now() - i.at < 72 * 3600_000;
                return (
                  <tr key={i.id} tabIndex={0} onClick={() => open(i)} onKeyDown={(e) => { if (e.key === "Enter") open(i); }} aria-label={`Deep dive: ${i.title}`}>
                    <th scope="row">
                      <span className="gr-who">
                        <span className="fx-rank mono">{k + 1}</span>
                        <span className="gr-th-sm">{i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : null}</span>
                        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                          <span className="ellipsis">{i.title}</span>
                          <span className="tiny dim fx-meta"><PlatformBadge net={i.network} size={14} />{FMT[i.fmt]}{live && <span className="fx-live"><span className="gr-dot" aria-hidden />Live</span>}</span>
                        </span>
                      </span>
                    </th>
                    <td className="small dim hide-sm">{new Date(i.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td>
                    <td className="mono">{compact(i.views ?? i.reach)}</td>
                    <td className="mono hide-sm">{i.er == null ? "—" : `${(i.er * 100).toFixed(1)}%`}</td>
                    <td className="mono hide-sm">{compact(i.likes)}</td>
                    <td><Gauge v={i.score} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

