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

export const fmtS = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(s < 10 ? 2 : 1)}s`);
export const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ms).toLocaleDateString();
};
export const audioUrl = (job: string, line: string, download?: string) =>
  `/api/audio/${job}/${line}.wav${download ? `?download&name=${encodeURIComponent(download)}` : ""}`;
