// Where the MCP server remembers each GPU worker: the Colab one's current tunnel URL, and (lib/gpus.ts) the Modal one,
// which heartbeats the same way while its container is awake.
// Prefers Upstash Redis (KV_REST_API_* / UPSTASH_REDIS_REST_*) when configured, else the R2 bucket.
import { getJson, putJson } from "./store";
import { promises as fs } from "node:fs";

export type WorkerRecord = {
  url: string;
  version?: string;
  gpu?: { name?: string; total_gb?: number; used_gb?: number };
  engines?: Record<string, string>;
  loaded?: string[];
  queue?: number;
  /** Jobs running at the last heartbeat (the cloud GPUs: the job list asks them only while they have work). */
  running?: number;
  started_at?: number;
  last_seen: number;
};

export type Backend = "colab" | "kaggle" | "modal" | "cerebrium";
const KEYS: Record<Backend, string> = { colab: "voicebox/worker.json", kaggle: "voicebox/worker-kaggle.json", modal: "voicebox/worker-modal.json", cerebrium: "voicebox/worker-cerebrium.json" };
export const STALE_MS = 4 * 60 * 1000; // heartbeat is every 60s

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
// Local development only: no store configured -> a temp file.
const devFile = !process.env.R2_ACCOUNT_ID && !redisUrl && process.env.NODE_ENV !== "production" ? "/tmp/voicebox-worker.json" : null;

async function redis(cmd: string[]) {
  const r = await fetch(redisUrl!, {
    method: "POST",
    headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

export async function saveWorker(rec: WorkerRecord, backend: Backend = "colab") {
  const body = JSON.stringify(rec);
  if (devFile) return fs.writeFile(devFile + (backend === "colab" ? "" : `.${backend}`), body);
  if (redisUrl && redisToken) {
    await redis(["SET", KEYS[backend], body, "EX", "86400"]);
    return;
  }
  await putJson(KEYS[backend], rec);
  cache[backend] = { at: Date.now(), rec };
}

// Every open dashboard tab polls status; a few seconds of reuse inside a warm function saves storage reads.
const cache: Partial<Record<Backend, { at: number; rec: WorkerRecord | null }>> = {};

/** A worker's last heartbeat (the Colab one unless named). */
export async function loadWorker(backend: Backend = "colab"): Promise<WorkerRecord | null> {
  if (devFile) return fs.readFile(devFile + (backend === "colab" ? "" : `.${backend}`), "utf8").then((t) => JSON.parse(t) as WorkerRecord, () => null);
  if (redisUrl && redisToken) {
    const v = await redis(["GET", KEYS[backend]]);
    return v ? (JSON.parse(v) as WorkerRecord) : null;
  }
  const c = cache[backend];
  if (c && Date.now() - c.at < 4000) return c.rec;
  const rec = await getJson<WorkerRecord>(KEYS[backend]);
  cache[backend] = { at: Date.now(), rec };
  return rec;
}
