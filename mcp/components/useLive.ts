"use client";
// Grow → Live and Competitors: the minute-by-minute numbers (lib/live.ts), shared by both pages and asked again every
// 30 seconds while one is open. One copy in memory, so moving between them shows it at once.
import { useCallback, useEffect, useState } from "react";
import type { LiveView } from "@/lib/live";
import { api } from "./api";

let kept: LiveView | null = null;
let asking: Promise<LiveView> | null = null;
const ask = () => (asking ??= api<LiveView>("live").then((r) => { kept = r; return r; }).finally(() => { asking = null; }));

export function useLive(every = 30_000) {
  const [data, setData] = useState<LiveView | null>(kept);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => ask().then((r) => { setData(r); setErr(null); }, (e) => setErr((e as Error).message)), []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, every);
    return () => clearInterval(t);
  }, [load, every]);
  return { data, err, reload: load };
}

/** "40 s ago", "3 min ago" for the live chip, ticking each second. */
export function useAgo(at: number | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!at) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}
