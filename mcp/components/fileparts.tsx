"use client";
// The Files page's parts: folder cards (a tabbed folder in one of six soft colours), file cards (a cover with a notched
// body, like a folder's front sheet), list rows, the right-click / ⋮ menu, the "Move to" dialog and the cover art for
// audio and docs. State and actions live in components/Files.tsx; styles under "files" in app/globals.css.
import {
  CaretDown, CaretRight, Check, ClosedCaptioning, Cpu, DotsThree, FileAudio, FileText, FilmStrip, Folder as FolderIc, FolderPlus, ImageSquare, Microphone, Paperclip, Play,
  Star, Stop, X,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Folder } from "@/lib/filetree";
import type { LibSummary } from "@/lib/library";
import { FOLDER_COLORS, type FolderColor, type Media, type MediaKind } from "@/lib/workspace";
import { useDismiss } from "./pop";
import { Avatar } from "./wsparts";

/** A generated item as the Files page lists it: its summary plus a cover and its first line's audio. */
export type JobSum = LibSummary & { cover: string | null; audio: string | null };

export type Item = {
  key: string; src: "upload" | "generated"; name: string; kind: MediaKind; type: string; size: number | null; seconds: number | null; at: number;
  by: string | null; byId: string | null; folder: string | null; starred: boolean; cover: string | null; audio: string | null;
  subs: boolean; post: string | null; backedUp: boolean; snippet: string; m?: Media; j?: JobSum;
  progress?: number; error?: string; trashedAt?: number; placed?: boolean;
};

export const DT = "application/x-voicebox-files"; // what an internal drag carries: a JSON list of keys

export const fmtSize = (b?: number | null) => (!b ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
export const fmtLen = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`);
export function fmtAgo(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? "" : "s"} ago`; }
  const d = Math.round(s / 86400);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d > 330 ? "numeric" : undefined });
}

/** "2 days ago", or what's happening to it: uploading, failed, deleted. */
export const when = (it: Item) => it.error ? "Upload failed" : it.progress != null ? (it.progress >= 1 ? "Finishing…" : `Uploading ${Math.round(it.progress * 100)}%`)
  : it.trashedAt ? `Deleted ${fmtAgo(it.trashedAt).toLowerCase()}` : fmtAgo(it.at);

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** A voiceover's cover: a waveform whose shape is seeded by its name (the same everywhere). */
function Wave({ seed }: { seed: string }) {
  let h = hash(seed);
  const bars = Array.from({ length: 44 }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const env = Math.sin((i / 43) * Math.PI) * 0.7 + 0.3;
    return Math.max(0.1, env * (0.35 + (h % 1000) / 1540));
  });
  return (
    <svg className="fc-wave" viewBox="0 0 176 60" preserveAspectRatio="none" aria-hidden>
      {bars.map((v, i) => <rect key={i} x={i * 4} y={30 - v * 27} width="2.2" height={v * 54} rx="1.1" />)}
    </svg>
  );
}

export function KindIcon({ kind, src, size = 16, weight = "duotone" }: { kind: MediaKind; src: Item["src"]; size?: number; weight?: "duotone" | "fill" | "regular" | "bold" }) {
  if (kind === "image") return <ImageSquare size={size} weight={weight} />;
  if (kind === "video") return <FilmStrip size={size} weight={weight} />;
  if (kind === "audio") return src === "generated" ? <Microphone size={size} weight={weight} /> : <FileAudio size={size} weight={weight} />;
  if (kind === "doc") return src === "generated" ? <ClosedCaptioning size={size} weight={weight} /> : <FileText size={size} weight={weight} />;
  return <Paperclip size={size} weight={weight} />;
}

/** A ring that fills as an upload goes. */
export function Ring({ value, size = 44 }: { value: number; size?: number }) {
  const r = size / 2 - 3, c = 2 * Math.PI * r;
  return (
    <svg className="fm-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${Math.round(value * 100)}% uploaded`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="rg-track" />
      <circle cx={size / 2} cy={size / 2} r={r} className="rg-fill" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.02, value))} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

/** The art at the top of a file card: the image or a video frame, else a tinted cover for audio, docs and the rest. */
export function Cover({ it, playing, onPlay }: { it: Item; playing?: boolean; onPlay?: () => void }) {
  const tint = it.cover ? "" : `t-${it.kind}`;
  return (
    <div className={`fc-cover ${tint}`}>
      {it.cover ? <img src={it.cover} alt="" loading="lazy" decoding="async" draggable={false} />
        : it.kind === "audio" ? <Wave seed={it.key} />
        : it.kind === "doc" && it.snippet ? <p className="fc-snippet">{it.snippet}</p>
        : <span className="fc-glyph"><KindIcon kind={it.kind} src={it.src} size={30} /></span>}
      {it.audio && onPlay && it.progress == null && (
        <button type="button" className={`fc-play ${playing ? "on" : ""}`} aria-label={playing ? `Stop ${it.name}` : `Play ${it.name}`} title={playing ? "Stop" : "Play"}
          onClick={(e) => { e.stopPropagation(); onPlay(); }}>{playing ? <Stop size={13} weight="fill" /> : <Play size={13} weight="fill" />}</button>
      )}
      {it.progress != null && <span className="fc-up">{it.error ? <span className="fc-up-err">Failed</span> : <Ring value={it.progress} />}</span>}
      {it.kind === "video" && it.cover && it.progress == null && <span className="fc-badge"><FilmStrip size={12} weight="bold" />{it.seconds ? fmtLen(it.seconds) : "Video"}</span>}
    </div>
  );
}

/** Who put a file here: their avatar, or the GPU for generated things. */
export function ByMark({ it }: { it: Item }) {
  if (it.src === "generated") return <span role="img" className="avatar sm fm-gpu" title="Made on the GPU" aria-label="Made on the GPU"><Cpu size={12} weight="bold" /></span>;
  return <Avatar id={it.byId} name={it.by || "Someone"} sm />;
}

/** The small tiles on a card's right foot: what kind of file it is, plus subtitles, a post and the R2 backup. */
function Badges({ it }: { it: Item }) {
  return (
    <span className="fc-badges">
      {it.subs && <span role="img" className="fb-ic" title="Has subtitles" aria-label="Has subtitles"><ClosedCaptioning size={13} weight="bold" /></span>}
      {it.post && <span role="img" className="fb-ic" title="On a post" aria-label="On a post"><Paperclip size={13} weight="bold" /></span>}
      <span role="img" className={`fb-ic k-${it.kind}`} title={it.type} aria-label={it.type}><KindIcon kind={it.kind} src={it.src} size={14} weight="fill" /></span>
    </span>
  );
}

/** The card's own control: a button the size of the card, under its checkbox and ⋮ (so nothing interactive nests). */
export const Hit = ({ label }: { label: string }) => <button type="button" className="fm-hit" aria-label={label} />;

export type CardEvents = {
  selected: boolean; selecting: boolean; renaming: boolean; dim?: boolean;
  onOpen: (e: React.MouseEvent) => void; onToggle: (shift: boolean) => void; onMenu: (at: Anchor) => void;
  onRename: (name: string | null) => void; onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void;
};

/** The name in place, or an input while renaming (Enter saves, Escape cancels, leaving the field saves). */
export function Name({ value, renaming, onRename, className }: { value: string; renaming: boolean; onRename: (v: string | null) => void; className: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!renaming || !ref.current) return;
    done.current = false;
    const el = ref.current;
    el.focus();
    const dot = value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 && value.length - dot <= 6 ? dot : value.length); // keep the extension
  }, [renaming, value]);
  if (!renaming) return <span className={className} title={value}>{value}</span>;
  const finish = (v: string | null) => { if (done.current) return; done.current = true; onRename(v); };
  return (
    <input ref={ref} className={`${className} fm-rename`} defaultValue={value} aria-label="New name" maxLength={200}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value.trim() || null);
        if (e.key === "Escape") finish(null);
      }} onBlur={(e) => finish(e.currentTarget.value.trim() || null)} />
  );
}

export const anchorOf = (el: HTMLElement): Anchor => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, align: "end" }; };

export function FileCard({ it, playing, onPlay, ...ev }: { it: Item; playing: boolean; onPlay: () => void } & CardEvents) {
  return (
    <div className={`fcard ${ev.selected ? "sel" : ""} ${ev.dim ? "dim" : ""}`}
      draggable={!ev.renaming} onDragStart={ev.onDragStart} onDragEnd={ev.onDragEnd}
      onClick={ev.onOpen}
      onContextMenu={(e) => { e.preventDefault(); ev.onMenu({ x: e.clientX, y: e.clientY, w: 0, h: 0, align: "start" }); }}>
      <Hit label={`Open ${it.name}, ${it.type}`} />
      <Cover it={it} playing={playing} onPlay={onPlay} />
      <input type="checkbox" className="selbox fc-check" checked={ev.selected} aria-label={`Select ${it.name}`} onClick={(e) => { e.stopPropagation(); ev.onToggle(e.shiftKey); }} onChange={() => {}} />
      <div className="fc-body">
        <span className="fc-tab" aria-hidden />
        <button type="button" className="fc-more" aria-label={`More for ${it.name}`} title="More" onClick={(e) => { e.stopPropagation(); ev.onMenu(anchorOf(e.currentTarget)); }}><DotsThree size={18} weight="bold" /></button>
        <div className="fc-meta">
          {it.starred && <Star size={12} weight="fill" className="fm-star" aria-label="Starred" />}
          <span>{when(it)}</span><span className="dot" aria-hidden /><span>{it.type}</span>
        </div>
        <Name value={it.name} renaming={ev.renaming} onRename={ev.onRename} className="fc-name" />
        <div className="fc-foot">
          <span className="row" style={{ gap: 8 }}><ByMark it={it} /><span className="tiny dim mono">{it.seconds && it.kind === "audio" ? fmtLen(it.seconds) : fmtSize(it.size)}</span></span>
          <Badges it={it} />
        </div>
      </div>
    </div>
  );
}

export function FolderCard({ f, count, people, over, ...ev }: { f: Folder; count: number; people: { id: string | null; name: string }[]; over: boolean; starred: boolean }
  & CardEvents & { onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void }) {
  return (
    <div className={`fold c-${f.color} ${ev.selected ? "sel" : ""} ${over ? "over" : ""} ${ev.dim ? "dim" : ""}`}
      draggable={!ev.renaming} onDragStart={ev.onDragStart} onDragEnd={ev.onDragEnd}
      onDragOver={ev.onDragOver} onDragLeave={ev.onDragLeave} onDrop={ev.onDrop}
      onClick={ev.onOpen}
      onContextMenu={(e) => { e.preventDefault(); ev.onMenu({ x: e.clientX, y: e.clientY, w: 0, h: 0, align: "start" }); }}>
      <Hit label={`Open folder ${f.name}, ${count} item${count === 1 ? "" : "s"}`} />
      <span className="fold-tab" aria-hidden /><span className="fold-back" aria-hidden /><span className="fold-paper" aria-hidden />
      <div className="fold-front">
        <input type="checkbox" className="selbox fold-check" checked={ev.selected} aria-label={`Select folder ${f.name}`} onClick={(e) => { e.stopPropagation(); ev.onToggle(e.shiftKey); }} onChange={() => {}} />
        <button type="button" className="fc-more" aria-label={`More for folder ${f.name}`} title="More" onClick={(e) => { e.stopPropagation(); ev.onMenu(anchorOf(e.currentTarget)); }}><DotsThree size={18} weight="bold" /></button>
        <div className="fold-name">{ev.starred && <Star size={12} weight="fill" className="fm-star" aria-label="Starred" />}<Name value={f.name} renaming={ev.renaming} onRename={ev.onRename} className="fold-title" /></div>
        <div className="fold-foot">
          <span className="avatars">
            {people.slice(0, 3).map((p) => p.id === "gpu" ? <span key="gpu" className="avatar sm fm-gpu" title="Made on the GPU"><Cpu size={12} weight="bold" /></span> : <Avatar key={p.id ?? p.name} id={p.id} name={p.name} sm />)}
            {people.length > 3 && <span className="avatar sm fm-more">+{people.length - 3}</span>}
          </span>
          <span className="small dim">{count} item{count === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}

/** The dashed card at the end of the folder row. */
export function NewFolderCard({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="fold-new" onClick={onClick}><span className="fn-ic"><FolderPlus size={20} /></span>New folder</button>
  );
}

export function FileRow({ it, folderName, ...ev }: { it: Item; folderName?: string } & CardEvents) {
  return (
    <div className={`frow ${ev.selected ? "sel" : ""} ${ev.dim ? "dim" : ""}`} draggable={!ev.renaming}
      onDragStart={ev.onDragStart} onDragEnd={ev.onDragEnd} onClick={ev.onOpen}
      onContextMenu={(e) => { e.preventDefault(); ev.onMenu({ x: e.clientX, y: e.clientY, w: 0, h: 0, align: "start" }); }}>
      <Hit label={`Open ${it.name}, ${it.type}`} />
      <input type="checkbox" className="selbox" checked={ev.selected} aria-label={`Select ${it.name}`} onClick={(e) => { e.stopPropagation(); ev.onToggle(e.shiftKey); }} onChange={() => {}} />
      <span className={`fr-thumb ${it.cover ? "" : `t-${it.kind}`}`}>{it.cover ? <img src={it.cover} alt="" loading="lazy" draggable={false} /> : <KindIcon kind={it.kind} src={it.src} size={16} />}</span>
      <span className="fr-name">
        <span className="row" style={{ gap: 6, flexWrap: "nowrap", minWidth: 0 }}>{it.starred && <Star size={12} weight="fill" className="fm-star" aria-label="Starred" />}<Name value={it.name} renaming={ev.renaming} onRename={ev.onRename} className="fr-title" /></span>
        {folderName && <span className="tiny dim ellipsis">in {folderName}</span>}
      </span>
      <span className="fr-col fr-type small dim">{it.type}</span>
      <span className="fr-col fr-size small dim mono">{it.seconds && it.kind === "audio" ? fmtLen(it.seconds) : fmtSize(it.size) || "—"}</span>
      <span className="fr-col fr-by"><ByMark it={it} /><span className="small dim ellipsis">{it.src === "generated" ? "GPU" : (it.by || "Someone").split(" ")[0]}</span></span>
      <span className="fr-col fr-at small dim">{when(it)}</span>
      <button type="button" className="icon-btn sm" aria-label={`More for ${it.name}`} title="More" onClick={(e) => { e.stopPropagation(); ev.onMenu(anchorOf(e.currentTarget)); }}><DotsThree size={18} weight="bold" /></button>
    </div>
  );
}

export function FolderRow({ f, count, over, ...ev }: { f: Folder; count: number; over: boolean; starred: boolean } & CardEvents
  & { onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void }) {
  return (
    <div className={`frow ${ev.selected ? "sel" : ""} ${over ? "over" : ""} ${ev.dim ? "dim" : ""}`} draggable={!ev.renaming}
      onDragStart={ev.onDragStart} onDragEnd={ev.onDragEnd} onDragOver={ev.onDragOver} onDragLeave={ev.onDragLeave} onDrop={ev.onDrop} onClick={ev.onOpen}
      onContextMenu={(e) => { e.preventDefault(); ev.onMenu({ x: e.clientX, y: e.clientY, w: 0, h: 0, align: "start" }); }}>
      <Hit label={`Open folder ${f.name}`} />
      <input type="checkbox" className="selbox" checked={ev.selected} aria-label={`Select folder ${f.name}`} onClick={(e) => { e.stopPropagation(); ev.onToggle(e.shiftKey); }} onChange={() => {}} />
      <span className={`fr-thumb fr-fold c-${f.color}`}><FolderIc size={16} weight="fill" /></span>
      <span className="fr-name"><span className="row" style={{ gap: 6, flexWrap: "nowrap", minWidth: 0 }}>{ev.starred && <Star size={12} weight="fill" className="fm-star" aria-label="Starred" />}<Name value={f.name} renaming={ev.renaming} onRename={ev.onRename} className="fr-title" /></span></span>
      <span className="fr-col fr-type small dim">Folder</span>
      <span className="fr-col fr-size small dim">{count} item{count === 1 ? "" : "s"}</span>
      <span className="fr-col fr-by" />
      <span className="fr-col fr-at small dim">{fmtAgo(f.created)}</span>
      <button type="button" className="icon-btn sm" aria-label={`More for folder ${f.name}`} title="More" onClick={(e) => { e.stopPropagation(); ev.onMenu(anchorOf(e.currentTarget)); }}><DotsThree size={18} weight="bold" /></button>
    </div>
  );
}

// ── the menu (right-click or ⋮), floating at the pointer or next to the button

export type Anchor = { x: number; y: number; w: number; h: number; align: "start" | "end" };
export type MenuEntry = { label: string; icon?: React.ReactNode; kbd?: string; danger?: boolean; run: () => void } | "-" | { colors: FolderColor; pick: (c: FolderColor) => void };

export function ContextMenu({ at, title, entries, onClose, inside }: { at: Anchor; title?: string; entries: MenuEntry[]; onClose: () => void; inside?: React.RefObject<HTMLElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useDismiss(true, onClose, inside ? [box, inside] : [box]);
  useLayoutEffect(() => {
    back.current = document.activeElement as HTMLElement;
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = innerWidth, vh = innerHeight;
    let left = at.align === "end" ? at.x + at.w - w : at.x;
    let top = at.y + at.h + (at.h ? 6 : 2);
    if (top + h > vh - 8) top = Math.max(8, (at.h ? at.y - 6 : at.y) - h);
    left = Math.max(8, Math.min(left, vw - w - 8));
    setPos({ left, top });
    el.querySelector<HTMLElement>("button")?.focus();
    return () => { back.current?.focus?.(); };
  }, [at]);
  const onKey = (e: React.KeyboardEvent) => {
    const btns = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    if (e.key === "Tab") onClose();
  };
  return createPortal(
    <div ref={box} className="popmenu floating fm-menu" role="menu" aria-label={title} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}>
      {title && <div className="pm-h ellipsis">{title}</div>}
      {entries.map((en, i) => en === "-" ? <hr key={i} /> : "colors" in en ? (
        <div key={i} className="fm-swatches" role="group" aria-label="Folder colour">
          {FOLDER_COLORS.map((c) => (
            <button key={c} type="button" role="menuitemradio" aria-checked={en.colors === c} className={`fm-sw c-${c}`} aria-label={c} title={c[0].toUpperCase() + c.slice(1)}
              onClick={() => { en.pick(c); onClose(); }}>{en.colors === c && <Check size={12} weight="bold" />}</button>
          ))}
        </div>
      ) : (
        <button key={i} type="button" role="menuitem" className={`pm-item ${en.danger ? "pm-danger" : ""}`} onClick={() => { onClose(); en.run(); }}>
          {en.icon && <span className="ic" aria-hidden>{en.icon}</span>}{en.label}{en.kbd && <kbd>{en.kbd}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// ── Move to…: pick a folder from the tree (or make one)

export function MoveDialog({ folders, moving, from, onMove, onCreate, onClose }: {
  folders: Folder[]; moving: string[]; from: string | null; onMove: (to: string | null) => void; onCreate: (name: string, parent: string | null) => Promise<string | null>; onClose: () => void;
}) {
  const [to, setTo] = useState<string | null>(from);
  const [name, setName] = useState("");
  const [making, setMaking] = useState(false);
  const movingFolders = new Set(moving.filter((k) => k.startsWith("f:")).map((k) => k.slice(2)));
  const blocked = (id: string) => { for (let cur: string | null = id, n = 0; cur && n < 64; n++) { if (movingFolders.has(cur)) return true; cur = folders.find((f) => f.id === cur)?.parent ?? null; } return false; };
  const tree: { f: Folder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => folders.filter((f) => f.parent === parent).sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => { tree.push({ f, depth }); walk(f.id, depth + 1); });
  walk(null, 0);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  const n = moving.length;
  return (
    <>
      <div className="scrim-modal" onClick={onClose} />
      <div className="modal fm-move" role="dialog" aria-modal="true" aria-labelledby="mv-title">
        <div className="row between"><h3 id="mv-title">Move {n === 1 ? "1 item" : `${n} items`} to…</h3>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <div className="fm-tree" role="listbox" aria-label="Folders">
          <button type="button" role="option" aria-selected={to === null} className={`fm-node ${to === null ? "on" : ""}`} onClick={() => setTo(null)}>
            <span className="fr-thumb fr-fold"><FolderIc size={15} weight="fill" /></span>All files{from === null && <span className="tiny dim">current</span>}</button>
          {tree.map(({ f, depth }) => (
            <button key={f.id} type="button" role="option" aria-selected={to === f.id} disabled={blocked(f.id)} className={`fm-node ${to === f.id ? "on" : ""}`} style={{ paddingLeft: 10 + (depth + 1) * 18 }}
              onClick={() => setTo(f.id)}>
              <CaretRight size={11} className="dim" aria-hidden /><span className={`fr-thumb fr-fold c-${f.color}`}><FolderIc size={15} weight="fill" /></span>
              <span className="ellipsis">{f.name}</span>{from === f.id && <span className="tiny dim">current</span>}
            </button>
          ))}
        </div>
        <form className="row" style={{ gap: 8, marginTop: 10, flexWrap: "nowrap" }} onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setMaking(true);
          const id = await onCreate(name.trim(), to);
          setMaking(false);
          if (id) { setTo(id); setName(""); }
        }}>
          <label htmlFor="mv-new" className="sr-only">New folder name</label>
          <input id="mv-new" value={name} onChange={(e) => setName(e.target.value)} placeholder={`New folder in ${to ? folders.find((f) => f.id === to)?.name : "All files"}`} maxLength={80} style={{ height: 34 }} />
          <button type="submit" className="ghost sm" disabled={making}><FolderPlus size={14} />Create</button>
        </form>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={() => onMove(to)} disabled={to === from}>Move here</button>
        </div>
        {to === from && <p className="tiny dim" style={{ margin: "8px 0 0", textAlign: "right" }}>Already in this folder: pick another.</p>}
      </div>
    </>
  );
}

/** A filter pill like "Type: All ▾" with its own menu of choices. */
export function FilterPill<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  const [at, setAt] = useState<Anchor | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const cur = options.find((o) => o[0] === value)?.[1] ?? "";
  const on = value !== options[0][0];
  return (
    <>
      <button ref={btn} type="button" className={`fpill ${on ? "on" : ""}`} aria-haspopup="menu" aria-expanded={!!at} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.top, w: r.width, h: r.height, align: "start" }); }}>
        <span className="fp-k">{label}:</span><span className="fp-v">{cur}</span><CaretDown size={11} weight="bold" className="fp-c" aria-hidden />
      </button>
      {at && <ContextMenu at={at} title={label} inside={btn} onClose={() => setAt(null)} entries={options.map(([v, l]) => ({ label: l, icon: v === value ? <Check size={14} weight="bold" /> : <span style={{ width: 14 }} />, run: () => onChange(v) }))} />}
    </>
  );
}

// ── the upload panel (bottom right, like Drive's): every file going up, its progress, done or failed

export type UpRow = { key: string; name: string; size: number; kind: MediaKind; progress: number; error?: string; done?: boolean; folder: string };

export function UploadPanel({ rows, onClose, onOpenFolder }: { rows: UpRow[]; onClose: () => void; onOpenFolder: (folderName: string) => void }) {
  const [small, setSmall] = useState(false);
  if (!rows.length) return null;
  const going = rows.filter((r) => !r.done && !r.error).length;
  const failed = rows.filter((r) => r.error).length;
  const bytes = rows.reduce((s, r) => s + r.size, 0), sent = rows.reduce((s, r) => s + r.size * (r.done ? 1 : r.progress), 0);
  const title = going ? `Uploading ${going} item${going === 1 ? "" : "s"}` : failed ? `${failed} upload${failed === 1 ? "" : "s"} failed` : `${rows.length} upload${rows.length === 1 ? "" : "s"} complete`;
  return (
    <section className={`fm-ups ${small ? "small" : ""}`} aria-label="Uploads" aria-live="polite">
      <header className="fu-h">
        <b>{title}</b>
        {going > 0 && <span className="tiny dim mono">{fmtSize(sent) || "0 KB"} of {fmtSize(bytes)}</span>}
        <span className="row" style={{ gap: 2, marginLeft: "auto", flexWrap: "nowrap" }}>
          <button className="icon-btn sm" aria-label={small ? "Show uploads" : "Hide uploads"} title={small ? "Show" : "Hide"} onClick={() => setSmall(!small)}><CaretDown size={14} weight="bold" style={{ transform: small ? "rotate(180deg)" : undefined }} /></button>
          {!going && <button className="icon-btn sm" aria-label="Close" title="Close" onClick={onClose}><X size={14} weight="bold" /></button>}
        </span>
      </header>
      {going > 0 && <div className="fu-bar"><i style={{ width: `${bytes ? (sent / bytes) * 100 : 0}%` }} /></div>}
      {!small && (
        <ul className="fu-list">
          {rows.map((r) => (
            <li key={r.key} className="fu-row">
              <span className={`fb-ic k-${r.kind}`} aria-hidden><KindIcon kind={r.kind} src="upload" size={14} weight="fill" /></span>
              <span className="fu-name">
                <span className="ellipsis">{r.name}</span>
                <span className="tiny dim">{r.error ? <span className="fu-err">{r.error}</span> : r.done ? <button className="fu-link" onClick={() => onOpenFolder(r.folder)}>In {r.folder}</button> : `${fmtSize(r.size * r.progress) || "0 KB"} of ${fmtSize(r.size)}`}</span>
              </span>
              {r.done ? <span className="fu-ok" role="img" aria-label="Uploaded"><Check size={13} weight="bold" /></span> : r.error ? <span className="fu-bad" role="img" aria-label="Failed"><X size={13} weight="bold" /></span> : <Ring value={r.progress} size={26} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "3 items moved to the trash · Undo", bottom left. */
export function Snack({ text, action, onAction, onClose }: { text: string; action?: string; onAction?: () => void; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 6500); return () => clearTimeout(t); }, [text, onClose]);
  return (
    <div className="fm-snack" role="status">
      <span>{text}</span>
      {action && <button className="fs-act" onClick={() => { onAction?.(); onClose(); }}>{action}</button>}
      <button className="icon-btn xs fs-x" aria-label="Dismiss" onClick={onClose}><X size={13} weight="bold" /></button>
    </div>
  );
}
