// The cloud GPUs' app files, for their setup commands (Settings → GPU & engines → Set up): modal_app/voicebox_modal.py
// by default, ?f=cerebrium.toml or ?f=voicebox_cerebrium.py for Cerebrium. Fetched with the cloud key (or
// WORKER_SECRET), so setting one up needs no copy of this repository. They hold no secrets.
import { CEREBRIUM_PY, CEREBRIUM_TOML, MODAL_APP_PY } from "@/lib/bundle";
import { workerCaller } from "@/lib/gpus";

export const dynamic = "force-dynamic";

const FILES: Record<string, [string, string]> = {
  "voicebox_modal.py": [MODAL_APP_PY, "text/x-python"],
  "cerebrium.toml": [CEREBRIUM_TOML, "application/toml"],
  "voicebox_cerebrium.py": [CEREBRIUM_PY, "text/x-python"],
};

export async function GET(req: Request) {
  if (!(await workerCaller(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const f = FILES[new URL(req.url).searchParams.get("f") || "voicebox_modal.py"];
  if (!f) return Response.json({ error: "no such file" }, { status: 404 });
  return new Response(f[0], { headers: { "Content-Type": `${f[1]}; charset=utf-8`, "Cache-Control": "no-store" } });
}
