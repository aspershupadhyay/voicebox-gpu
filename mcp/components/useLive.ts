"use client";
// Grow's minute-by-minute numbers (lib/live.ts), shared by every Grow page. Asked again every 30 seconds, but only
// while this tab is visible and someone has touched the page in the last 5 minutes: each ask also tells the server
// someone is watching, and the minute timer only reads YouTube and Instagram while someone is. Away = no API calls.
import { useCallback, useEffect, useState } from "react";
import type { LiveView } from "@/lib/live-shared";
import { api } from "./api";

let kept: LiveView | null = null;
let asking: Promise<LiveView> | null = null;
const ask = () => (asking ??= api<LiveView>("live").then((r) => { kept = r; return r; }).finally(() => { asking = null; }));

const IDLE_MS = 5 * 60_000;
let lastActive = Date.now();
if (typeof window !== "undefined") {
  const touch = () => { lastActive = Date.now(); };
  for (const e of ["pointermove", "pointerdown", "keydown", "scroll", "wheel", "touchstart", "focus"]) addEventListener(e, touch, { passive: true, capture: true });
}
/** Visible and touched in the last 5 minutes. */
const watching = () => document.visibilityState === "visible" && Date.now() - lastActive < IDLE_MS;

export function useLive(every = 30_000) {
  const [data, setData] = useState<LiveView | null>(kept);
  const [err, setErr] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const load = useCallback(() => ask().then((r) => { setData(r); setErr(null); }, (e) => setErr((e as Error).message)), []);
  useEffect(() => {
    let off = false; // paused, as the listeners see it
    const beat = () => {
      off = !watching();
      setPaused(off);
      if (!off) load();
    };
    beat();
    const t = setInterval(beat, every);
    // coming back (the tab shows again, or a touch after being away): ask at once instead of waiting for the next beat
    const back = () => { if (off && watching()) beat(); };
    document.addEventListener("visibilitychange", back);
    addEventListener("pointerdown", back);
    addEventListener("keydown", back);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", back); removeEventListener("pointerdown", back); removeEventListener("keydown", back); };
  }, [load, every]);
  return { data, err, paused, reload: load };
}

/** "40 s ago", "3 min ago" for the live chip, ticking each second. */
export function useAgo(at: number | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!at) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}
