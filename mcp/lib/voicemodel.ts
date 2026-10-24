// Trained voice models, one per person, kept in R2 so they outlive the Colab runtime:
//   models/<name>/<job>/adapter.zip   the LoRA adapter a train job wrote (~200-400 MB)
//   models/<name>/<job>/sample.wav    a line it never heard that person say
//   models/live/<name>.json           which job is <name>'s model now (training again replaces it)
// <name> is the dataset the model was trained on (one per person, e.g. "asper", "riya"), and it is the voice to ask the
// myvoice engine for. "me" means the most recently trained model. Every job that uses myvoice carries signed links to
// the models it may need (withModels), and the worker downloads each adapter once, so both people's models work on the
// same worker without restarting it.
import { getJson, listObjs, presign, putJson } from "./store";
import { call } from "./worker";

export type VoiceModel = {
  name: string; job: string; created: number; clips: number; minutes: number; epochs: number; steps: number; loss: number;
  speaker: string; base: string; sample: { text: string; duration: number } | null;
  best_epoch?: number; eval_loss?: number[]; listening?: { epoch: number; match: number | null; similarity: number | null; score: number | null }[]; flow_clips?: number; held_out?: number;
};
type TrainJob = { id: string; voice: string; status: string; train?: Omit<VoiceModel, "name" | "job" | "created"> };

const dir = (m: { name: string; job: string }) => `models/${m.name}/${m.job}/`;
const LIVE = "models/live/";
const CURRENT = "models/current.json"; // before per-person models: the one model there was (still read, still written)

/** A finished train job: the worker pushes the adapter (and its test line) straight into R2, then it becomes that
 *  person's model. Idempotent. */
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
    if (res.failed["adapter.zip"] === "in progress") return null; // an earlier poll's upload is still running
    if (res.failed["adapter.zip"]) throw new Error(`could not store your model: ${res.failed["adapter.zip"]}`);
  }
  await putJson(meta, m);
  await putJson(`${LIVE}${m.name}.json`, m);
  await putJson(CURRENT, m);
  return m;
}

/** Every person's model, newest first. */
export async function listModels(): Promise<VoiceModel[]> {
  const keys = (await listObjs(LIVE)).map((o) => o.key).filter((k) => k.endsWith(".json"));
  const live = (await Promise.all(keys.map((k) => getJson<VoiceModel>(k).catch(() => null)))).filter(Boolean) as VoiceModel[];
  const legacy = await getJson<VoiceModel>(CURRENT).catch(() => null);
  if (legacy && !live.some((m) => m.name === legacy.name)) live.push(legacy);
  return live.sort((a, b) => b.created - a.created);
}

const withSample = async (m: VoiceModel) => ({ ...m, sample_url: m.sample ? await presign(`${dir(m)}sample.wav`, "GET", 24 * 3600) : null });

/** One person's model (or the newest, for "me" / no name), with a playable test line. */
export async function currentModel(name?: string) {
  const all = await listModels();
  const m = !name || name === "me" ? all[0] : all.find((x) => x.name === name);
  return m ? withSample(m) : null;
}

export async function listModelsWithSamples() {
  return Promise.all((await listModels()).map(withSample));
}

/** Signed links to every model, by voice name ("me" = the newest), for a job that uses the myvoice engine. */
export async function modelLinks() {
  const all = await listModels();
  const out: Record<string, { job: string; url: string; speaker: string }> = {};
  for (const m of all) out[m.name] = { job: m.job, url: await presign(`${dir(m)}adapter.zip`, "GET", 24 * 3600), speaker: m.speaker };
  if (all[0] && !out.me) out.me = out[all[0].name];
  return out;
}

/** Attach the trained models to a worker job that voices anything with myvoice (a voiceover, a benchmark candidate, a
 *  story). Other jobs pass through untouched. */
export async function withModels<T extends Record<string, unknown>>(body: T): Promise<T> {
  const cands = Array.isArray(body.candidates) ? (body.candidates as { engine?: string; voice?: string }[]) : [];
  let out = body;
  // your voice found in Kokoro (kv_<name>): the style vector travels as a signed link too
  const kv = (e?: unknown, v?: unknown) => e === "kokoro" && String(v ?? "").startsWith("kv_");
  if (kv(body.engine, body.voice) || cands.some((c) => kv(c?.engine, c?.voice))) {
    const { kvoiceLinks } = await import("./kvoices");
    const kvoices = await kvoiceLinks().catch(() => ({}));
    if (Object.keys(kvoices).length) out = { ...out, kvoices };
  }
  // fine-tuned Qwen voices (ft_<name>): their models travel as signed links too
  const ft = (e?: unknown, v?: unknown) => e === "qwen" && String(v ?? "").startsWith("ft_");
  if (ft(body.engine, body.voice) || cands.some((c) => ft(c?.engine, c?.voice))) {
    const { qwenModelLinks } = await import("./qwenmodels");
    const qmodels = await qwenModelLinks().catch(() => ({}));
    if (Object.keys(qmodels).length) out = { ...out, qmodels };
  }
  if (body.engine !== "myvoice" && !cands.some((c) => c?.engine === "myvoice")) return out;
  const models = await modelLinks().catch(() => ({}));
  return Object.keys(models).length ? { ...out, models } : out;
}

/** For the worker at start-up: a 7-day link to the newest adapter (the longest an S3 signature lasts). */
export async function adapterUrl() {
  const m = (await listModels())[0];
  return m ? { url: await presign(`${dir(m)}adapter.zip`, "GET", 7 * 24 * 3600), speaker: m.speaker } : null;
}
