// The deploy run (.github/workflows/gpu-deploy.yml) turns its one-time deploy id in for the cloud's tokens and the
// cloud key (lib/clouddeploy.ts). Only with GitHub's OIDC token for that workflow on main (audience voicebox-deploy),
// once per deploy id, within 30 minutes of the dashboard starting it. Answers nothing else.
import { DEPLOY_AUDIENCE, DEPLOY_WORKFLOW, deployKeys } from "@/lib/clouddeploy";
import { githubOidc, workflowRef } from "@/lib/cronauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !(await githubOidc(token, DEPLOY_AUDIENCE, workflowRef(DEPLOY_WORKFLOW)))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { cloud?: string; deploy?: string } | null;
  if (!b || (b.cloud !== "modal" && b.cloud !== "cerebrium") || !/^[a-f0-9]{18}$/.test(String(b.deploy ?? ""))) return Response.json({ error: "cloud and deploy" }, { status: 400 });
  const origin = (await import("@/lib/colab")).appOrigin(new URL(req.url).origin) || new URL(req.url).origin;
  const keys = await deployKeys(b.cloud, String(b.deploy), origin);
  if (!keys) return Response.json({ error: "no such deploy waiting (started over 30 min ago, already used, or the tokens aren't saved)" }, { status: 404 });
  return Response.json(keys, { headers: { "Cache-Control": "no-store" } });
}
