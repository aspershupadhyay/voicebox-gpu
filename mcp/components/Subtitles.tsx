"use client";
import { ArrowSquareOut, ClosedCaptioning, FileAudio, Plus, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, fileUrl, fmtS, pct, uploadFile, type Job, type Word } from "./api";
import { Info } from "./Info";
import { CaptionArt, VoiceGlyph } from "./art";
import { GuideButton } from "./GuideDrawer";
import { LANGUAGES } from "./guides";
import JobProgress from "./JobProgress";
import { useResumeJob } from "./jobs";
import Player from "./Player";
import Recorder from "./Recorder";
import { useStatus } from "./Shell";
import { PageHeader } from "./ui";

type Item = { file: File; id: string; frac: number; url: string };
type Lib = { id: string; kind?: string; engine: string; voice: string; label?: string; subs?: unknown; created?: number; results: { duration: number; audio?: string | null }[] };

const safeId = (name: string, taken: Set<string>) => {
  let base = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "file";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
};

function Result({ jobId, id, name, src, heard, duration, match }: { jobId: string; id: string; name: string; src?: string; heard: string; duration: number; match?: number | null }) {
  const [words, setWords] = useState<Word[] | null>(null);
  const [cues, setCues] = useState<{ s: number; e: number; text: string }[]>([]);
  useEffect(() => {
    fetch(fileUrl(jobId, `${id}.subs.json`)).then((r) => r.json()).then((j) => { setWords(j.words); setCues(j.cues); }).catch(() => {});
  }, [jobId, id]);
  return (
    <div className="card reveal">
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 12 }}><span className="thumb"><FileAudio size={20} /></span>
          <div><b>{name}</b><div className="dim tiny mono">{fmtS(duration)} · {cues.length} cues · {words?.length ?? "…"} words{match != null ? ` · match ${pct(match)}` : ""}</div></div></div>
        <div className="dl">
          {["srt", "vtt", "json"].map((x) => <a key={x} href={fileUrl(jobId, `${id}.subs.${x}`, `${id}.${x}`)}>.{x}</a>)}
        </div>
      </div>
      {src ? <Player src={src} words={words} duration={duration} /> : <div className="words">{heard}</div>}
      {cues.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="dim small" style={{ cursor: "pointer" }}>{cues.length} subtitle cues</summary>
          <table className="table small" style={{ marginTop: 8 }}><tbody>
            {cues.map((c, i) => <tr key={i}><td className="mono dim" style={{ width: 150, whiteSpace: "nowrap" }}>{c.s.toFixed(2)} → {c.e.toFixed(2)}</td><td>{c.text}</td></tr>)}
          </tbody></table>
        </details>
      )}
    </div>
  );
}

export default function Subtitles() {
  const { status } = useStatus();
  const [mode, setMode] = useState<"upload" | "record" | "library">("upload");
  const [libQ, setLibQ] = useState("");
  const forget = useRef<(() => void) | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [lang, setLang] = useState("");
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState("");
  const [lib, setLib] = useState<Lib[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { api<{ jobs: Lib[] }>("library").then((r) => setLib(r.jobs.filter((j) => j.kind !== "transcribe"))).catch(() => {}); return () => { if (timer.current) clearTimeout(timer.current); }; }, []);

  function add(files: FileList | null) {
    if (!files) return;
    const taken = new Set(items.map((i) => i.id));
    setItems([...items, ...Array.from(files).filter((f) => /^(audio|video)\//.test(f.type) || /\.(wav|mp3|m4a|aac|flac|ogg|opus|mp4|mov|mkv|webm)$/i.test(f.name))
      .map((f) => ({ file: f, id: safeId(f.name, taken), frac: 0, url: URL.createObjectURL(f) }))]);
  }

  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !j.library)) timer.current = setTimeout(() => poll(id), 1500);
    } catch (e) { setErr((e as Error).message); timer.current = setTimeout(() => poll(id), 4000); }
  }

  async function start() {
    setErr(""); setJob(null); setUploading(true);
    try {
      const done = await Promise.all(items.map(async (it, i) => {
        const key = await uploadFile(it.file, `${it.id}${it.file.name.match(/\.[^.]+$/)?.[0] ?? ""}`,
          (f) => setItems((cur) => cur.map((x, k) => (k === i ? { ...x, frac: f } : x))));
        return { id: it.id, name: it.file.name, blob: key };
      }));
      setUploading(false);
      const j = await api<Job>("jobs", { body: { kind: "transcribe", sources: done, language: lang || undefined, label: items.length === 1 ? items[0].file.name : `${items.length} files` } });
      setJob(j);
      forget.current?.(); forget.current = null;
      timer.current = setTimeout(() => poll(j.id), 800);
    } catch (e) { setUploading(false); setErr((e as Error).message); }
  }

  async function fromLibrary(id: string) {
    setErr(""); setJob(null);
    try {
      const j = await api<Job>("jobs", { body: { kind: "transcribe", library: id, language: lang || undefined } });
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 800);
    } catch (e) { setErr((e as Error).message); }
  }

  useResumeJob<Job>(["transcribe"], (j) => { setJob(j); timer.current = setTimeout(() => poll(j.id), 300); });
  const totalUp = items.length ? items.reduce((s, i) => s + i.frac, 0) / items.length : 0;
  const busy = uploading || (!!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library)));
  const local = (id: string) => items.find((i) => i.id === id)?.url;

  return (
    <>
      <PageHeader title="Subtitles" sub="Word-timed subtitles for any audio or video, in 99 languages."
        actions={<GuideButton engine="whisper" label="Subtitle guide" />} />
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="seg lg" role="radiogroup" aria-label="Source">
          <button role="radio" aria-checked={mode === "upload"} className={mode === "upload" ? "on" : ""} onClick={() => setMode("upload")}>Upload files</button>
          <button role="radio" aria-checked={mode === "record"} className={mode === "record" ? "on" : ""} onClick={() => setMode("record")}>Record</button>
          <button role="radio" aria-checked={mode === "library"} className={mode === "library" ? "on" : ""} onClick={() => setMode("library")}>From your voiceovers</button>
        </div>
        <div style={{ flex: 1 }} />
        <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)} style={{ width: 240, maxWidth: "100%" }}>
          <option value="">Auto-detect language</option>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
      </div>

      {mode === "record" ? (
        <div className="card">
          <div className="card-head"><h2>Record, then subtitle it</h2></div>
          <Recorder scope="subtitles" onReady={(f, fg) => { forget.current = fg ?? null; setItems(f ? [{ file: f, id: "recording", frac: 0, url: URL.createObjectURL(f) }] : []); }} />
          {items.length > 0 && (
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              <button disabled={busy || !status?.online} onClick={start} title={!status?.online ? "Start the GPU first (GPU & engines)" : undefined}><ClosedCaptioning size={16} weight="bold" />{status?.online ? "Make subtitles" : "Start the GPU first"}</button>
            </div>
          )}
        </div>
      ) : mode === "upload" ? (
        <div>
          <div className={`drop ${over ? "over" : ""}`} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }} onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
            <CaptionArt />
            <b>Drop audio or video here</b>
            <span>or <u>choose files</u> · wav, mp3, m4a, flac, mp4, mov · any length</span>
            <span className="tiny">Uploads go straight to your private storage.</span>
            <input ref={input} type="file" multiple accept="audio/*,video/*" hidden onChange={(e) => add(e.target.files)} />
          </div>
          {items.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              {items.map((it, i) => (
                <div key={it.id} className="row" style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
                  <FileAudio size={18} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.file.name}</span>
                  <span className="mono dim tiny">{(it.file.size / 1024 / 1024).toFixed(1)} MB</span>
                  <div className="bar thin" style={{ width: 120 }}><i style={{ width: `${it.frac * 100}%` }} /></div>
                  <button className="icon-btn" disabled={busy} onClick={() => setItems(items.filter((_, k) => k !== i))} aria-label="Remove"><X size={14} /></button>
                </div>
              ))}
              <div className="row between" style={{ marginTop: 14 }}>
                <span className="dim small">{items.length} file{items.length === 1 ? "" : "s"} · {(items.reduce((s, i) => s + i.file.size, 0) / 1024 / 1024).toFixed(1)} MB</span>
                <button disabled={busy || !status?.online} onClick={start} title={!status?.online ? "Start the GPU first (GPU & engines)" : undefined}><ClosedCaptioning size={16} weight="bold" />{status?.online ? "Make subtitles" : "Start the GPU first"}</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="card-head"><h2>Your generated voiceovers</h2>
            <input value={libQ} onChange={(e) => setLibQ(e.target.value)} placeholder="Search" aria-label="Search your voiceovers" style={{ width: 200 }} /></div>
          {(() => {
            const shown = lib.filter((j) => j.kind !== "video" && (!libQ || `${j.label ?? ""} ${j.voice} ${j.engine}`.toLowerCase().includes(libQ.toLowerCase())));
            if (!shown.length) return <div className="empty"><ClosedCaptioning size={30} weight="duotone" /><b>No voiceovers yet</b><span>Make one in Voiceover, then subtitle it here.</span></div>;
            return shown.map((j) => (
              <div key={j.id} className="list-row" style={{ gridTemplateColumns: "40px minmax(0,1fr) minmax(0, 220px) auto" }}>
                <VoiceGlyph name={j.voice || j.engine} size={40} />
                <div style={{ minWidth: 0 }}><div className="t1">{j.label || j.id}</div>
                  <div className="t2">{j.engine} · {j.voice} · {j.results.length} line{j.results.length === 1 ? "" : "s"} · {fmtS(j.results.reduce((a, r) => a + r.duration, 0))}{j.subs ? " · has subtitles" : ""}</div></div>
                <div style={{ minWidth: 0 }}>{j.results[0]?.audio && <Player src={j.results[0].audio} compact />}</div>
                <button className="ghost sm" disabled={busy || !status?.online} onClick={() => fromLibrary(j.id)}><Plus size={14} weight="bold" />{j.subs ? "Make again" : "Subtitles"}</button>
              </div>
            ));
          })()}
        </div>
      )}
      {err && <p className="err" role="alert">{err}</p>}

      {(uploading || job) && <div style={{ marginTop: 16 }}><JobProgress job={job} uploading={uploading} uploadFrac={totalUp} onCancel={() => job && api(`jobs/${job.id}/cancel`, { body: {} })} /></div>}

      {job?.library && job.kind === "transcribe" && (
        <div className="stack" style={{ gap: 14, marginTop: 16 }}>
          {mode === "library" || (job as Job & { attach_to?: string }).attach_to ? (
            <div className="card row between"><span className="row"><ClosedCaptioning size={20} color="var(--ok)" />Subtitles attached to the voiceover.</span><Link className="btn sm" href={`/files#${job.library.id}`}><ArrowSquareOut size={14} />Open in Files</Link></div>
          ) : (
            <>
              {job.results.length > 1 && (
                <div className="card row between"><span><b>All files</b> <span className="dim small">· one combined timeline</span></span>
                  <div className="row">{["srt", "vtt"].map((x) => <a key={x} className="btn ghost sm" href={fileUrl(job.id, `subtitles.${x}`, `subtitles.${x}`)}>.{x}</a>)}</div></div>
              )}
              {job.results.map((r) => <Result key={r.id} jobId={job.id} id={r.id} name={r.name ?? r.id} src={local(r.id)} heard={r.heard ?? ""} duration={r.duration} match={r.match} />)}
            </>
          )}
        </div>
      )}
    </>
  );
}
