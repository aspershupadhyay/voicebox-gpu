// The worker calls this the moment a download job finishes (worker/gateway.py _notify_done), so the files are saved
// to Files now instead of at the next look or heartbeat. WORKER_SECRET only; it just runs the same refresh.
import { after } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // copying the files into Files runs after the reply

export async function POST(req: Request) {
  // WORKER_SECRET, or Modal's own key (lib/gpus.ts)
  if (!(await (await import("@/lib/gpus")).workerCaller(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const dl = await import("@/lib/downloads");
  await dl.refresh((f) => after(f), { name: "Download" });
  return Response.json({ ok: true });
}
