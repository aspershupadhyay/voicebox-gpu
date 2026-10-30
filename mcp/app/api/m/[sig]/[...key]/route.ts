// A Files upload kept in R2 (lib/r2files.ts): /api/m/<token>/<key>[?mode=download|preview&width=&output=webp|png|jpg].
// Public by design, like an Appwrite file token: the token is an HMAC of the key, kept only in team-only rows, so
// <img>/<video> and the worker can load it without a session. It only serves workspace/media/; nothing else in the
// bucket. Answers with a redirect to a presigned R2 link (bytes never pass through here) that the browser and the CDN
// keep for an hour; a photo's resized copy is made once, the first time it's asked for.
import { presign } from "@/lib/store";
import { resizable, sigOk, thumb, type ThumbFormat } from "@/lib/r2files";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sig: string; key: string[] }> };
const KEEP = "public, max-age=3600, s-maxage=3600";

export async function GET(req: Request, ctx: Ctx) {
  const { sig, key: parts } = await ctx.params;
  const key = parts.map(decodeURIComponent).join("/");
  if (!sigOk(key, sig)) return Response.json({ error: "not found" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const mode = q.get("mode");
  try {
    if (mode === "preview" && resizable(key)) {
      const out = (["webp", "png", "jpg"].includes(q.get("output") ?? "") ? q.get("output") : "webp") as ThumbFormat;
      const t = await thumb(key, Number(q.get("width")) || 1280, out);
      // just made: send it now; next time it's a redirect like everything else
      if (t.bytes) return new Response(t.bytes as BodyInit, { headers: { "Content-Type": t.type, "Cache-Control": KEEP } });
      return new Response(null, { status: 302, headers: { Location: await presign(t.key, "GET", 6 * 3600, undefined, true), "Cache-Control": KEEP } });
    }
    const name = mode === "download" ? key.split("/").pop() : undefined;
    const to = await presign(key, "GET", 6 * 3600, name, true);
    return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": KEEP } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: /not found/.test((e as Error).message) ? 404 : 502 });
  }
}
