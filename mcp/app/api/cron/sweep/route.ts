// Scheduled sweep (.github/workflows/sweep.yml, every 10 min): stops a GPU the app started once its worker has gone
// silent, so a crashed kernel doesn't bill until Colab reclaims it. Same secret as the heartbeat.
import { sweep } from "@/lib/colab";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 24 || !safeEqual(token, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await sweep());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
