"use client";
// The Analytics page's frame, shared by its six views (app/(app)/analytics/layout.tsx): the header with the range and
// Refresh, the strips for what a connection can't read yet, and the views as tabs with their own addresses (Overview,
// Content, Audience, When to post, YouTube, Instagram). The report is loaded once here (useReport) and handed to the
// views through useAn(), so moving between them is instant.
import { ArrowsClockwise, ArrowSquareOut, ChartLineUp, LinkSimple, Plus, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import type { Range } from "@/lib/analytics";
import { day } from "./anparts";
import { ago } from "./api";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { Empty, Notice, PageHeader } from "./ui";
import { RANGE_KEY, savedRange, useReport, type Report } from "./useReport";

const Ctx = createContext<Report | null>(null);
/** The report, inside an Analytics view (the shell only renders a view once it has one). */
export const useAn = () => useContext(Ctx)!;

export const VIEWS = [
  { href: "/analytics", name: "Overview" },
  { href: "/analytics/content", name: "Content" },
  { href: "/analytics/audience", name: "Audience" },
  { href: "/analytics/when-to-post", name: "When to post" },
  { href: "/analytics/youtube", name: "YouTube", net: "youtube" as const },
  { href: "/analytics/instagram", name: "Instagram", net: "instagram" as const },
];

export default function AnalyticsShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [range, setRange] = useState<Range>(28);
  useEffect(() => { setRange(savedRange()); }, []);
  const { data, err, busy, reload } = useReport(range);
  const pickRange = (r: Range) => { setRange(r); try { localStorage.setItem(RANGE_KEY, String(r)); } catch {} };

  return (
    <>
      <PageHeader title="Analytics" sub="How your YouTube and Instagram are doing, and what to post next to grow."
        actions={<>
          <Select className="an-sel" label="Range" value={range} onChange={pickRange} options={[[7, "Last 7 days"], [28, "Last 28 days"], [90, "Last 90 days"]]} />
          <button type="button" className="ghost" onClick={() => reload(true)} disabled={busy} aria-label="Refresh from YouTube and Instagram"><ArrowsClockwise size={15} className={busy ? "spin" : ""} />Refresh</button>
        </>} />
      {err && <Notice icon={<Warning size={18} />} tone="bad" action={<button className="ghost sm" onClick={() => reload()}>Try again</button>}>Couldn&apos;t load analytics: {err}</Notice>}
      {data?.needs.map((n, i) => (
        <Notice key={i} icon={<Warning size={18} />} tone="warn" action={n.action === "reconnect" ? <a className="btn ghost sm" href={`/api/publish/${n.network}/connect`}><LinkSimple size={14} />Reconnect</a>
          : n.action === "enable" ? <a className="btn ghost sm" href="https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com" target="_blank" rel="noreferrer">Open Google Cloud <ArrowSquareOut size={13} /></a> : undefined}>{n.text}</Notice>
      ))}
      <nav className="tabs an-nav" aria-label="Analytics views">
        {VIEWS.map((v) => {
          const on = v.href === "/analytics" ? path === v.href : path.startsWith(v.href);
          return (
            <Link key={v.href} href={v.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
              {v.net && <PlatformBadge net={v.net} size={16} />}{v.name}
            </Link>
          );
        })}
        {data && <span className="tiny dim an-upd-tab" aria-live="polite">{day(data.from)} – {day(data.to)} · {data.stale || busy ? <span className="an-updating">Updating…</span> : `updated ${ago(data.at)}`}</span>}
      </nav>
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
