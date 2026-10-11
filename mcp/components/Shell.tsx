"use client";
import {
  ArrowsClockwise, Books, ClosedCaptioning, Cpu, FilmSlate, Fire, HardDrives, MagnifyingGlass, Microphone, Power, SignOut, SquaresFour, UserSound, Waveform,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, type Status } from "./api";
import { LedMeter, Logo } from "./art";
import { DialogProvider, useDialog } from "./Dialog";

const StatusCtx = createContext<{ status: Status | null; refresh: () => Promise<void> }>({ status: null, refresh: async () => {} });
export const useStatus = () => useContext(StatusCtx);

const NAV = [
  { href: "/", name: "Overview", Icon: SquaresFour },
  { href: "/generate", name: "Generate", Icon: Microphone },
  { href: "/voices", name: "Voices", Icon: UserSound },
  { href: "/video", name: "Video", Icon: FilmSlate },
  { href: "/subtitles", name: "Subtitles", Icon: ClosedCaptioning },
  { href: "/library", name: "Library", Icon: Books },
] as const;
const ENGINE_ORDER = ["orpheus", "chatterbox", "kokoro", "qwen", "whisper", "wan", "ltx"];
const ALL_ENGINES = ["orpheus", "chatterbox", "kokoro", "qwen", "whisper", "wan", "ltx"];
const MODE: Record<string, string> = { voice: "Voice mode", visual: "Video mode", idle: "Idle · GPU free", mixed: "Switching" };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const stateClass = (s?: string) => (s === "ready" ? "ready" : s === "loading" || s === "installing" || s === "busy" ? "busy" : s === "error" ? "err" : "");

export function fmtUptime(s?: number) {
  if (!s) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

type Cmd = { id: string; label: string; group: string; Icon: typeof Fire; run: () => void | Promise<void> };

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
  let lastGroup = "";
  return (
    <>
      <div className="scrim-modal" onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="pin">
          <MagnifyingGlass size={18} />
          <input ref={input} value={q} placeholder="Jump to a page, warm an engine…" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
              if (e.key === "Enter") { e.preventDefault(); pick(list[i]); }
              if (e.key === "Escape") onClose();
            }} />
          <kbd>esc</kbd>
        </div>
        <ul>
          {list.map((c, k) => {
            const head = c.group !== lastGroup ? <li key={`g-${c.group}`} className="grp">{c.group}</li> : null;
            lastGroup = c.group;
            return [head, (
              <li key={c.id} className={`item ${k === i ? "on" : ""}`} onMouseEnter={() => setI(k)} onClick={() => pick(c)}>
                <c.Icon size={18} weight="duotone" className="ic" />{c.label}
              </li>
            )];
          })}
          {!list.length && <li className="item dim">Nothing matches “{q}”</li>}
        </ul>
        <div className="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span></div>
      </div>
    </>
  );
}

function Frame({ children, status }: { children: React.ReactNode; status: Status | null }) {
  const path = usePathname();
  const router = useRouter();
  const { toast } = useDialog();
  const { refresh } = useStatus();
  const [palette, setPalette] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const busy = !!(status?.running?.length || status?.queue);
  const here = NAV.find((n) => n.href === path) ?? NAV[0];
  const vram = status?.gpu?.total_gb ? status.gpu.used_gb / status.gpu.total_gb : 0;

  const cmds = useMemo<Cmd[]>(() => {
    const engine = (name: string, action: "load" | "unload") => async () => {
      try { await api(`engines/${name}/${action}`, { body: {} }); toast(`${action === "load" ? "Warming up" : "Unloading"} ${name}`, "info"); refresh(); }
      catch (e) { toast((e as Error).message, "bad"); }
    };
    return [
      ...NAV.map((n) => ({ id: `go-${n.href}`, label: n.name, group: "Go to", Icon: n.Icon as typeof Fire, run: () => router.push(n.href) })),
      ...ALL_ENGINES.map((n) => ({ id: `warm-${n}`, label: `Warm up ${n}`, group: "Engines", Icon: Fire, run: engine(n, "load") })),
      ...ALL_ENGINES.map((n) => ({ id: `unload-${n}`, label: `Unload ${n}`, group: "Engines", Icon: Power, run: engine(n, "unload") })),
      { id: "refresh", label: "Refresh worker status", group: "System", Icon: ArrowsClockwise, run: () => refresh() },
      { id: "signout", label: "Sign out", group: "System", Icon: SignOut, run: async () => { await fetch("/api/login", { method: "DELETE" }); location.href = "/login"; } },
    ];
  }, [router, toast, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable]")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) router.push(NAV[n - 1].href);
    };
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll); };
  }, [router]);

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><Logo /><span className="word">voice<em>box</em></span><span className="ver">v{status?.version ?? "2"}</span></div>
        <div className="navsec">Studio</div>
        {NAV.map(({ href, name, Icon }, k) => (
          <Link key={href} href={href} className={`navlink ${path === href ? "on" : ""}`}>
            <Icon size={19} weight={path === href ? "duotone" : "regular"} className="ic" />
            {name}<kbd>{k + 1}</kbd>
          </Link>
        ))}
        <div className="grow" />
        <div className="rack">
          <div className="title">
            <span className={`dot ${status?.online ? (busy ? "warn" : "ok") : status ? "bad" : "off"}`} />
            {status ? (status.online ? (busy ? "Rendering" : "GPU online") : "GPU offline") : "Connecting"}
            <Cpu size={15} className="dim" style={{ marginLeft: "auto" }} />
          </div>
          {status?.online ? (
            <>
              <div className="meta">{status.gpu?.name?.replace("NVIDIA ", "")} · up {fmtUptime(status.uptime_s)}</div>
              <div style={{ margin: "12px 0 4px" }}><LedMeter value={vram} segments={18} label="GPU memory" /></div>
              <div className="eng" style={{ marginBottom: 6 }}><span>VRAM</span><b style={{ color: "var(--ink2)" }}>{status.gpu?.used_gb} / {status.gpu?.total_gb} GB</b></div>
              {status.mode && <div className={`mode-chip ${status.mode}`}>{status.mode === "visual" ? <FilmSlate size={13} weight="fill" /> : <Waveform size={13} weight="bold" />}{MODE[status.mode] ?? status.mode}</div>}
              {ENGINE_ORDER.filter((n) => status.engines?.[n] && (status.engines[n] !== "idle" || n === "kokoro" || n === "orpheus")).map((n) => {
                const left = status.idle_unload_s?.[n];
                return (
                  <div key={n} className="eng" title={left != null ? `unloads after ${status.idle_min ?? 10} idle minutes` : undefined}>
                    <span className={`dot ${status.engines![n] === "ready" ? "ok" : stateClass(status.engines![n]) === "busy" ? "warn" : "off"}`} style={{ width: 6, height: 6, boxShadow: "none", animation: "none" }} />{n}
                    <b className={stateClass(status.engines![n])}>{left != null && left < 600 ? `idle ${mmss(left)}` : status.engines![n]}</b>
                  </div>
                );
              })}
              {(status.ram?.total_gb || status.disk?.total_gb) ? (
                <div className="res">
                  {status.ram?.total_gb ? <div className="eng"><span>RAM</span><b style={{ color: "var(--ink2)" }}>{status.ram.used_gb} / {status.ram.total_gb} GB</b></div> : null}
                  {status.disk?.total_gb ? <div className="eng" title={Object.entries(status.disk.weights_gb).map(([k, v]) => `${k} ${v} GB`).join(" · ") || "no weights downloaded"}><span><HardDrives size={11} /> Disk free</span><b style={{ color: status.disk.free_gb < 25 ? "var(--warn)" : "var(--ink2)" }}>{Math.round(status.disk.free_gb)} GB</b></div> : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="meta" style={{ lineHeight: 1.6 }}>{status?.reason === "heartbeat stale" ? "The Colab runtime stopped. Run the notebook to bring it back." : "Waiting for the Colab worker to check in."}</div>
          )}
        </div>
        <button className="quiet sm" style={{ marginTop: 8, justifyContent: "flex-start" }} onClick={async () => { await fetch("/api/login", { method: "DELETE" }); location.href = "/login"; }}>
          <SignOut size={16} /> Sign out
        </button>
      </aside>
      <main className="main">
        <div className={`topbar ${scrolled ? "scrolled" : ""}`}>
          <div className="crumb"><Waveform size={16} />Studio<span className="faint">/</span><b>{here.name}</b></div>
          <span className="status-pill">
            <span className={`dot ${status?.online ? (busy ? "warn" : "ok") : "bad"}`} />
            {status?.online ? (busy ? `Working · ${status.queue ?? 0} queued` : `${status.gpu?.name?.replace("NVIDIA ", "")} ready`) : "Worker offline"}
          </span>
          <button className="search" onClick={() => setPalette(true)}><MagnifyingGlass size={15} /><span>Search or run a command</span><kbd>⌘K</kbd></button>
        </div>
        {children}
      </main>
      <Palette open={palette} onClose={() => setPalette(false)} cmds={cmds} />
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = useCallback(async () => {
    setStatus(await api<Status>("status").catch(() => ({ online: false, reason: "dashboard API unreachable" }) as Status));
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <StatusCtx.Provider value={{ status, refresh }}>
      <DialogProvider>
        <Frame status={status}>{children}</Frame>
      </DialogProvider>
    </StatusCtx.Provider>
  );
}
