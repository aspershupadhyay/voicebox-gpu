"use client";
// The analytics report, shared by Home and every Analytics page: one copy per range kept in memory, so moving between
// the sub-pages (or from Home) shows it at once, and one request at a time per range. The server answers an old copy
// at once marked `stale`; this hook then asks once more with `wait`, which builds the new one inside that request (the
// server can't build it after answering: Workers cancel that work about 30 s in). `acc` is
// Grow's account switcher (a brand id, "" for every account): each brand's report is kept apart.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Analytics, Range } from "@/lib/analytics";
import { api } from "./api";
import { bigGet, bigSet } from "./cache";

export type Report = Analytics & { cached: boolean; stale?: boolean };

const kept = new Map<string, { r: Report; got: number }>();
const asking = new Map<string, Promise<Report>>();
/** In memory, a report this young is shown without asking the server again. */
const REUSE_MS = 2 * 60_000;

const slot = (range: Range, acc: string) => `${range}${acc ? `:${acc}` : ""}`;

function ask(range: Range, acc: string, fresh = false, wait = false) {
  const at = slot(range, acc), key = `${at}${fresh ? "!" : wait ? "~" : ""}`;
  let p = asking.get(key);
  if (!p) {
    p = api<Report>(`analytics?range=${range}${acc ? `&acc=${encodeURIComponent(acc)}` : ""}${fresh ? "&fresh=1" : wait ? "&wait=1" : ""}`)
      .then((r) => { kept.set(at, { r, got: Date.now() }); bigSet(`report:${at}`, r); return r; })
      .finally(() => asking.delete(key));
    asking.set(key, p);
  }
  return p;
}

export const RANGE_KEY = "vb-an-range";
export function savedRange(): Range {
  try { const r = Number(localStorage.getItem(RANGE_KEY)); if (r === 7 || r === 28 || r === 90) return r; } catch {}
  return 28;
}

export const ACC_KEY = "vb-an-acc";
/** The account last picked in Grow's switcher ("" = every account), for a link that doesn't say. */
export function savedAcc() {
  try { return localStorage.getItem(ACC_KEY) ?? ""; } catch { return ""; }
}

export function useReport(range: Range, acc = "") {
  const at = slot(range, acc);
  const [data, setData] = useState<Report | null>(() => kept.get(at)?.r ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tries = useRef(0);

  const load = useCallback(async (fresh = false) => {
    setBusy(true); setErr(null);
    try { setData(await ask(range, acc, fresh)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }, [range, acc]);

  useEffect(() => {
    const k = kept.get(at);
    setData(k?.r ?? null);
    tries.current = 0;
    if (k && !k.r.stale && Date.now() - k.got < REUSE_MS) return;
    // a fresh visit: the copy this browser kept goes on screen at once, the new one replaces it when it lands (a copy
    // from before brands existed is skipped: it mixed every account)
    if (!k) bigGet<Report>(`report:${at}`).then((r) => { if (r?.brands && !kept.has(at)) setData((d) => d ?? r); });
    load();
  }, [at, load]);

  // a stale copy: ask once more with `wait`, which builds the new one in that request (about 15-40 s); "Updating…"
  // stays on while it runs, and a failure leaves the old copy up and lets the next visit try again
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!data?.stale || tries.current >= 1) return;
    tries.current++;
    setWaiting(true);
    ask(range, acc, false, true).then(setData).catch(() => {}).finally(() => setWaiting(false));
  }, [data, range, acc]);

  return { data, err, busy: busy || waiting, reload: load };
}
