// Permanent storage for finished jobs: private Vercel Blob under library/<jobId>/.
// Audio is served to the browser through short-lived presigned CDN URLs (fast), with a proxy fallback.
import { del, get, issueSignedToken, list, parseStoreIdFromDelegationToken, presignUrl, put } from "@vercel/blob";
import { call } from "./worker";
import { unzip } from "./zip";

export type Word = { w: string; s: number; e: number };
export type LibLine = {
  id: string; text: string; duration: number; window?: number | null; fits?: boolean | null; start?: number | null;
  heard?: string; match?: number | null; subs?: boolean; name?: string; chunks?: number; cues?: number;
};
export type LibJob = {
  id: string; kind?: "tts" | "transcribe" | "video"; engine: string; voice: string; label?: string; language?: string | null;
  params?: Record<string, unknown>; created: number; archived: number; source?: string;
  subs?: { cues: number; timeline: string } | null; match?: number | null; results: LibLine[];
  video?: { width: number; height: number; duration: number; size: number; poster?: boolean; voice_job?: string };
};

const ROOT = "library/";
const opts = { access: "private" as const, addRandomSuffix: false, allowOverwrite: true };
export const FILE_RE = /^(?:[A-Za-z0-9_-]{1,64}(?:\.subs)?\.(?:wav|srt|vtt|json)|subtitles\.(?:srt|vtt|json)|video\.mp4|poster\.jpg)$/;
const TYPES: Record<string, string> = { wav: "audio/wav", srt: "application/x-subrip", vtt: "text/vtt", json: "application/json", mp4: "video/mp4", jpg: "image/jpeg" };
export const typeOf = (name: string) => TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const r = await get(path, { access: "private", useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return JSON.parse(await new Response(r.stream).text()) as T;
  } catch {
    return null;
  }
}

export const getLibJob = (id: string) => readJson<LibJob>(`${ROOT}${id}/job.json`);

export async function putLibJob(job: LibJob) {
  await put(`${ROOT}${job.id}/job.json`, JSON.stringify(job, null, 2), { ...opts, contentType: "application/json" });
}

export async function putFile(jobId: string, name: string, data: ArrayBuffer | Blob | ReadableStream | string) {
  await put(`${ROOT}${jobId}/${name}`, data, { ...opts, contentType: typeOf(name) });
}
export const putAudio = (jobId: string, lineId: string, data: ArrayBuffer) => putFile(jobId, `${lineId}.wav`, data);

export async function readFile(jobId: string, name: string) {
  const r = await get(`${ROOT}${jobId}/${name}`, { access: "private", useCache: false });
  return r && r.statusCode === 200 ? r : null;
}
export const readAudio = (jobId: string, lineId: string) => readFile(jobId, `${lineId}.wav`);

type WorkerResult = LibLine & { url?: string; srt_url?: string; vtt_url?: string; json_url?: string };
type WorkerJob = {
  id: string; kind?: "tts" | "transcribe" | "video"; engine: string; voice: string; label?: string; language?: string | null;
  params?: Record<string, unknown>; created?: number; status: string; results: WorkerResult[];
  subs?: LibJob["subs"]; match?: number | null; subs_urls?: Record<string, string>; attach_to?: string; zip_url?: string;
};

/** Copy a finished worker job (audio + subtitles via signed worker URLs) into the library. Idempotent. */
export async function archiveWorkerJob(job: WorkerJob): Promise<LibJob | null> {
  if (job.status !== "done") return null;
  if (job.attach_to) return attachSubtitles(job);
  const existing = await getLibJob(job.id);
  if (existing) return existing;
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
    params: job.params, created: Math.round((job.created ?? Date.now() / 1000) * 1000), archived: Date.now(), source: "worker",
    subs: job.subs ?? null, match: job.match ?? null,
    results: job.results.map(({ url, srt_url, vtt_url, json_url, ...r }) => r),
  };
  await putLibJob(lib);
  return lib;
}

/** Ask the worker to upload files straight to Blob with presigned PUT URLs (fast path; the tunnel is slow). */
export async function pushFromWorker(workerJob: string, libJob: string, names: string[]) {
  if (!names.length) return true;
  const token = await issueSignedToken({ operations: ["put"], validUntil: Date.now() + 15 * 60 * 1000 });
  const targets: Record<string, string> = {};
  await Promise.all(names.map(async (n) => {
    targets[n] = (await presignUrl(token, { operation: "put", pathname: `${ROOT}${libJob}/${n}`, access: "private", allowOverwrite: true, addRandomSuffix: false })).presignedUrl;
  }));
  const headers = { "x-api-version": "12", "x-vercel-blob-store-id": parseStoreIdFromDelegationToken(token.delegationToken), "x-vercel-blob-access": "private" };
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
      const j = f ? await new Response(f.stream).json().catch(() => null) : null;
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
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: ROOT, cursor, limit: 1000 });
    paths.push(...page.blobs.map((b) => b.pathname).filter((p) => p.endsWith("/job.json")));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const jobs = (await Promise.all(paths.map((p) => readJson<LibJob>(p)))).filter(Boolean) as LibJob[];
  return jobs.sort((a, b) => b.created - a.created);
}

export async function deleteLibJob(id: string) {
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `${ROOT}${id}/`, cursor, limit: 1000 });
    if (page.blobs.length) await del(page.blobs.map((b) => b.url));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

/** Presigned CDN GET URLs for many library files with one token; proxy URLs if presigning is unavailable. */
export async function signer(ttlMs = 6 * 3600 * 1000) {
  try {
    const token = await issueSignedToken({ operations: ["get"], validUntil: Date.now() + ttlMs });
    return async (jobId: string, name: string) =>
      (await presignUrl(token, { operation: "get", pathname: `${ROOT}${jobId}/${name}`, access: "private" })).presignedUrl;
  } catch {
    return async (jobId: string, name: string) => `/api/file/${jobId}/${name}`;
  }
}

/** Presigned GET for an arbitrary blob pathname (e.g. an upload the worker must fetch). */
export async function presignPath(pathname: string, ttlMs = 6 * 3600 * 1000) {
  const token = await issueSignedToken({ operations: ["get"], pathname, validUntil: Date.now() + ttlMs });
  return (await presignUrl(token, { operation: "get", pathname, access: "private" })).presignedUrl;
}

export async function withUrls(job: LibJob, sign: (j: string, n: string) => Promise<string>) {
  const results = await Promise.all(job.results.map(async (r) => ({
    ...r, audio: job.kind === "tts" || !job.kind ? await sign(job.id, `${r.id}.wav`) : null,
  })));
  if (job.kind === "video") {
    const [video_url, poster_url] = await Promise.all([sign(job.id, "video.mp4"), job.video?.poster ? sign(job.id, "poster.jpg") : null]);
    return { ...job, results, video_url, poster_url };
  }
  return { ...job, results };
}
