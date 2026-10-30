// The workspace in Postgres on Neon (docs/MIGRATION.md, phase 2): posts, comments, activity and media, the same four
// tables Appwrite holds (schema: db/001_workspace.sql). Queries go over Neon's HTTP driver to the pooled endpoint, which
// suits short serverless requests on Vercel and, later, Workers. Until DB_BACKEND=neon, Appwrite stays the source of
// truth and this is only the copy: copyFromAppwrite() fills Postgres (safe to run again), checkCopy() compares the two,
// and every row Appwrite writes after that arrives through its webhook (app/api/hooks/appwrite) as mirror()/unmirror().
// With DB_BACKEND=neon it's the other way round: lib/appwrite.ts reads and writes here (listRows … deleteRow), each write
// copied back to Appwrite with the same id so unsetting the switch loses nothing, and the browser's live board is a
// sealed Realtime query (liveQuery) instead of Appwrite Realtime.
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { AppwriteError, allRows, awMirror } from "./appwrite";
import { fromPg } from "./workspace";

export const DB_ON_NEON = process.env.DB_BACKEND === "neon";
const URL_ = () => process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || "";
export const hasDb = () => !!URL_();

let client: ReturnType<typeof neon> | null = null;
export function sql() {
  if (!hasDb()) throw new Error("The database is not configured (DATABASE_URL_POOLED).");
  return (client ??= neon(URL_()));
}

const TABLES = {
  posts: ["title", "status", "platforms", "script", "caption", "notes", "due_at", "posted_at", "link", "owner_id", "owner_name", "assignee_id", "assignee_name", "jobs", "cover"],
  comments: ["post_id", "body", "author_id", "author_name"],
  activity: ["post_id", "verb", "text", "actor_id", "actor_name"],
  media: ["file_id", "name", "mime", "size", "kind", "post_id", "uploaded_by", "uploaded_name", "r2_key", "token"],
} as const;
export type Table = keyof typeof TABLES;
export const isTable = (t: unknown): t is Table => typeof t === "string" && t in TABLES;
const ARRAYS = new Set(["platforms", "jobs"]);

/** Upsert Appwrite rows (ids, times and values as they are) into one table. A row only replaces one that isn't newer,
 *  so a webhook that arrives late can't undo a later change. */
async function upsert(table: Table, batch: Record<string, unknown>[]) {
  if (!batch.length) return;
  const cols = TABLES[table];
  const names = ["id", "created_at", "updated_at", ...cols];
  const values: unknown[] = [];
  const tuples = batch.map((r) => {
    const row = [r.$id, r.$createdAt, r.$updatedAt, ...cols.map((c) => (ARRAYS.has(c) ? (r[c] as unknown[] | null) ?? [] : r[c] ?? null))];
    return `(${row.map((v) => { values.push(v); return `$${values.length}`; }).join(", ")})`;
  });
  const update = names.slice(1).map((n) => `${n} = excluded.${n}`).join(", ");
  await sql().query(`insert into ${table} (${names.join(", ")}) values ${tuples.join(", ")} on conflict (id) do update set ${update} where ${table}.updated_at <= excluded.updated_at`, values);
}

/** Upsert every Appwrite row into Postgres, table by table. */
export async function copyFromAppwrite() {
  const done: Record<string, number> = {};
  for (const table of Object.keys(TABLES) as Table[]) {
    const all = await allRows(table);
    for (let i = 0; i < all.length; i += 50) await upsert(table, all.slice(i, i + 50));
    done[table] = all.length;
  }
  return done;
}

/** One row Appwrite just wrote (its webhook), and one it just deleted. */
export const mirror = (table: Table, row: Record<string, unknown>) => upsert(table, [row]);
export const unmirror = async (table: Table, id: string) => { await sql().query(`delete from ${table} where id = $1`, [id]); };

/** The webhook's signing key: derived from the database URL, which only Vercel and the owner hold, so there's no extra
 *  setting to keep (rotating the database password means setting the webhook's key again: docs/MIGRATION.md). */
export const hookKey = () => createHmac("sha256", URL_()).update("voicebox-appwrite-hook-v1").digest("hex");

/** Rows on each side and the ids only one side has: the copy is good when every table matches. */
export async function checkCopy() {
  const out: Record<string, { appwrite: number; postgres: number; missing: string[]; extra: string[] }> = {};
  for (const table of Object.keys(TABLES) as Table[]) {
    const a = new Set((await allRows(table)).map((r) => String(r.$id)));
    const p = new Set(((await sql().query(`select id from ${table}`)) as { id: string }[]).map((r) => r.id));
    out[table] = { appwrite: a.size, postgres: p.size, missing: [...a].filter((x) => !p.has(x)).slice(0, 20), extra: [...p].filter((x) => !a.has(x)).slice(0, 20) };
  }
  return { ok: Object.values(out).every((t) => !t.missing.length && !t.extra.length), tables: out };
}

// ── reads and writes once DB_BACKEND=neon (lib/appwrite.ts calls these instead of Appwrite's REST)

/** Appwrite's query objects ({method, attribute, values}, the JSON Query.* builds in the browser too), as SQL on
 *  allowed columns only. What the studio asks for: equal, the four comparisons, isNull/isNotNull, order and limit. */
export type Q = { method: string; attribute?: string; values?: unknown[] };
const OPS: Record<string, string> = { greaterThan: ">", greaterThanEqual: ">=", lessThan: "<", lessThanEqual: "<=", notEqual: "<>" };
export function toSql(table: Table, queries: Q[], maxLimit = 1000) {
  const col = (a = "") => {
    const c = a === "$id" ? "id" : a === "$createdAt" ? "created_at" : a === "$updatedAt" ? "updated_at" : a;
    if (c === "id" || c === "created_at" || c === "updated_at" || (TABLES[table] as readonly string[]).includes(c)) return c;
    throw new AppwriteError(`Unknown column ${a}`, 400);
  };
  const where: string[] = [], order: string[] = [], values: unknown[] = [];
  let limit = 25; // Appwrite's default
  const at = (v: unknown) => { values.push(v); return `$${values.length}`; };
  for (const x of queries) {
    const v = x.values ?? [];
    if (x.method === "equal") where.push(v.length ? `${col(x.attribute)} in (${v.map(at).join(", ")})` : "false");
    else if (OPS[x.method]) where.push(`${col(x.attribute)} ${OPS[x.method]} ${at(v[0])}`);
    else if (x.method === "isNull" || x.method === "isNotNull") where.push(`${col(x.attribute)} is ${x.method === "isNull" ? "" : "not "}null`);
    else if (x.method === "orderAsc" || x.method === "orderDesc") order.push(`${col(x.attribute)} ${x.method === "orderAsc" ? "asc" : "desc"}`);
    else if (x.method === "limit") limit = Math.max(1, Math.min(maxLimit, Number(v[0]) || 25));
    else throw new AppwriteError(`Unsupported query ${x.method}`, 400);
  }
  const text = `select * from ${table}${where.length ? ` where ${where.join(" and ")}` : ""} order by ${[...order, "id"].join(", ")} limit ${limit}`;
  return { text, values };
}

const shaped = <T>(table: Table, rows: unknown) => (rows as Record<string, unknown>[]).map((r) => fromPg<T>(table, r));
const pick = (table: Table, data: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const c of TABLES[table]) if (data[c] !== undefined) out[c] = ARRAYS.has(c) ? (data[c] as unknown[] | null) ?? [] : data[c];
  return out;
};
/** An id like Appwrite's unique(): 20 hex characters, time first. */
export const newId = () => Date.now().toString(16).padStart(12, "0").slice(-12) + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function listRows<T>(table: Table, queries: Q[]) {
  const { text, values } = toSql(table, queries);
  return shaped<T>(table, await sql().query(text, values));
}

export async function getRow<T>(table: Table, id: string) {
  const [row] = shaped<T>(table, await sql().query(`select * from ${table} where id = $1`, [id]));
  if (!row) throw new AppwriteError("Row with the requested ID could not be found.", 404, "row_not_found");
  return row;
}

export async function insertRow<T>(table: Table, data: Record<string, unknown>, id = newId()) {
  const d = pick(table, data);
  const cols = ["id", ...Object.keys(d)];
  const [row] = shaped<T & { $id: string }>(table, await sql().query(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, [id, ...Object.values(d)]));
  await awMirror("create", table, id, pick(table, row as Record<string, unknown>));
  return row as T;
}

export async function patchRow<T>(table: Table, id: string, data: Record<string, unknown>) {
  const d = pick(table, data);
  const sets = Object.keys(d).map((c, i) => `${c} = $${i + 2}`);
  const [row] = shaped<T>(table, await sql().query(`update ${table} set ${[...sets, "updated_at = now()"].join(", ")} where id = $1 returning *`, [id, ...Object.values(d)]));
  if (!row) throw new AppwriteError("Row with the requested ID could not be found.", 404, "row_not_found");
  if (sets.length) await awMirror("update", table, id, d);
  return row;
}

export async function deleteRow(table: Table, id: string) {
  await sql().query(`delete from ${table} where id = $1`, [id]);
  await awMirror("delete", table, id);
}

/** A live query for the browser (Neon Realtime): sealed here, so the browser can watch exactly these rows and nothing
 *  else, without the secret. Short-lived; the browser asks again when it goes stale. */
export async function liveQuery(table: Table, queries: Q[]) {
  const secret = process.env.NEON_REALTIME_SECRET, url = process.env.NEON_REALTIME_URL;
  if (!secret || !url) return null;
  const { createRealtime, rawSql } = await import("@neon/realtime/server");
  const { text, values } = toSql(table, queries);
  const query = await createRealtime({ secret, db: process.env.NEON_DB_NAME || "neondb" }).seal({ query: rawSql(text, values as never) });
  return { url, query };
}
