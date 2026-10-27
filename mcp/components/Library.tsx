"use client";
// One generated item (a voiceover, subtitles, an image set or a video) in full: its player, lines, scores and downloads.
// The Files page opens these in its detail drawer (components/Files.tsx).
import {
  CaretRight, ClosedCaptioning, DownloadSimple, FileZip, FilmStrip, ImageSquare, Microphone, Play, Stop, TrashSimple,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ago, fileUrl, fmtS, matchClass, pct, type Gen, type GenImage } from "./api";
import { VoiceGlyph } from "./art";
import LineRow, { coached, type Line } from "./LineRow";
import { VideoPlayer } from "./players";

export type LibJob = {
  id: string; kind?: "tts" | "transcribe" | "video" | "image"; engine: string; voice: string; label?: string; created: number; source?: string; language?: string | null;
  params?: Record<string, unknown>; style?: string; subs?: { cues: number; timeline: string } | null; match?: number | null; results: (Line & { audio?: string | null })[];
  video?: { width: number; height: number; duration: number; size: number; voice_job?: string; has_audio?: boolean }; video_url?: string; poster_url?: string | null;
  gen?: Gen; images?: GenImage[]; mode?: string; scenes?: { id: string; text: string; start: number; seconds: number }[];
};
type CardProps = { j: LibJob; open: boolean; selected?: boolean; onSelect?: (shift: boolean) => void; onDelete: () => void };

const Check = ({ selected, onSelect }: { selected?: boolean; onSelect?: (shift: boolean) => void }) => !onSelect ? null : (
  <input type="checkbox" className="selbox" checked={selected} aria-label="Select" onClick={(e) => { e.stopPropagation(); onSelect(e.shiftKey); }} onChange={() => {}} />
);

export function VideoCard({ j, open, selected, onSelect, onDelete }: CardProps) {
  const [isOpen, setOpen] = useState(true);
  useEffect(() => { if (open) setOpen(true); }, [open]);
  const slug = (j.label || j.id).replace(/[^A-Za-z0-9._-]/g, "_");
  const v = j.video;
  return (
    <div className={`lib-card ${selected ? "selected" : ""}`} id={j.id}>
      <div className="lc-head" onClick={() => setOpen(!isOpen)}>
        <Check selected={selected} onSelect={onSelect} />
        <CaretRight size={14} weight="bold" className={`chev ${isOpen ? "open" : ""}`} />
        <span className="thumb">{j.poster_url ? <img src={j.poster_url} alt="" /> : <FilmStrip size={20} weight="duotone" />}</span>
        <div style={{ minWidth: 0 }}>
          <div className="lc-title">{j.label || j.id}</div>
          <div className="lc-meta">
            <span className="pill sig"><FilmStrip size={11} weight="bold" />{j.gen ? ({ ltx: "LTX-2.5", wan14: "Wan 14B", animate: "Wan Animate", story: "Script video" }[j.gen.model] ?? "Wan 2.2") : "video"}</span>
            {j.video?.has_audio && <span className="pill">sound</span>}
            {j.subs && <span className="pill blue">CC · {j.subs.cues}</span>}
            {v && <span className="dim tiny mono">{fmtS(v.duration)} · {ago(j.created)}</span>}
          </div>
        </div>
        <div className="lc-actions" onClick={(e) => e.stopPropagation()}>
          <a className="btn sm" href={fileUrl(j.id, "video.mp4", `${slug}.mp4`)}><DownloadSimple size={14} weight="bold" />MP4</a>
          <button className="icon-btn danger-h" onClick={onDelete} title="Delete" aria-label="Delete"><TrashSimple size={16} /></button>
        </div>
      </div>
      {isOpen && j.video_url && (
        <div className="video-wrap">
          <div className="vplayer">
            <VideoPlayer src={j.video_url} poster={j.poster_url} autoPlay={false} resumeKey={`g:${j.id}`} ratio={v?.width && v.height ? v.width / v.height : null} />
          </div>
          <div className="stack" style={{ gap: 18 }}>
            <dl className="facts">
              {j.gen ? <>
                <dt>Prompt</dt><dd className="small">{j.gen.prompt}</dd>
                <dt>Render</dt><dd className="mono">{j.gen.mode === "story" ? `${j.scenes?.length ?? 0} scenes · voice ${j.engine} · ${j.voice}` : j.gen.mode === "i2v" ? "from image" : "from text"} · seed {j.gen.seed}{j.gen.mode === "story" ? "" : ` · ${j.gen.steps} steps`}</dd>
                {j.gen.mode === "story" && <><dt>Extras</dt><dd className="row" style={{ gap: 8 }}>
                  <a className="btn ghost sm" href={fileUrl(j.id, "voiceover.wav", `${slug}-voiceover.wav`)}>voiceover.wav</a>
                  {j.subs && <a className="btn ghost sm" href={fileUrl(j.id, "subtitles.srt", `${slug}.srt`)}>.srt</a>}</dd></>}
              </> : <><dt>Voice</dt><dd><span style={{ textTransform: "capitalize" }}>{j.engine}</span> · {j.voice}</dd></>}
              {v && <><dt>Format</dt><dd className="mono">{v.width}×{v.height} · {fmtS(v.duration)} · {(v.size / 1e6).toFixed(1)} MB</dd></>}
              {j.subs && <><dt>Subtitles</dt><dd>{j.subs.cues} cues, timed to the video</dd></>}
              <dt>Made</dt><dd>{new Date(j.created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd>
            </dl>
            <div className="row">
              <a className="btn sig sm" href={fileUrl(j.id, "video.mp4", `${slug}.mp4`)}><DownloadSimple size={14} weight="bold" />Download MP4</a>
              {j.subs && <a className="btn ghost sm" href={fileUrl(j.id, "subtitles.srt", `${slug}.srt`)}><ClosedCaptioning size={14} />.srt</a>}
              {j.subs && <a className="btn ghost sm" href={fileUrl(j.id, "subtitles.vtt", `${slug}.vtt`)}>.vtt</a>}
              {v?.voice_job && <a className="btn quiet sm" href={`#${v.voice_job}`}><Microphone size={14} />Voice lines</a>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ImageCard({ j, selected, onSelect, onDelete }: CardProps) {
  const slug = (j.label || j.id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const ims = j.images ?? [];
  return (
    <div className={`lib-card ${selected ? "selected" : ""}`} id={j.id}>
      <div className="lc-head">
        <Check selected={selected} onSelect={onSelect} />
        <span className="thumb">{ims[0]?.thumb_url ? <img src={ims[0].thumb_url} alt="" /> : <ImageSquare size={20} weight="duotone" />}</span>
        <div style={{ minWidth: 0 }}>
          <div className="lc-title">{j.label || j.id}</div>
          <div className="lc-meta">
            <span className="pill sig"><ImageSquare size={11} weight="bold" />{j.gen?.model === "qwenimage" ? "Qwen-Image" : "Z-Image"}</span>
            <span className="dim tiny mono">{ims.length} image{ims.length === 1 ? "" : "s"} · {ims[0] ? `${ims[0].width}×${ims[0].height}` : ""} · {ago(j.created)}</span>
          </div>
        </div>
        <div className="lc-actions" onClick={(e) => e.stopPropagation()}>
          <Link className="btn ghost sm" href="/images"><ImageSquare size={14} />Images</Link>
          <button className="icon-btn danger-h" onClick={onDelete} title="Delete" aria-label="Delete"><TrashSimple size={16} /></button>
        </div>
      </div>
      <div className="feed-grid" style={{ ["--cols" as string]: Math.min(4, ims.length || 1), padding: "0 16px 16px" }}>
        {ims.map((im, i) => (
          <a key={im.file} className={`gen-card done ${im.transparent ? "checker" : ""}`} style={{ aspectRatio: `${im.width} / ${im.height}` }}
            href={fileUrl(j.id, im.file, `${slug}-${i + 1}.png`)} title="Download PNG">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={im.thumb_url ?? im.url} alt="" loading="lazy" />
          </a>
        ))}
      </div>
    </div>
  );
}

export function JobCard({ j, open, selected, onSelect, onDelete, onSubtitle }: CardProps & { onSubtitle: () => void }) {
  const players = useRef<(() => void)[]>([]);
  const [playing, setPlaying] = useState(-1);
  const [isOpen, setOpen] = useState(open);
  useEffect(() => { if (open) setOpen(true); }, [open]);
  const total = j.results.reduce((s, r) => s + r.duration, 0);
  const longest = Math.max(0.1, ...j.results.map((r) => r.duration));
  const over = j.results.filter((r) => r.fits === false).length;
  const slug = (j.label || `${j.engine}-${j.voice}`).replace(/[^A-Za-z0-9._-]/g, "_");
  const asr = j.kind === "transcribe";

  function playFrom(i: number) {
    if (i >= j.results.length) return setPlaying(-1);
    setOpen(true); setPlaying(i);
    setTimeout(() => players.current[i]?.(), 30);
  }

  return (
    <div className={`lib-card ${selected ? "selected" : ""}`} id={j.id}>
      <div className="lc-head" onClick={() => setOpen(!isOpen)}>
        <Check selected={selected} onSelect={onSelect} />
        <CaretRight size={14} weight="bold" className={`chev ${isOpen ? "open" : ""}`} />
        {asr ? <span className="thumb" style={{ color: "var(--glacier)" }}><ClosedCaptioning size={20} weight="duotone" /></span>
          : <button className={`lc-play ${playing >= 0 ? "on" : ""}`} aria-label={playing >= 0 ? "Stop" : "Play all"} onClick={(e) => { e.stopPropagation(); if (playing >= 0) setPlaying(-1); else playFrom(0); }}>
              <VoiceGlyph name={j.voice || j.engine} size={40} active={playing >= 0} />
              <span className="lc-play-ic">{playing >= 0 ? <Stop size={14} weight="fill" /> : <Play size={14} weight="fill" />}</span></button>}
        <div style={{ minWidth: 0 }}>
          <div className="lc-title">{j.label || <span className="quote-title">“{(j.results[0]?.text ?? j.id).replace(/<[^>]+>/g, "").slice(0, 70)}{(j.results[0]?.text?.length ?? 0) > 70 ? "…" : ""}”</span>}</div>
          <div className="lc-meta">
            {asr ? <span className="pill blue">subtitles</span> : <span className="pill">{j.engine} · {j.voice}</span>}
            {j.subs && !asr && <span className="pill blue">CC · {j.subs.cues}</span>}
            {j.match != null && <span className={`pill ${matchClass(j.match)}`}>{pct(j.match)} match</span>}
            {over > 0 && <span className="pill bad">{over} over window</span>}
            <span className="dim tiny mono">{j.results.length} {asr ? "file" : "line"}{j.results.length === 1 ? "" : "s"} · {fmtS(total)} · {ago(j.created)}</span>
          </div>
        </div>
        <div className="lc-actions" onClick={(e) => e.stopPropagation()}>
          {!asr && !j.subs && <button className="icon-btn" onClick={onSubtitle} title="Add subtitles" aria-label="Add subtitles"><ClosedCaptioning size={17} /></button>}
          {j.subs && <a className="btn quiet sm" href={fileUrl(j.id, "subtitles.srt", `${slug}.srt`)} title="Timeline subtitles">.srt</a>}
          <a className="icon-btn btn" href={`/api/zip/${j.id}`} title="Download everything (zip)" aria-label="Download zip"><FileZip size={17} /></a>
          <button className="icon-btn danger-h" onClick={onDelete} title="Delete" aria-label="Delete"><TrashSimple size={16} /></button>
        </div>
      </div>
      {isOpen && (
        <div className="lc-body">
          {j.results.map((r, i) => (
            <LineRow key={r.id} jobId={j.id} line={r} audio={r.audio} slug={slug} scale={r.duration / longest}
              playRef={(fn) => { players.current[i] = fn; }} onEnded={playing === i ? () => playFrom(i + 1) : undefined}
              rate={!j.mode && coached(j.engine, j.voice) ? { engine: j.engine, voice: j.voice } : null} />
          ))}
          {j.params && Object.keys(j.params).length > 0 && <p className="faint tiny mono" style={{ margin: "10px 0 0" }}>{Object.entries(j.params).map(([k, v]) => `${k} ${v}`).join("  ·  ")}</p>}
        </div>
      )}
    </div>
  );
}
