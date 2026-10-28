"use client";
// Carousels on the Files page (rules in lib/carouselrules.ts): a post's photos and clips as one stacked card instead
// of ten loose files. Opening one stands the photos up from the bottom of the screen, one after another, onto a curved
// row (the owner's reference: a concave fan of tall cards, each numbered #01, #02… with its name under it). Click a
// photo to open it full size; the viewer gets a strip of the carousel along the bottom. Keys on the stage: ← → browse,
// Enter opens, 1–9 open that photo, drag a card up (or Alt+← →) to move it, [ ] (or Shift+← →) jump to the previous
// or next post's carousel, P shows it on a phone as Instagram will, Esc closes. Slide checks (lib/carouselcheck.ts) flag
// shapes and sizes Instagram crops and look-alike duplicates; once it's posted, its Instagram numbers show here. State lives in components/Files.tsx; styles under "carousels" in app/globals.css.
import {
  ArrowSquareOut, BookmarkSimple, CaretLeft, CaretRight, Cards, ChatCircle, CheckCircle, DeviceMobile, DotsThree, DownloadSimple, FilmStrip, Heart, InstagramLogo,
  PaperPlaneTilt, PencilSimple, Play, StackMinus, Star, Warning, X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Group } from "@/lib/carouselrules";
import { anchorOf, ByMark, Hit, KindIcon, Name, when, type CardEvents, type Item } from "./fileparts";

export type Stack = { key: string; g: Group; members: Item[]; at: number; starred: boolean };
export const isStack = (e: Item | Stack): e is Stack => "g" in e;

const pad = (n: number) => String(n).padStart(2, "0");
/** "6 photos", "4 photos, 2 clips" */
export function countOf(members: Item[]) {
  const v = members.filter((m) => m.kind === "video").length, p = members.length - v;
  return [p && `${p} photo${p === 1 ? "" : "s"}`, v && `${v} clip${v === 1 ? "" : "s"}`].filter(Boolean).join(", ");
}

function Thumb({ it, eager }: { it: Item; eager?: boolean }) {
  return it.cover ? <img src={it.cover} alt="" loading={eager ? "eager" : "lazy"} decoding="async" draggable={false} />
    : <span className="cc-glyph"><KindIcon kind={it.kind} src={it.src} size={22} /></span>;
}

/** The card in the grid: the first photos fanned like a hand of cards (they spread on hover), and how many. */
export function CarouselCard({ s, stats, ...ev }: { s: Stack; stats?: Stats | null } & CardEvents) {
  const shown = s.members.slice(0, 5);
  const mid = (shown.length - 1) / 2;
  return (
    <div className={`fcard ccard ${ev.selected ? "sel" : ""} ${ev.dim ? "dim" : ""}`}
      draggable={!ev.renaming} onDragStart={ev.onDragStart} onDragEnd={ev.onDragEnd} onClick={ev.onOpen}
      onContextMenu={(e) => { e.preventDefault(); ev.onMenu({ x: e.clientX, y: e.clientY, w: 0, h: 0, align: "start" }); }}>
      <Hit label={`Open carousel ${s.g.name}, ${countOf(s.members)}`} />
      <div className="fc-cover cc-cover" aria-hidden>
        {shown.map((m, i) => (
          <span key={m.key} className="cc-leaf" style={{ "--o": i - mid, zIndex: 10 - Math.round(Math.abs(i - mid) * 2) } as React.CSSProperties}>
            <Thumb it={m} />
            {m.kind === "video" && <i className="cc-play"><Play size={9} weight="fill" /></i>}
          </span>
        ))}
        <span className="fc-badge cc-count"><Cards size={12} weight="bold" />{s.members.length}</span>
      </div>
      <input type="checkbox" className="selbox fc-check" checked={ev.selected} aria-label={`Select carousel ${s.g.name}`} onClick={(e) => { e.stopPropagation(); ev.onToggle(e.shiftKey); }} onChange={() => {}} />
      <div className="fc-body">
        <span className="fc-tab" aria-hidden />
        <button type="button" className="fc-more" aria-label={`More for carousel ${s.g.name}`} title="More" onClick={(e) => { e.stopPropagation(); ev.onMenu(anchorOf(e.currentTarget)); }}><DotsThree size={18} weight="bold" /></button>
        <div className="fc-meta">
          {s.starred && <Star size={12} weight="fill" className="fm-star" aria-label="Starred" />}
          <span>{when(s.members[s.members.length - 1])}</span><span className="dot" aria-hidden /><span className="ellipsis">Carousel · {countOf(s.members)}</span>
        </div>
        <Name value={s.g.name} renaming={ev.renaming} onRename={ev.onRename} className="fc-name" />
        <div className="fc-foot">
          <span className="row" style={{ gap: 8 }}><ByMark it={s.members[0]} /><span className="tiny dim mono">{s.g.post ? "On a post" : "Grouped"}</span></span>
          {stats?.live ? (
            <span className="cc-live" title={`On Instagram: ${short(stats.views)} views, ${short(stats.saves)} saves, ${short(stats.shares)} shares`}>
              <i className="cs-live-dot" /><BookmarkSimple size={12} weight="bold" />{short(stats.saves)}<PaperPlaneTilt size={12} weight="bold" />{short(stats.shares)}
            </span>
          ) : <span className="cc-dots" aria-hidden>{s.members.slice(0, 10).map((m) => <i key={m.key} />)}</span>}
        </div>
      </div>
    </div>
  );
}

/** The same as a list row. */
export function CarouselRow({ s, folderName, ...ev }: { s: Stack; folderName?: string } & CardEvents) {
  return (
    <div className={`frow ${ev.selected ? "sel" : ""} ${ev.dim ? "dim" : ""}`} draggable={!ev.renaming}
      onDragStart={ev.onDragStart} onDragEnd={ev.onDragEnd} onClick={ev.onOpen}
      onContextMenu={(e) => { e.preventDefault(); ev.onMenu({ x: e.clientX, y: e.clientY, w: 0, h: 0, align: "start" }); }}>
      <Hit label={`Open carousel ${s.g.name}`} />
      <input type="checkbox" className="selbox" checked={ev.selected} aria-label={`Select carousel ${s.g.name}`} onClick={(e) => { e.stopPropagation(); ev.onToggle(e.shiftKey); }} onChange={() => {}} />
      <span className="fr-thumb cc-rthumb">{s.members.slice(0, 2).reverse().map((m) => <span key={m.key}><Thumb it={m} /></span>)}</span>
      <span className="fr-name">
        <span className="row" style={{ gap: 6, flexWrap: "nowrap", minWidth: 0 }}>{s.starred && <Star size={12} weight="fill" className="fm-star" aria-label="Starred" />}<Name value={s.g.name} renaming={ev.renaming} onRename={ev.onRename} className="fr-title" /></span>
        {folderName && <span className="tiny dim ellipsis">in {folderName}</span>}
      </span>
      <span className="fr-col fr-type small dim">Carousel</span>
      <span className="fr-col fr-size small dim mono">{s.members.length} files</span>
      <span className="fr-col fr-by"><ByMark it={s.members[0]} /><span className="small dim ellipsis">{s.members[0].src === "generated" ? "GPU" : (s.members[0].by || "Someone").split(" ")[0]}</span></span>
      <span className="fr-col fr-at small dim">{when(s.members[s.members.length - 1])}</span>
      <button type="button" className="icon-btn sm" aria-label={`More for carousel ${s.g.name}`} title="More" onClick={(e) => { e.stopPropagation(); ev.onMenu(anchorOf(e.currentTarget)); }}><DotsThree size={18} weight="bold" /></button>
    </div>
  );
}

type Near = { name: string; go: () => void } | null;
export type SlideCheck = { file_id: string; position: number; w: number | null; h: number | null; issues: { level: "bad" | "warn"; text: string }[] };
export type Checks = { slides: SlideCheck[]; bad: number; warn: number; ok: number; notes: string[] };
export type Stats = { live: boolean; state?: string | null; url?: string; at?: number; views?: number | null; reach?: number | null; likes?: number | null;
  comments?: number | null; shares?: number | null; saves?: number | null; er?: number | null; notes?: string[]; error?: string };

export const short = (n?: number | null) => (n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

const GAP = 1.1; // card centres, in card widths

/** Card size and how many show either side, so the whole curve fits the stage (width and height). */
function geometry(w: number, h: number, n: number) {
  const phone = w < 640;
  const span = phone ? 1.3 : Math.max(1, Math.min(3.5, (n - 1) / 2 + 0.3));
  const edge = 1 + Math.pow(span, 1.6) * 0.17 * 0.9; // the outer cards come nearer and look bigger
  const byW = (w / 2 - 18) / (span * GAP + span * span * 0.025 + edge / 2);
  const byH = (h - 92) / (1.4 * edge);
  const pw = phone ? Math.max(120, Math.min(w * 0.56, byH, 260)) : Math.max(96, Math.min(byW, byH, 212));
  return { pw, span };
}

/** Where a card sits on the curve, `o` places from the one in focus: further out is nearer to you and turned in, like
 *  standing inside a ring of photos. */
function placeOf(o: number, pw: number, span: number) {
  const a = Math.abs(o), s = Math.sign(o);
  return { x: s * (a * pw * GAP + a * a * pw * 0.025), z: Math.pow(a, 1.6) * pw * 0.17, ry: -o * 12, op: Math.max(0, Math.min(1, span + 0.65 - a)) };
}
const moved = (n: number, from: number, to: number) => { const o = Array.from({ length: n }, (_, i) => i); o.splice(to, 0, o.splice(from, 1)[0]); return o; };

/** The opened carousel: the photos rise from the bottom onto a curved row. The row is placed straight on the DOM
 *  (no re-render while you drag), so it keeps up at 60 fps. Drag sideways to browse; lift a card (drag it up, or press
 *  and hold) and drop it elsewhere to reorder. */
export function CarouselStage({ s, onClose, onOpen, onPrev, onNext, onRename, onUngroup, onMove, onDownload, onPost, onStar, onInstagram, at, checks, stats, handle }: {
  s: Stack; onClose: () => void; onOpen: (i: number) => void; onPrev: Near; onNext: Near; at?: number;
  onRename?: (name: string) => void; onUngroup?: () => void; onMove?: (from: number, to: number) => void; onDownload: () => void; onPost?: () => void; onStar: () => void;
  onInstagram?: () => void; checks?: Checks | null; stats?: Stats | null; handle?: string | null;
}) {
  const n = s.members.length;
  const [focus, setFocus] = useState(() => Math.min(n - 1, Math.max(0, at ?? Math.floor((n - 1) / 2))));
  const [leaving, setLeaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [mode, setMode] = useState<"curve" | "phone">("curve");
  const [panel, setPanel] = useState<"checks" | "stats" | null>(null);
  const [size, setSize] = useState({ w: 1200, h: 600 });
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pos = useRef<(HTMLDivElement | null)[]>([]);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const view = useRef<{ cur: number; lift: { i: number; to: number; dx: number; dy: number } | null }>({ cur: focus, lift: null });
  const press = useRef<{ x: number; y: number; f: number; i: number | null; mode: "" | "scroll" | "lift"; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const quiet = useRef(false); // the click after a drag doesn't open the photo
  const raf = useRef(0);
  const wheel = useRef({ acc: 0, t: 0 });
  const { pw, span } = geometry(size.w, size.h, n);
  const issues = new Map((checks?.slides ?? []).map((c) => [c.file_id, c.issues]));

  useEffect(() => { setFocus((f) => Math.min(n - 1, Math.max(0, f))); }, [n]);
  useEffect(() => { if (at != null) setFocus(Math.min(n - 1, Math.max(0, at))); }, [at, n]);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [mode]);

  /** Put every card where it belongs right now (focus, a drag, a lifted card). */
  const apply = useCallback(() => {
    raf.current = 0;
    const { cur, lift } = view.current;
    const order = lift ? moved(n, lift.i, lift.to) : null;
    for (let i = 0; i < n; i++) {
      const el = pos.current[i], card = cards.current[i];
      if (!el || !card) continue;
      if (lift && i === lift.i) {
        const home = placeOf(i - cur, pw, span);
        el.style.transform = `translate3d(${home.x + lift.dx}px, ${lift.dy - 26}px, ${home.z + 90}px)`;
        el.style.opacity = "1";
        card.style.transform = "rotateY(0deg) scale(1.04)";
        continue;
      }
      const p = placeOf((order ? order.indexOf(i) : i) - cur, pw, span);
      el.style.transform = `translate3d(${p.x}px, 0, ${p.z}px)`;
      el.style.opacity = String(p.op);
      el.style.visibility = p.op < 0.02 ? "hidden" : "";
      card.style.transform = `rotateY(${p.ry}deg)`;
    }
  }, [n, pw, span]);
  const schedule = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(apply); }, [apply]);
  useLayoutEffect(() => { if (!press.current) view.current.cur = focus; apply(); }, [focus, apply, s.members, mode]);
  // cards glide between places once they're placed (not from the middle on the first frame)
  useEffect(() => { const id = requestAnimationFrame(() => stage.current?.classList.add("ready")); return () => cancelAnimationFrame(id); }, [mode]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; back?.focus?.(); };
  }, []);

  const close = useCallback(() => { setLeaving(true); setTimeout(onClose, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 340); }, [onClose]);
  const step = useCallback((d: number) => setFocus((f) => Math.min(n - 1, Math.max(0, f + d))), [n]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".fv, .modal, .fm-menu, .pub")) return;
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, [contenteditable=true]")) return;
      if (e.key === "Escape") { e.preventDefault(); if (panel) setPanel(null); else if (mode === "phone") setMode("curve"); else close(); return; }
      const jump = e.key === "[" || e.key === "]" || (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"));
      if (jump) { e.preventDefault(); const d = e.key === "[" || e.key === "ArrowLeft" ? onPrev : onNext; d?.go(); return; }
      if (e.altKey && onMove && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const to = focus + (e.key === "ArrowLeft" ? -1 : 1);
        if (to >= 0 && to < n) { onMove(focus, to); setFocus(to); }
        return;
      }
      if (e.key === "p" || e.key === "P") { e.preventDefault(); setMode((m) => (m === "phone" ? "curve" : "phone")); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "Home") { e.preventDefault(); setFocus(0); }
      else if (e.key === "End") { e.preventDefault(); setFocus(n - 1); }
      else if (e.key === "Enter" || e.key === " ") { if (t.tagName === "BUTTON" && !t.classList.contains("cs-card")) return; e.preventDefault(); onOpen(focus); }
      else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && Number(e.key) <= n) { e.preventDefault(); setFocus(Number(e.key) - 1); onOpen(Number(e.key) - 1); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [close, focus, mode, n, onMove, onNext, onOpen, onPrev, panel, step]);

  // ── pointer: drag sideways to browse; lift a card (drag up, or hold) to move it
  const cardAt = (e: React.PointerEvent) => { const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]"); return el ? Number(el.dataset.i) : null; };
  const startLift = (p: NonNullable<typeof press.current>) => {
    if (p.i == null || !onMove) return;
    p.mode = "lift";
    view.current.lift = { i: p.i, to: p.i, dx: 0, dy: 0 };
    stage.current?.classList.add("lifting");
    pos.current[p.i]?.classList.add("lifted");
    schedule();
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    quiet.current = false;
    const p = { x: e.clientX, y: e.clientY, f: view.current.cur, i: cardAt(e), mode: "" as const };
    press.current = p;
    if (p.i != null && onMove && e.pointerType !== "mouse") (press.current as { timer?: ReturnType<typeof setTimeout> }).timer = setTimeout(() => { if (press.current === p && !p.mode) { startLift(p); navigator.vibrate?.(8); } }, 320);
  };
  const move = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.mode) {
      if (Math.hypot(dx, dy) < 7) return;
      clearTimeout(p.timer);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      if (p.i != null && onMove && dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.1) startLift(p);
      else { p.mode = "scroll"; stage.current?.classList.add("dragging"); }
      quiet.current = true;
    }
    if (p.mode === "lift" && view.current.lift) {
      const l = view.current.lift;
      l.dx = dx; l.dy = Math.min(40, dy);
      l.to = Math.max(0, Math.min(n - 1, Math.round(l.i + dx / (pw * GAP))));
    } else if (p.mode === "scroll") view.current.cur = Math.max(-0.45, Math.min(n - 0.55, p.f - dx / (pw * GAP)));
    schedule();
  };
  const up = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    stage.current?.classList.remove("dragging", "lifting");
    if (p.mode === "lift" && view.current.lift) {
      const { i, to } = view.current.lift;
      pos.current[i]?.classList.remove("lifted");
      view.current.lift = null;
      if (to !== i) { onMove!(i, to); view.current.cur = to; setFocus(to); }
      schedule();
    } else if (p.mode === "scroll") {
      const f = Math.max(0, Math.min(n - 1, Math.round(view.current.cur)));
      view.current.cur = f;
      if (f === focus) schedule(); else setFocus(f);
    }
  };

  const meta = [countOf(s.members), s.g.post ? "on a post" : "grouped by hand", s.members[0]?.by].filter(Boolean).join(" · ");
  const flagged = (checks?.bad ?? 0) + (checks?.warn ?? 0);
  const first = checks?.slides.find((c) => c.w && c.h);
  const ratio = first ? Math.max(0.8, Math.min(1.91, first.w! / first.h!)) : 0.8;
  return (
    <div className={`cs ${leaving ? "out" : ""} m-${mode}`} ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Carousel ${s.g.name}`}>
      <div className="cs-back" onClick={close} />
      <div className="cs-top">
        <div className="cs-name">
          <span className="cs-kicker"><Cards size={13} weight="bold" />Carousel</span>
          {onRename ? <Name value={s.g.name} renaming={renaming} onRename={(v) => { setRenaming(false); if (v && v !== s.g.name) onRename(v); }} className="cs-title ellipsis" />
            : <b className="cs-title ellipsis">{s.g.name}</b>}
          <span className="ellipsis">{meta}</span>
        </div>
        <div className="cs-tools">
          <div className="seg cs-seg" role="radiogroup" aria-label="View">
            <button role="radio" aria-checked={mode === "curve"} className={mode === "curve" ? "on" : ""} onClick={() => setMode("curve")} title="The curve"><Cards size={15} /><span>Curve</span></button>
            <button role="radio" aria-checked={mode === "phone"} className={mode === "phone" ? "on" : ""} onClick={() => setMode("phone")} title="As it looks on Instagram (P)"><DeviceMobile size={15} /><span>Phone</span></button>
          </div>
          <button type="button" className={`cs-chip ${checks ? (checks.bad ? "bad" : checks.warn ? "warn" : "ok") : ""} ${panel === "checks" ? "on" : ""}`} onClick={() => setPanel(panel === "checks" ? null : "checks")} aria-pressed={panel === "checks"}>
            {!checks ? <><span className="vp-spin sm" />Checking</> : flagged ? <><Warning size={14} weight="bold" />{flagged} to look at</> : <><CheckCircle size={14} weight="bold" />Slides look good</>}
          </button>
          {stats?.live && (
            <button type="button" className={`cs-chip live ${panel === "stats" ? "on" : ""}`} onClick={() => setPanel(panel === "stats" ? null : "stats")} aria-pressed={panel === "stats"}>
              <i className="cs-live-dot" />Live · {short(stats.saves)} saves<span className="cs-more"> · {short(stats.shares)} shares</span>
            </button>
          )}
          {onInstagram && <button type="button" className="sm cs-ig" onClick={onInstagram} aria-label={stats?.live ? "Post to Instagram again" : "Post to Instagram"} title="Post to Instagram"><InstagramLogo size={15} weight="bold" /><span>{stats?.live ? "Post again" : "Post to Instagram"}</span></button>}
        </div>
        <div className="fv-acts">
          <button className="vp-btn" onClick={onStar} aria-label={s.starred ? "Remove star" : "Star every file"} title={s.starred ? "Remove star" : "Star"}><Star size={19} weight={s.starred ? "fill" : "regular"} className={s.starred ? "fm-star" : ""} /></button>
          {onRename && <button className="vp-btn" onClick={() => setRenaming(true)} aria-label="Rename the carousel" title="Rename"><PencilSimple size={19} /></button>}
          {onPost && <button className="vp-btn" onClick={onPost} aria-label="Open its post" title="Open its post"><ArrowSquareOut size={19} /></button>}
          <button className="vp-btn" onClick={onDownload} aria-label={`Download all ${n}`} title={`Download all ${n}`}><DownloadSimple size={19} /></button>
          {onUngroup && <button className="vp-btn" onClick={onUngroup} aria-label="Ungroup (the files stay)" title="Ungroup"><StackMinus size={19} /></button>}
          <button className="vp-btn" onClick={close} aria-label="Close (Esc)" title="Close (Esc)"><X size={20} /></button>
        </div>
      </div>

      {mode === "curve" ? (
        <div ref={stage} className="cs-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onWheel={(e) => {
            const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            const now = Date.now(), wh = wheel.current;
            if (now - wh.t > 260) wh.acc = 0;
            wh.t = now; wh.acc += d;
            if (Math.abs(wh.acc) > 60) { step(Math.sign(wh.acc)); wh.acc = 0; }
          }}>
          <div className="cs-ring" key={s.key} style={{ "--pw": `${pw}px` } as React.CSSProperties}>
            {s.members.map((m, i) => {
              const near = Math.abs(i - focus) <= span + 1;
              const bad = issues.get(m.key);
              return (
                <div key={m.key} className="cs-slot" style={{ "--d": `${Math.max(0, Math.round((i - focus + span) * 65))}ms`, "--d2": `${Math.max(0, Math.round((span - Math.abs(i - focus)) * 35))}ms`, "--tilt": `${(i % 2 ? 1 : -1) * 4}deg` } as React.CSSProperties}>
                  <div className="cs-pos" data-i={i} ref={(el) => { pos.current[i] = el; }}>
                    <button type="button" ref={(el) => { cards.current[i] = el; }} className={`cs-card ${i === focus ? "on" : ""}`} tabIndex={near ? 0 : -1}
                      aria-label={`Open ${m.name}, ${i + 1} of ${n}`} onFocus={() => { if (!press.current) setFocus(i); }} onClick={() => { if (!quiet.current) onOpen(i); quiet.current = false; }}>
                      {m.cover ? <img src={m.cover} alt="" loading={near ? "eager" : "lazy"} fetchPriority={i === focus ? "high" : "auto"} decoding="async" draggable={false} /> : <span className="cc-glyph"><KindIcon kind={m.kind} src={m.src} size={34} /></span>}
                      {m.kind === "video" && <span className="cs-vid"><FilmStrip size={12} weight="bold" />Clip</span>}
                      {bad?.length ? <span className={`cs-flag ${bad.some((x) => x.level === "bad") ? "bad" : ""}`} title={bad.map((x) => x.text).join("\n")}><Warning size={12} weight="bold" /></span> : null}
                    </button>
                    <div className="cs-label" aria-hidden>
                      <span className="cs-num">#{pad(i + 1)}</span>
                      <span className="cs-cap ellipsis">{m.name.replace(/\.[A-Za-z0-9]{2,5}$/, "")}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <Phone s={s} index={focus} onIndex={setFocus} ratio={ratio} handle={handle} issues={issues} onOpen={onOpen} />
      )}

      {panel === "checks" && checks && (
        <aside className="cs-panel" aria-label="Slide checks">
          <div className="cs-panel-h"><b>Slide checks</b><span className="tiny dim">{checks.ok} good · {checks.warn} to look at · {checks.bad} won&apos;t work</span><button className="vp-btn" onClick={() => setPanel(null)} aria-label="Close checks"><X size={16} /></button></div>
          {checks.notes.map((x) => <p key={x} className="cs-note bad">{x}</p>)}
          <ol className="cs-checks">
            {s.members.map((m, i) => {
              const c = checks.slides.find((x) => x.file_id === m.key);
              return (
                <li key={m.key}>
                  <button type="button" onClick={() => { setFocus(i); if (mode === "phone") return; }} className="cs-check-row">
                    <span className="cs-check-th"><Thumb it={m} /></span>
                    <span className="cs-check-t">
                      <b>#{pad(i + 1)} <span className="dim mono tiny">{c?.w ? `${c.w}×${c.h}` : ""}</span></b>
                      {c?.issues.length ? c.issues.map((x) => <span key={x.text} className={`cs-iss ${x.level}`}>{x.text}</span>) : <span className="cs-iss ok">Good for Instagram</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      )}
      {panel === "stats" && stats?.live && (
        <aside className="cs-panel" aria-label="How it did">
          <div className="cs-panel-h"><b>On Instagram</b>{stats.url && <a className="tiny" href={stats.url} target="_blank" rel="noreferrer">Open the post</a>}<button className="vp-btn" onClick={() => setPanel(null)} aria-label="Close"><X size={16} /></button></div>
          {stats.error ? <p className="cs-note bad">{stats.error}</p> : (
            <div className="cs-kpis">
              {([["Views", stats.views], ["Reach", stats.reach], ["Likes", stats.likes], ["Comments", stats.comments], ["Shares", stats.shares], ["Saves", stats.saves]] as const).map(([l, v]) => (
                <div key={l}><span className="tiny dim">{l}</span><b className="mono">{short(v)}</b></div>
              ))}
              {stats.er != null && <div><span className="tiny dim">Engagement</span><b className="mono">{stats.er.toFixed(1)}%</b></div>}
            </div>
          )}
          {stats.notes?.map((x) => <p key={x} className="cs-note">{x}</p>)}
        </aside>
      )}

      <div className="cs-foot">
        <button type="button" className="cs-jump l" onClick={onPrev?.go} disabled={!onPrev} aria-label={onPrev ? `Previous carousel: ${onPrev.name}` : "No previous carousel"}>
          <CaretLeft size={15} weight="bold" /><span className="cs-jump-t"><em>Previous post</em><b className="ellipsis">{onPrev?.name ?? "—"}</b></span>
        </button>
        <div className="cs-mid">
          <div className="cs-ticks" role="tablist" aria-label="Photos">
            {s.members.map((m, i) => <button key={m.key} type="button" role="tab" aria-selected={i === focus} aria-label={`Photo ${i + 1}`} className={i === focus ? "on" : ""} onClick={() => setFocus(i)} />)}
          </div>
          <span className="cs-count mono"><b>{pad(focus + 1)}</b> / {pad(n)}</span>
          <span className="cs-keys" aria-hidden><kbd>←</kbd><kbd>→</kbd> browse <kbd>↵</kbd> open <kbd>[</kbd><kbd>]</kbd> other posts <kbd>P</kbd> phone{onMove ? <> · drag a card up to move it</> : null}</span>
        </div>
        <button type="button" className="cs-jump r" onClick={onNext?.go} disabled={!onNext} aria-label={onNext ? `Next carousel: ${onNext.name}` : "No next carousel"}>
          <span className="cs-jump-t"><em>Next post</em><b className="ellipsis">{onNext?.name ?? "—"}</b></span><CaretRight size={15} weight="bold" />
        </button>
      </div>
    </div>
  );
}

/** The carousel as it shows in the Instagram feed: a phone, the slides cropped to the first one's shape, swipeable. */
function Phone({ s, index, onIndex, ratio, handle, issues, onOpen }: {
  s: Stack; index: number; onIndex: (i: number) => void; ratio: number; handle?: string | null; issues: Map<string, SlideCheck["issues"]>; onOpen: (i: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const n = s.members.length;
  const shown = Math.min(n, 20);
  const syncing = useRef(false);
  const placed = useRef(false);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const want = index * el.clientWidth;
    if (Math.abs(el.scrollLeft - want) > 2) {
      syncing.current = true;
      el.scrollTo({ left: want, behavior: placed.current ? "smooth" : "instant" }); // opens on the slide you were on
      setTimeout(() => { syncing.current = false; }, placed.current ? 400 : 50);
    }
    placed.current = true;
  }, [index]);
  const onScroll = () => {
    const el = track.current;
    if (!el || syncing.current) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== index) onIndex(Math.min(shown - 1, i));
  };
  const cur = s.members[index];
  const bad = cur ? issues.get(cur.key) : undefined;
  return (
    <div className="cs-phone-wrap">
      <button type="button" className="fv-nav l" onClick={() => onIndex(Math.max(0, index - 1))} disabled={index === 0} aria-label="Previous slide"><CaretLeft size={20} weight="bold" /></button>
      <div className="cs-phone" aria-label="Instagram preview">
        <div className="cs-ph-bar"><span className="mono">9:41</span><span className="cs-ph-notch" /><span className="cs-ph-sig" /></div>
        <div className="cs-ph-head"><span className="cs-ph-av" />{handle ? <b>{handle}</b> : <b>your_account</b>}<DotsThree size={18} weight="bold" className="dim" /></div>
        <div className="cs-ph-track" ref={track} onScroll={onScroll} style={{ aspectRatio: String(ratio) }}>
          {s.members.slice(0, shown).map((m, i) => (
            <div key={m.key} className="cs-ph-slide" onDoubleClick={() => onOpen(i)}>
              {m.cover ? <img src={m.cover} alt={`Slide ${i + 1}`} loading={Math.abs(i - index) < 3 ? "eager" : "lazy"} decoding="async" draggable={false} /> : <span className="cc-glyph"><KindIcon kind={m.kind} src={m.src} size={34} /></span>}
              {m.kind === "video" && <span className="cs-vid"><Play size={11} weight="fill" />Clip</span>}
            </div>
          ))}
          <span className="cs-ph-count mono">{index + 1}/{shown}</span>
        </div>
        <div className="cs-ph-acts">
          <Heart size={22} /><ChatCircle size={22} /><PaperPlaneTilt size={22} />
          <span className="cs-ph-dots">{s.members.slice(0, shown).map((m, i) => <i key={m.key} className={i === index ? "on" : Math.abs(i - index) > 4 ? "far" : ""} />)}</span>
          <BookmarkSimple size={22} />
        </div>
        <div className="cs-ph-cap"><b>{handle ?? "your_account"}</b> {s.g.name}</div>
        {bad?.length ? <div className={`cs-ph-warn ${bad.some((x) => x.level === "bad") ? "bad" : ""}`}><Warning size={13} weight="bold" />{bad[0].text}</div> : null}
      </div>
      <button type="button" className="fv-nav r" onClick={() => onIndex(Math.min(shown - 1, index + 1))} disabled={index >= shown - 1} aria-label="Next slide"><CaretRight size={20} weight="bold" /></button>
    </div>
  );
}

/** Along the bottom of the full-size viewer: the carousel's photos (the open one lit) and the way to the next post. */
export function CarouselStrip({ s, index, onPick, onPrev, onNext }: { s: Stack; index: number; onPick: (i: number) => void; onPrev: Near; onNext: Near }) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => { row.current?.querySelector<HTMLElement>(".on")?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }); }, [index]);
  return (
    <div className="cs-strip">
      <button type="button" className="vp-btn" onClick={onPrev?.go} disabled={!onPrev} aria-label={onPrev ? `Previous carousel: ${onPrev.name} ([)` : "No previous carousel"} title={onPrev ? `${onPrev.name} ([)` : undefined}><CaretLeft size={16} weight="bold" /></button>
      <div className="cs-strip-row" ref={row}>
        <span className="cs-strip-name ellipsis"><Cards size={13} weight="bold" />{s.g.name}</span>
        {s.members.map((m, i) => (
          <button key={m.key} type="button" className={`cs-thumb ${i === index ? "on" : ""}`} onClick={() => onPick(i)} aria-label={`${i + 1}: ${m.name}`} aria-current={i === index || undefined}>
            <Thumb it={m} eager={Math.abs(i - index) < 6} /><span className="mono">{pad(i + 1)}</span>
          </button>
        ))}
      </div>
      <button type="button" className="vp-btn" onClick={onNext?.go} disabled={!onNext} aria-label={onNext ? `Next carousel: ${onNext.name} (])` : "No next carousel"} title={onNext ? `${onNext.name} (])` : undefined}><CaretRight size={16} weight="bold" /></button>
    </div>
  );
}
