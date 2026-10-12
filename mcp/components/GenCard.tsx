"use client";
import { WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { fmtS, type Job } from "./api";

const STAGE: Record<string, string> = {
  queued: "in the queue", installing: "installing the model", loading: "warming up the GPU", downloading: "fetching inputs",
  rendering: "dreaming it up", decoding: "developing", encoding: "finishing", packaging: "saving", saving: "saving",
};

/** Smoothed 0..1 progress that glides between polls toward the worker's ETA (never overshoots). */
export function useGlide(job: Job | null) {
  const [shown, setShown] = useState(0);
  const anchor = useRef({ f: 0, eta: 0, at: 0 });
  useEffect(() => { if (job) anchor.current = { f: job.progress.fraction, eta: job.progress.eta_s, at: performance.now() }; }, [job]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const { f, eta, at } = anchor.current;
      let target = f;
      if (job?.status === "running" && eta > 0) {
        const dt = (performance.now() - at) / 1000;
        target = Math.min(f + (1 - f) * (dt / (eta + dt)), f + (1 - f) * 0.85);
      }
      if (job?.status === "done") target = 1;
      setShown((s) => s + (target - s) * 0.08);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [job]);
  const left = job?.status === "running" ? Math.max(0, job.progress.eta_s - (performance.now() - anchor.current.at) / 1000) : 0;
  return { shown, left };
}

/** A generation in flight, Higgsfield-style: drifting aurora, film grain and a scanning light inside the frame's own
 *  aspect ratio, with live % / stage / time left. */
export function PendingCard({ job, w, h, label }: { job: Job | null; w: number; h: number; label?: string }) {
  const { shown, left } = useGlide(job);
  const failed = job?.status === "error" || job?.status === "cancelled";
  if (failed) return (
    <div className="gen-card failed" style={{ aspectRatio: `${w} / ${h}` }}>
      <div className="stack" style={{ alignItems: "center", gap: 6, padding: 16, textAlign: "center" }}>
        <WarningCircle size={26} weight="duotone" color="var(--signal2)" />
        <b className="small">{job?.status === "cancelled" ? "Cancelled" : "Failed"}</b>
        {job?.error && <span className="tiny dim clamp2">{job.error}</span>}
      </div>
    </div>
  );
  const stage = !job ? "sending" : job.status === "queued" ? (job.queue_position ? `#${job.queue_position} in the queue` : "in the queue")
    : job.status === "done" ? "saving" : (job.progress.fetch?.phase === "downloading" ? "downloading the model" : STAGE[job.progress.stage] ?? job.progress.stage);
  return (
    <div className="gen-card pending" style={{ aspectRatio: `${w} / ${h}` }}>
      <div className="grain" />
      <div className="hud">
        <div className="row between" style={{ alignItems: "flex-end" }}>
          <span className="pct">{Math.round(shown * 100)}%</span>
          {left > 0 && <span className="mono tiny" style={{ color: "rgba(255,255,255,.8)" }}>~{fmtS(left)}</span>}
        </div>
        <div className="stage">{label ? `${label} · ` : ""}{stage}{job?.progress.detail && job.status === "running" && !["loading", "installing"].includes(job.progress.stage) ? ` · ${job.progress.detail}` : ""}</div>
        <div className="track"><i style={{ width: `${Math.max(2, shown * 100)}%` }} /></div>
      </div>
    </div>
  );
}
