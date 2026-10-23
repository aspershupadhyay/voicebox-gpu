"use client";
import {
  ArrowsClockwise, Books, CalendarBlank, ClosedCaptioning, Cpu, DotsThreeOutline, Fire, GearSix, ImageSquare, Kanban, MagicWand, MagnifyingGlass,
  Microphone, Moon, Power, Brain, SignOut, SquaresFour, Stack, Sun, UserSound, Images,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, type Status } from "./api";
import { Logo } from "./art";
import { signOut, useMe } from "./aw";
import { DialogProvider, useDialog } from "./Dialog";
import JobTray from "./JobTray";
import { initials } from "@/lib/workspace";

const StatusCtx = createContext<{ status: Status | null; refresh: () => Promise<void> }>({ status: null, refresh: async () => {} });
export const useStatus = () => useContext(StatusCtx);

const NAV = [
  { href: "/content", name: "Content", Icon: Stack, sec: "Workspace" },
  { href: "/workspace", name: "Board", Icon: Kanban, sec: "Workspace" },
  { href: "/calendar", name: "Calendar", Icon: CalendarBlank, sec: "Workspace" },
  { href: "/media", name: "Media", Icon: Images, sec: "Workspace" },
  { href: "/generate", name: "Voiceover", Icon: Microphone, sec: "Create" },
  { href: "/voices", name: "Voices", Icon: UserSound, sec: "Create" },
  { href: "/model", name: "Your model", Icon: Brain, sec: "Create" },
  { href: "/studio", name: "Clean-up", Icon: MagicWand, sec: "Create" },
  { href: "/subtitles", name: "Subtitles", Icon: ClosedCaptioning, sec: "Create" },
  { href: "/image", name: "Images", Icon: ImageSquare, sec: "Create" },
  { href: "/library", name: "Library", Icon: Books, sec: "Studio" },
  { href: "/", name: "Engines", Icon: SquaresFour, sec: "Studio" },
  { href: "/settings", name: "Settings", Icon: GearSix, sec: "Studio" },
] as const;
const TABS = ["/content", "/workspace", "/calendar", "/generate"];

function useTheme() {
  const [t, setT] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    const cur = document.documentElement.dataset.theme as "light" | "dark" | undefined;
    setT(cur ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }, []);
  const flip = () => {
    const next = t === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("vb-theme", next); } catch {}
    setT(next);
  };
  return { theme: t, flip };
}

async function leave() { await signOut(); location.href = "/login"; }
const ALL_ENGINES = ["orpheus", "myvoice", "chatterbox", "kokoro", "qwen", "whisper", "enhance", "zimage", "qwenimage"];
const MODE: Record<string, string> = { voice: "Voice mode", visual: "Image mode", idle: "Idle · GPU free", mixed: "Switching" };

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
  const here = NAV.find((n) => (n.href === "/" ? path === "/" : path.startsWith(n.href))) ?? NAV[0];
  const vram = status?.gpu?.total_gb ? status.gpu.used_gb / status.gpu.total_gb : 0;
  const me = useMe();
  const { theme, flip } = useTheme();
  const on = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

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
      { id: "theme", label: "Switch light / dark", group: "System", Icon: Moon, run: flip },
      { id: "signout", label: "Sign out", group: "System", Icon: SignOut, run: leave },
    ];
  }, [router, toast, refresh, flip]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable]")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9) router.push(NAV[n - 1].href);
    };
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll); };
  }, [router]);

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><Logo size={24} /><span className="word">voicebox</span></div>
        <nav className="side-nav" aria-label="Pages">
          {NAV.map(({ href, name, Icon, sec }, k) => (
            <div key={href} style={{ display: "contents" }}>
              {(k === 0 || NAV[k - 1].sec !== sec) && <div className="navsec">{sec}</div>}
              <Link href={href} className={`navlink ${on(href) ? "on" : ""}`}>
                <Icon size={18} weight={on(href) ? "fill" : "regular"} className="ic" />
                {name}{k < 9 && <kbd>{k + 1}</kbd>}
              </Link>
            </div>
          ))}
        </nav>
        {/* the GPU at a glance; every engine, RAM and disk are on the Engines page */}
        <Link href="/" className="gpu-mini" title={status?.online ? `${status.gpu?.used_gb} / ${status.gpu?.total_gb} GB VRAM · up ${fmtUptime(status.uptime_s)}` : "Open Engines"}>
          <span className={`dot ${status?.online ? (busy ? "warn" : "ok") : status ? "bad" : "off"}`} />
          <span className="gm-text">
            <b>{status ? (status.online ? (busy ? "Rendering" : "GPU online") : "GPU offline") : "Connecting"}</b>
            <span className="tiny faint">{status?.online
              ? `${status.gpu?.name?.replace("NVIDIA ", "") ?? ""}${status.mode ? ` · ${MODE[status.mode] ?? status.mode}` : ""} · ${Object.values(status.engines ?? {}).filter((x) => x === "ready").length} ready`
              : status?.reason === "heartbeat stale" ? "Run the Colab notebook" : "Waiting for the worker"}</span>
          </span>
          {status?.online ? <span className="gm-bar" aria-label="GPU memory"><i style={{ width: `${Math.round(vram * 100)}%` }} /></span> : <Cpu size={15} className="dim" />}
        </Link>
        <div className="me-row">
          <span className="avatar">{initials(me?.user?.name)}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="small" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me?.user?.name ?? (me ? "Token session" : " ")}</div>
            <div className="tiny faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me?.user?.email ?? (me ? "no shared workspace" : " ")}</div>
          </div>
          <button className="icon-btn" title={theme === "dark" ? "Light mode" : "Dark mode"} onClick={flip}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
          <button className="icon-btn" title="Sign out" onClick={leave}><SignOut size={16} /></button>
        </div>
      </aside>
      <main className="main">
        <div className={`topbar ${scrolled ? "scrolled" : ""}`}>
          <div className="crumb">{here.sec}<span className="faint">/</span><b>{here.name}</b></div>
          <span className="status-pill">
            <span className={`dot ${status?.online ? (busy ? "warn" : "ok") : "bad"}`} />
            {status?.online ? (busy ? `Working · ${status.queue ?? 0} queued` : `${status.gpu?.name?.replace("NVIDIA ", "")} ready`) : "Worker offline"}
          </span>
          <button className="search" onClick={() => setPalette(true)}><MagnifyingGlass size={15} /><span>Search or run a command</span><kbd>⌘K</kbd></button>
        </div>
        {children}
      </main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((href) => { const n = NAV.find((x) => x.href === href)!; return (
          <Link key={href} href={href} className={on(href) ? "on" : ""}><n.Icon size={22} weight={on(href) ? "fill" : "regular"} /><span>{n.name}</span></Link>
        ); })}
        <button onClick={() => setPalette(true)}><DotsThreeOutline size={22} /><span>More</span></button>
      </nav>
      <Palette open={palette} onClose={() => setPalette(false)} cmds={cmds} />
      <JobTray />
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
