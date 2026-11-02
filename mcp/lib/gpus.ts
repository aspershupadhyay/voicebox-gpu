// Two GPUs behind one studio: the Colab worker (started by hand or from the app) and a Modal one (modal/voicebox_modal.py)
// that sleeps until a job wakes it and bills by the second. Which one goes first, whether the other takes over when it
// fails, Modal's monthly cap, and which GPU holds each job all live here; lib/worker.ts routes every call through it.
// Settings → GPU & engines and the MCP `gpu` tool (action backend) change the preferences.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getJson, putJson } from "./store";
import { loadWorker, STALE_MS, type Backend, type WorkerRecord } from "./registry";

export type { Backend };
export type GpuPrefs = {
  /** The GPU new work goes to first. */
  prefer: Backend;
  /** When the first one is off or can't be reached, send it to the other. */
  fallback: boolean;
  /** Modal's address (https://<workspace>--voicebox-worker-gateway.modal.run), unless MODAL_WORKER_URL is set. */
  modal_url: string;
  /** Hours of Modal GPU a month; past it, Modal takes no new work until the month turns. 0 = Modal off. */
  modal_cap_h: number;
  /** Training, Orpheus drafts and video on Modal too (hours of GPU each); off by default, they stay on Colab. */
  modal_heavy: boolean;
  /** When Modal's setup last connected its address (the end of the setup commands). */
  modal_hello_at?: number;
};

export const DEFAULT_PREFS: GpuPrefs = { prefer: "colab", fallback: true, modal_url: "", modal_cap_h: 30, modal_heavy: false };
/** A Modal web address: <workspace>--<app>-<function>.modal.run, with a region when the app runs in one
 *  (…gateway.us-east.modal.run): what `modal deploy` prints. */
export const MODAL_URL = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)?\.modal\.run$/;
/** Jobs that hold a GPU for an hour or more. */
export const HEAVY = new Set(["train", "eagle", "video"]);

const PREFS = "voicebox/gpu-prefs.json";
const USAGE = "voicebox/modal-usage.json";
const JOBS = "voicebox/modal-jobs.json";

let prefsCache: { at: number; v: GpuPrefs } | null = null;
export async function getPrefs(): Promise<GpuPrefs> {
  if (prefsCache && Date.now() - prefsCache.at < 4000) return prefsCache.v;
  const v = { ...DEFAULT_PREFS, ...((await getJson<Partial<GpuPrefs>>(PREFS).catch(() => null)) ?? {}) };
  prefsCache = { at: Date.now(), v };
  return v;
}

/** Validate and merge a change; unknown keys and bad values are dropped. */
export async function setPrefs(patch: Record<string, unknown>): Promise<GpuPrefs> {
  const next = { ...(await getPrefs()) };
  if (patch.prefer === "colab" || patch.prefer === "modal") next.prefer = patch.prefer;
  if (typeof patch.fallback === "boolean") next.fallback = patch.fallback;
  if (typeof patch.modal_heavy === "boolean") next.modal_heavy = patch.modal_heavy;
  if (typeof patch.modal_cap_h === "number" && isFinite(patch.modal_cap_h)) next.modal_cap_h = Math.max(0, Math.min(500, Math.round(patch.modal_cap_h)));
  if (typeof patch.modal_url === "string") {
    const u = patch.modal_url.trim().replace(/\/+$/, "");
    if (u && !MODAL_URL.test(u)) throw new Error("the Modal address is the one modal deploy prints, like https://<workspace>--voicebox-worker-gateway.us-east.modal.run");
    next.modal_url = u;
  }
  if (patch.hello === true) next.modal_hello_at = Date.now();
  await putJson(PREFS, next);
  prefsCache = { at: Date.now(), v: next };
  return next;
}

export const modalUrl = (p: GpuPrefs) => (process.env.MODAL_WORKER_URL || p.modal_url || "").replace(/\/+$/, "");

type Usage = { month: string; seconds: number; boot?: number; seen?: number };
const month = () => new Date().toISOString().slice(0, 7);

export async function modalUsage(): Promise<Usage> {
  const u = await getJson<Usage>(USAGE).catch(() => null);
  return u && u.month === month() ? u : { month: month(), seconds: 0 };
}

/** A Modal heartbeat: the container is awake and billing, so its time since the last heartbeat counts (at most two
 *  minutes, so a missed beat never counts a sleep). */
export async function countModal(startedAt: number) {
  const u = await modalUsage();
  const now = Date.now();
  const boot = Math.round(startedAt * 1000);
  const from = u.boot === boot && u.seen ? u.seen : boot || now;
  u.seconds += Math.max(0, Math.min(120, (now - from) / 1000));
  await putJson(USAGE, { ...u, boot, seen: now });
}

// Which jobs Modal holds: every other job id is Colab's. Kept small: the last 300, a day each.
type JobMap = Record<string, number>;
let jobsCache: { at: number; v: JobMap } | null = null;
async function jobMap(): Promise<JobMap> {
  if (jobsCache && Date.now() - jobsCache.at < 3000) return jobsCache.v;
  const v = (await getJson<JobMap>(JOBS).catch(() => null)) ?? {};
  jobsCache = { at: Date.now(), v };
  return v;
}
export async function rememberModalJob(id: string) {
  const m = { ...(await getJson<JobMap>(JOBS).catch(() => null)) ?? {} };
  m[id] = Date.now();
  const keep = Object.entries(m).filter(([, t]) => Date.now() - t < 86_400_000).sort((a, b) => b[1] - a[1]).slice(0, 300);
  const v = Object.fromEntries(keep);
  await putJson(JOBS, v);
  jobsCache = { at: Date.now(), v };
}
export async function jobBackend(id: string): Promise<Backend> {
  return (await jobMap())[id] ? "modal" : "colab";
}

export type GpuState = {
  prefs: GpuPrefs;
  colab: { rec: WorkerRecord | null; online: boolean };
  modal: { url: string; rec: WorkerRecord | null; configured: boolean; awake: boolean; used_h: number; cap_h: number; over: boolean; available: boolean };
};

export async function gpuState(): Promise<GpuState> {
  const [prefs, colab, modal, usage] = await Promise.all([getPrefs(), loadWorker("colab").catch(() => null), loadWorker("modal").catch(() => null), modalUsage()]);
  const url = modalUrl(prefs);
  const used_h = Math.round((usage.seconds / 3600) * 10) / 10;
  const over = used_h >= prefs.modal_cap_h;
  const awake = !!url && !!modal && modal.url === url && Date.now() - modal.last_seen < STALE_MS;
  return {
    prefs,
    colab: { rec: colab, online: !!colab && Date.now() - colab.last_seen < STALE_MS },
    modal: { url, rec: modal, configured: !!url, awake, used_h, cap_h: prefs.modal_cap_h, over, available: !!url && !over },
  };
}

/** The GPUs to try for new work, in order. */
export function order(s: GpuState, kind?: string): Backend[] {
  const first = s.prefs.prefer;
  const list: Backend[] = s.prefs.fallback ? [first, first === "colab" ? "modal" : "colab"] : [first];
  return kind && HEAVY.has(kind) && !s.prefs.modal_heavy ? list.filter((b) => b !== "modal") : list;
}

/** The two GPUs in a few words, for status answers (the dashboard and worker_status). */
export function describe(s: GpuState) {
  return {
    prefer: s.prefs.prefer, fallback: s.prefs.fallback, modal_heavy: s.prefs.modal_heavy,
    colab: { online: s.colab.online, last_seen: s.colab.rec?.last_seen ?? null, gpu: s.colab.rec?.gpu?.name ?? null },
    modal: { configured: s.modal.configured, awake: s.modal.awake, available: s.modal.available, used_h: s.modal.used_h, cap_h: s.modal.cap_h,
      over_cap: s.modal.over, gpu: s.modal.rec?.gpu?.name ?? null, connected_at: s.prefs.modal_hello_at ?? null, url_from: process.env.MODAL_WORKER_URL ? "env" : s.modal.url ? "settings" : null },
  };
}

// Modal's own key: what the Modal worker uses where Colab uses WORKER_SECRET (the gateway's password, the heartbeat,
// the bundle, its settings and its weight cache), so setting Modal up never needs WORKER_SECRET. Made in Settings → GPU &
// engines → Set up Modal (shown once, inside the commands to paste); making a new one replaces the old. Kept in R2
// sealed with AES-256-GCM under a key derived from WORKER_SECRET.
const KEYFILE = "voicebox/modal-key.json";
const boxKey = () => createHash("sha256").update(`voicebox-modal-key-v1:${process.env.WORKER_SECRET ?? ""}:${process.env.MCP_TOKEN ?? ""}`).digest();
function seal(s: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", boxKey(), iv);
  const body = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}
function unseal(e: string): string | null {
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
/** The password the dashboard sends a GPU: Modal's own key once one was made (else WORKER_SECRET, for a Modal set up by hand). */
export async function authFor(b: Backend) {
  return (b === "modal" && (await modalKey())) || process.env.WORKER_SECRET || "";
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

/** The commands that set Modal up, with a fresh key in them (one paste, in a terminal on any Mac or Linux machine). */
export function setupCommands(key: string, origin: string) {
  return [
    "python3 -m pip install -q --upgrade modal && python3 -m modal setup",
    `curl -fsSL -H "Authorization: Bearer ${key}" ${origin}/api/modal/app -o voicebox_modal.py`,
    `python3 -m modal secret create voicebox WORKER_SECRET=${key} REGISTER_URL=${origin}/api/register --force`,
    // the key and the studio at deploy bake the worker code into the image, so a start never depends on the studio
    `VOICEBOX_KEY=${key} VOICEBOX_STUDIO=${origin} python3 -m modal deploy voicebox_modal.py && python3 voicebox_modal.py ${key} ${origin}`,
  ];
}
