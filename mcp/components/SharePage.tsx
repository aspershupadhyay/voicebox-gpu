"use client";
// The page behind a share link (app/s/[token]): a carousel's photos in order, or a folder's files, for someone without
// an account. Read-only: look, step through, download (when the link allows it). Matte black like the studio.
import { CaretLeft, CaretRight, Cards, DownloadSimple, FileText, FilmStrip, FolderSimple, MusicNotes, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

type File = { id: string; name: string; kind: string; thumb: string | null; view: string | null; download: string | null; poster?: string | null; mb: number | null };
type Data = { name: string; kind: "carousel" | "folder"; expires: number; by: string; downloads: boolean; files: File[] } | null;

const left = (t: number) => { const h = Math.max(0, (t - Date.now()) / 3600_000); return h < 1 ? "less than an hour" : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`; };

export function SharePage({ data }: { data: Data }) {
  const [open, setOpen] = useState<number | null>(null);
  const files = data?.files ?? [];
  const step = useCallback((d: number) => setOpen((i) => (i == null ? i : (i + d + files.length) % files.length)), [files.length]);
  useEffect(() => {
    if (open == null) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); else if (e.key === "ArrowRight") step(1); else if (e.key === "ArrowLeft") step(-1); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [open, step]);
  if (!data) {
    return (
      <main className="sh sh-gone">
        <div className="sh-logo"><img src="/icon.svg" alt="" width={28} height={28} /><b>Voicebox</b></div>
        <h1>This link doesn&apos;t work any more</h1>
        <p className="dim">It ran out or was turned off. Ask whoever sent it for a new one.</p>
      </main>
    );
  }
  const f = open == null ? null : files[open];
  return (
    <main className="sh">
      <header className="sh-head">
        <div className="sh-logo"><img src="/icon.svg" alt="" width={24} height={24} /><b>Voicebox</b></div>
        <div className="sh-title">
          <span className="tiny dim row" style={{ gap: 6 }}>{data.kind === "carousel" ? <Cards size={13} weight="bold" /> : <FolderSimple size={13} weight="bold" />}{data.kind === "carousel" ? "Carousel" : "Folder"} · shared by {data.by.split(" ")[0]}</span>
          <h1>{data.name}</h1>
          <span className="tiny dim">{files.length} file{files.length === 1 ? "" : "s"} · this link works for {left(data.expires)}</span>
        </div>
      </header>
      {!files.length ? <p className="dim" style={{ padding: 24 }}>Nothing in here yet.</p> : (
        <ol className={`sh-grid ${data.kind === "carousel" ? "car" : ""}`}>
          {files.map((x, i) => (
            <li key={x.id}>
              <button type="button" className="sh-card" onClick={() => setOpen(i)} aria-label={`Open ${x.name}`}>
                {x.thumb ? <img src={x.thumb} alt="" loading={i < 8 ? "eager" : "lazy"} decoding="async" /> : <span className="sh-glyph">{x.kind === "video" ? <FilmStrip size={30} /> : x.kind === "audio" ? <MusicNotes size={30} /> : <FileText size={30} />}</span>}
                {data.kind === "carousel" && <span className="sh-num mono">{String(i + 1).padStart(2, "0")}</span>}
                {x.kind === "video" && <span className="sh-tag"><FilmStrip size={11} weight="bold" />Clip</span>}
              </button>
              <span className="sh-name ellipsis">{x.name}</span>
            </li>
          ))}
        </ol>
      )}
      {f && (
        <div className="sh-view" role="dialog" aria-modal="true" aria-label={f.name}>
          <div className="sh-view-top">
            <span className="ellipsis"><b>{f.name}</b> <span className="dim mono tiny">{open! + 1} / {files.length}</span></span>
            <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
              {f.download && <a className="vp-btn" href={f.download} aria-label="Download" title="Download" rel="noreferrer"><DownloadSimple size={19} /></a>}
              <button className="vp-btn" onClick={() => setOpen(null)} aria-label="Close (Esc)"><X size={20} /></button>
            </span>
          </div>
          <div className="sh-view-body" key={f.id}>
            {f.kind === "image" && f.view ? <img src={f.view} alt={f.name} /> :
              f.kind === "video" && f.view ? <video src={f.view} poster={f.poster ?? undefined} controls autoPlay playsInline /> :
              f.kind === "audio" && f.view ? <audio src={f.view} controls autoPlay /> :
              <div className="sh-other"><FileText size={40} /><b>{f.name}</b>{f.download ? <a className="btn sm" href={f.download}><DownloadSimple size={15} />Download</a> : <span className="dim small">No preview for this file</span>}</div>}
          </div>
          {files.length > 1 && <>
            <button className="fv-nav l" onClick={() => step(-1)} aria-label="Previous"><CaretLeft size={20} weight="bold" /></button>
            <button className="fv-nav r" onClick={() => step(1)} aria-label="Next"><CaretRight size={20} weight="bold" /></button>
          </>}
        </div>
      )}
    </main>
  );
}
