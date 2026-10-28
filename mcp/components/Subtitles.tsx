"use client";
// Subtitles: word-timed subtitles for any audio or video, in 99 languages. The files (or a recording, or one of your
// voiceovers) on the canvas; the language and the button in the panel on the right.
import { ArrowSquareOut, ClosedCaptioning, FileAudio, Plus, Power, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, fileUrl, fmtS, pct, uploadFile, type Job, type Word } from "./api";
import { VoiceGlyph } from "./art";
import { GuideButton } from "./GuideDrawer";
import { LANGUAGES } from "./guides";
import JobProgress from "./JobProgress";
import { useResumeJob } from "./jobs";
import Player from "./Player";
import { Select } from "./pop";
import Recorder from "./Recorder";
import { useReleaseBlobs } from "./blobs";
import { useStatus } from "./Shell";
import { DropZone, Empty, Notice, SideRow, ToolPage } from "./ui";

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
    <div className="lines-box pad reveal">
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
  useReleaseBlobs(items.map((i) => i.url));
  const [lang, setLang] = useState("");
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState("");
  const [lib, setLib] = useState<Lib[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { api<{ jobs: Lib[] }>("library").then((r) => setLib(r.jobs.filter((j) => j.kind !== "transcribe"))).catch(() => {}); return () => { if (timer.current) clearTimeout(timer.current); }; }, []);

  function add(files: File[]) {
    const taken = new Set(items.map((i) => i.id));
    setItems([...items, ...files.filter((f) => /^(audio|video)\//.test(f.type) || /\.(wav|mp3|m4a|aac|flac|ogg|opus|mp4|mov|mkv|webm)$/i.test(f.name))
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
    if (!items.length) return setErr(mode === "record" ? "Record something first." : "Add a file first.");
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
  const offline = !!status && !status.online;
  const pick = (m: typeof mode) => { setMode(m); if (m !== "upload") setItems([]); };

  return (
    <ToolPage title="Subtitles" sub="Word-timed subtitles for any audio or video, in 99 languages."
      actions={<GuideButton engine="whisper" label="Subtitle guide" />}
      notice={offline && <Notice icon={<WarningCircle size={18} weight="bold" />} tone="warn" action={<Link href="/settings?tab=gpu" className="btn sm"><Power size={14} weight="bold" />Start the GPU</Link>}><b>The GPU is off.</b> Add your files now; subtitling needs the GPU.</Notice>}
      side={
        <>
          <SideRow label="Language" htmlFor="sub-lang" info="Auto-detect works for most recordings. Pick the language when a file mixes languages or starts with music.">
            <Select id="sub-lang" value={lang} onChange={setLang} options={[{ value: "", label: "Auto-detect" }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.name }))]} />
          </SideRow>
          <div className="set-row">
            <div className="sr-h">What you get</div>
            <p className="small dim" style={{ margin: 0 }}>SRT and VTT files plus word timings (JSON) for every file, and one combined timeline when you add several.</p>
          </div>
          <div className="tool-go">
            {offline ? <Link href="/settings?tab=gpu" className="btn block"><Power size={15} weight="bold" />Start the GPU</Link>
              : mode === "library" ? <span className="small dim">Pick a voiceover on the left and press Subtitles.</span>
              : <button className="block" onClick={start} disabled={busy || !status}><ClosedCaptioning size={16} weight="bold" />{busy ? "Working…" : `Make subtitles${items.length > 1 ? ` for ${items.length} files` : ""}`}</button>}
          </div>
        </>
      }>
      <div className="tool-canvas">
        <div className="seg" role="radiogroup" aria-label="Source">
          <button role="radio" aria-checked={mode === "upload"} className={mode === "upload" ? "on" : ""} onClick={() => pick("upload")}>Upload</button>
          <button role="radio" aria-checked={mode === "record"} className={mode === "record" ? "on" : ""} onClick={() => pick("record")}>Record</button>
          <button role="radio" aria-checked={mode === "library"} className={mode === "library" ? "on" : ""} onClick={() => pick("library")}>Your voiceovers</button>
        </div>

        {mode === "record" ? (
          <Recorder scope="subtitles" onReady={(f, fg) => { forget.current = fg ?? null; setItems(f ? [{ file: f, id: "recording", frac: 0, url: URL.createObjectURL(f) }] : []); }} />
        ) : mode === "upload" ? (
          <>
            <DropZone icon={<UploadSimple size={22} />} title="Drop audio or video here" hint="or click to choose · wav, mp3, m4a, flac, mp4, mov · any length, as many as you like" accept="audio/*,video/*" multiple onFiles={add} />
            {items.length > 0 && (
              <div className="lib-list">
                {items.map((it, i) => (
                  <div key={it.id} className="file-row">
                    <FileAudio size={18} aria-hidden />
                    <span className="ellipsis" style={{ flex: 1, minWidth: 0 }}>{it.file.name}</span>
                    <span className="mono dim tiny">{(it.file.size / 1024 / 1024).toFixed(1)} MB</span>
                    {uploading && <div className="bar thin" style={{ width: 90 }}><i style={{ width: `${it.frac * 100}%` }} /></div>}
                    <button className="icon-btn sm" disabled={busy} onClick={() => setItems(items.filter((_, k) => k !== i))} aria-label={`Remove ${it.file.name}`}><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="lib-list">
            <div className="file-row"><input value={libQ} onChange={(e) => setLibQ(e.target.value)} placeholder="Search your voiceovers" aria-label="Search your voiceovers" /></div>
            {(() => {
              const shown = lib.filter((j) => j.kind !== "video" && j.kind !== "image" && (!libQ || `${j.label ?? ""} ${j.voice} ${j.engine}`.toLowerCase().includes(libQ.toLowerCase())));
              if (!shown.length) return <Empty icon={<ClosedCaptioning size={20} />} title="No voiceovers yet">Make one in Voiceover, then subtitle it here.</Empty>;
              return shown.map((j) => (
                <div key={j.id} className="file-row">
                  <VoiceGlyph name={j.voice || j.engine} size={34} />
                  <div style={{ minWidth: 0, flex: 1 }}><div className="ellipsis"><b>{j.label || j.id}</b></div>
                    <div className="tiny dim">{j.engine} · {j.voice} · {j.results.length} line{j.results.length === 1 ? "" : "s"} · {fmtS(j.results.reduce((a, r) => a + r.duration, 0))}{j.subs ? " · has subtitles" : ""}</div></div>
                  <button className="ghost sm" disabled={busy || !status?.online} onClick={() => fromLibrary(j.id)}><Plus size={14} weight="bold" />{j.subs ? "Again" : "Subtitles"}</button>
                </div>
              ));
            })()}
          </div>
        )}
        {err && <p className="err" role="alert">{err}</p>}
        {(uploading || job) && <JobProgress job={job} uploading={uploading} uploadFrac={totalUp} onCancel={() => job && api(`jobs/${job.id}/cancel`, { body: {} })} />}

        {job?.library && job.kind === "transcribe" ? (
          mode === "library" || (job as Job & { attach_to?: string }).attach_to ? (
            <Notice icon={<ClosedCaptioning size={18} />} tone="ok" action={<Link className="btn sm" href={`/files#${job.library.id}`}><ArrowSquareOut size={14} />Open in Files</Link>}>Subtitles attached to the voiceover.</Notice>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {job.results.length > 1 && (
                <Notice icon={<ClosedCaptioning size={18} />} action={<div className="row" style={{ gap: 6 }}>{["srt", "vtt"].map((x) => <a key={x} className="btn ghost sm" href={fileUrl(job.id, `subtitles.${x}`, `subtitles.${x}`)}>.{x}</a>)}</div>}>
                  <b>All files</b> · one combined timeline</Notice>
              )}
              {job.results.map((r) => <Result key={r.id} jobId={job.id} id={r.id} name={r.name ?? r.id} src={local(r.id)} heard={r.heard ?? ""} duration={r.duration} match={r.match} />)}
            </div>
          )
        ) : !job && !items.length && mode !== "library" && <Empty icon={<ClosedCaptioning size={20} />} title="Your subtitles appear here">Play along with the words highlighted, then download SRT, VTT or JSON.</Empty>}
      </div>
    </ToolPage>
  );
}
