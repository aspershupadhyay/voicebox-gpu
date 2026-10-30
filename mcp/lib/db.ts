// The workspace in Postgres on Neon (docs/MIGRATION.md, phase 2): posts, comments, activity and media, the same four
// tables Appwrite holds (schema: db/001_workspace.sql). Queries go over Neon's HTTP driver to the pooled endpoint, which
// suits short serverless requests on Vercel and, later, Workers. Until DB_BACKEND=neon, Appwrite stays the source of
// truth and this is only the copy: copyFromAppwrite() fills Postgres (safe to run again), checkCopy() compares the two.
import { neon } from "@neondatabase/serverless";
import { allRows } from "./appwrite";

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
type Table = keyof typeof TABLES;
const ARRAYS = new Set(["platforms", "jobs"]);

/** Upsert every Appwrite row into Postgres (ids, times and values as they are), table by table. */
export async function copyFromAppwrite() {
  const done: Record<string, number> = {};
  for (const table of Object.keys(TABLES) as Table[]) {
    const cols = TABLES[table];
    const all = await allRows(table);
    for (let i = 0; i < all.length; i += 50) {
      const batch = all.slice(i, i + 50);
      const names = ["id", "created_at", "updated_at", ...cols];
      const values: unknown[] = [];
      const tuples = batch.map((r) => {
        const row = [r.$id, r.$createdAt, r.$updatedAt, ...cols.map((c) => (ARRAYS.has(c) ? (r[c] as unknown[] | null) ?? [] : r[c] ?? null))];
        return `(${row.map((v) => { values.push(v); return `$${values.length}`; }).join(", ")})`;
      });
      const update = names.slice(1).map((n) => `${n} = excluded.${n}`).join(", ");
      await sql().query(`insert into ${table} (${names.join(", ")}) values ${tuples.join(", ")} on conflict (id) do update set ${update}`, values);
    }
    done[table] = all.length;
  }
  return done;
}

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
