// Scheduled sweep (.github/workflows/sweep.yml, every 10 min): stops a GPU the app started once its worker has gone
// silent, so a crashed kernel doesn't bill until Colab reclaims it, then runs the publishing autopilot (lib/publish/run.ts)
// (downloads due to try again, then post pipelines, lib/pipeline.ts, then workflows, lib/auto/flows.ts) inside this request,
// not after the response: on Cloudflare, after() work is stopped 30 s after the response, which cut all of this short.
// The timer waits for the answer (a Cron Trigger may run 15 min). Same secret as the heartbeat.
import { sweep } from "@/lib/colab";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  // WORKER_SECRET, CRON_SECRET, or GitHub's OIDC token for sweep.yml (lib/cronauth.ts: no secret to copy into GitHub)
  if (!(await (await import("@/lib/cronauth")).cronAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  let gpu: unknown;
  try { gpu = await sweep(); } catch (e) { gpu = { error: (e as Error).message }; }
  await (async () => {
    // downloads waiting to try again (a site's rate limit that has had time to lift) go now, worker on or off
    const dl: Promise<unknown>[] = [];
    await (await import("@/lib/downloads")).refresh((f) => { dl.push(f().catch(() => null)); }, { name: "Download" }).catch((e) => console.error("downloads", e));
    await Promise.race([Promise.all(dl), new Promise((r) => setTimeout(r, 60_000))]); // a runtime start goes on beside the rest
    await (await import("@/lib/pipeline")).advancePipelines(40_000).catch((e) => console.error("pipelines", e)); // post pipelines carry on
    await (await import("@/lib/publish/run")).sweep(170_000).catch((e) => console.error("autopilot", e));
    await (await import("@/lib/publish/autodm-more")).sweep().catch((e) => console.error("autodm", e)); // DMs held by the hourly limit, the weekly report
    await (await import("@/lib/auto/flows")).sweep(55_000).catch((e) => console.error("workflows", e)); // schedules due, runs carried on
    await (await import("@/lib/auto/tools")).sweepFactory(30_000).catch((e) => console.error("factory", e)); // batches nobody is polling
    await (await import("@/lib/auto/ledger")).nightly().catch((e) => console.error("ledger", e)); // the agents' notes, one PR a night
  })();
  return Response.json(gpu, { status: gpu && typeof gpu === "object" && "error" in gpu ? 502 : 200 });
}
