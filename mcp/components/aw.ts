"use client";
// Browser side of the shared workspace: rows are read and written through /api/ws/rows (Postgres on Neon) and kept live
// by a sealed Neon Realtime query, closed while nobody's looking so the database can sleep. Sign-in posts to /api/login.
import { useCallback, useEffect, useState } from "react";
import { fromPg, type Member } from "@/lib/workspace";

/** Row queries as JSON strings ({method, attribute, values}), checked column by column on the server (lib/db.ts). */
const qy = (method: string, attribute?: string, values?: unknown[]) => JSON.stringify({ method, ...(attribute ? { attribute } : {}), ...(values ? { values } : {}) });
export const Query = {
  equal: (attribute: string, value: unknown) => qy("equal", attribute, Array.isArray(value) ? value : [value]),
  notEqual: (attribute: string, value: unknown) => qy("notEqual", attribute, [value]),
  lessThan: (attribute: string, value: unknown) => qy("lessThan", attribute, [value]),
  greaterThan: (attribute: string, value: unknown) => qy("greaterThan", attribute, [value]),
  isNull: (attribute: string) => qy("isNull", attribute),
  isNotNull: (attribute: string) => qy("isNotNull", attribute),
  orderAsc: (attribute: string) => qy("orderAsc", attribute),
  orderDesc: (attribute: string) => qy("orderDesc", attribute),
  limit: (n: number) => qy("limit", undefined, [n]),
};

/** Sign in, or with a name sign up (the server checks the invite list first). */
export async function signIn(email: string, password: string, name?: string) {
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name !== undefined ? { signup: { name, email, password } } : { email, password }) });
  const res = await r.json().catch(() => ({}));
  if (!r.ok || !res.user) throw new Error(res.error || "Sign-in failed");
  meCache = null;
  return res as { user: { id: string; name: string; email: string }; workspace: boolean };
}

export async function signOut() {
  (await import("./cache")).clearCache();
  meCache = null;
  await fetch("/api/login", { method: "DELETE" });
}

type Me = { id: string; name: string; email: string };
type MeState = { user: Me | null; workspace: boolean; session: boolean };
let meCache: Promise<MeState> | null = null;

export function getMe() {
  meCache ??= fetch("/api/ws/me").then((x) => x.json()).catch(() => ({ user: null, workspace: false }))
    .then((r) => ({ user: r.user ?? null, workspace: !!r.workspace, session: !!r.user }));
  return meCache;
}

/** The signed-in person (from the dashboard's cookie). */
export function useMe() {
  const [me, setMe] = useState<MeState | null>(null);
  useEffect(() => { getMe().then(setMe); }, []);
  return me;
}

// ── one row at a time

async function wsRows<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/ws/rows/${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `${method} ${path}: ${r.status}`);
  return out as T;
}
type Data = Record<string, unknown>;
export const rowGet = <T>(table: string, id: string) => wsRows<T>("GET", `${table}/${id}`);
export const rowCreate = <T>(table: string, data: Data) => wsRows<T>("POST", table, { data });
export const rowUpdate = <T>(table: string, id: string, data: Data) => wsRows<T>("PATCH", `${table}/${id}`, { data });
export async function rowDelete(table: string, id: string) { await wsRows("DELETE", `${table}/${id}`); }

/** One line in the shared activity feed ("Asha moved 'Rust in 60s' to Review"). Never throws. */
export async function logActivity(postId: string | null, verb: string, text = "") {
  try {
    const { user } = await getMe();
    await rowCreate("activity", { post_id: postId, verb, text: text.slice(0, 500), actor_id: user?.id ?? null, actor_name: user?.name ?? "someone" });
  } catch { /* the feed is a nicety */ }
}

let membersCache: Promise<Member[]> | null = null;
export function useMembers() {
  const [m, setM] = useState<Member[]>([]);
  useEffect(() => {
    membersCache ??= fetch("/api/ws/members").then((r) => r.json()).then((r) => r.members ?? []).catch(() => []);
    membersCache.then(setM);
  }, []);
  return m;
}

type RowLike = { $id: string; $createdAt: string; $updatedAt: string };

/**
 * Rows of one table, kept live: a first list, then every create/update/delete from either of you lands within a second.
 * (`_match` is kept for the callers: the server applies `queries` to the live rows too.)
 */
export function useLive<T extends RowLike>(table: string, queries: string[], _match: (row: T) => boolean = () => true, deps: unknown[] = []) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const key = JSON.stringify([table, queries, ...deps]);

  const reload = useCallback(async () => {
    try {
      setRows((await wsRows<{ rows: T[] }>("GET", `${table}?q=${encodeURIComponent(JSON.stringify(queries))}`)).rows);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    setLoading(true);
    const stop = liveFromNeon<T>(table, queries, setRows, setLoading, setError, reload);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload, table]);

  return { rows, setRows, loading, error, reload };
}

// ── Neon Realtime: one socket for the tab, one sealed query per useLive

type Live = { onChange: (f: (s: { data?: readonly unknown[]; status: string; error?: unknown }) => void) => () => void; unsubscribe: () => void; renew: (q: never) => void };
let rtClient: Promise<{ subscribe: (q: never) => Live; close: () => void }> | null = null;
const IDLE_MS = 10 * 60_000, HIDDEN_MS = 30_000;
let lastTouch = Date.now();
if (typeof window !== "undefined") for (const e of ["pointerdown", "keydown", "scroll", "wheel", "touchstart"]) addEventListener(e, () => { lastTouch = Date.now(); }, { passive: true, capture: true });

/** Watch one query while someone's looking: closed 30 s after the tab hides or after 10 idle minutes (an open query
 *  keeps Neon's compute awake, and its hours are the free tier's limit), opened again, fresh, on the next look. If
 *  Realtime can't be had, the rows are fetched instead, and again on every return to the tab. */
function liveFromNeon<T>(table: string, queries: string[], setRows: (r: T[]) => void, setLoading: (b: boolean) => void, setError: (s: string) => void, reload: () => Promise<void>) {
  let sub: Live | null = null, off = () => {}, opening = false, gone = false, fallback = false;
  const seal = async () => {
    const r = await fetch(`/api/ws/live/${table}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `live ${r.status}`);
    return out as { url: string; query: never };
  };
  const open = async () => {
    if (sub || opening || gone) return;
    if (fallback) { await reload(); return; }
    opening = true;
    try {
      const s = await seal();
      if (gone) return;
      rtClient ??= import("@neon/realtime/client").then(({ createRealtimeClient }) => createRealtimeClient({ url: s.url }) as never);
      sub = (await rtClient).subscribe(s.query);
      off = sub.onChange(({ data, status, error }) => {
        if (data) { setRows(data.map((r) => fromPg<T>(table, r as Record<string, unknown>))); setError(""); setLoading(false); }
        if (status === "stale") seal().then((n) => sub?.renew(n.query)).catch(() => null);
        if (status === "error" || error) { close(); fallback = true; reload(); }
      });
    } catch {
      fallback = true;
      await reload();
    } finally {
      opening = false;
    }
  };
  const close = () => { off(); sub?.unsubscribe(); sub = null; off = () => {}; };
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const onVis = () => {
    clearTimeout(hideTimer);
    if (document.visibilityState === "visible") { lastTouch = Date.now(); open(); }
    else hideTimer = setTimeout(close, HIDDEN_MS);
  };
  const onTouch = () => { if (!sub && document.visibilityState === "visible") open(); };
  const idle = setInterval(() => { if (sub && Date.now() - lastTouch > IDLE_MS) close(); }, 60_000);
  document.addEventListener("visibilitychange", onVis);
  addEventListener("pointerdown", onTouch);
  addEventListener("keydown", onTouch);
  open();
  return () => {
    gone = true;
    close();
    clearTimeout(hideTimer);
    clearInterval(idle);
    document.removeEventListener("visibilitychange", onVis);
    removeEventListener("pointerdown", onTouch);
    removeEventListener("keydown", onTouch);
  };
}

export function timeAgo(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
