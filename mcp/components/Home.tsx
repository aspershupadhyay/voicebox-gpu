"use client";
// Home: the studio at a glance. A greeting (the GPU lives in Settings), then how the channels are doing (the headline metrics
// as tiles over one chart, the last 28 days against the 28 before, the top posts lately, this week's rhythm against the
// goals and what's due next), then the tools as tiles, your latest takes and ways to make a voice. The channel numbers
// are Analytics' own report (useReport), so opening Analytics after Home is instant.
import { ArrowRight, ArrowsClockwise, Brain, CalendarBlank, ChartLineUp, ClosedCaptioning, ImageSquare, MagicWand, Microphone, Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, api, fmtS, useSeed, type Job } from "./api";
import { CassetteArt, EngineArt, MicArt, VoiceGlyph } from "./art";
import { Query, useLive, useMe } from "./aw";
import { Marble, Rings } from "./orbs";
import { SampleButton } from "./Sample";
import { useStatus } from "./Shell";
import { PixelScene } from "./pixel";
import { Empty, Notice, PageHeader } from "./ui";
import { dueLabel } from "./PostDrawer";
import type { Post } from "@/lib/workspace";
import type { Item } from "@/lib/analytics";
import { TopPosts, trendOf } from "./Analytics";
import { PlatformBadge } from "./platform";
import { PostDrawer } from "./AnalyticsPlatform";
import { fmtUnit, TrendBoard } from "./anparts";
import { useReport, type Report } from "./useReport";

type Lib = {
  id: string; kind?: string; engine: string; voice: string; label?: string; created: number; match?: number | null;
  results: { duration: number; text?: string; audio?: string | null }[]; video?: { duration: number }; poster_url?: string | null; images?: { thumb_url?: string }[];
};
const seconds = (j: Lib) => j.video?.duration ?? j.results.reduce((a, r) => a + r.duration, 0);
const greeting = (h: number) => (h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Working late");

const TOOLS = [
  { href: "/voiceover", name: "Voiceover", art: <EngineArt engine="chatterbox" /> },
  { href: "/writing", name: "Writing room", art: <svg viewBox="-40 -40 80 80" width={72} height={72} aria-hidden><Rings cx={0} cy={0} r0={23} gap={4} n={4} /><Marble tone="ginger" seed={1.3} r={19} n={10} /></svg> },
  { href: "/voices/new", name: "Clone your voice", art: <EngineArt engine="qwen" /> },
  { href: "/voices/professional", name: "Train your voice", art: <VoiceGlyph name="myvoice" size={72} /> },
  { href: "/clean-up", name: "Clean-up", art: <MicArt /> },
  { href: "/subtitles", name: "Subtitles", art: <EngineArt engine="whisper" /> },
  { href: "/images", name: "Images", art: <EngineArt engine="zimage" /> },
];

function UpNext() {
  const { rows, loading } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(200)]);
  const next = rows.filter((p) => p.status !== "posted" && p.due_at).sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!)).slice(0, 3);
  if (loading) return <div className="skel" style={{ height: 96 }} />;
  if (!next.length) return (
    <div className="wk-none"><CalendarBlank size={16} aria-hidden /><span>Nothing booked yet. Give a post a date and it lines up here.</span><Link href="/posts?new=1" className="btn xs">New post</Link></div>
  );
  return (
    <div className="wk-next">
      {next.map((p) => {
        const late = Date.parse(p.due_at!) < Date.now();
        return (
          <Link key={p.$id} href={`/posts?post=${p.$id}`} className="wk-item">
            <span className={`wk-when ${late ? "late" : ""}`}>{late ? "Overdue" : dueLabel(p.due_at)}</span>
            <span className="ellipsis wk-t">{p.title}</span>
            <span className="tiny dim ellipsis hide-sm">{p.assignee_name ?? p.owner_name ?? ""}</span>
          </Link>
        );
      })}
    </div>
  );
}

/** This week, at a glance: a ring per format (posted against the weekly goal), the next seven days (booked or open),
 *  and what's up next. */
function WeekCard({ data, workspace }: { data: Report; workspace: boolean }) {
  const fmt = (t: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: data.tz, ...o }).format(new Date(t));
  const days = Array.from({ length: 7 }, (_, d) => {
    const t = Date.now() + d * 86_400_000;
    return { t, key: fmt(t, { weekday: "short", day: "numeric", month: "short" }), wd: fmt(t, { weekday: "short" }), n: fmt(t, { day: "numeric" }) };
  });
  const open = new Set(data.gaps);
  const booked = days.filter((d) => !open.has(d.key)).length;
  const R = 22, C = 2 * Math.PI * R;
  return (
    <section className="card an-card wk" aria-labelledby="home-week-h">
      <div className="card-head">
        <div><h2 id="home-week-h">This week</h2><p className="sub">{booked ? `${booked} of the next 7 days booked` : "Nothing booked for the next 7 days"}</p></div>
        <Link href="/posts?view=calendar" className="btn ghost xs"><CalendarBlank size={13} />Calendar</Link>
      </div>
      {data.rhythm.length ? (
        <div className="wk-rings">
          {data.rhythm.map((r, i) => {
            const goal = r.goal ?? Math.max(r.week, 1), f = Math.min(1, r.week / goal), met = !!r.goal && r.week >= r.goal;
            return (
              <div key={r.space} className={`wk-ring ${met ? "met" : ""}`} title={`${r.label}: ${r.week} posted this week${r.goal ? ` of ${r.goal}` : ""}, ${r.next7} booked${r.last ? `, last ${ago(r.last)}` : ""}`}>
                <span className="wk-dial">
                  <svg viewBox="0 0 52 52" aria-hidden>
                    <circle cx="26" cy="26" r={R} className="wk-track" />
                    <circle cx="26" cy="26" r={R} className="wk-fill" strokeDasharray={C} style={{ "--off": C * (1 - f), animationDelay: `${i * 90}ms` } as React.CSSProperties} />
                  </svg>
                  <PlatformBadge space={r.space} size={18} />
                </span>
                <b className="mono">{r.week}{r.goal ? <span className="dim">/{r.goal}</span> : null}</b>
                <span className="tiny dim ellipsis">{r.label.replace(/^(YouTube|Instagram) /, "")}</span>
              </div>
            );
          })}
        </div>
      ) : <p className="small dim">Set weekly goals on the Posts page and post a few times to see your rhythm.</p>}
      <div className="wk-days" role="list" aria-label="The next 7 days">
        {days.map((d, i) => {
          const isOpen = open.has(d.key);
          return (
            <span key={d.key} role="listitem" className={`wk-day ${isOpen ? "open" : "booked"} ${i === 0 ? "today" : ""}`} aria-label={`${d.key}: ${isOpen ? "nothing booked" : "booked"}`}>
              <span className="wk-wd">{i === 0 ? "Today" : d.wd}</span><b className="mono">{d.n}</b><i aria-hidden />
            </span>
          );
        })}
      </div>
      {workspace && <><h3 className="an-h3">Up next</h3><UpNext /></>}
    </section>
  );
}

/** How the channels are doing: Analytics' overview in brief. */
function Channels({ workspace }: { workspace: boolean }) {
  const { data, err } = useReport(28);
  const [open, setOpen] = useState<Item | null>(null);
  if (err) return null;
  if (!data) return <div className="home-pulse" aria-busy="true" aria-label="Loading your channels"><div className="skel" style={{ height: 340 }} /><div className="home-duo"><div className="skel" style={{ height: 260 }} /><div className="skel" style={{ height: 260 }} /></div></div>;
  if (!data.accounts.length) return (
    <Notice icon={<ChartLineUp size={18} weight="bold" />} action={<Link href="/posts?view=autopilot" className="btn sm"><Plus size={14} weight="bold" />Connect</Link>}>
      <b>See how your posts do.</b> Connect YouTube or Instagram and your views, followers and best posts show here.
    </Notice>
  );
  const er = data.overview.find((k) => k.key === "er");
  return (
    <section className="home-pulse" aria-labelledby="home-ch-h">
      <div className="section-h">
        <h2 id="home-ch-h">Your channels <span className="dim home-range">· last 28 days</span></h2>
        <Link href="/analytics" className="btn quiet sm">Open analytics <ArrowRight size={14} /></Link>
      </div>
      <TrendBoard id="home-trend" trend={trendOf(data)} days={data.days} range={data.range} height={200} extra={{ engagements: er?.value != null ? `${fmtUnit(er.value, "pct")} of views` : undefined }} />
      <div className="home-duo">
        <TopPosts data={data} open={setOpen} n={3} title="Top posts lately" id="home-top-h" />
        <WeekCard data={data} workspace={workspace} />
      </div>
      {open && <PostDrawer item={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

export default function Home() {
  const { status: st } = useStatus();
  const me = useMe();
  const [lib, setLib] = useState<Lib[] | null>(null);
  useSeed<{ jobs: Lib[] }>("library", (l) => setLib(l.jobs));
  const [jobs, setJobs] = useState<Job[]>([]);
  const [hello, setHello] = useState("Welcome back");
  useEffect(() => { setHello(greeting(new Date().getHours())); api<{ jobs: Lib[] }>("library").then((l) => setLib(l.jobs)).catch(() => setLib([])); }, []);
  useEffect(() => {
    if (!st?.online) return;
    const load = () => api<{ jobs: Job[] }>("jobs").then((j) => setJobs(j.jobs)).catch(() => {});
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 8000);
    return () => clearInterval(t);
  }, [st?.online]);

  const first = me?.user?.name?.split(" ")[0];
  const active = jobs.filter((j) => ["queued", "running"].includes(j.status));
  const workspace = !!(me?.user && me.session && me.workspace);

  return (
    <>
      <PageHeader eyebrow="Your studio" title={`${hello}${first ? `, ${first}` : ""}`}
        sub={active.length ? `${active.length} job${active.length > 1 ? "s" : ""} running on the GPU.` : "Your channels, this week's plan and what you made lately."}
        actions={<div className="home-scene-wrap"><PixelScene className="home-scene" /></div>} />

      {active.length > 0 && (
        <div className="card pad-sm" style={{ marginBottom: 20 }}>
          {active.map((j) => (
            <div key={j.id} style={{ padding: "6px 4px" }}>
              <div className="row between small"><b className="ellipsis">{j.label || `${j.engine} · ${j.voice}`}</b><span className="mono tiny dim">{j.progress.stage} · ~{fmtS(j.progress.eta_s)} left</span></div>
              <div className="bar thin live" style={{ marginTop: 8 }}><i style={{ width: `${Math.max(3, j.progress.fraction * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      )}

      <Channels workspace={workspace} />

      <div className="section-h home-studio"><h2>Studio</h2></div>
      <nav className="tiles" aria-label="Tools">
        {TOOLS.map((t) => (
          <Link key={t.href} href={t.href} className="tile">
            <span className="tile-art" aria-hidden>{t.art}</span>
            <b>{t.name}</b>
          </Link>
        ))}
      </nav>

      <div className="home-cols">
        <section>
          <div className="section-h"><h2>Latest from the library</h2><Link href="/files" className="btn quiet sm">Open files <ArrowRight size={14} /></Link></div>
          {lib === null && <div className="skel" style={{ height: 220 }} />}
          {lib?.length === 0 && <Empty art={<CassetteArt />} title="Nothing recorded yet" action={<Link href="/voiceover" className="btn sm"><Microphone size={14} weight="bold" />Make a voiceover</Link>}>Your takes, subtitles and images land here.</Empty>}
          <div className="rows">
            {(lib ?? []).slice(0, 6).map((j) => {
              const text = j.results[0]?.text?.replace(/<[^>]+>/g, "");
              return (
                <div key={j.id} className="list-row">
                  {j.kind === "image" ? <span className="thumb">{j.images?.[0]?.thumb_url ? <img src={j.images[0].thumb_url} alt="" /> : <ImageSquare size={18} />}</span>
                    : j.kind === "transcribe" ? <span className="thumb"><ClosedCaptioning size={18} /></span>
                    : <VoiceGlyph name={j.voice || j.engine} size={40} />}
                  <Link href={`/files#${j.id}`} style={{ minWidth: 0 }}>
                    <div className="t1">{j.label || (text ? `“${text.slice(0, 60)}”` : j.id)}</div>
                    <div className="t2">{j.kind === "image" ? "Image" : j.kind === "transcribe" ? "Subtitles" : j.kind === "video" ? "Video" : `${j.engine} · ${j.voice}`} · {fmtS(seconds(j))} · {ago(j.created)}</div>
                  </Link>
                  {j.results[0]?.audio && j.kind !== "image" ? <SampleButton id={`home/${j.id}`} url={j.results[0].audio ?? undefined} size={32} label={j.label || "take"} /> : <span />}
                </div>
              );
            })}
          </div>
        </section>
        <section>
          <div className="section-h"><h2>Create or clone a voice</h2></div>
          <div className="stack" style={{ gap: 4 }}>
            <Link href="/voices/new" className="feature-row"><span className="fr-art"><Microphone size={26} weight="duotone" /></span><span><b>Clone your voice</b><span>Read a script for 20 seconds and use your voice right away.</span></span></Link>
            <Link href="/voices/professional" className="feature-row"><span className="fr-art"><Brain size={26} weight="duotone" /></span><span><b>Train your voice model</b><span>Add recordings over time for the most natural read.</span></span></Link>
            <Link href="/voices/revoice" className="feature-row"><span className="fr-art"><ArrowsClockwise size={26} weight="duotone" /></span><span><b>Re-voice a take</b><span>Turn a rough phone recording into your clean voice.</span></span></Link>
            <Link href="/clean-up" className="feature-row"><span className="fr-art"><MagicWand size={26} weight="duotone" /></span><span><b>Clean up a recording</b><span>Noise and room echo out, mastered for the platform.</span></span></Link>
          </div>
        </section>
      </div>
    </>
  );
}
