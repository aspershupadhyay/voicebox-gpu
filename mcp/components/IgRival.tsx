"use client";
// Instagram rivals (Grow → Competitors): the Facebook connection they need, the table of every Instagram rival you
// follow, and one rival's page. Data: lib/rivals-ig.ts via /api/dash/ig-rival/<username>, the connection
// lib/publish/facebook.ts via /api/dash/facebook. Instagram shares likes and comments for other accounts, never views,
// so every score here is likes against that account's own usual.
import { ArrowSquareOut, ArrowsClockwise, FacebookLogo, Trophy, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { FbStatus } from "@/lib/publish/facebook";
import type { IgRival, RivalKind } from "@/lib/rivals-ig";
import { rivalSlug, type Rival } from "@/lib/live-shared";
import { compact, full, Heatmap, Score } from "./anparts";
import { ago, api } from "./api";
import { useDialog } from "./Dialog";
import { PlatformBadge } from "./platform";
import { Empty, Notice } from "./ui";

const KIND: Record<RivalKind, string> = { reel: "Reels", carousel: "Carousels", post: "Photos" };
const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

let fbKept: FbStatus | null = null;
/** The Facebook connection, shared by everything on Competitors. */
export function useFacebook() {
  const [s, setS] = useState<FbStatus | null>(fbKept);
  const load = () => api<FbStatus>("facebook").then((x) => { fbKept = x; setS(x); }).catch(() => null);
  useEffect(() => { load(); }, []);
  return { fb: s, setFb: (x: FbStatus) => { fbKept = x; setS(x); }, reload: load };
}

/** Connect / Disconnect Facebook, and what it's linked through. */
export function FacebookLink() {
  const { fb, setFb } = useFacebook();
  const { toast } = useDialog();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  useEffect(() => {
    // back from Facebook's sign-in (lib/publish route): say how it went once, then tidy the address
    const q = new URLSearchParams(location.search);
    const ok = q.get("fb_connected"), err = q.get("fb_error");
    if (ok == null && err == null) return;
    setMsg({ ok: ok ?? undefined, err: err ?? undefined });
    q.delete("fb_connected"); q.delete("fb_error");
    history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
  }, []);
  if (!fb) return null;
  const igs = fb.pages.filter((p) => p.ig);
  return (
    <div className="ig-fb">
      {msg.err && <Notice icon={<Warning size={18} />} tone="bad">{msg.err}</Notice>}
      {msg.ok != null && <Notice icon={<FacebookLogo size={18} />} tone="ok">Facebook connected{msg.ok ? ` through ${msg.ok}` : ""}. Instagram rivals load now.</Notice>}
      <div className="ig-fb-row">
        <FacebookLogo size={20} aria-hidden />
        <div style={{ minWidth: 0, flex: 1 }}>
          <b>Facebook (for Instagram rivals)</b>
          <p className="tiny dim" style={{ margin: "2px 0 0" }}>
            {!fb.configured ? "Not set up yet: FACEBOOK_APP_SECRET goes on the Worker (docs/PUBLISHING.md)."
              : fb.connected ? `Connected by ${fb.by ?? "someone"}${fb.at ? ` ${ago(fb.at)}` : ""} through ${igs.length ? igs.map((p) => `${p.name} (@${p.ig!.username})`).join(", ") : "a Page with no Instagram linked"}.${fb.declined?.length ? ` Not allowed: ${fb.declined.join(", ")}; connect again and allow them.` : ""}`
                : "Instagram only shares other accounts' followers and posts with apps signed in through Facebook, via a Page your Instagram is linked to."}
          </p>
        </div>
        {fb.configured && (fb.connected
          ? <button type="button" className="ghost xs" disabled={busy} onClick={async () => { setBusy(true); try { setFb(await api<FbStatus>("facebook/disconnect", { body: {} })); } catch (e) { toast((e as Error).message, "bad"); } setBusy(false); }}>Disconnect</button>
          : <a className="btn sm" href="/api/publish/facebook/connect"><FacebookLogo size={14} />Connect Facebook</a>)}
      </div>
    </div>
  );
}

const cache = new Map<string, IgRival>();
function useIgRival(handle: string | null) {
  const [d, setD] = useState<IgRival | null>(handle ? cache.get(handle) ?? null : null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (fresh = false) => {
    if (!handle) return;
    setBusy(true); setErr(null);
    try { const x = await api<IgRival>(`ig-rival/${encodeURIComponent(handle.replace(/^@/, ""))}${fresh ? "?fresh=1" : ""}`); cache.set(handle, x); setD(x); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, [handle]); // eslint-disable-line react-hooks/exhaustive-deps
  return { d, err, busy, reload: load };
}

function Row({ r }: { r: Rival }) {
  const { d, err } = useIgRival(r.handle);
  const top = d ? [...d.posts].filter((p) => p.score != null).sort((a, b) => b.score! - a.score!)[0] : null;
  const href = `/analytics/competitors/${rivalSlug(r)}`;
  return (
    <Link role="row" href={href} className="an-fr ig-rv-row">
      <span role="cell" className="an-fr-n">
        {d?.avatar ? <img src={d.avatar} alt="" width={22} height={22} className="ig-av" /> : <PlatformBadge net="instagram" size={22} />}
        <b className="ellipsis">@{r.handle.replace(/^@/, "")}</b>
      </span>
      {err ? <span role="cell" className="tiny ig-err">{err}</span> : <>
        <span role="cell" className="mono">{d ? compact(d.followers) : "…"}</span>
        <span role="cell" className="mono">{d ? d.rhythm.per_week ?? "—" : "…"}</span>
        <span role="cell" className="mono hide-sm">{d ? compact(d.usual.likes) : "…"}</span>
        <span role="cell" className="mono hide-sm">{d ? pct(d.usual.hit_rate) : "…"}</span>
        <span role="cell" className="hide-sm ig-top">{top ? <><span className="ellipsis small">{top.title}</span><Score v={top.score} what="Likes against their usual" /></> : <span className="tiny dim">{d ? "No scored posts" : "…"}</span>}</span>
      </>}
    </Link>
  );
}

/** Every Instagram rival you follow, side by side. */
export function IgRivalsTable({ rivals }: { rivals: Rival[] }) {
  const { fb } = useFacebook();
  const igs = rivals.filter((r) => r.net === "instagram");
  if (!igs.length || !fb?.connected) return null;
  return (
    <section className="card an-card flush" aria-labelledby="ig-rv-h">
      <div className="card-head an-pad"><div><h2 id="ig-rv-h">Instagram rivals</h2><p className="sub">Their public numbers from Instagram, read every 3 hours. Each post is scored by likes against their own usual</p></div></div>
      <div className="an-fmts" role="table" aria-label="Instagram rivals">
        <div role="row" className="an-fr ig-rv-row head"><span role="columnheader">Account</span><span role="columnheader">Followers</span><span role="columnheader">Posts / week</span><span role="columnheader" className="hide-sm">Usual likes</span><span role="columnheader" className="hide-sm">Hit rate</span><span role="columnheader" className="hide-sm">Best recent post</span></div>
        {igs.map((r) => <Row key={r.handle} r={r} />)}
      </div>
      <p className="tiny dim an-pad" style={{ padding: "10px 20px 16px" }}>Hit rate: the share of their recent posts with 1.5× their usual likes or more. Instagram never shares other accounts&apos; views.</p>
    </section>
  );
}

/** One Instagram rival in depth. */
export function IgRivalView({ handle }: { handle: string }) {
  const { fb } = useFacebook();
  const { d, err, busy, reload } = useIgRival(fb?.connected ? handle : null);
  if (!fb) return <div className="an-wrap" aria-busy="true"><div className="skel" style={{ height: 160 }} /></div>;
  if (!fb.connected) return (
    <>
      <Empty icon={<Trophy size={22} />} title={`${handle} is waiting on Facebook`} action={<Link className="btn sm" href="/analytics/competitors">Competitors</Link>}>Instagram only shares other accounts&apos; numbers with apps signed in through Facebook.</Empty>
      <FacebookLink />
    </>
  );
  if (err && !d) return <Notice icon={<Warning size={18} />} tone="bad" action={<button className="ghost sm" onClick={() => reload(true)}>Try again</button>}>{err}</Notice>;
  if (!d) return <div className="an-wrap" aria-busy="true" aria-label={`Loading ${handle}`}><div className="skel" style={{ height: 160 }} /><div className="skel" style={{ height: 320 }} /></div>;
  const hits = d.posts.filter((p) => p.score != null && p.score >= 1.5).sort((a, b) => b.score! - a.score!);
  const [hq, rq] = d.hits_vs_rest.questions, [hn, rn] = d.hits_vs_rest.numbers, [hl, rl] = d.hits_vs_rest.caption_len;
  return (
    <>
      <section className="card an-card gr-hero">
        {d.avatar ? <img src={d.avatar} alt="" width={56} height={56} className="ig-av lg" /> : <PlatformBadge net="instagram" size={56} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="ellipsis">{d.name || `@${d.username}`}</h2>
          <p className="sub dim small" style={{ margin: "2px 0 0" }}>@{d.username} · {full(d.posts_total)} posts · <a className="an-link" href={`https://instagram.com/${d.username}`} target="_blank" rel="noreferrer">Open on Instagram <ArrowSquareOut size={12} /></a></p>
          {d.bio && <p className="small" style={{ margin: "8px 0 0", whiteSpace: "pre-line" }}>{d.bio}</p>}
        </div>
        <div className="gr-hero-n">
          <div><span className="an-k">Followers</span><b className="an-v">{compact(d.followers)}</b></div>
          <div><span className="an-k">Posts / week</span><b className="mono">{d.rhythm.per_week ?? "—"}</b></div>
          <div><span className="an-k">Last 7 days</span><b className="mono">{d.rhythm.last7}</b></div>
          <div><span className="an-k">Usual likes</span><b className="mono">{compact(d.usual.likes)}</b></div>
          <div><span className="an-k">Engagement</span><b className="mono">{d.usual.er == null ? "—" : `${d.usual.er}%`}</b></div>
        </div>
      </section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <p className="tiny dim" style={{ margin: 0 }}>From Instagram {ago(d.at)} · their last {d.posts.length} posts{d.rhythm.last_post ? ` · latest ${ago(d.rhythm.last_post)}` : ""}{d.rhythm.median_gap_h != null ? ` · usually ${d.rhythm.median_gap_h < 24 ? `${Math.round(d.rhythm.median_gap_h)} h` : `${Math.round(d.rhythm.median_gap_h / 24)} days`} between posts` : ""}</p>
        <button type="button" className="ghost xs" onClick={() => reload(true)} disabled={busy}><ArrowsClockwise size={13} className={busy ? "spin" : ""} />Refresh</button>
      </div>
      {d.likes_hidden && <Notice icon={<Warning size={18} />} tone="warn">@{d.username} hides like counts, so posts can&apos;t be scored. Posting rhythm and times still show.</Notice>}
      <div className="an-duo">
        <section className="card an-card" aria-labelledby="ig-mix-h">
          <div className="card-head"><div><h2 id="ig-mix-h">What they post</h2><p className="sub">Share of their recent posts, with the usual likes and comments of each</p></div></div>
          <div className="ig-kinds">
            {d.kinds.map((k) => (
              <div key={k.kind} className="ig-kind">
                <span>{KIND[k.kind]}</span>
                <span className="an-bar" role="meter" aria-label={`${KIND[k.kind]} share`} aria-valuenow={Math.round(k.share * 100)} aria-valuemin={0} aria-valuemax={100}><i className="c-instagram" style={{ width: `${Math.max(2, k.share * 100)}%` }} /></span>
                <span className="mono small">{pct(k.share)}</span>
                <span className="tiny dim">{compact(k.median_likes)} likes · {compact(k.median_comments)} comments</span>
              </div>
            ))}
          </div>
          <h3 className="an-h3">What their hits have in common</h3>
          <ul className="ig-vs">
            <li><span>Caption length</span><b className="mono">{hl ?? "—"}</b><span className="tiny dim">vs {rl ?? "—"} characters on the rest</span></li>
            <li><span>Hook asks a question</span><b className="mono">{pct(hq)}</b><span className="tiny dim">vs {pct(rq)}</span></li>
            <li><span>Hook has a number</span><b className="mono">{pct(hn)}</b><span className="tiny dim">vs {pct(rn)}</span></li>
            <li><span>Hit rate</span><b className="mono">{pct(d.usual.hit_rate)}</b><span className="tiny dim">{d.usual.hits} posts at 1.5× their usual or more</span></li>
          </ul>
        </section>
        <Heatmap heat={d.heat} metric="times their usual likes" tz={d.tz} title="When they post" id="ig-when-h" sub="Their recent posts by when they went out, shaded by how they did" />
      </div>
      {!!d.tags.length && (
        <section className="card an-card" aria-labelledby="ig-tags-h">
          <div className="card-head"><div><h2 id="ig-tags-h">Their hashtags that work</h2><p className="sub">Median score of their posts using each (used twice or more)</p></div></div>
          <div className="an-tags">{d.tags.map((t) => <span key={t.tag} className={`pill ${t.score >= 1.5 ? "ok" : t.score < 0.8 ? "" : "blue"}`}>{t.tag}<b className="mono">{t.score.toFixed(1)}×</b><span className="dim">· {t.n}</span></span>)}</div>
        </section>
      )}
      <section className="card an-card flush" aria-labelledby="ig-posts-h">
        <div className="card-head an-pad"><div><h2 id="ig-posts-h">{hits.length ? "Their hits, then everything" : "Their recent posts"}</h2><p className="sub">Likes against their usual for the same kind of post</p></div></div>
        <div className="an-fmts" role="table" aria-label="Recent posts">
          <div role="row" className="an-fr ig-post-row head"><span role="columnheader">Post</span><span role="columnheader">Likes</span><span role="columnheader" className="hide-sm">Comments</span><span role="columnheader" className="hide-sm">Posted</span><span role="columnheader">Score</span></div>
          {[...hits, ...d.posts.filter((p) => !hits.includes(p))].slice(0, 40).map((p) => (
            <a role="row" key={p.id} href={p.url ?? `https://instagram.com/${d.username}`} target="_blank" rel="noreferrer" className="an-fr ig-post-row">
              <span role="cell" className="an-fr-n"><span className="pill">{KIND[p.kind].replace(/s$/, "")}</span><span className="ellipsis small">{p.title}</span></span>
              <span role="cell" className="mono">{compact(p.likes)}</span>
              <span role="cell" className="mono hide-sm">{compact(p.comments)}</span>
              <span role="cell" className="tiny dim hide-sm">{ago(p.at)}</span>
              <span role="cell"><Score v={p.score} what="Likes against their usual for this kind of post" /></span>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}
