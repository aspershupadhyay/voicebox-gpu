// Heartbeat from the Colab worker: POST {url, version, gpu, engines, loaded, queue, started_at}.
import { saveWorker } from "@/lib/registry";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";
const TUNNEL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 24 || !safeEqual(token, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => null);
  const allowed = process.env.WORKER_URL_PATTERN ? new RegExp(process.env.WORKER_URL_PATTERN) : TUNNEL;
  if (!b || typeof b.url !== "string" || !allowed.test(b.url))
    return Response.json({ error: "url must be an https trycloudflare.com origin" }, { status: 400 });

  await saveWorker({
    url: b.url,
    version: String(b.version ?? ""),
    gpu: b.gpu,
    engines: b.engines,
    loaded: b.loaded,
    queue: Number(b.queue ?? 0),
    started_at: Number(b.started_at ?? 0),
    last_seen: Date.now(),
  });
  return Response.json({ ok: true });
}
