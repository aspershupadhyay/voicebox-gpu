// The worker code as a .tar.gz, for the one-cell Colab bootstrap. Same secret as the heartbeat.
import { WORKER_BUNDLE_B64, WORKER_VERSION } from "@/lib/bundle";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.WORKER_SECRET ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 24 || !safeEqual(token, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return new Response(Buffer.from(WORKER_BUNDLE_B64, "base64"), {
    headers: { "Content-Type": "application/gzip", "X-Worker-Version": WORKER_VERSION, "Cache-Control": "no-store" },
  });
}
