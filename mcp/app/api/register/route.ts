// Heartbeat from the Colab worker: POST {url, version, gpu, engines, loaded, queue, started_at, running, last_active}.
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
  // GPU from the app: hourly reminders, low-balance warning, idle auto-stop (no-op unless Colab is connected)
  await import("@/lib/colab").then((c) => c.onHeartbeat({ started_at: Number(b.started_at ?? 0), queue: Number(b.queue ?? 0),
    running: Number(b.running ?? 0), last_active: Number(b.last_active ?? 0), gpu: b.gpu?.name })).catch((e) => console.error("colab heartbeat", e));
  // a training run the last runtime didn't finish (the GPU went away) starts again here, from its checkpoint
  await import("@/lib/datasets").then((d) => d.resumeTraining(Math.round(Number(b.started_at ?? 0)))).catch((e) => console.error("resume training", e));
  return Response.json({ ok: true });
}
