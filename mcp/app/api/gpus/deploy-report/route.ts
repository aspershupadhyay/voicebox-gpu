// The deploy run's report (.github/workflows/gpu-deploy.yml): done or failed, the app's address, the run's link.
// Only with GitHub's OIDC token for that workflow on main; it can only mark its own deploy id (lib/clouddeploy.ts).
import { DEPLOY_AUDIENCE, DEPLOY_WORKFLOW, deployReport } from "@/lib/clouddeploy";
import { githubOidc, workflowRef } from "@/lib/cronauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !(await githubOidc(token, DEPLOY_AUDIENCE, workflowRef(DEPLOY_WORKFLOW)))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { deploy?: string; ok?: boolean; note?: string; url?: string; run_url?: string } | null;
  if (!b || !/^[a-f0-9]{18}$/.test(String(b.deploy ?? ""))) return Response.json({ error: "deploy" }, { status: 400 });
  return (await deployReport(String(b.deploy), b)) ? Response.json({ ok: true }) : Response.json({ error: "no such deploy" }, { status: 404 });
}
