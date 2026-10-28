"use client";
// Browser side of the shared workspace: one Appwrite client, plus useLive() — a table that stays in sync over Realtime.
import { Account, Channel, Client, ID, Query, Realtime, Storage, TablesDB, type Models } from "appwrite";
import { useCallback, useEffect, useRef, useState } from "react";
import { AW, type Member } from "@/lib/workspace";

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
let meCache: Promise<{ user: Me | null; workspace: boolean; session: boolean }> | null = null;

export function getMe() {
  meCache ??= (async () => {
    const [r, session] = await Promise.all([
      fetch("/api/ws/me").then((x) => x.json()).catch(() => ({ user: null, workspace: false })),
      aw().account.get().then(() => true).catch(() => false),
    ]);
    return { user: r.user ?? null, workspace: !!r.workspace, session };
  })();
  return meCache;
}

/** The signed-in person (from our cookie) and whether this browser also holds an Appwrite session (needed for live data). */
export function useMe() {
  const [me, setMe] = useState<{ user: Me | null; workspace: boolean; session: boolean } | null>(null);
  useEffect(() => { getMe().then(setMe); }, []);
  return me;
}

/** One line in the shared activity feed ("Asha moved 'Rust in 60s' to Review"). Never throws. */
export async function logActivity(postId: string | null, verb: string, text = "") {
  try {
    const { user } = await getMe();
    await aw().tables.createRow({ databaseId: AW.db, tableId: "activity", rowId: ID.unique(),
      data: { post_id: postId, verb, text: text.slice(0, 500), actor_id: user?.id ?? null, actor_name: user?.name ?? "someone" } });
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
      const r = await aw().tables.listRows<T>({ databaseId: AW.db, tableId: table, queries });
      setRows(r.rows); setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    setLoading(true);
    reload();
    let sub: { unsubscribe: () => Promise<void> } | null = null;
    let dead = false;
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
    return () => { dead = true; sub?.unsubscribe(); document.removeEventListener("visibilitychange", onVis); };
  }, [key, reload, table]);

  return { rows, setRows, loading, error, reload };
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
