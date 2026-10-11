"use client";
import { X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { fmtS, type Job } from "./api";

const TTS_STEPS = [["queued", "Queued"], ["prepare", "Warm up"], ["generating", "Voicing"], ["subtitles", "Subtitles"], ["saving", "Saving"], ["done", "Done"]] as const;
const ASR_STEPS = [["upload", "Upload"], ["queued", "Queued"], ["downloading", "Fetch"], ["prepare", "Warm up"], ["transcribing", "Transcribe"], ["saving", "Saving"], ["done", "Done"]] as const;

function stepKey(job: Job | null, uploading: boolean) {
  if (uploading) return "upload";
  if (!job) return "queued";
  const s = job.progress.stage;
  if (job.status === "done") return job.library ? "done" : "saving";
  if (["installing", "loading", "reference"].includes(s)) return "prepare";
  if (s === "packaging") return "saving";
  return s;
}

/** Live job progress: stage stepper + a bar that glides between polls using the worker's ETA. */
export default function JobProgress({ job, uploading, uploadFrac, onCancel }: {
  job: Job | null; uploading?: boolean; uploadFrac?: number; onCancel?: () => void;
}) {
  const [shown, setShown] = useState(0);
  const [, tick] = useState(0);
  const anchor = useRef({ f: 0, eta: 0, at: 0 });
  const kind = job?.kind ?? (uploading ? "transcribe" : "tts");
  const steps = (kind === "transcribe" ? ASR_STEPS : TTS_STEPS).filter(([k]) => k !== "subtitles" || job?.subtitles);
  const key = stepKey(job, !!uploading);
  const idx = Math.max(0, steps.findIndex(([k]) => k === key));
  const running = uploading || (job && ["queued", "running"].includes(job.status)) || (job?.status === "done" && !job.library);
  const prep = key === "prepare";

  useEffect(() => {
    if (job) anchor.current = { f: job.progress.fraction, eta: job.progress.eta_s, at: performance.now() };
  }, [job]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const { f, eta, at } = anchor.current;
      let target = uploading ? (uploadFrac ?? 0) : f;
      if (!uploading && job?.status === "running" && eta > 0) {
        const dt = (performance.now() - at) / 1000;
        target = Math.min(f + (1 - f) * (dt / (eta + dt)), f + (1 - f) * 0.85); // glide toward the ETA, never overshoot
      }
      if (job?.status === "done") target = 1;
      setShown((s) => s + (target - s) * 0.08);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => { cancelAnimationFrame(raf); clearInterval(t); };
  }, [job, uploading, uploadFrac]);

  const p = job?.progress;
  const elapsed = p ? p.elapsed_s + (job?.status === "running" ? (performance.now() - anchor.current.at) / 1000 : 0) : 0;
  const eta = p && job?.status === "running" ? Math.max(0, p.eta_s - (performance.now() - anchor.current.at) / 1000) : 0;
  const headline = uploading ? `Uploading… ${Math.round((uploadFrac ?? 0) * 100)}%`
    : !job ? "Starting…"
    : job.status === "queued" ? `Queued${job.queue_position ? ` · #${job.queue_position} in line` : ""}`
    : job.status === "done" ? (job.library ? "Done · saved to library" : "Saving to library…")
    : job.status === "error" ? "Failed" : job.status === "cancelled" ? "Cancelled"
    : prep ? (p!.stage === "installing" ? "Installing engine (first run only)" : "Loading model onto the GPU")
    : key === "generating" ? `Voicing ${p!.detail}` : key === "subtitles" ? "Writing subtitles" : key === "transcribing" ? `Transcribing ${p!.detail}` : key === "downloading" ? "Fetching your files" : "Working";

  const done = job?.status === "done" && !!job.library;
  const failed = job?.status === "error" || job?.status === "cancelled";
  const N = 48, lit = Math.round(shown * N);

  return (
    <div className="card rec reveal">
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <span className={`recdot ${done ? "done" : ""}`} style={failed ? { color: "var(--dim)" } : undefined}><i style={failed ? { background: "var(--faint)", boxShadow: "none", animation: "none" } : undefined} />{done ? "SAVED" : failed ? "STOPPED" : running ? "REC" : "READY"}</span>
          <h3>{headline}</h3>
          <div className="dim small" style={{ marginTop: 4 }}>
            {prep ? p?.detail : job?.status === "running" ? `${p?.done ?? 0} of ${p?.total ?? 0} ${kind === "transcribe" ? "files" : "lines"} finished` : job?.error ?? " "}
          </div>
        </div>
        <div className="row" style={{ gap: 22, alignItems: "flex-start" }}>
          <div className="stats">
            {job && <div><div className="label">Progress</div><div className="v">{Math.round(shown * 100)}%</div></div>}
            {job && <div><div className="label">Elapsed</div><div className="v">{fmtS(elapsed)}</div></div>}
            {running && !uploading && eta > 0 && <div><div className="label">Left</div><div className="v" style={{ color: "var(--signal2)" }}>~{fmtS(eta)}</div></div>}
          </div>
          {running && onCancel && job && job.status !== "done" && <button className="ghost sm" onClick={onCancel}><X size={14} />Cancel</button>}
        </div>
      </div>
      <div className={`spectrum ${running ? "live" : ""}`} aria-hidden>
        {Array.from({ length: N }, (_, i) => {
          const h = 30 + 70 * Math.abs(Math.sin(i * 0.53) * Math.cos(i * 0.21 + 0.4));
          return <i key={i} className={i < lit ? "on" : ""} style={{ height: `${h}%`, animationDelay: `${(i % 9) * 0.07}s`, ...(done && i < lit ? { background: "var(--ok)", opacity: 0.8 } : {}) }} />;
        })}
      </div>
      <div className={`bar thin ${running ? "live" : ""} ${done ? "done" : ""} ${prep && shown < 0.02 ? "indet" : ""}`}>
        <i style={{ width: `${Math.max(2, shown * 100)}%` }} />
      </div>
      <div className="steps">
        {steps.map(([k, label], i) => (
          <div key={k} className={`step ${i < idx || done ? "done" : i === idx && running ? "now" : ""}`}>
            <div className="ln" />{label}
          </div>
        ))}
      </div>
      {job?.warnings?.map((w) => <div key={w} className="dim tiny">↳ {w}</div>)}
    </div>
  );
}
