"use client";
// The machine the worker runs on, live: CPU, RAM (and how much of it holds model weights), GPU busy and GPU memory over
// the last 10 minutes, what each lane (GPU / CPU) is doing, which engines are kept warm in RAM and how fast they last
// started, and whether the work needs the GPU it's on. Data: the worker's /health + /metrics, the job notes' gpu_fit.

type Sample = { t: number; cpu: number | null; ram_gb: number; cache_gb: number; gpu?: number | null; vram_gb?: number | null; power_w?: number | null };
export type Metrics = { every_s: number; cores: number; ram_total_gb: number | null; vram_total_gb: number; samples: Sample[] } | null;
type LaneJob = { id: string; label?: string | null; stage?: string; engine?: string };
export type MachineWorker = {
  offline?: string; cpu?: { cores: number; load: number | null }; ram?: { total_gb: number; used_gb: number };
  lanes?: Record<"gpu" | "cpu", { running: LaneJob[]; queued: number }>;
  warm?: { budget_gb: number; engines: Record<string, { gb: number; warm: boolean; secs: number | null }> };
  loads?: Record<string, { secs: number; warm: boolean; at: number }>;
};
export type GpuFit = { work: "voice" | "heavy"; gpu: string; jobs: number; gpu_util: number | null; vram_peak_gb: number | null; suggest: string | null }[];

function Spark({ label, values, max, unit, color, note }: { label: string; values: (number | null | undefined)[]; max: number; unit: string; color: string; note?: string }) {
  const v = values.map((x) => (typeof x === "number" ? x : null));
  const last = [...v].reverse().find((x) => x != null) ?? null;
  const W = 220, H = 44, n = Math.max(2, v.length);
  const pts = v.map((x, i) => (x == null ? null : `${((i / (n - 1)) * W).toFixed(1)},${(H - 2 - (Math.min(x, max) / (max || 1)) * (H - 4)).toFixed(1)}`)).filter(Boolean).join(" ");
  return (
    <div className="stack" style={{ gap: 4, minWidth: 0 }}>
      <div className="row between tiny"><span className="dim">{label}</span><span className="mono">{last != null ? `${Math.round(last * 10) / 10}${unit}` : "—"}{note ? <span className="dim"> {note}</span> : null}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block", background: "var(--bg2)", borderRadius: 6 }} role="img" aria-label={`${label} over the last 10 minutes`}>
        {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
      </svg>
    </div>
  );
}

export default function MachineCard({ w, m, fit }: { w?: MachineWorker; m: Metrics; fit?: GpuFit }) {
  if (!w || w.offline) return null;
  const s = m?.samples ?? [];
  const ram = m?.ram_total_gb ?? w.ram?.total_gb ?? 0;
  const lanes = w.lanes;
  const warm = Object.entries(w.warm?.engines ?? {});
  const loads = Object.entries(w.loads ?? {}).sort((a, b) => b[1].at - a[1].at);
  const tips = (fit ?? []).filter((f) => f.suggest);
  return (
    <div className="card">
      <div className="card-head"><h2>Machine</h2>
        <span className="dim tiny">{w.cpu?.cores ?? m?.cores ?? "?"} CPU cores · {Math.round(ram)} GB RAM · {m?.vram_total_gb ?? "?"} GB GPU · last 10 min</span></div>
      {s.length ? (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Spark label="GPU busy" values={s.map((x) => x.gpu)} max={100} unit="%" color="var(--signal)" />
          <Spark label="GPU memory" values={s.map((x) => x.vram_gb)} max={m?.vram_total_gb || 1} unit=" GB" color="var(--glacier)" />
          <Spark label="CPU busy" values={s.map((x) => x.cpu)} max={100} unit="%" color="var(--ok)" />
          <Spark label="RAM in use" values={s.map((x) => x.ram_gb)} max={ram || 1} unit=" GB"
            color="var(--sand)" note={s.length ? `+ ${Math.round(s[s.length - 1].cache_gb)} GB cached` : undefined} />
        </div>
      ) : <p className="dim small" style={{ margin: 0 }}>Live charts arrive with worker 3.2.0: press Update worker.</p>}

      {lanes && (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 14 }}>
          {(["gpu", "cpu"] as const).map((k) => (
            <div key={k} className="stack" style={{ gap: 4 }}>
              <span className="small"><b>{k === "gpu" ? "GPU lane" : "CPU lane"}</b> <span className="dim tiny">{k === "gpu" ? "one job at a time on the GPU" : "Kokoro drafts and other no-GPU jobs, alongside"}</span></span>
              {lanes[k].running.length ? lanes[k].running.map((j) => (
                <span key={j.id} className="tiny"><span className="dot ok" style={{ marginRight: 6 }} />{j.label || j.engine} <span className="dim">· {j.stage}</span></span>
              )) : <span className="tiny dim">idle</span>}
              {lanes[k].queued > 0 && <span className="tiny dim">{lanes[k].queued} waiting</span>}
            </div>
          ))}
        </div>
      )}

      {(warm.length > 0 || loads.length > 0) && (
        <div className="stack" style={{ gap: 6, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          {warm.length > 0 && (
            <span className="small"><b>Kept in RAM</b> <span className="dim tiny">({w.warm!.budget_gb} GB budget: engines start from memory, not the disk)</span><br />
              {warm.map(([n, x]) => <span key={n} className={`pill ${x.warm ? "ok" : ""}`} style={{ marginRight: 6, marginTop: 4 }}>{n} {x.gb} GB{x.warm ? "" : " · warming"}</span>)}</span>
          )}
          {loads.length > 0 && (
            <span className="tiny"><span className="dim">Last start:</span> {loads.map(([n, x]) => `${n} ${Math.round(x.secs)} s${x.warm ? " (from RAM)" : " (from disk)"}`).join(" · ")}</span>
          )}
        </div>
      )}

      {fit && fit.length > 0 && (
        <div className="stack" style={{ gap: 4, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <span className="small"><b>Right-size the GPU</b> <span className="dim tiny">from what your jobs really used</span></span>
          {fit.map((f) => (
            <span key={`${f.work}-${f.gpu}`} className="tiny">{f.work === "voice" ? "Voice work" : "Training & video"} on {f.gpu}: <span className="mono">{f.gpu_util ?? "—"}%</span> GPU busy,
              peak <span className="mono">{f.vram_peak_gb ?? "—"} GB</span> <span className="dim">({f.jobs} jobs)</span></span>
          ))}
          {tips.map((f) => <span key={`t-${f.work}-${f.gpu}`} className="tiny" style={{ color: "var(--warn)" }}>→ {f.suggest}</span>)}
        </div>
      )}
    </div>
  );
}
