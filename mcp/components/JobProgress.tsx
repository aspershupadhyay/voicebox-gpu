"use client";
import { X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { fmtS, type Job } from "./api";
import FetchBar, { MODEL_NAMES } from "./FetchBar";

const TTS_STEPS = [["upload", "Upload"], ["queued", "Queued"], ["cleaning", "Clean"], ["prepare", "Warm up"], ["enhancing", "Enhance"], ["generating", "Voicing"], ["choosing", "Review"], ["subtitles", "Subtitles"], ["saving", "Saving"], ["done", "Done"]] as const;
const STORY_STEPS = [["upload", "Upload"], ["queued", "Queued"], ["prepare", "Warm up"], ["generating", "Voice"], ["choosing", "Best take"], ["subtitles", "Captions"], ["visuals", "Pictures"], ["assembling", "Edit"], ["saving", "Saving"], ["done", "Done"]] as const;
const ASR_STEPS = [["upload", "Upload"], ["queued", "Queued"], ["downloading", "Fetch"], ["prepare", "Warm up"], ["transcribing", "Transcribe"], ["saving", "Saving"], ["done", "Done"]] as const;
const VIDEO_STEPS = [["upload", "Upload"], ["queued", "Queued"], ["prepare", "Warm up"], ["rendering", "Render"], ["decoding", "Decode"], ["encoding", "Encode"], ["saving", "Saving"], ["done", "Done"]] as const;
const IMAGE_STEPS = [["upload", "Upload"], ["queued", "Queued"], ["prepare", "Warm up"], ["rendering", "Render"], ["saving", "Saving"], ["done", "Done"]] as const;
const REF_STEPS = [["upload", "Upload"], ["queued", "Queued"], ["cleaning", "Clean"], ["enhancing", "Studio"], ["prepare", "Warm up"], ["transcribing", "Transcribe"], ["saving", "Saving"], ["done", "Done"]] as const;
const DATASET_STEPS = [["upload", "Upload"], ["queued", "Queued"], ["downloading", "Fetch"], ["cleaning", "Denoise"], ["prepare", "Warm up"], ["transcribing", "Transcribe"], ["cutting", "Cut clips"], ["saving", "Saving"], ["done", "Done"]] as const;
const saved = (job: Job | null) => !!(job?.library || job?.myvoice || (job as { part?: unknown; kvoice_saved?: unknown } | null)?.part || (job as { kvoice_saved?: unknown } | null)?.kvoice_saved);

function stepKey(job: Job | null, uploading: boolean) {
  if (uploading) return "upload";
  if (!job) return "queued";
  const s = job.progress.stage;
  if (job.status === "done") return saved(job) ? "done" : "saving";
  if ((job.kind === "reference" || job.mode === "revoice" || job.mode === "clean") && s === "downloading") return "cleaning";
  if (job.mode === "story") {
    // the story warms up several models; keep the stepper moving forward instead of jumping back to "Warm up"
    const d = job.progress.detail ?? "";
    if (["installing", "loading"].includes(s) && /zimage|wan/.test(d)) return "visuals";
    if (["installing", "loading"].includes(s) && /whisper/.test(d) && job.results.length) return "subtitles";
    if (s === "downloading") return job.results.length ? "visuals" : "upload";
  }
  if (s === "fixing") return "choosing"; // re-voicing the sentences the review flagged
  if (["denoising", "checking"].includes(s) && (job.kind === "reference" || job.mode)) return "enhancing";
  if (s === "enhancing" && job.kind === "tts" && !job.mode) return "generating"; // post.enhance polish between lines
  if (s === "enhancing" && job.kind === "reference") return "enhancing";
  if (["installing", "loading", "reference"].includes(s)) return "prepare";
  if (s === "packaging") return "saving";
  if (job.kind === "image" && ["decoding", "encoding"].includes(s)) return "saving";
  if (job.kind === "dataset" && ["denoising", "checking"].includes(s)) return "cleaning";
  return s;
}

/** Live job progress: stage stepper + a bar that glides between polls using the worker's ETA. */
export default function JobProgress({ job, uploading, uploadFrac, onCancel, kind: kindHint }: {
  job: Job | null; uploading?: boolean; uploadFrac?: number; onCancel?: () => void; kind?: Job["kind"];
}) {
  const [shown, setShown] = useState(0);
  const [, tick] = useState(0);
  const anchor = useRef({ f: 0, eta: 0, at: 0 });
  const kind = job?.kind ?? kindHint ?? (uploading ? "transcribe" : "tts");
  const all: readonly (readonly [string, string])[] = job?.mode === "story" ? STORY_STEPS : kind === "transcribe" ? ASR_STEPS : kind === "video" ? VIDEO_STEPS : kind === "image" ? IMAGE_STEPS : kind === "reference" ? REF_STEPS : kind === "dataset" ? DATASET_STEPS : TTS_STEPS;
  const revoice = job?.mode === "revoice", clean = job?.mode === "clean", story = job?.mode === "story";
  const steps = all.filter(([k]) => (k !== "subtitles" || job?.subtitles || story) && (k !== "choosing" || (job?.takes ?? 1) > 1 || !!job?.review)
    && (k !== "cleaning" || kind !== "tts" || revoice || clean) && (k !== "enhancing" || kind === "reference" || revoice || clean)
    && (k !== "generating" || !clean)
    && (k !== "upload" || kind === "transcribe" || kind === "reference" || revoice || clean || uploading || job?.gen?.source || !!job?.gen?.refs));
  const key = stepKey(job, !!uploading);
  const idx = Math.max(0, steps.findIndex(([k]) => k === key));
  const running = uploading || (job && ["queued", "running"].includes(job.status)) || (job?.status === "done" && !saved(job));
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
    : job.status === "done" ? (saved(job) ? (kind === "reference" ? "Done · your voice is ready" : kind === "dataset" ? "Done · added to the dataset" : "Done · saved to library") : kind === "reference" ? "Saving your voice…" : kind === "dataset" ? "Adding to the dataset…" : "Saving to library…")
    : job.status === "error" ? "Failed" : job.status === "cancelled" ? "Cancelled"
    : prep ? (p!.fetch?.phase === "downloading" ? `Downloading ${MODEL_NAMES[job.engine] ?? job.engine} (first time only)` : p!.stage === "installing" ? "Installing engine (first run only)" : "Loading model onto the GPU")
    : key === "generating" ? `${revoice ? "Re-voicing" : "Voicing"} ${p!.detail}` : key === "choosing" ? `Picking the best take · ${p!.detail}` : key === "subtitles" ? "Writing subtitles" : key === "transcribing" ? (kind === "reference" ? "Writing down what you said" : kind === "dataset" ? (p!.detail || "Writing down every word") : `Transcribing ${p!.detail}`) : key === "cutting" ? (p!.detail || "Cutting clean clips")
    : key === "downloading" ? (job.engine === "animate" ? "Fetching your character and motion clip" : kind === "video" ? "Fetching the start frame" : kind === "image" ? "Fetching reference images" : "Fetching your files") : key === "rendering" ? `Rendering · ${p!.detail}` : key === "encoding" ? "Encoding the MP4"
    : key === "cleaning" ? (revoice ? "Cleaning up your performance" : kind === "dataset" ? `Removing background noise${p!.detail ? ` · ${p!.detail}` : ""}` : "Cleaning up your recording")
    : key === "enhancing" ? `Studio clean-up · ${p!.detail}` : key === "visuals" ? `Making the pictures · ${p!.detail}`
    : key === "assembling" ? `Editing the video · ${p!.detail}` : "Working";

  const done = job?.status === "done" && saved(job);
  const failed = job?.status === "error" || job?.status === "cancelled";
  const N = 48, lit = Math.round(shown * N);

  return (
    <div className="card rec reveal">
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <span className={`recdot ${done ? "done" : ""}`} style={failed ? { color: "var(--dim)" } : undefined}><i style={failed ? { background: "var(--faint)", boxShadow: "none", animation: "none" } : undefined} />{done ? "SAVED" : failed ? "STOPPED" : running ? "REC" : "READY"}</span>
          <h3>{headline}</h3>
          <div className="dim small" style={{ marginTop: 4 }}>
            {prep ? p?.detail : job?.status === "running" ? (kind === "video" || kind === "reference" || kind === "image" || revoice || clean ? p?.detail || " " : `${p?.done ?? 0} of ${p?.total ?? 0} ${kind === "transcribe" || kind === "dataset" ? "files" : "lines"} finished`) : job?.error ?? " "}
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
      {prep && p?.fetch && <FetchBar f={p.fetch} name={job?.engine} />}
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
