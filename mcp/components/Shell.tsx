"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, type Status } from "./api";
import { DialogProvider, useDialog } from "./Dialog";

const StatusCtx = createContext<{ status: Status | null; refresh: () => Promise<void> }>({ status: null, refresh: async () => {} });
export const useStatus = () => useContext(StatusCtx);

const I = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  cc: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M10.5 10.2a2.5 2.5 0 1 0 0 3.6M17 10.2a2.5 2.5 0 1 0 0 3.6" /></>,
  lib: <><path d="M4 4h4v16H4zM10 4h4v16h-4z" /><path d="m16.5 4.6 3.8-1 3.7 15.5-3.8.9z" transform="translate(-2 1)" /></>,
};
const NAV = [["/", "Overview", I.home, "overview"], ["/generate", "Generate", I.mic, "generate"], ["/subtitles", "Subtitles", I.cc, "subtitles"], ["/library", "Library", I.lib, "library"]] as const;
const ENGINE_STATE: Record<string, string> = { ready: "on", loading: "busy", installing: "busy", busy: "busy", error: "err" };

function fmtUptime(s?: number) {
  if (!s) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

type Cmd = { id: string; label: string; group: string; run: () => void | Promise<void> };

function Palette({ open, onClose, cmds }: { open: boolean; onClose: () => void; cmds: Cmd[] }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? cmds.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(t)) : cmds;
  }, [q, cmds]);
  useEffect(() => { if (open) { setQ(""); setI(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => setI(0), [q]);
  if (!open) return null;
  const pick = (c?: Cmd) => { if (c) { onClose(); c.run(); } };
  return (
    <>
      <div className="scrim-modal" onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Command palette">
        <input ref={input} value={q} placeholder="Type a command or page…" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
            if (e.key === "Enter") { e.preventDefault(); pick(list[i]); }
            if (e.key === "Escape") onClose();
          }} />
        <ul>
          {list.map((c, k) => (
            <li key={c.id} className={k === i ? "on" : ""} onMouseEnter={() => setI(k)} onClick={() => pick(c)}>
              {c.label}<span className="g">{c.group}</span>
            </li>
          ))}
          {!list.length && <li className="dim">No matches</li>}
        </ul>
        <div className="foot"><span>↑↓ move</span><span>↵ run</span><span>esc close</span></div>
      </div>
    </>
  );
}

function Frame({ children, status, latency }: { children: React.ReactNode; status: Status | null; latency: number | null }) {
  const path = usePathname();
  const router = useRouter();
  const { toast } = useDialog();
  const { refresh } = useStatus();
  const [palette, setPalette] = useState(false);
  const busy = status?.running?.length || status?.queue;
  const here = NAV.find(([href]) => href === path)?.[3] ?? path.slice(1);
  const vram = status?.gpu?.total_gb ? Math.round((status.gpu.used_gb / status.gpu.total_gb) * 100) : 0;

  const cmds = useMemo<Cmd[]>(() => {
    const engine = (name: string, action: "load" | "unload") => async () => {
      try { await api(`engines/${name}/${action}`, { body: {} }); toast(`${action === "load" ? "Warming" : "Unloading"} ${name}…`, "info"); refresh(); }
      catch (e) { toast((e as Error).message, "bad"); }
    };
    return [
      ...NAV.map(([href, name]) => ({ id: `go-${href}`, label: `Go to ${name}`, group: "navigate", run: () => router.push(href) })),
      ...["orpheus", "whisper", "chatterbox", "kokoro"].map((n) => ({ id: `warm-${n}`, label: `Warm up ${n}`, group: "engine", run: engine(n, "load") })),
      ...["orpheus", "whisper", "chatterbox"].map((n) => ({ id: `unload-${n}`, label: `Unload ${n}`, group: "engine", run: engine(n, "unload") })),
      { id: "refresh", label: "Refresh worker status", group: "system", run: () => refresh() },
      { id: "signout", label: "Sign out", group: "system", run: async () => { await fetch("/api/login", { method: "DELETE" }); location.href = "/login"; } },
    ];
  }, [router, toast, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="wave"><i /><i /><i /><i /></span>voice<b>box</b><sup>v{status?.version ?? "2"}</sup></div>
        {NAV.map(([href, name, icon], k) => (
          <Link key={href} href={href} className={`navlink ${path === href ? "on" : ""}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
            {name}<kbd>0{k + 1}</kbd>
          </Link>
        ))}
        <div className="grow" />
        <div className="workerchip scan">
          <div className="row" style={{ gap: 8 }}>
            <span className={`dot ${status?.online ? (busy ? "warn" : "live") : "bad"}`} />
            <b style={{ color: "var(--ink)" }}>{status ? (status.online ? (busy ? "WORKING" : "GPU ONLINE") : "GPU OFFLINE") : "CONNECTING"}</b>
          </div>
          {status?.online ? (
            <>
              <div className="dim" style={{ marginTop: 4 }}>{status.gpu?.name?.replace("NVIDIA ", "")} · up {fmtUptime(status.uptime_s)}</div>
              <div className="vram" title={`VRAM ${status.gpu?.used_gb}/${status.gpu?.total_gb} GB`}><i style={{ width: `${vram}%` }} /></div>
              <div className="eng"><span>vram</span><b>{status.gpu?.used_gb}/{status.gpu?.total_gb} GB</b></div>
              {Object.entries(status.engines ?? {}).map(([n, st]) => (
                <div key={n} className="eng"><span>{n}</span><b className={ENGINE_STATE[st] ?? ""}>{st}</b></div>
              ))}
            </>
          ) : (
            <div className="dim" style={{ marginTop: 4 }}>{status?.reason === "heartbeat stale" ? "Start the Colab notebook" : "Waiting for the Colab worker"}</div>
          )}
        </div>
        <button className="ghost sm" style={{ marginTop: 8 }} onClick={async () => { await fetch("/api/login", { method: "DELETE" }); location.href = "/login"; }}>Sign out</button>
      </aside>
      <main className="main">
        <div className="topbar">
          <span className="path">~/voicebox/<b>{here}</b><span className="caret" /></span>
          <span className="stat"><span className={`dot ${status?.online ? "live" : "bad"}`} />worker <b>{status?.online ? "online" : "offline"}</b></span>
          {status?.online && <span className="stat">queue <b>{status.queue ?? 0}</b></span>}
          {latency != null && <span className="stat">rtt <b>{latency} ms</b></span>}
          <span className="k" onClick={() => setPalette(true)}>⌘K <span>commands</span></span>
        </div>
        {children}
      </main>
      <Palette open={palette} onClose={() => setPalette(false)} cmds={cmds} />
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    const t0 = performance.now();
    const s = await api<Status>("status").catch(() => ({ online: false, reason: "dashboard API unreachable" }) as Status);
    setLatency(Math.round(performance.now() - t0));
    setStatus(s);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <StatusCtx.Provider value={{ status, refresh }}>
      <DialogProvider>
        <Frame status={status} latency={latency}>{children}</Frame>
      </DialogProvider>
    </StatusCtx.Provider>
  );
}
