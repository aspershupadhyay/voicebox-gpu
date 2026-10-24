// Your voice in Kokoro (the voicewalk job): the Kokoro style vector found closest to a person's recording, kept in R2
// so it outlives the Colab runtime:
//   kvoices/<name>/<job>/voice.npy   the style tensor Kokoro speaks with (~500 KB)
//   kvoices/<name>/<job>/sample.wav  a line it was never tuned on
//   kvoices/live/<name>.json         which job is <name>'s Kokoro voice now (searching again replaces it)
// The voice is used as kokoro voice "kv_<name>"; every kokoro job carries signed links to these (withKVoices).
import { getJson, listObjs, presign, putJson } from "./store";
import { call } from "./worker";

export type KVoice = {
  name: string; voice: string; job: string; created: number; target: string; similarity: number; match: number; start: number;
  closest: { voice: string; similarity: number }[]; mix?: { voice: string; weight: number }[]; rounds: number;
  sample: { text: string; duration: number } | null;
};
type WalkJob = { id: string; voice: string; status: string; kvoice?: Omit<KVoice, "voice" | "job" | "created"> & { name: string } };

const dir = (v: { name: string; job: string }) => `kvoices/${v.name}/${v.job}/`;
const LIVE = "kvoices/live/";

/** A finished voicewalk job: the worker pushes the voice and its sample into R2, then it becomes that person's
 *  Kokoro voice. Idempotent. */
export async function archiveKVoice(job: WalkJob): Promise<KVoice | null> {
  if (job.status !== "done" || !job.kvoice) return null;
  const meta = `${dir({ name: job.voice, job: job.id })}meta.json`;
  const have = await getJson<KVoice>(meta).catch(() => null);
  if (have) return have;
  const v: KVoice = { ...job.kvoice, name: job.voice, voice: `kv_${job.voice}`, job: job.id, created: Date.now() };
  const targets = { "voice.npy": await presign(`${dir(v)}voice.npy`, "PUT", 3600), "sample.wav": await presign(`${dir(v)}sample.wav`, "PUT", 3600) };
  const res = await call<{ failed: Record<string, string> }>(`/jobs/${job.id}/push`, { body: { targets, headers: {} }, timeoutMs: 55_000 });
  if (res.failed["voice.npy"]) throw new Error(`could not store the Kokoro voice: ${res.failed["voice.npy"]}`);
  await putJson(meta, v);
  await putJson(`${LIVE}${v.name}.json`, v);
  return v;
}

/** Every person's Kokoro voice, newest first, with a playable sample. */
export async function listKVoices() {
  const keys = (await listObjs(LIVE)).map((o) => o.key).filter((k) => k.endsWith(".json"));
  const all = (await Promise.all(keys.map((k) => getJson<KVoice>(k).catch(() => null)))).filter(Boolean) as KVoice[];
  all.sort((a, b) => b.created - a.created);
  return Promise.all(all.map(async (v) => ({ ...v, sample_url: v.sample ? await presign(`${dir(v)}sample.wav`, "GET", 24 * 3600) : null })));
}

/** Signed links to every Kokoro voice found, by voice id (kv_<name>), for a job that may speak in one. */
export async function kvoiceLinks() {
  const keys = (await listObjs(LIVE)).map((o) => o.key).filter((k) => k.endsWith(".json"));
  const all = (await Promise.all(keys.map((k) => getJson<KVoice>(k).catch(() => null)))).filter(Boolean) as KVoice[];
  const out: Record<string, { job: string; url: string }> = {};
  for (const v of all) out[v.voice] = { job: v.job, url: await presign(`${dir(v)}voice.npy`, "GET", 24 * 3600) };
  return out;
}
