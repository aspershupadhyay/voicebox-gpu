"use client";
// Recordings that survive a refresh, a closed tab or a crash: while you record, every second of audio is written to this
// browser's IndexedDB. A take stays there until it's used (sent to the worker) or discarded, and every page that records
// offers its unsent takes back (SavedTakes). Nothing leaves the device until you send it.
import { useCallback, useEffect, useState } from "react";

export type Take = { id: string; scope: string; created: number; mime: string; secs: number; done: boolean; note?: string };

const DB = "vb-takes";
let dbp: Promise<IDBDatabase> | null = null;

function db() {
  dbp ??= new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("takes", { keyPath: "id" });
      r.result.createObjectStore("chunks", { keyPath: ["take", "seq"] });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
  return dbp;
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((ok, bad) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => ok(req ? req.result : undefined);
    t.onerror = () => bad(t.error);
    t.onabort = () => bad(t.error);
  });
}

const changed = new Set<() => void>();
const emit = () => changed.forEach((f) => f());

export async function newTake(scope: string, mime: string, note?: string): Promise<Take> {
  const take: Take = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, scope, created: Date.now(), mime, secs: 0, done: false, note };
  await tx(["takes"], "readwrite", (t) => t.objectStore("takes").put(take)).catch(() => {});
  emit();
  return take;
}

export async function addChunk(take: Take, seq: number, blob: Blob, secs: number) {
  take.secs = secs;
  await tx(["takes", "chunks"], "readwrite", (t) => {
    t.objectStore("chunks").put({ take: take.id, seq, blob });
    t.objectStore("takes").put(take);
  }).catch(() => {});
}

export async function finishTake(take: Take, secs: number) {
  take.secs = secs;
  take.done = true;
  await tx(["takes"], "readwrite", (t) => t.objectStore("takes").put(take)).catch(() => {});
  emit();
}

export async function listTakes(scope: string): Promise<Take[]> {
  const all = (await tx<Take[]>(["takes"], "readonly", (t) => t.objectStore("takes").getAll()).catch(() => [])) ?? [];
  return all.filter((x) => x.scope === scope).sort((a, b) => b.created - a.created);
}

/** The take as one file (its chunks in order; a take cut short by a refresh still plays). */
export async function takeFile(take: Take): Promise<File | null> {
  const range = IDBKeyRange.bound([take.id, 0], [take.id, Number.MAX_SAFE_INTEGER]);
  const rows = (await tx<{ seq: number; blob: Blob }[]>(["chunks"], "readonly", (t) => t.objectStore("chunks").getAll(range)).catch(() => [])) ?? [];
  if (!rows.length) return null;
  rows.sort((a, b) => a.seq - b.seq);
  const ext = take.mime.includes("mp4") ? "m4a" : "webm";
  return new File(rows.map((r) => r.blob), `${take.scope}-${new Date(take.created).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${ext}`, { type: take.mime });
}

export async function dropTake(id: string) {
  const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  await tx(["takes", "chunks"], "readwrite", (t) => { t.objectStore("chunks").delete(range); t.objectStore("takes").delete(id); }).catch(() => {});
  emit();
}

/** Unsent takes for one page, kept current. A take still being recorded in this tab is left out. */
export function useTakes(scope: string, live?: string | null) {
  const [takes, setTakes] = useState<Take[]>([]);
  const load = useCallback(() => { listTakes(scope).then((t) => setTakes(t.filter((x) => !(live ?? "").split(",").includes(x.id) && x.secs > 0.5))); }, [scope, live]);
  useEffect(() => { load(); changed.add(load); return () => { changed.delete(load); }; }, [load]);
  return takes;
}
