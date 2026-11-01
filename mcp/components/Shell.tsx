"use client";
// The studio's frame (dark only): a sidebar (studio switcher, the Create / Grow switch, search, the pages, a GPU card, you),
// a top bar with the page name and the GPU's state, the ⌘K command palette, and on phones a bottom tab bar plus the
// sidebar as a drawer. Create is the studio (voices, audio, images, files); Grow is analytics (everything under
// /analytics), with its own pages, its own tabs on phones and the rivals you pinned. The switch remembers where you were.
import { ChatCircleDots,
  ArrowsClockwise, Broadcast, CalendarDots, Crosshair, SidebarSimple, CaretDown, ChartLineUp, Rows, SquaresFour, Trophy, UsersThree, CaretUpDown, ClosedCaptioning, Cpu, DotsThreeOutline, Fire, GearSix, House, ImageSquare, Kanban, List,
  CloudArrowDown, FileAudio, FileText, FilmStrip, Folder, Folders, MagicWand, MagnifyingGlass, Microphone, Paperclip, PenNib, Plus, Power, SignOut, Star, UserSound, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, type Status } from "./api";
import { PixelAvatar } from "./pixel";
import { useCursor, useLook } from "./look";
import { PlatformBadge } from "./platform";
import { Logo } from "./art";
import { signOut, useMe } from "./aw";
import { DialogProvider, useDialog } from "./Dialog";
import JobTray from "./JobTray";
import { PopMenu } from "./ui";
import { initials } from "@/lib/workspace";
import { watching } from "./watching";

const StatusCtx = createContext<{ status: Status | null; refresh: () => Promise<void> }>({ status: null, refresh: async () => {} });
export const useStatus = () => useContext(StatusCtx);

type Nav = { href: string; name: string; Icon: typeof House; mv: string; sec: "main" | "create" | "studio"; match?: string[] };
export const NAV: Nav[] = [
  { href: "/home", name: "Home", Icon: House, mv: "home", sec: "main" },
  { href: "/voices", name: "Voices", Icon: UserSound, mv: "voices", sec: "main" },
  { href: "/posts", name: "Posts", Icon: Kanban, mv: "posts", sec: "main" },
  { href: "/auto-dm", name: "Auto-DM", Icon: ChatCircleDots, mv: "posts", sec: "main" },
  { href: "/analytics", name: "Analytics", Icon: ChartLineUp, mv: "chart", sec: "main" },
  { href: "/files", name: "Files", Icon: Folders, mv: "files", sec: "main" },
  { href: "/writing", name: "Writing room", Icon: PenNib, mv: "pen", sec: "create" },
  { href: "/analytics/radar", name: "Radar", Icon: Crosshair, mv: "radar", sec: "create" },
  { href: "/voiceover", name: "Voiceover", Icon: Microphone, mv: "mic", sec: "create" },
  { href: "/clean-up", name: "Clean-up", Icon: MagicWand, mv: "wand", sec: "create" },
  { href: "/subtitles", name: "Subtitles", Icon: ClosedCaptioning, mv: "cc", sec: "create" },
  { href: "/images", name: "Images", Icon: ImageSquare, mv: "image", sec: "create" },
  { href: "/download", name: "Download", Icon: CloudArrowDown, mv: "files", sec: "create" },
  { href: "/settings?tab=gpu", name: "GPU & engines", Icon: Cpu, mv: "chip", sec: "studio" },
  { href: "/settings", name: "Settings", Icon: GearSix, mv: "gear", sec: "studio" },
];
const TABS = ["/home", "/voiceover", "/posts", "/voices"];

/** Grow mode's pages (all under /analytics; the Analytics shell renders them). */
export const GROW: { href: string; name: string; Icon: typeof House; mv?: string; net?: "youtube" | "instagram" }[] = [
  { href: "/analytics", name: "Overview", Icon: SquaresFour, mv: "grid" },
  { href: "/analytics/radar", name: "Radar", Icon: Crosshair, mv: "radar" },
  { href: "/analytics/live", name: "Live", Icon: Broadcast },
  { href: "/analytics/content", name: "Content", Icon: Rows, mv: "rows" },
  { href: "/analytics/audience", name: "Audience", Icon: UsersThree, mv: "users" },
  { href: "/analytics/when-to-post", name: "When to post", Icon: CalendarDots, mv: "calendar" },
  { href: "/analytics/competitors", name: "Competitors", Icon: Trophy, mv: "trophy" },
  { href: "/analytics/youtube", name: "YouTube", Icon: ChartLineUp, net: "youtube" },
  { href: "/analytics/instagram", name: "Instagram", Icon: ChartLineUp, net: "instagram" },
];
const GROW_TABS = ["/analytics", "/analytics/radar", "/analytics/live", "/analytics/competitors"];
const isGrow = (path: string) => path === "/analytics" || path.startsWith("/analytics/");
const growOn = (path: string, href: string) => (href === "/analytics" ? path === href : path === href || path.startsWith(`${href}/`));
const LAST = { create: "vb-last-create", grow: "vb-last-grow" };

/** Create or Grow: one switch at the top of the sidebar (and in the top bar on phones). Each side goes back to the page
 *  you were last on there. */
function ModeSwitch({ grow, compact }: { grow: boolean; compact?: boolean }) {
  const last = (k: keyof typeof LAST, fallback: string) => { try { return localStorage.getItem(LAST[k]) || fallback; } catch { return fallback; } };
  const [hrefs, setHrefs] = useState({ create: "/home", grow: "/analytics" });
  useEffect(() => setHrefs({ create: last("create", "/home"), grow: last("grow", "/analytics") }), [grow]);
  return (
    <nav className={`mode-sw ${compact ? "compact" : ""}`} aria-label="Mode">
      <Link href={hrefs.create} className={grow ? "" : "on"} aria-current={grow ? undefined : "page"} title="Create: voices, audio, images, files"><MagicWand size={15} weight="duotone" className="mv" data-move="wand" aria-hidden /><span className="nl">Create</span></Link>
      <Link href={hrefs.grow} className={grow ? "on" : ""} aria-current={grow ? "page" : undefined} title="Grow: analytics, live numbers, rivals"><ChartLineUp size={15} weight="duotone" className="mv" data-move="chart" aria-hidden /><span className="nl">Grow</span></Link>
    </nav>
  );
}

type Pin = { key: string; name: string; avatar: string | null; href: string; net: "youtube" | "instagram" };
/** Grow's sidebar: rivals you pinned on Competitors, each opening its own report. */
function PinnedRivals({ path }: { path: string }) {
  const [pins, setPins] = useState<Pin[]>([]);
  useEffect(() => {
    try { setPins(JSON.parse(localStorage.getItem("vb-pins") ?? "[]")); } catch {}
    const load = () => api<{ pins: Pin[] }>("live/pins").then((r) => { setPins(r.pins); try { localStorage.setItem("vb-pins", JSON.stringify(r.pins)); } catch {} }).catch(() => null);
    load();
    addEventListener("vb-rivals-changed", load);
    return () => removeEventListener("vb-rivals-changed", load);
  }, []);
  if (!pins.length) return null;
  return (
    <>
      <div className="navsec">Pinned rivals</div>
      {pins.map((p) => (
        <Link key={p.key} href={p.href} className={`navlink pin-link ${path === p.href ? "on" : ""}`} aria-current={path === p.href ? "page" : undefined} title={p.name}>
          <span className="pin-av">{p.avatar ? <img src={p.avatar} alt="" loading="lazy" /> : initials(p.name)}</span><span className="ellipsis nl">{p.name}</span>
        </Link>
      ))}
    </>
  );
}
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
function Palette({ open, onClose, cmds }: { open: boolean; onClose: () => void; cmds: Cmd[] }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const lid = useId();
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? cmds.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(t)) : cmds;
  }, [q, cmds]);
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
          <input ref={input} value={q} placeholder="Go to a page, warm an engine…" onChange={(e) => setQ(e.target.value)}
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

function Frame({ children, status }: { children: React.ReactNode; status: Status | null }) {
  const path = usePathname();
  const router = useRouter();
  const { toast } = useDialog();
  const { refresh } = useStatus();
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const me = useMe();
  const look = useLook();
  useCursor();
  const here = pageOf(path);
  const grow = isGrow(path);
  const growHere = grow ? [...GROW].reverse().find((g) => growOn(path, g.href)) ?? (path.startsWith("/analytics/competitors") ? GROW.find((g) => g.href === "/analytics/competitors")! : GROW[0]) : null;
  useEffect(() => { try { localStorage.setItem(grow ? LAST.grow : LAST.create, path); } catch {} }, [grow, path]);
  const on = (href: string) => path === href || path.startsWith(`${href}/`);
  const busy = !!(status?.running?.length || status?.queue);
  useEffect(() => setDrawer(false), [path]);
  // the sidebar folds to an icon rail (the button at the top left, or ⌘B / Ctrl+B); remembered in this browser
  const [mini, setMini] = useState(false);
  useEffect(() => { try { setMini(localStorage.getItem("vb-side-mini") === "1"); } catch {} }, []);
  const fold = useCallback(() => setMini((m) => { try { localStorage.setItem("vb-side-mini", m ? "0" : "1"); } catch {} return !m; }), []);

  const cmds = useMemo<Cmd[]>(() => {
    const engine = (name: string, action: "load" | "unload") => async () => {
      try { await api(`engines/${name}/${action}`, { body: {} }); toast(`${action === "load" ? "Warming up" : "Unloading"} ${name}`, "info"); refresh(); }
      catch (e) { toast((e as Error).message, "bad"); }
    };
    return [
      ...NAV.filter((n) => n.href !== "/analytics").map((n) => ({ id: `go-${n.href}`, label: n.name, group: "Pages", Icon: n.Icon as typeof Fire, run: () => router.push(n.href) })),
      ...GROW.map((n) => ({ id: `grow-${n.href}`, label: n.name, group: "Grow", Icon: n.Icon as typeof Fire, run: () => router.push(n.href) })),
      { id: "new-post", label: "New post", group: "Create", Icon: Plus, run: () => router.push("/posts?new=1") },
      { id: "new-vo", label: "New voiceover", group: "Create", Icon: Microphone, run: () => router.push("/voiceover") },
      ...ALL_ENGINES.map((n) => ({ id: `warm-${n}`, label: `Warm up ${n}`, group: "Engines", Icon: Fire, run: engine(n, "load") })),
      ...ALL_ENGINES.map((n) => ({ id: `unload-${n}`, label: `Unload ${n}`, group: "Engines", Icon: Power, run: engine(n, "unload") })),
      { id: "refresh", label: "Refresh GPU status", group: "System", Icon: ArrowsClockwise, run: () => refresh() },
      { id: "signout", label: "Sign out", group: "System", Icon: SignOut, run: leave },
    ];
  }, [router, toast, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      const t = e.target as HTMLElement | null;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && !t?.closest("input, textarea, [contenteditable=true]")) { e.preventDefault(); fold(); return; }
      // page shortcuts need Alt, so typing or dictating a digit never navigates (WCAG 2.1.4)
      if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
        const n = NAV[Number(e.code.slice(5)) - 1];
        if (n) { e.preventDefault(); router.push(n.href); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, fold]);

  const section = (sec: Nav["sec"]) => NAV.filter((n) => n.sec === sec && n.href !== "/analytics").map(({ href, name, Icon, mv }) => (
    <Link key={href} href={href} className={`navlink ${on(href) ? "on" : ""}`} aria-current={on(href) ? "page" : undefined} title={mini ? name : undefined}>
      <Icon size={18} weight="duotone" className="ic mv" data-move={mv} /><span className="nl">{name}</span>
    </Link>
  ));

  return (
    <div className={`app ${mini ? "mini" : ""}`}>
      <a href="#main" className="skip">Skip to content</a>
      {drawer && <div className="side-scrim" onClick={() => setDrawer(false)} />}
      <aside className={`side ${drawer ? "open" : ""}`} aria-label="Sidebar">
        <Link href={grow ? "/analytics" : "/home"} className="brand" aria-label="Voicebox Studio">
          <Logo size={26} />
          <span className="brand-n nl"><b>Voicebox</b><span>Studio</span></span>
        </Link>
        <ModeSwitch grow={grow} />
        {grow ? (
          <nav className="side-nav" aria-label="Grow pages">
            {GROW.map(({ href, name, Icon, mv, net }) => { const on = growOn(path, href); return (
              <Link key={href} href={href} className={`navlink ${on ? "on" : ""}`} aria-current={on ? "page" : undefined} title={mini ? name : undefined}>
                {net ? <span className="ic nav-pb"><PlatformBadge net={net} size={16} /></span> : href === "/analytics/live" ? <span className="ic nav-live" aria-hidden><i /></span> : <Icon size={18} weight="duotone" className="ic mv" data-move={mv} />}<span className="nl">{name}</span>
              </Link>
            ); })}
            <PinnedRivals path={path} />
          </nav>
        ) : (
          <nav className="side-nav" aria-label="Pages">
            {section("main")}
            <div className="navsec nl">Create</div>
            {section("create")}
            <Favourites />
          </nav>
        )}
        <PopMenu align="left" up width={230} trigger={({ toggle, ref, open }) => (
          <button ref={ref} className="me-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
            <PixelAvatar name={me?.user?.email ?? me?.user?.name ?? "access token"} char={look.avatar} size={30} />
            <span className="me-name nl"><b className="ellipsis">{me?.user?.name ?? (me ? "Access token" : " ")}</b><span className="ellipsis">{me?.user?.email ?? (me ? "Studio only, no shared workspace" : " ")}</span></span>
            <CaretUpDown size={14} className="dim nl" />
          </button>
        )}>
          {(close) => (
            <>
              <Link className="pm-item" role="menuitem" href="/settings?tab=profile" onClick={close}><UserSound size={16} className="ic" />Profile</Link>
              <Link className="pm-item" role="menuitem" href="/settings" onClick={close}><GearSix size={16} className="ic" />Settings</Link>
              <hr />
              <button className="pm-item" role="menuitem" onClick={leave}><SignOut size={16} className="ic" />Sign out</button>
            </>
          )}
        </PopMenu>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer}><List size={20} className="mv" data-move="menu" /></button>
          <button type="button" className="side-tg" onClick={fold} aria-pressed={mini} aria-label={mini ? "Expand the sidebar" : "Collapse the sidebar"}>
            <SidebarSimple size={18} weight="duotone" className="mv" data-move="side" aria-hidden />
            <span className="side-tg-tip" aria-hidden>{mini ? "Expand" : "Collapse"} sidebar <kbd>⌘B</kbd></span>
          </button>
          <div className="crumb">{growHere ? <><span className="hide-sm">Grow<span aria-hidden> /</span></span><b>{growHere.name}</b></> : <>{here && here.sec !== "main" && <span className="hide-sm">{here.sec === "create" ? "Create" : "Studio"}<span aria-hidden> /</span></span>}<b>{here?.name ?? "Voicebox"}</b></>}</div>
          <ModeSwitch grow={grow} compact />
          <div className="top-actions">
            <button type="button" className="top-search" onClick={() => setPalette(true)} aria-label="Search pages, rivals and commands (⌘K)">
              <MagnifyingGlass size={16} className="mv" data-move="search" aria-hidden /><span className="ts-t">Search pages, rivals, engines…</span><kbd className="ts-k">⌘K</kbd>
            </button>
            <Link href="/settings" className={`top-set ${path.startsWith("/settings") ? "on" : ""}`} aria-label={`Settings. GPU ${status?.online ? (busy ? "busy" : "on") : "off"}`}
              title={`Settings · GPU ${!status ? "connecting" : status.online ? (busy ? `working, ${status.queue ?? 0} queued` : "on") : "off"}`}>
              <span className="ts-ic"><GearSix size={17} weight="duotone" className="mv" data-move="gear" aria-hidden /><i className={`ts-dot ${status?.online ? (busy ? "warn" : "ok") : "off"}`} aria-hidden /></span><span className="ts-t">Settings</span>
            </Link>
            {!grow && <PopMenu width={220} trigger={({ toggle, ref, open }) => (
              <button ref={ref} className="sm" onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label="Create"><Plus size={15} weight="bold" className="mv" data-move="plus" /><span className="hide-sm">Create</span><CaretDown size={12} className="hide-sm" /></button>
            )}>
              {(close) => (
                <>
                  <Link className="pm-item" role="menuitem" href="/voiceover" onClick={close}><Microphone size={16} className="ic" />Voiceover</Link>
                  <Link className="pm-item" role="menuitem" href="/posts?new=1" onClick={close}><Kanban size={16} className="ic" />Post</Link>
                  <Link className="pm-item" role="menuitem" href="/writing" onClick={close}><PenNib size={16} className="ic" />Hook, titles, captions</Link>
                  <Link className="pm-item" role="menuitem" href="/images" onClick={close}><ImageSquare size={16} className="ic" />Image</Link>
                  <Link className="pm-item" role="menuitem" href="/subtitles" onClick={close}><ClosedCaptioning size={16} className="ic" />Subtitles</Link>
                  <Link className="pm-item" role="menuitem" href="/clean-up" onClick={close}><MagicWand size={16} className="ic" />Clean-up</Link>
                  <Link className="pm-item" role="menuitem" href="/download" onClick={close}><CloudArrowDown size={16} className="ic" />Download from a link</Link>
                </>
              )}
            </PopMenu>}
          </div>
        </header>
        <main id="main" className="main-inner" tabIndex={-1}>{children}</main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {grow ? GROW_TABS.map((href) => { const n = GROW.find((x) => x.href === href)!, o = growOn(path, href); return (
          <Link key={href} href={href} className={o ? "on" : ""} aria-current={o ? "page" : undefined}><n.Icon size={22} weight="duotone" className="mv" data-move={n.mv} /><span>{n.name}</span></Link>
        ); }) : TABS.map((href) => { const n = NAV.find((x) => x.href === href)!; return (
          <Link key={href} href={href} className={on(href) ? "on" : ""} aria-current={on(href) ? "page" : undefined}><n.Icon size={22} weight="duotone" className="mv" data-move={n.mv} /><span>{n.name}</span></Link>
        ); })}
        <button onClick={() => setDrawer(true)} aria-label="More pages"><DotsThreeOutline size={22} className="mv" data-move="more" /><span>More</span></button>
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
    // a hidden tab doesn't poll (every call counts against the hosting quota); coming back refreshes at once
    const t = setInterval(() => { if (watching()) refresh(); }, 15_000);
    const back = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", back); };
  }, [refresh]);

  return (
    <StatusCtx.Provider value={{ status, refresh }}>
      <DialogProvider>
        <Frame status={status}>{children}</Frame>
      </DialogProvider>
    </StatusCtx.Provider>
  );
}
