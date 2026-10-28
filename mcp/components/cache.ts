"use client";
// Pages paint at once from the last copy of their data, then swap in the fresh one: a copy of every dashboard GET is
// kept in memory (instant when you move between pages) and in this browser (instant on a fresh visit): small answers in
// localStorage, the big ones (the analytics report, live numbers) in IndexedDB. Signing out clears all of it.
import { useLayoutEffect } from "react";

const PREFIX = "vb-c:";
const mem = new Map<string, unknown>();
const MAX_LS = 350_000; // characters; bigger answers stay in memory only (or go to IndexedDB by name)

/** The last copy of an answer, if this browser has one. */
export function peek<T>(key: string): T | undefined {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const s = localStorage.getItem(PREFIX + key);
    if (s) { const v = JSON.parse(s) as T; mem.set(key, v); return v; }
  } catch {}
  return undefined;
}
export function keep(key: string, value: unknown) {
  mem.set(key, value);
  try {
    const s = JSON.stringify(value);
    if (s.length < MAX_LS) localStorage.setItem(PREFIX + key, s);
  } catch {}
}

/** On mount, before the first paint: put the last copy on screen (the fetch that follows replaces it). */
export function useSeed<T>(key: string, set: (v: T) => void) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { const v = peek<T>(key); if (v !== undefined) set(v); }, [key]);
}

// ───────────── IndexedDB, for the big ones
const DB = "vb-cache";
let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= new Promise((ok, bad) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => ok(r.result);
  r.onerror = () => bad(r.error);
}));
export async function bigGet<T>(key: string): Promise<T | undefined> {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const d = await db();
    const v = await new Promise<T | undefined>((ok) => { const q = d.transaction("kv").objectStore("kv").get(key); q.onsuccess = () => ok(q.result as T | undefined); q.onerror = () => ok(undefined); });
    if (v !== undefined) mem.set(key, v);
    return v;
  } catch { return undefined; }
}
export async function bigSet(key: string, value: unknown) {
  mem.set(key, value);
  try { const d = await db(); d.transaction("kv", "readwrite").objectStore("kv").put(value, key); } catch {}
}

/** Signing out: nothing of the studio stays in this browser. */
export function clearCache() {
  mem.clear();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k); } catch {}
  try { dbp = null; indexedDB.deleteDatabase(DB); } catch {}
}
