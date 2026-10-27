"use client";
// The full-screen file viewer (Files): photos with zoom, video and audio in the big players (components/players.tsx),
// PDFs, Word files, spreadsheets, CSV and text read in place (components/docview.tsx), anything else with its details
// and a download. ← → (or the side arrows) step through the files in the folder; Escape or the backdrop closes it.
import { ArrowSquareOut, CaretLeft, CaretRight, DownloadSimple, FilePpt, Paperclip, TrashSimple, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { MediaKind } from "@/lib/workspace";
import { docKind, DocxView, PdfView, SheetView, TextView } from "./docview";
import { AudioStage, VideoPlayer } from "./players";

export type ViewFile = {
  key: string; name: string; kind: MediaKind; mime?: string | null; size?: number | null; url: string; download: string;
  poster?: string | null; by?: string | null; at?: number | null;
};

const fmtSize = (b?: number | null) => (!b ? "" : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

/** A photo: fits the screen; click (or double-tap) to see it at full size and drag around; the wheel zooms. */
function Photo({ src, name }: { src: string; name: string }) {
  const [z, setZ] = useState(1);
  const [p, setP] = useState({ x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  useEffect(() => { setZ(1); setP({ x: 0, y: 0 }); setLoaded(false); }, [src]);
  return (
    <div className={`fv-photo ${z > 1 ? "zoomed" : ""}`}
      onWheel={(e) => { const nz = Math.min(6, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); setZ(nz); if (nz === 1) setP({ x: 0, y: 0 }); }}
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, px: p.x, py: p.y, moved: false }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => { const d = drag.current; if (!d || z === 1) return; if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true; setP({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) }); }}
      onPointerUp={() => { const d = drag.current; drag.current = null; if (d && !d.moved) { if (z > 1) { setZ(1); setP({ x: 0, y: 0 }); } else setZ(2.2); } }}>
      {!loaded && <span className="vp-spin" />}
      <img src={src} alt={name} draggable={false} onLoad={() => setLoaded(true)} style={{ transform: `translate(${p.x}px, ${p.y}px) scale(${z})`, opacity: loaded ? 1 : 0 }} />
    </div>
  );
}

function Stage({ f }: { f: ViewFile }) {
  if (f.kind === "image") return <Photo src={f.url} name={f.name} />;
  if (f.kind === "video") return <div className="fv-video"><VideoPlayer key={f.url} src={f.url} poster={f.poster} title={f.name} resumeKey={f.key} globalKeys /></div>;
  if (f.kind === "audio") return <div className="fv-audio"><AudioStage key={f.url} src={f.url} title={f.name} size={f.size} sub={[fmtSize(f.size), f.by].filter(Boolean).join(" · ")} /></div>;
  const dk = docKind(f.name, f.mime);
  if (dk === "pdf") return <PdfView key={f.url} url={f.url} />;
  if (dk === "docx") return <DocxView key={f.url} url={f.url} />;
  if (dk === "sheet") return <SheetView key={f.url} url={f.url} name={f.name} />;
  if (dk === "text") return <TextView key={f.url} url={f.url} name={f.name} />;
  const Ic = dk === "pptx" ? FilePpt : Paperclip;
  return (
    <div className="fv-other">
      <span className="fv-big"><Ic size={44} weight="duotone" /></span>
      <b>{f.name}</b>
      <span className="dim small">{[f.name.includes(".") ? `${f.name.split(".").pop()!.toUpperCase()} file` : f.mime, fmtSize(f.size)].filter(Boolean).join(" · ")}</span>
      <p className="dim small">{dk === "pptx" ? "Slides can't be shown here yet. Download to open them in PowerPoint, Keynote or Google Slides." : "There's no preview for this kind of file."}</p>
      <a className="btn sm" href={f.download}><DownloadSimple size={15} weight="bold" />Download</a>
    </div>
  );
}

export function FileViewer({ file, onClose, onPrev, onNext, onDelete, index, total, extra }: {
  file: ViewFile; onClose: () => void; onPrev?: () => void; onNext?: () => void; onDelete?: () => void; index?: number; total?: number; extra?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; back?.focus?.(); };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".modal, .vp-menu")) { if (document.fullscreenElement) return; e.preventDefault(); onClose(); return; }
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      // the players take ← → for seeking; PageUp/PageDown always step
      const media = file.kind === "video" || file.kind === "audio";
      if ((e.key === "ArrowLeft" && !media) || e.key === "PageUp") { if (onPrev) { e.preventDefault(); onPrev(); } }
      if ((e.key === "ArrowRight" && !media) || e.key === "PageDown") { if (onNext) { e.preventDefault(); onNext(); } }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [file.kind, onClose, onPrev, onNext]);
  const meta = [fmtSize(file.size), file.by, file.at ? new Date(file.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null].filter(Boolean).join(" · ");
  return (
    <div className="fv" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={file.name}>
      <div className="fv-back" onClick={onClose} />
      <div className="fv-top">
        <div className="fv-name">
          <b className="ellipsis">{file.name}</b>
          <span className="ellipsis">{meta}{total && total > 1 ? ` · ${index! + 1} of ${total}` : ""}</span>
        </div>
        <div className="fv-acts">
          {extra}
          <a className="vp-btn" href={file.url} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab"><ArrowSquareOut size={19} /></a>
          <a className="vp-btn" href={file.download} aria-label="Download" title="Download"><DownloadSimple size={19} /></a>
          {onDelete && <button className="vp-btn" onClick={onDelete} aria-label="Move to the trash" title="Move to the trash"><TrashSimple size={19} /></button>}
          <button className="vp-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)"><X size={20} /></button>
        </div>
      </div>
      <div className={`fv-stage k-${file.kind}`} key={file.key}><Stage f={file} /></div>
      {onPrev && <button className="fv-nav l" onClick={onPrev} aria-label="Previous file"><CaretLeft size={22} weight="bold" /></button>}
      {onNext && <button className="fv-nav r" onClick={onNext} aria-label="Next file"><CaretRight size={22} weight="bold" /></button>}
    </div>
  );
}
