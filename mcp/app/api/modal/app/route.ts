// modal_app/voicebox_modal.py, for the Modal setup commands (Settings → GPU & engines → Set up Modal): fetched with
// Modal's own key (or WORKER_SECRET), so setting Modal up needs no copy of this repository. It holds no secrets.
import { MODAL_APP_PY } from "@/lib/bundle";
import { workerCaller } from "@/lib/gpus";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await workerCaller(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  return new Response(MODAL_APP_PY, { headers: { "Content-Type": "text/x-python; charset=utf-8", "Cache-Control": "no-store" } });
}
