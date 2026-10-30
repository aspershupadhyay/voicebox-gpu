// The nightly backup (lib/backup.ts), knocked by .github/workflows/sweep.yml every 10 min beside the sweep: it only
// does something once a day after 02:00 UTC (and while a models copy is catching up), so most knocks read one small
// file and stop. Its own function, so the sweep's autopilot keeps all of its time. Same secret as the sweep.
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  // WORKER_SECRET (shared with the Colab worker) or CRON_SECRET (only the scheduled knocks: GitHub's copy can be
  // replaced without touching the worker)
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = [process.env.WORKER_SECRET, process.env.CRON_SECRET].some((s) => (s ?? "").length >= 24 && safeEqual(token, s!));
  if (!ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const out = await (await import("@/lib/backup")).nightly(240_000);
    return Response.json(out ?? { idle: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
