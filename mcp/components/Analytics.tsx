"use client";
// Analytics: how the connected YouTube channels and Instagram accounts are doing, and what to post next. Laid out like a
// marketing hub: a card per format (Videos, Shorts, Reels, Posts) with its trend, views over time against the period
// before, the audience split, when posts do best (day × time), a channel's insights, then the next moves, every recent
// post scored against the usual for its format (the viral signal), where views come from, who's watching, the length
// and hashtags that work, and the posting rhythm. Data: lib/analytics.ts via /api/dash/analytics.
import {
  ArrowDownRight, ArrowSquareOut, ArrowUpRight, ArrowsClockwise, ChartLineUp, Fire, Lightning, LinkSimple, Plus, Sparkle, TrendUp, Warning,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Analytics as Data, Bar, Fmt, FmtSum, Item, SeriesKey, Tip } from "@/lib/analytics";
import { Bars, change, compact, day, full, Heatmap, LineChart, pct, Score, Scorecard, Trend } from "./anparts";
import { InstagramTab, YouTubeTab } from "./AnalyticsPlatform";
import { spaceName } from "@/lib/spaces";
import { ago, api } from "./api";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { Empty, Notice, PageHeader } from "./ui";

type Range = 7 | 28 | 90;
type Tab = "overview" | "youtube" | "instagram";
const FMTS: Fmt[] = ["yt_video", "yt_short", "ig_reel", "ig_post"];
const NET_NAME = { youtube: "YouTube", instagram: "Instagram" } as const;
function ChannelCard({ f, s, on, onClick }: { f: Fmt; s: FmtSum; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`an-ch ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on} aria-label={`${spaceName(f)}: show on the chart`}>
      <div className="an-ch-top">
        <span className="an-ch-ic"><PlatformBadge space={f} size={24} /></span>
        <b><span className="an-net">{f.startsWith("yt") ? "YouTube" : "Instagram"} </span>{spaceName(f).replace(/^(YouTube|Instagram) /, "")}</b>
        <Trend v={change(s.a.value, s.a.prev)} />
      </div>
      <div className="an-ch-nums">
        <div><span className="an-k"><TrendUp size={13} aria-hidden />{s.a.label}</span><span className="an-v mono">{compact(s.a.value)}</span></div>
        <div><span className="an-k"><TrendUp size={13} aria-hidden />{s.b.label}</span><span className="an-v mono">{compact(s.b.value)}</span></div>
      </div>
    </button>
  );
}

function ViewsChart({ data, k, setK }: { data: Data; k: SeriesKey; setK: (k: SeriesKey) => void }) {
  const opts = (Object.keys(data.series) as SeriesKey[]).map((x) => [x, data.series[x]!.label] as const);
  const key = k in data.series ? k : opts[0]?.[0];
  const s = key ? data.series[key] : undefined;
  if (!s) return <section className="card an-card"><h2>Views over time</h2><Empty icon={<ChartLineUp size={22} />} title="No daily numbers yet">They appear once a connected account has posts.</Empty></section>;
  const total = s.cur.reduce((a, b) => a + b, 0), totalPrev = s.prev.reduce((a, b) => a + b, 0);
  return (
    <section className="card an-card an-chart-card" aria-labelledby="an-views-h">
      <div className="card-head">
        <div><h2 id="an-views-h">Views over time</h2><p className="sub">{full(total)} in {data.range} days <Trend v={change(total, totalPrev)} size="sm" /></p></div>
        <Select className="an-sel" size="sm" label="Channel" value={key!} onChange={setK} options={opts} />
      </div>
      <LineChart labels={data.days.map((d) => day(d))} cur={s.cur} prev={s.prev} name={s.label} tipLabel={(i) => day(data.days[i], { weekday: "short", month: "short", day: "numeric" })} />
      <div className="an-legend">
        <span><i className="k" />Last {data.range} days</span><span><i className="k prev" />The {data.range} days before</span>
        {!s.exact && <span className="dim">By the day each post went out (its views so far)</span>}
      </div>
    </section>
  );
}

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
      {pts.length >= 2 ? <LineChart labels={pts.map((p) => day(p.d))} cur={pts.map((p) => p.f[a!.id])} name="Followers" height={200} tipLabel={(i) => day(pts[i].d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} />
        : <p className="small dim">The line starts here: Voicebox notes your follower counts each day you open Analytics (or an AI asks), so the history builds up from today.</p>}
    </section>
  );
}

function Audience({ data }: { data: Data }) {
  const accs = data.accounts.filter((a) => a.followers != null);
  const total = accs.reduce((a, b) => a + (b.followers ?? 0), 0);
  const gained = accs.reduce((a, b) => a + (b.gained ?? 0) - (b.lost ?? 0), 0);
  const known = accs.some((a) => a.gained != null);
  return (
    <section className="card an-card" aria-labelledby="an-aud-h">
      <div className="card-head"><h2 id="an-aud-h">Audience</h2><span className="pill">{data.range} days</span></div>
      <div className="an-hero"><span className="an-k">Total followers</span>
        <div className="row" style={{ gap: 10 }}><span className="an-big mono">{full(total)}</span>{known && total - gained > 0 && <Trend v={gained / (total - gained)} size="sm" />}</div>
      </div>
      {total > 0 && <>
        <div className="an-split" role="img" aria-label={accs.map((a) => `${NET_NAME[a.network]} ${a.name}: ${pct((a.followers ?? 0) / total)}`).join(", ")}>
          {accs.map((a) => <i key={a.id} className={`c-${a.network}`} style={{ flexGrow: Math.max(a.followers ?? 0, total * 0.02) }} />)}
        </div>
        <div className="an-legend tight">{accs.map((a) => <span key={a.id}><i className={`dot c-${a.network}`} />{NET_NAME[a.network]}</span>)}</div>
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

function Insights({ data, onSee }: { data: Data; onSee: (f: Fmt | "all") => void }) {
  const have = FMTS.filter((f) => data.formats[f]);
  const [f, setF] = useState<Fmt | "all">(have[0] ?? "all");
  const items = data.items.filter((i) => (f === "all" || i.fmt === f) && i.at >= Date.parse(`${data.from}T00:00:00Z`));
  const s = f === "all" ? null : data.formats[f];
  const views = items.reduce((a, i) => a + (i.views ?? i.reach ?? 0), 0);
  const eng = items.reduce((a, i) => a + i.likes + i.comments + (i.shares ?? 0) + (i.saves ?? 0), 0);
  const best = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  return (
    <section className="card an-card" aria-labelledby="an-ins-h">
      <div className="card-head">
        <h2 id="an-ins-h">Insights</h2>
        <Select className="an-sel" size="sm" label="Channel for insights" value={f} onChange={setF} options={[["all", "All channels"], ...have.map((x) => [x, spaceName(x)] as const)]} />
      </div>
      <p className="small dim" style={{ marginTop: -6 }}>From {day(data.from)} to {day(data.to, { month: "short", day: "numeric", year: "numeric" })}</p>
      <div className="an-ins-head">
        <span className="an-ch-ic">{f === "all" ? <Sparkle size={16} aria-hidden /> : <PlatformBadge space={f} size={22} />}</span>
        <div style={{ minWidth: 0, flex: 1 }}><b className="ellipsis" style={{ display: "block" }}>{f === "all" ? "Every channel" : spaceName(f)}</b><span className="tiny an-ok">{items.length} post{items.length === 1 ? "" : "s"} in this period</span></div>
        <button type="button" className="ghost xs an-pill-btn" onClick={() => onSee(f)}>See posts</button>
      </div>
      <div className="an-ins-nums">
        <div><span className="an-k">{s?.a.label ?? "Views"}</span><b className="mono">{full(s ? s.a.value : views)}</b></div>
        <div><span className="an-k">{s?.b.label ?? "Engaged"}</span><b className="mono">{full(s ? s.b.value : eng)}</b></div>
        <div><span className="an-k">Engagement</span><b className="mono">{views ? pct(eng / views, 1) : "—"}</b></div>
      </div>
      {best && best.score != null && (
        <a className="an-best" href={best.url} target="_blank" rel="noreferrer">
          <span className="an-th">{best.thumb ? <img src={best.thumb} alt="" loading="lazy" /> : <PlatformBadge space={best.fmt} size={18} />}</span>
          <span style={{ minWidth: 0, flex: 1 }}><span className="tiny dim">Best this period</span><b className="ellipsis" style={{ display: "block" }}>{best.title}</b></span>
          <Score v={best.score} />
        </a>
      )}
    </section>
  );
}

function Tips({ tips }: { tips: Tip[] }) {
  if (!tips.length) return null;
  return (
    <section className="card an-card" aria-labelledby="an-tips-h">
      <div className="card-head"><div><h2 id="an-tips-h"><Lightning size={16} weight="fill" aria-hidden />Next moves</h2><p className="sub">What your numbers say to do to grow, the strongest first</p></div></div>
      <div className="an-tips">
        {tips.map((t, i) => (
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
    </section>
  );
}

type Sort = "score" | "views" | "er" | "shares" | "saves" | "at";
const SORTS: [Sort, string][] = [["score", "Viral score"], ["views", "Views"], ["er", "Engagement rate"], ["shares", "Shares"], ["saves", "Saves"], ["at", "Newest"]];

function TopPosts({ data, fmt, setFmt }: { data: Data; fmt: Fmt | "all"; setFmt: (f: Fmt | "all") => void }) {
  const [sort, setSort] = useState<Sort>("score");
  const [more, setMore] = useState(false);
  const have = FMTS.filter((f) => data.items.some((i) => i.fmt === f));
  const rows = useMemo(() => {
    const val = (i: Item) => (sort === "at" ? i.at : sort === "views" ? i.views ?? i.reach ?? i.likes : (i[sort] as number | null) ?? -1);
    return data.items.filter((i) => fmt === "all" || i.fmt === fmt).sort((a, b) => val(b) - val(a));
  }, [data.items, fmt, sort]);
  const shown = more ? rows.slice(0, 60) : rows.slice(0, 10);
  return (
    <section className="card an-card flush" id="an-posts" aria-labelledby="an-posts-h">
      <div className="card-head an-pad">
        <div><h2 id="an-posts-h">Top posts</h2><p className="sub">Score is views against your usual for that format: 2× is twice your usual, 3× and up is taking off</p></div>
        <div className="row" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label="Format">
            <button className={fmt === "all" ? "on" : ""} aria-pressed={fmt === "all"} onClick={() => setFmt("all")}>All</button>
            {have.map((f) => <button key={f} className={fmt === f ? "on" : ""} aria-pressed={fmt === f} onClick={() => setFmt(f)}>{spaceName(f).replace("YouTube ", "").replace("Instagram ", "IG ")}</button>)}
          </div>
          <Select className="an-sel" size="sm" label="Sort posts by" value={sort} onChange={setSort} options={SORTS} />
        </div>
      </div>
      {!rows.length ? <div className="an-pad" style={{ paddingTop: 0 }}><Empty icon={<ChartLineUp size={22} />} title="No posts here yet" /></div> : (
        <div className="an-table" role="table" aria-label="Posts">
          <div role="row" className="an-tr head">
            <span role="columnheader">Post</span><span role="columnheader">Views</span><span role="columnheader" className="hide-sm">Engagement</span>
            <span role="columnheader" className="hide-md">Shares</span><span role="columnheader" className="hide-md">Saves</span><span role="columnheader" className="hide-md">Watched</span><span role="columnheader">Score</span>
          </div>
          {shown.map((i) => (
            <div role="row" key={i.id} className="an-tr">
              <span role="cell" className="an-post">
                <a href={i.url} target="_blank" rel="noreferrer" className="an-th" aria-label={`Open ${i.title} on ${NET_NAME[i.network]}`}>{i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : <PlatformBadge space={i.fmt} size={18} />}</a>
                <span style={{ minWidth: 0 }}>
                  <a href={i.url} target="_blank" rel="noreferrer" className="ellipsis an-post-t">{i.title}</a>
                  <span className="tiny dim an-post-m"><PlatformBadge space={i.fmt} size={14} />{spaceName(i.fmt)} · {ago(i.at)}{i.post && <> · <Link href={`/posts?post=${i.post}`} className="an-link">Open post</Link></>}</span>
                </span>
              </span>
              <span role="cell" className="mono">{compact(i.views ?? i.reach ?? null)}{i.views == null && i.reach == null && <span className="tiny dim"> {compact(i.likes)} likes</span>}</span>
              <span role="cell" className="mono hide-sm">{pct(i.er, 1)}</span>
              <span role="cell" className="mono hide-md">{compact(i.shares)}</span>
              <span role="cell" className="mono hide-md">{compact(i.saves)}</span>
              <span role="cell" className="mono hide-md">{i.avg_pct != null ? `${Math.round(i.avg_pct)}%` : i.avg_s != null ? `${i.avg_s}s` : "—"}</span>
              <span role="cell"><Score v={i.score} /></span>
            </div>
          ))}
        </div>
      )}
      {rows.length > 10 && <div className="an-pad" style={{ paddingTop: 10 }}><button type="button" className="ghost xs" onClick={() => setMore((m) => !m)}>{more ? "Show the top 10" : `Show ${Math.min(60, rows.length) - 10} more`}</button></div>}
    </section>
  );
}

function Where({ data }: { data: Data }) {
  const t = data.yt?.traffic ?? [];
  const all = t.reduce((a, b) => a + b[1], 0);
  return (
    <section className="card an-card" aria-labelledby="an-where-h">
      <div className="card-head"><div><h2 id="an-where-h">Where YouTube views come from</h2><p className="sub">Last {data.range} days</p></div></div>
      {t.length ? <Bars rows={t} unit={(v) => pct(v / all)} /> : <p className="small dim">{data.yt ? "No views in this period yet." : "Connect a YouTube channel and turn on the YouTube Analytics API to see this."}</p>}
      {!!data.yt?.devices.length && <><h3 className="an-h3">Devices</h3><Bars rows={data.yt.devices} unit={(v) => pct(v / data.yt!.devices.reduce((a, b) => a + b[1], 0))} /></>}
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
        {!!src.ages.length && <><h3 className="an-h3">Age</h3><Bars rows={src.ages} tone={`c-${n}`} unit={(v) => (n === "youtube" ? `${Math.round(v)}%` : compact(v))} /></>}
        {!!src.genders.length && <div className="an-legend tight" style={{ marginTop: 10 }}>{src.genders.map(([k, v]) => <span key={k}><b className="mono">{n === "youtube" ? `${Math.round(v)}%` : compact(v)}</b> {k}</span>)}</div>}
        {!!src.countries.length && <><h3 className="an-h3">Top countries</h3><Bars rows={src.countries.slice(0, 6).map(([k, v]) => [region(k), v] as Bar)} tone={`c-${n}`} /></>}
      </>}
    </section>
  );
}

function Lengths({ data }: { data: Data }) {
  return (
    <section className="card an-card" aria-labelledby="an-len-h">
      <div className="card-head"><div><h2 id="an-len-h">What length works</h2><p className="sub">Median views by video length</p></div></div>
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

function Rhythm({ data }: { data: Data }) {
  return (
    <section className="card an-card" aria-labelledby="an-rhy-h">
      <div className="card-head"><div><h2 id="an-rhy-h">Posting rhythm</h2><p className="sub">The last 7 days against your weekly goals, and what&apos;s booked</p></div><Link href="/posts?view=calendar" className="btn ghost xs">Calendar</Link></div>
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
    </section>
  );
}

export default function Analytics() {
  const [range, setRange] = useState<Range>(28);
  const [data, setData] = useState<(Data & { cached: boolean }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [k, setK] = useState<SeriesKey>("youtube");
  const [fmt, setFmt] = useState<Fmt | "all">("all");
  const [tab, setTabState] = useState<Tab>("overview");
  // the tab lives in the address (?tab=youtube), so a link or a reload lands on it
  useEffect(() => { const t = new URLSearchParams(location.search).get("tab"); if (t === "youtube" || t === "instagram") setTabState(t); }, []);
  const setTab = (t: Tab) => { setTabState(t); const u = new URL(location.href); if (t === "overview") u.searchParams.delete("tab"); else u.searchParams.set("tab", t); history.replaceState(null, "", u); };
  useEffect(() => { try { const r = Number(localStorage.getItem("vb-an-range")); if (r === 7 || r === 28 || r === 90) setRange(r); } catch {} }, []);
  const load = useCallback(async (r: Range, fresh = false) => {
    setBusy(true); setErr(null);
    try {
      const d = await api<Data & { cached: boolean }>(`analytics?range=${r}${fresh ? "&fresh=1" : ""}`);
      setData(d);
      setK((cur) => (cur in d.series ? cur : ((Object.keys(d.series)[0] as SeriesKey) ?? "youtube")));
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(range); }, [range, load]);
  const pickRange = (r: Range) => { setRange(r); try { localStorage.setItem("vb-an-range", String(r)); } catch {} };
  const see = (f: Fmt | "all") => { setFmt(f); document.getElementById("an-posts")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const have = data ? FMTS.filter((f) => data.formats[f]) : [];

  return (
    <>
      <PageHeader title="Analytics" sub="How your YouTube and Instagram are doing, and what to post next to grow."
        actions={<>
          <Select className="an-sel" label="Range" value={range} onChange={pickRange} options={[[7, "Last 7 days"], [28, "Last 28 days"], [90, "Last 90 days"]]} />
          <button type="button" className="ghost" onClick={() => load(range, true)} disabled={busy} aria-label="Refresh from YouTube and Instagram"><ArrowsClockwise size={15} className={busy ? "spin" : ""} />Refresh</button>
        </>} />
      {err && <Notice icon={<Warning size={18} />} tone="bad" action={<button className="ghost sm" onClick={() => load(range)}>Try again</button>}>Couldn&apos;t load analytics: {err}</Notice>}
      {data?.needs.map((n, i) => (
        <Notice key={i} icon={<Warning size={18} />} tone="warn" action={n.action === "reconnect" ? <a className="btn ghost sm" href={`/api/publish/${n.network}/connect`}><LinkSimple size={14} />Reconnect</a>
          : n.action === "enable" ? <a className="btn ghost sm" href="https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com" target="_blank" rel="noreferrer">Open Google Cloud <ArrowSquareOut size={13} /></a> : undefined}>{n.text}</Notice>
      ))}

      {!data && !err ? <div className="an-board"><div className="an-channels">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 132 }} />)}</div><div className="skel" style={{ height: 320 }} /></div>
        : data && !data.accounts.length ? (
          <Empty icon={<ChartLineUp size={22} />} title="Connect a channel to see analytics" action={<Link href="/posts?view=autopilot" className="btn sm"><Plus size={14} />Connect YouTube or Instagram</Link>}>
            Analytics reads the YouTube channels and Instagram accounts connected in Posts → Autopilot.
          </Empty>
        ) : data && (
          <div className={busy ? "an-wrap busy" : "an-wrap"}>
            <div className="tabs an-tabs" role="tablist" aria-label="Analytics views">
              {(["overview", "youtube", "instagram"] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                  {t !== "overview" && <PlatformBadge net={t} size={18} />}{t === "overview" ? "Overview" : NET_NAME[t]}
                  <span className="count">{t === "overview" ? data.accounts.length : data.accounts.filter((a) => a.network === t).length}</span>
                </button>
              ))}
              <span className="tiny dim an-upd-tab">{day(data.from)} – {day(data.to)} · updated {ago(data.at)}</span>
            </div>
            {tab === "youtube" ? <YouTubeTab key={`yt-${data.at}`} data={data} /> : tab === "instagram" ? <InstagramTab key={`ig-${data.at}`} data={data} /> : <>
            <div className="an-sec-h">
              <h2>My channels</h2>
              <span className="tiny dim an-upd">Every platform together</span>
              <Link href="/posts?view=autopilot" className="an-add"><Plus size={14} weight="bold" />Add channel</Link>
            </div>
            <div className="an-board">
              {have.length > 0 && <div className="an-channels">{have.map((f) => <ChannelCard key={f} f={f} s={data.formats[f]!} on={k === f} onClick={() => { if (data.series[f]) setK(f); setFmt(f); }} />)}</div>}
              <div className="an-row">
                <ViewsChart data={data} k={k} setK={setK} />
                <Audience data={data} />
              </div>
              <div className="an-row">
                <Heatmap id="an-heat-h" heat={data.heat} metric={data.heat_metric} tz={data.tz} />
                <Insights key={data.at} data={data} onSee={see} />
              </div>
            </div>
            {data.overview.length > 0 && (
              <section className="card an-card" aria-labelledby="an-sc-h">
                <div className="card-head"><div><h2 id="an-sc-h">Scorecard</h2><p className="sub">Every platform together, against the {data.range} days before. Open a platform tab for all of its numbers.</p></div></div>
                <Scorecard kpis={data.overview} range={data.range} />
              </section>
            )}
            <Tips tips={data.tips} />
            <TopPosts data={data} fmt={fmt} setFmt={setFmt} />
            <div className="an-trio">
              <Where data={data} />
              <Who key={`who-${data.at}`} data={data} />
              <Lengths data={data} />
            </div>
            <div className="an-duo">
              <Tags data={data} />
              <Rhythm data={data} />
            </div>
            <Growth key={`g-${data.at}`} data={data} />
            </>}
          </div>
        )}
    </>
  );
}
