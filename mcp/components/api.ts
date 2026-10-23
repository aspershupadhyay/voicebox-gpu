"use client";
export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`/api/dash/${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (r.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data as T;
}

/** Upload a file straight to storage (presigned PUT) with progress; resolves to its storage key. */
export async function uploadFile(file: Blob, name: string, onProgress?: (f: number) => void): Promise<string> {
  const r = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type: file.type }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(t.error || `upload HTTP ${r.status}`);
  await new Promise<void>((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open("PUT", t.url);
    if (file.type) x.setRequestHeader("Content-Type", file.type);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? ok() : bad(new Error(`upload failed (${x.status})`)));
    x.onerror = () => bad(new Error("upload failed (network or storage CORS)"));
    x.send(file);
  });
  onProgress?.(1);
  return t.key as string;
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
  gpu?: { name: string; total_gb: number; used_gb: number }; vram_budget_gb?: number; version?: string;
  engines?: Record<string, string>; engine_errors?: Record<string, string>; rates?: Record<string, number>;
  ram?: { total_gb: number; used_gb: number }; disk?: { total_gb: number; free_gb: number; weights_gb: Record<string, number> };
  mode?: "voice" | "visual" | "idle" | "mixed"; idle_unload_s?: Record<string, number>; idle_min?: number;
  fetch?: Record<string, Fetch>;
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
  lufs?: number | null; similarity?: number | null; spoken?: string; engine?: string; takes?: { n: number; picked: number[]; match: number; similarity: number | null };
};
export type Job = {
  id: string; kind: "tts" | "transcribe" | "video" | "reference" | "image"; engine: string; voice: string; status: string; error?: string; label?: string;
  progress: { done: number; total: number; fraction: number; eta_s: number; stage: string; detail: string; elapsed_s: number; fetch?: Fetch | null };
  queue_position?: number; results: JobResult[]; warnings?: string[]; subs?: { cues: number; timeline: string } | null;
  match?: number | null; library?: { id: string } | null; subtitles?: boolean; gen?: Gen; video?: VideoInfo | null;
  myvoice?: MyVoice | null; platform?: string; captions?: string; takes?: number; mode?: string; similarity?: number | null;
};
export type MyVoice = { name: string; label: string; transcript: string; duration: number; version: string; created: number; warnings?: string[]; url?: string; level_db?: number };
export type Samples = { text: Record<string, string>; voices: Record<string, Record<string, { duration: number; url: string }>> };

/** Fill the slider track up to the thumb (globals.css reads --v). */
export const rangeFill = (v: number, min = 0, max = 1) => ({ ["--v" as string]: `${((v - min) / (max - min || 1)) * 100}%` }) as React.CSSProperties;
