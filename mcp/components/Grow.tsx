"use client";
// Grow's live pages (the rest of Grow is Analytics.tsx), on the minute-by-minute numbers from lib/live.ts:
//   Live          what's happening right now? Every post under 72 hours old, yours and your rivals', drawn against
//                 the usual post at the same age, with views in the last hour, a verdict, and subscribers as they move.
//   Competitors   how do we stack up, and what's working for them? You and each rival side by side, the outlier feed
//                 (their videos beating their own usual), their fresh uploads live, when they post, and the title
//                 patterns behind their hits. Rivals are added, pinned and removed here.
//   Rival         one rival in depth (pinned rivals open it from the sidebar).
import { ArrowSquareOut, Broadcast, Fire, MagnifyingGlass, PushPin, Plus, Trash, Trophy, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Fmt } from "@/lib/analytics";
import { bandAt, rivalSlug, type LiveChan, type LivePost, type LiveView, type Rival, type Vid } from "@/lib/live-shared";
import { compact, full, Heatmap, LineChart, Score, Sparkline, useWidth } from "./anparts";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { Empty, Notice } from "./ui";
import { useAgo, useLive } from "./useLive";

const FMT_NAME: Record<Fmt, string> = { yt_short: "Short", yt_video: "Video", ig_reel: "Reel", ig_post: "Post" };
const ageText = (min: number) => (min < 60 ? `${Math.max(0, Math.round(min))} min` : min < 2880 ? `${Math.floor(min / 60)} h${min % 60 && min < 600 ? ` ${Math.round(min % 60)} m` : ""}` : `${Math.round(min / 1440)} days`);
const since = (at: number) => ageText((Date.now() - at) / 60_000);
const lenText = (s: number | null | undefined) => (s == null ? "—" : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function Av({ c, size = 28 }: { c?: Pick<LiveChan, "name" | "avatar"> | null; size?: number }) {
  const init = (c?.name ?? "?").split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
  return <span className="gr-av" style={{ width: size, height: size, fontSize: size * 0.36 }}>{c?.avatar ? <img src={c.avatar} alt="" loading="lazy" /> : init}</span>;
}

/** The live chip: a beating dot and when the last check landed. */
export function LiveChip({ at, href }: { at: number | null | undefined; href?: string }) {
  const ago = useAgo(at);
  const stale = !at || Date.now() - at > 5 * 60_000;
  const body = <><span className={`gr-dot ${stale ? "off" : ""}`} aria-hidden />{!at ? "Live · starting" : stale ? `Last check ${ago}` : `Live · ${ago}`}</>;
  return href ? <Link href={href} className="gr-chip" aria-label={`Live numbers, ${ago ?? "starting"}`}>{body}</Link> : <span className="gr-chip" role="status">{body}</span>;
}

/* ───────────── a post against the usual at the same age */

/** Views by age since upload: the post (solid), the usual post at the same age (dashed, the middle half shaded). */
function AgeChart({ p, height = 260 }: { p: LivePost; height?: number }) {
  const [box, W] = useWidth<HTMLDivElement>();
  const [h, setH] = useState<number | null>(null);
  const H = height, L = 48, R = 14, T = 22, B = 26;
  const start = Math.floor(p.at / 60_000);
  const pts = p.pts.map(([m, v]) => [Math.max(0, m - start), v] as [number, number]);
  const span = Math.min(4320, Math.max(60, p.age_min * 1.15, ...(p.band ? [Math.min(p.age_min * 1.6, 4320)] : [])));
  const band = p.band;
  const steps = band ? Array.from({ length: 48 }, (_, i) => ((i + 1) / 48) * span) : [];
  const lo = steps.map((a) => bandAt(band!, "lo", a)), hi = steps.map((a) => bandAt(band!, "hi", a)), mid = steps.map((a) => bandAt(band!, "mid", a));
  const top = Math.max(10, ...pts.map((x) => x[1]), ...hi.filter((v): v is number => v != null));
  const max = (() => { const e = 10 ** Math.floor(Math.log10(top)), r = top / e; return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * e; })();
  const x = (a: number) => L + (a / span) * (W - L - R), y = (v: number) => T + (1 - v / max) * (H - T - B);
  const path = (xs: [number, number][]) => xs.map(([a, v], i) => `${i ? "L" : "M"}${x(a).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const okBand = steps.map((a, i) => [a, lo[i], hi[i]] as const).filter((r): r is readonly [number, number, number] => r[1] != null && r[2] != null);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const xt = (W < 520 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((t) => t * span);
  const near = h == null ? null : pts.reduce((b, q) => (Math.abs(q[0] - h) < Math.abs(b[0] - h) ? q : b), pts[0]);
  const last = pts.at(-1);
  return (
    <div ref={box} className="an-chart" style={{ height: H }} role="img" tabIndex={0}
      aria-label={`${p.title}: ${full(p.views)} views at ${ageText(p.age_min)}${band ? `; your usual ${FMT_NAME[p.fmt]} has ${full(bandAt(band, "mid", p.age_min))} at this age` : ""}.`}
      onPointerMove={(e) => { const r = box.current!.getBoundingClientRect(); setH(Math.max(0, Math.min(p.age_min, ((e.clientX - r.left - L) / (W - L - R)) * span))); }} onPointerLeave={() => setH(null)}>
      <svg width={W} height={H} aria-hidden>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="an-grid" /><text x={L - 8} y={y(t) + 4} className="an-axis" textAnchor="end">{compact(t)}</text></g>)}
        {xt.map((a, i) => <text key={i} x={x(a)} y={H - 6} className="an-axis" textAnchor={i === 0 ? "start" : i === xt.length - 1 ? "end" : "middle"}>{ageText(a)}</text>)}
        {okBand.length > 1 && <path d={`${path(okBand.map(([a, , v]) => [a, v]))}${okBand.slice().reverse().map(([a, v]) => `L${x(a).toFixed(1)},${y(v).toFixed(1)}`).join("")}Z`} className="gr-band" />}
        {band && <path d={path(steps.map((a, i) => [a, mid[i]] as [number, number | null]).filter((r): r is [number, number] => r[1] != null))} className="an-line prev" />}
        {pts.length > 1 && <path d={`${path(pts)}L${x(pts.at(-1)![0])},${y(0)}L${x(pts[0][0])},${y(0)}Z`} className="an-area" />}
        {pts.length > 1 && <path d={path(pts)} className="an-line" />}
        {last && <circle cx={x(last[0])} cy={y(last[1])} r={5} className="gr-now" />}
        {near && <><line x1={x(near[0])} x2={x(near[0])} y1={T - 6} y2={y(0)} className="an-cross" /><circle cx={x(near[0])} cy={y(near[1])} r={4.5} className="an-dot" /></>}
      </svg>
      {last && !near && W >= 480 && <div className="gr-now-tag" style={{ left: Math.min(x(last[0]) + 10, W - 150), top: Math.max(0, y(last[1]) - 18) }}><b className="mono">{full(last[1])}</b> now<span>+{full(p.last_hour)} in the last hour</span></div>}
      {near && (
        <div className="an-tip" style={{ left: Math.min(Math.max(x(near[0]), 96), W - 96), top: Math.max(0, y(near[1]) - 74) }}>
          <span className="an-tip-d">{ageText(near[0])} after upload</span>
          <span className="an-tip-row"><i className="k" /><b className="mono">{full(near[1])}</b> views</span>
          {band && bandAt(band, "mid", near[0]) != null && <span className="an-tip-row"><i className="k prev" /><b className="mono">{full(bandAt(band, "mid", near[0]))}</b> usual at this age</span>}
        </div>
      )}
    </div>
  );
}

function Verdict({ p }: { p: LivePost }) {
  const v = p.verdict;
  return <span className={`pill ${v.tone === "dim" ? "" : v.tone}`}>{v.label === "Taking off" && <Fire size={12} weight="fill" aria-hidden />}{v.label}{v.basis === "curve" && v.x != null ? ` · ${v.x}×` : ""}</span>;
}

/** Fresh posts as rows: thumbnail, age, views, the last hour, the verdict. Picking one draws it above. */
function FreshList({ posts, chans, pick, on, label, narrow }: { posts: LivePost[]; chans: Map<string, LiveChan>; pick: (id: string) => void; on: string | null; label: string; /** a side column: the verdict goes under the title */ narrow?: boolean }) {
  return (
    <div className={`gr-fresh ${narrow ? "narrow" : ""}`} role="list" aria-label={label}>
      {posts.map((p) => {
        const c = chans.get(p.owner);
        return (
          <button key={p.id} type="button" role="listitem" className={`gr-fr ${on === p.id ? "on" : ""}`} onClick={() => pick(p.id)} aria-pressed={on === p.id}>
            <span className="gr-fr-th">{p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <PlatformBadge net={p.net} size={18} />}</span>
            <span className="gr-fr-t">
              <b className="ellipsis">{p.title}</b>
              <span className="tiny dim">{c?.rival && <>{c.name} · </>}{FMT_NAME[p.fmt]} · {ageText(p.age_min)} old</span>
              {<span className={`tiny gr-vt ${p.verdict.tone}`}>{p.verdict.label}{p.verdict.basis === "curve" && p.verdict.x != null ? ` · ${p.verdict.x}×` : ""}</span>}
            </span>
            <span className="gr-fr-n"><b className="mono">{compact(p.views)}</b><span className={`tiny ${p.last_hour > 0 ? "an-ok" : "dim"}`}>+{compact(p.last_hour)} / h</span></span>
            {!narrow && <span className="gr-fr-v"><Verdict p={p} /></span>}
          </button>
        );
      })}
    </div>
  );
}

function Status({ d }: { d: LiveView }) {
  const following = d.posts.length;
  const stale = !d.at || Date.now() - d.at > 5 * 60_000;
  return (
    <div className="gr-status" role="status">
      <span>Following <b className="mono">{following}</b> post{following === 1 ? "" : "s"} under 72 hours old</span>
      <span className="hide-sm">Checked every minute</span>
      <span className="hide-sm">YouTube quota today <b className="mono">{full(d.quota.units)}</b> / 10,000</span>
      {stale && d.at > 0 && <span className="pill warn">The minute timer looks stopped; this page checks while it&apos;s open</span>}
    </div>
  );
}

export function LiveView() {
  const { data: d, err } = useLive();
  const [sel, setSel] = useState<string | null>(null);
  if (err && !d) return <Notice icon={<Warning size={18} />} tone="bad">Couldn&apos;t load live numbers: {err}</Notice>;
  if (!d) return <div className="an-wrap" aria-busy="true" aria-label="Loading live numbers"><div className="skel" style={{ height: 44 }} /><div className="skel" style={{ height: 380 }} /></div>;
  const chans = new Map(d.chans.map((c) => [c.id, c]));
  const mine = d.posts.filter((p) => !chans.get(p.owner)?.rival), theirs = d.posts.filter((p) => chans.get(p.owner)?.rival);
  const p = d.posts.find((x) => x.id === sel) ?? mine[0] ?? theirs[0] ?? null;
  const own = d.chans.filter((c) => !c.rival);
  return (
    <>
      <Status d={d} />
      {!d.at && <Notice icon={<Broadcast size={18} />}>The first check is running. Fresh posts show up here within a minute or two.</Notice>}
      <div className="an-row">
        <section className="card an-card" aria-labelledby="gr-now-h">
          {p ? (
            <>
              <div className="card-head">
                <div style={{ minWidth: 0 }}>
                  <h2 id="gr-now-h" className="ellipsis">{p.title}</h2>
                  <p className="sub"><PlatformBadge net={p.net} size={16} />{chans.get(p.owner)?.rival ? `${chans.get(p.owner)?.name} · ` : ""}{FMT_NAME[p.fmt]} · {ageText(p.age_min)} old · <a className="an-link" href={p.url} target="_blank" rel="noreferrer">Open <ArrowSquareOut size={12} /></a></p>
                </div>
                <Verdict p={p} />
              </div>
              <AgeChart p={p} />
              <div className="an-legend"><span><i className="k" />This {FMT_NAME[p.fmt].toLowerCase()}</span>{p.band ? <span><i className="k prev" />Usual at the same age (shaded: the middle half of {p.band.n})</span> : <span className="dim">The usual-at-this-age line appears after 3 {FMT_NAME[p.fmt].toLowerCase()}s have been followed for 72 hours.</span>}</div>
              <div className="gr-kpis">
                <div><span className="an-k">Views</span><b className="mono">{full(p.views)}</b></div>
                <div><span className="an-k">Last hour</span><b className="mono">+{full(p.last_hour)}</b></div>
                <div><span className="an-k">Per hour so far</span><b className="mono">{full(p.per_hour)}</b></div>
                <div><span className="an-k">Likes</span><b className="mono">{full(p.likes)}</b></div>
                <div><span className="an-k">Comments</span><b className="mono">{full(p.comments)}</b></div>
                {p.usual_life != null && <div><span className="an-k">Usual lifetime</span><b className="mono">{compact(p.usual_life)}</b></div>}
              </div>
              <p className="small dim" style={{ margin: "12px 0 0" }}>{whatItMeans(p)}</p>
            </>
          ) : (
            <Empty icon={<Broadcast size={22} />} title="Nothing posted in the last 72 hours">
              The next upload, yours or a rival&apos;s, shows up here within 10 minutes and is checked every minute for three days.
            </Empty>
          )}
        </section>
        <section className="card an-card" aria-labelledby="gr-mine-h">
          <div className="card-head"><div><h2 id="gr-mine-h">Your fresh posts</h2><p className="sub">Under 72 hours old, newest first</p></div></div>
          {mine.length ? <FreshList posts={mine} chans={chans} pick={setSel} on={p?.id ?? null} label="Your fresh posts" narrow /> : <p className="small dim" style={{ margin: 0 }}>None right now. Post something and watch it here from its first minutes.</p>}
          <h3 className="an-h3">Subscribers and followers, live</h3>
          <div className="gr-subs">
            {own.map((c) => (
              <div key={c.id} className="gr-sub">
                <PlatformBadge net={c.net} size={18} />
                <span className="ellipsis">{c.name}</span>
                <Sparkline values={c.pts.filter((x) => Date.now() / 60_000 - x[0] < 2880).map((x) => x[1])} w={72} h={22} label={`${c.name} over 48 hours`} fit />
                <b className="mono">{full(c.subs)}</b>
                <span className={`tiny ${(c.d1 ?? 0) > 0 ? "an-ok" : "dim"}`}>{c.d1 == null ? "—" : `${c.d1 >= 0 ? "+" : ""}${full(c.d1)} / 24 h`}</span>
              </div>
            ))}
            {!own.length && <p className="small dim" style={{ margin: 0 }}>Connect YouTube or Instagram in Posts → Autopilot.</p>}
          </div>
        </section>
      </div>
      <section className="card an-card" aria-labelledby="gr-theirs-h">
        <div className="card-head"><div><h2 id="gr-theirs-h">Your rivals&apos; fresh uploads</h2><p className="sub">Each against that channel&apos;s own usual: a hit shows in its first hours</p></div><Link href="/analytics/competitors" className="btn ghost sm"><Trophy size={14} />Competitors</Link></div>
        {theirs.length ? <FreshList posts={theirs} chans={chans} pick={(id) => { setSel(id); scrollTo({ top: 0, behavior: "smooth" }); }} on={p?.id ?? null} label="Rivals' fresh uploads" /> : <p className="small dim" style={{ margin: 0 }}>No rival has uploaded in the last 72 hours.</p>}
      </section>
    </>
  );
}

function whatItMeans(p: LivePost) {
  const v = p.verdict;
  if (v.basis === "curve" && v.x != null) {
    if (v.x >= 2) return `It has ${v.x}× the views your usual ${FMT_NAME[p.fmt].toLowerCase()} has at ${ageText(p.age_min)}. Reply to comments now and pin one: early engagement feeds the push.`;
    if (v.x >= 1.2) return `Ahead of your usual at this age. Keep an eye on the last-hour number: if it holds, this one keeps climbing.`;
    if (v.x >= 0.8) return `Right where your usual ${FMT_NAME[p.fmt].toLowerCase()} sits at this age.`;
    return `Behind your usual at this age. If the first hours are slow, a sharper title or thumbnail can still change its course.`;
  }
  if (v.basis === "lifetime" && p.usual_life) return `${full(p.views)} views so far against ${full(p.usual_life)} for a usual ${FMT_NAME[p.fmt].toLowerCase()} over its life.`;
  return "Voicebox is learning this channel's usual: after three posts have been followed for 72 hours, every new one is drawn against them.";
}

/* ───────────── Competitors */

/** Title habits: how often hit titles do each thing against the rest. */
const PATTERNS: [string, (t: string) => boolean][] = [
  ["A number", (t) => /\d/.test(t)],
  ["A question", (t) => /\?/.test(t)],
  ["How / why / what", (t) => /\b(how|why|what)\b/i.test(t)],
  ["“I” or “my”", (t) => /\b(I|I'm|I've|my|me)\b/.test(t)],
  ["“You”", (t) => /\byou(r|'re)?\b/i.test(t)],
  ["A word in CAPS", (t) => /\b[A-Z]{3,}\b/.test(t.replace(/\b(AI|GPT|API|USA|UK|CEO|SEO|LLM|MCP|AGI)\b/g, ""))],
  ["Under 50 characters", (t) => t.length < 50],
];
const STOP = new Set("a an the and or but of to in on for with is are was were be been it this that these those i you he she we they my your our their me us them how why what when who which from by at as so not no do does did can will just about into than then there here new vs its it's i'm you're im".split(" "));

function Titles({ vids, id }: { vids: (Vid & { score: number | null })[]; id: string }) {
  const rated = vids.filter((v) => v.score != null);
  const hits = rated.filter((v) => v.score! >= 1.5), rest = rated.filter((v) => v.score! < 1.5);
  const words = useMemo(() => {
    const n = new Map<string, number>();
    for (const v of hits) for (const w of new Set(v.title.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/))) if (w.length > 2 && !STOP.has(w)) n.set(w, (n.get(w) ?? 0) + 1);
    return [...n].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [hits]);
  if (hits.length < 2 || rest.length < 2) return (
    <section className="card an-card" aria-labelledby={id}><div className="card-head"><div><h2 id={id}>Titles that win</h2><p className="sub">What hit titles do that the rest don&apos;t</p></div></div>
      <p className="small dim" style={{ margin: 0 }}>Needs a few hits and a few misses to compare. It fills in as the uploads are read (every 3 hours).</p></section>
  );
  const share = (xs: Vid[], f: (t: string) => boolean) => xs.filter((v) => f(v.title)).length / xs.length;
  const rows = PATTERNS.map(([label, f]) => ({ label, a: share(hits, f), b: share(rest, f) })).sort((x, y) => (y.a - y.b) - (x.a - x.b));
  const top = rows[0];
  return (
    <section className="card an-card" aria-labelledby={id}>
      <div className="card-head"><div><h2 id={id}>Titles that win</h2><p className="sub">Share of hit titles (1.5× their usual or more) against the rest · {hits.length} hits, {rest.length} others</p></div></div>
      <div className="gr-pat" role="table" aria-label="Title habits of hits against the rest">
        {rows.map((r) => (
          <div key={r.label} role="row" className="gr-pat-r">
            <span role="rowheader">{r.label}</span>
            <span role="cell" className="gr-pat-bars" aria-label={`Hits ${Math.round(r.a * 100)}%, others ${Math.round(r.b * 100)}%`}>
              <i className="hit" style={{ width: `${Math.max(1, r.a * 100)}%` }} /><i style={{ width: `${Math.max(1, r.b * 100)}%` }} />
            </span>
            <span role="cell" className="mono small">{Math.round(r.a * 100)}% <span className="dim">vs {Math.round(r.b * 100)}%</span></span>
          </div>
        ))}
      </div>
      <div className="an-legend"><span><i className="k" style={{ background: "var(--ok)" }} />Hits</span><span><i className="k prev" />The rest</span></div>
      {top.a - top.b > 0.1 && <p className="small dim" style={{ margin: "10px 0 0" }}>Hits use <b className="an-ink">{top.label.toLowerCase()}</b> {Math.round(top.a * 100)}% of the time against {Math.round(top.b * 100)}% for the rest.</p>}
      {words.length > 0 && <><h3 className="an-h3">Words that keep showing up in hits</h3><div className="an-tags">{words.map(([w, c]) => <span key={w} className="pill">{w}<b className="mono">{c}</b></span>)}</div></>}
    </section>
  );
}

function postTimes(vids: Vid[]) {
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => ({ v: 0, n: 0 })));
  for (const v of vids) {
    const d = new Date(v.at);
    const c = heat[d.getDay()][Math.floor(d.getHours() / 3)];
    c.n++; c.v++;
  }
  return heat;
}

function Outliers({ items, chans, id, title = "Outliers", sub }: { items: (Vid & { owner: string; score: number })[]; chans: Map<string, LiveChan>; id: string; title?: string; sub?: string }) {
  return (
    <section className="card an-card" aria-labelledby={id}>
      <div className="card-head"><div><h2 id={id}><Fire size={16} weight="fill" aria-hidden />{title}</h2><p className="sub">{sub ?? "Rival videos of the last 45 days beating their own channel's usual, the biggest first"}</p></div></div>
      {!items.length ? <p className="small dim" style={{ margin: 0 }}>No outliers yet. Each channel&apos;s last 50 uploads are read every 3 hours.</p> : (
        <div className="gr-outs">
          {items.slice(0, 12).map((v) => {
            const c = chans.get(v.owner);
            return (
              <a key={v.id} className="gr-out" href={v.fmt === "yt_short" ? `https://youtube.com/shorts/${v.id}` : `https://youtu.be/${v.id}`} target="_blank" rel="noreferrer">
                <span className="gr-out-th">{v.thumb && <img src={v.thumb} alt="" loading="lazy" />}<span className="gr-out-x"><Score v={v.score} /></span></span>
                <b className="gr-out-t">{v.title}</b>
                <span className="tiny gr-out-m"><Av c={c} size={18} /><span className="ellipsis">{c?.name}</span></span>
                <span className="tiny dim">{compact(v.views)} views · {since(v.at)} ago</span>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ChanCard({ c, href }: { c: LiveChan; href?: string }) {
  const wk = c.d7;
  const body = (
    <>
      <span className="gr-cc-top"><Av c={c} size={34} /><span style={{ minWidth: 0 }}><b className="ellipsis">{c.name}</b><span className="tiny dim ellipsis">{c.rival ? c.handle ?? "" : "You"}</span></span><PlatformBadge net={c.net} size={18} /></span>
      <span className="gr-cc-mid"><span className="an-v">{compact(c.subs)}</span><Sparkline values={c.pts.map((p) => p[1])} w={96} h={30} label={`${c.name}'s subscribers`} fit /></span>
      <span className="gr-cc-nums">
        <span><span className="an-k">7 days</span><b className={`mono ${(wk ?? 0) > 0 ? "an-ok" : ""}`}>{wk == null ? "—" : `${wk >= 0 ? "+" : ""}${compact(wk)}`}</b></span>
        <span><span className="an-k">Per week</span><b className="mono">{c.per_week ?? "—"}</b></span>
        <span><span className="an-k">Usual Short</span><b className="mono">{compact(c.usual.yt_short ?? c.usual.ig_reel)}</b></span>
      </span>
    </>
  );
  return href ? <Link href={href} className={`gr-cc ${c.rival ? "" : "me"}`}>{body}</Link> : <div className={`gr-cc ${c.rival ? "" : "me"}`}>{body}</div>;
}

function VsTable({ chans, slugOf }: { chans: LiveChan[]; slugOf: (c: LiveChan) => string | null }) {
  const cols: [string, (c: LiveChan) => React.ReactNode, string?][] = [
    ["Subscribers", (c) => full(c.subs)],
    ["7 days", (c) => (c.d7 == null ? "—" : `${c.d7 >= 0 ? "+" : ""}${full(c.d7)}`), "hide-sm"],
    ["Uploads / week", (c) => c.per_week ?? "—"],
    ["Usual Short", (c) => compact(c.usual.yt_short ?? null), "hide-sm"],
    ["Usual video", (c) => compact(c.usual.yt_video ?? null), "hide-sm"],
    ["Engagement", (c) => (c.er == null ? "—" : `${c.er.toFixed(1)}%`)],
    ["Short length", (c) => lenText(c.avg_len.yt_short), "hide-sm"],
    ["Video length", (c) => lenText(c.avg_len.yt_video), "hide-sm"],
  ];
  return (
    <section className="card an-card flush" aria-labelledby="gr-vs-h">
      <div className="card-head an-pad"><div><h2 id="gr-vs-h">You vs them</h2><p className="sub">Public numbers only, the same for everyone. Usual = median views of their uploads older than a week; engagement = (likes + comments) ÷ views</p></div></div>
      <div className="gr-tbl-wrap">
        <table className="gr-tbl">
          <thead><tr><th scope="col">Channel</th>{cols.map(([h, , cls]) => <th key={h} scope="col" className={cls}>{h}</th>)}</tr></thead>
          <tbody>
            {chans.map((c) => {
              const s = slugOf(c);
              return (
                <tr key={c.id} className={c.rival ? "" : "me"}>
                  <th scope="row"><span className="gr-who"><Av c={c} size={24} />{s ? <Link href={`/analytics/competitors/${s}`} className="ellipsis">{c.name}</Link> : <span className="ellipsis">{c.name}{!c.rival && <span className="pill sig" style={{ marginLeft: 6 }}>You</span>}</span>}</span></th>
                  {cols.map(([h, f, cls]) => <td key={h} className={`mono ${cls ?? ""}`}>{f(c)}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ManageRivals({ rivals }: { rivals: Rival[] }) {
  const { toast } = useDialog();
  const [list, setList] = useState(rivals);
  const [handle, setHandle] = useState("");
  const [net, setNet] = useState<"youtube" | "instagram">("youtube");
  const [busy, setBusy] = useState(false);
  const send = async (body: object) => {
    setBusy(true);
    try { const r = await api<{ rivals: Rival[] }>("live/rivals", { body }); setList(r.rivals); dispatchEvent(new Event("vb-rivals-changed")); return true; }
    catch (e) { toast((e as Error).message, "bad"); return false; }
    finally { setBusy(false); }
  };
  const key = (r: Rival) => `${r.net}:${r.handle}`;
  return (
    <section className="card an-card" aria-labelledby="gr-man-h">
      <div className="card-head"><div><h2 id="gr-man-h">Rivals you follow</h2><p className="sub">Pinned ones get their own page in the sidebar. New uploads are found within 10 minutes</p></div></div>
      <div className="gr-rivals">
        {list.map((r) => (
          <div key={key(r)} className="gr-rv">
            <PlatformBadge net={r.net} size={18} />
            <span className="ellipsis">{r.handle}</span>
            {r.net === "instagram" ? <span className="pill warn" title="Instagram only shares other accounts' numbers with apps signed in through Facebook">Needs Facebook Login</span>
              : r.error ? <span className="pill bad" title={r.error}>Not found</span> : !r.id ? <span className="pill">Finding…</span> : null}
            <span className="gr-rv-act">
              <button type="button" className={`icon-btn sm ${r.pinned ? "on" : ""}`} aria-pressed={r.pinned} aria-label={`${r.pinned ? "Unpin" : "Pin"} ${r.handle}`} disabled={busy} onClick={() => send({ pin: { handle: key(r), on: !r.pinned } })}><PushPin size={15} weight={r.pinned ? "fill" : "regular"} /></button>
              <button type="button" className="icon-btn sm" aria-label={`Stop following ${r.handle}`} disabled={busy} onClick={() => send({ remove: key(r) })}><Trash size={15} /></button>
            </span>
          </div>
        ))}
      </div>
      <form className="gr-add" onSubmit={async (e) => { e.preventDefault(); if (handle.trim() && (await send({ add: { handle, net } }))) setHandle(""); }}>
        <Select size="sm" className="gr-net" label="Network" value={net} onChange={setNet} options={[["youtube", "YouTube"], ["instagram", "Instagram"]]} />
        <label className="gr-add-in"><MagnifyingGlass size={15} aria-hidden /><span className="sr-only">Channel handle or link</span><input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@handle or a channel link" /></label>
        <button type="submit" className="sm" disabled={busy || !handle.trim()}><Plus size={14} weight="bold" />Follow</button>
      </form>
      {list.some((r) => r.net === "instagram") && <p className="tiny dim" style={{ margin: "10px 0 0" }}>Instagram shows other accounts&apos; followers and posts only to apps that sign in through Facebook (a Facebook Page linked to your Instagram). Your Instagram is connected through Instagram&apos;s own sign-in, so these wait until that link exists.</p>}
    </section>
  );
}

const slugFor = (d: LiveView) => (c: LiveChan) => {
  const r = d.rivals.find((x) => x.id === c.id);
  return r ? rivalSlug(r) : null;
};

export function CompetitorsView() {
  const { data: d, err } = useLive(60_000);
  if (err && !d) return <Notice icon={<Warning size={18} />} tone="bad">Couldn&apos;t load your rivals: {err}</Notice>;
  if (!d) return <div className="an-wrap" aria-busy="true" aria-label="Loading rivals"><div className="skel" style={{ height: 160 }} /><div className="skel" style={{ height: 320 }} /></div>;
  const chans = new Map(d.chans.map((c) => [c.id, c]));
  const order = [...d.chans.filter((c) => !c.rival), ...d.chans.filter((c) => c.rival).sort((a, b) => (b.subs ?? 0) - (a.subs ?? 0))].filter((c) => c.net === "youtube");
  const rivals = d.chans.filter((c) => c.rival);
  const theirs = d.posts.filter((p) => chans.get(p.owner)?.rival);
  const all = rivals.flatMap((c) => c.recent);
  const slug = slugFor(d);
  return (
    <>
      <div className="gr-status" role="status"><span>You and <b className="mono">{rivals.length}</b> rival{rivals.length === 1 ? "" : "s"} on YouTube</span><span className="hide-sm">Public numbers: YouTube rounds their subscriber counts</span></div>
      {!rivals.length && <Notice icon={<Trophy size={18} />}>Finding your rivals&apos; channels. Their numbers appear after the next check (a minute or two).</Notice>}
      <div className="gr-cards">{order.map((c) => <ChanCard key={c.id} c={c} href={slug(c) ? `/analytics/competitors/${slug(c)}` : undefined} />)}</div>
      <VsTable chans={order} slugOf={slug} />
      <Outliers items={d.outliers} chans={chans} id="gr-out-h" />
      <div className="an-duo">
        <section className="card an-card" aria-labelledby="gr-their-h">
          <div className="card-head"><div><h2 id="gr-their-h">Their uploads, live</h2><p className="sub">Under 72 hours old, against each channel&apos;s usual</p></div><Link href="/analytics/live" className="btn ghost sm"><Broadcast size={14} />Live</Link></div>
          {theirs.length ? <FreshList posts={theirs} chans={chans} pick={() => {}} on={null} label="Rivals' fresh uploads" narrow /> : <p className="small dim" style={{ margin: 0 }}>Nothing new from them in the last 72 hours.</p>}
        </section>
        <Heatmap heat={postTimes(all)} metric="uploads" tz={tz()} title="When they post" id="gr-when-h" sub="Their last 50 uploads each, by when they went out" format={(v) => `${v} upload${v === 1 ? "" : "s"}`} />
      </div>
      <Titles vids={rivals.flatMap((c) => c.recent)} id="gr-titles-h" />
      <ManageRivals rivals={d.rivals} />
    </>
  );
}

/* ───────────── one rival */

export function RivalView({ slug }: { slug: string }) {
  const { data: d, err } = useLive(60_000);
  const [all, setAll] = useState(false);
  if (err && !d) return <Notice icon={<Warning size={18} />} tone="bad">Couldn&apos;t load this rival: {err}</Notice>;
  if (!d) return <div className="an-wrap" aria-busy="true"><div className="skel" style={{ height: 160 }} /><div className="skel" style={{ height: 320 }} /></div>;
  const r = d.rivals.find((x) => rivalSlug(x).toLowerCase() === decodeURIComponent(slug).toLowerCase());
  const c = d.chans.find((x) => r?.id && x.id === r.id);
  if (!r) return <Empty icon={<Trophy size={22} />} title="Not one of your rivals" action={<Link className="btn sm" href="/analytics/competitors">Competitors</Link>}>Follow a channel on Competitors to give it a page.</Empty>;
  if (r.net === "instagram") return <Empty icon={<Trophy size={22} />} title={`${r.handle} is waiting on Facebook Login`} action={<Link className="btn sm" href="/analytics/competitors">Competitors</Link>}>Instagram only shares other accounts&apos; numbers with apps signed in through Facebook.</Empty>;
  if (!c) return <Empty icon={<Trophy size={22} />} title={r.error ? `YouTube doesn't know ${r.handle}` : `Finding ${r.handle}…`}>{r.error ?? "Its numbers appear after the next check."}</Empty>;
  const chans = new Map(d.chans.map((x) => [x.id, x]));
  const mine = d.chans.find((x) => !x.rival && x.net === "youtube");
  const fresh = d.posts.filter((p) => p.owner === c.id);
  const outs = c.recent.filter((v) => v.score != null && v.score >= 1.5).map((v) => ({ ...v, owner: c.id, score: v.score! })).sort((a, b) => b.score - a.score);
  const sorted = [...c.pts].filter((p) => p[1] > 0);
  const rows = all ? c.recent : c.recent.slice(0, 15);
  return (
    <>
      <section className="card an-card gr-hero">
        <Av c={c} size={56} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="ellipsis">{c.name}</h2>
          <p className="sub dim small" style={{ margin: "2px 0 0" }}>{c.handle} · {full(c.videos)} videos · <a className="an-link" href={`https://youtube.com/${c.handle ?? `channel/${c.id}`}`} target="_blank" rel="noreferrer">Open on YouTube <ArrowSquareOut size={12} /></a></p>
        </div>
        <div className="gr-hero-n">
          <div><span className="an-k">Subscribers</span><b className="an-v">{compact(c.subs)}</b></div>
          <div><span className="an-k">24 h</span><b className="mono">{c.d1 == null ? "—" : `${c.d1 >= 0 ? "+" : ""}${compact(c.d1)}`}</b></div>
          <div><span className="an-k">7 days</span><b className="mono">{c.d7 == null ? "—" : `${c.d7 >= 0 ? "+" : ""}${compact(c.d7)}`}</b></div>
          <div><span className="an-k">Uploads / week</span><b className="mono">{c.per_week ?? "—"}</b></div>
          <div><span className="an-k">Engagement</span><b className="mono">{c.er == null ? "—" : `${c.er.toFixed(1)}%`}</b></div>
        </div>
      </section>
      <div className="an-row">
        <section className="card an-card" aria-labelledby="gr-rs-h">
          <div className="card-head"><div><h2 id="gr-rs-h">Subscribers gained</h2><p className="sub">Since Voicebox started watching{sorted.length ? ` on ${new Date(sorted[0][0] * 60_000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""} (YouTube rounds big channels to 3 figures, so it climbs in steps)</p></div></div>
          {sorted.length > 1 ? <LineChart labels={sorted.map((p) => new Date(p[0] * 60_000).toLocaleDateString(undefined, { month: "short", day: "numeric" }))} cur={sorted.map((p) => Math.max(0, p[1] - sorted[0][1]))} name="Subscribers gained" tipLabel={(i) => `${new Date(sorted[i][0] * 60_000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${full(sorted[i][1])} in all`} height={220} />
            : <p className="small dim" style={{ margin: 0 }}>The line starts with Voicebox&apos;s first checks and grows every 5 minutes.</p>}
        </section>
        <section className="card an-card" aria-labelledby="gr-rvs-h">
          <div className="card-head"><div><h2 id="gr-rvs-h">You vs {c.name}</h2><p className="sub">Their usual against yours</p></div></div>
          <div className="gr-vs2">
            {([["Subscribers", c.subs, mine?.subs], ["Uploads / week", c.per_week, mine?.per_week], ["Usual Short views", c.usual.yt_short, mine?.usual.yt_short], ["Usual video views", c.usual.yt_video, mine?.usual.yt_video], ["Engagement %", c.er, mine?.er]] as [string, number | null | undefined, number | null | undefined][]).map(([k, a, b]) => {
              const m = Math.max(a ?? 0, b ?? 0) || 1;
              return (
                <div key={k} className="gr-vs2-r">
                  <span className="small">{k}</span>
                  <span className="gr-vs2-b"><i className="them" style={{ width: `${((a ?? 0) / m) * 100}%` }} /><i className="you" style={{ width: `${((b ?? 0) / m) * 100}%` }} /></span>
                  <span className="mono small">{compact(a ?? null)} <span className="dim">/ {compact(b ?? null)}</span></span>
                </div>
              );
            })}
          </div>
          <div className="an-legend"><span><i className="k" style={{ background: "var(--blue)" }} />{c.name}</span><span><i className="k" style={{ background: "var(--ink)" }} />You</span></div>
        </section>
      </div>
      {fresh.length > 0 && (
        <section className="card an-card" aria-labelledby="gr-rf-h">
          <div className="card-head"><div><h2 id="gr-rf-h">Fresh uploads, live</h2><p className="sub">Under 72 hours old, against {c.name}&apos;s usual</p></div></div>
          <FreshList posts={fresh} chans={chans} pick={() => {}} on={null} label="Fresh uploads" />
        </section>
      )}
      <Outliers items={outs} chans={chans} id="gr-rout-h" title="Their hits" sub="Their last 50 uploads beating their own usual by 1.5× or more" />
      <div className="an-duo">
        <Heatmap heat={postTimes(c.recent)} metric="uploads" tz={tz()} title="When they post" id="gr-rwhen-h" sub="Their last 50 uploads" format={(v) => `${v} upload${v === 1 ? "" : "s"}`} />
        <Titles vids={c.recent} id="gr-rt-h" />
      </div>
      <section className="card an-card flush" aria-labelledby="gr-rall-h">
        <div className="card-head an-pad"><div><h2 id="gr-rall-h">Every recent upload</h2><p className="sub">Their last {c.recent.length}, newest first; score = views ÷ their usual for the format</p></div></div>
        <div className="gr-tbl-wrap">
          <table className="gr-tbl">
            <thead><tr><th scope="col">Video</th><th scope="col">Score</th><th scope="col">Views</th><th scope="col" className="hide-sm">Likes</th><th scope="col" className="hide-sm">Comments</th><th scope="col" className="hide-sm">Length</th><th scope="col">Age</th></tr></thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <th scope="row"><a className="gr-who" href={v.fmt === "yt_short" ? `https://youtube.com/shorts/${v.id}` : `https://youtu.be/${v.id}`} target="_blank" rel="noreferrer">
                    <span className="gr-th-sm">{v.thumb && <img src={v.thumb} alt="" loading="lazy" />}</span><span className="ellipsis">{v.title}</span></a></th>
                  <td><Score v={v.score} /></td><td className="mono">{compact(v.views)}</td><td className="mono hide-sm">{compact(v.likes)}</td><td className="mono hide-sm">{compact(v.comments)}</td>
                  <td className="mono hide-sm">{lenText(v.dur)}</td><td className="small dim">{since(v.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {c.recent.length > 15 && <div className="an-pad" style={{ paddingTop: 4, paddingBottom: 16 }}><button type="button" className="ghost sm" onClick={() => setAll(!all)} aria-expanded={all}>{all ? "Show the latest 15" : `Show all ${c.recent.length}`}</button></div>}
      </section>
    </>
  );
}

