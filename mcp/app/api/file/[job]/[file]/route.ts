// Proxy for library files (downloads with a nice filename, or playback when presigning is unavailable).
import { isAuthed } from "@/lib/session";
import { FILE_RE, readFile, typeOf } from "@/lib/library";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ job: string; file: string }> }) {
  if (!(await isAuthed(req))) return new Response("unauthorized", { status: 401 });
  const { job, file } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(job) || !FILE_RE.test(file)) return new Response("bad path", { status: 400 });
  const r = await readFile(job, file);
  if (!r) return new Response("not found", { status: 404 });
  const q = new URL(req.url).searchParams;
  const headers: Record<string, string> = { "Content-Type": typeOf(file), "Content-Length": String(r.blob.size), "Cache-Control": "private, max-age=3600" };
  if (q.has("download")) headers["Content-Disposition"] = `attachment; filename="${(q.get("name") || file).replace(/[^A-Za-z0-9._-]/g, "_")}"`;
  return new Response(r.stream, { headers });
}
