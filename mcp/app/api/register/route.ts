// Heartbeat from a GPU worker (Colab; Kaggle with backend: "kaggle"; Modal / Cerebrium with their backend): POST {url, version, gpu, engines, loaded, queue, started_at, running, last_active}.
import { after } from "next/server";
import { saveWorker } from "@/lib/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // copying a finished download into Files runs after the reply
const TUNNEL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

export async function POST(req: Request) {
  const who = await (await import("@/lib/gpus")).workerCaller(req);
  if (!who) return Response.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => null);
  if (b?.backend === "modal" || b?.backend === "cerebrium") {
    // a cloud GPU (Modal: modal_app/, Cerebrium: cerebrium_app/) beats only while its container is awake: that time
    // counts toward its monthly cap (lib/gpus.ts). None of Colab's start / stop / reminder bookkeeping applies to it
    const g = await import("@/lib/gpus");
    const cloud = b.backend as "modal" | "cerebrium";
    if (b.hello === true) {
      // the end of its setup: its address, so nobody has to paste it
      try { await g.setPrefs({ [`${cloud}_url`]: String(b.url ?? ""), hello: true, cloud }); } catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
      return Response.json({ ok: true });
    }
    if (typeof b.url !== "string" || !g.URL_RE[cloud].test(b.url)) return Response.json({ error: `url must be a ${cloud} app address` }, { status: 400 });
    const boot = Number(b.started_at ?? 0) || Date.now() / 1000;
    // Stop was pressed after this container started: it shuts itself down (the app's watch loop)
    if (await g.shouldStop(boot, cloud)) { await g.countCloud(cloud, boot); return Response.json({ ok: true, stop: true }); }
    await saveWorker({ url: b.url, version: String(b.version ?? ""), gpu: b.gpu, engines: b.engines, loaded: b.loaded,
      queue: Number(b.queue ?? 0), running: Number(b.running ?? 0), started_at: Number(b.started_at ?? 0), last_seen: Date.now() }, cloud);
    await g.countCloud(cloud, boot);
    await import("@/lib/downloads").then((d) => d.refresh((f) => after(f), { name: "Download" })).catch((e) => console.error("downloads", e));
    return Response.json({ ok: true });
  }
  // the cloud key is for the cloud GPUs' heartbeats only: the Colab worker's record takes WORKER_SECRET
  if (who !== "worker") return Response.json({ error: "unauthorized" }, { status: 401 });
  const allowed = process.env.WORKER_URL_PATTERN ? new RegExp(process.env.WORKER_URL_PATTERN) : TUNNEL;
  if (!b || typeof b.url !== "string" || !allowed.test(b.url))
    return Response.json({ error: "url must be an https trycloudflare.com origin" }, { status: 400 });

  if (b.backend === "kaggle") {
    // the Kaggle notebook (lib/kaggle.ts): its own record and weekly hours; it stops itself when this answers stop
    const rec = { url: b.url, version: String(b.version ?? ""), gpu: b.gpu, engines: b.engines, loaded: b.loaded, queue: Number(b.queue ?? 0),
      running: Number(b.running ?? 0), started_at: Number(b.started_at ?? 0), last_seen: Date.now() };
    const k = await import("@/lib/kaggle");
    await k.countKaggle(rec.started_at || Date.now() / 1000);
    const why = await k.kaggleShouldStop(rec, Number(b.last_active ?? 0));
    if (why) { await saveWorker({ ...rec, last_seen: 0 }, "kaggle"); return Response.json({ ok: true, stop: true, why }); }
    await saveWorker(rec, "kaggle");
    await import("@/lib/downloads").then((d) => d.refresh((f) => after(f), { name: "Download" })).catch((e) => console.error("downloads", e));
    return Response.json({ ok: true });
  }

  // a worker on a runtime the app already stopped keeps heartbeating while Colab tears the machine down: it must not
  // look online (its tunnel is gone; a download sent to it waits on "Connecting" instead of a new runtime starting)
  const session = await import("@/lib/colab").then((c) => c.getSession()).catch(() => null);
  const boot = Number(b.started_at ?? 0) * 1000;
  if (session?.by === "app" && session.stopped && boot && boot >= session.started - 60_000 && boot <= session.stopped)
    return Response.json({ ok: true, ignored: "this runtime was stopped" });
  await saveWorker({
    url: b.url,
    version: String(b.version ?? ""),
    gpu: b.gpu,
    engines: b.engines,
    loaded: b.loaded,
    queue: Number(b.queue ?? 0),
    running: Number(b.running ?? 0), // how busy it is: a new job goes to the less busy free GPU (lib/gpus.ts order)
    started_at: Number(b.started_at ?? 0),
    last_seen: Date.now(),
  });
  // GPU from the app: hourly reminders, low-balance warning, idle auto-stop (no-op unless Colab is connected)
  await import("@/lib/colab").then((c) => c.onHeartbeat({ started_at: Number(b.started_at ?? 0), queue: Number(b.queue ?? 0),
    running: Number(b.running ?? 0), last_active: Number(b.last_active ?? 0), gpu: b.gpu?.name })).catch((e) => console.error("colab heartbeat", e));
  // a training run the last runtime didn't finish (the GPU went away) starts again here, from its checkpoint
  await import("@/lib/datasets").then((d) => d.resumeTraining(Math.round(Number(b.started_at ?? 0)))).catch((e) => console.error("resume training", e));
  // downloads waiting for the worker go now, and finished ones land in Files, with nobody on the Download page
  await import("@/lib/downloads").then((d) => d.refresh((f) => after(f), { name: "Download" })).catch((e) => console.error("downloads", e));
  return Response.json({ ok: true });
}
