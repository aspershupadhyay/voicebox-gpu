"use client";
// Publishing state shared by every component on a page: connected accounts, every plan, the automation rules.
// Loaded from /api/dash/publish, refreshed every 15 s (every 3 s while something is going out) and when the tab returns.
import { useEffect, useState } from "react";
import type { Account } from "@/lib/publish/accounts";
import { BUSY, type Plan, type Rules } from "@/lib/publish/shared";
import { api } from "./api";

type State = { accounts: Account[]; plans: Plan[]; rules: Rules | null; configured: { youtube: boolean; instagram: boolean }; loaded: boolean; error: string | null };
let st: State = { accounts: [], plans: [], rules: null, configured: { youtube: false, instagram: false }, loaded: false, error: null };
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const set = (p: Partial<State>) => { st = { ...st, ...p }; emit(); };

export function refreshPublish() {
  inflight ??= api<Omit<State, "loaded" | "error">>("publish").then((r) => set({ ...r, loaded: true, error: null }))
    .catch((e) => set({ loaded: true, error: (e as Error).message })).finally(() => { inflight = null; });
  return inflight;
}

/** Put a plan the server just returned into the shared list. */
export function notePlan(p: Plan | null, gone?: { post: string; space: string }) {
  const k = (x: { post: string; space: string }) => `${x.post}/${x.space}`;
  const drop = p ? k(p) : gone ? k(gone) : "";
  set({ plans: [...st.plans.filter((x) => k(x) !== drop), ...(p ? [p] : [])] });
}
export const noteRules = (rules: Rules) => set({ rules });
export const planFor = (post: string, space: string) => st.plans.find((p) => p.post === post && p.space === space) ?? null;

export function usePublish() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    if (!st.loaded) refreshPublish();
    let t: ReturnType<typeof setTimeout>;
    const loop = () => { t = setTimeout(async () => { if (document.visibilityState === "visible") await refreshPublish(); loop(); }, st.plans.some((p) => BUSY.includes(p.state)) ? 3000 : 15000); };
    loop();
    const vis = () => { if (document.visibilityState === "visible") refreshPublish(); };
    document.addEventListener("visibilitychange", vis);
    return () => { subs.delete(f); clearTimeout(t); document.removeEventListener("visibilitychange", vis); };
  }, []);
  return st;
}
