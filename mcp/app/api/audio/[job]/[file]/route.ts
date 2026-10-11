import { isAuthed } from "@/lib/session";
import { readAudio } from "@/lib/library";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ job: string; file: string }> }) {
  if (!(await isAuthed(req))) return new Response("unauthorized", { status: 401 });
  const { job, file } = await ctx.params;
  const line = file.replace(/\.wav$/, "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(job) || !/^[A-Za-z0-9_-]{1,64}$/.test(line)) return new Response("bad path", { status: 400 });
  const r = await readAudio(job, line);
  if (!r) return new Response("not found", { status: 404 });
  const name = new URL(req.url).searchParams.get("name") || `${line}.wav`;
  const headers: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Content-Length": String(r.blob.size),
    "Cache-Control": "private, max-age=3600",
  };
  if (new URL(req.url).searchParams.has("download"))
    headers["Content-Disposition"] = `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
  return new Response(r.stream, { headers });
}
