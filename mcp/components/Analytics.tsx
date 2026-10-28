"use client";
// Analytics' four cross-platform views (YouTube and Instagram in depth are AnalyticsPlatform.tsx), each answering one
// question with a handful of numbers, the way YouTube Studio and the social suites split theirs:
//   Overview      how are we doing? A one-line summary, the headline metrics as tiles over one big chart (this period
//                 against the one before), every format side by side, the next moves, and the top posts.
//   Content       what works? Output and hit rate, every post on a performance map (views against the usual × engagement
//                 rate), every post in a table with its deep dive, and the lengths and tags that go with the best ones.
//   Audience      who's here and how are we growing? Followers and growth, followers over time, each account, who's
//                 watching and how they find you.
//   When to post  the day × time heatmap, the best slots, the days and hours the audience shows up, and the rhythm.
// The report comes from the shell (useAn); data: lib/analytics.ts via /api/dash/analytics.
import { ArrowRight, ArrowSquareOut, ArrowUpRight, ArrowDownRight, ChartLineUp, Clock, Fire, Lightning, Sparkle, TrendUp, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { Analytics as Data, Bar, Daily, Fmt, Item, Kpi, Tip } from "@/lib/analytics";
import { spaceName } from "@/lib/spaces";
import { Bars, change, Columns, compact, DAYS, day, fmtUnit, full, Heatmap, hour, LineChart, pct, Quadrant, Score, Scorecard, SLOTS, Trend, TrendBoard } from "./anparts";
import { InstagramTab, PostDrawer, PostList, YouTubeTab } from "./AnalyticsPlatform";
import { useAn } from "./AnalyticsShell";
import { FollowerGrowth, KpiStrip, Responses, TopTable } from "./Flux";
import { ago } from "./api";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { Empty } from "./ui";

const FMTS: Fmt[] = ["yt_video", "yt_short", "ig_reel", "ig_post"];
const NET_NAME = { youtube: "YouTube", instagram: "Instagram" } as const;
const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const short = (f: Fmt) => spaceName(f).replace("YouTube ", "").replace("Instagram ", "IG ");
/** "up 18%" / "down 4%" / "3× up" */
const moved = (v: number) => (Math.abs(v) >= 10 ? `${Math.round(Math.abs(v) + 1)}×` : pct(Math.abs(v)));
const kpiOf = (d: Data, k: string) => d.overview.find((x) => x.key === k);
const inPeriod = (d: Data) => { const s = Date.parse(`${d.from}T00:00:00Z`); return d.items.filter((i) => i.at >= s); };

/** The day-by-day headline metrics; a report kept before they existed falls back on the views series. */
export function trendOf(d: Data): Daily[] {
  if (d.trend?.length) return d.trend;
  const yt = d.series.youtube, ig = d.series.instagram;
  if (!yt && !ig) return [];
  const add = (k: "cur" | "prev") => d.days.map((_, i) => (yt?.[k][i] ?? 0) + (ig?.[k][i] ?? 0));
  return [{ key: "views", label: "Views and reach", cur: add("cur"), prev: add("prev") }];
}

/* ───────────── Overview */

/** Every format side by side: its main number, its share of views, the trend, output and how a typical post did. */
function Formats({ data }: { data: Data }) {
  const rows = FMTS.filter((f) => data.formats[f]).map((f) => ({ f, s: data.formats[f]! }));
  const views = sumOf(rows.filter((r) => r.s.a.label === "Views").map((r) => r.s.a.value ?? 0));
  const items = inPeriod(data);
  return (
    <section className="card an-card flush" aria-labelledby="an-fmt-h">
      <div className="card-head an-pad"><div><h2 id="an-fmt-h">By format</h2><p className="sub">Each against its own last {data.range} days; the score is how a typical post did against your usual</p></div></div>
      {!rows.length ? <div className="an-pad" style={{ paddingBottom: 20 }}><Empty icon={<ChartLineUp size={22} />} title="No posts yet" /></div> : (
        <div className="an-fmts" role="table" aria-label="Formats">
          <div role="row" className="an-fr head"><span role="columnheader">Format</span><span role="columnheader">Views</span><span role="columnheader" className="hide-sm">Change</span><span role="columnheader">Posts</span><span role="columnheader" className="hide-sm">Typical</span></div>
          {rows.map(({ f, s }) => {
            const share = s.a.label === "Views" && views ? (s.a.value ?? 0) / views : null;
            const med = median(items.filter((i) => i.fmt === f && i.score != null).map((i) => i.score!));
            return (
              <Link role="row" key={f} href={`/analytics/content?fmt=${f}`} className="an-fr">
                <span role="cell" className="an-fr-n">
                  <PlatformBadge space={f} size={22} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <b className="ellipsis" style={{ display: "block" }}>{spaceName(f)}</b>
                    {share != null && <span className="an-share" title={`${pct(share)} of views`}><i className={f.startsWith("yt") ? "c-youtube" : "c-instagram"} style={{ width: `${Math.max(2, share * 100)}%` }} /></span>}
                  </span>
                </span>
                <span role="cell"><b className="mono">{compact(s.a.value)}</b>{s.a.label !== "Views" && <span className="tiny dim"> {s.a.label.toLowerCase()}</span>}{share != null && <span className="tiny dim"> · {pct(share)}</span>}</span>
                <span role="cell" className="hide-sm"><Trend v={change(s.a.value, s.a.prev)} size="sm" /></span>
                <span role="cell" className="mono">{s.posts}<span className="tiny dim"> / {s.prev_posts}</span></span>
                <span role="cell" className="hide-sm"><Score v={med} /></span>
              </Link>
            );
          })}
        </div>
      )}
      <p className="tiny dim an-pad" style={{ padding: "10px 20px 16px" }}>Posts: this period / the one before. Open a format for its posts.</p>
    </section>
  );
}

function Tips({ tips, limit = 3 }: { tips: Tip[]; limit?: number }) {
  const [all, setAll] = useState(false);
  if (!tips.length) return null;
  const shown = all ? tips : tips.slice(0, limit);
  return (
    <section className="card an-card" aria-labelledby="an-tips-h">
      <div className="card-head"><div><h2 id="an-tips-h"><Lightning size={16} weight="fill" aria-hidden />Next moves</h2><p className="sub">What your numbers say to do, the strongest first</p></div></div>
      <div className="an-tips one">
        {shown.map((t, i) => (
          <div key={i} className="an-tip-card">
            <span className={`an-tip-ic ${t.tone}`} aria-hidden>{t.tone === "warn" ? <Warning size={15} weight="bold" /> : t.tone === "ok" ? <Fire size={15} weight="fill" /> : t.tone === "violet" ? <Sparkle size={15} weight="fill" /> : <TrendUp size={15} weight="bold" />}</span>
            <div style={{ minWidth: 0 }}>
              <b>{t.title}</b>
              <p>{t.body}</p>
              {t.href && (t.href.startsWith("/") ? <Link href={t.href} className="tiny an-link">Open <ArrowUpRight size={11} aria-hidden /></Link> : <a href={t.href} target="_blank" rel="noreferrer" className="tiny an-link">Open <ArrowSquareOut size={11} aria-hidden /></a>)}
            </div>
          </div>
        ))}
      </div>
      {tips.length > limit && <button type="button" className="ghost xs" style={{ marginTop: 12 }} onClick={() => setAll((a) => !a)}>{all ? "Show the top 3" : `Show all ${tips.length}`}</button>}
    </section>
  );
}

/** The best posts of the period as cards (the latest posts when the period had none scored). */
export function TopPosts({ data, open, n = 6, title = "Top posts", id = "an-top-h" }: { data: Data; open: (i: Item) => void; n?: number; title?: string; id?: string }) {
  const period = inPeriod(data).filter((i) => i.score != null);
  const pool = period.length ? period : data.items.filter((i) => i.score != null);
  const top = [...pool].sort((a, b) => b.score! - a.score!).slice(0, n);
  return (
    <section className="card an-card" aria-labelledby={id}>
      <div className="card-head">
        <div><h2 id={id}>{title}</h2><p className="sub">{period.length ? `Posted in the last ${data.range} days` : "Your latest posts"}, by score: views against your usual for the format</p></div>
        <Link href="/analytics/content" className="btn quiet sm">All content <ArrowRight size={14} /></Link>
      </div>
      {!top.length ? <Empty icon={<Fire size={22} />} title="No scored posts yet">After three posts in a format, each gets a score.</Empty> : (
        <div className="an-tops">
          {top.map((i, k) => (
            <button key={i.id} type="button" className="an-topc" onClick={() => open(i)} aria-label={`Deep dive: ${i.title}`}>
              <span className="an-topc-th">
                {i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : <PlatformBadge space={i.fmt} size={22} />}
                <span className="an-rank mono">{k + 1}</span>
              </span>
              <span className="an-topc-t">{i.title}</span>
              <span className="tiny dim an-post-m"><PlatformBadge space={i.fmt} size={14} />{short(i.fmt)} · {ago(i.at)}</span>
              <span className="an-topc-n">
                <span><b className="mono">{compact(i.views ?? i.reach ?? i.likes)}</b> <span className="tiny dim">{i.views != null || i.reach != null ? "views" : "likes"}</span></span>
                <Score v={i.score} />
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function Overview() {
  const data = useAn();
  const [open, setOpen] = useState<Item | null>(null);
  const trend = trendOf(data);
  const views = trend.find((t) => t.key === "views");
  return (
    <>
      <KpiStrip data={data} />
      <div className="an-row">
        <FollowerGrowth data={data} />
        <Responses data={data} />
      </div>
      <div className="an-row">
        <section className="card an-card" aria-labelledby="an-ov-views-h">
          <div className="card-head"><div><h2 id="an-ov-views-h">Views and reach, day by day</h2><p className="sub">The last {data.range} days against the {data.range} before</p></div></div>
          {views ? <LineChart labels={data.days.map((d) => day(d))} cur={views.cur} prev={views.prev} name="Views and reach" height={240} /> : <Empty icon={<ChartLineUp size={22} />} title="No daily views yet" />}
          <div className="an-legend"><span><i className="k" />Last {data.range} days</span><span><i className="k prev" />The {data.range} days before</span></div>
        </section>
        <Tips tips={data.tips} />
      </div>
      <TopTable data={data} open={setOpen} />
      <Formats data={data} />
      {open && <PostDrawer item={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ───────────── Content */

function Lengths({ data }: { data: Data }) {
  return (
    <section className="card an-card" aria-labelledby="an-len-h">
      <div className="card-head"><div><h2 id="an-len-h">What length works</h2><p className="sub">Median views by video length (how many posts)</p></div></div>
      {data.lengths.length ? <Bars rows={data.lengths.map((l) => [`${l.label} · ${l.n}`, l.median] as Bar)} /> : <p className="small dim">Shows once there are YouTube videos with views.</p>}
      {data.yt?.avg_pct != null && <p className="small dim" style={{ margin: "12px 0 0" }}>Viewers watch <b className="an-ink">{Math.round(data.yt.avg_pct)}%</b> of a video on average{data.yt.subs_per_1k != null && <> and <b className="an-ink">{data.yt.subs_per_1k}</b> in every 1,000 views subscribe</>}.</p>}
    </section>
  );
}

function Tags({ data }: { data: Data }) {
  return (
    <section className="card an-card" aria-labelledby="an-tags-h">
      <div className="card-head"><div><h2 id="an-tags-h">Hashtags and tags that work</h2><p className="sub">Median score of posts using each (used twice or more)</p></div></div>
      {data.tags.length ? (
        <div className="an-tags">{data.tags.map((t) => <span key={t.tag} className={`pill ${t.score >= 1.5 ? "ok" : t.score < 0.8 ? "" : "blue"}`}>{t.tag}<b className="mono">{t.score.toFixed(1)}×</b><span className="dim">· {t.n}</span></span>)}</div>
      ) : <p className="small dim">Use a few hashtags or tags again and again, and this shows which ones go with your best posts.</p>}
    </section>
  );
}

export function ContentView() {
  const data = useAn();
  const q = useSearchParams();
  const f = q.get("fmt");
  const fmt0 = FMTS.includes(f as Fmt) ? (f as Fmt) : "all";
  const [open, setOpen] = useState<Item | null>(null);
  const kpis = useMemo(() => {
    const s = Date.parse(`${data.from}T00:00:00Z`), ps = s - data.range * 864e5;
    const er = (a: number, b: number) => median(data.items.filter((i) => i.at >= a && i.at < b && i.er != null).map((i) => i.er! * 100));
    const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
    const out: Kpi[] = ["posts", "hits", "median_score"].map((k) => kpiOf(data, k)).filter(Boolean) as Kpi[];
    out.push({ key: "er_med", label: "Typical engagement rate", group: "Engagement", value: r2(er(s, Infinity)), prev: r2(er(ps, s)), unit: "pct", about: "The median post's engagements ÷ its views (or reach)." });
    return out.filter((k) => k.value != null);
  }, [data]);
  return (
    <>
      {kpis.length > 0 && <Scorecard kpis={kpis} range={data.range} />}
      <section className="card an-card" aria-labelledby="an-map-h">
        <div className="card-head">
          <div><h2 id="an-map-h">Performance map</h2><p className="sub">Every post: across, views against your usual for its format; up, how many viewers engaged</p></div>
          <div className="an-legend tight" style={{ marginTop: 0 }}><span><i className="dot c-youtube" />YouTube</span><span><i className="dot c-instagram" />Instagram</span></div>
        </div>
        <Quadrant items={data.items} open={setOpen} />
        <p className="tiny dim" style={{ margin: "8px 0 0" }}>Hits travelled and landed: make more like them. Loved, not seen: good posts the feed didn&apos;t push, so try a stronger hook or title. Seen, not loved: the hook worked, the rest didn&apos;t.</p>
      </section>
      <PostList key={fmt0} items={data.items} net="all" open={setOpen} fmt0={fmt0} />
      <div className="an-duo">
        <Lengths data={data} />
        <Tags data={data} />
      </div>
      {open && <PostDrawer item={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ───────────── Audience */

/** Followers per account over time: Voicebox keeps one reading a day, so this grows longer than Instagram remembers. */
function Growth({ data }: { data: Data }) {
  const accs = data.accounts.filter((a) => data.history.some((h) => h.f[a.id] != null));
  const [id, setId] = useState(accs[0]?.id ?? "");
  const a = accs.find((x) => x.id === id) ?? accs[0];
  const pts = a ? data.history.filter((h) => h.f[a.id] != null) : [];
  return (
    <section className="card an-card" aria-labelledby="an-growth-h">
      <div className="card-head">
        <div><h2 id="an-growth-h">Followers over time</h2><p className="sub">One reading a day, kept by Voicebox{pts.length ? ` since ${day(pts[0].d, { month: "short", day: "numeric", year: "numeric" })}` : ""}</p></div>
        {accs.length > 1 && <Select className="an-sel" size="sm" label="Account" value={a?.id ?? ""} onChange={setId} options={accs.map((x) => [x.id, `${NET_NAME[x.network]} · ${x.name}`] as const)} />}
      </div>
      {pts.length >= 2 ? <LineChart labels={pts.map((p) => day(p.d))} cur={pts.map((p) => p.f[a!.id])} name="Followers" height={240} tipLabel={(i) => day(pts[i].d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} />
        : <p className="small dim">The line starts here: Voicebox notes your follower counts each day you open Analytics (or an AI asks), so the history builds up from today.</p>}
    </section>
  );
}

function Accounts({ data }: { data: Data }) {
  const accs = data.accounts.filter((a) => a.followers != null);
  const total = sumOf(accs.map((a) => a.followers ?? 0));
  return (
    <section className="card an-card" aria-labelledby="an-aud-h">
      <div className="card-head"><div><h2 id="an-aud-h">Accounts</h2><p className="sub">Followers and the change in {data.range} days</p></div></div>
      {total > 0 && <>
        <div className="an-split" role="img" aria-label={accs.map((a) => `${NET_NAME[a.network]} ${a.name}: ${pct((a.followers ?? 0) / total)}`).join(", ")}>
          {accs.map((a) => <i key={a.id} className={`c-${a.network}`} style={{ flexGrow: Math.max(a.followers ?? 0, total * 0.02) }} />)}
        </div>
        <div className="an-legend tight">{accs.map((a) => <span key={a.id}><i className={`dot c-${a.network}`} />{NET_NAME[a.network]} <b className="mono an-ink">{pct((a.followers ?? 0) / total)}</b></span>)}</div>
      </>}
      <div className="an-acc-list">
        {data.accounts.map((a) => {
          const net = (a.gained ?? 0) - (a.lost ?? 0);
          const base = (a.followers ?? 0) - net;
          return (
            <div key={a.id} className="an-acc">
              <PlatformBadge net={a.network} size={22} />
              <span className="ellipsis an-acc-n">{a.name}<span className="tiny dim"> {a.network === "instagram" && a.handle ? `@${a.handle}` : a.handle ?? ""}</span></span>
              <span className="mono">{full(a.followers)}</span>
              {a.gained != null ? <span className={`an-chg ${net >= 0 ? "up" : "down"}`} title={`${net >= 0 ? "+" : ""}${net} in ${data.range} days`}>{net >= 0 ? <ArrowUpRight size={12} weight="bold" aria-hidden /> : <ArrowDownRight size={12} weight="bold" aria-hidden />}{net >= 0 ? "+" : "−"}{Math.abs(net)}{base > 0 ? ` · ${pct(Math.abs(net) / base, 1)}` : ""}</span> : <span className="tiny dim">—</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Who({ data }: { data: Data }) {
  const nets = [data.yt && (data.yt.ages.length || data.yt.countries.length) ? "youtube" : null, data.ig && (data.ig.ages.length || data.ig.countries.length) ? "instagram" : null].filter(Boolean) as ("youtube" | "instagram")[];
  const [n, setN] = useState<"youtube" | "instagram">(nets[0] ?? "youtube");
  const src = n === "youtube" ? data.yt : data.ig;
  const region = (c: string) => { try { return new Intl.DisplayNames(undefined, { type: "region" }).of(c) ?? c; } catch { return c; } };
  return (
    <section className="card an-card" aria-labelledby="an-who-h">
      <div className="card-head">
        <div><h2 id="an-who-h">Who&apos;s watching</h2><p className="sub">{n === "youtube" ? "Viewers in this period" : "Your followers"}</p></div>
        {nets.length > 1 && <div className="seg" role="group" aria-label="Network">{nets.map((x) => <button key={x} className={n === x ? "on" : ""} aria-pressed={n === x} onClick={() => setN(x)}>{NET_NAME[x]}</button>)}</div>}
      </div>
      {!src || (!src.ages.length && !src.countries.length) ? <p className="small dim">Audience details show once there are enough viewers (Instagram needs 100 followers; YouTube hides small audiences).</p> : <>
        {!!src.ages.length && <><h3 className="an-h3" style={{ marginTop: 0 }}>Age</h3><Bars rows={src.ages} tone={`c-${n}`} unit={(v) => (n === "youtube" ? `${Math.round(v)}%` : compact(v))} /></>}
        {!!src.genders.length && <div className="an-legend tight" style={{ marginTop: 10 }}>{src.genders.map(([k, v]) => <span key={k}><b className="mono an-ink">{n === "youtube" ? `${Math.round(v)}%` : compact(v)}</b> {k}</span>)}</div>}
        {!!src.countries.length && <><h3 className="an-h3">Top countries</h3><Bars rows={src.countries.slice(0, 6).map(([k, v]) => [region(k), v] as Bar)} tone={`c-${n}`} /></>}
      </>}
    </section>
  );
}

function Found({ data }: { data: Data }) {
  const t = data.yt?.traffic ?? [];
  const all = sumOf(t.map((b) => b[1]));
  return (
    <section className="card an-card" aria-labelledby="an-where-h">
      <div className="card-head"><div><h2 id="an-where-h">How they find you</h2><p className="sub">Where YouTube views came from, last {data.range} days</p></div></div>
      {t.length ? <Bars rows={t} unit={(v) => pct(v / all)} /> : <p className="small dim">{data.yt ? "No views in this period yet." : "Connect a YouTube channel and turn on the YouTube Analytics API to see this."}</p>}
      {!!data.yt?.devices.length && <><h3 className="an-h3">Devices</h3><Bars rows={data.yt.devices} unit={(v) => pct(v / sumOf(data.yt!.devices.map((b) => b[1])))} /></>}
    </section>
  );
}

export function AudienceView() {
  const data = useAn();
  const followers = kpiOf(data, "followers"), net = kpiOf(data, "net");
  const kpis: Kpi[] = [followers, net].filter(Boolean) as Kpi[];
  if (followers?.value && net?.value != null && followers.value - net.value > 0) kpis.push({ key: "growth", label: "Growth rate", group: "Growth", value: Math.round((net.value / (followers.value - net.value)) * 10000) / 100, prev: null, unit: "pct", about: "Net new followers ÷ followers at the start of the period." });
  const nonF = kpiOf(data, "non_follower");
  if (nonF) kpis.push(nonF);
  return (
    <>
      {kpis.length > 0 && <Scorecard kpis={kpis} range={data.range} />}
      <div className="an-row">
        <Growth data={data} />
        <Accounts data={data} />
      </div>
      <div className="an-duo">
        <Who data={data} />
        <Found data={data} />
      </div>
    </>
  );
}

/* ───────────── When to post */

function BestSlots({ heat, metric }: { heat: { v: number; n: number }[][]; metric: string }) {
  const cells = heat.flatMap((r, d) => r.map((c, s) => ({ d, s, ...c }))).filter((c) => c.n);
  const sure = cells.filter((c) => c.n >= 2);
  const top = [...(sure.length >= 3 ? sure : cells)].sort((a, b) => b.v - a.v).slice(0, 3);
  const fmt = (v: number) => (metric === "engagements" ? <><b className="mono">{compact(v)}</b> engagements</> : <><b className="mono">{v >= 10 ? Math.round(v) : v.toFixed(1)}×</b> your usual</>);
  return (
    <section className="card an-card" aria-labelledby="an-best-h">
      <div className="card-head"><div><h2 id="an-best-h">Your best slots</h2><p className="sub">Where posts did best{sure.length >= 3 ? " (two posts or more)" : ""}</p></div></div>
      {!top.length ? <p className="small dim">After a few posts this ranks the times that work for you.</p> : (
        <ol className="an-slots">
          {top.map((c, k) => (
            <li key={`${c.d}-${c.s}`}>
              <span className="an-slot-k mono" aria-hidden>{k + 1}</span>
              <span style={{ minWidth: 0, flex: 1 }}><b>{DAYS[c.d]} {SLOTS[c.s]}–{SLOTS[(c.s + 1) % 8]}</b><span className="tiny dim" style={{ display: "block" }}>{c.n} post{c.n === 1 ? "" : "s"}</span></span>
              <span className="small dim">{fmt(c.v)}</span>
            </li>
          ))}
        </ol>
      )}
      <Link href="/posts?view=autopilot" className="btn ghost sm" style={{ marginTop: 14 }}><Clock size={14} />Set posting slots</Link>
    </section>
  );
}

function Rhythm({ data }: { data: Data }) {
  return (
    <section className="card an-card" aria-labelledby="an-rhy-h">
      <div className="card-head"><div><h2 id="an-rhy-h">Posting rhythm</h2><p className="sub">The last 7 days against your weekly goals, and what&apos;s booked</p></div><Link href="/posts?view=calendar" className="btn ghost xs">Calendar</Link></div>
      <RhythmRows data={data} />
    </section>
  );
}

export function RhythmRows({ data }: { data: Data }) {
  return <>
    {data.rhythm.length ? (
      <div className="an-rhythm">
        {data.rhythm.map((r) => {
          const goal = r.goal ?? Math.max(r.week, 1);
          return (
            <div key={r.space} className="an-rhy-r">
              <PlatformBadge space={r.space} size={20} />
              <span className="ellipsis">{r.label}</span>
              <span className="an-bar" role="meter" aria-label={`${r.label} this week`} aria-valuenow={r.week} aria-valuemin={0} aria-valuemax={goal}><i className={r.goal && r.week >= r.goal ? "c-ok" : "c-youtube"} style={{ width: `${Math.min(100, (r.week / goal) * 100)}%` }} /></span>
              <span className="mono small">{r.week}{r.goal ? ` / ${r.goal}` : ""}</span>
              <span className="tiny dim hide-sm">{r.next7} booked{r.last ? ` · last ${ago(r.last)}` : ""}</span>
            </div>
          );
        })}
      </div>
    ) : <p className="small dim">Set weekly goals on the Posts page and post a few times to see your rhythm.</p>}
    {data.gaps.length > 0 && <p className="small dim" style={{ margin: "12px 0 0" }}>Nothing booked on <b className="an-ink">{data.gaps.join(", ")}</b>.</p>}
  </>;
}

export function TimingView() {
  const data = useAn();
  const nets = (["youtube", "instagram"] as const).filter((n) => data.heat_by[n]);
  const [net, setNet] = useState<"all" | "youtube" | "instagram">("all");
  const heat = net === "all" ? data.heat : data.heat_by[net] ?? data.heat;
  const ytWeek = data.youtube.length ? DAYS.map((_, i) => sumOf(data.youtube.map((y) => y.weekday[i] ?? 0))) : null;
  const ig = data.instagram[0];
  const peak = ig?.online ? ig.online.indexOf(Math.max(...ig.online)) : -1;
  return (
    <>
      <div className="an-row">
        <Heatmap id="an-heat-h" heat={heat} metric={data.heat_metric} tz={data.tz}
          action={nets.length > 1 ? <div className="seg" role="group" aria-label="Network">{(["all", ...nets] as const).map((n) => <button key={n} className={net === n ? "on" : ""} aria-pressed={net === n} onClick={() => setNet(n)}>{n === "all" ? "All" : NET_NAME[n]}</button>)}</div> : undefined} />
        <BestSlots heat={heat} metric={data.heat_metric} />
      </div>
      <div className="an-duo">
        <section className="card an-card" aria-labelledby="an-ytw-h">
          <div className="card-head"><div><h2 id="an-ytw-h">Which days YouTube views land</h2><p className="sub">Average views per weekday, last {data.range} days</p></div></div>
          {ytWeek && ytWeek.some((v) => v > 0) ? <Columns labels={DAYS} values={ytWeek} name="Average YouTube views by weekday" /> : <p className="small dim">Shows with the YouTube Analytics API on.</p>}
        </section>
        <section className="card an-card" aria-labelledby="an-igo-h">
          <div className="card-head"><div><h2 id="an-igo-h">When Instagram followers are online</h2><p className="sub">{ig?.online ? `Most online at ${hour(peak)} (Instagram reports Pacific time)` : "Average reach per weekday"}</p></div></div>
          {ig?.online ? <Columns labels={Array.from({ length: 24 }, (_, h) => hour(h))} values={ig.online} name="Followers online by hour" every={6} />
            : ig?.weekday.length ? <Columns labels={DAYS} values={ig.weekday} name="Average reach by weekday" /> : <p className="small dim">Instagram shares this from 100 followers.</p>}
        </section>
      </div>
      <Rhythm data={data} />
    </>
  );
}

/* ───────────── each platform in depth (AnalyticsPlatform.tsx) */

export function YouTubeView() {
  const data = useAn();
  return <YouTubeTab key={`yt-${data.at}`} data={data} />;
}
export function InstagramView() {
  const data = useAn();
  return <InstagramTab key={`ig-${data.at}`} data={data} />;
}
