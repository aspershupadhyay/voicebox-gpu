"use client";
// The studio's frame (dark only): a sidebar (studio switcher, search, the pages, a GPU card, you), a top bar with the page
// name and the GPU's state, the ⌘K command palette, and on phones a bottom tab bar plus the sidebar as a drawer.
import {
  ArrowsClockwise, CaretDown, CaretUpDown, ClosedCaptioning, Cpu, DotsThreeOutline, Fire, GearSix, House, ImageSquare, Kanban, List,
  FileAudio, FileText, FilmStrip, Folder, Folders, MagicWand, MagnifyingGlass, Microphone, Paperclip, Plus, Power, SignOut, Sparkle, Star, UserSound, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, type Status } from "./api";
import { AskButton, AskProvider, useAsk } from "./Ask";
import { Logo } from "./art";
import { signOut, useMe } from "./aw";
import { DialogProvider, useDialog } from "./Dialog";
import JobTray from "./JobTray";
import { PopMenu } from "./ui";
import { initials } from "@/lib/workspace";

const StatusCtx = createContext<{ status: Status | null; refresh: () => Promise<void> }>({ status: null, refresh: async () => {} });
export const useStatus = () => useContext(StatusCtx);

type Nav = { href: string; name: string; Icon: typeof House; sec: "main" | "create" | "studio"; match?: string[] };
export const NAV: Nav[] = [
  { href: "/", name: "Home", Icon: House, sec: "main" },
  { href: "/voices", name: "Voices", Icon: UserSound, sec: "main" },
  { href: "/posts", name: "Posts", Icon: Kanban, sec: "main" },
  { href: "/files", name: "Files", Icon: Folders, sec: "main" },
  { href: "/voiceover", name: "Voiceover", Icon: Microphone, sec: "create" },
  { href: "/clean-up", name: "Clean-up", Icon: MagicWand, sec: "create" },
  { href: "/subtitles", name: "Subtitles", Icon: ClosedCaptioning, sec: "create" },
  { href: "/images", name: "Images", Icon: ImageSquare, sec: "create" },
  { href: "/gpu", name: "GPU & engines", Icon: Cpu, sec: "studio" },
  { href: "/settings", name: "Settings", Icon: GearSix, sec: "studio" },
];
const TABS = ["/", "/voiceover", "/posts", "/voices"];
const ALL_ENGINES = ["orpheus", "myvoice", "chatterbox", "kokoro", "qwen", "whisper", "enhance", "zimage", "qwenimage"];

type Fav = { key: string; name: string; kind: string; color: string | null; thumb: string | null; href: string };
const FAV_ICON: Record<string, typeof Folder> = { video: FilmStrip, image: ImageSquare, audio: FileAudio, doc: FileText, other: Paperclip, folder: Folder };

/** Starred files and folders (Files page), like Drive's: a thumbnail, the name and the star. Kept in this browser too,
 *  so the sidebar shows them at once. */
function Favourites() {
  const [items, setItems] = useState<Fav[]>([]);
  useEffect(() => {
    try { setItems(JSON.parse(localStorage.getItem("vb-favs") ?? "[]")); } catch {}
    const load = () => api<{ items: Fav[] }>("files/favourites").then((r) => { setItems(r.items); try { localStorage.setItem("vb-favs", JSON.stringify(r.items)); } catch {} }).catch(() => null);
    load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const soon = () => { clearTimeout(t); t = setTimeout(load, 700); };
    addEventListener("vb-files-changed", soon);
    return () => { clearTimeout(t); removeEventListener("vb-files-changed", soon); };
  }, []);
  if (!items.length) return null;
  return (
    <>
      <div className="navsec">Favourites</div>
      <div className="side-favs">
        {items.map((f) => {
          const Ic = FAV_ICON[f.kind] ?? Paperclip;
          return (
            <Link key={f.key} href={f.href} className="fav-link" title={f.name}>
              <span className={`fav-th ${f.kind === "folder" ? `fold-th c-${f.color}` : ""}`}>{f.thumb ? <img src={f.thumb} alt="" loading="lazy" /> : <Ic size={14} weight="duotone" />}</span>
              <span className="ellipsis">{f.name}</span>
              <Star size={13} weight="fill" className="fm-star" aria-label="Starred" />
            </Link>
          );
        })}
      </div>
    </>
  );
}

async function leave() { await signOut(); location.href = "/login"; }
export const pageOf = (path: string) => NAV.find((n) => (n.href === "/" ? path === "/" : path === n.href || path.startsWith(`${n.href}/`)));

export function fmtUptime(s?: number) {
  if (!s) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

type Cmd = { id: string; label: string; group: string; Icon: typeof Fire; run: () => void | Promise<void> };

/** ⌘K: an ARIA combobox over a listbox. Arrow keys move, Enter runs, Escape closes and hands focus back. */
function Palette({ open, onClose, cmds, onAsk }: { open: boolean; onClose: () => void; cmds: Cmd[]; onAsk: (q: string) => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const lid = useId();
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return cmds;
    // anything typed can go to the assistant: first when nothing else matches, else last
    const ask: Cmd = { id: "ask-q", label: `Ask Voicebox: “${q.trim()}”`, group: "Ask", Icon: Sparkle as typeof Fire, run: () => onAsk(q.trim()) };
    const hits = cmds.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(t));
    return hits.length ? [...hits, ask] : [ask];
  }, [q, cmds, onAsk]);
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement;
    setQ(""); setI(0);
    setTimeout(() => input.current?.focus(), 0);
    return () => { back.current?.focus?.(); };
  }, [open]);
  useEffect(() => setI(0), [q]);
  useEffect(() => { document.getElementById(`${lid}-${i}`)?.scrollIntoView({ block: "nearest" }); }, [i, lid]);
  if (!open) return null;
  const pick = (c?: Cmd) => { if (c) { onClose(); c.run(); } };
  let lastGroup = "";
  return (
    <>
      <div className="scrim-modal" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands"
        onKeyDown={(e) => { if (e.key === "Tab") e.preventDefault(); /* focus stays in the box */ }}>
        <div className="pin">
          <MagnifyingGlass size={18} aria-hidden />
          <input ref={input} value={q} placeholder="Go to a page, or ask Voicebox to do something…" onChange={(e) => setQ(e.target.value)}
            role="combobox" aria-expanded="true" aria-controls={`${lid}-list`} aria-autocomplete="list"
            aria-activedescendant={list[i] ? `${lid}-${i}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
              if (e.key === "Enter") { e.preventDefault(); pick(list[i]); }
              if (e.key === "Escape") onClose();
            }} />
          <button className="icon-btn sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <ul role="listbox" id={`${lid}-list`} aria-label="Results">
          {list.map((c, k) => {
            const head = c.group !== lastGroup ? <li key={`g-${c.group}`} className="grp" role="presentation">{c.group}</li> : null;
            lastGroup = c.group;
            return [head, (
              <li key={c.id} id={`${lid}-${k}`} role="option" aria-selected={k === i} onMouseMove={() => setI(k)} onClick={() => pick(c)}>
                <c.Icon size={18} className="ic" aria-hidden />{c.label}
              </li>
            )];
          })}
          {!list.length && <li className="none" role="presentation">Nothing matches “{q}”</li>}
        </ul>
        <div className="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Alt</kbd> + <kbd>1</kbd>–<kbd>9</kbd> jump to a page</span></div>
      </div>
    </>
  );
}

/** The GPU in the sidebar: on or off at a glance, how full its memory is, and the one action that matters. */
function GpuCard({ status }: { status: Status | null }) {
  const busy = !!(status?.running?.length || status?.queue);
  const vram = status?.gpu?.total_gb ? status.gpu.used_gb / status.gpu.total_gb : 0;
  const ready = Object.values(status?.engines ?? {}).filter((x) => x === "ready").length;
  return (
    <div className="side-card">
      <div className="sc-head">
        <span className="sc-ic"><span className={`onair ${status?.online ? "live" : ""}`} aria-hidden><i style={{ height: "55%" }} /><i style={{ height: "90%" }} /><i style={{ height: "40%" }} /><i style={{ height: "75%" }} /><i style={{ height: "50%" }} /></span></span>
        <div style={{ minWidth: 0 }}>
          <b>{!status ? "Connecting…" : status.online ? (busy ? "GPU busy" : "GPU on") : "GPU off"}</b>
          <p className="ellipsis">{status?.online ? `${status.gpu?.name?.replace("NVIDIA ", "") ?? "GPU"} · ${ready} engine${ready === 1 ? "" : "s"} warm` : "Voice work needs the GPU."}</p>
        </div>
      </div>
      {status?.online && <div className="gm-bar" role="meter" aria-label="GPU memory" aria-valuenow={Math.round(vram * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(vram * 100)}%` }} /></div>}
      <Link href="/gpu" className="btn ghost sm block">{status?.online ? "Open GPU & engines" : <><Power size={14} weight="bold" /> Start the GPU</>}</Link>
    </div>
  );
}

function Frame({ children, status }: { children: React.ReactNode; status: Status | null }) {
  const path = usePathname();
  const router = useRouter();
  const { toast } = useDialog();
  const { refresh } = useStatus();
  const ask = useAsk();
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const me = useMe();
  const here = pageOf(path);
  const on = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  const busy = !!(status?.running?.length || status?.queue);
  useEffect(() => setDrawer(false), [path]);

  const cmds = useMemo<Cmd[]>(() => {
    const engine = (name: string, action: "load" | "unload") => async () => {
      try { await api(`engines/${name}/${action}`, { body: {} }); toast(`${action === "load" ? "Warming up" : "Unloading"} ${name}`, "info"); refresh(); }
      catch (e) { toast((e as Error).message, "bad"); }
    };
    return [
      { id: "ask", label: "Ask Voicebox", group: "Ask", Icon: Sparkle as typeof Fire, run: () => ask.open() },
      ...NAV.map((n) => ({ id: `go-${n.href}`, label: n.name, group: "Pages", Icon: n.Icon as typeof Fire, run: () => router.push(n.href) })),
      { id: "new-post", label: "New post", group: "Create", Icon: Plus, run: () => router.push("/posts?new=1") },
      { id: "new-vo", label: "New voiceover", group: "Create", Icon: Microphone, run: () => router.push("/voiceover") },
      ...ALL_ENGINES.map((n) => ({ id: `warm-${n}`, label: `Warm up ${n}`, group: "Engines", Icon: Fire, run: engine(n, "load") })),
      ...ALL_ENGINES.map((n) => ({ id: `unload-${n}`, label: `Unload ${n}`, group: "Engines", Icon: Power, run: engine(n, "unload") })),
      { id: "refresh", label: "Refresh GPU status", group: "System", Icon: ArrowsClockwise, run: () => refresh() },
      { id: "signout", label: "Sign out", group: "System", Icon: SignOut, run: leave },
    ];
  }, [router, toast, refresh, ask]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      // page shortcuts need Alt, so typing or dictating a digit never navigates (WCAG 2.1.4)
      if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
        const n = NAV[Number(e.code.slice(5)) - 1];
        if (n) { e.preventDefault(); router.push(n.href); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const section = (sec: Nav["sec"]) => NAV.filter((n) => n.sec === sec).map(({ href, name, Icon }) => (
    <Link key={href} href={href} className={`navlink ${on(href) ? "on" : ""}`} aria-current={on(href) ? "page" : undefined}>
      <Icon size={18} weight={on(href) ? "duotone" : "regular"} className="ic" />{name}
    </Link>
  ));

  return (
    <div className="app">
      <a href="#main" className="skip">Skip to content</a>
      {drawer && <div className="side-scrim" onClick={() => setDrawer(false)} />}
      <aside className={`side ${drawer ? "open" : ""}`} aria-label="Sidebar">
        <PopMenu align="left" width={230} trigger={({ toggle, ref, open }) => (
          <button ref={ref} className="ws-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
            <Logo size={28} />
            <span className="ws-name"><b>Voicebox Studio</b><span>Shared studio</span></span>
            <CaretUpDown size={14} className="dim" />
          </button>
        )}>
          {(close) => (
            <>
              <Link className="pm-item" role="menuitem" href="/settings" onClick={close}><GearSix size={16} className="ic" />Settings</Link>
              <Link className="pm-item" role="menuitem" href="/gpu" onClick={close}><Cpu size={16} className="ic" />GPU &amp; engines</Link>
              <hr />
              <button className="pm-item" role="menuitem" onClick={leave}><SignOut size={16} className="ic" />Sign out</button>
            </>
          )}
        </PopMenu>
        <button className="side-search" onClick={() => setPalette(true)}><MagnifyingGlass size={16} />Search<kbd>⌘K</kbd></button>
        <nav className="side-nav" aria-label="Pages">
          {section("main")}
          <div className="navsec">Create</div>
          {section("create")}
          <Favourites />
        </nav>
        <GpuCard status={status} />
        <div className="side-foot">{section("studio")}</div>
        <PopMenu align="left" up width={230} trigger={({ toggle, ref, open }) => (
          <button ref={ref} className="me-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
            <span className="avatar">{initials(me?.user?.name ?? (me ? "T" : ""))}</span>
            <span className="me-name"><b className="ellipsis">{me?.user?.name ?? (me ? "Access token" : " ")}</b><span className="ellipsis">{me?.user?.email ?? (me ? "Studio only, no shared workspace" : " ")}</span></span>
            <CaretUpDown size={14} className="dim" />
          </button>
        )}>
          {(close) => (
            <>
              <Link className="pm-item" role="menuitem" href="/settings" onClick={close}><GearSix size={16} className="ic" />Settings</Link>
              <hr />
              <button className="pm-item" role="menuitem" onClick={leave}><SignOut size={16} className="ic" />Sign out</button>
            </>
          )}
        </PopMenu>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer}><List size={20} /></button>
          <div className="crumb">{here && here.sec !== "main" && <span className="hide-sm">{here.sec === "create" ? "Create" : "Studio"}<span aria-hidden> /</span></span>}<b>{here?.name ?? "Voicebox"}</b></div>
          <div className="top-actions">
            <AskButton />
            <Link href="/gpu" className="status-pill" title="GPU & engines">
              <span className={`dot ${status?.online ? (busy ? "warn" : "ok") : status ? "bad" : "off"}`} />
              {!status ? "Connecting" : status.online ? (busy ? `Working · ${status.queue ?? 0} queued` : `${status.gpu?.name?.replace("NVIDIA ", "") ?? "GPU"} ready`) : "GPU off"}
            </Link>
            <PopMenu width={220} trigger={({ toggle, ref, open }) => (
              <button ref={ref} className="sm" onClick={toggle} aria-expanded={open} aria-haspopup="menu"><Plus size={15} weight="bold" /><span className="hide-sm">Create</span><CaretDown size={12} className="hide-sm" /></button>
            )}>
              {(close) => (
                <>
                  <Link className="pm-item" role="menuitem" href="/voiceover" onClick={close}><Microphone size={16} className="ic" />Voiceover</Link>
                  <Link className="pm-item" role="menuitem" href="/posts?new=1" onClick={close}><Kanban size={16} className="ic" />Post</Link>
                  <Link className="pm-item" role="menuitem" href="/images" onClick={close}><ImageSquare size={16} className="ic" />Image</Link>
                  <Link className="pm-item" role="menuitem" href="/subtitles" onClick={close}><ClosedCaptioning size={16} className="ic" />Subtitles</Link>
                  <Link className="pm-item" role="menuitem" href="/clean-up" onClick={close}><MagicWand size={16} className="ic" />Clean-up</Link>
                </>
              )}
            </PopMenu>
          </div>
        </header>
        <main id="main" className="main-inner" tabIndex={-1}>{children}</main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {TABS.map((href) => { const n = NAV.find((x) => x.href === href)!; return (
          <Link key={href} href={href} className={on(href) ? "on" : ""} aria-current={on(href) ? "page" : undefined}><n.Icon size={22} weight={on(href) ? "duotone" : "regular"} /><span>{n.name}</span></Link>
        ); })}
        <button onClick={() => setDrawer(true)} aria-label="More pages"><DotsThreeOutline size={22} /><span>More</span></button>
      </nav>
      <Palette open={palette} onClose={() => setPalette(false)} cmds={cmds} onAsk={ask.open} />
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
        <AskProvider>
          <Frame status={status}>{children}</Frame>
        </AskProvider>
      </DialogProvider>
    </StatusCtx.Provider>
  );
}
