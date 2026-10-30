// Server half of the shared workspace. The browser reads and writes posts/comments/media straight to Appwrite (that is
// what makes it live); these routes do the parts that need the project's API key. With DB_BACKEND=neon the browser
// reads and writes rows here instead (rows/<table>[/<id>], lib/appwrite.ts picks the database) and watches them through a
// sealed Neon Realtime query (live).
import { AppwriteError, backupUrl, deleteMediaRow, finalizeMedia, getMedia, hasKey, insert, listMembers, listOf, patch, remove, rowOf, type Table } from "@/lib/appwrite";
import { storageUse } from "@/lib/r2files";
import { after } from "next/server";
import { currentUser, isAuthed } from "@/lib/session";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // the R2 backup of a big upload runs after the response

type Ctx = { params: Promise<{ path: string[] }> };
const ID = /^[A-Za-z0-9._-]{1,36}$/;
const TABLES = new Set(["posts", "comments", "activity", "media"]);
const isTable = (t: unknown): t is Table => typeof t === "string" && TABLES.has(t);
/** The browser's Query.* strings (Appwrite's JSON), checked again column by column in lib/db.ts. */
const queriesOf = (raw: unknown) => (Array.isArray(raw) ? raw.slice(0, 12).map((x) => (typeof x === "string" ? JSON.parse(x) : x)) : []) as object[];
const bodyOf = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof AppwriteError ? (e.status >= 500 ? 502 : e.status) : 500 });

export async function GET(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [a, b] = (await ctx.params).path;
  try {
    if (a === "me") return Response.json({ user: await currentUser(), workspace: hasKey(), db: process.env.DB_BACKEND === "neon" ? "neon" : "appwrite" });
    if (a === "rows" && isTable(b)) {
      const id = (await ctx.params).path[2];
      if (id) return ID.test(id) ? Response.json(await rowOf(b, id)) : Response.json({ error: "bad id" }, { status: 400 });
      return Response.json({ rows: await listOf(b, ...queriesOf(JSON.parse(new URL(req.url).searchParams.get("q") || "[]"))) });
    }
    if (a === "members") return Response.json({ members: await listMembers() });
    // the copy into Postgres (lib/db.ts, docs/MIGRATION.md phase 2): both sides' rows, and what only one side has
    if (a === "db-check") return Response.json(await (await import("@/lib/db")).checkCopy());
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
    if (a === "db-copy") {
      if (process.env.DB_BACKEND === "neon") return Response.json({ error: "Postgres already leads (DB_BACKEND=neon)" }, { status: 409 });
      const { copyFromAppwrite, checkCopy } = await import("@/lib/db");
      return Response.json({ copied: await copyFromAppwrite(), check: await checkCopy() });
    }
    if (a === "rows" && isTable(b)) {
      const { data, id } = await bodyOf(req);
      if (id !== undefined && !(typeof id === "string" && ID.test(id))) return Response.json({ error: "bad id" }, { status: 400 });
      return Response.json(await insert(b, (data ?? {}) as Record<string, unknown>, (id as string) || undefined));
    }
    // a live query for the board: only on Neon (Appwrite's own Realtime serves the browser otherwise)
    if (a === "live" && isTable(b)) {
      if (process.env.DB_BACKEND !== "neon") return Response.json({ error: "not on Neon" }, { status: 409 });
      const { queries } = await bodyOf(req);
      const live = await (await import("@/lib/db")).liveQuery(b, queriesOf(queries) as never);
      return live ? Response.json(live) : Response.json({ error: "Realtime is not configured (NEON_REALTIME_URL, NEON_REALTIME_SECRET)" }, { status: 503 });
    }
    if (a === "media" && b && ID.test(b)) {
      const body = (await req.json().catch(() => ({}))) as { backup?: boolean };
      const backup = body.backup ?? (await getSettings()).backup_media;
      // the view token now (the file shows at once), the R2 backup copy after the response
      const out = await finalizeMedia(b, { backup: false });
      if (backup) after(() => finalizeMedia(b, { backup: true }).catch(() => null));
      return Response.json(out);
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

/** A file kept in R2 is deleted here: the browser can't reach the bucket (an Appwrite file goes from the browser). */
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
