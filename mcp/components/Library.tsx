"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, fileUrl, fmtS, matchClass, pct } from "./api";
import LineRow, { type Line } from "./LineRow";
import { useStatus } from "./Shell";

type LibJob = {
  id: string; kind?: "tts" | "transcribe"; engine: string; voice: string; label?: string; created: number; source?: string; language?: string | null;
  params?: Record<string, unknown>; subs?: { cues: number; timeline: string } | null; match?: number | null; results: (Line & { audio?: string | null })[];
};

function JobCard({ j, open, onDelete, onSubtitle }: { j: LibJob; open: boolean; onDelete: () => void; onSubtitle: () => void }) {
  const players = useRef<(() => void)[]>([]);
  const [playing, setPlaying] = useState(-1);
  const [isOpen, setOpen] = useState(open);
  const total = j.results.reduce((s, r) => s + r.duration, 0);
  const over = j.results.filter((r) => r.fits === false).length;
  const slug = (j.label || `${j.engine}-${j.voice}`).replace(/[^A-Za-z0-9._-]/g, "_");
  const asr = j.kind === "transcribe";

  function playFrom(i: number) {
    if (i >= j.results.length) return setPlaying(-1);
    setOpen(true); setPlaying(i);
    setTimeout(() => players.current[i]?.(), 30);
  }

  return (
    <div className="card" id={j.id} style={{ marginBottom: 12, padding: 0, overflow: "hidden" }}>
      <div className="row between" style={{ padding: "16px 20px", cursor: "pointer" }} onClick={() => setOpen(!isOpen)}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span style={{ color: "var(--dim)", transition: "transform .2s", transform: isOpen ? "rotate(90deg)" : "none", display: "inline-block" }}>›</span>
            <b style={{ fontSize: 15 }}>{j.label || j.id}</b>
          </div>
          <div className="row tiny" style={{ gap: 6, marginTop: 6, marginLeft: 16 }}>
            {asr ? <span className="pill blue">subtitles</span> : <><span className="pill">{j.engine}</span><span className="pill">{j.voice}</span></>}
            {j.subs && !asr && <span className="pill blue">CC · {j.subs.cues} cues</span>}
            {j.match != null && <span className={`pill ${matchClass(j.match)}`}>match {pct(j.match)}</span>}
            {over > 0 && <span className="pill bad">{over} over window</span>}
            <span className="dim mono">{j.results.length} {asr ? "files" : "lines"} · {fmtS(total)} · {ago(j.created)}</span>
          </div>
        </div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          {!asr && <button className="sm" onClick={() => (playing >= 0 ? setPlaying(-1) : playFrom(0))}>{playing >= 0 ? "■ Stop" : "▶ Play all"}</button>}
          {!asr && !j.subs && <button className="ghost sm" onClick={onSubtitle}>+ Subtitles</button>}
          {j.subs && <a className="btn ghost sm" href={fileUrl(j.id, "subtitles.srt", `${slug}.srt`)}>.srt</a>}
          {j.subs && <a className="btn ghost sm" href={fileUrl(j.id, "subtitles.vtt", `${slug}.vtt`)}>.vtt</a>}
          <a className="btn ghost sm" href={`/api/zip/${j.id}`}>Zip</a>
          <button className="ghost sm" onClick={onDelete} title="Delete">✕</button>
        </div>
      </div>
      {isOpen && (
        <div style={{ padding: "0 20px 10px", borderTop: "1px solid var(--line)" }}>
          {j.results.map((r, i) => (
            <LineRow key={r.id} jobId={j.id} line={r} audio={r.audio} slug={slug}
              playRef={(fn) => { players.current[i] = fn; }} onEnded={playing === i ? () => playFrom(i + 1) : undefined} />
          ))}
          {j.params && Object.keys(j.params).length > 0 && <p className="dim tiny mono">{Object.entries(j.params).map(([k, v]) => `${k}=${v}`).join(" · ")}</p>}
        </div>
      )}
    </div>
  );
}

export default function Library() {
  const { status } = useStatus();
  const [jobs, setJobs] = useState<LibJob[] | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [hash, setHash] = useState("");
  const [note, setNote] = useState("");

  const load = () => api<{ jobs: LibJob[] }>("library").then((r) => setJobs(r.jobs)).catch((e) => setErr(e.message));
  useEffect(() => { setHash(location.hash.slice(1)); load(); }, []);
  useEffect(() => { if (hash && jobs) document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [hash, jobs]);

  const engines = useMemo(() => Array.from(new Set((jobs ?? []).filter((j) => j.kind !== "transcribe").map((j) => j.engine))), [jobs]);
  const shown = (jobs ?? []).filter((j) =>
    (filter === "all" || (filter === "subtitles" ? j.kind === "transcribe" || !!j.subs : j.kind !== "transcribe" && j.engine === filter)) &&
    (!q || `${j.label} ${j.voice} ${j.engine} ${j.results.map((r) => r.text).join(" ")}`.toLowerCase().includes(q.toLowerCase())));

  async function remove(j: LibJob) {
    if (!confirm(`Delete "${j.label || j.id}" and all its files? This can't be undone.`)) return;
    await api(`library/${j.id}`, { method: "DELETE" }).catch((e) => alert(e.message));
    load();
  }
  async function subtitle(j: LibJob) {
    if (!status?.online) return alert("The GPU worker is offline. Start the Colab notebook first.");
    await api("jobs", { body: { kind: "transcribe", library: j.id, language: j.language || undefined } }).catch((e) => alert(e.message));
    setNote(`Subtitling "${j.label || j.id}"… it'll show a CC badge here when done (follow it on Overview).`);
  }

  return (
    <>
      <div className="head">
        <div>
          <h1>Library</h1>
          <p className="sub">Everything you've made, stored privately on Vercel Blob. Still here after Colab stops.</p>
        </div>
        <Link href="/generate" className="btn sig">New voiceover</Link>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="chips">
          {["all", ...engines, "subtitles"].map((e) => <button key={e} className={`chip ${filter === e ? "on" : ""}`} onClick={() => setFilter(e)}>{e}</button>)}
        </div>
        <input placeholder="Search names, voices, script text…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <button className="ghost sm" onClick={load}>Refresh</button>
      </div>
      {note && <div className="card flat small" style={{ marginBottom: 12 }}>{note}</div>}
      {err && <p className="err">{err}</p>}
      {jobs === null && !err && <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="card" style={{ height: 74, opacity: 0.5 }} />)}</div>}
      {jobs && !shown.length && <div className="empty">Nothing here yet.</div>}
      {shown.map((j) => <JobCard key={j.id} j={j} open={hash === j.id} onDelete={() => remove(j)} onSubtitle={() => subtitle(j)} />)}
    </>
  );
}
