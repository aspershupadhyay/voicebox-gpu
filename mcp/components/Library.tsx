"use client";
import {
  CaretRight, ClosedCaptioning, DownloadSimple, FileZip, FilmSlate, FilmStrip, ImageSquare, MagnifyingGlass, Microphone, Play, Plus, Stop, TrashSimple, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, fileUrl, fmtS, matchClass, pct, type Gen, type GenImage } from "./api";
import { Info } from "./Info";
import { CassetteArt, VoiceGlyph } from "./art";
import LineRow, { coached, type Line } from "./LineRow";
import { useStatus } from "./Shell";
import { useDialog } from "./Dialog";

type LibJob = {
  id: string; kind?: "tts" | "transcribe" | "video" | "image"; engine: string; voice: string; label?: string; created: number; source?: string; language?: string | null;
  params?: Record<string, unknown>; style?: string; subs?: { cues: number; timeline: string } | null; match?: number | null; results: (Line & { audio?: string | null })[];
  video?: { width: number; height: number; duration: number; size: number; voice_job?: string; has_audio?: boolean }; video_url?: string; poster_url?: string | null;
  gen?: Gen; images?: GenImage[]; mode?: string; scenes?: { id: string; text: string; start: number; seconds: number }[];
};
type CardProps = { j: LibJob; open: boolean; selected: boolean; onSelect: (shift: boolean) => void; onDelete: () => void };

const Check = ({ selected, onSelect }: { selected: boolean; onSelect: (shift: boolean) => void }) => (
  <input type="checkbox" className="selbox" checked={selected} aria-label="Select" onClick={(e) => { e.stopPropagation(); onSelect(e.shiftKey); }} onChange={() => {}} />
);

function VideoCard({ j, open, selected, onSelect, onDelete }: CardProps) {
  const [isOpen, setOpen] = useState(true);
  useEffect(() => { if (open) setOpen(true); }, [open]);
  const slug = (j.label || j.id).replace(/[^A-Za-z0-9._-]/g, "_");
  const v = j.video;
  return (
    <div className={`card lib-card ${selected ? "selected" : ""}`} id={j.id}>
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
          <video className="vplayer" src={j.video_url} poster={j.poster_url ?? undefined} controls playsInline preload="metadata"
            style={{ aspectRatio: v ? `${v.width}/${v.height}` : undefined }} />
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

function ImageCard({ j, selected, onSelect, onDelete }: CardProps) {
  const slug = (j.label || j.id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const ims = j.images ?? [];
  return (
    <div className={`card lib-card ${selected ? "selected" : ""}`} id={j.id}>
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
          <Link className="btn ghost sm" href="/image"><ImageSquare size={14} />Image</Link>
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

function JobCard({ j, open, selected, onSelect, onDelete, onSubtitle }: CardProps & { onSubtitle: () => void }) {
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
    <div className={`card lib-card ${selected ? "selected" : ""}`} id={j.id}>
      <div className="lc-head" onClick={() => setOpen(!isOpen)}>
        <Check selected={selected} onSelect={onSelect} />
        <CaretRight size={14} weight="bold" className={`chev ${isOpen ? "open" : ""}`} />
        {asr ? <span className="thumb" style={{ color: "var(--glacier)" }}><ClosedCaptioning size={20} weight="duotone" /></span> : <VoiceGlyph name={j.voice || j.engine} size={40} active={playing >= 0} />}
        <div style={{ minWidth: 0 }}>
          <div className="lc-title">{j.label || <span className="quote-title">“{(j.results[0]?.text ?? j.id).replace(/<[^>]+>/g, "").slice(0, 70)}{(j.results[0]?.text?.length ?? 0) > 70 ? "…" : ""}”</span>}</div>
          <div className="lc-meta">
            {asr ? <span className="pill blue">subtitles</span> : <span className="pill">{j.engine} · {j.voice}</span>}
            {j.style && !asr && <span className="pill">{j.style}</span>}
            {j.subs && !asr && <span className="pill blue">CC · {j.subs.cues}</span>}
            {j.match != null && <span className={`pill ${matchClass(j.match)}`}>{pct(j.match)} match</span>}
            {over > 0 && <span className="pill bad">{over} over window</span>}
            <span className="dim tiny mono">{j.results.length} {asr ? "file" : "line"}{j.results.length === 1 ? "" : "s"} · {fmtS(total)} · {ago(j.created)}</span>
          </div>
        </div>
        <div className="lc-actions" onClick={(e) => e.stopPropagation()}>
          {!asr && <button className={playing >= 0 ? "sig sm" : "ghost sm"} onClick={() => (playing >= 0 ? setPlaying(-1) : playFrom(0))}>
            {playing >= 0 ? <><Stop size={13} weight="fill" />Stop</> : <><Play size={13} weight="fill" />Play all</>}</button>}
          {!asr && !j.subs && <button className="ghost sm" onClick={onSubtitle}><Plus size={13} weight="bold" />Subtitles</button>}
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

export default function Library() {
  const { status } = useStatus();
  const { confirm, toast } = useDialog();
  const [jobs, setJobs] = useState<LibJob[] | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [hash, setHash] = useState("");
  const [note, setNote] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);

  const load = () => api<{ jobs: LibJob[] }>("library").then((r) => setJobs(r.jobs)).catch((e) => setErr(e.message));
  useEffect(() => {
    const onHash = () => setHash(location.hash.slice(1));
    onHash(); load();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!hash || !jobs) return;
    const t = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 350); // let cards above expand first
    return () => clearTimeout(t);
  }, [hash, jobs]);

  const engines = useMemo(() => Array.from(new Set((jobs ?? []).filter((j) => !j.kind || j.kind === "tts").map((j) => j.engine))), [jobs]);
  const hasVideo = (jobs ?? []).some((j) => j.kind === "video");
  const hasImages = (jobs ?? []).some((j) => j.kind === "image");
  const shown = (jobs ?? []).filter((j) =>
    (filter === "all" || (filter === "videos" ? j.kind === "video" : filter === "images" ? j.kind === "image" : filter === "subtitles" ? j.kind === "transcribe" || (!!j.subs && j.kind !== "video") : (!j.kind || j.kind === "tts") && j.engine === filter)) &&
    (!q || `${j.label} ${j.voice} ${j.engine} ${j.results.map((r) => r.text).join(" ")}`.toLowerCase().includes(q.toLowerCase())));
  const shownIds = shown.map((j) => j.id);
  const selShown = shownIds.filter((id) => sel.has(id));
  const allShown = shownIds.length > 0 && selShown.length === shownIds.length;
  const someShown = selShown.length > 0 && !allShown;

  // drop selections that vanished (deleted elsewhere / reloaded)
  useEffect(() => { if (jobs) setSel((s) => new Set([...s].filter((id) => jobs.some((j) => j.id === id)))); }, [jobs]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input:not([type=checkbox]), textarea");
      if (e.key === "Escape" && sel.size && !document.querySelector(".modal")) setSel(new Set());
      if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && shownIds.length) { e.preventDefault(); setSel(new Set(shownIds)); }
      if (!typing && (e.key === "Delete" || e.key === "Backspace") && sel.size && !document.querySelector(".modal")) { e.preventDefault(); removeMany([...sel]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function toggle(id: string, shift: boolean) {
    setSel((prev) => {
      const next = new Set(prev);
      if (shift && anchor.current && shownIds.includes(anchor.current)) {
        // shift-click selects the whole range from the last clicked card
        const [a, b] = [shownIds.indexOf(anchor.current), shownIds.indexOf(id)].sort((x, y) => x - y);
        shownIds.slice(a, b + 1).forEach((x) => next.add(x));
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  }
  function toggleAll() {
    setSel((prev) => {
      const next = new Set(prev);
      if (allShown) shownIds.forEach((id) => next.delete(id));
      else shownIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function removeMany(ids: string[]) {
    const items = (jobs ?? []).filter((j) => ids.includes(j.id));
    if (!items.length) return;
    const files = items.reduce((n, j) => n + (j.kind === "video" ? 1 : j.kind === "image" ? (j.images?.length ?? 0) : j.results.length), 0);
    const one = items.length === 1;
    const ok = await confirm({
      danger: true,
      title: one ? `Delete "${items[0].label || items[0].id}"?` : `Delete ${items.length} items?`,
      body: (
        <>
          {one ? "This removes it and all of its files" : `This removes ${items.length} items (${files} files, plus their subtitles)`} from your private storage. It can&apos;t be undone.
          {!one && <ul>{items.slice(0, 50).map((j) => <li key={j.id}>{j.label || j.id}</li>)}{items.length > 50 && <li className="dim">…and {items.length - 50} more</li>}</ul>}
        </>
      ),
      confirm: one ? "Delete" : `Delete ${items.length}`,
    });
    if (!ok) return;
    setRemoving(new Set(ids));
    try {
      const r = one
        ? await api(`library/${ids[0]}`, { method: "DELETE" }).then(() => ({ deleted: ids, failed: [] as string[] }))
        : await api<{ deleted: string[]; failed: string[] }>("library", { method: "DELETE", body: { ids } });
      setJobs((js) => (js ?? []).filter((j) => !r.deleted.includes(j.id)));
      setSel((s) => new Set([...s].filter((id) => !r.deleted.includes(id))));
      if (r.failed.length) toast(`Deleted ${r.deleted.length}; ${r.failed.length} failed. Try again.`, "bad");
      else toast(one ? "Deleted." : `Deleted ${r.deleted.length} items.`, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setRemoving(new Set());
    }
  }
  async function subtitle(j: LibJob) {
    if (!status?.online) return toast("The GPU worker is offline. Start the Colab notebook first.", "bad");
    try {
      await api("jobs", { body: { kind: "transcribe", library: j.id, language: j.language || undefined } });
      setNote(`Subtitling "${j.label || j.id}"… it'll show a CC badge here when done (follow it on Overview).`);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Archive</div>
          <h1>The <em>library.</em></h1>
          <p className="sub">Every take, subtitle and render, kept privately. <Info>Stored in your R2 bucket, so it stays after the GPU shuts down.</Info></p>
        </div>
        <Link href="/generate" className="btn sig"><Microphone size={16} weight="bold" />New voiceover</Link>
      </div>
      <div className="filters">
        <div className="seg">
          {["all", ...(hasVideo ? ["videos"] : []), ...(hasImages ? ["images"] : []), ...engines, "subtitles"].map((e) => <button key={e} className={filter === e ? "on" : ""} style={{ textTransform: "capitalize" }} onClick={() => setFilter(e)}>{e}</button>)}
        </div>
        <div className="searchbox"><MagnifyingGlass size={16} className="ic" /><input placeholder="Search titles, voices, script text…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className="ghost sm" onClick={load}>Refresh</button>
      </div>

      {jobs && shown.length > 0 && (
        sel.size > 0 ? (
          <div className="selbar">
            <input type="checkbox" className="selbox" checked={allShown} ref={(el) => { if (el) el.indeterminate = someShown; }} onChange={toggleAll} aria-label="Select all shown" />
            <b>{sel.size} selected</b>
            {!allShown && <button className="quiet xs" onClick={toggleAll}>Select all {shownIds.length}</button>}
            <button className="quiet xs" onClick={() => setSel(new Set())}><X size={12} />Clear</button>
            <span className="faint tiny" style={{ flex: 1 }}>Shift-click selects a range · Esc clears</span>
            <button className="danger sm" disabled={removing.size > 0} onClick={() => removeMany([...sel])}>
              <TrashSimple size={14} weight="bold" />{removing.size ? "Deleting…" : `Delete ${sel.size}`}
            </button>
          </div>
        ) : (
          <label className="row tiny dim" style={{ gap: 10, margin: "0 0 12px 18px", cursor: "pointer", width: "fit-content" }}>
            <input type="checkbox" className="selbox" checked={false} onChange={toggleAll} aria-label="Select all shown" />
            Select all · {shown.length} shown
          </label>
        )
      )}

      {note && <div className="banner" style={{ borderColor: "rgba(124,196,212,.35)", background: "var(--glacier-soft)" }}><ClosedCaptioning size={20} weight="duotone" color="var(--glacier)" /><span>{note}</span></div>}
      {err && <p className="err">{err}</p>}
      {jobs === null && !err && <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="card" style={{ height: 72, opacity: 0.45 }} />)}</div>}
      {jobs && !shown.length && (
        <div className="empty"><CassetteArt /><b>{jobs.length ? "Nothing matches" : "The shelf is empty"}</b><span>{jobs.length ? "Try another filter or search." : "Record your first take and it lands here."}</span>
          {!jobs.length && <Link href="/generate" className="btn sig sm"><Microphone size={14} weight="bold" />Record a voiceover</Link>}</div>
      )}
      {shown.map((j) => (
        <div key={j.id} className={removing.has(j.id) ? "removing" : ""}>
          {j.kind === "image"
            ? <ImageCard j={j} open={hash === j.id} selected={sel.has(j.id)} onSelect={(sh) => toggle(j.id, sh)} onDelete={() => removeMany([j.id])} />
            : j.kind === "video"
            ? <VideoCard j={j} open={hash === j.id} selected={sel.has(j.id)} onSelect={(sh) => toggle(j.id, sh)} onDelete={() => removeMany([j.id])} />
            : <JobCard j={j} open={hash === j.id} selected={sel.has(j.id)} onSelect={(sh) => toggle(j.id, sh)} onDelete={() => removeMany([j.id])} onSubtitle={() => subtitle(j)} />}
        </div>
      ))}
    </>
  );
}
