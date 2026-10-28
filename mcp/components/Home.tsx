"use client";
// Home: the studio at a glance. A greeting (the GPU lives in Settings), then how the channels are doing (the headline metrics
// as tiles over one chart, the last 28 days against the 28 before, the top posts lately, this week's rhythm against the
// goals and what's due next), then the tools as tiles, your latest takes and ways to make a voice. The channel numbers
// are Analytics' own report (useReport), so opening Analytics after Home is instant.
import { ArrowRight, ArrowsClockwise, Brain, CalendarBlank, ChartLineUp, ClosedCaptioning, ImageSquare, MagicWand, Microphone, Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, api, fmtS, type Job } from "./api";
import { CassetteArt, EngineArt, MicArt, VoiceGlyph } from "./art";
import { Query, useLive, useMe } from "./aw";
import { SampleButton } from "./Sample";
import { useStatus } from "./Shell";
import { Empty, Notice, PageHeader } from "./ui";
import { dueLabel } from "./PostDrawer";
import type { Post } from "@/lib/workspace";
import type { Item } from "@/lib/analytics";
import { RhythmRows, TopPosts, trendOf } from "./Analytics";
import { PostDrawer } from "./AnalyticsPlatform";
import { fmtUnit, TrendBoard } from "./anparts";
import { useReport } from "./useReport";

type Lib = {
  id: string; kind?: string; engine: string; voice: string; label?: string; created: number; match?: number | null;
  results: { duration: number; text?: string; audio?: string | null }[]; video?: { duration: number }; poster_url?: string | null; images?: { thumb_url?: string }[];
};
const seconds = (j: Lib) => j.video?.duration ?? j.results.reduce((a, r) => a + r.duration, 0);
const greeting = (h: number) => (h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Working late");

const TOOLS = [
  { href: "/voiceover", name: "Voiceover", art: <EngineArt engine="chatterbox" /> },
  { href: "/voices/new", name: "Clone your voice", art: <EngineArt engine="qwen" /> },
  { href: "/voices/professional", name: "Train your voice", art: <VoiceGlyph name="myvoice" size={72} /> },
  { href: "/clean-up", name: "Clean-up", art: <MicArt /> },
  { href: "/subtitles", name: "Subtitles", art: <EngineArt engine="whisper" /> },
  { href: "/images", name: "Images", art: <EngineArt engine="zimage" /> },
];

function UpNext() {
  const { rows, loading } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(200)]);
  const next = rows.filter((p) => p.status !== "posted" && p.due_at).sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!)).slice(0, 4);
  if (loading) return <div className="skel" style={{ height: 120 }} />;
  if (!next.length) return <Empty icon={<CalendarBlank size={22} />} title="Nothing scheduled" action={<Link href="/posts?new=1" className="btn sm">New post</Link>}>Give a post a date and it shows up here.</Empty>;
  return (
    <div className="rows">
      {next.map((p) => {
        const late = Date.parse(p.due_at!) < Date.now();
        return (
          <Link key={p.$id} href={`/posts?post=${p.$id}`} className="list-row">
            <span className="thumb"><CalendarBlank size={18} /></span>
            <div style={{ minWidth: 0 }}><div className="t1">{p.title}</div><div className="t2">{p.assignee_name ?? p.owner_name ?? "Nobody yet"}</div></div>
            <span className={`pill ${late ? "bad" : ""}`}>{late ? "Overdue" : dueLabel(p.due_at)}</span>
          </Link>
        );
      })}
    </div>
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
        <section className="card an-card" aria-labelledby="home-week-h">
          <div className="card-head"><div><h2 id="home-week-h">This week</h2><p className="sub">Posted against your weekly goals, and what&apos;s booked</p></div><Link href="/posts?view=calendar" className="btn ghost xs">Calendar</Link></div>
          <RhythmRows data={data} />
          {workspace && <><h3 className="an-h3">Up next</h3><UpNext /></>}
        </section>
      </div>
      {open && <PostDrawer item={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

export default function Home() {
  const { status: st } = useStatus();
  const me = useMe();
  const [lib, setLib] = useState<Lib[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [hello, setHello] = useState("Welcome back");
  useEffect(() => { setHello(greeting(new Date().getHours())); api<{ jobs: Lib[] }>("library").then((l) => setLib(l.jobs)).catch(() => setLib([])); }, []);
  useEffect(() => {
    if (!st?.online) return;
    const load = () => api<{ jobs: Job[] }>("jobs").then((j) => setJobs(j.jobs)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [st?.online]);

  const first = me?.user?.name?.split(" ")[0];
  const active = jobs.filter((j) => ["queued", "running"].includes(j.status));
  const workspace = !!(me?.user && me.session && me.workspace);

  return (
    <>
      <PageHeader eyebrow="Your studio" title={`${hello}${first ? `, ${first}` : ""}`}
        sub={active.length ? `${active.length} job${active.length > 1 ? "s" : ""} running on the GPU.` : "Your channels, this week's plan and what you made lately."} />

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
