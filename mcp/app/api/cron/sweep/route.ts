// Scheduled sweep (.github/workflows/sweep.yml, every 10 min): stops a GPU the app started once its worker has gone
// silent, so a crashed kernel doesn't bill until Colab reclaims it, then runs the publishing autopilot (lib/publish/run.ts)
// after the response (downloads due to try again, then post pipelines, lib/pipeline.ts, then workflows, lib/auto/flows.ts), so the knock returns at once and uploads get the function's full time. Same secret as the heartbeat.
import { after } from "next/server";
import { sweep } from "@/lib/colab";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 24 || !safeEqual(token, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  after(async () => {
    // downloads waiting to try again (a site's rate limit that has had time to lift) go now, worker on or off
    const dl: Promise<unknown>[] = [];
    await (await import("@/lib/downloads")).refresh((f) => { dl.push(f().catch(() => null)); }, { name: "Download" }).catch((e) => console.error("downloads", e));
    await Promise.race([Promise.all(dl), new Promise((r) => setTimeout(r, 60_000))]); // a runtime start goes on beside the rest
    await (await import("@/lib/pipeline")).advancePipelines(40_000).catch((e) => console.error("pipelines", e)); // post pipelines carry on
    await (await import("@/lib/publish/run")).sweep(170_000).catch((e) => console.error("autopilot", e));
    await (await import("@/lib/auto/flows")).sweep(55_000).catch((e) => console.error("workflows", e)); // schedules due, runs carried on
  });
  try {
    return Response.json(await sweep());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
