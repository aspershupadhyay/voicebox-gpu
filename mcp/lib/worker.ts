// Thin client for the Colab worker's gateway (see docs/API.md).
import { loadWorker, STALE_MS, type WorkerRecord } from "./registry";

export class WorkerOffline extends Error {}

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

export async function call<T = unknown>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
  const w = await currentWorker();
  if (path === "/jobs" && init.body && typeof init.body === "object") {
    // a job that uses a trained voice model (either person's) carries signed links to the models
    const { withModels } = await import("./voicemodel");
    init = { ...init, body: await withModels(init.body as Record<string, unknown>) };
  }
  const method = init.method ?? (init.body ? "POST" : "GET");
  // Cloudflare answers for the worker when it can't reach it (restarting, tunnel reconnecting) with an HTML page:
  // 530 / 1033 = the tunnel isn't connected (the request never reached the worker), 502-504 = it didn't answer.
  // Reads try again briefly; a POST only on 530, where it certainly never arrived (no job is ever sent twice).
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(w.url + path, {
      method,
      headers: { Authorization: `Bearer ${process.env.WORKER_SECRET}`, "Content-Type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 25_000),
      cache: "no-store",
    });
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
    if (edge) throw new Error(`worker ${r.status}: the worker isn't reachable right now (restarting, or its tunnel is reconnecting); try again in a minute`);
    throw new Error(`worker ${r.status}: ${(data as { error?: string } | null)?.error ?? text.slice(0, 300)}`);
  }
}

export function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
