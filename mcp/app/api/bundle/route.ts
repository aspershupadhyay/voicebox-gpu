// The worker code as a .tar.gz, for the one-cell Colab bootstrap. Same secret as the heartbeat.
import { WORKER_BUNDLE_B64, WORKER_VERSION } from "@/lib/bundle";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // WORKER_SECRET, or Modal's own key (lib/gpus.ts)
  if (!(await (await import("@/lib/gpus")).workerCaller(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  return new Response(Buffer.from(WORKER_BUNDLE_B64, "base64"), {
    headers: { "Content-Type": "application/gzip", "X-Worker-Version": WORKER_VERSION, "Cache-Control": "no-store" },
  });
}
