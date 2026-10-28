"use client";
// Grow's frame, shared by its pages (app/(app)/analytics/layout.tsx): the header with one top bar on every page (the
// range, what it's compared with, the live chip, Export and Refresh), the strips for what a connection can't read yet,
// and on phones the pages as tabs (on wider screens the sidebar lists them). The report is loaded once here (useReport)
// and handed to the views through useAn(), so moving between them is instant. Live, Competitors and a rival's page run
// on the minute-by-minute numbers instead (useLive) and don't wait for the report.
import { ArrowsClockwise, ArrowSquareOut, ChartLineUp, DownloadSimple, FileCsv, LinkSimple, Plus, Printer, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import type { Range } from "@/lib/analytics";
import { day } from "./anparts";
import { ago } from "./api";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { LiveChip } from "./Grow";
import { Empty, Notice, PageHeader, PopMenu } from "./ui";
import { useLive } from "./useLive";
import { RANGE_KEY, savedRange, useReport, type Report } from "./useReport";

const Ctx = createContext<Report | null>(null);
/** The report, inside an Analytics view (the shell only renders a view once it has one). */
export const useAn = () => useContext(Ctx)!;

export const VIEWS = [
  { href: "/analytics", name: "Overview", sub: "How your YouTube and Instagram are doing, and what to post next to grow." },
  { href: "/analytics/live", name: "Live", sub: "Every post under 72 hours old, yours and your rivals', checked every minute.", live: true },
  { href: "/analytics/content", name: "Content", sub: "What works: every post against your usual, and what the hits have in common." },
  { href: "/analytics/audience", name: "Audience", sub: "Who's watching, where they come from and how fast you're growing." },
  { href: "/analytics/when-to-post", name: "When to post", sub: "The days and times your posts do best, and your rhythm." },
  { href: "/analytics/competitors", name: "Competitors", sub: "You against the channels you're chasing, and what's working for them right now.", live: true },
  { href: "/analytics/youtube", name: "YouTube", net: "youtube" as const, sub: "Your YouTube in depth: reach, watch time, audience and every video." },
  { href: "/analytics/instagram", name: "Instagram", net: "instagram" as const, sub: "Your Instagram in depth: reach, engagement, audience and every post." },
];

/** Every post in the report as a CSV file (Export in the top bar). */
function csvOf(d: Report) {
  const cols = ["network", "format", "published", "title", "url", "views", "reach", "likes", "comments", "shares", "saves", "engagement_rate", "score_vs_usual", "watch_minutes", "avg_pct_viewed", "subscribers"];
  const q = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = d.items.map((i) => [i.network, i.fmt, new Date(i.at).toISOString(), i.title, i.url, i.views, i.reach, i.likes, i.comments, i.shares, i.saves, i.er == null ? null : Math.round(i.er * 10000) / 100, i.score, i.watch_min, i.avg_pct, i.subs].map(q).join(","));
  return [cols.join(","), ...rows].join("\n");
}
function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const before = (from: string, range: number) => { const s = Date.parse(`${from}T12:00:00Z`); return [new Date(s - range * 864e5).toISOString().slice(0, 10), new Date(s - 864e5).toISOString().slice(0, 10)]; };

export default function AnalyticsShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const view = [...VIEWS].reverse().find((v) => (v.href === "/analytics" ? path === v.href : path.startsWith(v.href))) ?? VIEWS[0];
  return view.live ? <LiveShell view={view}>{children}</LiveShell> : <ReportShell view={view}>{children}</ReportShell>;
}

function Tabs({ path, tail }: { path: string; tail?: React.ReactNode }) {
  return (
    <nav className="tabs an-nav" aria-label="Grow pages">
      {VIEWS.map((v) => {
        const on = v.href === "/analytics" ? path === v.href : path.startsWith(v.href);
        return (
          <Link key={v.href} href={v.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
            {v.net && <PlatformBadge net={v.net} size={16} />}{v.name}
          </Link>
        );
      })}
      {tail}
    </nav>
  );
}

/** Live, Competitors and a rival's page: the minute-by-minute numbers, no report to wait on. */
/** Which platform the page shows: Overview is every platform, the YouTube and Instagram pages one each. Picking one
 *  goes to its page. */
function PlatformChip({ path }: { path: string }) {
  const router = useRouter();
  const v = path.startsWith("/analytics/youtube") ? "youtube" : path.startsWith("/analytics/instagram") ? "instagram" : "all";
  return <Select className="fx-chip-sel" size="sm" label="Platform" value={v} onChange={(n) => router.push(n === "all" ? "/analytics" : `/analytics/${n}`)}
    options={[["all", "All platforms"], ["youtube", "YouTube"], ["instagram", "Instagram"]]} />;
}

function LiveShell({ view, children }: { view: (typeof VIEWS)[number]; children: React.ReactNode }) {
  const path = usePathname();
  const { data, paused } = useLive();
  return (
    <>
      <PageHeader className="fx-head" title={view.name} actions={<LiveChip at={data?.at} paused={paused} />} />
      <Tabs path={path} />
      <div key={path} className="an-wrap an-view">{children}</div>
    </>
  );
}

function ReportShell({ view, children }: { view: (typeof VIEWS)[number]; children: React.ReactNode }) {
  const path = usePathname();
  const { data: live, paused } = useLive(60_000);
  const [range, setRange] = useState<Range>(28);
  useEffect(() => { setRange(savedRange()); }, []);
  const { data, err, busy, reload } = useReport(range);
  const pickRange = (r: Range) => { setRange(r); try { localStorage.setItem(RANGE_KEY, String(r)); } catch {} };

  return (
    <>
      <PageHeader className="fx-head" title={view.name}
        actions={<>
          <Select className="fx-chip-sel" size="sm" label="Range" value={range} onChange={pickRange} options={[[7, "Last 7 days"], [28, "Last 28 days"], [90, "Last 90 days"]]} />
          {data && <span className="fx-chip hide-sm" title="Every change on these pages compares with the same number of days just before">Compare to · {day(before(data.from, data.range)[0])} – {day(before(data.from, data.range)[1])}</span>}
          <PlatformChip path={path} />
          <LiveChip at={live?.at} paused={paused} href="/analytics/live" />
          <PopMenu width={230} trigger={({ toggle, ref, open }) => (
            <button ref={ref} type="button" className="fx-export" onClick={toggle} aria-expanded={open} aria-haspopup="menu" disabled={!data}><DownloadSimple size={14} weight="bold" />Export</button>
          )}>
            {(close) => (
              <>
                <button className="pm-item" role="menuitem" onClick={() => { close(); if (data) download(`voicebox-posts-${data.from}-to-${data.to}.csv`, csvOf(data)); }}><FileCsv size={16} className="ic" />Every post as CSV</button>
                <button className="pm-item" role="menuitem" onClick={() => { close(); setTimeout(() => print(), 50); }}><Printer size={16} className="ic" />This page as PDF</button>
              </>
            )}
          </PopMenu>
          <button type="button" className="fx-icon" onClick={() => reload(true)} disabled={busy} aria-label="Refresh from YouTube and Instagram" title="Refresh from YouTube and Instagram"><ArrowsClockwise size={15} className={busy ? "spin" : ""} /></button>
        </>} />
      {err && <Notice icon={<Warning size={18} />} tone="bad" action={<button className="ghost sm" onClick={() => reload()}>Try again</button>}>Couldn&apos;t load analytics: {err}</Notice>}
      {data?.needs.map((n, i) => (
        <Notice key={i} icon={<Warning size={18} />} tone="warn" action={n.action === "reconnect" ? <a className="btn ghost sm" href={`/api/publish/${n.network}/connect`}><LinkSimple size={14} />Reconnect</a>
          : n.action === "enable" ? <a className="btn ghost sm" href="https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com" target="_blank" rel="noreferrer">Open Google Cloud <ArrowSquareOut size={13} /></a> : undefined}>{n.text}</Notice>
      ))}
      <Tabs path={path} />
      {data && <p className="tiny dim an-upd-line" aria-live="polite">{day(data.from)} – {day(data.to)} · {data.stale || busy ? <span className="an-updating">Updating…</span> : `updated ${ago(data.at)}`}</p>}
      {!data && !err ? (
        <div className="an-wrap" aria-busy="true" aria-label="Loading analytics">
          <div className="skel" style={{ height: 92 }} />
          <div className="skel" style={{ height: 360 }} />
          <div className="an-duo"><div className="skel" style={{ height: 240 }} /><div className="skel" style={{ height: 240 }} /></div>
        </div>
      ) : data && !data.accounts.length ? (
        <Empty icon={<ChartLineUp size={22} />} title="Connect a channel to see analytics" action={<Link href="/posts?view=autopilot" className="btn sm"><Plus size={14} />Connect YouTube or Instagram</Link>}>
          Analytics reads the YouTube channels and Instagram accounts connected in Posts → Autopilot.
        </Empty>
      ) : data && (
        <Ctx.Provider value={data}>
          <div key={path} className={`an-wrap an-view ${busy ? "busy" : ""}`}>{children}</div>
        </Ctx.Provider>
      )}
    </>
  );
}
