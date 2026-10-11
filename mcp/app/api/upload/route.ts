// Direct browser → Blob uploads (any size, multipart) for transcription. Token issued only to signed-in users.
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { isAuthed } from "@/lib/session";

export const dynamic = "force-dynamic";

const AUDIO_VIDEO = ["audio/*", "video/*", "application/octet-stream"];

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as HandleUploadBody;
  try {
    const res = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("uploads/")) throw new Error("uploads/ only");
        return { allowedContentTypes: AUDIO_VIDEO, maximumSizeInBytes: 2 * 1024 ** 3, addRandomSuffix: true };
      },
    });
    return Response.json(res);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
