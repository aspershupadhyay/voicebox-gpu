// Save a file into Files from anywhere (an AI, a script), step 1 of 3 (lib/inbox.ts): POST {name, size?, type?,
// folder?, post_id?, carousel?, position?} → {upload_url, ticket}. Then `curl -T <file> "<upload_url>"`, then POST the
// ticket to /api/files/complete. `carousel` (an id, or a name: a new name makes one) with `position` (1 = first) stacks
// a post's photos as one carousel on the Files page. Several at once: POST {files: [{name, size?, type?, position?}],
// folder?, post_id?, carousel?} → {uploads: [{name, upload_url, ticket, position}]} (no positions: the listed order).
// Signed in, Bearer MCP_TOKEN, or Bearer an upload key (Settings → Upload keys), which can only save files and arrange
// carousels (/api/files/carousels).
import { startUpload, startUploads, uploadKeyOk } from "@/lib/inbox";
import { isAuthed } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await isAuthed(req)) && !(await uploadKeyOk(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const origin = new URL(req.url).origin;
    if (Array.isArray(body.files)) {
      const uploads = await startUploads(body, origin);
      return Response.json({ uploads, next: [`curl -sS -T <file> "<put_url>"  (or <upload_url> over 95 MB; each file; run them side by side)`,
        `curl -sS -X POST ${origin}/api/files/complete -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"tickets":["<ticket>", ...]}'`] });
    }
    const r = await startUpload(body, origin);
    return Response.json({ ...r, next: [`curl -sS -T <file> "${r.put_url ?? r.upload_url}"`, `curl -sS -X POST ${origin}/api/files/complete -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"ticket":"${r.ticket}"}'`] });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
