"use client";
import { upload } from "@vercel/blob/client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, fileUrl, fmtS, pct, type Job, type Word } from "./api";
import { GuideButton } from "./GuideDrawer";
import { LANGUAGES } from "./guides";
import JobProgress from "./JobProgress";
import Player from "./Player";
import { useStatus } from "./Shell";

type Item = { file: File; id: string; frac: number; url: string };
type Lib = { id: string; kind?: string; engine: string; voice: string; label?: string; subs?: unknown; results: { duration: number }[] };

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
        <div><b>{name}</b><div className="dim tiny mono">{fmtS(duration)} · {cues.length} cues · {words?.length ?? "…"} words{match != null ? ` · match ${pct(match)}` : ""}</div></div>
        <div className="row">
          {["srt", "vtt", "json"].map((x) => <a key={x} className="btn ghost sm" href={fileUrl(jobId, `${id}.subs.${x}`, `${id}.${x}`)}>.{x}</a>)}
        </div>
      </div>
      {src ? <Player src={src} words={words} duration={duration} /> : <div className="words">{heard}</div>}
      {cues.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="dim small" style={{ cursor: "pointer" }}>Show {cues.length} subtitle cues</summary>
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
  const [mode, setMode] = useState<"upload" | "library">("upload");
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
        const r = await upload(`uploads/${it.id}${it.file.name.match(/\.[^.]+$/)?.[0] ?? ""}`, it.file, {
          access: "private", handleUploadUrl: "/api/upload", multipart: it.file.size > 8 * 1024 * 1024,
          onUploadProgress: (e) => setItems((cur) => cur.map((x, k) => (k === i ? { ...x, frac: e.percentage / 100 } : x))),
        });
        return { id: it.id, name: it.file.name, blob: r.pathname };
      }));
      setUploading(false);
      const j = await api<Job>("jobs", { body: { kind: "transcribe", sources: done, language: lang || undefined, label: items.length === 1 ? items[0].file.name : `${items.length} files` } });
      setJob(j);
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

  const totalUp = items.length ? items.reduce((s, i) => s + i.frac, 0) / items.length : 0;
  const busy = uploading || (!!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library)));
  const local = (id: string) => items.find((i) => i.id === id)?.url;

  return (
    <>
      <div className="head">
        <div>
          <h1>Subtitles</h1>
          <p className="sub">Whisper large-v3: word-level timing, 99 languages, SRT, VTT and JSON. Upload anything, or subtitle a voiceover you already made.</p>
        </div>
        <GuideButton engine="whisper" />
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="chips">
          <button className={`chip ${mode === "upload" ? "on" : ""}`} onClick={() => setMode("upload")}>Upload files</button>
          <button className={`chip ${mode === "library" ? "on" : ""}`} onClick={() => setMode("library")}>From library</button>
        </div>
        <div style={{ flex: 1 }} />
        <select value={lang} onChange={(e) => setLang(e.target.value)} style={{ width: 240 }}>
          <option value="">Auto-detect language</option>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
      </div>

      {mode === "upload" ? (
        <div className="card">
          <div className={`drop ${over ? "over" : ""}`} onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ color: "var(--signal)" }}><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <div style={{ marginTop: 8 }}><b>Drop audio or video here</b> <span className="dim">or click to choose</span></div>
            <div className="dim tiny" style={{ marginTop: 4 }}>wav · mp3 · m4a · flac · mp4 · mov · any length. Files go straight to your private storage.</div>
            <input ref={input} type="file" multiple accept="audio/*,video/*" hidden onChange={(e) => add(e.target.files)} />
          </div>
          {items.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {items.map((it, i) => (
                <div key={it.id} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.file.name}</span>
                  <span className="mono dim tiny">{(it.file.size / 1024 / 1024).toFixed(1)} MB</span>
                  <div className="bar thin blue" style={{ width: 120 }}><i style={{ width: `${it.frac * 100}%` }} /></div>
                  <button className="ghost xs" disabled={busy} onClick={() => setItems(items.filter((_, k) => k !== i))}>✕</button>
                </div>
              ))}
              <div className="row between" style={{ marginTop: 14 }}>
                <span className="dim small">{items.length} file{items.length === 1 ? "" : "s"} · {(items.reduce((s, i) => s + i.file.size, 0) / 1024 / 1024).toFixed(1)} MB</span>
                <button className="sig" disabled={busy || !status?.online} onClick={start}>{status?.online ? "Make subtitles" : "GPU offline"}</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <h2>Voiceovers without subtitles</h2>
          {lib.filter((j) => !j.subs).length === 0 && <div className="dim small">Every voiceover already has subtitles.</div>}
          <table className="table"><tbody>
            {lib.filter((j) => !j.subs).map((j) => (
              <tr key={j.id}>
                <td><b>{j.label || j.id}</b><div className="dim tiny">{j.engine} · {j.voice} · {j.results.length} lines</div></td>
                <td style={{ textAlign: "right" }}><button className="ghost sm" disabled={busy || !status?.online} onClick={() => fromLibrary(j.id)}>Add subtitles</button></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      {err && <p className="err">{err}</p>}

      {(uploading || job) && <div style={{ marginTop: 16 }}><JobProgress job={job} uploading={uploading} uploadFrac={totalUp} onCancel={() => job && api(`jobs/${job.id}/cancel`, { body: {} })} /></div>}

      {job?.library && job.kind === "transcribe" && (
        <div className="stack" style={{ gap: 14, marginTop: 16 }}>
          {mode === "library" || (job as Job & { attach_to?: string }).attach_to ? (
            <div className="card row between"><span>Subtitles attached to the voiceover.</span><Link className="btn sm" href={`/library#${job.library.id}`}>Open in library</Link></div>
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
