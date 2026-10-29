"use client";
// The upload overlay (Files): one place to add things three ways, choose files (or a folder), drop them anywhere, or
// paste a photo or a link. Opened by Upload ("pick"); the same scene takes over the page while files are dragged in
// ("drag", no pointer events: the page takes the drop). Escape and a click outside close it. Styles under "upload
// overlay" in app/globals.css; motion stops for people who ask for less.
import { ClipboardText, FolderSimple, LinkSimple, UploadSimple, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const PX = 10; // the pixel strip's squares

/** The scene: three file cards over a tray; while dragging they drop in one after another. */
function Scene({ drag }: { drag: boolean }) {
  return (
    <div className={`up-scene ${drag ? "drag" : ""}`} aria-hidden>
      <span className="up-card c1"><i /><i /><i /></span>
      <span className="up-card c2"><i /><i /></span>
      <span className="up-card c3"><i /><i /><i /></span>
      <span className="up-tray"><UploadSimple size={20} weight="bold" /></span>
      <span className="up-px">{Array.from({ length: PX }, (_, i) => <i key={i} style={{ animationDelay: `${i * 90}ms` }} />)}</span>
    </div>
  );
}

export function UploadOverlay({ mode, where, count = 0, onClose, onFiles, onLink }: {
  mode: "pick" | "drag"; where: string; count?: number; onClose: () => void; onFiles: (files: File[]) => void; onLink: (url: string) => void;
}) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const drag = mode === "drag";
  const close = () => { setLeaving(true); setTimeout(onClose, 160); };
  const send = (f: File[]) => { if (f.length) { onFiles(f); close(); } };
  const okUrl = /^https?:\/\/\S+\.\S+/i.test(url.trim());

  useEffect(() => {
    if (drag) return;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    // a paste anywhere while it's open: photos upload, a link is added (typing in the link box pastes as usual)
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input")) return;
      const f = [...(e.clipboardData?.files ?? [])];
      if (f.length) { e.preventDefault(); e.stopImmediatePropagation(); send(f); return; }
      const t = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      if (/^https?:\/\/\S+$/i.test(t)) { e.preventDefault(); e.stopImmediatePropagation(); onLink(t); close(); }
    };
    addEventListener("keydown", onKey);
    addEventListener("paste", onPaste, true);
    return () => { removeEventListener("keydown", onKey); removeEventListener("paste", onPaste, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  const mod = isMac() ? "⌘" : "Ctrl+";
  return (
    <div className={`up-ov ${drag ? "is-drag" : ""} ${leaving ? "out" : ""}`} role={drag ? undefined : "dialog"} aria-modal={drag ? undefined : true} aria-label="Add files"
      onClick={drag ? undefined : (e) => { if (e.target === e.currentTarget) close(); }}
      onDragOver={drag ? undefined : (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={drag ? undefined : (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={drag ? undefined : (e) => { e.preventDefault(); e.stopPropagation(); setOver(false); send([...e.dataTransfer.files]); }}>
      <div className={`up-panel ${drag || over ? "hot" : ""}`} ref={box} tabIndex={-1}>
        <span className="up-br tl" /><span className="up-br tr" /><span className="up-br bl" /><span className="up-br br" />
        {!drag && <button type="button" className="icon-btn up-x" onClick={close} aria-label="Close (Esc)" title="Close (Esc)"><X size={18} /></button>}
        <span className="up-kick mono">{drag ? `INCOMING${count ? ` · ${String(count).padStart(2, "0")}` : ""}` : "UPLOAD"}</span>
        <Scene drag={drag || over} />
        <h2 className="up-title">{drag || over ? (count > 1 ? `Drop ${count} files to upload` : count === 1 ? "Drop the file to upload" : "Drop to upload") : "Add files"}</h2>
        <p className="up-sub">{drag || over ? <>They go to <b>{where}</b>.</> : <>Photos, videos, audio and documents, up to 2 GB each. They go to <b>{where}</b>.</>}</p>
        {!drag && (
          <>
            <div className="up-acts">
              <button type="button" onClick={() => files.current?.click()}><UploadSimple size={16} weight="bold" />Choose files</button>
              <button type="button" className="ghost" onClick={() => folder.current?.click()}><FolderSimple size={16} />Choose a folder</button>
            </div>
            <form className="up-link" onSubmit={(e) => { e.preventDefault(); if (okUrl) { onLink(url.trim()); close(); } }}>
              <LinkSimple size={16} aria-hidden />
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Or paste a link to a photo or video…" aria-label="Add from a link" inputMode="url" />
              <button type="submit" className="ghost sm" disabled={!okUrl}>Add</button>
            </form>
            <ul className="up-ways" aria-label="Ways to add">
              <li><i className="up-dot" />Drop files anywhere on the page</li>
              <li><ClipboardText size={14} aria-hidden /><kbd>{mod}V</kbd> pastes a photo or a link</li>
            </ul>
            <input ref={files} type="file" multiple hidden onChange={(e) => { send([...(e.target.files ?? [])]); e.target.value = ""; }} />
            <input ref={folder} type="file" multiple hidden {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => { send([...(e.target.files ?? [])].filter((f) => !f.name.startsWith("."))); e.target.value = ""; }} />
          </>
        )}
      </div>
    </div>
  );
}
