// Where the MCP server remembers the Colab worker's current tunnel URL.
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
  started_at?: number;
  last_seen: number;
};

const KEY = "voicebox/worker.json";
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

export async function saveWorker(rec: WorkerRecord) {
  const body = JSON.stringify(rec);
  if (devFile) return fs.writeFile(devFile, body);
  if (redisUrl && redisToken) {
    await redis(["SET", KEY, body, "EX", "86400"]);
    return;
  }
  await putJson(KEY, rec);
  cache = { at: Date.now(), rec };
}

// Every open dashboard tab polls status; a few seconds of reuse inside a warm function saves storage reads.
let cache: { at: number; rec: WorkerRecord | null } | null = null;

export async function loadWorker(): Promise<WorkerRecord | null> {
  if (devFile) return fs.readFile(devFile, "utf8").then((t) => JSON.parse(t) as WorkerRecord, () => null);
  if (redisUrl && redisToken) {
    const v = await redis(["GET", KEY]);
    return v ? (JSON.parse(v) as WorkerRecord) : null;
  }
  if (cache && Date.now() - cache.at < 4000) return cache.rec;
  const rec = await getJson<WorkerRecord>(KEY);
  cache = { at: Date.now(), rec };
  return rec;
}
