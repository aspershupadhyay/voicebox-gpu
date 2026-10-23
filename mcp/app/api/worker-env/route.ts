// Runtime settings for the GPU worker (same secret as the heartbeat): the Hugging Face token (so big downloads aren't
// rate-limited and your private voice model can load) and which trained voice model to serve as the myvoice engine.
import { adapterUrl } from "@/lib/voicemodel";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.WORKER_SECRET ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 24 || !safeEqual(token, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  // a model trained from the dashboard (kept in R2) unless MY_VOICE_MODEL points at one on Hugging Face
  const trained = process.env.MY_VOICE_MODEL ? null : await adapterUrl().catch(() => null);
  return Response.json({ HF_TOKEN: process.env.HF_TOKEN || null, MY_VOICE_MODEL: process.env.MY_VOICE_MODEL || null,
    MY_VOICE_SPEAKER: process.env.MY_VOICE_SPEAKER || trained?.speaker || null, MY_VOICE_ADAPTER_URL: trained?.url ?? null },
    { headers: { "Cache-Control": "no-store" } });
}
