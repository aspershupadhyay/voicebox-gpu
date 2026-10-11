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

export type Status = {
  online: boolean; reason?: string; last_seen?: number; uptime_s?: number; queue?: number; running?: string[];
  gpu?: { name: string; total_gb: number; used_gb: number }; vram_budget_gb?: number; version?: string;
  engines?: Record<string, string>; engine_errors?: Record<string, string>; rates?: Record<string, number>;
};
export type Word = { w: string; s: number; e: number };
export type JobResult = {
  id: string; text: string; duration: number; window?: number | null; fits?: boolean | null; start?: number | null;
  url?: string; heard?: string; match?: number | null; subs?: boolean; name?: string; chunks?: number; cues?: number;
  srt_url?: string; vtt_url?: string;
};
export type Job = {
  id: string; kind: "tts" | "transcribe"; engine: string; voice: string; status: string; error?: string; label?: string;
  progress: { done: number; total: number; fraction: number; eta_s: number; stage: string; detail: string; elapsed_s: number };
  queue_position?: number; results: JobResult[]; warnings?: string[]; subs?: { cues: number; timeline: string } | null;
  match?: number | null; library?: { id: string } | null; subtitles?: boolean;
};
