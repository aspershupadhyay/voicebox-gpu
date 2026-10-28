// Save a file into Files from anywhere (an AI, a script), step 1 of 3 (lib/inbox.ts): POST {name, size?, type?,
// folder?, post_id?} → {upload_url, ticket}. Then `curl -T <file> "<upload_url>"`, then POST the ticket to
// /api/files/complete. Signed in, Bearer MCP_TOKEN, or Bearer an upload key (Settings → Upload keys), which can do
// nothing but this.
import { startUpload, uploadKeyOk } from "@/lib/inbox";
import { isAuthed } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await isAuthed(req)) && !(await uploadKeyOk(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const r = await startUpload(await req.json().catch(() => ({})));
    const origin = new URL(req.url).origin;
    return Response.json({ ...r, next: [`curl -sS -T <file> "${r.upload_url}"`, `curl -sS -X POST ${origin}/api/files/complete -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"ticket":"${r.ticket}"}'`] });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
