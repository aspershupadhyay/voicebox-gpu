"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, audioUrl, fmtS } from "./api";

type LibLine = { id: string; text: string; duration: number; window?: number | null; fits?: boolean | null };
type LibJob = { id: string; engine: string; voice: string; label?: string; created: number; source?: string; params?: Record<string, unknown>; results: LibLine[] };

function JobCard({ j, open, onDelete }: { j: LibJob; open: boolean; onDelete: () => void }) {
  const players = useRef<(HTMLAudioElement | null)[]>([]);
  const [playing, setPlaying] = useState(-1);
  const total = j.results.reduce((s, r) => s + r.duration, 0);
  const over = j.results.filter((r) => r.fits === false).length;
  const slug = (j.label || `${j.engine}-${j.voice}`).replace(/[^A-Za-z0-9._-]/g, "_");

  function playFrom(i: number) {
    players.current.forEach((p) => p?.pause());
    const p = players.current[i];
    if (!p) return setPlaying(-1);
    setPlaying(i);
    p.currentTime = 0;
    p.onended = () => playFrom(i + 1);
    p.play();
  }

  return (
    <details className="card job" id={j.id} open={open} style={{ marginBottom: 12 }}>
      <summary className="row between">
        <div>
          <b style={{ fontSize: 15 }}>{j.label || j.id}</b>
          <div className="row small" style={{ gap: 6, marginTop: 4 }}>
            <span className="pill blue">{j.engine}</span><span className="pill">{j.voice}</span>
            <span className="mono dim">{j.results.length} lines · {fmtS(total)}</span>
            {over > 0 && <span className="pill bad">{over} over window</span>}
            <span className="dim">· {ago(j.created)}</span>
          </div>
        </div>
        <div className="row" onClick={(e) => e.preventDefault()}>
          <button className="tiny" onClick={() => (playing >= 0 ? (players.current[playing]?.pause(), setPlaying(-1)) : playFrom(0))}>
            {playing >= 0 ? "■ Stop" : "▶ Play all"}
          </button>
          <a className="btn ghost tiny" href={`/api/zip/${j.id}`}>⤓ Zip</a>
          <button className="ghost tiny" onClick={onDelete}>Delete</button>
        </div>
      </summary>
      <div style={{ marginTop: 12 }}>
        {j.results.map((r, i) => (
          <div className="line" key={r.id} style={playing === i ? { background: "#1d1f23" } : undefined}>
            <span className="mono small dim">{r.id}</span>
            <span className="t">{r.text}</span>
            <audio ref={(el) => { players.current[i] = el; }} controls preload="none" src={audioUrl(j.id, r.id)} />
            <span className="row acts" style={{ gap: 6 }}>
              <span className="mono small">{r.duration.toFixed(2)}s</span>
              {r.fits === false && <span className="pill bad" title={`window ${r.window}s`}>over</span>}
              <a className="small" href={audioUrl(j.id, r.id, `${slug}-${r.id}.wav`)} title="Download">⤓</a>
            </span>
          </div>
        ))}
        {j.params && Object.keys(j.params).length > 0 && (
          <p className="small dim mono" style={{ marginBottom: 0 }}>{Object.entries(j.params).map(([k, v]) => `${k}=${v}`).join(" · ")}</p>
        )}
      </div>
    </details>
  );
}

export default function Library() {
  const [jobs, setJobs] = useState<LibJob[] | null>(null);
  const [err, setErr] = useState("");
  const [engine, setEngine] = useState("all");
  const [q, setQ] = useState("");
  const [hash, setHash] = useState("");

  const load = () => api<{ jobs: LibJob[] }>("library").then((r) => setJobs(r.jobs)).catch((e) => setErr(e.message));
  useEffect(() => {
    setHash(location.hash.slice(1));
    load();
  }, []);
  useEffect(() => {
    if (hash && jobs) document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash, jobs]);

  const engines = useMemo(() => ["all", ...Array.from(new Set((jobs ?? []).map((j) => j.engine)))], [jobs]);
  const shown = (jobs ?? []).filter(
    (j) => (engine === "all" || j.engine === engine) &&
      (!q || `${j.label} ${j.voice} ${j.engine} ${j.results.map((r) => r.text).join(" ")}`.toLowerCase().includes(q.toLowerCase())),
  );

  async function remove(j: LibJob) {
    if (!confirm(`Delete "${j.label || j.id}" and its ${j.results.length} files? This can't be undone.`)) return;
    await api(`library/${j.id}`, { method: "DELETE" }).catch((e) => alert(e.message));
    load();
  }

  return (
    <>
      <h1>Library</h1>
      <p className="sub">Every finished voiceover, stored privately on Vercel Blob. Still here after the Colab runtime stops.</p>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="chips">{engines.map((e) => <button key={e} className={`chip ${engine === e ? "on" : ""}`} onClick={() => setEngine(e)}>{e}</button>)}</div>
        <input placeholder="Search label, voice or text…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
      </div>
      {err && <p className="err">{err}</p>}
      {jobs === null && !err && <div className="empty">Loading…</div>}
      {jobs && !shown.length && <div className="empty">Nothing here yet. Generate something first.</div>}
      {shown.map((j) => <JobCard key={j.id} j={j} open={hash === j.id} onDelete={() => remove(j)} />)}
    </>
  );
}
