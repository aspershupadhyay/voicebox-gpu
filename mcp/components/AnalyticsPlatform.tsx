"use client";
// Analytics → YouTube and Analytics → Instagram: one platform in depth, in four views so no screen carries everything
// (?view=, as YouTube Studio splits its own): Overview (the account, every KPI against the period before, daily charts,
// the days and hours the audience shows up), Reach (where views come from), Audience (who's watching) and Posts (best
// times, and every post, each opening a deep dive: retention curve, views day by day since it went out, every metric).
// PostList and PostDrawer are shared with Analytics → Content. Data: lib/analytics-yt.ts, analytics-ig.ts, and
// /api/dash/analytics/post/<network>/<id> for a post.
import { ArrowSquareOut, ChartLineUp, Clock, Lightning, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import type { Analytics as Data, Fmt, IgDeep, Item, PostDetail, YtDeep } from "@/lib/analytics";
import { spaceName } from "@/lib/spaces";
import { ago, api } from "./api";
import { Bars, Columns, compact, DailyCard, DAYS, day, fmtUnit, full, Heatmap, hour, LineChart, pct, Score, Scorecard, share, Trend, change } from "./anparts";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { Empty, Notice } from "./ui";

const region = (c: string) => { try { return new Intl.DisplayNames(undefined, { type: "region" }).of(c) ?? c; } catch { return c; } };

function AccountHead({ a, net, pick }: { a: YtDeep["account"]; net: "youtube" | "instagram"; pick?: React.ReactNode }) {
  const url = net === "youtube" ? `https://youtube.com/channel/${a.id}` : `https://instagram.com/${a.handle ?? ""}`;
  return (
    <div className="an-acc-head">
      <span className="pv-av an-av">{a.avatar ? <img src={a.avatar} alt="" /> : a.name.slice(0, 1)}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b className="ellipsis" style={{ display: "block", fontSize: 16 }}>{a.name}</b>
        <span className="small dim">{[net === "instagram" && a.handle ? `@${a.handle}` : a.handle, `${full(a.followers)} ${net === "youtube" ? "subscribers" : "followers"}`, a.posts != null ? `${full(a.posts)} ${net === "youtube" ? "videos" : "posts"}` : null].filter(Boolean).join(" · ")}</span>
      </div>
      {pick}
      <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">Open on {net === "youtube" ? "YouTube" : "Instagram"} <ArrowSquareOut size={13} /></a>
    </div>
  );
}

function Card({ id, title, sub, children, action }: { id: string; title: string; sub?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="card an-card" aria-labelledby={id}>
      <div className="card-head"><div><h2 id={id}>{title}</h2>{sub && <p className="sub">{sub}</p>}</div>{action}</div>
      {children}
    </section>
  );
}
const none = (t = "YouTube doesn't report this for the period yet (it hides small numbers).") => <p className="small dim">{t}</p>;

type View = "overview" | "reach" | "audience" | "posts";
/** The platform's four views, kept in the address (?view=reach) so a link or a reload lands on it. */
function useView(): [View, (v: View) => void] {
  const q = useSearchParams(), router = useRouter(), path = usePathname();
  const v = q.get("view");
  const view: View = v === "reach" || v === "audience" || v === "posts" ? v : "overview";
  return [view, (n) => router.replace(n === "overview" ? path : `${path}?view=${n}`, { scroll: false })];
}
function Views({ view, set, posts }: { view: View; set: (v: View) => void; posts: string }) {
  return (
    <div className="seg an-views" role="group" aria-label="View">
      {(["overview", "reach", "audience", "posts"] as View[]).map((v) => (
        <button key={v} className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => set(v)}>{v === "posts" ? posts : v[0].toUpperCase() + v.slice(1)}</button>
      ))}
    </div>
  );
}

/** Every post of a platform (or of both, `net` "all"), sortable; a row opens the post's deep dive. */
export function PostList({ items, net, open, fmt0 = "all" }: { items: Item[]; net: "youtube" | "instagram" | "all"; open: (i: Item) => void; fmt0?: Fmt | "all" }) {
  type S = "score" | "views" | "er" | "shares" | "saves" | "avg" | "subs" | "at";
  const [sort, setSort] = useState<S>("score");
  const [fmt, setFmt] = useState<Fmt | "all">(fmt0);
  const [more, setMore] = useState(false);
  const fmts = ((net === "youtube" ? ["yt_video", "yt_short"] : net === "instagram" ? ["ig_reel", "ig_post"] : ["yt_video", "yt_short", "ig_reel", "ig_post"]) as Fmt[]).filter((f) => items.some((i) => i.fmt === f));
  const rows = useMemo(() => {
    const v = (i: Item) => (sort === "at" ? i.at : sort === "views" ? i.views ?? i.reach ?? i.likes : sort === "avg" ? i.avg_pct ?? i.avg_s ?? -1 : (i[sort] as number | null) ?? -1);
    return items.filter((i) => fmt === "all" || i.fmt === fmt).sort((a, b) => v(b) - v(a));
  }, [items, fmt, sort]);
  const shown = more ? rows : rows.slice(0, 15);
  return (
    <section className="card an-card flush" aria-labelledby={`an-${net}-posts`}>
      <div className="card-head an-pad">
        <div><h2 id={`an-${net}-posts`}>Every {net === "youtube" ? "video" : "post"}</h2><p className="sub">Open one for its deep dive: {net === "youtube" ? "the retention curve, views day by day since it went out, its traffic" : net === "instagram" ? "reach, saves, shares, follows, profile visits, watch time" : "retention, views day by day, reach, saves, shares"}</p></div>
        <div className="row" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label="Format">
            <button className={fmt === "all" ? "on" : ""} aria-pressed={fmt === "all"} onClick={() => setFmt("all")}>All</button>
            {fmts.map((f) => <button key={f} className={fmt === f ? "on" : ""} aria-pressed={fmt === f} onClick={() => setFmt(f)}>{net === "all" ? spaceName(f).replace("YouTube ", "").replace("Instagram ", "IG ") : spaceName(f).replace(/^(YouTube|Instagram) /, "")}</button>)}
          </div>
          <Select className="an-sel" size="sm" label="Sort by" value={sort} onChange={setSort} options={[["score", "Viral score"], ["views", "Views"], ["er", "Engagement rate"], ["shares", "Shares"], ...(net !== "youtube" ? [["saves", "Saves"] as const] : []), ...(net !== "instagram" ? [["subs", "Subscribers gained"] as const] : []), ["avg", net === "youtube" ? "Average % viewed" : "Watch time"], ["at", "Newest"]]} />
        </div>
      </div>
      {!rows.length ? <div className="an-pad" style={{ paddingBottom: 20 }}><Empty icon={<ChartLineUp size={22} />} title="No posts yet" /></div> : (
        <div className="an-table" role="table" aria-label="Posts">
          <div role="row" className="an-tr head">
            <span role="columnheader">{net === "youtube" ? "Video" : "Post"}</span><span role="columnheader">Views</span><span role="columnheader" className="hide-sm">Engagement</span>
            <span role="columnheader" className="hide-md">Shares</span><span role="columnheader" className="hide-md">{net === "youtube" ? "New subs" : net === "instagram" ? "Saves" : "Saves / subs"}</span><span role="columnheader" className="hide-md">{net === "instagram" ? "Watch time" : "Watched"}</span><span role="columnheader">Score</span>
          </div>
          {shown.map((i) => (
            <button type="button" role="row" key={i.id} className="an-tr an-tr-btn" onClick={() => open(i)} aria-label={`Deep dive: ${i.title}`}>
              <span role="cell" className="an-post">
                <span className="an-th">{i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : <PlatformBadge space={i.fmt} size={18} />}</span>
                <span style={{ minWidth: 0 }}><span className="ellipsis an-post-t">{i.title}</span><span className="tiny dim an-post-m">{spaceName(i.fmt)} · {ago(i.at)}{i.duration ? ` · ${fmtUnit(i.duration, "s")}` : ""}</span></span>
              </span>
              <span role="cell" className="mono">{compact(i.views ?? i.reach ?? null)}</span>
              <span role="cell" className="mono hide-sm">{pct(i.er, 1)}</span>
              <span role="cell" className="mono hide-md">{compact(i.shares)}</span>
              <span role="cell" className="mono hide-md">{compact(i.network === "youtube" ? i.subs : i.saves)}</span>
              <span role="cell" className="mono hide-md">{i.avg_pct != null ? `${Math.round(i.avg_pct)}%` : i.avg_s != null ? `${i.avg_s}s` : "—"}</span>
              <span role="cell"><Score v={i.score} /></span>
            </button>
          ))}
        </div>
      )}
      {rows.length > 15 && <div className="an-pad" style={{ padding: "10px 20px 16px" }}><button type="button" className="ghost xs" onClick={() => setMore((m) => !m)}>{more ? "Show fewer" : `Show all ${rows.length}`}</button></div>}
      <p className="tiny dim an-pad" style={{ padding: "0 20px 16px" }}>Lifetime numbers for each post; the score compares it with your usual for its format over your latest 100 posts.</p>
    </section>
  );
}

/** One post in depth, in a drawer. */
export function PostDrawer({ item, onClose }: { item: Item; onClose: () => void }) {
  const [d, setD] = useState<PostDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null); setErr(null);
    api<PostDetail>(`analytics/post/${item.network}/${item.id}`).then(setD).catch((e) => setErr((e as Error).message));
  }, [item]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  const v = d?.velocity;
  const peakI = v?.peak ? v.days.indexOf(v.peak) : -1;
  // in a portal: the page rises in with a transform, which would pin a fixed drawer to the page instead of the screen
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer an-drawer" role="dialog" aria-modal="true" aria-label={`Deep dive: ${item.title}`}>
        <div className="row between" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
          <div className="an-post" style={{ minWidth: 0 }}>
            <span className="an-th lg">{item.thumb ? <img src={item.thumb} alt="" /> : <PlatformBadge space={item.fmt} size={22} />}</span>
            <div style={{ minWidth: 0 }}>
              <span className="tiny dim">{spaceName(item.fmt)} · {new Date(item.at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <h2 style={{ fontSize: 17, marginTop: 2 }}>{item.title}</h2>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" autoFocus><X size={18} /></button>
        </div>
        <div className="row" style={{ gap: 8, margin: "12px 0 18px" }}>
          <a className="btn ghost sm" href={item.url} target="_blank" rel="noreferrer">Open on {item.network === "youtube" ? "YouTube" : "Instagram"} <ArrowSquareOut size={13} /></a>
          {item.post && <Link className="btn ghost sm" href={`/posts?post=${item.post}`}>Open the post in Voicebox</Link>}
          {item.score != null && <span className="row tiny dim" style={{ gap: 6 }}>Score <Score v={item.score} /></span>}
        </div>
        {err && <Notice icon={<X size={16} />} tone="bad">{err}</Notice>}
        {!d && !err && <div className="stack"><div className="skel" style={{ height: 140 }} /><div className="skel" style={{ height: 220 }} /></div>}
        {d && <>
          {d.notes.length > 0 && <div className="an-notes">{d.notes.map((n, i) => <p key={i}><Lightning size={13} weight="fill" aria-hidden /> {n}</p>)}</div>}
          <div className="an-kpis" style={{ "--cols": 3 } as React.CSSProperties}>
            {d.kpis.map((k) => <div key={k.key} className="an-kpi" title={k.about}><span className="an-k">{k.label}</span><div className="an-kpi-v"><span className="mono">{fmtUnit(k.value, k.unit)}</span></div></div>)}
          </div>
          {d.retention && (
            <div className="an-dsec">
              <h3>Audience retention</h3>
              <p className="small dim">How much of the audience is still watching at each point of the video (over 100% means people rewind or loop).</p>
              <LineChart labels={d.retention.x.map((x) => `${x}%`)} cur={d.retention.watch} unit="pct" name="Still watching" minMax={100} height={200} tipLabel={(i) => `${d.retention!.x[i]}% of the way in${item.duration ? ` (${fmtUnit((item.duration * d.retention!.x[i]) / 100, "s")})` : ""}`} />
              <p className="tiny dim">Against similar videos on YouTube: {(() => { const r = d.retention.relative.filter((x) => x > 0); const m = r.length ? r.reduce((a, b) => a + b, 0) / r.length : null; return m == null ? "not reported" : m >= 0.55 ? "above average" : m >= 0.45 ? "about average" : "below average"; })()}.</p>
            </div>
          )}
          {v && (
            <div className="an-dsec">
              <h3>Views day by day since it went out</h3>
              <p className="small dim">{v.peak && <>Peak on <b className="an-ink">{day(v.peak, { weekday: "short", month: "short", day: "numeric" })}</b>. </>}{v.first2 != null && <>{Math.round(v.first2)}% of these views came in the first 2 days, {Math.round(v.first7 ?? 0)}% in the first week{v.first2 > 60 ? " (a quick burst: it was pushed early, then stopped)" : v.first2 < 30 ? " (a slow burn: search or suggestions keep finding it)" : ""}.</>}</p>
              <LineChart labels={v.days.map((x, i) => `Day ${i + 1}`)} cur={v.views} name="Views" height={200} mark={peakI} tipLabel={(i) => `Day ${i + 1} · ${day(v.days[i], { weekday: "short", month: "short", day: "numeric" })}`} />
            </div>
          )}
          {d.traffic.length > 0 && <div className="an-dsec"><h3>Where its views came from</h3><Bars rows={d.traffic} unit={share(d.traffic)} /></div>}
          {d.actions.length > 0 && <div className="an-dsec"><h3>What people did on your profile after</h3><Bars rows={d.actions} tone="c-instagram" /></div>}
        </>}
      </aside>
    </>,
    document.body,
  );
}

export function YouTubeTab({ data }: { data: Data }) {
  const [view, setView] = useView();
  const [i, setI] = useState(0);
  const [open, setOpen] = useState<Item | null>(null);
  const y = data.youtube[i] ?? data.youtube[0];
  const accId = y?.account.id ?? data.accounts.find((a) => a.network === "youtube")?.id;
  const items = data.items.filter((x) => x.network === "youtube" && (!accId || x.account === accId));
  if (!data.accounts.some((a) => a.network === "youtube")) return <Empty icon={<ChartLineUp size={22} />} title="No YouTube channel connected" action={<Link href="/posts?view=autopilot" className="btn sm">Connect YouTube</Link>}>Connect it in Posts → Autopilot.</Empty>;
  const allTraffic = y ? y.traffic.reduce((a, b) => a + b.views, 0) : 0;
  return (
    <div className="an-wrap">
      {y && <AccountHead a={y.account} net="youtube" pick={data.youtube.length > 1 ? <Select className="an-sel" size="sm" label="Channel" value={i} onChange={setI} options={data.youtube.map((c, k) => [k, c.account.name] as const)} /> : null} />}
      <Views view={view} set={setView} posts="Videos" />
      {!y && view !== "posts" ? <Notice icon={<Clock size={18} />} tone="warn">The YouTube Analytics API isn&apos;t answering for this channel yet, so only video counts show. Turn it on in Google Cloud (see the strip above), then Refresh.</Notice> : view === "overview" && y && (
        <div className="an-board">
          <Scorecard kpis={y.kpis} range={data.range} />
          <div className="an-row">
            {y.daily.length ? <DailyCard id="an-yt-daily" title="Day by day" daily={y.daily} days={data.days} range={data.range} /> : <Card id="an-yt-daily" title="Day by day">{none()}</Card>}
            <Card id="an-yt-week" title="Which days views land" sub="Average views per weekday in this period">
              {y.weekday.length ? <Columns labels={DAYS} values={y.weekday} name="Average views by weekday" /> : none()}
              <p className="tiny dim" style={{ marginTop: 10 }}>YouTube reports views by day, not by hour. For posting times, see Videos (how your uploads did by when they went out).</p>
            </Card>
          </div>
        </div>
      )}
      {y && view === "reach" && <>
        <div className="an-duo">
          <Card id="an-yt-traffic" title="Traffic sources" sub="How viewers found your videos, against the period before">
            {y.traffic.length ? (
              <div className="an-mini-table">
                <div className="an-mt-r head"><span>Source</span><span>Views</span><span>Share</span><span className="hide-sm">Watch h</span><span>Change</span></div>
                {y.traffic.map((t) => <div key={t.key} className="an-mt-r"><span className="ellipsis">{t.label}</span><span className="mono">{compact(t.views)}</span><span className="mono">{pct(allTraffic ? t.views / allTraffic : 0)}</span><span className="mono hide-sm">{compact(t.watch_min / 60)}</span><span><Trend v={change(t.views, t.prev)} size="sm" /></span></div>)}
              </div>
            ) : none()}
          </Card>
          <Card id="an-yt-share" title="Where it's shared" sub="Shares by service">{y.sharing.length ? <Bars rows={y.sharing} tone="c-ok" /> : none("No shares in this period yet.")}</Card>
        </div>
        <div className="an-trio">
          <Card id="an-yt-search" title="Search terms" sub="What people typed before watching">{y.search.length ? <Bars rows={y.search} /> : none("No search views in this period yet.")}</Card>
          <Card id="an-yt-ext" title="External sites and apps" sub="Views from links outside YouTube">{y.external.length ? <Bars rows={y.external} /> : none("No views from outside YouTube yet.")}</Card>
          <Card id="an-yt-rel" title="Suggested next to" sub="Videos YouTube showed yours beside">{y.related.length ? <Bars rows={y.related} /> : none("Not reported yet.")}{y.playlists.length > 0 && <><h3 className="an-h3">Playlists</h3><Bars rows={y.playlists} /></>}</Card>
        </div>
      </>}
      {y && view === "audience" && <>
        <div className="an-duo">
          <Card id="an-yt-content" title="By content type" sub="Shorts, videos and live, side by side">
            {y.content.length ? (
              <div className="an-mini-table">
                <div className="an-mt-r head"><span>Type</span><span>Views</span><span>Watch h</span><span>% viewed</span><span>Subs</span></div>
                {y.content.map((c) => <div key={c.label} className="an-mt-r"><span>{c.label}</span><span className="mono">{compact(c.views)}</span><span className="mono">{compact(c.watch_h)}</span><span className="mono">{c.avg_pct != null ? `${c.avg_pct}%` : "—"}</span><span className="mono">{compact(c.subs)}</span></div>)}
              </div>
            ) : none()}
            {y.subscribed.length > 0 && <><h3 className="an-h3">Subscribers vs not</h3>
              <div className="an-mini-table">
                <div className="an-mt-r head"><span>Viewers</span><span>Views</span><span>Share</span><span>Watch h</span><span>% viewed</span></div>
                {y.subscribed.map((s) => <div key={s.label} className="an-mt-r"><span>{s.label}</span><span className="mono">{compact(s.views)}</span><span className="mono">{pct(s.views / Math.max(1, y.subscribed.reduce((a, b) => a + b.views, 0)))}</span><span className="mono">{compact(s.watch_min / 60)}</span><span className="mono">{s.avg_pct != null ? `${s.avg_pct}%` : "—"}</span></div>)}
              </div></>}
          </Card>
          <Card id="an-yt-dev" title="Devices" sub="Where it was watched, on what">{y.devices.length ? <Bars rows={y.devices} unit={share(y.devices)} /> : none()}{y.playback.length > 0 && <><h3 className="an-h3">Playback locations</h3><Bars rows={y.playback} unit={share(y.playback)} limit={6} /></>}{y.os.length > 0 && <><h3 className="an-h3">Operating systems</h3><Bars rows={y.os} unit={share(y.os)} limit={5} /></>}</Card>
        </div>
        <div className="an-duo">
          <Card id="an-yt-geo" title="Geography" sub="Top countries by views">
            {y.countries.length ? (
              <div className="an-mini-table">
                <div className="an-mt-r head"><span>Country</span><span>Views</span><span>Watch h</span><span className="hide-sm">Avg view</span><span>Subs</span></div>
                {y.countries.slice(0, 15).map((c) => <div key={c.code} className="an-mt-r"><span className="ellipsis">{region(c.code)}</span><span className="mono">{compact(c.views)}</span><span className="mono">{compact(c.watch_min / 60)}</span><span className="mono hide-sm">{fmtUnit(c.avg_s, "s")}</span><span className="mono">{compact(c.subs)}</span></div>)}
              </div>
            ) : none()}
          </Card>
          <Card id="an-yt-demo" title="Age and gender" sub="Share of signed-in viewers">
            {y.ages.length ? <Bars rows={y.ages} unit={(v) => `${Math.round(v)}%`} /> : none()}
            {y.genders.length > 0 && <div className="an-legend tight" style={{ marginTop: 12 }}>{y.genders.map(([k, v]) => <span key={k}><b className="mono an-ink">{Math.round(v)}%</b> {k}</span>)}</div>}
          </Card>
        </div>
      </>}
      {view === "posts" && <>
        {data.heat_by.youtube && <Heatmap id="an-yt-heat" title="Best times to upload" heat={data.heat_by.youtube} metric={data.heat_metric} tz={data.tz} />}
        <PostList items={items} net="youtube" open={setOpen} />
      </>}
      {open && <PostDrawer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function InstagramTab({ data }: { data: Data }) {
  const [view, setView] = useView();
  const [i, setI] = useState(0);
  const [open, setOpen] = useState<Item | null>(null);
  const [aud, setAud] = useState<"followers" | "engaged" | "reached">("followers");
  const g = data.instagram[i] ?? data.instagram[0];
  const accId = g?.account.id ?? data.accounts.find((a) => a.network === "instagram")?.id;
  const items = data.items.filter((x) => x.network === "instagram" && (!accId || x.account === accId));
  if (!data.accounts.some((a) => a.network === "instagram")) return <Empty icon={<ChartLineUp size={22} />} title="No Instagram account connected" action={<Link href="/posts?view=autopilot" className="btn sm">Connect Instagram</Link>}>Connect it in Posts → Autopilot.</Empty>;
  const audiences = g ? (["followers", "engaged", "reached"] as const).filter((k) => g.demo[k]) : [];
  const demo = g?.demo[audiences.includes(aud) ? aud : audiences[0]];
  const peak = g?.online ? g.online.indexOf(Math.max(...g.online)) : -1;
  return (
    <div className="an-wrap">
      {g && <AccountHead a={g.account} net="instagram" pick={data.instagram.length > 1 ? <Select className="an-sel" size="sm" label="Account" value={i} onChange={setI} options={data.instagram.map((c, k) => [k, c.account.name] as const)} /> : null} />}
      <Views view={view} set={setView} posts="Posts" />
      {!g && view !== "posts" ? <Notice icon={<Clock size={18} />} tone="warn">Instagram insights aren&apos;t allowed for this account yet, so only likes and comments show. Reconnect it (the strip above) and allow insights, then Refresh.</Notice> : view === "overview" && g && (
        <div className="an-board">
          <Scorecard kpis={g.kpis} range={data.range} />
          <div className="an-row">
            <DailyCard id="an-ig-daily" title="Day by day" daily={g.daily} days={data.days} range={data.range} />
            <Card id="an-ig-online" title="When followers are online" sub={g.online ? `Most online at ${hour(peak)} (Instagram reports Pacific time)` : "Average reach per weekday"}>
              {g.online ? <Columns labels={Array.from({ length: 24 }, (_, h) => hour(h))} values={g.online} name="Followers online by hour" every={6} /> : g.weekday.length ? <Columns labels={DAYS} values={g.weekday} name="Average reach by weekday" /> : none("Instagram shares this from 100 followers.")}
              {g.online && g.weekday.length > 0 && <><h3 className="an-h3">Reach by weekday</h3><Columns labels={DAYS} values={g.weekday} name="Average reach by weekday" /></>}
            </Card>
          </div>
        </div>
      )}
      {g && view === "reach" && <>
        <div className="an-trio">
          <Card id="an-ig-split" title="Followers vs non-followers" sub="How far past your followers you travel">
            {g.audience_split.length ? g.audience_split.map((s) => {
              const t = s.parts.reduce((a, b) => a + b[1], 0);
              return (
                <div key={s.metric} style={{ marginBottom: 14 }}>
                  <div className="row between small"><span className="dim">{s.metric}</span><span className="mono">{full(t)}</span></div>
                  <div className="an-split" style={{ marginTop: 6 }}>{s.parts.map(([k, v]) => <i key={k} className={k === "Non-followers" ? "c-instagram" : "c-youtube"} style={{ flexGrow: Math.max(v, t * 0.02) }} />)}</div>
                  <div className="an-legend tight">{s.parts.map(([k, v]) => <span key={k}><i className={`dot ${k === "Non-followers" ? "c-instagram" : "c-youtube"}`} />{k} <b className="mono an-ink">{pct(t ? v / t : 0)}</b></span>)}</div>
                </div>
              );
            }) : none("Instagram hasn't reported this split yet.")}
          </Card>
          <Card id="an-ig-fmt" title="By format" sub="Views, reach and interactions">
            {g.by_format.length ? (
              <div className="an-mini-table">
                <div className="an-mt-r head four"><span>Format</span><span>Views</span><span>Reach</span><span>Interact.</span></div>
                {g.by_format.map((f) => <div key={f.label} className="an-mt-r four"><span>{f.label}</span><span className="mono">{compact(f.views)}</span><span className="mono">{compact(f.reach)}</span><span className="mono">{compact(f.interactions)}</span></div>)}
              </div>
            ) : none("Not reported yet.")}
          </Card>
          <Card id="an-ig-taps" title="Profile link taps" sub="Bio link and contact buttons">{g.taps.length ? <Bars rows={g.taps} tone="c-instagram" /> : none("No taps in this period.")}</Card>
        </div>
      </>}
      {g && view === "audience" && <>
        <Card id="an-ig-demo" title="Audience" sub="By age, gender, country and city"
          action={audiences.length > 1 ? <div className="seg" role="group" aria-label="Audience">{audiences.map((k) => <button key={k} className={aud === k ? "on" : ""} aria-pressed={aud === k} onClick={() => setAud(k)}>{k === "followers" ? "Followers" : k === "engaged" ? "Engaged" : "Reached"}</button>)}</div> : undefined}>
          {demo ? (
            <div className="an-quad">
              <div><h3 className="an-h3">Age</h3>{demo.age.length ? <Bars rows={demo.age} tone="c-instagram" unit={share(demo.age)} /> : none("—")}</div>
              <div><h3 className="an-h3">Gender</h3>{demo.gender.length ? <Bars rows={demo.gender} tone="c-instagram" unit={share(demo.gender)} /> : none("—")}</div>
              <div><h3 className="an-h3">Countries</h3>{demo.country.length ? <Bars rows={demo.country.map(([k, v]) => [region(k), v])} tone="c-instagram" limit={6} /> : none("—")}</div>
              <div><h3 className="an-h3">Cities</h3>{demo.city.length ? <Bars rows={demo.city} tone="c-instagram" limit={6} /> : none("—")}</div>
            </div>
          ) : none("Instagram shares audience details from 100 followers.")}
        </Card>
      </>}
      {view === "posts" && <>
        {g && g.stories.length > 0 && (
          <Card id="an-ig-stories" title="Stories live now" sub="Instagram keeps Story insights for 24 hours">
            <div className="an-stories">
              {g.stories.map((s) => (
                <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="an-story">
                  <span className="an-story-th">{s.thumb ? <img src={s.thumb} alt="" loading="lazy" /> : null}</span>
                  <span className="tiny dim">{ago(s.at)}</span>
                  <span className="small"><b className="mono">{compact(s.views ?? s.reach)}</b> views · <b className="mono">{compact(s.replies)}</b> replies</span>
                  {s.nav.length > 0 && <span className="tiny dim">{s.nav.slice(0, 3).map(([k, v]) => `${k} ${compact(v)}`).join(" · ")}</span>}
                </a>
              ))}
            </div>
          </Card>
        )}
        {data.heat_by.instagram && <Heatmap id="an-ig-heat" title="Best times to post" heat={data.heat_by.instagram} metric={data.heat_metric} tz={data.tz} />}
        <PostList items={items} net="instagram" open={setOpen} />
      </>}
      {open && <PostDrawer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

