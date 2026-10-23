"use client";
// Every post's targets (spaces + per-target stage, date, link), shared by every component on the page. Loaded from
// /api/dash/spaces, refreshed every 15 s and whenever the tab comes back, saved optimistically.
import { useEffect, useState } from "react";
import type { Goals, Target, TargetMap } from "@/lib/spaces";
import { api } from "./api";

let map: TargetMap = {};
let goals: Goals = {};
let loaded = false;
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function refresh() {
  inflight ??= api<{ posts: TargetMap; goals?: Goals }>("spaces").then((r) => { map = r.posts ?? {}; goals = r.goals ?? {}; loaded = true; emit(); }).catch(() => {}).finally(() => { inflight = null; });
  return inflight;
}

export async function saveTargets(postId: string, targets: Target[]) {
  map = { ...map, [postId]: targets };
  emit();
  const r = await api<{ targets: Target[] }>(`spaces/${postId}`, { body: { targets } });
  map = { ...map, [postId]: r.targets };
  emit();
  return r.targets;
}

export async function saveGoals(next: Goals) {
  goals = next;
  emit();
  goals = (await api<{ goals: Goals }>("spaces/goals", { body: { goals: next } })).goals;
  emit();
}

export async function forgetTargets(postId: string) {
  const { [postId]: _, ...rest } = map;
  map = rest;
  emit();
  await api(`spaces/${postId}`, { method: "DELETE" }).catch(() => {});
}

export function useTargets() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    if (!loaded) refresh();
    const t = setInterval(refresh, 15_000);
    const vis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", vis);
    return () => { subs.delete(f); clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, []);
  return { map, goals, loaded };
}
