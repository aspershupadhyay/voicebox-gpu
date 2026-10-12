// Runtime settings for the GPU worker (same secret as the heartbeat): today just the Hugging Face read token,
// so big model downloads aren't rate-limited without the user pasting it into Colab Secrets.
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.WORKER_SECRET ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 24 || !safeEqual(token, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ HF_TOKEN: process.env.HF_TOKEN || null }, { headers: { "Cache-Control": "no-store" } });
}
