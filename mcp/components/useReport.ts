"use client";
// The analytics report, shared by Home and every Analytics page: one copy per range kept in memory, so moving between
// the sub-pages (or from Home) shows it at once, and one request at a time per range. The server answers an old copy
// at once marked `stale` while it builds a new one; this hook then asks again every few seconds to pick that up.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Analytics, Range } from "@/lib/analytics";
import { api } from "./api";
import { bigGet, bigSet } from "./cache";

export type Report = Analytics & { cached: boolean; stale?: boolean };

const kept = new Map<Range, { r: Report; got: number }>();
const asking = new Map<string, Promise<Report>>();
/** In memory, a report this young is shown without asking the server again. */
const REUSE_MS = 2 * 60_000;

function ask(range: Range, fresh = false) {
  const key = `${range}${fresh ? "!" : ""}`;
  let p = asking.get(key);
  if (!p) {
    p = api<Report>(`analytics?range=${range}${fresh ? "&fresh=1" : ""}`)
      .then((r) => { kept.set(range, { r, got: Date.now() }); bigSet(`report:${range}`, r); return r; })
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

export function useReport(range: Range) {
  const [data, setData] = useState<Report | null>(() => kept.get(range)?.r ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tries = useRef(0);

  const load = useCallback(async (fresh = false) => {
    setBusy(true); setErr(null);
    try { setData(await ask(range, fresh)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }, [range]);

  useEffect(() => {
    const k = kept.get(range);
    setData(k?.r ?? null);
    tries.current = 0;
    if (k && !k.r.stale && Date.now() - k.got < REUSE_MS) return;
    // a fresh visit: the copy this browser kept goes on screen at once, the new one replaces it when it lands
    if (!k) bigGet<Report>(`report:${range}`).then((r) => { if (r && !kept.has(range)) setData((d) => d ?? r); });
    load();
  }, [range, load]);

  // a stale copy: the new one is being built behind it, so look again shortly (for up to about two minutes)
  useEffect(() => {
    if (!data?.stale || tries.current >= 20) return;
    const t = setTimeout(() => {
      tries.current++;
      ask(range).then(setData).catch(() => {});
    }, 6000);
    return () => clearTimeout(t);
  }, [data, range]);

  return { data, err, busy, reload: load };
}
