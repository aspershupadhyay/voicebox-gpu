// Your trained voice model, kept in R2 so it outlives the Colab runtime: models/<dataset>/<job>/adapter.zip (the LoRA
// adapter the worker's train job wrote, ~200-400 MB), sample.wav (a line it never heard you say) and models/current.json
// (which one the myvoice engine serves). A fresh worker downloads the adapter through /api/worker-env.
import { getJson, listObjs, presign, putJson } from "./store";
import { call } from "./worker";

export type VoiceModel = {
  name: string; job: string; created: number; clips: number; minutes: number; epochs: number; steps: number; loss: number;
  speaker: string; base: string; sample: { text: string; duration: number } | null;
};
type TrainJob = { id: string; voice: string; status: string; train?: Omit<VoiceModel, "name" | "job" | "created"> };

const dir = (m: { name: string; job: string }) => `models/${m.name}/${m.job}/`;
const CURRENT = "models/current.json";

/** A finished train job: the worker pushes the adapter (and its test line) straight into R2, then it becomes the model
 *  the myvoice engine serves. Idempotent. */
export async function archiveModel(job: TrainJob): Promise<VoiceModel | null> {
  if (job.status !== "done" || !job.train) return null;
  const meta = `${dir({ name: job.voice, job: job.id })}model.json`;
  const have = await getJson<VoiceModel>(meta).catch(() => null);
  if (have) return have;
  const m: VoiceModel = { ...job.train, name: job.voice, job: job.id, created: Date.now() };
  // a big adapter on a slow uplink can outlast this request; the worker keeps pushing, so the next poll finds it stored
  const stored = new Set((await listObjs(dir(m))).map((o) => o.key.slice(dir(m).length)));
  const targets: Record<string, string> = {};
  if (!stored.has("adapter.zip")) targets["adapter.zip"] = await presign(`${dir(m)}adapter.zip`, "PUT", 3600);
  if (m.sample && !stored.has("sample.wav")) targets["sample.wav"] = await presign(`${dir(m)}sample.wav`, "PUT", 3600);
  if (Object.keys(targets).length) {
    const res = await call<{ failed: Record<string, string> }>(`/jobs/${job.id}/push`, { body: { targets, headers: {} }, timeoutMs: 55_000 });
    if (res.failed["adapter.zip"]) throw new Error(`could not store your model: ${res.failed["adapter.zip"]}`);
  }
  await putJson(meta, m);
  await putJson(CURRENT, m);
  return m;
}

/** The model the myvoice engine serves, with a playable test line. */
export async function currentModel() {
  const m = await getJson<VoiceModel>(CURRENT).catch(() => null);
  if (!m) return null;
  return { ...m, sample_url: m.sample ? await presign(`${dir(m)}sample.wav`, "GET", 24 * 3600) : null };
}

/** For the worker at start-up: a 7-day link to the adapter (the longest an S3 signature lasts). */
export async function adapterUrl() {
  const m = await getJson<VoiceModel>(CURRENT).catch(() => null);
  return m ? { url: await presign(`${dir(m)}adapter.zip`, "GET", 7 * 24 * 3600), speaker: m.speaker } : null;
}
