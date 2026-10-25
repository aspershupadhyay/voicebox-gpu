"use client";
// What's working and what isn't: the worker (version, self-check, update), each engine's speed and how often the
// review re-voices lines, recent failures with their logs, training runs, and the model checks that kept or switched
// a voice. Built from the job notes the dashboard keeps (lib/telemetry.ts).
import { ArrowsClockwise, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import GpuCard from "./GpuCard";

type Engine = { engine: string; jobs: number; failed: number; lines: number; audio_min: number; speed: number | null; steps: Record<string, number | null>;
  step_share: Record<string, number>; retry_rate: number | null; unfixed: number };
type Step = { name: string; ok: boolean; detail: string };
type HealthData = {
  jobs: number; engines: Engine[]; latest_version: string;
  failures: { id: string; kind: string; mode?: string | null; method?: string | null; engine?: string; voice?: string; error?: string | null; at: number }[];
  trains: { id: string; method: string; voice?: string; status: string; error?: string | null; minutes: number; at: number }[];
  gates: { name: string; engine: string; stage: string; at: number; old?: number | null; new?: number | null; note?: string }[];
  kept: { promoted: number; kept_old: number };
  worker: { offline?: string; version?: string; gpu?: { name: string; used_gb: number; total_gb: number }; engine_errors?: Record<string, string>; uptime_s?: number;
    selfcheck?: { ok: boolean; why: string; at: number; version?: string; steps: Step[] } | null };
};
const STEPS = ["loading", "generating", "listening", "re-voicing", "mastering"];
const when = (t: number) => new Date(t).toLocaleString();

export default function Health() {
  const { toast } = useDialog();
  const [h, setH] = useState<HealthData | null>(null);
  const [err, setErr] = useState("");
  const [log, setLog] = useState<{ engine: string; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { api<HealthData>("health").then(setH).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  const w = h?.worker;
  const stale = w?.version && h && w.version !== h.latest_version;

  async function update() {
    setBusy("update");
    try {
      await api("worker/update", { method: "POST", body: {} });
      toast("Updating: the worker restarts with the new code in about a minute", "ok");
      setTimeout(load, 70_000);
    } catch (e) { toast((e as Error).message, "bad"); }
    setBusy("");
  }
  async function check() {
    setBusy("check");
    try { await api("worker/selfcheck", { method: "POST", body: {} }); toast("Self-check started: results here in a minute or two", "ok"); setTimeout(load, 90_000); }
    catch (e) { toast((e as Error).message, "bad"); }
    setBusy("");
  }
  const showLog = (engine?: string) => engine && api<{ text: string }>(`logs/${engine}`).then((r) => setLog({ engine, text: r.text })).catch(() => {});

  return (
    <>
      <div className="head"><div><div className="eyebrow">Health</div><h1>What&apos;s <em>working.</em></h1>
        <p className="sub">Speed, failures, retrains and the worker&apos;s own checks, from the last {h?.jobs ?? "…"} jobs.</p></div></div>
      {err && <p className="err">{err}</p>}
      <div className="stack" style={{ gap: 16 }}>
        <GpuCard />
        <div className="card">
          <div className="card-head"><h2>Worker</h2>
            <span className="row" style={{ gap: 6 }}>
              <button className="ghost sm" onClick={check} disabled={!!busy || !!w?.offline}>Run self-check</button>
              <button className="ghost sm" disabled={!!busy || !!w?.offline} onClick={() => api("worker/restart", { method: "POST", body: {} }).then(() => toast("Restarting the worker: back in about a minute", "ok")).catch((e) => toast((e as Error).message, "bad"))}>Restart worker</button>
              <button className="sm" onClick={update} disabled={!!busy || !!w?.offline} title="Fetch the newest worker code and restart (no Colab restart)"><ArrowsClockwise size={13} /> Update worker</button>
            </span></div>
          {w?.offline ? <p className="small" style={{ color: "var(--warn)", margin: 0 }}>Offline: {w.offline}</p> : w && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row small" style={{ gap: 14, flexWrap: "wrap" }}>
                <span>version <b>{w.version}</b>{stale ? <span className="pill warn" style={{ marginLeft: 6 }}>{h!.latest_version} available: press Update</span> : <span className="pill ok" style={{ marginLeft: 6 }}>latest</span>}</span>
                {w.gpu && <span>{w.gpu.name} · {w.gpu.used_gb}/{w.gpu.total_gb} GB</span>}
                {w.uptime_s != null && <span className="dim">up {Math.round(w.uptime_s / 60)} min</span>}
              </div>
              {w.engine_errors && Object.keys(w.engine_errors).length > 0 && Object.entries(w.engine_errors).map(([e, m]) => (
                <div key={e} className="small"><WarningCircle size={14} color="var(--bad)" /> <b>{e}</b> <span className="dim">{String(m).slice(0, 160)}</span> <button className="ghost xs" onClick={() => showLog(e)}>log</button></div>))}
              {w.selfcheck ? (
                <div className="stack" style={{ gap: 4 }}>
                  <span className="small"><b>Self-check</b> <span className="dim">({w.selfcheck.why}, {when(w.selfcheck.at * 1000)}{w.selfcheck.version ? `, ${w.selfcheck.version}` : ""})</span> {w.selfcheck.ok ? <span className="pill ok">all pass</span> : <span className="pill bad">failed</span>}</span>
                  {w.selfcheck.steps.map((s) => <span key={s.name} className="tiny">{s.ok ? <CheckCircle size={12} color="var(--ok)" /> : <WarningCircle size={12} color="var(--bad)" />} {s.name} <span className="dim">{s.detail}</span></span>)}
                </div>
              ) : <span className="tiny dim">No self-check yet: it runs by itself after the worker starts (update the worker if it&apos;s older than {h?.latest_version}).</span>}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>Voice engines</h2><span className="dim tiny">speed = seconds of GPU work per second of audio (lower is faster)</span></div>
          {!h?.engines.length ? <p className="dim small" style={{ margin: 0 }}>No voiceovers recorded yet.</p> : (
            <table className="table">
              <thead><tr><th>Engine</th><th>Jobs</th><th>Audio</th><th>Speed</th><th>Where the time goes</th><th>Re-voiced</th><th>Failed</th></tr></thead>
              <tbody>{h.engines.map((e) => (
                <tr key={e.engine}>
                  <td><b className="small">{e.engine}</b></td>
                  <td className="mono small">{e.jobs}</td>
                  <td className="mono small">{e.audio_min} min</td>
                  <td className="mono small">{e.speed != null ? `${e.speed}×` : "—"}</td>
                  <td className="tiny">{STEPS.filter((s) => e.step_share[s]).map((s) => `${s} ${e.step_share[s]}%`).join(" · ") || "—"}</td>
                  <td className="mono small" title="Share of lines the review had to voice again; unfixed = still below the bar">{e.retry_rate != null ? `${Math.round(e.retry_rate * 100)}%` : "—"}{e.unfixed ? ` · ${e.unfixed} unfixed` : ""}</td>
                  <td className="small">{e.failed ? <span className="pill bad">{e.failed}</span> : <span className="dim">0</span>} <button className="ghost xs" onClick={() => showLog(e.engine)}>log</button></td>
                </tr>))}</tbody>
            </table>
          )}
        </div>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>Model checks</h2><span className="dim tiny">{h?.kept.promoted ?? 0} switched · {h?.kept.kept_old ?? 0} kept the old model</span></div>
            {!h?.gates.length ? <p className="dim small" style={{ margin: 0 }}>None yet: a retrain or polish is compared with the model in use before it goes live.</p>
              : h.gates.map((g, k) => (
                <div key={k} className="stack" style={{ gap: 2, padding: "6px 0", borderTop: k ? "1px solid var(--line)" : undefined }}>
                  <span className="small"><b>{g.engine === "qwen" ? `ft_${g.name}` : g.name}</b> <span className={`pill ${g.stage === "promoted" ? "ok" : g.stage === "kept" ? "warn" : g.stage === "error" ? "bad" : ""}`}>{g.stage}</span>
                    {g.old != null && g.new != null && <span className="dim tiny"> {g.old.toFixed(3)} → {g.new.toFixed(3)}</span>}</span>
                  {g.note && <span className="tiny dim">{g.note}</span>}
                </div>))}
          </div>
          <div className="card">
            <div className="card-head"><h2>Training runs</h2></div>
            {!h?.trains.length ? <p className="dim small" style={{ margin: 0 }}>None recorded yet.</p>
              : h.trains.map((t) => (
                <div key={t.id} className="row between small" style={{ padding: "6px 0", borderTop: "1px solid var(--line)", gap: 8 }}>
                  <span><b>{t.voice}</b> <span className="dim">{t.method === "dpo" ? "polish (RLHF)" : "train"} · {t.minutes} min · {when(t.at)}</span></span>
                  {t.status === "done" ? <span className="pill ok">done</span> : <span className="pill bad" title={t.error ?? ""}>{t.status}</span>}
                </div>))}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Recent failures</h2></div>
          {!h?.failures.length ? <p className="dim small" style={{ margin: 0 }}>Nothing failed recently.</p> : h.failures.map((f) => (
            <div key={f.id} className="stack" style={{ gap: 2, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="small"><b>{f.mode ?? f.method ?? f.kind}</b> <span className="dim">{f.engine} · {f.voice} · {when(f.at)}</span> {f.engine && <button className="ghost xs" onClick={() => showLog(f.kind === "train" ? "train" : f.engine)}>log</button>}</span>
              <span className="tiny" style={{ color: "var(--bad)" }}>{f.error}</span>
            </div>))}
        </div>
        {log && (
          <div className="card">
            <div className="card-head"><h2>Log · {log.engine}</h2><button className="ghost xs" onClick={() => setLog(null)}>Close</button></div>
            <pre className="mono tiny" style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto", margin: 0 }}>{log.text.split("\n").slice(-80).join("\n")}</pre>
          </div>
        )}
      </div>
      <div style={{ height: 30 }} />
    </>
  );
}
