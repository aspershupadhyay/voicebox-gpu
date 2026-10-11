"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ago, api, fmtS } from "./api";

type Status = {
  online: boolean; reason?: string; last_seen?: number; uptime_s?: number; queue?: number; running?: string[];
  gpu?: { name: string; total_gb: number; used_gb: number }; vram_budget_gb?: number;
  engines?: Record<string, string>; engine_errors?: Record<string, string>;
};
type WJob = { id: string; engine: string; voice: string; status: string; label: string; error?: string; progress: { done: number; total: number }; created?: number };

const ENGINE_NOTE: Record<string, string> = {
  kokoro: "CPU · instant drafts", chatterbox: "4 GB · emotion dial, cloning", orpheus: "9 GB · most human", dia: "7 GB · dialogue, cloning",
};
const stateClass = (s: string) => (s === "ready" ? "ok" : s === "loading" || s === "installing" ? "warn" : s === "error" ? "bad" : "");

export default function Dashboard() {
  const [st, setSt] = useState<Status | null>(null);
  const [jobs, setJobs] = useState<WJob[]>([]);
  const [lib, setLib] = useState<{ id: string; engine: string; voice: string; label?: string; created: number; results: { duration: number }[] }[]>([]);
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    const s = await api<Status>("status").catch(() => ({ online: false, reason: "dashboard API error" }) as Status);
    setSt(s);
    if (s.online) api<{ jobs: WJob[] }>("jobs").then((j) => setJobs(j.jobs)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    api<{ jobs: typeof lib }>("library").then((l) => setLib(l.jobs)).catch(() => {});
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function engine(name: string, action: "load" | "unload") {
    setBusy(name);
    await api(`engines/${name}/${action}`, { body: {} }).catch((e) => alert(e.message));
    await refresh();
    setBusy("");
  }

  const vram = st?.gpu ? (st.gpu.used_gb / Math.max(st.gpu.total_gb, 1)) * 100 : 0;
  const libSeconds = lib.reduce((s, j) => s + j.results.reduce((a, r) => a + r.duration, 0), 0);

  return (
    <>
      <div className="row between" style={{ marginBottom: 20 }}>
        <div>
          <h1>Dashboard</h1>
          <p className="sub" style={{ margin: 0 }}>Colab GPU worker, engines and recent work.</p>
        </div>
        <Link href="/generate" className="btn sig">+ New voiceover</Link>
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2>Worker</h2>
          <div className="row"><span className={`dot ${st?.online ? "ok" : "bad"}`} /><span className="big">{st ? (st.online ? "Online" : "Offline") : "…"}</span></div>
          <p className="small dim" style={{ margin: "6px 0 0" }}>
            {st?.online ? `up ${fmtS(st.uptime_s ?? 0)} · heartbeat ${ago(st.last_seen ?? Date.now())}` : st?.reason === "heartbeat stale" ? "Colab stopped. Re-run the notebook." : st?.reason ?? ""}
          </p>
        </div>
        <div className="card">
          <h2>GPU</h2>
          <div className="big" style={{ fontSize: 20 }}>{st?.gpu?.name?.replace("NVIDIA ", "") ?? "—"}</div>
          <div className="bar sig" style={{ margin: "10px 0 6px" }}><i style={{ width: `${vram}%` }} /></div>
          <p className="small dim mono" style={{ margin: 0 }}>{st?.gpu ? `${st.gpu.used_gb} / ${st.gpu.total_gb} GB VRAM` : "—"}</p>
        </div>
        <div className="card">
          <h2>Queue</h2>
          <div className="big">{st?.online ? st.queue ?? 0 : "—"}</div>
          <p className="small dim" style={{ margin: "6px 0 0" }}>{st?.running?.length ? `running ${st.running[0]}` : "idle"}</p>
        </div>
        <div className="card">
          <h2>Library</h2>
          <div className="big">{lib.length}</div>
          <p className="small dim" style={{ margin: "6px 0 0" }}>jobs · {fmtS(libSeconds)} of audio saved</p>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Engines</h2>
          <table className="table">
            <tbody>
              {Object.entries(st?.engines ?? { kokoro: "—", chatterbox: "—", orpheus: "—", dia: "—" }).map(([name, s]) => (
                <tr key={name}>
                  <td><b>{name}</b><div className="small dim">{ENGINE_NOTE[name]}</div>
                    {st?.engine_errors?.[name] && <div className="err small">{st.engine_errors[name].slice(0, 120)}</div>}</td>
                  <td><span className={`pill ${stateClass(s)}`}>{s}</span></td>
                  <td style={{ textAlign: "right" }}>
                    {s === "ready" ? (
                      <button className="ghost tiny" disabled={!st?.online || busy === name} onClick={() => engine(name, "unload")}>Unload</button>
                    ) : (
                      <button className="ghost tiny" disabled={!st?.online || busy === name || s === "loading" || s === "installing"} onClick={() => engine(name, "load")}>Load</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small dim" style={{ marginBottom: 0 }}>Engines load on demand and are swapped out automatically when VRAM runs short. Loading ahead of time saves 1–3 minutes on the first job.</p>
        </div>

        <div className="card">
          <h2>Worker jobs</h2>
          {!jobs.length && <p className="dim small">No jobs on this runtime yet.</p>}
          <table className="table">
            <tbody>
              {jobs.slice(0, 8).map((j) => (
                <tr key={j.id}>
                  <td><b>{j.label || `${j.engine} · ${j.voice}`}</b><div className="small dim mono">{j.id}</div></td>
                  <td style={{ width: 120 }}>
                    <div className="bar"><i style={{ width: `${(j.progress.done / Math.max(j.progress.total, 1)) * 100}%` }} /></div>
                    <div className="small dim mono">{j.progress.done}/{j.progress.total}</div>
                  </td>
                  <td><span className={`pill ${j.status === "done" ? "ok" : j.status === "error" ? "bad" : j.status === "running" ? "blue" : ""}`}>{j.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row between"><h2>Recently saved</h2><Link href="/library" className="small">Open library →</Link></div>
        {!lib.length && <p className="dim small">Nothing saved yet.</p>}
        <table className="table">
          <tbody>
            {lib.slice(0, 6).map((j) => (
              <tr key={j.id}>
                <td><Link href={`/library#${j.id}`}><b>{j.label || j.id}</b></Link></td>
                <td><span className="pill blue">{j.engine}</span> <span className="pill">{j.voice}</span></td>
                <td className="mono small dim">{j.results.length} lines · {fmtS(j.results.reduce((a, r) => a + r.duration, 0))}</td>
                <td className="small dim">{ago(j.created)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
