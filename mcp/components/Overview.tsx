"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, api, fmtS, pct, type Job } from "./api";
import { useStatus } from "./Shell";
import { useDialog } from "./Dialog";

type Lib = { id: string; kind?: string; engine: string; voice: string; label?: string; created: number; match?: number | null; subs?: unknown; results: { duration: number }[]; video?: { duration: number } };
const libSeconds = (j: Lib) => j.video?.duration ?? j.results.reduce((a, r) => a + r.duration, 0);

const ENGINES: Record<string, { what: string; vram: string }> = {
  orpheus: { what: "Most human · English · emotion tags", vram: "10 GB" },
  chatterbox: { what: "Emotion dial · cloning · 23 languages", vram: "4 GB" },
  kokoro: { what: "Instant drafts · many languages", vram: "CPU" },
  whisper: { what: "Subtitles · word timing · 99 languages", vram: "4 GB" },
};
const stClass = (s?: string) => (s === "ready" ? "ok" : s === "loading" || s === "installing" ? "warn" : s === "error" ? "bad" : "");

function speed(name: string, rate?: number) {
  if (!rate) return "";
  const rtf = name === "whisper" ? rate : rate * 14.5; // compute seconds per second of audio
  return rtf < 1 ? `${(1 / rtf).toFixed(1)}× realtime` : `${rtf.toFixed(1)}s per audio second`;
}

export default function Overview() {
  const { status: st, refresh } = useStatus();
  const { toast } = useDialog();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [lib, setLib] = useState<Lib[] | null>(null);
  const [busy, setBusy] = useState("");
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  async function showLogs(name: string) {
    setLogs({ name, text: "Loading…" });
    const r = await api<{ text: string }>(`logs/${name}`).catch((e) => ({ text: String(e.message) }));
    setLogs({ name, text: r.text });
  }

  useEffect(() => { api<{ jobs: Lib[] }>("library").then((l) => setLib(l.jobs)).catch(() => setLib([])); }, []);
  useEffect(() => {
    if (!st?.online) return;
    const load = () => api<{ jobs: Job[] }>("jobs").then((j) => setJobs(j.jobs)).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [st?.online]);

  async function engine(name: string, action: "load" | "unload") {
    setBusy(name);
    await api(`engines/${name}/${action}`, { body: {} }).catch((e) => toast(e.message, "bad"));
    await refresh();
    setBusy("");
  }

  const vramP = st?.gpu?.total_gb ? Math.round((st.gpu.used_gb / st.gpu.total_gb) * 100) : 0;
  const audio = (lib ?? []).filter((j) => j.kind !== "video").reduce((s, j) => s + libSeconds(j), 0);
  const active = jobs.filter((j) => ["queued", "running"].includes(j.status));

  return (
    <>
      <div className="head">
        <div>
          <h1>Mission control</h1>
          <p className="sub">Your Colab GPU, its engines, and everything you've made.</p>
        </div>
        <div className="row">
          <Link href="/subtitles" className="btn ghost">Subtitle a file</Link>
          <Link href="/generate" className="btn sig">New voiceover</Link>
        </div>
      </div>

      <div className="grid g4 stat-row" style={{ marginBottom: 16 }}>
        <div className="card stat-card">
          <h2>Worker</h2>
          <div className="row" style={{ gap: 10 }}><span className={`dot ${st?.online ? "live" : "bad"}`} /><span className="num" style={{ fontSize: 24 }}>{st ? (st.online ? "Online" : "Offline") : "…"}</span></div>
          <div className="dim small" style={{ marginTop: 8 }}>
            {st?.online ? `up ${fmtS(st.uptime_s ?? 0)} · v${st.version}` : st?.reason === "heartbeat stale" ? "Colab runtime stopped. Run the notebook." : st?.reason ?? "connecting"}
          </div>
        </div>
        <div className="card row" style={{ gap: 16 }}>
          <div className="ring" style={{ ["--p" as string]: vramP }}><span>{vramP}%</span></div>
          <div><h2 style={{ marginBottom: 4 }}>GPU memory</h2><div className="mono">{st?.gpu ? `${st.gpu.used_gb} / ${st.gpu.total_gb} GB` : "—"}</div><div className="dim tiny">{st?.gpu?.name ?? ""}</div></div>
        </div>
        <div className="card stat-card">
          <h2>Queue</h2>
          <div className="num">{st?.online ? active.length : "—"}</div>
          <div className="dim small" style={{ marginTop: 4 }}>{active.length ? `${active.filter((j) => j.status === "running").length} running` : "idle, ready for work"}</div>
        </div>
        <div className="card stat-card">
          <h2>Library</h2>
          <div className="num">{lib?.length ?? "…"}</div>
          <div className="dim small" style={{ marginTop: 4 }}>jobs · {fmtS(audio)} of audio</div>
        </div>
      </div>

      {active.length > 0 && (
        <div className="card reveal" style={{ marginBottom: 16 }}>
          <h2>In progress</h2>
          {active.map((j) => (
            <div key={j.id} style={{ marginBottom: 12 }}>
              <div className="row between small"><b>{j.label || `${j.engine} · ${j.voice}`}</b><span className="dim mono">{j.progress.stage} · {j.progress.done}/{j.progress.total} · ~{fmtS(j.progress.eta_s)} left</span></div>
              <div className="bar thin live" style={{ marginTop: 6 }}><i style={{ width: `${Math.max(3, j.progress.fraction * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      )}

      <div className="grid g2">
        <div className="card">
          <h2>Engines</h2>
          <div className="stack" style={{ gap: 0 }}>
            {Object.keys(ENGINES).map((name) => {
              const s = st?.engines?.[name];
              return (
                <div key={name} className="row between" style={{ padding: "11px 0", borderBottom: "1px solid var(--line)" }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}><b style={{ textTransform: "capitalize" }}>{name}</b><span className={`pill ${stClass(s)}`}>{s ?? "—"}</span></div>
                    <div className="dim small">{ENGINES[name].what} · {ENGINES[name].vram}{st?.rates?.[name] ? ` · ${speed(name, st.rates[name])}` : ""}</div>
                    {st?.engine_errors?.[name] && <div className="err tiny">{st.engine_errors[name].slice(0, 140)}</div>}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                  <button className="ghost xs" disabled={!st?.online} onClick={() => showLogs(name)}>Logs</button>
                  {s === "ready"
                    ? <button className="ghost sm" disabled={busy === name} onClick={() => engine(name, "unload")}>Unload</button>
                    : <button className="ghost sm" disabled={!st?.online || busy === name || s === "loading" || s === "installing"} onClick={() => engine(name, "load")}>{s === "loading" || s === "installing" ? "Loading…" : "Warm up"}</button>}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="dim tiny" style={{ margin: "12px 0 0" }}>Engines load on first use and swap out automatically when GPU memory runs short. "Warm up" before a big batch saves the 1–2 minute load.</p>
        </div>

        <div className="card">
          <div className="row between"><h2>Recent</h2><Link href="/library" className="small">Library →</Link></div>
          {lib === null && <div className="dim small">Loading…</div>}
          {lib?.length === 0 && <div className="empty">Nothing yet. <Link href="/generate">Make your first voiceover</Link>.</div>}
          <table className="table"><tbody>
            {(lib ?? []).slice(0, 7).map((j) => (
              <tr key={j.id}>
                <td style={{ maxWidth: 220 }}><Link href={`/library#${j.id}`} style={{ color: "var(--ink)" }}><b>{j.label || j.id}</b></Link><div className="dim tiny">{ago(j.created)}</div></td>
                <td><span className={`pill ${j.kind === "transcribe" ? "blue" : j.kind === "video" ? "bad" : ""}`}>{j.kind === "transcribe" ? "subtitles" : j.kind === "video" ? "video" : j.engine}</span></td>
                <td className="mono small dim">{fmtS(libSeconds(j))}</td>
                <td>{j.match != null ? <span className={`pill ${j.match >= 0.95 ? "ok" : "warn"}`}>{pct(j.match)}</span> : null}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
      {logs && (
        <>
          <div className="scrim" onClick={() => setLogs(null)} />
          <aside className="drawer" style={{ width: "min(860px, 100vw)" }}>
            <div className="row between"><h2 style={{ margin: 0 }}>{logs.name} logs</h2>
              <div className="row"><button className="ghost xs" onClick={() => showLogs(logs.name)}>Refresh</button><button className="ghost xs" onClick={() => setLogs(null)}>Close</button></div></div>
            <pre className="mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--ink2)", marginTop: 14 }}>{logs.text}</pre>
          </aside>
        </>
      )}
    </>
  );
}
