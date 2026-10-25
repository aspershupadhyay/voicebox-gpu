// What's working and what isn't, for the Health page: one small record per finished worker job (where its time went,
// how many lines the review had to re-voice, the error if it failed), kept in R2 at telemetry/jobs/<id>.json.
import { getJson, listObjs, putJson } from "./store";

export type JobNote = {
  id: string; kind: string; mode?: string | null; method?: string | null; engine?: string; voice?: string; status: string; error?: string | null;
  created: number; at: number; lines: number; chars: number; audio_s: number; secs: number; timings: Record<string, number>;
  retried: number; fixed: number; still: number; warnings: string[]; resources?: Resources | null;
};
// the worker's monitor, averaged over the job: how busy the GPU and CPU were, peak GPU memory, which GPU, which lane
type Resources = { gpu_util: number; cpu_util: number; power_w: number; vram_peak_gb: number; ram_peak_gb: number; gpu_name: string; lane: string };
type Job = { id: string; kind?: string; mode?: string; method?: string; engine?: string; voice?: string; status: string; error?: string | null; created?: number;
  timings?: Record<string, number>; warnings?: string[]; progress?: { elapsed_s?: number }; resources?: Resources | null;
  results?: { text?: string; duration?: number; review?: { retried?: number; fixed?: number; issues?: unknown[] } | null }[] };

const KEY = "telemetry/jobs/";

/** Note a finished (done / failed / cancelled) job once. Cheap to call on every poll. */
export async function noteJob(job: Job) {
  if (!["done", "error", "cancelled"].includes(job.status) || !job.id) return;
  const key = `${KEY}${job.id}.json`;
  if (await getJson(key).catch(() => null)) return;
  const res = job.results ?? [];
  const n: JobNote = {
    id: job.id, kind: job.kind ?? "tts", mode: job.mode ?? null, method: job.method ?? null, engine: job.engine, voice: job.voice, status: job.status,
    error: job.error ? String(job.error).slice(0, 400) : null, created: Math.round((job.created ?? Date.now() / 1000) * 1000), at: Date.now(),
    lines: res.length, chars: res.reduce((s, r) => s + (r.text?.length ?? 0), 0), audio_s: Math.round(res.reduce((s, r) => s + (r.duration ?? 0), 0) * 10) / 10,
    secs: Math.round(job.progress?.elapsed_s ?? Object.values(job.timings ?? {}).reduce((s, x) => s + x, 0)), timings: job.timings ?? {},
    retried: res.reduce((s, r) => s + (r.review?.retried ?? 0), 0), fixed: res.reduce((s, r) => s + (r.review?.fixed ?? 0), 0),
    still: res.reduce((s, r) => s + (r.review?.issues?.length ?? 0), 0), warnings: (job.warnings ?? []).slice(0, 6).map((w) => String(w).slice(0, 200)),
    resources: job.resources ?? null,
  };
  await putJson(key, n);
}

/** Average GPU busy % and peak GPU memory over jobs the monitor sampled. */
function use(ns: JobNote[]) {
  const r = ns.map((n) => n.resources).filter((x): x is Resources => !!x);
  return r.length ? { gpu_util: Math.round(r.reduce((s, x) => s + x.gpu_util, 0) / r.length), vram_peak_gb: Math.max(...r.map((x) => x.vram_peak_gb)), sampled: r.length }
    : { gpu_util: null, vram_peak_gb: null, sampled: 0 };
}

/** Which GPU the work needs, from what it really did: per kind of work (voiceovers vs training and video) and per GPU
 *  it ran on, how busy the GPU was and its memory peak. GPU memory isn't the test (the worker sizes the voice engine's
 *  pool to the card, so an A100 always shows a big peak); voice work is built to fit a 24 GB L4, so voice work on an
 *  A100 / H100 gets the suggestion, with how busy it kept the big card as the evidence. */
const gpuName = (s: string) => s.replace("NVIDIA ", "").replace(/-(SXM\d*|PCIE)/i, "").replace(/-(\d+)GB$/i, " $1 GB");

export function gpuFit(notes: JobNote[]) {
  const kind = (n: JobNote) => (n.kind === "train" || n.kind === "video" || n.kind === "image" ? "heavy" : "voice");
  const out: { work: "voice" | "heavy"; gpu: string; jobs: number; gpu_util: number | null; vram_peak_gb: number | null; suggest: string | null }[] = [];
  for (const work of ["voice", "heavy"] as const) {
    const mine = notes.filter((n) => n.status === "done" && n.resources && n.resources.lane !== "cpu" && kind(n) === work);
    for (const gpu of [...new Set(mine.map((n) => gpuName(n.resources!.gpu_name)))]) {
      const on = mine.filter((n) => gpuName(n.resources!.gpu_name) === gpu);
      const u = use(on);
      const big = /A100|H100/.test(gpu), small = /L4|T4/.test(gpu);
      const suggest = work === "voice" && big ? `voice work kept the ${gpu} ${u.gpu_util}% busy: start it on an L4 (Start for voice) for far fewer units`
        : work === "heavy" && small ? `training / video on the ${gpu}: an A100 (Start for training & video) finishes much sooner` : null;
      out.push({ work, gpu, jobs: on.length, gpu_util: u.gpu_util, vram_peak_gb: u.vram_peak_gb, suggest });
    }
  }
  return out;
}

/** The Health page: per-engine speed and reliability over the last jobs, recent failures, model checks. */
export async function healthSummary(limit = 150) {
  const objs = (await listObjs(KEY)).sort((a, b) => b.modified - a.modified).slice(0, limit);
  const notes = (await Promise.all(objs.map((o) => getJson<JobNote>(o.key).catch(() => null)))).filter(Boolean) as JobNote[];
  const voice = notes.filter((n) => n.kind === "tts" && !n.mode);
  const engines = [...new Set(voice.map((n) => n.engine ?? "?"))].map((engine) => {
    const mine = voice.filter((n) => n.engine === engine);
    const ok = mine.filter((n) => n.status === "done");
    const audio = ok.reduce((s, n) => s + n.audio_s, 0);
    const steps: Record<string, number> = {};
    ok.forEach((n) => Object.entries(n.timings).forEach(([k, v]) => { steps[k] = (steps[k] ?? 0) + v; }));
    const spent = Object.values(steps).reduce((s, x) => s + x, 0);
    const lines = ok.reduce((s, n) => s + n.lines, 0);
    return {
      engine, jobs: mine.length, failed: mine.filter((n) => n.status === "error").length, lines, audio_min: Math.round(audio / 6) / 10,
      // seconds of work per second of audio, overall and per step
      speed: audio ? Math.round((ok.reduce((s, n) => s + n.secs, 0) / audio) * 100) / 100 : null,
      steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, audio ? Math.round((v / audio) * 100) / 100 : null])),
      step_share: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, spent ? Math.round((v / spent) * 100) : 0])),
      retry_rate: lines ? Math.round((ok.reduce((s, n) => s + n.retried, 0) / lines) * 100) / 100 : null,
      unfixed: ok.reduce((s, n) => s + n.still, 0),
      ...use(ok),
    };
  }).sort((a, b) => b.jobs - a.jobs);
  const failures = notes.filter((n) => n.status === "error").slice(0, 12)
    .map(({ id, kind, mode, method, engine, voice, error, at }) => ({ id, kind, mode, method, engine, voice, error, at }));
  const trains = notes.filter((n) => n.kind === "train").slice(0, 10)
    .map(({ id, method, voice, status, error, secs, at }) => ({ id, method: method ?? "train", voice, status, error, minutes: Math.round(secs / 6) / 10, at }));
  // model checks across everyone's coach files
  const coach = (await listObjs("coach/")).filter((o) => /^coach\/[^/]+\.json$/.test(o.key));
  const gates = (await Promise.all(coach.map(async (o) => {
    const c = await getJson<{ name: string; gates: { stage: string; at: number; old?: number | null; new?: number | null; note?: string; engine: string }[] }>(o.key).catch(() => null);
    return (c?.gates ?? []).map((g) => ({ name: c!.name, ...g }));
  }))).flat().sort((a, b) => b.at - a.at).slice(0, 12);
  return { jobs: notes.length, engines, failures, trains, gates, gpu_fit: gpuFit(notes),
    kept: { promoted: gates.filter((g) => g.stage === "promoted").length, kept_old: gates.filter((g) => g.stage === "kept").length } };
}
