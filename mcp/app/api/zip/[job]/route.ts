import { isAuthed } from "@/lib/session";
import { getLibJob, readAudio } from "@/lib/library";
import { zip } from "@/lib/zip";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!(await isAuthed(req))) return new Response("unauthorized", { status: 401 });
  const { job } = await ctx.params;
  const lib = await getLibJob(job);
  if (!lib) return new Response("not found", { status: 404 });
  const files = await Promise.all(
    lib.results.map(async (r) => {
      const a = await readAudio(job, r.id);
      return { name: `${r.id}.wav`, data: new Uint8Array(a ? await new Response(a.stream).arrayBuffer() : new ArrayBuffer(0)) };
    }),
  );
  files.push({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(lib, null, 2)) });
  const slug = `${lib.label || `${lib.engine}-${lib.voice}`}-${job}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(Buffer.from(zip(files)), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${slug}.zip"` },
  });
}
