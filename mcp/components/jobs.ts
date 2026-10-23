"use client";
// Jobs you started, remembered in this browser (localStorage) so nothing is lost to a refresh, a closed tab or another
// page: the work itself always runs on the GPU worker; this is what keeps the dashboard following it. The tray in the
// shell polls every tracked job (which is also what stores finished results: a voice, a dataset session, a trained model,
// a library entry) and each page picks its own running job back up when you return (useResumeJob).
import { useEffect, useRef, useState } from "react";

export type Tracked = {
  id: string; kind: string; label: string; path: string; at: number;
  status: string; fraction?: number; stage?: string; detail?: string; settled?: number; error?: string;
};

const KEY = "vb-jobs";
const KEEP_MS = 30 * 60_000; // finished jobs stay in the tray this long
const subs = new Set<() => void>();

function read(): Tracked[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]") as Tracked[]; } catch { return []; }
}
function write(list: Tracked[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30))); } catch { /* private mode: the tray just forgets */ }
  subs.forEach((f) => f());
}

export function trackJob(j: { id: string; status?: string; label?: string }, kind: string, label?: string) {
  if (typeof window === "undefined" || !j?.id) return;
  const list = read().filter((x) => x.id !== j.id);
  write([{ id: j.id, kind, label: label || j.label || kind, path: location.pathname, at: Date.now(), status: j.status || "queued" }, ...list]);
}

export function updateTracked(id: string, patch: Partial<Tracked>) {
  write(read().map((x) => (x.id === id ? { ...x, ...patch } : x)));
}

export function forgetTracked(id: string) {
  write(read().filter((x) => x.id !== id));
}

export const isLive = (t: Tracked) => !t.settled;

export function useTracked() {
  const [list, setList] = useState<Tracked[]>([]);
  useEffect(() => {
    const f = () => setList(read().filter((x) => !x.settled || Date.now() - x.settled < KEEP_MS));
    f();
    subs.add(f);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) f(); }; // another tab started or finished something
    window.addEventListener("storage", onStorage);
    return () => { subs.delete(f); window.removeEventListener("storage", onStorage); };
  }, []);
  return list;
}

/** On a page that starts jobs: when you come back (refresh, another tab, another page), hand the page its latest job of
 *  these kinds that is still running or finished in the last 15 minutes, so it shows progress / the result again. */
export function useResumeJob<J extends { id: string }>(kinds: string[], resume: (job: J) => void, enabled = true) {
  const done = useRef(false);
  const fn = useRef(resume);
  fn.current = resume;
  const key = kinds.join(",");
  useEffect(() => {
    if (done.current || !enabled) return;
    done.current = true;
    const t = read().find((x) => key.split(",").includes(x.kind) && x.path === location.pathname && (!x.settled || Date.now() - x.settled < 15 * 60_000));
    if (!t) return;
    fetch(`/api/dash/jobs/${t.id}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.id) fn.current(j as J); }).catch(() => {});
  }, [key, enabled]);
}
