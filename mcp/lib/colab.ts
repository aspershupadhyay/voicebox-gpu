// The GPU from the app: start a Colab runtime, launch the worker on it, stop it, and read the compute-unit balance,
// without opening Colab. Same backend and same Google sign-in as Google's official Colab CLI (google-colab-cli):
//   - sign-in: Google OAuth (the CLI's client, COLAB_OAUTH_CLIENT_ID / _SECRET), the copy-paste code flow with PKCE;
//     the refresh token is kept encrypted in R2 (colab/token.enc), keyed from COLAB_TOKEN_KEY or WORKER_SECRET;
//   - runtimes: colab.research.google.com/tun/m (assign, assignments, unassign, ccu-info);
//   - the worker: a Jupyter kernel on the runtime (its proxy URL + token) runs the notebook's own start cells, so the
//     worker heartbeats this dashboard exactly as if the notebook had been run. The busy kernel keeps the VM alive.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { loadWorker } from "./registry";
import { delObjs, getJson, getObj, putJson, putObj } from "./store";

const COLAB = "https://colab.research.google.com";
const REDIRECT = "https://sdk.cloud.google.com/applicationdefaultauthcode.html"; // registered to the CLI's client
const SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/colaboratory", "https://www.googleapis.com/auth/drive.file"];
const TOKEN = "colab/token.enc";
const PENDING = "colab/pending.json";
const SESSION = "colab/session.json";
const CONFIG = "colab/config.json";
export const GPUS = ["A100", "L4", "H100", "T4", "G4"] as const;
export type Gpu = (typeof GPUS)[number];

export type Purpose = "voice" | "heavy";
// voice_gpu / heavy_gpu: what Start picks for voiceovers vs training and video; rates: the units an hour Colab really
// charged, measured per runtime kind ("A100", "A100 high RAM") while it ran alone, so the choice rests on real prices.
export type ColabConfig = { gpu: Gpu; idle_stop_min: number; ntfy_topic: string | null; remind_hours: number; low_units: number;
  high_ram: boolean; voice_gpu: Gpu; heavy_gpu: Gpu; rates: Record<string, number> };
// L4 comes in one shape (it already has 53 GB of RAM); the others take shape=hm for the high-RAM machine
/** Rates are keyed by what Colab actually assigned (its machineShape), so no GPU's shapes are assumed here. */
export const rateKey = (gpu: string, highRam: boolean) => `${gpu}${highRam ? " high RAM" : ""}`;
export type ColabSession = { endpoint: string; gpu: string; started: number; by: "app" | "notebook"; worker_started?: number; notified_hours?: number;
  high_ram?: boolean; purpose?: Purpose | null; for_downloads?: boolean;
  last_active?: number; stopped?: number; stop_reason?: string; low_warned?: boolean; usage?: Usage | null };
export type Usage = { balance: number; rate: number; assignments: number; at: number };

const client = () => {
  const id = process.env.COLAB_OAUTH_CLIENT_ID, secret = process.env.COLAB_OAUTH_CLIENT_SECRET;
  if (!id || !secret) throw new Error("COLAB_OAUTH_CLIENT_ID / COLAB_OAUTH_CLIENT_SECRET aren't set on the server");
  return { id, secret };
};
const key = () => createHash("sha256").update(`colab-token:${process.env.COLAB_TOKEN_KEY || process.env.WORKER_SECRET || ""}`).digest();
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function seal(obj: unknown) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
function open<T>(buf: Buffer): T {
  const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}

// ── sign-in ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Step 1: the Google sign-in link. Google then shows a code to paste back into the app (step 2). */
export async function authUrl() {
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(12));
  await putJson(PENDING, { verifier, state, at: Date.now() });
  const q = new URLSearchParams({ client_id: client().id, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", token_usage: "remote", state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" });
  return `https://accounts.google.com/o/oauth2/auth?${q}`;
}

/** Step 2: the pasted code -> a refresh token, stored encrypted. */
export async function connect(code: string) {
  const p = await getJson<{ verifier: string; at: number }>(PENDING).catch(() => null);
  if (!p || Date.now() - p.at > 15 * 60_000) throw new Error("the sign-in link expired: press Connect again");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: code.trim(), client_id: client().id, client_secret: client().secret, redirect_uri: REDIRECT,
      grant_type: "authorization_code", code_verifier: p.verifier }) });
  const t = await r.json() as { refresh_token?: string; access_token?: string; error?: string; error_description?: string };
  if (!r.ok || !t.refresh_token) throw new Error(`Google refused the code: ${t.error_description || t.error || r.status}`);
  const who = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })
    .then((x) => x.json()).catch(() => ({})) as { email?: string };
  await putObj(TOKEN, seal({ refresh_token: t.refresh_token, email: who.email ?? null, at: Date.now() }), "application/octet-stream");
  await delObjs([PENDING]);
  cached = null;
  return { email: who.email ?? null };
}

export async function disconnect() {
  await delObjs([TOKEN]);
  cached = null;
}

async function stored() {
  const r = await getObj(TOKEN);
  if (!r) return null;
  return open<{ refresh_token: string; email: string | null; at: number }>(Buffer.from(await r.arrayBuffer()));
}

let cached: { token: string; until: number } | null = null;
async function accessToken() {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const s = await stored();
  if (!s) throw new Error("Colab isn't connected: Health → GPU → Connect Colab");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: s.refresh_token, client_id: client().id, client_secret: client().secret, grant_type: "refresh_token" }) });
  const t = await r.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!r.ok || !t.access_token) throw new Error(t.error === "invalid_grant" ? "the Colab sign-in expired or was revoked: connect again" : `Google token refresh failed (${t.error ?? r.status})`);
  cached = { token: t.access_token, until: Date.now() + (t.expires_in ?? 3600) * 1000 };
  return cached.token;
}

// ── the Colab backend ──────────────────────────────────────────────────────────────────────────────────────────

async function tun<T>(path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<T> {
  const u = new URL(`${COLAB}/tun/m${path}`);
  u.searchParams.set("authuser", "0");
  const r = await fetch(u, { method: init.method ?? "GET", cache: "no-store", signal: AbortSignal.timeout(45_000),
    headers: { Accept: "application/json", "X-Colab-Client-Agent": "colab-cli", Authorization: `Bearer ${await accessToken()}`, ...(init.headers ?? {}) } });
  const text = (await r.text()).replace(/^\)\]\}'\n/, "");
  if (!r.ok) {
    const hint = r.status === 412 ? "too many runtimes are assigned already (stop one first)"
      : r.status === 503 ? "no GPU of that type is free right now: try another (L4 is usually available)"
      : r.status === 403 ? "this Google account can't use that GPU (check your Colab plan)"
      : /^\s*</.test(text) ? (r.status === 400 ? "Colab doesn't offer that GPU and memory combination on this account" : `Colab answered with an error page (${text.match(/<title>([^<]*)/i)?.[1]?.trim() ?? "no details"})`)
      : text.slice(0, 200);
    throw Object.assign(new Error(`Colab ${r.status}: ${hint}`), { status: r.status });
  }
  return (text ? JSON.parse(text) : {}) as T;
}

type Proxy = { url: string; token: string; tokenExpiresInSeconds: number };
type Listed = { accelerator: string; endpoint: string; variant: number; machineShape: number; runtimeProxyInfo: Proxy };

export async function usage(): Promise<Usage> {
  const c = await tun<{ currentBalance: number; consumptionRateHourly: number; assignmentsCount: number }>("/ccu-info");
  return { balance: Math.round(c.currentBalance * 100) / 100, rate: Math.round(c.consumptionRateHourly * 100) / 100, assignments: c.assignmentsCount, at: Date.now() };
}

export async function runtimes() {
  const r = await tun<{ assignments?: Listed[] }>("/assignments");
  return (r.assignments ?? []).map((a) => ({ endpoint: a.endpoint, accelerator: a.accelerator, high_ram: a.machineShape === 1 }));
}

export async function stopRuntime(endpoint: string, reason = "stopped from the app") {
  const t = await tun<{ token: string }>(`/unassign/${encodeURIComponent(endpoint)}`);
  await tun(`/unassign/${encodeURIComponent(endpoint)}`, { method: "POST", headers: { "X-Goog-Colab-Token": t.token } });
  const s = await getSession();
  if (s?.endpoint === endpoint) {
    await putJson(SESSION, { ...s, stopped: Date.now(), stop_reason: reason });
    // its worker is gone with it: offline now, not after its last heartbeat goes stale (a download would wait on it)
    const { loadWorker: load, saveWorker, STALE_MS } = await import("./registry");
    const rec = await load().catch(() => null);
    if (rec && (rec.started_at ?? 0) * 1000 >= s.started - 60_000) await saveWorker({ ...rec, last_seen: Date.now() - STALE_MS - 1000 }).catch(() => null);
  }
  return { stopped: endpoint };
}

/** Ask Colab for a GPU runtime (same request as `colab new --gpu X`). */
async function assignOnce(gpu: Gpu, highRam: boolean) {
  const nbh = randomUUID().replace(/-/g, "_").padEnd(44, ".");
  const q = `?nbh=${encodeURIComponent(nbh)}&variant=GPU&accelerator=${gpu}${highRam ? "&shape=hm" : ""}`;
  const first = await tun<{ token?: string; endpoint?: string; runtimeProxyInfo?: Proxy }>(`/assign${q}`);
  if (first.endpoint && first.runtimeProxyInfo) return first as { endpoint: string; runtimeProxyInfo: Proxy };
  if (!first.token) throw new Error("Colab didn't hand out an assignment token");
  const got = await tun<{ endpoint: string; runtimeProxyInfo: Proxy; accelerator: string }>(`/assign${q}`, { method: "POST", headers: { "X-Goog-Colab-Token": first.token } });
  return got;
}

/** A CPU-only runtime (Colab's "None" accelerator), for downloads: yt-dlp needs no GPU and it costs a fraction of
 *  the units. Colab's API has taken it as variant=DEFAULT with no accelerator; accelerator=NONE is tried too. */
async function assignCpu() {
  let last: Error | null = null;
  for (const extra of ["", "&accelerator=NONE"]) {
    try {
      const nbh = randomUUID().replace(/-/g, "_").padEnd(44, ".");
      const q = `?nbh=${encodeURIComponent(nbh)}&variant=DEFAULT${extra}`;
      const first = await tun<{ token?: string; endpoint?: string; runtimeProxyInfo?: Proxy }>(`/assign${q}`);
      if (first.endpoint && first.runtimeProxyInfo) return first as { endpoint: string; runtimeProxyInfo: Proxy };
      if (!first.token) throw new Error("Colab didn't hand out an assignment token");
      return await tun<{ endpoint: string; runtimeProxyInfo: Proxy }>(`/assign${q}`, { method: "POST", headers: { "X-Goog-Colab-Token": first.token } });
    } catch (e) {
      last = e as Error;
      const status = (e as { status?: number }).status;
      if (status === 412 || status === 401) throw e; // too many runtimes / signed out
    }
  }
  throw last ?? new Error("Colab couldn't give a CPU runtime");
}

/** Get exactly the GPU that was picked: with high RAM, or in its standard shape when Colab doesn't offer high RAM
 *  for it (a 400). Never a different GPU: if Colab can't give this one, the error says why. Nothing about which GPU
 *  has which shapes is assumed; Colab's answer decides. */
async function assign(choices: Gpu[], highRam: boolean, deadline: number) {
  const tried: string[] = [];
  let last: Error | null = null;
  for (const gpu of [...new Set(choices)]) {
    for (const hm of highRam ? [true, false] : [false]) {
      if (Date.now() > deadline) break;
      try {
        const a = await assignOnce(gpu, hm);
        return { ...a, gpu, high_ram: hm, tried };
      } catch (e) {
        const status = (e as { status?: number }).status;
        last = e as Error;
        tried.push(`${gpu}${hm ? " high RAM" : ""}: ${last.message.replace(/^Colab /, "")}`);
        if (status === 412 || status === 401) throw e; // too many runtimes / signed out: another GPU won't help
        if (hm && status !== 400) break; // not a shape problem: skip this GPU's standard shape
      }
    }
  }
  throw new Error(tried.length > 1 ? `Colab couldn't give a ${choices[0]}. Tried ${tried.join("; ")}` : last?.message ?? `Colab couldn't give a ${choices[0]}`);
}

/** Python the worker's kernel runs: the notebook's two start cells, with the secrets passed in (no Colab Secrets here). */
function bootstrap(origin: string, prewarm: string, mode = "") {
  // VOICEBOX_MODE=fetch: a downloads-only worker on a CPU runtime (no engines fetched or checked, fetch jobs only)
  const env = { WORKER_SECRET: process.env.WORKER_SECRET ?? "", REGISTER_URL: `${origin}/api/register`, PREWARM: mode ? "" : prewarm, VOICEBOX_STARTED_BY: "app", VOICEBOX_MODE: mode };
  return [
    "import io, json, os, runpy, sys, tarfile, urllib.request",
    `os.environ.update(json.loads(${JSON.stringify(JSON.stringify(env))}))`,
    'APP = "/content/voicebox/app"',
    "os.makedirs(APP, exist_ok=True)",
    'print("voicebox kernel up; fetching the worker", flush=True)',
    'req = urllib.request.Request(os.environ["REGISTER_URL"].rsplit("/api/", 1)[0] + "/api/bundle", headers={"Authorization": "Bearer " + os.environ["WORKER_SECRET"]})',
    "data = urllib.request.urlopen(req, timeout=120).read()",
    'tarfile.open(fileobj=io.BytesIO(data), mode="r:gz").extractall(APP, filter="data")',
    'print("voicebox worker unpacked; starting", flush=True)',
    'sys.argv = ["launcher.py"]',
    'runpy.run_path(APP + "/launcher.py", run_name="__main__")',
  ].join("\n");
}

/** Start a kernel on the runtime and run the worker in it; returns once the kernel is busy with it (it keeps running).
 *  A kernel on a freshly booted VM silently drops messages until its channels are wired up, so (like Google's own
 *  client, jupyter-kernel-client's wait_for_ready) we ask kernel_info once a second until it answers, and only then
 *  send the code. Any sign the kernel is running it counts as started (busy on our request, or its first line). */
export async function launch(proxy: Proxy, code: string, deadline = Date.now() + 45_000) {
  // exactly what Google's client sends (google-colab-cli + jupyter-kernel-client): the proxy token as a header, as a
  // bearer token, and on the websocket as ?token= with a ?session_id=
  const headers = { "X-Colab-Runtime-Proxy-Token": proxy.token, "X-Colab-Client-Agent": "colab-cli", Authorization: `Bearer ${proxy.token}`, "Content-Type": "application/json" };
  const base = proxy.url.replace(/\/$/, "");
  let kernel: { id: string } | null = null;
  for (let i = 0; i < 6 && !kernel && Date.now() < deadline - 15_000; i++) { // a fresh VM takes a few seconds to accept kernels
    const r = await fetch(`${base}/api/kernels`, { method: "POST", headers, body: JSON.stringify({ name: "python3" }), signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (r?.ok) kernel = await r.json();
    else await new Promise((res) => setTimeout(res, 3000));
  }
  if (!kernel) throw new Error("the runtime didn't start a Python kernel");
  const session = randomUUID(), msgId = randomUUID();
  const qs = new URLSearchParams({ session_id: session, token: proxy.token, "colab-runtime-proxy-token": proxy.token });
  const ws = await openSocket(`${base.replace(/^http/, "ws")}/api/kernels/${kernel.id}/channels?${qs}`,
    { "X-Colab-Runtime-Proxy-Token": proxy.token, "X-Colab-Client-Agent": "colab-cli", Authorization: `Bearer ${proxy.token}` });
  // what the connection actually did, so a failure says why instead of guessing
  const diag = { opened: false, frames: 0, types: new Set<string>(), closed: "" as string };
  const msg = (id: string, type: string, content: object) => JSON.stringify({
    header: { msg_id: id, username: "voicebox", session, msg_type: type, version: "5.3", date: new Date().toISOString() },
    parent_header: {}, metadata: {}, channel: "shell", buffers: [], content });
  let ready = false, poke: ReturnType<typeof setInterval> | null = null;
  const out: string[] = [];
  let busy = false; // the kernel has picked up our request: the worker code is running
  const kernelBusy = async () => {
    const r = await fetch(`${base}/api/kernels/${kernel!.id}`, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
    const k = r?.ok ? ((await r.json().catch(() => ({}))) as { execution_state?: string }) : {};
    return k.execution_state === "busy";
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(async () => {
      if (out.length || busy || (await kernelBusy())) resolve();
      else {
        const seen = `websocket ${diag.opened ? "open" : "never opened"}, ${diag.frames} frame${diag.frames === 1 ? "" : "s"} back${diag.types.size ? ` (${[...diag.types].join(", ")})` : ""}${diag.closed ? `, closed ${diag.closed}` : ""}`;
        reject(new Error(ready ? `the kernel took the worker code but never ran it (${seen})` : `the kernel never answered (${seen})`));
      }
    }, Math.max(12_000, deadline - Date.now()));
    ws.on("close", (code, why) => { diag.closed = `${code}${why?.length ? ` ${why.toString().slice(0, 80)}` : ""}`; });
    ws.on("open", () => {
      diag.opened = true;
      const ask = () => { try { ws.send(msg(randomUUID(), "kernel_info_request", {})); } catch { /* retried next tick */ } };
      ask();
      poke = setInterval(ask, 1000);
    });
    ws.on("message", (raw) => {
      let m: { msg_type?: string; header?: { msg_type: string }; parent_header?: { msg_id?: string }; content?: { text?: string; ename?: string; evalue?: string; execution_state?: string } };
      diag.frames++;
      try { m = JSON.parse(raw.toString()); } catch { diag.types.add("binary"); return; }
      const t = m.header?.msg_type ?? m.msg_type;
      if (t) diag.types.add(t);
      if (t === "kernel_info_reply" && !ready) {
        // the kernel is wired up: now the code goes through
        ready = true;
        if (poke) clearInterval(poke);
        ws.send(msg(msgId, "execute_request", { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true }));
        return;
      }
      if (m.parent_header?.msg_id !== msgId) return;
      if (t === "stream" && m.content?.text) out.push(m.content.text);
      if (t === "status" && m.content?.execution_state === "busy") busy = true;
      if (t === "error") { clearTimeout(timer); reject(new Error(`the worker failed to start: ${m.content?.ename}: ${m.content?.evalue}`)); }
      // the bundle is unpacked and the launcher is running: from here it heartbeats the dashboard by itself
      if (out.join("").includes("starting")) { clearTimeout(timer); setTimeout(resolve, 1500); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  }).finally(() => { if (poke) clearInterval(poke); try { ws.close(); } catch { /* the kernel keeps running without us */ } });
  return { kernel: kernel.id, output: out.join("").slice(-1500) };
}

export async function getSession() {
  return getJson<ColabSession>(SESSION).catch(() => null);
}

export async function getConfig(): Promise<ColabConfig> {
  const c = await getJson<Partial<ColabConfig>>(CONFIG).catch(() => null);
  return { gpu: "A100", idle_stop_min: 45, ntfy_topic: null, remind_hours: 1, low_units: 15, high_ram: true, voice_gpu: "L4", heavy_gpu: "A100", rates: {}, ...(c ?? {}) };
}

export async function setConfig(patch: Partial<ColabConfig>) {
  const cur = await getConfig();
  const pick = (g: unknown, d: Gpu) => (GPUS.includes(g as Gpu) ? (g as Gpu) : d);
  const next: ColabConfig = {
    gpu: pick(patch.gpu, cur.gpu),
    voice_gpu: pick(patch.voice_gpu, cur.voice_gpu),
    heavy_gpu: pick(patch.heavy_gpu, cur.heavy_gpu),
    high_ram: typeof patch.high_ram === "boolean" ? patch.high_ram : cur.high_ram,
    rates: cur.rates,
    idle_stop_min: typeof patch.idle_stop_min === "number" ? Math.max(0, Math.min(600, Math.round(patch.idle_stop_min))) : cur.idle_stop_min,
    remind_hours: typeof patch.remind_hours === "number" ? Math.max(0, Math.min(12, patch.remind_hours)) : cur.remind_hours,
    low_units: typeof patch.low_units === "number" ? Math.max(0, Math.min(500, patch.low_units)) : cur.low_units,
    ntfy_topic: patch.ntfy_topic === null ? null : typeof patch.ntfy_topic === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(patch.ntfy_topic) ? patch.ntfy_topic : cur.ntfy_topic,
  };
  await putJson(CONFIG, next);
  return next;
}

/** The dashboard's public address (the worker heartbeats it): APP_URL, else Vercel's production domain. */
export const appOrigin = (fallback?: string) =>
  process.env.APP_URL?.replace(/\/$/, "") || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : fallback ?? "");

/** Start: a GPU runtime + the worker on it. Refuses while a worker is online or a runtime is already assigned.
 *  purpose picks the GPU from settings (voice: voiceovers, an L4 by default; heavy: training and video, an A100); an
 *  explicit gpu wins over both. */
export async function start(origin: string, gpu?: Gpu, opts: { purpose?: Purpose; high_ram?: boolean; for_downloads?: boolean; cpu?: boolean } = {}) {
  const t0 = Date.now(); // the whole start has to fit in the request's 300 s (maxDuration of the dash and MCP routes)
  const cfg = await getConfig();
  const want = gpu && GPUS.includes(gpu) ? gpu : opts.purpose === "voice" ? cfg.voice_gpu : opts.purpose === "heavy" ? cfg.heavy_gpu : cfg.gpu;
  const highRam = typeof opts.high_ram === "boolean" ? opts.high_ram : cfg.high_ram;
  let have = await runtimes();
  const cur = await getSession();
  if (have.length && !opts.for_downloads && cur?.for_downloads && cur.gpu === "CPU" && !cur.stopped && have.every((r) => r.endpoint === cur.endpoint)) {
    // the downloads-only CPU runtime makes way for a real GPU (a download still on it starts again on the new worker)
    await stopRuntime(cur.endpoint, "replaced by a GPU");
    have = [];
  }
  if (have.length) throw new Error(`a runtime is already running (${have.map((r) => r.accelerator).join(", ")}): stop it first, or wait for the worker to come online`);
  // downloads: a CPU runtime, else the cheap GPU. Otherwise only the GPU that was picked: starting a different one
  // (and billing for it) is never our call
  let a: { endpoint: string; runtimeProxyInfo: Proxy; gpu: string; high_ram: boolean };
  let cpuNote: string | undefined;
  if (opts.cpu) {
    try { a = { ...(await assignCpu()), gpu: "CPU", high_ram: false }; } catch (e) {
      cpuNote = `Colab didn't give a CPU runtime (${(e as Error).message.slice(0, 120)}), so the ${want} was started`;
      a = await assign([want], highRam, t0 + 60_000);
    }
  } else a = await assign([want], highRam, t0 + 60_000);
  const s: ColabSession = { endpoint: a.endpoint, gpu: a.gpu, started: Date.now(), by: "app", notified_hours: 0, last_active: Date.now(),
    high_ram: a.high_ram, purpose: opts.purpose ?? null, ...(opts.for_downloads ? { for_downloads: true } : {}) };
  await putJson(SESSION, s);
  try {
    const r = await launch(a.runtimeProxyInfo, bootstrap(appOrigin(origin), process.env.COLAB_PREWARM ?? "", a.gpu === "CPU" ? "fetch" : ""), t0 + 270_000);
    const note = cpuNote ?? (highRam && !a.high_ram ? `${want} has no high-RAM machine on this account, so the standard one was started` : undefined);
    return { ...s, kernel: r.kernel, output: r.output, ...(note ? { note } : {}) };
  } catch (e) {
    // a runtime without a worker only burns units: give it back
    await stopRuntime(a.endpoint, `the worker didn't start: ${(e as Error).message}`).catch(() => null);
    throw e;
  }
}

/** Push to the phone (ntfy app, subscribed to the topic). */
export async function notify(title: string, body: string, tags = "computer") {
  const cfg = await getConfig();
  if (!cfg.ntfy_topic) return false;
  const r = await fetch(`https://ntfy.sh/${cfg.ntfy_topic}`, { method: "POST", body, headers: { Title: title, Tags: tags } }).catch(() => null);
  return !!r?.ok;
}

/** Every worker heartbeat (once a minute): hourly reminders with the real balance, a low-balance warning, and
 *  stopping a runtime the app started once it has sat idle for idle_stop_min. Cheap when nothing is due. */
/** Tell Colab the runtime is in use. An open notebook tab does this by itself; a GPU started from the app has no tab,
 *  so without it Colab treats the runtime as idle and reclaims it mid-job (it did, ~20 min into a training run).
 *  Same request as Google's CLI keep-alive daemon. A read timeout counts as done (Colab logs the activity first). */
export async function keepAlive(endpoint: string) {
  const u = new URL(`${COLAB}/tun/m/${encodeURIComponent(endpoint)}/keep-alive/`);
  u.searchParams.set("authuser", "0");
  const r = await fetch(u, { cache: "no-store", signal: AbortSignal.timeout(10_000),
    headers: { "X-Colab-Tunnel": "Google", "X-Colab-Client-Agent": "colab-cli", Authorization: `Bearer ${await accessToken()}` } })
    .catch((e: Error) => (e.name === "TimeoutError" ? null : Promise.reject(e)));
  if (r && !r.ok) throw new Error(`keep-alive ${r.status}`);
}

/** Colab keeps a runtime on kernel activity it sees through its tunnel; Google's own CLI dropped the keep-alive ping
 *  for exactly that reason (Sept 2026), and a GPU started here was still reclaimed ~20 min into training with the ping.
 *  An open notebook tab is that activity; a GPU started from the app has no tab, so every heartbeat does what a tab
 *  does: lists the kernels and says hello to the worker's kernel over its websocket, through the tunnel. */
export async function touchKernel(endpoint: string) {
  const r = await tun<{ assignments?: Listed[] }>("/assignments");
  const proxy = r.assignments?.find((x) => x.endpoint === endpoint)?.runtimeProxyInfo;
  if (!proxy) return;
  const headers = { "X-Colab-Runtime-Proxy-Token": proxy.token, "X-Colab-Client-Agent": "colab-cli", Authorization: `Bearer ${proxy.token}` };
  const base = proxy.url.replace(/\/$/, "");
  await fetch(`${base}/api/sessions`, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const k = await fetch(`${base}/api/kernels`, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const kernels = k?.ok ? ((await k.json().catch(() => [])) as { id: string }[]) : [];
  if (!kernels.length) return;
  const session = randomUUID();
  const qs = new URLSearchParams({ session_id: session, token: proxy.token, "colab-runtime-proxy-token": proxy.token });
  const ws = await openSocket(`${base.replace(/^http/, "ws")}/api/kernels/${kernels[0].id}/channels?${qs}`, headers).catch(() => null);
  if (!ws) return;
  await new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 6000); // the kernel is busy running the worker: a reply is a bonus, the visit counts
    ws.on("open", () => {
      for (const channel of ["control", "shell"]) {
        ws.send(JSON.stringify({ header: { msg_id: randomUUID(), username: "voicebox", session, msg_type: "kernel_info_request", version: "5.3",
          date: new Date().toISOString() }, parent_header: {}, metadata: {}, channel, buffers: [], content: {} }));
      }
    });
    ws.on("message", () => { clearTimeout(done); resolve(); });
    ws.on("error", () => { clearTimeout(done); resolve(); });
  });
  try { ws.close(); } catch { /* gone already */ }
}


/** A WebSocket client with the `ws` package's shape (on open/message/close/error, send, close). On Cloudflare Workers
 *  `ws` can't open sockets (no node:net), so there it's the runtime's own: a fetch with Upgrade: websocket. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sock = { on(ev: string, f: (...a: any[]) => void): void; send(d: string): void; close(): void };
async function openSocket(url: string, headers: Record<string, string>): Promise<Sock> {
  if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "undefined") {
    const { default: WS } = await import("ws");
    return new WS(url, { headers }) as unknown as Sock;
  }
  const r = await fetch(url.replace(/^ws/, "http"), { headers: { ...headers, Upgrade: "websocket" } });
  const s = (r as Response & { webSocket?: { accept(): void; send(d: string): void; close(): void; addEventListener(t: string, f: (e: { data?: unknown; code?: number; reason?: string }) => void): void } }).webSocket;
  if (!s) throw new Error(`the runtime refused the websocket (${r.status})`);
  s.accept();
  const subs: Record<string, ((...a: unknown[]) => void)[]> = {};
  const emit = (ev: string, ...a: unknown[]) => (subs[ev] ?? []).forEach((f) => f(...a));
  s.addEventListener("message", (e) => emit("message", typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer)));
  s.addEventListener("close", (e) => emit("close", e.code ?? 0, e.reason ?? ""));
  s.addEventListener("error", () => emit("error", new Error("websocket error")));
  setTimeout(() => emit("open"), 0); // accepted = open; the caller adds its listeners first
  return { on: (ev, f) => { (subs[ev] ??= []).push(f as (...a: unknown[]) => void); }, send: (d) => s.send(d), close: () => s.close() };
}

export async function onHeartbeat(hb: { started_at?: number; queue?: number; running?: number; last_active?: number; gpu?: string }) {
  let s = await getSession();
  if (!(await getObj(TOKEN))) return;
  const boot = hb.started_at ? Math.round(hb.started_at * 1000) : 0;
  const fresh = s?.by === "notebook" && boot && s.worker_started && boot - s.worker_started > 3600_000 * 0.25 && !s.stopped; // a new runtime since
  if (((!s || s.stopped) && boot && (!s || boot > (s.stopped ?? s.started))) || fresh) {
    // a worker started from the notebook: remind and show the balance too (auto-stop is only for GPUs started here)
    s = { endpoint: "", gpu: hb.gpu?.replace("NVIDIA ", "").split(/[- ]/)[0] || "GPU", started: boot, by: "notebook", notified_hours: 0, last_active: Date.now(), worker_started: boot };
    await putJson(SESSION, s);
  }
  if (!s || s.stopped) return;
  // keep the runtime from being reclaimed as idle (every heartbeat = once a minute). A notebook-started worker has no
  // endpoint on record: use the only runtime assigned, and remember it.
  if (!s.endpoint) {
    const rs = await runtimes().catch(() => []);
    if (rs.length === 1) { s.endpoint = rs[0].endpoint; await putJson(SESSION, s); }
  }
  if (s.endpoint) {
    await keepAlive(s.endpoint).catch((e) => console.warn("colab keep-alive failed:", (e as Error).message));
    await touchKernel(s.endpoint).catch((e) => console.warn("colab kernel touch failed:", (e as Error).message));
  }
  const cfg = await getConfig();
  const now = Date.now();
  let changed = false;
  if (hb.last_active && hb.last_active * 1000 > (s.last_active ?? 0)) { s.last_active = hb.last_active * 1000; changed = true; }
  if ((hb.queue ?? 0) > 0 || (hb.running ?? 0) > 0) { s.last_active = now; changed = true; }
  const hours = Math.floor((now - s.started) / 3600_000);
  const due = cfg.remind_hours > 0 && hours >= (s.notified_hours ?? 0) + cfg.remind_hours;
  const stale = !s.usage || now - s.usage.at > 5 * 60_000;
  if (due || stale) {
    const u = await usage().catch(() => null);
    if (u) { s.usage = u; changed = true; }
    if (u && u.assignments === 1 && u.rate > 0) await learnRate(u.rate).catch(() => null);
    if (due) {
      s.notified_hours = hours;
      const left = u && u.rate > 0 ? ` · about ${(u.balance / u.rate).toFixed(1)} h left at this rate` : "";
      await notify(`GPU running ${hours} h`, `${s.gpu} on for ${hours} h${u ? ` · ${u.balance} units left (${u.rate}/h)${left}` : ""}. Stop it from Health if you're done.`, "hourglass");
    }
    if (u && cfg.low_units > 0 && u.balance < cfg.low_units && !s.low_warned) {
      s.low_warned = true;
      await notify("Compute units low", `${u.balance} units left on Colab (${u.rate}/h). Top up or stop the GPU.`, "warning");
    }
  }
  // a GPU the Download page started for itself goes as soon as nothing is running and no download is still under way
  if (s.by === "app" && s.endpoint && s.for_downloads && !(hb.queue ?? 0) && !(hb.running ?? 0) && now - s.started > 3 * 60_000
    && !(await import("./downloads").then((d) => d.anyLive()))) {
    await stopRuntime(s.endpoint, "the downloads it was started for are done").catch(() => null);
    await notify("GPU stopped", `${s.gpu} stopped: the downloads it was started for are in Files.`, "zzz");
    return;
  }
  if (s.by === "app" && s.endpoint && cfg.idle_stop_min > 0 && s.last_active && now - s.last_active > cfg.idle_stop_min * 60_000) {
    const mins = Math.round((now - s.last_active) / 60_000);
    await stopRuntime(s.endpoint, `idle for ${mins} min`).catch(() => null);
    await notify("GPU stopped", `${s.gpu} stopped after ${mins} min idle, to save units.`, "zzz");
    return;
  }
  if (changed) await putJson(SESSION, s);
}

/** No heartbeat for this long from a runtime the app started: the worker died with its kernel (a crash, an OOM kill).
 *  Idle auto-stop runs on heartbeats, so a dead worker would bill until Colab reclaims the VM. Boot takes about a
 *  minute and the worker heartbeats every minute, so 20 min of silence is never a slow start. */
export const DEAD_MIN = 20;

/** Stop the app-started runtime if its worker went silent. Runs from the scheduled sweep (/api/cron/sweep) and each
 *  time the GPU card loads; cheap when there is nothing to do (Colab is only asked once the worker looks dead). */
export async function sweep(now = Date.now()) {
  const s = await getSession();
  if (!s || s.stopped || s.by !== "app" || !s.endpoint) return { action: "none", reason: "no runtime started from the app" };
  if (!(await getObj(TOKEN))) return { action: "none", reason: "Colab isn't connected" };
  const rec = await loadWorker().catch(() => null);
  const quiet = Math.round((now - Math.max(s.started, rec?.last_seen ?? 0)) / 60_000); // a record older than the start is the last runtime's
  if (quiet < DEAD_MIN) return { action: "none", reason: `last heard from ${quiet} min ago` };
  if (!(await runtimes()).some((r) => r.endpoint === s.endpoint)) {
    await putJson(SESSION, { ...s, stopped: now, stop_reason: "Colab took the runtime back" });
    return { action: "closed", reason: "Colab had already taken the runtime back" };
  }
  await stopRuntime(s.endpoint, `no heartbeat for ${quiet} min (the worker died)`);
  await notify("GPU stopped", `${s.gpu} stopped: its worker went silent ${quiet} min ago (crashed?), so it was only burning units.`, "skull");
  return { action: "stopped", reason: `no heartbeat for ${quiet} min` };
}

/** One runtime is running: what Colab charges for it is its rate (per kind of runtime, kept in settings). */
async function learnRate(rate: number) {
  const [r] = await runtimes();
  if (!r) return;
  const k = rateKey(r.accelerator, r.high_ram);
  const cfg = await getConfig();
  if (Math.abs((cfg.rates[k] ?? 0) - rate) < 0.01) return;
  await putJson(CONFIG, { ...cfg, rates: { ...cfg.rates, [k]: rate } });
}

/** Everything the GPU card shows. */
export async function status() {
  const s = await stored().catch(() => null);
  if (s) await sweep().catch((e) => console.warn("colab sweep failed:", (e as Error).message));
  const [session, config] = await Promise.all([getSession(), getConfig()]);
  if (!s) return { connected: false, session, config };
  const [u, list] = await Promise.all([usage().catch((e: Error) => ({ error: e.message })), runtimes().catch((e: Error) => ({ error: e.message }))]);
  return { connected: true, email: s.email, usage: u, runtimes: list, session, config };
}
