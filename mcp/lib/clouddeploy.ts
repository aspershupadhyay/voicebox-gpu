// Deploying the cloud GPUs from the website (Settings → GPU & engines → Modal / Cerebrium → Deploy), no terminal:
// 1. a signed-in person pastes the cloud's own tokens once (Modal: token id + secret from `modal token new` or
//    modal.com → Settings → API Tokens; Cerebrium: a Service Account key from dashboard.cerebrium.ai → API Keys, and the
//    project id). They're kept in R2 sealed like the cloud key (lib/gpus.ts seal), never sent back to the browser (only
//    the last 4 characters) and never to a model.
// 2. Deploy starts .github/workflows/gpu-deploy.yml with the studio's GitHub key (Settings → Automation → Keys; it
//    needs Actions: write on this repository) and a one-time deploy id.
// 3. The run proves itself with GitHub's OIDC token (lib/cronauth.ts: signed by GitHub, audience voicebox-deploy,
//    gpu-deploy.yml on main) and turns the deploy id in for the tokens and the cloud key (/api/gpus/deploy-keys): once,
//    within 30 minutes. It masks them, deploys, connects the address, and reports how it went (/api/gpus/deploy-report).
import { randomBytes } from "node:crypto";
import { getJson, putJson } from "./store";
import { modalKey, newModalKey, seal, unseal, type Cloud } from "./gpus";
import { GITHUB_REPO } from "./cronauth";

export const DEPLOY_AUDIENCE = "voicebox-deploy";
export const DEPLOY_WORKFLOW = "gpu-deploy.yml";
const TOKENS = "voicebox/cloud-tokens.json";
const RUNS = "voicebox/cloud-deploys.json";
const TTL = 30 * 60_000;

type Sealed = { enc: string; last4: string };
type Tokens = { modal?: { id: Sealed; secret: Sealed; at: number; by: string }; cerebrium?: { token: Sealed; project: string; at: number; by: string } };
export type Deploy = { id: string; cloud: Cloud; by: string; at: number; status: "starting" | "running" | "done" | "failed"; fetched?: number;
  finished?: number; note?: string; url?: string | null; run_url?: string | null };

const sealed = (v: string): Sealed => ({ enc: seal(v), last4: v.slice(-4) });
const open = (s?: Sealed) => (s ? unseal(s.enc) : null);
const PROJECT = /^p-[a-z0-9]{4,40}$/;

/** What the dashboard shows: whether each cloud's tokens are saved (the last 4 characters), never the tokens. */
export async function tokensStatus() {
  const t = (await getJson<Tokens>(TOKENS).catch(() => null)) ?? {};
  return {
    modal: t.modal && open(t.modal.id) ? { saved: true, last4: t.modal.secret.last4, at: t.modal.at, by: t.modal.by } : { saved: false },
    cerebrium: t.cerebrium && open(t.cerebrium.token) ? { saved: true, last4: t.cerebrium.token.last4, project: t.cerebrium.project, at: t.cerebrium.at, by: t.cerebrium.by } : { saved: false },
  };
}

/** Save (or with null, forget) a cloud's deploy tokens. A signed-in person only (the route checks). */
export async function setTokens(cloud: Cloud, body: Record<string, unknown>, by: string) {
  const t = (await getJson<Tokens>(TOKENS).catch(() => null)) ?? {};
  const str = (k: string) => String(body[k] ?? "").trim();
  if (body.forget === true) delete t[cloud];
  else if (cloud === "modal") {
    const id = str("token_id"), secret = str("token_secret");
    if (!/^ak-[A-Za-z0-9]{8,80}$/.test(id) || !/^as-[A-Za-z0-9]{8,80}$/.test(secret))
      throw new Error("Modal's token id starts with ak- and its secret with as- (modal.com → Settings → API Tokens → New token)");
    t.modal = { id: sealed(id), secret: sealed(secret), at: Date.now(), by };
  } else {
    const token = str("token"), project = str("project").toLowerCase();
    if (token.length < 20 || token.length > 4000 || /\s/.test(token)) throw new Error("paste the Service Account key from dashboard.cerebrium.ai → API Keys");
    if (!PROJECT.test(project)) throw new Error("the project id looks like p-xxxxxxxx (dashboard.cerebrium.ai, top left)");
    t.cerebrium = { token: sealed(token), project, at: Date.now(), by };
  }
  await putJson(TOKENS, t);
  return tokensStatus();
}

async function runs(): Promise<Deploy[]> {
  return ((await getJson<Deploy[]>(RUNS).catch(() => null)) ?? []).filter((d) => Date.now() - d.at < 7 * 86_400_000);
}
async function saveRun(d: Deploy) {
  const all = (await runs()).filter((x) => x.id !== d.id);
  await putJson(RUNS, [d, ...all].slice(0, 30));
}
export const listDeploys = async () => (await runs()).map(({ id, cloud, by, at, status, finished, note, url, run_url }) => ({ id, cloud, by, at, status, finished, note, url, run_url }));

/** Start a deploy: a one-time id, then the workflow, started with the studio's GitHub key. */
export async function startDeploy(cloud: Cloud, by: string) {
  const st = await tokensStatus();
  if (!st[cloud].saved) throw new Error(`save ${cloud === "modal" ? "Modal" : "Cerebrium"}'s tokens first`);
  const gh = await (await import("./auto/secrets")).secret("github");
  if (!gh) throw new Error("the studio needs a GitHub key to start the deploy: Settings → Automation → Keys (with Actions: read and write on this repository)");
  if (!(await modalKey())) await newModalKey(by); // the cloud key the deployed GPU will use
  const d: Deploy = { id: randomBytes(9).toString("hex"), cloud, by, at: Date.now(), status: "starting" };
  await saveRun(d);
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const r = await fetch(`${api}/repos/${GITHUB_REPO}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, {
    method: "POST", headers: { Authorization: `Bearer ${gh}`, Accept: "application/vnd.github+json", "User-Agent": "voicebox", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { cloud, deploy: d.id } }), cache: "no-store",
  });
  if (r.status !== 204) {
    const why = (await r.text()).slice(0, 200);
    await saveRun({ ...d, status: "failed", finished: Date.now(), note: `GitHub refused to start it (${r.status})` });
    throw new Error(r.status === 403 || r.status === 404 ? `GitHub refused to start the deploy (${r.status}): the GitHub key in Settings → Automation → Keys needs Actions: read and write on ${GITHUB_REPO}` : `GitHub said ${r.status}: ${why}`);
  }
  return d;
}

/** The run turns its deploy id in (once, within 30 minutes): the tokens and the cloud key, for that one deploy. */
export async function deployKeys(cloud: Cloud, id: string, origin: string) {
  const d = (await runs()).find((x) => x.id === id && x.cloud === cloud);
  if (!d || d.fetched || d.status !== "starting" || Date.now() - d.at > TTL) return null;
  const t = (await getJson<Tokens>(TOKENS).catch(() => null)) ?? {};
  const key = await modalKey();
  if (!key) return null;
  const base = { cloud_key: key, studio: origin, register_url: `${origin}/api/register` };
  let out: Record<string, string> | null = null;
  if (cloud === "modal" && t.modal) { const a = open(t.modal.id), b = open(t.modal.secret); if (a && b) out = { ...base, modal_token_id: a, modal_token_secret: b }; }
  if (cloud === "cerebrium" && t.cerebrium) { const a = open(t.cerebrium.token); if (a) out = { ...base, cerebrium_token: a, cerebrium_project: t.cerebrium.project }; }
  if (!out) return null;
  await saveRun({ ...d, status: "running", fetched: Date.now() });
  return out;
}

/** The run's report: how the deploy went. */
export async function deployReport(id: string, body: { ok?: unknown; note?: unknown; url?: unknown; run_url?: unknown }) {
  const d = (await runs()).find((x) => x.id === id);
  if (!d) return false;
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
  await saveRun({ ...d, status: body.ok === true ? "done" : "failed", finished: Date.now(), note: s(body.note, 300) ?? undefined, url: s(body.url, 200), run_url: s(body.run_url, 300) });
  return true;
}
