// The workspace in Postgres on Neon: posts, comments, activity and media (schema: db/001_workspace.sql). Queries go over
// Neon's HTTP driver to the pooled endpoint, which suits short requests on the Worker. lib/data.ts reads and writes
// through here (listRows … deleteRow), and the browser's live board is a sealed Realtime query (liveQuery).
// (Appwrite held these until 2026-10-31: docs/MIGRATION.md.)
import { neon } from "@neondatabase/serverless";
import { fromPg } from "./workspace";

/** A refusal with an HTTP status (a missing row is 404, a bad query 400). */
export class DataError extends Error {
  constructor(message: string, public status: number, public type = "") { super(message); }
}

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

// ── reads and writes

/** Query objects ({method, attribute, values}, the JSON components/aw.ts' Query builds in the browser), as SQL on
 *  allowed columns only. What the studio asks for: equal, the four comparisons, isNull/isNotNull, order and limit. */
export type Q = { method: string; attribute?: string; values?: unknown[] };
const OPS: Record<string, string> = { greaterThan: ">", greaterThanEqual: ">=", lessThan: "<", lessThanEqual: "<=", notEqual: "<>" };
export function toSql(table: Table, queries: Q[], maxLimit = 1000) {
  const col = (a = "") => {
    const c = a === "$id" ? "id" : a === "$createdAt" ? "created_at" : a === "$updatedAt" ? "updated_at" : a;
    if (c === "id" || c === "created_at" || c === "updated_at" || (TABLES[table] as readonly string[]).includes(c)) return c;
    throw new DataError(`Unknown column ${a}`, 400);
  };
  const where: string[] = [], order: string[] = [], values: unknown[] = [];
  let limit = 25;
  const at = (v: unknown) => { values.push(v); return `$${values.length}`; };
  for (const x of queries) {
    const v = x.values ?? [];
    if (x.method === "equal") where.push(v.length ? `${col(x.attribute)} in (${v.map(at).join(", ")})` : "false");
    else if (OPS[x.method]) where.push(`${col(x.attribute)} ${OPS[x.method]} ${at(v[0])}`);
    else if (x.method === "isNull" || x.method === "isNotNull") where.push(`${col(x.attribute)} is ${x.method === "isNull" ? "" : "not "}null`);
    else if (x.method === "orderAsc" || x.method === "orderDesc") order.push(`${col(x.attribute)} ${x.method === "orderAsc" ? "asc" : "desc"}`);
    else if (x.method === "limit") limit = Math.max(1, Math.min(maxLimit, Number(v[0]) || 25));
    else throw new DataError(`Unsupported query ${x.method}`, 400);
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
/** A row id: 20 hex characters, time first. */
export const newId = () => Date.now().toString(16).padStart(12, "0").slice(-12) + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function listRows<T>(table: Table, queries: Q[]) {
  const { text, values } = toSql(table, queries);
  return shaped<T>(table, await sql().query(text, values));
}

export async function getRow<T>(table: Table, id: string) {
  const [row] = shaped<T>(table, await sql().query(`select * from ${table} where id = $1`, [id]));
  if (!row) throw new DataError("Row with the requested ID could not be found.", 404, "row_not_found");
  return row;
}

export async function insertRow<T>(table: Table, data: Record<string, unknown>, id = newId()) {
  const d = pick(table, data);
  const cols = ["id", ...Object.keys(d)];
  const [row] = shaped<T & { $id: string }>(table, await sql().query(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, [id, ...Object.values(d)]));
  return row as T;
}

export async function patchRow<T>(table: Table, id: string, data: Record<string, unknown>) {
  const d = pick(table, data);
  const sets = Object.keys(d).map((c, i) => `${c} = $${i + 2}`);
  const [row] = shaped<T>(table, await sql().query(`update ${table} set ${[...sets, "updated_at = now()"].join(", ")} where id = $1 returning *`, [id, ...Object.values(d)]));
  if (!row) throw new DataError("Row with the requested ID could not be found.", 404, "row_not_found");
  return row;
}

export async function deleteRow(table: Table, id: string) {
  await sql().query(`delete from ${table} where id = $1`, [id]);
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
