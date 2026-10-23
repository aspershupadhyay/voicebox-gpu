"use client";
import { CloudArrowDown, Cpu, Package } from "@phosphor-icons/react";
import { fmtS, type Fetch } from "./api";

export const MODEL_NAMES: Record<string, string> = {
  wan: "Wan 2.2", wan14: "Wan 14B", ltx: "LTX-2.5", animate: "Wan Animate", zimage: "Z-Image", qwenimage: "Qwen-Image 2.1",
  orpheus: "Orpheus", chatterbox: "Chatterbox", kokoro: "Kokoro", qwen: "Qwen3-TTS", whisper: "Whisper", enhance: "Resemble Enhance",
};

/** A model warming up: real download progress (GB landed on the worker's disk / expected, speed, time left), then
 *  an indeterminate "loading onto the GPU" bar. */
export default function FetchBar({ f, name, compact }: { f: Fetch; name?: string; compact?: boolean }) {
  const pct = f.total_gb ? Math.min(100, (f.gb / f.total_gb) * 100) : 0;
  const label = name ? MODEL_NAMES[name] ?? name : "model";
  const Icon = f.phase === "downloading" ? CloudArrowDown : f.phase === "installing" ? Package : Cpu;
  return (
    <div className={`fetch ${f.phase} ${compact ? "compact" : ""}`}>
      <div className="row between fetch-head">
        <span className="row" style={{ gap: 8 }}>
          <Icon size={compact ? 14 : 17} weight="duotone" />
          <b className="small">
            {f.phase === "downloading" ? `Downloading ${label}` : f.phase === "installing" ? `Installing ${label} (first run)` : `Loading ${label} onto the GPU`}
          </b>
        </span>
        <span className="mono small dim">
          {f.phase === "downloading" ? <>
            {f.gb.toFixed(1)} / {f.total_gb.toFixed(0)} GB{f.mbps > 0 && <> · {f.mbps >= 1000 ? `${(f.mbps / 1000).toFixed(1)} GB/s` : `${f.mbps} MB/s`}</>}
            {f.eta_s ? <> · <span style={{ color: "var(--signal2)" }}>~{fmtS(f.eta_s)} left</span></> : null}
          </> : fmtS(f.elapsed_s)}
        </span>
      </div>
      <div className={`fetch-track ${f.phase !== "downloading" ? "indet" : ""}`}>
        <i style={{ width: f.phase === "downloading" ? `${Math.max(1.5, pct)}%` : "100%" }} />
      </div>
      {!compact && f.phase === "downloading" && <div className="tiny dim" style={{ marginTop: 6 }}>One-time download. It stays on the GPU machine's disk until the runtime restarts.</div>}
    </div>
  );
}
