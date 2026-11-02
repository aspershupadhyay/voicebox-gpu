// Thin client for the GPU workers' gateway (see docs/API.md): the Colab one and the Modal one run the same code, and
// every call picks one (lib/gpus.ts): a job's follow-ups go to the GPU that has it, new work to the preferred GPU and,
// when that one is off or can't be reached, to the other.
import { loadWorker, saveWorker, STALE_MS, type WorkerRecord } from "./registry";
import { authFor, gpuState, jobBackend, order, rememberModalJob, type Backend, type GpuState } from "./gpus";

export class WorkerOffline extends Error {}
/** The worker is registered (it heartbeats) but a request to it didn't get through: a tunnel that's seconds old and
 *  doesn't resolve yet, a tunnel reconnecting, a worker restarting. `neverArrived`: the request certainly didn't reach
 *  it, so the other GPU can take it. */
export class WorkerUnreachable extends Error {
  constructor(msg: string, public neverArrived = false) { super(msg); }
}

/** Why a fetch threw, from Node's "fetch failed" and its cause: the code (ENOTFOUND…) and whether the request
 *  certainly never reached the worker (then even a POST is safe to send again). */
function netError(e: unknown) {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const code = err.cause?.code ?? (err.name === "TimeoutError" ? "TIMEOUT" : "");
  return { code: code || err.message, neverArrived: /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|EHOSTUNREACH|ENETUNREACH)$/.test(code) };
}

const NAME: Record<Backend, string> = { colab: "Colab", modal: "Modal" };

/** The Colab worker's record, when it's online. */
export async function currentWorker(): Promise<WorkerRecord> {
  const rec = await loadWorker();
  if (!rec) throw new WorkerOffline("No worker has registered yet. Open the Colab notebook and run all cells.");
  const age = Date.now() - rec.last_seen;
  if (age > STALE_MS)
    throw new WorkerOffline(
      `Worker last seen ${Math.round(age / 60000)} min ago — the Colab runtime is probably stopped. Re-run the notebook.`,
    );
  return rec;
}

type Init = { method?: string; body?: unknown; timeoutMs?: number };

/** Where one GPU answers, or why it can't take this call. A sleeping Modal is woken only by work (a POST), never by a
 *  read: every open tab asks for status and lists, and each would otherwise start a GPU. */
function target(s: GpuState, b: Backend, method: string, isJob: boolean): string {
  if (b === "colab") {
    if (!s.colab.rec) throw new WorkerOffline("Colab is off: no Colab worker has registered (start it in Settings → GPU & engines, or run the notebook).");
    if (!s.colab.online) throw new WorkerOffline(`Colab is off: last seen ${Math.round((Date.now() - s.colab.rec.last_seen) / 60000)} min ago (start it in Settings → GPU & engines).`);
    return s.colab.rec.url;
  }
  if (!s.modal.configured) throw new WorkerOffline("Modal isn't set up (Settings → GPU & engines → Modal).");
  if (isJob && !s.modal.awake) throw new WorkerOffline("the Modal GPU that ran this job has gone to sleep; its results are in Files if it finished");
  if (!s.modal.awake && s.modal.over) throw new WorkerOffline(`Modal has used its ${s.modal.cap_h} h for this month (raise the cap in Settings → GPU & engines).`);
  if (!s.modal.awake && method === "GET") throw new WorkerOffline("Modal is asleep (it wakes for the next job).");
  return s.modal.url;
}

/** Wake a sleeping Modal GPU: its first answer waits on a container starting (about a minute; longer the first time,
 *  while it installs). Only that wait is waited out: an address that doesn't resolve, refuses or resets, or an answer
 *  that says it isn't ours (not deployed, wrong secret), gives up in seconds, so the other GPU can take the job. */
async function wake(url: string) {
  const auth = await authFor("modal");
  const until = Date.now() + 8 * 60_000;
  let last = "", drops = 0;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(140_000), cache: "no-store" });
      if (r.ok) return;
      if (r.status < 500) throw new WorkerUnreachable(`Modal answered ${r.status}: ${r.status === 404 ? "the app isn't deployed at that address (modal deploy modal_app/voicebox_modal.py)" : r.status === 401 ? "its key doesn't match (Settings → GPU & engines → Set up Modal again)" : "it isn't the voicebox worker"}`, true);
      last = `HTTP ${r.status}`;
    } catch (e) {
      if (e instanceof WorkerUnreachable) throw e;
      const n = netError(e);
      if (n.code !== "TIMEOUT" && ++drops >= 3) throw new WorkerUnreachable(`couldn't reach Modal (${n.code})`, true);
      last = n.code;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new WorkerUnreachable(`the Modal GPU didn't wake up in 8 min (${last})`, true);
}

export async function call<T = unknown>(path: string, init: Init = {}) {
  if (path === "/jobs" && init.body && typeof init.body === "object") {
    // a job that uses a trained voice model (either person's) carries signed links to the models
    const { withModels } = await import("./voicemodel");
    const who = (await import("./auto/caller")).caller.getStore()?.model; // the worker's lanes take turns by owner
    init = { ...init, body: await withModels({ ...(who ? { owner: who } : {}), ...(init.body as Record<string, unknown>) }) };
  }
  const method = init.method ?? (init.body ? "POST" : "GET");
  const s = await gpuState();
  const job = path.match(/^\/jobs\/([A-Za-z0-9_-]+)/)?.[1];
  if (job) {
    const b = await jobBackend(job);
    return callOn<T>(b, target(s, b, method, true), path, init, method);
  }
  if (path === "/jobs" && method === "GET") {
    // every job on every GPU that's up (Modal only while awake)
    const up = (["colab", "modal"] as Backend[]).filter((b) => (b === "colab" ? s.colab.online : s.modal.awake));
    if (!up.length) throw new WorkerOffline(offline(s));
    const all = await Promise.allSettled(up.map((b) => callOn<{ jobs?: unknown[] }>(b, b === "colab" ? s.colab.rec!.url : s.modal.url, path, init, method)));
    const ok = all.filter((r): r is PromiseFulfilledResult<{ jobs?: unknown[] }> => r.status === "fulfilled").map((r) => r.value);
    if (!ok.length) throw (all[0] as PromiseRejectedResult).reason;
    return { ...ok[0], jobs: ok.flatMap((r) => r.jobs ?? []) } as T;
  }
  const kind = path === "/jobs" ? String((init.body as { kind?: unknown } | undefined)?.kind ?? "tts") : undefined;
  const tries = order(s, kind);
  const why: string[] = [];
  for (const b of tries) {
    let url: string;
    try { url = target(s, b, method, false); } catch (e) { why.push((e as Error).message); continue; }
    try {
      if (b === "modal" && !s.modal.awake) {
        await wake(url);
        // awake from now: the job's progress polls go to it before its first heartbeat lands
        await saveWorker({ ...(s.modal.rec ?? {}), url, started_at: Date.now() / 1000, last_seen: Date.now() }, "modal").catch(() => {});
      }
      const out = await callOn<T>(b, url, path, init, method);
      if (b === "modal" && method === "POST") {
        const id = (out as { id?: unknown } | null)?.id;
        // the job exists either way: a failed note must not turn its start into an error
        if (typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)) await rememberModalJob(id).catch((e) => console.error("modal job note", e));
      }
      return out;
    } catch (e) {
      // only what certainly never arrived goes to the other GPU: no job is ever sent twice
      if (!(e instanceof WorkerOffline || (e instanceof WorkerUnreachable && e.neverArrived))) throw e;
      why.push(`${NAME[b]}: ${(e as Error).message}`);
    }
  }
  throw new WorkerOffline(why.length > 1 ? `No GPU could take it. ${why.join(" · ")}` : why[0] ?? offline(s));
}

/** Wake Modal (even with Colab on, even past nothing but a read) and ask its /health: proof it works, end to end.
 *  Costs a minute or two of Modal GPU; it sleeps again 10 minutes later. */
export async function testModal() {
  const s = await gpuState();
  const url = target(s, "modal", "POST", false);
  const t = Date.now();
  if (!s.modal.awake) {
    await wake(url);
    await saveWorker({ ...(s.modal.rec ?? {}), url, started_at: Date.now() / 1000, last_seen: Date.now() }, "modal").catch(() => {});
  }
  const h = await callOn<{ gpu?: { name?: string; total_gb?: number }; version?: string; engines?: Record<string, string> }>("modal", url, "/health", {}, "GET");
  return { ok: true, woke_in_s: Math.round((Date.now() - t) / 1000), was_awake: s.modal.awake, gpu: h.gpu?.name ?? null, gpu_gb: h.gpu?.total_gb ?? null,
    worker_version: h.version ?? null, engines: h.engines ?? {}, url };
}

function offline(s: GpuState) {
  const parts = [s.colab.online ? null : "Colab is off", !s.modal.configured ? "Modal isn't set up" : s.modal.over ? "Modal is past its monthly cap" : "Modal is asleep"].filter(Boolean);
  return `No GPU is on (${parts.join(", ")}). Start Colab in Settings → GPU & engines, or send a job and Modal wakes for it.`;
}

async function callOn<T>(b: Backend, base: string, path: string, init: Init, method: string): Promise<T> {
  // Cloudflare answers for the worker when it can't reach it (restarting, tunnel reconnecting) with an HTML page:
  // 530 / 1033 = the tunnel isn't connected (the request never reached the worker), 502-504 = it didn't answer.
  // Reads try again briefly; a POST only on 530, where it certainly never arrived (no job is ever sent twice).
  const auth = await authFor(b);
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? (b === "modal" ? 60_000 : 25_000)),
        cache: "no-store",
      });
    } catch (e) {
      // a brand-new trycloudflare address takes a few seconds to resolve: a request that never left is sent again
      // (a POST too: it can't have arrived); a read also on any other network error
      const n = netError(e);
      if (attempt < 4 && (n.neverArrived || method === "GET")) {
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
        continue;
      }
      throw new WorkerUnreachable(`couldn't reach the ${NAME[b]} worker (${n.code}): ${n.neverArrived ? "its address isn't up yet" : n.code === "TIMEOUT" ? "it didn't answer in time" : "the connection dropped"}`, n.neverArrived);
    }
    const text = await r.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (r.ok && data !== null) return data as T;
    const edge = data === null && [502, 503, 504, 530].includes(r.status);
    if (edge && attempt < 2 && (method === "GET" || r.status === 530)) {
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
      continue;
    }
    if (edge) throw new WorkerUnreachable(`worker ${r.status}: the ${NAME[b]} worker isn't reachable right now (restarting, or its address is reconnecting); try again in a minute`, r.status === 530);
    throw new Error(`worker ${r.status}: ${(data as { error?: string } | null)?.error ?? text.slice(0, 300)}`);
  }
}

export function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
