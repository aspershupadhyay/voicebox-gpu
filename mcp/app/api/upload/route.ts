// Direct browser -> R2 uploads: POST {name, type} returns a presigned PUT URL (15 min) under uploads/.
// Used for files to transcribe, voice recordings and images to animate. Signed-in users only.
import { after } from "next/server";
import { isAuthed } from "@/lib/session";
import { delObjs, listObjs, presign } from "@/lib/store";

export const dynamic = "force-dynamic";

const OK_TYPE = /^(audio|video|image)\//;
const OK_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|opus|webm|mp4|mov|mkv|jpg|jpeg|png|webp)$/i;

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const name = String(b.name ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  if (!OK_EXT.test(name) && !OK_TYPE.test(String(b.type ?? ""))) return Response.json({ error: "audio, video or image files only" }, { status: 400 });
  // uploads are only needed until the worker has fetched them: sweep anything older than two days now and then
  if (Math.random() < 0.1) {
    after(() => listObjs("uploads/").then((all) => delObjs(all.filter((o) => Date.now() - o.modified > 2 * 86400_000).map((o) => o.key))).catch(() => {}));
  }
  const key = `uploads/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${name || "file"}`;
  return Response.json({ key, url: await presign(key, "PUT", 15 * 60) });
}
