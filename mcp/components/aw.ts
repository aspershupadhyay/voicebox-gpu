"use client";
// Browser side of the shared workspace: one Appwrite client, plus useLive() — a table that stays in sync over Realtime.
// With DB_BACKEND=neon (getMe().db, docs/MIGRATION.md phase 2) rows are read and written through /api/ws/rows and kept
// live by a sealed Neon Realtime query, closed while nobody's looking so the database can sleep. row* and useLive pick.
import { Account, Channel, Client, ID, Query, Realtime, Storage, TablesDB, type Models } from "appwrite";
import { useCallback, useEffect, useRef, useState } from "react";
import { AW, fromPg, type Member } from "@/lib/workspace";

let sdk: { client: Client; account: Account; tables: TablesDB; storage: Storage; realtime: Realtime } | null = null;

export function aw() {
  if (!sdk) {
    const client = new Client().setEndpoint(AW.endpoint).setProject(AW.project);
    sdk = { client, account: new Account(client), tables: new TablesDB(client), storage: new Storage(client), realtime: new Realtime(client) };
  }
  return sdk;
}
export { ID, Query };

/** Sign in to Appwrite, then trade a short-lived JWT for the dashboard's own cookie (who you are, for attribution).
 *  With a name it's a sign-up: the server checks the invite list first and creates the account (api/login). */
export async function signIn(email: string, password: string, name?: string) {
  const { account } = aw();
  await account.deleteSession({ sessionId: "current" }).catch(() => {});
  if (name !== undefined) {
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signup: { name, email, password } }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || "Sign-up failed");
    if (out.create === "client") await account.create({ userId: ID.unique(), email, password, name: name || email.split("@")[0] });
  }
  await account.createEmailPasswordSession({ email, password });
  const { jwt } = await account.createJWT();
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jwt }) });
  const out = await r.json();
  if (!r.ok) { await account.deleteSession({ sessionId: "current" }).catch(() => {}); throw new Error(out.error || "Sign-in failed"); }
  return out as { user: { id: string; name: string; email: string }; workspace: boolean };
}

export async function signOut() {
  (await import("./cache")).clearCache();
  await aw().account.deleteSession({ sessionId: "current" }).catch(() => {});
  await fetch("/api/login", { method: "DELETE" });
}

type Me = { id: string; name: string; email: string };
type MeState = { user: Me | null; workspace: boolean; session: boolean; db: "appwrite" | "neon" };
let meCache: Promise<MeState> | null = null;

export function getMe() {
  meCache ??= (async () => {
    const [r, session] = await Promise.all([
      fetch("/api/ws/me").then((x) => x.json()).catch(() => ({ user: null, workspace: false })),
      aw().account.get().then(() => true).catch(() => false),
    ]);
    return { user: r.user ?? null, workspace: !!r.workspace, session, db: r.db === "neon" ? "neon" : "appwrite" } as MeState;
  })();
  return meCache;
}

/** The signed-in person (from our cookie) and whether this browser also holds an Appwrite session (needed for live data). */
export function useMe() {
  const [me, setMe] = useState<MeState | null>(null);
  useEffect(() => { getMe().then(setMe); }, []);
  return me;
}

// ── one row at a time, from whichever database leads

const onNeon = async () => (await getMe()).db === "neon";
async function wsRows<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/ws/rows/${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `${method} ${path}: ${r.status}`);
  return out as T;
}
type Data = Record<string, unknown>;
export async function rowGet<T>(table: string, id: string): Promise<T> {
  return (await onNeon()) ? wsRows<T>("GET", `${table}/${id}`) : (aw().tables.getRow({ databaseId: AW.db, tableId: table, rowId: id }) as Promise<T>);
}
export async function rowCreate<T>(table: string, data: Data): Promise<T> {
  return (await onNeon()) ? wsRows<T>("POST", table, { data }) : (aw().tables.createRow({ databaseId: AW.db, tableId: table, rowId: ID.unique(), data }) as Promise<T>);
}
export async function rowUpdate<T>(table: string, id: string, data: Data): Promise<T> {
  return (await onNeon()) ? wsRows<T>("PATCH", `${table}/${id}`, { data }) : (aw().tables.updateRow({ databaseId: AW.db, tableId: table, rowId: id, data }) as Promise<T>);
}
export async function rowDelete(table: string, id: string) {
  if (await onNeon()) await wsRows("DELETE", `${table}/${id}`);
  else await aw().tables.deleteRow({ databaseId: AW.db, tableId: table, rowId: id });
}

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

type RowLike = Models.Row & { $id: string };

/**
 * Rows of one table, kept live: a first list, then every create/update/delete from either of you lands within a second.
 * `match` filters realtime events client-side the same way `queries` filter the first list.
 */
export function useLive<T extends RowLike>(table: string, queries: string[], match: (row: T) => boolean = () => true, deps: unknown[] = []) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const matchRef = useRef(match);
  matchRef.current = match;
  const key = JSON.stringify([table, queries, ...deps]);

  const reload = useCallback(async () => {
    try {
      if (await onNeon()) setRows((await wsRows<{ rows: T[] }>("GET", `${table}?q=${encodeURIComponent(JSON.stringify(queries))}`)).rows);
      else setRows((await aw().tables.listRows<T>({ databaseId: AW.db, tableId: table, queries })).rows);
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
    let stop = () => {};
    let dead = false;
    getMe().then((me) => {
      if (dead) return;
      stop = me.db === "neon" ? liveFromNeon<T>(table, queries, setRows, setLoading, setError, reload) : liveFromAppwrite();
    });
    return () => { dead = true; stop(); };

    function liveFromAppwrite() {
      reload();
      let sub: { unsubscribe: () => Promise<void> } | null = null;
      aw().realtime.subscribe(Channel.tablesdb(AW.db).table(table).row(), (ev) => {
        const row = ev.payload as T;
        const del = ev.events.some((e) => e.endsWith(".delete"));
        setRows((cur) => {
          const rest = cur.filter((r) => r.$id !== row.$id);
          if (del || !matchRef.current(row)) return rest;
          const i = cur.findIndex((r) => r.$id === row.$id);
          if (i < 0) return [row, ...cur];
          const next = cur.slice(); next[i] = row; return next;
        });
      }).then((s) => { if (dead) s.unsubscribe(); else sub = s; }).catch(() => {});
      // when the tab comes back (laptop lid, phone lock) the socket may have missed events: refetch once
      const onVis = () => { if (document.visibilityState === "visible") reload(); };
      document.addEventListener("visibilitychange", onVis);
      return () => { sub?.unsubscribe(); document.removeEventListener("visibilitychange", onVis); };
    }
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

export const tables = () => aw().tables;
export const db = AW.db;

export function timeAgo(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
