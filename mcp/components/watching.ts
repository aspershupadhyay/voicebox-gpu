"use client";
// Whether anyone is looking: the tab is visible and someone touched it in the last 5 minutes. The dashboard's regular
// checks (status, GPU, jobs, Files…) run only then, so a tab left open all day stops waking Vercel (docs/MIGRATION.md:
// its function usage was at 75 %). The first touch after a break counts at once, so the next check is current.
const IDLE_MS = 5 * 60_000;
let lastTouch = Date.now();
if (typeof window !== "undefined") {
  const touch = () => { lastTouch = Date.now(); };
  for (const e of ["pointermove", "pointerdown", "keydown", "scroll", "wheel", "touchstart", "focus"]) addEventListener(e, touch, { passive: true, capture: true });
}
export const watching = () => typeof document !== "undefined" && document.visibilityState === "visible" && Date.now() - lastTouch < IDLE_MS;
