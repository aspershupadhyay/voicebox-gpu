"use client";
import { keep } from "./cache";
export { peek, useSeed } from "./cache";

/** Answers worth keeping a copy of: plain reads, not one job's progress or the GPU's heartbeat. */
const keepable = (path: string) => !/^(jobs\/|status|analytics|live$|engines\/)/.test(path) && !path.includes("fresh=");

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`/api/dash/${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (r.status === 401) { (await import("./cache")).clearCache(); location.href = "/login"; throw new Error("unauthorized"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, body: data });
  if (!init?.body && !init?.method && keepable(path)) keep(path, data);
  if ((path === "jobs" || path === "myvoices") && init?.body && data?.id) {
    // remember it so the tray and this page can follow it through a refresh (jobs.ts)
    const b = init.body as { kind?: string; label?: string; name?: string };
    const kind = path === "myvoices" ? "reference" : b.kind || "voice";
    import("./jobs").then((m) => m.trackJob(data, kind, b.label || (kind === "reference" ? `Voice · ${b.name}` : undefined)));
  }
  return data as T;
}

/** PUT a blob with progress. Rejects with `status` 0 for a dropped connection (or a refused cross-site PUT). */
function put(url: string, file: Blob, onProgress?: (f: number) => void) {
  return new Promise<void>((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    if (file.type) x.setRequestHeader("Content-Type", file.type);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      if (x.status < 300) return ok();
      let msg = ""; try { msg = JSON.parse(x.responseText).error ?? ""; } catch {}
      bad(Object.assign(new Error(`upload failed (${x.status}${msg ? `: ${msg}` : ""})`), { status: x.status }));
    };
    x.onerror = () => bad(Object.assign(new Error("upload failed: the connection dropped"), { status: 0 }));
    x.send(file);
  });
}

/** Upload a file into storage with progress; resolves to its storage key. Up to 95 MB the bytes go through our own
 *  domain (/api/upload/put: same origin, so the bucket's CORS never matters), with a few tries if the line drops;
 *  bigger files, or if those tries all fail, straight to the bucket's presigned address. A failure never touches the
 *  recording itself: takes stay on this device (takes.ts) until a batch is safely in the dataset. */
export async function uploadFile(file: Blob, name: string, onProgress?: (f: number) => void): Promise<string> {
  const r = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type: file.type }) });
  const t = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = "/login"; throw new Error("signed out: sign in again (your recording is still saved here)"); }
  if (!r.ok) throw new Error(t.error || `upload HTTP ${r.status}`);
  const key = t.key as string;
  let last: Error | null = null;
  if (file.size <= 95e6) {
    for (let i = 0; i < 3; i++) {
      try { await put(`/api/upload/put?key=${encodeURIComponent(key)}`, file, onProgress); onProgress?.(1); return key; }
      catch (e) {
        const s = (e as { status?: number }).status ?? 0;
        if (s === 409) { onProgress?.(1); return key; } // it's stored already
        last = e as Error;
        if (s === 400 || s === 401 || s === 411) break; // retrying won't change the answer
        onProgress?.(0);
        await new Promise((w) => setTimeout(w, 1500 * (i + 1)));
      }
    }
  }
  try { await put(t.url, file, onProgress); }
  catch (e) { throw last && (e as { status?: number }).status === 0 ? last : (e as Error); }
  onProgress?.(1);
  return key;
}

export const fmtS = (s: number) => {
  if (!isFinite(s)) return "—";
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
};
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
export const fileUrl = (job: string, name: string, download?: string) =>
  `/api/file/${job}/${name}${download ? `?download&name=${encodeURIComponent(download)}` : ""}`;
export const pct = (x?: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
export const matchClass = (x?: number | null) => (x == null ? "" : x >= 0.95 ? "ok" : x >= 0.85 ? "warn" : "bad");
/** Speaker-embedding cosine: 0.86 is the same-speaker threshold of the WavLM SV model. */
export const simClass = (x?: number | null) => (x == null ? "" : x >= 0.9 ? "ok" : x >= 0.86 ? "warn" : "bad");

export type Status = {
  online: boolean; reason?: string; last_seen?: number; uptime_s?: number; queue?: number; running?: string[];
  /** The GPU that takes the next job, and a Modal one that's asleep until then (lib/gpus.ts). */
  backend?: "colab" | "kaggle" | "modal" | "cerebrium"; asleep?: boolean; starting?: boolean; gpus?: Gpus;
  gpu?: { name: string; total_gb: number; used_gb: number }; vram_budget_gb?: number; version?: string;
  engines?: Record<string, string>; engine_errors?: Record<string, string>; rates?: Record<string, number>;
  ram?: { total_gb: number; used_gb: number }; disk?: { total_gb: number; free_gb: number; weights_gb: Record<string, number> };
  mode?: "voice" | "visual" | "idle" | "mixed"; idle_unload_s?: Record<string, number>; idle_min?: number;
  fetch?: Record<string, Fetch>;
};
export type CloudGpu = { configured: boolean; awake: boolean; available: boolean; used_h: number; cap_h: number; over_cap: boolean; gpu: string | null; connected_at: number | null; url_from: "env" | "settings" | null };
/** Kaggle (lib/kaggle.ts): started by the app for work, stops itself when idle. */
export type KaggleGpu = { configured: boolean; on: boolean; online: boolean; starting: boolean; used_h_this_week: number; cap_h: number; over_cap: boolean; idle_stop_min: number; gpu: string | null };
export type Gpus = {
  prefer: "colab" | "kaggle" | "modal" | "cerebrium"; fallback: boolean; modal_heavy: boolean;
  colab: { online: boolean; last_seen: number | null; gpu: string | null };
  kaggle: KaggleGpu;
  modal: CloudGpu; cerebrium: CloudGpu;
};
/** Live download / load progress of an engine that's warming up (worker measures its weights landing on disk). */
export type Fetch = { phase: "installing" | "downloading" | "loading"; gb: number; total_gb: number; mbps: number; eta_s: number | null; elapsed_s: number };
export type Gen = {
  model: string; mode: string; prompt: string; negative?: string; seed: number; steps: number; guidance?: number; quality?: string;
  aspect?: string; fps?: number; frames?: number; seconds?: number; width?: number; height?: number; audio?: boolean; source?: boolean;
  count?: number; refs?: number; transparent?: boolean; adult?: boolean; retarget?: boolean;
};
export type GenImage = { file: string; thumb: string; width: number; height: number; transparent?: boolean; url?: string; thumb_url?: string };
export type VideoInfo = { frames: number; width: number; height: number; fps: number; duration: number; has_audio?: boolean; size?: number; poster?: boolean };
export type Word = { w: string; s: number; e: number };
export type JobResult = {
  id: string; text: string; duration: number; window?: number | null; fits?: boolean | null; start?: number | null;
  url?: string; heard?: string; match?: number | null; subs?: boolean; name?: string; chunks?: number; cues?: number;
  srt_url?: string; vtt_url?: string; poster_url?: string; cut?: boolean; level_db?: number;
  file?: string; thumb?: string; width?: number; height?: number; transparent?: boolean; thumb_url?: string;
  lufs?: number | null; similarity?: number | null; spoken?: string; engine?: string; enhanced?: boolean; takes?: { n: number; picked: number[]; match: number; similarity: number | null };
  review?: Review | null; diff?: { missed: string[]; added: string[] } | null; cleanup?: Cleanup | null;
};
export type Review = { retried: number; fixed: number; issues: { chunk: number; missed: string[]; added: string[]; match: number | null; similarity: number | null }[] };
type Measure = { snr_db: number | null; bandwidth_hz: number | null; reverb_s: number | null; clipped: number | null };
export type Cleanup = { steps: string[]; why: string; identity: number | null; before: Measure; after: Measure };
export type Job = {
  id: string; kind: "tts" | "transcribe" | "video" | "reference" | "image" | "dataset" | "train" | "benchmark"; engine: string; voice: string; status: string; error?: string; label?: string;
  progress: { done: number; total: number; fraction: number; eta_s: number; stage: string; detail: string; elapsed_s: number; fetch?: Fetch | null };
  queue_position?: number; results: JobResult[]; warnings?: string[]; subs?: { cues: number; timeline: string } | null;
  match?: number | null; library?: { id: string } | null; subtitles?: boolean; gen?: Gen; video?: VideoInfo | null;
  review?: boolean; profile?: { sim_base: number | null; learned: Record<string, number> } | null;
  myvoice?: MyVoice | null; platform?: string; captions?: string; takes?: number; mode?: string; similarity?: number | null;
  scenes?: { id: string; text: string; start: number; seconds: number; prompt?: string | null; match?: number | null; animated?: boolean }[];
  live?: { id: string; duration: number; url: string }[]; // listen live: lines made but not finished yet
};
export type MyVoice = { name: string; label: string; transcript: string; duration: number; version: string; created: number; warnings?: string[]; url?: string; level_db?: number; enhanced?: boolean };
export type Samples = { text: Record<string, string>; voices: Record<string, Record<string, { duration: number; url: string }>> };

/** Fill the slider track up to the thumb (globals.css reads --v). */
export const rangeFill = (v: number, min = 0, max = 1) => ({ ["--v" as string]: `${((v - min) / (max - min || 1)) * 100}%` }) as React.CSSProperties;
