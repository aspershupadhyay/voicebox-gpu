// Kaggle as a fourth GPU (the owner, 2026-11-10: "connect Kaggle; optimise the free resources"). Kaggle gives about
// 30 GPU hours a week (a T4, sessions up to 12 h). The app starts a private Kaggle notebook through Kaggle's API when
// work needs a GPU and Colab is off; the notebook runs the same worker as Colab (gateway + Cloudflare tunnel +
// heartbeat, worker/launcher.py with VOICEBOX_BACKEND=kaggle), and it stops itself once idle (kaggle_idle_min), when
// Stop is pressed, past the weekly cap, or before Kaggle's 12-hour limit, so the weekly hours go to work, not waiting.
//
// Settings on the Worker: KAGGLE_USERNAME, and KAGGLE_API_TOKEN (a token from kaggle.com → Settings → API) or the
// older KAGGLE_KEY from kaggle.json. The notebook carries no secret: it holds a boot ticket (HMAC-signed, 30 minutes,
// one use) that /api/kaggle/boot swaps for the worker's secret.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getJson, getJsonTagged, putJson, putJsonIf } from "./store";
import { loadWorker, STALE_MS, type WorkerRecord } from "./registry";
import type { GpuPrefs, KaggleState } from "./gpus";

const API = "https://api.kaggle.com/v1/kernels.KernelsApiService";
const SLUG = "voicebox-gpu-worker";
const START = "voicebox/kaggle-start.json";
const USAGE = "voicebox/kaggle-usage.json";
/** Kaggle ends a session at 12 h: the worker stops itself a little before, between jobs. */
const MAX_SESSION_MS = 11.5 * 3600_000;
/** A start in flight: the notebook boots in 3-6 minutes; another start isn't sent before this. */
const BOOTING_MS = 12 * 60_000;

type Start = { at: number; by: string; nonce: string; used?: boolean; error?: string; ref?: string };
type Usage = { week: string; seconds: number; boot?: number; seen?: number };

const user = () => (process.env.KAGGLE_USERNAME ?? "").trim();
export const kaggleConfigured = () => !!user() && !!((process.env.KAGGLE_API_TOKEN ?? "").trim() || (process.env.KAGGLE_KEY ?? "").trim());

function auth() {
  const token = (process.env.KAGGLE_API_TOKEN ?? "").trim();
  if (token) return `Bearer ${token}`;
  return `Basic ${Buffer.from(`${user()}:${(process.env.KAGGLE_KEY ?? "").trim()}`).toString("base64")}`;
}

async function kaggle<T>(method: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/${method}`, {
    method: "POST", headers: { Authorization: auth(), "Content-Type": "application/json", "User-Agent": "voicebox-studio" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  const text = await r.text();
  const j = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (!r.ok || (j && typeof j.code === "number" && j.code >= 400)) {
    const why = j?.message || text.slice(0, 200) || `HTTP ${r.status}`;
    throw new Error(r.status === 401 || r.status === 403 ? `Kaggle turned the key down (${why}): check KAGGLE_USERNAME and the token` : `Kaggle ${method}: ${why}`);
  }
  return j as T;
}

// ── the week's hours (Monday 00:00 UTC to Monday), counted from heartbeats like the cloud GPUs' months
function week(now = Date.now()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
async function usage(): Promise<Usage> {
  const u = await getJson<Usage>(USAGE).catch(() => null);
  return u && u.week === week() ? u : { week: week(), seconds: 0 };
}
/** A heartbeat: the time since the last one counts (at most two minutes, so a gap never counts). */
export async function countKaggle(startedAt: number) {
  const u = await usage();
  const now = Date.now(), boot = Math.round(startedAt * 1000);
  const from = u.boot === boot && u.seen ? u.seen : boot || now;
  u.seconds += Math.max(0, Math.min(120, (now - from) / 1000));
  await putJson(USAGE, { ...u, boot, seen: now });
}

/** Kaggle's part of gpuState (lib/gpus.ts). */
export async function kaggleState(): Promise<(p: GpuPrefs) => KaggleState> {
  const [rec, u, st] = await Promise.all([loadWorker("kaggle").catch(() => null), usage(), getJson<Start>(START).catch(() => null)]);
  return (p) => {
    const used_h = Math.round((u.seconds / 3600) * 10) / 10;
    const online = !!rec && Date.now() - rec.last_seen < STALE_MS;
    const booting = !!st && !st.error && Date.now() - st.at < BOOTING_MS && !(rec && rec.last_seen > st.at);
    return { rec, online, configured: kaggleConfigured() && p.kaggle_on, used_h, cap_h: p.kaggle_cap_h, over: used_h >= p.kaggle_cap_h,
      starting_since: booting ? st!.at : null };
  };
}

// ── the boot ticket: the notebook's only claim, swapped once for the worker's secret
const sign = (s: string) => createHmac("sha256", process.env.WORKER_SECRET ?? "").update(`voicebox-kaggle-boot-v1:${s}`).digest("base64url");
function ticket(nonce: string, exp: number) { const body = `${exp}.${nonce}`; return `${body}.${sign(body)}`; }

/** /api/kaggle/boot: the worker's secret for a valid, unused ticket of the start in flight; null otherwise. */
export async function redeemTicket(t: string): Promise<string | null> {
  const [exp, nonce, mac] = String(t).split(".");
  if (!exp || !nonce || !mac || Number(exp) < Date.now()) return null;
  const want = sign(`${exp}.${nonce}`);
  if (want.length !== mac.length || !timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  const { value, etag } = await getJsonTagged<Start>(START);
  if (!value || value.nonce !== nonce || value.used) return null;
  if (!(await putJsonIf(START, { ...value, used: true }, etag))) return null;
  const secret = process.env.WORKER_SECRET ?? "";
  return secret.length >= 24 ? secret : null;
}

/** The notebook Kaggle runs: fetch the secret with the ticket, the worker code from the studio, then the launcher. */
function notebook(origin: string, t: string) {
  const code = `# VoiceBox GPU worker on Kaggle: started by the studio, stops itself when idle. Nothing to do here.
import io, json, os, runpy, subprocess, sys, tarfile, urllib.request
STUDIO = ${JSON.stringify(origin)}
print(subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True).stdout or "no GPU")
req = urllib.request.Request(STUDIO + "/api/kaggle/boot", data=json.dumps({"ticket": ${JSON.stringify(t)}}).encode(),
                             headers={"Content-Type": "application/json", "User-Agent": "voicebox-kaggle"}, method="POST")
secret = json.loads(urllib.request.urlopen(req, timeout=60).read())["secret"]
HOME = "/tmp/voicebox"
os.environ.update({"WORKER_SECRET": secret, "REGISTER_URL": STUDIO + "/api/register", "VOICEBOX_BACKEND": "kaggle",
                   "VOICEBOX_HOME": HOME, "VOICEBOX_SANDBOX": "/tmp/sandbox", "VOICEBOX_STARTED_BY": "app"})
os.makedirs(HOME + "/app", exist_ok=True)
b = urllib.request.urlopen(urllib.request.Request(STUDIO + "/api/bundle", headers={"Authorization": "Bearer " + secret, "User-Agent": "voicebox-kaggle"}), timeout=120).read()
tarfile.open(fileobj=io.BytesIO(b)).extractall(HOME + "/app")
sys.argv = ["launcher.py"]
runpy.run_path(HOME + "/app/launcher.py", run_name="__main__")
`;
  return JSON.stringify({
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } },
    nbformat: 4, nbformat_minor: 4,
    cells: [{ cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: code }],
  });
}

/** Start the Kaggle notebook (a new run of it), unless it's on, booting, off in Settings or past the week's cap. */
export async function startKaggle(origin: string, by = "the studio", force = false) {
  if (!kaggleConfigured()) throw new Error("Kaggle isn't set up: add KAGGLE_USERNAME and KAGGLE_API_TOKEN on the Worker (Settings → GPU & engines → Kaggle).");
  const { getPrefs, gpuState } = await import("./gpus");
  const [p, s] = await Promise.all([getPrefs(), gpuState()]);
  if (!p.kaggle_on) throw new Error("Kaggle is switched off in Settings → GPU & engines.");
  if (s.kaggle.online) return { started: false, why: "Kaggle is already on" };
  if (s.kaggle.over && !force) throw new Error(`Kaggle has used ${s.kaggle.used_h} of its ${s.kaggle.cap_h} h this week (resets Monday 00:00 UTC; raise the cap in Settings → GPU & engines).`);
  if (s.kaggle.starting_since && !force) return { started: false, why: `Kaggle is already starting (${Math.round((Date.now() - s.kaggle.starting_since) / 60000)} min ago); it takes 3-6 min` };
  const nonce = randomBytes(12).toString("base64url");
  const t = ticket(nonce, Date.now() + 30 * 60_000);
  await putJson(START, { at: Date.now(), by, nonce } satisfies Start);
  if (p.kaggle_stop_at) (await import("./gpus")).setPrefs({ kaggle_stop: false }).catch(() => {});
  try {
    const r = await kaggle<{ ref?: string; url?: string; versionNumber?: number; error?: string }>("SaveKernel", {
      slug: `${user()}/${SLUG}`, newTitle: SLUG, text: notebook(origin, t), language: "python", kernelType: "notebook",
      isPrivate: true, enableGpu: true, enableTpu: false, enableInternet: true, machineShape: "NvidiaTeslaT4",
      datasetDataSources: [], kernelDataSources: [], competitionDataSources: [], categoryIds: [], modelDataSources: [],
      sessionTimeoutSeconds: 43_200, kernelExecutionType: "SAVE_AND_RUN_ALL",
    });
    if (r.error) throw new Error(r.error);
    await putJson(START, { at: Date.now(), by, nonce, ref: r.ref } satisfies Start);
    return { started: true, run: r.versionNumber ?? null, url: r.url ?? `https://www.kaggle.com/code/${user()}/${SLUG}`,
      next: "Kaggle boots the notebook in 3-6 minutes; it shows online in worker_status once its heartbeat lands." };
  } catch (e) {
    await putJson(START, { at: Date.now(), by, nonce, used: true, error: (e as Error).message } satisfies Start).catch(() => {});
    throw e;
  }
}

/** What Kaggle says about the notebook's latest run. */
export async function kaggleRun() {
  if (!kaggleConfigured()) return null;
  const r = await kaggle<{ status?: string; failureMessage?: string }>("GetKernelSessionStatus", { userName: user(), kernelSlug: SLUG });
  return { status: String(r.status ?? "").toLowerCase().replace(/^kernel_worker_status_/, ""), failure: r.failureMessage ?? null };
}

/** Whether a running Kaggle worker should stop now (its heartbeat answers stop: true and the launcher exits, which
 *  ends the Kaggle session): Stop pressed after it started, idle for kaggle_idle_min, past the week's cap, or near
 *  Kaggle's 12-hour limit with nothing running. */
export async function kaggleShouldStop(rec: Pick<WorkerRecord, "started_at" | "queue" | "running">, lastActive: number): Promise<string | null> {
  const { getPrefs } = await import("./gpus");
  const p = await getPrefs();
  const boot = (rec.started_at ?? 0) * 1000;
  const busy = (rec.queue ?? 0) > 0 || (rec.running ?? 0) > 0;
  if (p.kaggle_stop_at && boot && boot < p.kaggle_stop_at) return "Stop was pressed";
  if (busy) return null;
  const idleSince = Math.max(boot, (lastActive || 0) * 1000);
  if (idleSince && Date.now() - idleSince > p.kaggle_idle_min * 60_000) return `idle for ${p.kaggle_idle_min} min`;
  const u = await usage();
  if (u.seconds / 3600 >= p.kaggle_cap_h) return "the week's hours are used";
  if (boot && Date.now() - boot > MAX_SESSION_MS) return "near Kaggle's 12-hour limit";
  return null;
}
