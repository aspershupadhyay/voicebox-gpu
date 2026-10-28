"use client";
// Carousels on the Files page (rules in lib/carouselrules.ts): a post's photos and clips as one stacked card instead
// of ten loose files. Opening one stands the photos up from the bottom of the screen, one after another, onto a curved
// row (the owner's reference: a concave fan of tall cards, each numbered #01, #02… with its name under it). Click a
// photo to open it full size; the viewer gets a strip of the carousel along the bottom. Keys on the stage: ← → browse,
// Enter opens, 1–9 open that photo, Alt+← → move the photo in the order, [ ] (or Shift+← →) jump to the previous or
// next post's carousel, Esc closes. State lives in components/Files.tsx; styles under "carousels" in app/globals.css.
import {
  ArrowSquareOut, CaretLeft, CaretRight, Cards, DotsThree, DownloadSimple, FilmStrip, PencilSimple, Play, StackMinus, Star, X,
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
export function CarouselCard({ s, ...ev }: { s: Stack } & CardEvents) {
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
          <span className="cc-dots" aria-hidden>{s.members.slice(0, 10).map((m) => <i key={m.key} />)}</span>
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

/** Where a card sits on the curve, `o` places from the one in focus: further out is nearer to you and turned in, like
 *  standing inside a ring of photos. */
function placeOf(o: number, pw: number, span: number) {
  const a = Math.abs(o), s = Math.sign(o);
  const x = s * (a * pw * 0.97 + a * a * pw * 0.02);
  const z = Math.pow(a, 1.6) * pw * 0.17;
  const ry = -o * 13;
  const fade = Math.max(0, Math.min(1, span + 0.6 - a));
  return { transform: `translate3d(${x}px, 0, ${z}px) rotateY(${ry}deg)`, opacity: fade, zIndex: 100 - Math.round(a * 4), hidden: fade <= 0.02 };
}

/** The opened carousel: the photos rise from the bottom onto a curved row. */
export function CarouselStage({ s, onClose, onOpen, onPrev, onNext, onRename, onUngroup, onMove, onDownload, onPost, onStar, at }: {
  s: Stack; onClose: () => void; onOpen: (i: number) => void; onPrev: Near; onNext: Near; at?: number;
  onRename?: (name: string) => void; onUngroup?: () => void; onMove?: (from: number, to: number) => void; onDownload: () => void; onPost?: () => void; onStar: () => void;
}) {
  const n = s.members.length;
  const [focus, setFocus] = useState(() => Math.min(n - 1, Math.max(0, at ?? Math.floor((n - 1) / 2))));
  const [drag, setDrag] = useState<number | null>(null); // the focus while dragging (a fraction)
  const [leaving, setLeaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [w, setW] = useState(1200);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; f: number; moved: boolean } | null>(null);
  const wheel = useRef({ acc: 0, t: 0 });
  useEffect(() => { setFocus((f) => Math.min(n - 1, Math.max(0, f))); }, [n]);
  useEffect(() => { if (at != null) setFocus(Math.min(n - 1, Math.max(0, at))); }, [at, n]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const phone = w < 640;
  const pw = phone ? Math.min(w * 0.5, 230) : Math.max(112, Math.min(196, w / 9.8));
  const span = phone ? 1.4 : 3.5;

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; back?.focus?.(); };
  }, []);

  const close = useCallback(() => { setLeaving(true); setTimeout(onClose, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 380); }, [onClose]);
  const step = useCallback((d: number) => setFocus((f) => Math.min(n - 1, Math.max(0, f + d))), [n]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".fv, .modal, .fm-menu")) return;
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, [contenteditable=true]")) return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      const jump = e.key === "[" || e.key === "]" || (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"));
      if (jump) { e.preventDefault(); const d = e.key === "[" || e.key === "ArrowLeft" ? onPrev : onNext; d?.go(); return; }
      if (e.altKey && onMove && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const to = focus + (e.key === "ArrowLeft" ? -1 : 1);
        if (to >= 0 && to < n) { onMove(focus, to); setFocus(to); }
        return;
      }
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "Home") { e.preventDefault(); setFocus(0); }
      else if (e.key === "End") { e.preventDefault(); setFocus(n - 1); }
      else if (e.key === "Enter" || e.key === " ") { if (t.tagName === "BUTTON" && !t.classList.contains("cs-card")) return; e.preventDefault(); onOpen(focus); }
      else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && Number(e.key) <= n) { e.preventDefault(); setFocus(Number(e.key) - 1); onOpen(Number(e.key) - 1); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [close, focus, n, onMove, onNext, onOpen, onPrev, step]);

  const cur = drag ?? focus;
  const meta = [countOf(s.members), s.g.post ? "on a post" : "grouped by hand", s.members[0]?.by].filter(Boolean).join(" · ");
  return (
    <div className={`cs ${leaving ? "out" : ""}`} ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Carousel ${s.g.name}`}>
      <div className="cs-back" onClick={close} />
      <div className="cs-top">
        <div className="cs-name">
          <span className="cs-kicker"><Cards size={13} weight="bold" />Carousel</span>
          {onRename ? <Name value={s.g.name} renaming={renaming} onRename={(v) => { setRenaming(false); if (v && v !== s.g.name) onRename(v); }} className="cs-title ellipsis" />
            : <b className="cs-title ellipsis">{s.g.name}</b>}
          <span className="ellipsis">{meta}</span>
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

      <div ref={stage} className={`cs-stage ${drag != null ? "dragging" : ""}`} style={{ "--pw": `${pw}px` } as React.CSSProperties}
        onWheel={(e) => {
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          const now = Date.now(), wh = wheel.current;
          if (now - wh.t > 300) wh.acc = 0;
          wh.t = now; wh.acc += d;
          if (Math.abs(wh.acc) > 70) { step(Math.sign(wh.acc)); wh.acc = 0; }
        }}
        onPointerDown={(e) => { if (e.button === 0) press.current = { x: e.clientX, f: focus, moved: false }; }}
        onPointerMove={(e) => {
          const p = press.current;
          if (!p) return;
          const dx = e.clientX - p.x;
          if (!p.moved && Math.abs(dx) < 7) return;
          if (!p.moved) { p.moved = true; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
          setDrag(Math.min(n - 1 + 0.4, Math.max(-0.4, p.f - dx / (pw * 1.04))));
        }}
        onPointerUp={() => { const p = press.current; press.current = null; if (p?.moved && drag != null) setFocus(Math.min(n - 1, Math.max(0, Math.round(drag)))); setDrag(null); }}
        onPointerCancel={() => { press.current = null; setDrag(null); }}
        onClickCapture={(e) => { if (drag != null) { e.stopPropagation(); e.preventDefault(); } }}>
        <div className="cs-ring" key={s.key}>
          {s.members.map((m, i) => {
            const o = i - cur;
            const p = placeOf(o, pw, span);
            const visible = Math.abs(i - focus) <= span + 0.6;
            return (
              <div key={m.key} className="cs-slot" style={{ zIndex: p.zIndex, "--d": `${Math.max(0, (i - focus + span) * 70)}ms`, "--d2": `${Math.max(0, (span - Math.abs(i - focus)) * 40)}ms`, "--tilt": `${(i % 2 ? 1 : -1) * 5}deg` } as React.CSSProperties}>
                <div className="cs-pos" style={{ transform: p.transform, opacity: p.opacity, pointerEvents: p.hidden ? "none" : undefined }}>
                  <button type="button" className={`cs-card ${i === focus ? "on" : ""}`} tabIndex={visible ? 0 : -1} aria-hidden={p.hidden || undefined}
                    aria-label={`Open ${m.name}, ${i + 1} of ${n}`} onFocus={() => setFocus(i)} onClick={() => onOpen(i)}>
                    {m.cover ? <img src={m.cover} alt="" loading={visible ? "eager" : "lazy"} decoding="async" draggable={false} /> : <span className="cc-glyph"><KindIcon kind={m.kind} src={m.src} size={34} /></span>}
                    {m.kind === "video" && <span className="cs-vid"><FilmStrip size={12} weight="bold" />Clip</span>}
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

      <div className="cs-foot">
        <button type="button" className="cs-jump l" onClick={onPrev?.go} disabled={!onPrev} aria-label={onPrev ? `Previous carousel: ${onPrev.name}` : "No previous carousel"}>
          <CaretLeft size={15} weight="bold" /><span className="cs-jump-t"><em>Previous post</em><b className="ellipsis">{onPrev?.name ?? "—"}</b></span>
        </button>
        <div className="cs-mid">
          <div className="cs-ticks" role="tablist" aria-label="Photos">
            {s.members.map((m, i) => <button key={m.key} type="button" role="tab" aria-selected={i === focus} aria-label={`Photo ${i + 1}`} className={i === focus ? "on" : ""} onClick={() => setFocus(i)} />)}
          </div>
          <span className="cs-count mono"><b>{pad(focus + 1)}</b> / {pad(n)}</span>
          <span className="cs-keys" aria-hidden><kbd>←</kbd><kbd>→</kbd> browse <kbd>↵</kbd> open <kbd>[</kbd><kbd>]</kbd> other posts{onMove ? <> <kbd>Alt</kbd>+<kbd>←</kbd> reorder</> : null}</span>
        </div>
        <button type="button" className="cs-jump r" onClick={onNext?.go} disabled={!onNext} aria-label={onNext ? `Next carousel: ${onNext.name}` : "No next carousel"}>
          <span className="cs-jump-t"><em>Next post</em><b className="ellipsis">{onNext?.name ?? "—"}</b></span><CaretRight size={15} weight="bold" />
        </button>
      </div>
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
