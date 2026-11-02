// Step 2 of a studio upload (components/api.ts uploadFile), through our own domain: the browser PUTs the file's bytes
// here and they stream into R2 through the Worker's binding. Same origin, so no bucket CORS for the browser to trip on
// (a refused cross-site PUT to the R2 hostname shows up only as "network or storage CORS" and loses the upload).
// Signed-in only, and only into the one `uploads/` key that POST /api/upload just handed out; up to 95 MB (Cloudflare's
// request cap), bigger files go to the presigned address. Never overwrites, reads or lists anything.
import { isAuthed } from "@/lib/session";
import { PUT_MAX } from "@/lib/inbox";
import { headObj, putObj, putStream, typeOf } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const KEY = /^uploads\/[a-z0-9]{6,12}-[a-z0-9]{1,8}-[A-Za-z0-9._-]{1,80}$/;

export async function PUT(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!KEY.test(key) || key.includes("..")) return Response.json({ error: "not an upload key" }, { status: 400 });
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (!Number.isInteger(len) || len <= 0) return Response.json({ error: "send the file with its Content-Length" }, { status: 411 });
  if (len > PUT_MAX) return Response.json({ error: `over ${PUT_MAX / 1e6} MB: use the direct address` }, { status: 413 });
  if (await headObj(key)) return Response.json({ error: "already uploaded" }, { status: 409 });
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim() || typeOf(key);
  const body = req.body!;
  if (!(await putStream(key, body, len, type))) await putObj(key, await new Response(body).arrayBuffer(), type);
  const head = await headObj(key);
  if (!head || head.size !== len) return Response.json({ error: `stored ${head?.size ?? 0} of ${len} bytes: try again` }, { status: 500 });
  return Response.json({ key, bytes: len });
}
