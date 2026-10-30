// An upload link's page talks to this (lib/auto/uplinks.ts): public by design, but the token is a signed, expiring
// claim that can only start and finish uploads into its one folder, up to its file cap. Nothing is read or listed.
import { completeUploads, startUpload } from "@/lib/inbox";
import { openLink, take } from "@/lib/auto/uplinks";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const l = openLink((await params).token);
  if (!l) return Response.json({ error: "This link has expired or isn't valid. Ask for a new one." }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === "start") {
      if (!(await take(l, 1))) return Response.json({ error: `This link takes ${l.max} files and they're all used. Ask for a new one.` }, { status: 403 });
      const r = await startUpload({ name: body.name, size: body.size, type: body.type, folder: l.f ?? undefined });
      return Response.json({ upload_url: r.upload_url, ticket: r.ticket });
    }
    if (body.action === "complete" && Array.isArray(body.tickets)) {
      const saved = await completeUploads(body.tickets.slice(0, 20).map(String), { name: `upload link from ${l.by}` });
      const ids = (saved as { file_id?: string }[]).map((s) => s.file_id).filter((x): x is string => !!x);
      if (l.p && ids.length) await (await import("@/lib/auto/projects")).record(l.p, { files: ids, jobs: [] }, "upload_link", l.by).catch(() => {});
      return Response.json({ saved: ids.length });
    }
    return Response.json({ error: "action: start or complete" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
