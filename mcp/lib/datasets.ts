// Training data for your own voice model, kept in R2: datasets/<name>/<job>.zip (24 kHz clips + metadata.csv, built by
// the worker's dataset job) and <job>.json (what went in, what was kept). A train job reads the manifest.
import { delObjs, getJson, listObjs, presign, putJson } from "./store";
import { call } from "./worker";

export type DatasetPart = {
  job: string; name: string; clips: number; minutes: number; input_minutes: number; dropped: Record<string, number>;
  created: number; sources: { name: string; duration: number; clips: number; cleanup?: unknown }[];
  // set once for a batch sent with auto_train: the train job it started, or why it didn't
  auto_train?: { job?: string; skipped?: string };
};
type DatasetJob = { id: string; voice: string; status: string; auto_train?: boolean; dataset?: Omit<DatasetPart, "job" | "created" | "sources">; results: DatasetPart["sources"] };

export const TRAIN_MIN_MINUTES = 15;

const dir = (name: string) => `datasets/${name}/`;

/** A finished dataset job: the worker pushes its zip straight into R2, then we record the summary. Idempotent. */
export async function archiveDataset(job: DatasetJob): Promise<DatasetPart | null> {
  if (job.status !== "done" || !job.dataset) return null;
  const meta = `${dir(job.voice)}${job.id}.json`;
  const have = await getJson<DatasetPart>(meta).catch(() => null);
  if (have) return have;
  const url = await presign(`${dir(job.voice)}${job.id}.zip`, "PUT", 3600);
  const res = await call<{ failed: Record<string, string> }>(`/jobs/${job.id}/push`, { body: { targets: { "dataset.zip": url }, headers: {} }, timeoutMs: 55_000 });
  if (Object.keys(res.failed).length) throw new Error(`could not store the dataset: ${Object.values(res.failed)[0]}`);
  const part: DatasetPart = { ...job.dataset, job: job.id, created: Date.now(), sources: job.results.map(({ name, duration, clips, cleanup }) => ({ name, duration, clips, cleanup })) };
  await putJson(meta, part);
  return part;
}

/** Every dataset (one per person) with its minutes collected. */
export async function listDatasets() {
  const names = [...new Set((await listObjs("datasets/")).map((o) => o.key.split("/")[1]).filter(Boolean))];
  return Promise.all(names.map(async (n) => { const d = await listDataset(n); return { name: n, minutes: d.minutes, clips: d.clips }; }));
}

export async function listDataset(name: string) {
  const keys = (await listObjs(dir(name))).map((o) => o.key).filter((k) => k.endsWith(".json"));
  const parts = (await Promise.all(keys.map((k) => getJson<DatasetPart>(k).catch(() => null)))).filter(Boolean) as DatasetPart[];
  parts.sort((a, b) => a.created - b.created);
  return { name, parts, clips: parts.reduce((s, p) => s + p.clips, 0), minutes: Math.round(parts.reduce((s, p) => s + p.minutes, 0) * 100) / 100 };
}

/** What the training notebook downloads: every part's zip as a 12 h link. */
export async function datasetManifest(name: string) {
  const d = await listDataset(name);
  return { ...d, parts: await Promise.all(d.parts.map(async (p) => ({ job: p.job, clips: p.clips, minutes: p.minutes, url: await presign(`${dir(name)}${p.job}.zip`, "GET", 12 * 3600) }))) };
}

/** The worker body for a train job on everything collected for name: every session travels as a signed link. */
export async function trainJobBody(name: string, label?: string) {
  const d = await datasetManifest(name);
  if (d.minutes < 5) throw new Error(`collect at least ${TRAIN_MIN_MINUTES} minutes first (you have ${d.minutes})`);
  return { kind: "train", name, parts: d.parts.map((p) => ({ url: p.url })), minutes: d.minutes, label: label ?? `Train your voice · ${name}` };
}

/** A stored batch sent with auto_train: start training on the whole dataset once, if there's enough and none is running. */
export async function autoTrain(job: DatasetJob, part: DatasetPart): Promise<DatasetPart> {
  if (!job.auto_train || part.auto_train) return part;
  const d = await listDataset(job.voice);
  let result: NonNullable<DatasetPart["auto_train"]>;
  if (d.minutes < TRAIN_MIN_MINUTES) {
    result = { skipped: `${d.minutes} of ${TRAIN_MIN_MINUTES} minutes collected` };
  } else {
    const { jobs } = await call<{ jobs: { kind: string; voice: string; status: string }[] }>("/jobs");
    if (jobs.some((j) => j.kind === "train" && j.voice === job.voice && ["queued", "running"].includes(j.status))) {
      result = { skipped: "already training" };
    } else {
      const t = await call<{ id: string }>("/jobs", { body: await trainJobBody(job.voice, `Auto-train · ${job.voice}`) });
      result = { job: t.id };
    }
  }
  const next = { ...part, auto_train: result };
  await putJson(`${dir(job.voice)}${job.id}.json`, next);
  return next;
}

export async function deleteDatasetPart(name: string, job: string) {
  await delObjs([`${dir(name)}${job}.zip`, `${dir(name)}${job}.json`]);
}
