// Permanent storage for finished jobs: the private R2 bucket under library/<jobId>/.
// Files are served to the browser (and handed to the worker) through short-lived presigned URLs.
import { learnFromJob, type Trial } from "./profiles";
import { delPrefix, getJson, getObj, listDirs, listObjs, presign, putJson, putObj, typeOf } from "./store";
import { call } from "./worker";
import { unzip } from "./zip";

export type Word = { w: string; s: number; e: number };
export type LibLine = {
  id: string; text: string; duration: number; window?: number | null; fits?: boolean | null; start?: number | null;
  heard?: string; match?: number | null; subs?: boolean; name?: string; chunks?: number; cues?: number;
  lufs?: number | null; similarity?: number | null; spoken?: string; engine?: string; takes?: { n: number; picked: number[]; match: number; similarity: number | null };
};
export type LibImage = { file: string; thumb: string; width: number; height: number; transparent?: boolean };
export type LibJob = {
  id: string; kind?: "tts" | "transcribe" | "video" | "image"; engine: string; voice: string; label?: string; language?: string | null;
  params?: Record<string, unknown>; style?: string; created: number; archived: number; source?: string;
  subs?: { cues: number; timeline: string } | null; match?: number | null; results: LibLine[];
  platform?: string; similarity?: number | null; mode?: string;
  video?: { width: number; height: number; duration: number; size: number; poster?: boolean; voice_job?: string; has_audio?: boolean };
  gen?: { model: string; mode: string; prompt: string; negative?: string; seed: number; steps: number; fps?: number; frames?: number; seconds?: number;
    source?: boolean; quality?: string; aspect?: string; count?: number; refs?: number; transparent?: boolean; width?: number; height?: number };
  images?: LibImage[];
  scenes?: LibScene[];
  benchmark?: { target: string | null; candidates: { label: string; engine: string; voice: string; match?: number | null; similarity?: number | null; mos?: number | null; rtf?: number; score?: number | null; lines?: string[]; error?: string }[] } | null;
};
export type LibScene = { id: string; text: string; start: number; seconds: number; voice_start?: number; prompt?: string | null; match?: number | null; animated?: boolean };

const ROOT = "library/";
export const FILE_RE = /^(?:[A-Za-z0-9_-]{1,64}(?:\.subs)?\.(?:wav|srt|vtt|json)|subtitles\.(?:srt|vtt|json)|video\.mp4|poster\.jpg|source\.(?:jpg|png|webp)|image-\d{1,2}\.png|thumb-\d{1,2}\.jpg)$/;
export { typeOf };

export const getLibJob = (id: string) => getJson<LibJob>(`${ROOT}${id}/job.json`).catch(() => null);

/** Every write of a job goes through here, so the index (what the Files page lists) follows it. */
export async function putLibJob(job: LibJob) {
  await putJson(`${ROOT}${job.id}/job.json`, job);
  await patchIndex((i) => { i.jobs[job.id] = summarize(job); }).catch(() => null);
}

// ── the index: one small summary per job (library/index.json), so listing the library is two requests, not one per job

/** What the Files page needs to show a job as a file; the full job (every line) loads when it's opened. */
export type LibSummary = {
  id: string; kind?: LibJob["kind"]; engine: string; voice: string; label?: string; created: number; language?: string | null; mode?: string;
  text: string; lines: number; seconds: number; first?: string; subs: boolean;
  video?: { width: number; height: number; duration: number; size: number; poster?: boolean };
  image?: { file: string; thumb: string; width: number; height: number; transparent?: boolean }; images: number; model?: string;
};
type Index = { built: number; jobs: Record<string, LibSummary> };
const INDEX = `${ROOT}index.json`;

export function summarize(j: LibJob): LibSummary {
  return {
    id: j.id, kind: j.kind, engine: j.engine, voice: j.voice, label: j.label, created: j.created, language: j.language ?? null, mode: j.mode,
    text: (j.results[0]?.text ?? "").replace(/<[^>]+>/g, "").slice(0, 200), lines: j.results.length,
    seconds: +j.results.reduce((s, r) => s + (r.duration || 0), 0).toFixed(1), first: j.results[0]?.id, subs: !!j.subs,
    video: j.video ? { width: j.video.width, height: j.video.height, duration: j.video.duration, size: j.video.size, poster: j.video.poster } : undefined,
    image: j.images?.[0], images: j.images?.length ?? 0, model: j.gen?.model,
  };
}

const readIndex = () => getJson<Index>(INDEX).catch(() => null);
async function patchIndex(fn: (i: Index) => void) {
  const i = (await readIndex()) ?? { built: 0, jobs: {} };
  if (!i.built) return; // no index yet: the next listing builds it from scratch
  fn(i);
  await putJson(INDEX, i);
}

/** Every job, summarised: the index, plus any job it misses (made before it, or a write it missed). Rebuilt daily. */
export async function listSummaries(): Promise<LibSummary[]> {
  const [dirs, idx] = await Promise.all([listDirs(ROOT), readIndex()]);
  const fresh = idx && Date.now() - idx.built < 86400_000;
  const i: Index = fresh ? idx : { built: Date.now(), jobs: {} };
  const ids = new Set(dirs.filter((d) => /^[A-Za-z0-9_-]{1,64}$/.test(d)));
  const missing = [...ids].filter((id) => !i.jobs[id]);
  const gone = Object.keys(i.jobs).filter((id) => !ids.has(id));
  for (let k = 0; k < missing.length; k += 24) {
    const got = await Promise.all(missing.slice(k, k + 24).map((id) => getLibJob(id)));
    for (const j of got) if (j) i.jobs[j.id] = summarize(j);
  }
  for (const id of gone) delete i.jobs[id];
  if (!fresh || gone.length || missing.some((id) => i.jobs[id])) await putJson(INDEX, i).catch(() => null);
  return Object.values(i.jobs).sort((a, b) => b.created - a.created);
}

export const putFile = (jobId: string, name: string, data: BodyInit) => putObj(`${ROOT}${jobId}/${name}`, data);
export const putAudio = (jobId: string, lineId: string, data: ArrayBuffer) => putFile(jobId, `${lineId}.wav`, data);

export const readFile = (jobId: string, name: string) => getObj(`${ROOT}${jobId}/${name}`);
export const listFiles = async (jobId: string) => (await listObjs(`${ROOT}${jobId}/`)).map((o) => ({ ...o, name: o.key.slice(`${ROOT}${jobId}/`.length) }));
export const readAudio = (jobId: string, lineId: string) => readFile(jobId, `${lineId}.wav`);

type WorkerResult = LibLine & { url?: string; srt_url?: string; vtt_url?: string; json_url?: string };
type WorkerJob = {
  id: string; kind?: "tts" | "transcribe" | "video" | "image"; engine: string; voice: string; label?: string; language?: string | null;
  params?: Record<string, unknown>; style?: string; created?: number; status: string;
  subs?: LibJob["subs"]; match?: number | null; subs_urls?: Record<string, string>; platform?: string; scenes?: LibScene[]; similarity?: number | null; mode?: string; attach_to?: string; zip_url?: string;
  trials?: Trial[] | null; benchmark?: LibJob["benchmark"];
  gen?: LibJob["gen"] & Record<string, unknown>; video?: { width: number; height: number; duration: number; size: number; has_audio?: boolean; fps?: number; frames?: number } | null;
  results: (WorkerResult & { poster_url?: string; file?: string; thumb?: string; width?: number; height?: number; transparent?: boolean; thumb_url?: string })[];
};

/** Copy a finished worker job (audio + subtitles via signed worker URLs) into the library. Idempotent. */
export async function archiveWorkerJob(job: WorkerJob): Promise<LibJob | null> {
  if (job.status !== "done" || (job.kind as string) === "dataset") return null; // datasets live in datasets/, not the library
  // a model check after a retrain (coach.ts): decide whether the new model goes live
  if (job.mode === "benchmark") await import("./coach").then((c) => c.resolveGate(job as Parameters<typeof c.resolveGate>[0])).catch(() => null);
  if (job.attach_to) return attachSubtitles(job);
  const existing = await getLibJob(job.id);
  if (existing) return existing;
  if (job.kind === "video") return archiveVideo(job);
  if (job.kind === "image") return archiveImages(job);
  const names: string[] = [];
  for (const r of job.results) {
    if (r.url) names.push(`${r.id}.wav`);
    if (r.srt_url) names.push(`${r.id}.subs.srt`, `${r.id}.subs.vtt`, `${r.id}.subs.json`);
  }
  for (const ext of Object.keys(job.subs_urls ?? {})) names.push(`subtitles.${ext}`);
  const pushed = await pushFromWorker(job.id, job.id, names).catch(() => false);
  const copied = pushed || (job.zip_url ? await copyFromZip(job.id, job.zip_url).catch(() => false) : false);
  if (!copied) {
    const copies: [string, string][] = [];
    for (const r of job.results) {
      if (r.url) copies.push([`${r.id}.wav`, r.url]);
      if (r.srt_url) copies.push([`${r.id}.subs.srt`, r.srt_url], [`${r.id}.subs.vtt`, r.vtt_url!], [`${r.id}.subs.json`, r.json_url!]);
    }
    for (const [ext, url] of Object.entries(job.subs_urls ?? {})) copies.push([`subtitles.${ext}`, url]);
    await Promise.all(
      copies.map(async ([name, url]) => {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
        await putFile(job.id, name, await res.arrayBuffer());
      }),
    );
  }
  const lib: LibJob = {
    id: job.id, kind: job.kind ?? "tts", engine: job.engine, voice: job.voice, label: job.label, language: job.language,
    params: job.params, style: job.style, created: Math.round((job.created ?? Date.now() / 1000) * 1000), archived: Date.now(), source: "worker",
    subs: job.subs ?? null, match: job.match ?? null, platform: job.platform, similarity: job.similarity ?? null, mode: job.mode,
    ...(job.benchmark ? { benchmark: job.benchmark } : {}),
    results: job.results.map(({ url, srt_url, vtt_url, json_url, ...r }) => r),
  };
  await putLibJob(lib);
  await learnFromJob(job).catch(() => null); // this voice's scores feed its learned defaults
  await import("./coach").then((c) => c.recordJob(job as Parameters<typeof c.recordJob>[0])).catch(() => null); // and the voice coach
  await import("./pairs").then((p) => p.archivePairs(job as Parameters<typeof p.archivePairs>[0])).catch(() => null); // RLHF pairs
  return lib;
}

/** A generated clip: the MP4, its poster frame and the source image (image-to-video) go straight from the worker to R2. */
async function archiveVideo(job: WorkerJob): Promise<LibJob> {
  const g = job.gen!;
  const story = g.mode === "story";
  const names = ["video.mp4", "poster.jpg", ...(g.source ? ["source.jpg"] : []),
    ...(story ? ["voiceover.wav", "subtitles.srt", "subtitles.vtt", "subtitles.json"] : [])];
  const pushed = await pushFromWorker(job.id, job.id, names).catch(() => false);
  if (!pushed) {
    const r = job.results[0];
    for (const [name, url] of [["video.mp4", r?.url], ["poster.jpg", r?.poster_url]] as const) {
      if (!url) continue;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
      await putFile(job.id, name, await res.arrayBuffer());
    }
  }
  const v = job.video!;
  const lib: LibJob = {
    id: job.id, kind: "video", engine: job.engine, voice: "", label: job.label || g.prompt.slice(0, 80),
    created: Math.round((job.created ?? Date.now() / 1000) * 1000), archived: Date.now(), source: "generated", results: [],
    video: { width: v.width, height: v.height, duration: v.duration, size: v.size, poster: true, has_audio: !!v.has_audio },
    gen: { model: g.model, mode: g.mode, prompt: g.prompt, negative: g.negative || undefined, seed: g.seed, steps: g.steps, fps: g.fps,
      frames: g.frames, seconds: g.seconds, source: !!g.source, aspect: g.aspect, width: g.width, height: g.height },
    ...(story ? { scenes: job.scenes, platform: job.platform, subs: job.subs ?? null } : {}),
  };
  await putLibJob(lib);
  return lib;
}

/** Generated images: each full-size PNG and its JPEG thumbnail go straight from the worker to R2. */
async function archiveImages(job: WorkerJob): Promise<LibJob> {
  const g = job.gen!;
  const imgs = job.results.filter((r) => r.file && r.thumb);
  const names = imgs.flatMap((r) => [r.file!, r.thumb!]);
  const pushed = await pushFromWorker(job.id, job.id, names).catch(() => false);
  if (!pushed) {
    for (const r of imgs) {
      for (const [name, url] of [[r.file!, r.url], [r.thumb!, r.thumb_url]] as const) {
        if (!url) continue;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
        await putFile(job.id, name, await res.arrayBuffer());
      }
    }
  }
  const lib: LibJob = {
    id: job.id, kind: "image", engine: job.engine, voice: "", label: job.label || g.prompt.slice(0, 80),
    created: Math.round((job.created ?? Date.now() / 1000) * 1000), archived: Date.now(), source: "generated", results: [],
    images: imgs.map((r) => ({ file: r.file!, thumb: r.thumb!, width: r.width ?? 0, height: r.height ?? 0, transparent: !!r.transparent })),
    gen: { model: g.model, mode: g.mode, prompt: g.prompt, negative: g.negative || undefined, seed: g.seed, steps: g.steps,
      quality: g.quality, aspect: g.aspect, count: g.count, refs: g.refs, transparent: !!g.transparent, width: g.width, height: g.height },
  };
  await putLibJob(lib);
  return lib;
}

/** Presigned PUT URLs (15 min) for files in one library job. */
export async function presignPuts(libJob: string, names: string[]) {
  const targets: Record<string, string> = {};
  await Promise.all(names.map(async (n) => { targets[n] = await presign(`${ROOT}${libJob}/${n}`, "PUT", 15 * 60); }));
  return { targets, headers: {} as Record<string, string> };
}

/** Ask the worker to upload files straight to Blob with presigned PUT URLs (fast path; the tunnel is slow). */
export async function pushFromWorker(workerJob: string, libJob: string, names: string[]) {
  if (!names.length) return true;
  const { targets, headers } = await presignPuts(libJob, names);
  const res = await call<{ pushed: string[]; failed: Record<string, string> }>(`/jobs/${workerJob}/push`, { body: { targets, headers }, timeoutMs: 55_000 });
  return Object.keys(res.failed).length === 0;
}

/** One download through the tunnel (the job zip), then parallel writes to Blob. */
async function copyFromZip(jobId: string, zipUrl: string) {
  const res = await fetch(zipUrl, { cache: "no-store" });
  if (!res.ok) return false;
  const files = await unzip(new Uint8Array(await res.arrayBuffer()));
  const keep = [...files.entries()].filter(([n]) => FILE_RE.test(n));
  if (!keep.length) return false;
  await Promise.all(keep.map(([n, data]) => putFile(jobId, n, data.slice().buffer)));
  return true;
}

/** A transcribe job run over an existing library job: copy its subtitles onto that job. */
async function attachSubtitles(job: WorkerJob): Promise<LibJob | null> {
  const target = await getLibJob(job.attach_to!);
  if (!target) return null;
  if (target.subs && target.archived >= Math.round((job.created ?? 0) * 1000)) return target;
  const names = job.results.filter((r) => r.srt_url).flatMap((r) => [`${r.id}.subs.srt`, `${r.id}.subs.vtt`, `${r.id}.subs.json`]);
  const pushed = await pushFromWorker(job.id, target.id, names).catch(() => false);
  if (!pushed) {
    const copies: [string, string][] = [];
    for (const r of job.results) if (r.srt_url) copies.push([`${r.id}.subs.srt`, r.srt_url], [`${r.id}.subs.vtt`, r.vtt_url!], [`${r.id}.subs.json`, r.json_url!]);
    await Promise.all(copies.map(async ([name, url]) => {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) await putFile(target.id, name, await res.arrayBuffer());
    }));
  }
  // rebuild the timeline subtitle files from the per-line words, honouring starts
  const byId = new Map(job.results.map((r) => [r.id, r]));
  const allCues: { s: number; e: number; text: string }[] = [];
  let t = 0;
  for (const line of target.results) {
    const r = byId.get(line.id);
    const off = line.start ?? t;
    if (r?.json_url) {
      const f = await readFile(target.id, `${r.id}.subs.json`);
      const j = f ? await f.json().catch(() => null) : null;
      for (const c of j?.cues ?? []) allCues.push({ s: +(c.s + off).toFixed(3), e: +(c.e + off).toFixed(3), text: c.text });
    }
    if (r) Object.assign(line, { heard: r.heard, match: r.match, subs: true });
    t = off + line.duration;
  }
  const ts = (x: number, sep: string) => {
    const ms = Math.round(x * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
  };
  await putFile(target.id, "subtitles.srt", allCues.map((c, i) => `${i + 1}\n${ts(c.s, ",")} --> ${ts(c.e, ",")}\n${c.text}\n`).join("\n"));
  await putFile(target.id, "subtitles.vtt", "WEBVTT\n\n" + allCues.map((c) => `${ts(c.s, ".")} --> ${ts(c.e, ".")}\n${c.text}\n`).join("\n"));
  await putFile(target.id, "subtitles.json", JSON.stringify({ cues: allCues }));
  const scores = target.results.map((r) => r.match).filter((m): m is number => typeof m === "number");
  target.subs = { cues: allCues.length, timeline: target.results.some((r) => r.start != null) ? "starts" : "sequential" };
  target.match = scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3) : null;
  target.archived = Date.now();
  await putLibJob(target);
  return target;
}

export async function listLibrary(): Promise<LibJob[]> {
  const keys = (await listObjs(ROOT)).map((o) => o.key).filter((k) => k.endsWith("/job.json"));
  const jobs = (await Promise.all(keys.map((k) => getJson<LibJob>(k).catch(() => null)))).filter(Boolean) as LibJob[];
  return jobs.sort((a, b) => b.created - a.created);
}

/** Rename a library item (its label; files and id stay). */
export async function renameLibJob(id: string, label: string) {
  const j = await getLibJob(id);
  if (!j) throw new Error("library item not found");
  const next = { ...j, label: label.slice(0, 120) };
  await putLibJob(next);
  return next;
}

export async function deleteLibJob(id: string) {
  await delPrefix(`${ROOT}${id}/`);
  await patchIndex((i) => { delete i.jobs[id]; }).catch(() => null);
}

/** Presigned GET URLs for library files. */
export async function signer(ttlSec = 6 * 3600) {
  return async (jobId: string, name: string) => presign(`${ROOT}${jobId}/${name}`, "GET", ttlSec, undefined, true);
}

/** Presigned GET for any stored key (e.g. an upload the worker must fetch). */
export const presignPath = (key: string, ttlSec = 6 * 3600, download?: string) => presign(key, "GET", ttlSec, download);

export async function withUrls(job: LibJob, sign: (j: string, n: string) => Promise<string>) {
  const results = await Promise.all(job.results.map(async (r) => ({
    ...r, audio: job.kind === "tts" || !job.kind ? await sign(job.id, `${r.id}.wav`) : null,
  })));
  if (job.kind === "video") {
    const [video_url, poster_url, source_url] = await Promise.all([sign(job.id, "video.mp4"), job.video?.poster ? sign(job.id, "poster.jpg") : null,
      job.gen?.source ? sign(job.id, "source.jpg") : null]);
    return { ...job, results, video_url, poster_url, source_url };
  }
  if (job.kind === "image") {
    const images = await Promise.all((job.images ?? []).map(async (im) => ({ ...im, url: await sign(job.id, im.file), thumb_url: await sign(job.id, im.thumb) })));
    return { ...job, results, images, poster_url: images[0]?.thumb_url ?? null };
  }
  return { ...job, results };
}
