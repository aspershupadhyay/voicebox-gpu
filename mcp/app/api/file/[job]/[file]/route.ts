// Proxy for library files (downloads with a nice filename, or playback when presigning is unavailable).
import { isAuthed } from "@/lib/session";
import { FILE_RE, presignPath, readFile, typeOf } from "@/lib/library";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ job: string; file: string }> }) {
  if (!(await isAuthed(req))) return new Response("unauthorized", { status: 401 });
  const { job, file } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(job) || !FILE_RE.test(file)) return new Response("bad path", { status: 400 });
  const q = new URL(req.url).searchParams;
  if (q.has("download")) {
    // downloads go straight to storage with a friendly filename; nothing streams through the function
    return Response.redirect(await presignPath(`library/${job}/${file}`, 600, q.get("name") || file), 302);
  }
  const r = await readFile(job, file);
  if (!r) return new Response("not found", { status: 404 });
  const headers: Record<string, string> = { "Content-Type": typeOf(file), "Cache-Control": "private, max-age=3600" };
  const len = r.headers.get("content-length");
  if (len) headers["Content-Length"] = len;
  return new Response(r.body, { headers });
}
