// Fine-tuned Qwen3-TTS voices (train jobs with engine "qwen"), one per person, kept in R2 next to the Orpheus models:
//   qmodels/<name>/<job>/qmodel.zip   config + weights + the reference clip (~3.5 GB; the base model supplies the rest)
//   qmodels/<name>/<job>/sample.wav   a line it never heard that person say
//   qmodels/live/<name>.json          which job is <name>'s fine-tuned voice now (training again replaces it)
// The voice is ft_<name> on the qwen engine. Jobs that use one carry signed links to them (qmodels), and the worker
// downloads each model once.
import { getJson, listObjs, presign, putJson } from "./store";
import { call } from "./worker";

export type QwenModel = { name: string; job: string; created: number; clips: number; minutes: number; epochs: number; steps: number;
  loss: number; speaker: string; base: string; sample: { text: string; duration: number } | null; engine: "qwen"; gate?: string };
type TrainJob = { id: string; voice: string; status: string; train?: Omit<QwenModel, "name" | "job" | "created"> };

const dir = (m: { name: string; job: string }) => `qmodels/${m.name}/${m.job}/`;
const LIVE = "qmodels/live/";

/** A finished Qwen fine-tune: the worker pushes the model (and its test line) straight into R2. Idempotent; a model this
 *  big can outlast one request, and the worker keeps pushing, so the next poll finds it stored. */
export async function archiveQwenModel(job: TrainJob): Promise<QwenModel | null> {
  if (job.status !== "done" || !job.train) return null;
  const meta = `${dir({ name: job.voice, job: job.id })}model.json`;
  const have = await getJson<QwenModel>(meta).catch(() => null);
  if (have) return have;
  const m: QwenModel = { ...job.train, engine: "qwen", name: job.voice, job: job.id, created: Date.now() };
  const stored = new Set((await listObjs(dir(m))).map((o) => o.key.slice(dir(m).length)));
  const targets: Record<string, string> = {};
  if (!stored.has("qmodel.zip")) targets["qmodel.zip"] = await presign(`${dir(m)}qmodel.zip`, "PUT", 3 * 3600);
  if (m.sample && !stored.has("sample.wav")) targets["sample.wav"] = await presign(`${dir(m)}sample.wav`, "PUT", 3600);
  if (Object.keys(targets).length) {
    // the worker streams ~3.5 GB to storage: this request usually times out first, and later polls hear "in progress"
    const res = await call<{ failed: Record<string, string> }>(`/jobs/${job.id}/push`, { body: { targets, headers: {} }, timeoutMs: 55_000 })
      .catch(() => ({ failed: { "qmodel.zip": "in progress" } as Record<string, string> }));
    const f = res.failed["qmodel.zip"];
    if (f === "in progress") return null;
    if (f) throw new Error(`could not store the Qwen voice: ${f}`);
  }
  await putJson(meta, m);
  // a retrain only replaces the voice in use once it has been compared with it (coach.ts); a first one goes live now
  const prev = await getJson<QwenModel>(`${LIVE}${m.name}.json`).catch(() => null);
  if (prev && prev.job !== m.job) {
    const { startGate } = await import("./coach");
    await startGate(m.name, "qwen", m.job, prev.job, await gateLink(m.name, m.job));
    return { ...m, gate: "comparing" };
  }
  await promoteQwenModel(m.name, m.job);
  return m;
}

/** Make one of <name>'s fine-tuned voices the one in use (ft_<name>). */
export async function promoteQwenModel(name: string, job: string) {
  const m = await getJson<QwenModel>(`${dir({ name, job })}model.json`);
  if (!m) throw new Error(`no stored Qwen voice ${name}/${job}`);
  await putJson(`${LIVE}${name}.json`, m);
}

/** A signed link to one stored fine-tune, for a job that voices it before it's live (the comparison). */
export async function gateLink(name: string, job: string) {
  return { job, url: await presign(`${dir({ name, job })}qmodel.zip`, "GET", 24 * 3600) };
}

export async function listQwenModels(): Promise<QwenModel[]> {
  const keys = (await listObjs(LIVE)).map((o) => o.key).filter((k) => k.endsWith(".json"));
  const all = (await Promise.all(keys.map((k) => getJson<QwenModel>(k).catch(() => null)))).filter(Boolean) as QwenModel[];
  return all.sort((a, b) => b.created - a.created);
}

export async function listQwenModelsWithSamples() {
  return Promise.all((await listQwenModels()).map(async (m) => ({ ...m, voice: `ft_${m.name}`,
    sample_url: m.sample ? await presign(`${dir(m)}sample.wav`, "GET", 24 * 3600) : null })));
}

/** Signed links to every fine-tuned Qwen voice, by name (the voice is ft_<name>), for a job that voices with qwen. */
export async function qwenModelLinks() {
  const out: Record<string, { job: string; url: string }> = {};
  for (const m of await listQwenModels()) out[m.name] = { job: m.job, url: await presign(`${dir(m)}qmodel.zip`, "GET", 24 * 3600) };
  return out;
}
