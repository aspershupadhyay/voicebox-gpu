// The GPUs behind one studio: the Colab worker (started by hand or from the app) and two cloud GPUs that run the same
// worker, sleep until a job wakes them and bill by the second: Modal (modal_app/voicebox_modal.py) and Cerebrium
// (cerebrium_app/). Which one goes first, whether the others take over when it fails, each cloud's monthly cap, and
// which GPU holds each job all live here; lib/worker.ts routes every call through it. Settings → GPU & engines and the
// MCP `gpu` tool (action backend) change the preferences.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getJson, putJson } from "./store";
import { loadWorker, saveWorker, STALE_MS, type Backend, type WorkerRecord } from "./registry";

export type { Backend };
export type Cloud = "modal" | "cerebrium";
export const CLOUDS: Cloud[] = ["modal", "cerebrium"];
/** In fallback order: the free ones first (Colab, then Kaggle), then the cloud GPUs that spend credit. */
export const ALL: Backend[] = ["colab", "kaggle", "modal", "cerebrium"];
export const isCloud = (b: string): b is Cloud => b === "modal" || b === "cerebrium";
export const CLOUD_NAME: Record<Backend, string> = { colab: "Colab", kaggle: "Kaggle", modal: "Modal", cerebrium: "Cerebrium" };

export type GpuPrefs = {
  /** The GPU new work goes to first. */
  prefer: Backend;
  /** When the first one is off or can't be reached, send it to the next (Colab, Modal, Cerebrium, in that order). */
  fallback: boolean;
  /** Modal's address (https://<workspace>--voicebox-worker-gateway.<region>.modal.run), unless MODAL_WORKER_URL is set. */
  modal_url: string;
  /** Hours of Modal GPU a month; past it, Modal takes no new work until the month turns. 0 = Modal off. */
  modal_cap_h: number;
  /** Training, Orpheus drafts and video on the cloud GPUs too (hours of GPU each); off by default, they stay on Colab. */
  modal_heavy: boolean;
  /** When Modal's setup last connected its address (the end of the setup commands). */
  modal_hello_at?: number;
  /** Stop pressed: a Modal container that started before this shuts itself down at its next heartbeat. */
  modal_stop_at?: number;
  /** The same for Cerebrium (https://api.cerebrium.ai/v4/p-<project>/<app>, unless CEREBRIUM_WORKER_URL is set). */
  cerebrium_url: string;
  cerebrium_cap_h: number;
  cerebrium_hello_at?: number;
  cerebrium_stop_at?: number;
  /** Kaggle (lib/kaggle.ts): started by the app when work needs it. Off = never started from here. */
  kaggle_on: boolean;
  /** Hours of Kaggle GPU a week the app may use (Kaggle gives about 30): past it, no new start until Monday. */
  kaggle_cap_h: number;
  /** Idle minutes after which a running Kaggle stops itself, so the weekly hours aren't spent waiting. */
  kaggle_idle_min: number;
  kaggle_stop_at?: number;
};

export const DEFAULT_PREFS: GpuPrefs = { prefer: "colab", fallback: true, modal_url: "", modal_cap_h: 30, modal_heavy: false, cerebrium_url: "", cerebrium_cap_h: 15, kaggle_on: true, kaggle_cap_h: 28, kaggle_idle_min: 15 };
/** A Modal web address: <workspace>--<app>-<function>.modal.run, with a region when the app runs in one
 *  (…gateway.us-east.modal.run): what `modal deploy` prints. */
export const MODAL_URL = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)?\.modal\.run$/;
/** A Cerebrium app: https://api.cerebrium.ai/v4/p-<project id>/<app name> (a regional api.<region>.cerebrium.ai too). */
export const CEREBRIUM_URL = /^https:\/\/api(?:\.[a-z0-9-]+){0,3}\.cerebrium\.ai\/v4\/p-[a-z0-9]{4,40}\/[a-z0-9][a-z0-9-]{0,62}$/;
export const URL_RE: Record<Cloud, RegExp> = { modal: MODAL_URL, cerebrium: CEREBRIUM_URL };
const URL_HINT: Record<Cloud, string> = {
  modal: "the Modal address is the one modal deploy prints, like https://<workspace>--voicebox-worker-gateway.us-east.modal.run",
  cerebrium: "the Cerebrium address looks like https://api.cerebrium.ai/v4/p-xxxxxxxx/voicebox-worker",
};
/** Jobs that hold a GPU for an hour or more. */
export const HEAVY = new Set(["train", "eagle", "video"]);

const PREFS = "voicebox/gpu-prefs.json";
const USAGE: Record<Cloud, string> = { modal: "voicebox/modal-usage.json", cerebrium: "voicebox/cerebrium-usage.json" };
/** The GPUs whose jobs are remembered by id (every other job id is Colab's). */
export type Tracked = Cloud | "kaggle";
const JOBS: Record<Tracked, string> = { modal: "voicebox/modal-jobs.json", cerebrium: "voicebox/cerebrium-jobs.json", kaggle: "voicebox/kaggle-jobs.json" };

let prefsCache: { at: number; v: GpuPrefs } | null = null;
export async function getPrefs(): Promise<GpuPrefs> {
  if (prefsCache && Date.now() - prefsCache.at < 4000) return prefsCache.v;
  const v = { ...DEFAULT_PREFS, ...((await getJson<Partial<GpuPrefs>>(PREFS).catch(() => null)) ?? {}) };
  prefsCache = { at: Date.now(), v };
  return v;
}

/** Validate and merge a change; unknown keys and bad values are dropped. `hello` and `stop` act on `cloud` (default Modal). */
export async function setPrefs(patch: Record<string, unknown>): Promise<GpuPrefs> {
  const next = { ...(await getPrefs()) };
  if (typeof patch.prefer === "string" && (ALL as string[]).includes(patch.prefer)) next.prefer = patch.prefer as Backend;
  if (typeof patch.fallback === "boolean") next.fallback = patch.fallback;
  if (typeof patch.modal_heavy === "boolean") next.modal_heavy = patch.modal_heavy;
  if (typeof patch.kaggle_on === "boolean") next.kaggle_on = patch.kaggle_on;
  if (typeof patch.kaggle_cap_h === "number" && isFinite(patch.kaggle_cap_h)) next.kaggle_cap_h = Math.max(0, Math.min(60, Math.round(patch.kaggle_cap_h)));
  if (typeof patch.kaggle_idle_min === "number" && isFinite(patch.kaggle_idle_min)) next.kaggle_idle_min = Math.max(5, Math.min(240, Math.round(patch.kaggle_idle_min)));
  if (patch.kaggle_stop === true) next.kaggle_stop_at = Date.now();
  if (patch.kaggle_stop === false) delete next.kaggle_stop_at;
  for (const c of CLOUDS) {
    const cap = patch[`${c}_cap_h`];
    if (typeof cap === "number" && isFinite(cap)) next[`${c}_cap_h`] = Math.max(0, Math.min(500, Math.round(cap)));
    const url = patch[`${c}_url`];
    if (typeof url === "string") {
      const u = url.trim().replace(/\/+$/, "");
      if (u && !URL_RE[c].test(u)) throw new Error(URL_HINT[c]);
      next[`${c}_url`] = u;
    }
  }
  const cloud: Cloud = patch.cloud === "cerebrium" ? "cerebrium" : "modal";
  if (patch.hello === true) next[`${cloud}_hello_at`] = Date.now();
  if (patch.stop === true) next[`${cloud}_stop_at`] = Date.now();
  if (patch.stop === false) delete next[`${cloud}_stop_at`];
  await putJson(PREFS, next);
  prefsCache = { at: Date.now(), v: next };
  return next;
}

export const cloudUrl = (p: GpuPrefs, c: Cloud) =>
  ((c === "modal" ? process.env.MODAL_WORKER_URL : process.env.CEREBRIUM_WORKER_URL) || p[`${c}_url`] || "").replace(/\/+$/, "");
export const modalUrl = (p: GpuPrefs) => cloudUrl(p, "modal");

type Usage = { month: string; seconds: number; boot?: number; seen?: number };
const month = () => new Date().toISOString().slice(0, 7);

export async function cloudUsage(c: Cloud): Promise<Usage> {
  const u = await getJson<Usage>(USAGE[c]).catch(() => null);
  return u && u.month === month() ? u : { month: month(), seconds: 0 };
}
export const modalUsage = () => cloudUsage("modal");

/** A cloud GPU's heartbeat: the container is awake and billing, so its time since the last heartbeat counts (at most
 *  two minutes, so a missed beat never counts a sleep). */
export async function countCloud(c: Cloud, startedAt: number) {
  const u = await cloudUsage(c);
  const now = Date.now();
  const boot = Math.round(startedAt * 1000);
  const from = u.boot === boot && u.seen ? u.seen : boot || now;
  u.seconds += Math.max(0, Math.min(120, (now - from) / 1000));
  await putJson(USAGE[c], { ...u, boot, seen: now });
}
export const countModal = (startedAt: number) => countCloud("modal", startedAt);

// Which jobs each cloud GPU holds: every other job id is Colab's. Kept small: the last 300, a day each.
type JobMap = Record<string, number>;
const jobsCache: Partial<Record<Tracked, { at: number; v: JobMap }>> = {};
async function jobMap(c: Tracked): Promise<JobMap> {
  const k = jobsCache[c];
  if (k && Date.now() - k.at < 3000) return k.v;
  const v = (await getJson<JobMap>(JOBS[c]).catch(() => null)) ?? {};
  jobsCache[c] = { at: Date.now(), v };
  return v;
}
export async function rememberJob(c: Tracked, id: string) {
  const m = { ...(await getJson<JobMap>(JOBS[c]).catch(() => null)) ?? {} };
  m[id] = Date.now();
  const keep = Object.entries(m).filter(([, t]) => Date.now() - t < 86_400_000).sort((a, b) => b[1] - a[1]).slice(0, 300);
  const v = Object.fromEntries(keep);
  await putJson(JOBS[c], v);
  jobsCache[c] = { at: Date.now(), v };
}
export const rememberModalJob = (id: string) => rememberJob("modal", id);
/** Whether a cloud GPU took a job in the last `ms` (the job list asks it only then, or while its heartbeat says it's busy). */
export async function recentJob(c: Tracked, ms: number) {
  return Object.values(await jobMap(c)).some((t) => Date.now() - t < ms);
}
export async function jobBackend(id: string): Promise<Backend> {
  for (const c of [...CLOUDS, "kaggle"] as Tracked[]) if ((await jobMap(c))[id]) return c;
  return "colab";
}

export type CloudState = { url: string; rec: WorkerRecord | null; configured: boolean; awake: boolean; used_h: number; cap_h: number; over: boolean; available: boolean };
export type KaggleState = { rec: WorkerRecord | null; online: boolean; configured: boolean; used_h: number; cap_h: number; over: boolean; starting_since: number | null };
export type GpuState = { prefs: GpuPrefs; colab: { rec: WorkerRecord | null; online: boolean }; kaggle: KaggleState } & Record<Cloud, CloudState>;

export async function gpuState(): Promise<GpuState> {
  const kag = import("./kaggle").then((k) => k.kaggleState());
  const [prefs, colab, ...rest] = await Promise.all([getPrefs(), loadWorker("colab").catch(() => null),
    ...CLOUDS.map((c) => loadWorker(c).catch(() => null)), ...CLOUDS.map((c) => cloudUsage(c))]);
  const p = prefs as GpuPrefs;
  const clouds = Object.fromEntries(CLOUDS.map((c, i) => {
    const rec = rest[i] as WorkerRecord | null, usage = rest[CLOUDS.length + i] as Usage;
    const url = cloudUrl(p, c);
    const used_h = Math.round((usage.seconds / 3600) * 10) / 10;
    const cap_h = p[`${c}_cap_h`];
    const over = used_h >= cap_h;
    const awake = !!url && !!rec && rec.url === url && Date.now() - rec.last_seen < STALE_MS;
    return [c, { url, rec, configured: !!url, awake, used_h, cap_h, over, available: !!url && !over }];
  })) as Record<Cloud, CloudState>;
  const c = colab as WorkerRecord | null;
  return { prefs: p, colab: { rec: c, online: !!c && Date.now() - c.last_seen < STALE_MS }, kaggle: await kag.then((k) => k(p)), ...clouds };
}

/** Stop a cloud GPU now: its container shuts down at its next heartbeat (within a minute), and it shows asleep at once. */
export async function stopCloud(c: Cloud) {
  await setPrefs({ stop: true, cloud: c });
  const rec = await loadWorker(c).catch(() => null);
  if (rec) await saveWorker({ ...rec, last_seen: 0 }, c);
}
export const stopModal = () => stopCloud("modal");
/** Whether a heartbeat from a container that booted at startedAt (seconds) should shut down: Stop was pressed after. */
export async function shouldStop(startedAt: number, c: Cloud = "modal") {
  const at = (await getPrefs())[`${c}_stop_at`];
  return !!at && startedAt * 1000 < at;
}

/** The GPUs to try for new work, in order: the preferred one, then (with fallback) the rest as Colab, Modal, Cerebrium. */
export function order(s: GpuState, kind?: string): Backend[] {
  const first = s.prefs.prefer;
  const all = ALL.filter((b) => b !== "kaggle" || s.kaggle.configured);
  let list: Backend[] = s.prefs.fallback ? [first, ...all.filter((b) => b !== first)] : [first];
  // two free GPUs on at once (Colab and Kaggle): a new job goes to the less busy one, so a batch runs side by side
  // instead of queueing on the first. Only GPUs already on are reordered; nothing is started for it.
  if (kind && s.prefs.fallback) {
    const load = (b: Backend) => { const r = b === "colab" ? s.colab.rec : b === "kaggle" ? s.kaggle.rec : null; return (r?.queue ?? 0) + (r?.running ?? 0); };
    const on = list.filter((b) => (b === "colab" && s.colab.online) || (b === "kaggle" && s.kaggle.online));
    if (on.length > 1) list = [...[...on].sort((x, y) => load(x) - load(y)), ...list.filter((b) => !on.includes(b))];
  }
  return kind && HEAVY.has(kind) && !s.prefs.modal_heavy ? list.filter((b) => !isCloud(b)) : list;
}

/** The GPUs in a few words, for status answers (the dashboard and worker_status). */
export function describe(s: GpuState) {
  const cloud = (c: Cloud) => ({ configured: s[c].configured, awake: s[c].awake, available: s[c].available, used_h: s[c].used_h, cap_h: s[c].cap_h,
    over_cap: s[c].over, gpu: s[c].rec?.gpu?.name ?? null, connected_at: s.prefs[`${c}_hello_at`] ?? null,
    url_from: (c === "modal" ? process.env.MODAL_WORKER_URL : process.env.CEREBRIUM_WORKER_URL) ? "env" : s[c].url ? "settings" : null });
  return {
    prefer: s.prefs.prefer, fallback: s.prefs.fallback, modal_heavy: s.prefs.modal_heavy,
    colab: { online: s.colab.online, last_seen: s.colab.rec?.last_seen ?? null, gpu: s.colab.rec?.gpu?.name ?? null },
    kaggle: { configured: s.kaggle.configured, on: s.prefs.kaggle_on, online: s.kaggle.online, starting: !!s.kaggle.starting_since && !s.kaggle.online,
      used_h_this_week: s.kaggle.used_h, cap_h: s.kaggle.cap_h, over_cap: s.kaggle.over, idle_stop_min: s.prefs.kaggle_idle_min, gpu: s.kaggle.rec?.gpu?.name ?? null },
    modal: cloud("modal"), cerebrium: cloud("cerebrium"),
  };
}

// Modal's own key: what the Modal worker uses where Colab uses WORKER_SECRET (the gateway's password, the heartbeat,
// the bundle, its settings and its weight cache), so setting Modal up never needs WORKER_SECRET. Made in Settings → GPU &
// engines → Set up Modal (shown once, inside the commands to paste); making a new one replaces the old. Kept in R2
// sealed with AES-256-GCM under a key derived from WORKER_SECRET.
const KEYFILE = "voicebox/modal-key.json";
const boxKey = () => createHash("sha256").update(`voicebox-modal-key-v1:${process.env.WORKER_SECRET ?? ""}:${process.env.MCP_TOKEN ?? ""}`).digest();
export function seal(s: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", boxKey(), iv);
  const body = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}
export function unseal(e: string): string | null {
  try {
    const b = Buffer.from(e, "base64");
    const d = createDecipheriv("aes-256-gcm", boxKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch { return null; }
}
let keyCache: { at: number; v: string | null } | null = null;
/** The Modal key, or null when none was made. */
export async function modalKey(): Promise<string | null> {
  if (keyCache && Date.now() - keyCache.at < 10_000) return keyCache.v;
  const f = await getJson<{ enc: string }>(KEYFILE).catch(() => null);
  const v = f ? unseal(f.enc) : null;
  keyCache = { at: Date.now(), v };
  return v;
}
export async function newModalKey(by: string) {
  const key = `vbmd_${randomBytes(30).toString("base64url")}`;
  await putJson(KEYFILE, { enc: seal(key), at: Date.now(), by });
  keyCache = { at: Date.now(), v: key };
  return key;
}
/** The password the dashboard sends a GPU: the cloud key once one was made (Modal and Cerebrium share it; else
 *  WORKER_SECRET, for one set up by hand). */
export async function authFor(b: Backend) {
  return (isCloud(b) && (await modalKey())) || process.env.WORKER_SECRET || "";
}

/** Who a worker request comes from: Colab (or any worker) with WORKER_SECRET, Modal with its own key, or nobody. */
export async function workerCaller(req: Request): Promise<"worker" | "modal" | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = process.env.WORKER_SECRET ?? "";
  if (!token) return null;
  if (secret.length >= 24 && eq(token, secret)) return "worker";
  const k = await modalKey();
  return k && eq(token, k) ? "modal" : null;
}
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The commands that set a cloud GPU up, with the cloud key in them (one paste, in a terminal on any Mac or Linux
 *  machine). Cerebrium: its CLI, the app's three files from the studio, the key in voicebox.env (deployed with the app:
 *  Cerebrium has no secrets command), deploy, and connect (the address is read from what the deploy printed). */
export function setupCommands(key: string, origin: string, cloud: Cloud = "modal") {
  if (cloud === "cerebrium") {
    const get = (f: string) => `curl -fsSL -H "Authorization: Bearer ${key}" "${origin}/api/modal/app?f=${f}" -o ${f}`;
    return [
      // the pip package downloads the real CLI with Python: on the python.org Python for a Mac that fails
      // (CERTIFICATE_VERIFY_FAILED) unless Python is pointed at certifi's certificates first
      'python3 -m pip install -q --upgrade cerebrium certifi && export SSL_CERT_FILE="$(python3 -m certifi)" && cerebrium login',
      `mkdir -p voicebox-cerebrium && cd voicebox-cerebrium && ${get("cerebrium.toml")} && ${get("voicebox_cerebrium.py")}`,
      `printf 'WORKER_SECRET=${key}\\nREGISTER_URL=${origin}/api/register\\n' > voicebox.env`,
      `cerebrium deploy -y 2>&1 | tee deploy.log; python3 voicebox_cerebrium.py connect ${key} ${origin} deploy.log`,
    ];
  }
  return [
    "python3 -m pip install -q --upgrade modal && python3 -m modal setup",
    `curl -fsSL -H "Authorization: Bearer ${key}" ${origin}/api/modal/app -o voicebox_modal.py`,
    `python3 -m modal secret create voicebox WORKER_SECRET=${key} REGISTER_URL=${origin}/api/register --force`,
    // the key and the studio at deploy bake the worker code into the image, so a start never depends on the studio
    `VOICEBOX_KEY=${key} VOICEBOX_STUDIO=${origin} python3 -m modal deploy voicebox_modal.py && python3 voicebox_modal.py ${key} ${origin}`,
  ];
}
