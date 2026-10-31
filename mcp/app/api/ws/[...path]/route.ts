// Server half of the shared workspace: the browser reads and writes posts/comments/activity/media rows here
// (rows/<table>[/<id>], Postgres on Neon through lib/data.ts) and watches them through a sealed Neon Realtime query (live).
import { DataError, backupUrl, deleteMediaRow, finalizeMedia, getMedia, insert, listMembers, listOf, patch, remove, rowOf, type Table } from "@/lib/data";
import { storageUse } from "@/lib/r2files";
import { currentUser, isAuthed } from "@/lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };
const ID = /^[A-Za-z0-9._-]{1,36}$/;
const TABLES = new Set(["posts", "comments", "activity", "media"]);
const isTable = (t: unknown): t is Table => typeof t === "string" && TABLES.has(t);
/** The browser's Query.* strings (JSON), checked again column by column in lib/db.ts. */
const queriesOf = (raw: unknown) => (Array.isArray(raw) ? raw.slice(0, 12).map((x) => (typeof x === "string" ? JSON.parse(x) : x)) : []) as object[];
const bodyOf = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof DataError ? (e.status >= 500 ? 502 : e.status) : 500 });

export async function GET(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [a, b] = (await ctx.params).path;
  try {
    if (a === "me") return Response.json({ user: await currentUser(), workspace: true });
    if (a === "rows" && isTable(b)) {
      const id = (await ctx.params).path[2];
      if (id) return ID.test(id) ? Response.json(await rowOf(b, id)) : Response.json({ error: "bad id" }, { status: 400 });
      return Response.json({ rows: await listOf(b, ...queriesOf(JSON.parse(new URL(req.url).searchParams.get("q") || "[]"))) });
    }
    if (a === "members") return Response.json({ members: await listMembers() });
    if (a === "usage") return Response.json(await (await import("@/lib/usage")).usage());
    if (a === "storage") { const u = await storageUse(); return Response.json({ used: u.bytes, cap: u.cap, parts: u.parts }); }
    if (a === "backup" && b && ID.test(b)) {
      const url = await backupUrl(await getMedia(b));
      return url ? Response.json({ url }) : Response.json({ error: "no R2 copy yet" }, { status: 404 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [a, b] = (await ctx.params).path;
  try {
    if (a === "rows" && isTable(b)) {
      const { data, id } = await bodyOf(req);
      if (id !== undefined && !(typeof id === "string" && ID.test(id))) return Response.json({ error: "bad id" }, { status: 400 });
      return Response.json(await insert(b, (data ?? {}) as Record<string, unknown>, (id as string) || undefined));
    }
    // a live query for the board
    if (a === "live" && isTable(b)) {
      const { queries } = await bodyOf(req);
      const live = await (await import("@/lib/db")).liveQuery(b, queriesOf(queries) as never);
      return live ? Response.json(live) : Response.json({ error: "Realtime is not configured (NEON_REALTIME_URL, NEON_REALTIME_SECRET)" }, { status: 503 });
    }
    if (a === "media" && b && ID.test(b)) {
      return Response.json(await finalizeMedia(b));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [a, b, id] = (await ctx.params).path;
  try {
    if (a === "rows" && isTable(b) && id && ID.test(id)) return Response.json(await patch(b, id, ((await bodyOf(req)).data ?? {}) as Record<string, unknown>));
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return fail(e);
  }
}

/** Rows and files are deleted here: the browser can't reach the database or the bucket. */
export async function DELETE(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [a, b] = (await ctx.params).path;
  try {
    // a row (a media row deletes its file too: below)
    const id = (await ctx.params).path[2];
    if (a === "rows" && isTable(b) && b !== "media" && id && ID.test(id)) { await remove(b, id); return Response.json({ deleted: id }); }
    if (a === "media" && b && ID.test(b)) {
      const who = await currentUser().catch(() => null);
      const m = await deleteMediaRow(b, who ? { id: who.id, name: who.name } : { name: "Dashboard" });
      return Response.json({ deleted: b, name: m.name });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return fail(e);
  }
}
