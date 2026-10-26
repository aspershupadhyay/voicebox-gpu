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

export const TRAIN_MIN_MINUTES = 15; // auto-train waits for this much; a manual run takes any amount

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
export async function trainJobBody(name: string, label?: string, engine: "orpheus" | "qwen" = "orpheus", tries = 0) {
  const d = await datasetManifest(name);
  if (!d.clips) throw new Error(`${name} has no clips yet: add recordings first`);  // any amount trains; 15+ min sounds right
  label = label ?? (engine === "qwen" ? `Fine-tune Qwen3-TTS · ${name}` : `Train your voice · ${name}`);
  const k = `${RESUME}${name}/${engine}`;
  await putJson(`${k}.pending.json`, { name, engine, label, boot: 0, tries, at: Date.now() } satisfies PendingTrain);
  const resume = { get: await presign(`${k}.zip`, "GET", 24 * 3600), put: await presign(`${k}.zip`, "PUT", 24 * 3600),
    state: await presign(`${k}.state.json`, "PUT", 24 * 3600) };
  return { kind: "train", name, engine, parts: d.parts.map((p) => ({ url: p.url })), minutes: d.minutes, label, resume };
}

// Training that survives the GPU going away (worker/resume.py): resume/<name>/<engine>.zip is the newest checkpoint,
// .pending.json a run that hasn't finished (and on which runtime it ran), .state.json what the worker said at the end.
// A runtime that dies mid-run leaves .pending.json behind: the next runtime's heartbeat starts the run again and the
// trainer carries on from the checkpoint.
const RESUME = "resume/";
const MAX_RESTARTS = 5;
type PendingTrain = { name: string; engine: "orpheus" | "qwen"; label: string; boot: number; tries: number; at: number };

/** Every worker heartbeat: note which runtime a pending run is on; on a new runtime, start an interrupted run again. */
export async function resumeTraining(boot: number) {
  const keys = (await listObjs(RESUME)).map((o) => o.key).filter((k) => k.endsWith(".pending.json"));
  if (!keys.length || !boot) return;
  const same = (b: number) => Math.abs(b - boot) < 120;  // started_at wobbles by a second between heartbeats
  let jobs: { kind: string; voice: string; status: string }[] | null = null;
  const running = async (name: string) => {
    jobs ??= (await call<{ jobs: typeof jobs }>("/jobs")).jobs ?? [];
    return jobs!.some((j) => j.kind === "train" && j.voice === name && ["queued", "running"].includes(j.status));
  };
  for (const key of keys) {
    const p = await getJson<PendingTrain>(key);
    if (!p) continue;
    const base = key.slice(0, -".pending.json".length);
    const end = await getJson<{ state: string; t: number }>(`${base}.state.json`).catch(() => null);
    if (end && end.t * 1000 > p.at) {  // finished, cancelled or failed for good: nothing to resume
      await delObjs([key, ...(end.state === "done" ? [`${base}.zip`] : [])]);
      continue;
    }
    if (await running(p.name)) {
      if (!same(p.boot)) await putJson(key, { ...p, boot });
      continue;
    }
    if (!p.boot) {  // never seen running: the submit failed or the worker hasn't picked it up yet
      if (Date.now() - p.at > 15 * 60_000) await delObjs([key]);
      continue;
    }
    if (same(p.boot)) continue;  // this runtime ran it and it's gone without a word: leave it to the person
    if (p.tries >= MAX_RESTARTS) { await delObjs([key]); continue; }
    const t = await call<{ id: string }>("/jobs", { body: await trainJobBody(p.name, p.label, p.engine, p.tries + 1) });
    await putJson(key, { ...p, boot, tries: p.tries + 1, at: Date.now() });
    console.log(`resumed training ${p.name} (${p.engine}) as ${t.id} on the new runtime`);
    const { notify } = await import("./colab");
    await notify("Training resumed", `${p.name}'s ${p.engine} training picked up where it stopped, on the new GPU.`, "repeat").catch(() => null);
  }
}

/** A stored batch sent with auto_train: start training on the whole dataset once, if there's enough and none is running.
 *  A voice with no model trains Orpheus at TRAIN_MIN_MINUTES; a voice that has one retrains on the same engine once
 *  RETRAIN_MINUTES of new recordings are in, and the retrained model goes live only if it beats the old one (coach.ts). */
export async function autoTrain(job: DatasetJob, part: DatasetPart): Promise<DatasetPart> {
  if (!job.auto_train || part.auto_train) return part;
  const d = await listDataset(job.voice);
  const { listModels } = await import("./voicemodel");
  const { listQwenModels } = await import("./qwenmodels");
  const { RETRAIN_MINUTES } = await import("./coach");
  const [orpheus, qwen] = await Promise.all([listModels().catch(() => []), listQwenModels().catch(() => [])]);
  const last = [...orpheus.filter((m) => m.name === job.voice).map((m) => ({ ...m, engine: "orpheus" as const })),
    ...qwen.filter((m) => m.name === job.voice).map((m) => ({ ...m, engine: "qwen" as const }))].sort((a, b) => b.created - a.created)[0];
  const fresh = last ? Math.round((d.minutes - last.minutes) * 10) / 10 : d.minutes;
  let result: NonNullable<DatasetPart["auto_train"]>;
  if (!last && d.minutes < TRAIN_MIN_MINUTES) {
    result = { skipped: `${d.minutes} of ${TRAIN_MIN_MINUTES} minutes collected` };
  } else if (last && fresh < RETRAIN_MINUTES) {
    result = { skipped: `${fresh} new minutes since the current model; it retrains at ${RETRAIN_MINUTES}` };
  } else {
    const { jobs } = await call<{ jobs: { kind: string; voice: string; status: string }[] }>("/jobs");
    if (jobs.some((j) => j.kind === "train" && j.voice === job.voice && ["queued", "running"].includes(j.status))) {
      result = { skipped: "already training" };
    } else {
      const engine = last?.engine ?? "orpheus";
      const t = await call<{ id: string }>("/jobs", { body: await trainJobBody(job.voice, `${last ? "Retrain" : "Auto-train"} · ${job.voice}`, engine) });
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
