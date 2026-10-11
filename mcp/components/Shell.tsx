"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, type Status } from "./api";

const StatusCtx = createContext<{ status: Status | null; refresh: () => Promise<void> }>({ status: null, refresh: async () => {} });
export const useStatus = () => useContext(StatusCtx);

const I = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  cc: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M10.5 10.2a2.5 2.5 0 1 0 0 3.6M17 10.2a2.5 2.5 0 1 0 0 3.6" /></>,
  lib: <><path d="M4 4h4v16H4zM10 4h4v16h-4z" /><path d="m16.5 4.6 3.8-1 3.7 15.5-3.8.9z" transform="translate(-2 1)" /></>,
};
const NAV = [["/", "Overview", I.home], ["/generate", "Generate", I.mic], ["/subtitles", "Subtitles", I.cc], ["/library", "Library", I.lib]] as const;

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = useCallback(async () => {
    setStatus(await api<Status>("status").catch(() => ({ online: false, reason: "dashboard API unreachable" })));
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);
  const busy = status?.running?.length || status?.queue;

  return (
    <StatusCtx.Provider value={{ status, refresh }}>
      <div className="app">
        <aside className="side">
          <div className="brand"><span className="wave"><i /><i /><i /><i /></span>voice<b>box</b></div>
          {NAV.map(([href, name, icon]) => (
            <Link key={href} href={href} className={`navlink ${path === href ? "on" : ""}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
              {name}
            </Link>
          ))}
          <div className="grow" />
          <div className="workerchip">
            <div className="row" style={{ gap: 8 }}>
              <span className={`dot ${status?.online ? (busy ? "warn" : "ok") : "bad"}`} />
              <b>{status ? (status.online ? (busy ? "Working" : "GPU online") : "GPU offline") : "Connecting…"}</b>
            </div>
            <div className="dim tiny" style={{ marginTop: 4 }}>
              {status?.online ? `${status.gpu?.name?.replace("NVIDIA ", "")} · ${status.gpu?.used_gb}/${status.gpu?.total_gb} GB` : status?.reason === "heartbeat stale" ? "Start the Colab notebook" : "Waiting for the Colab worker"}
            </div>
          </div>
          <button className="ghost sm" style={{ marginTop: 8 }} onClick={async () => { await fetch("/api/login", { method: "DELETE" }); location.href = "/login"; }}>Sign out</button>
        </aside>
        <main className="main">{children}</main>
      </div>
    </StatusCtx.Provider>
  );
}
