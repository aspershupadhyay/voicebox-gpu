// Permanent storage for finished voice jobs: private Vercel Blob under library/<jobId>/.
import { del, get, list, put } from "@vercel/blob";

export type LibLine = { id: string; text: string; duration: number; window?: number | null; fits?: boolean | null };
export type LibJob = {
  id: string;
  engine: string;
  voice: string;
  label?: string;
  params?: Record<string, unknown>;
  created: number;
  archived: number;
  source?: string;
  results: LibLine[];
};

const ROOT = "library/";
const opts = { access: "private" as const, addRandomSuffix: false, allowOverwrite: true };

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

export async function putAudio(jobId: string, lineId: string, data: ArrayBuffer | Blob | ReadableStream) {
  await put(`${ROOT}${jobId}/${lineId}.wav`, data, { ...opts, contentType: "audio/wav" });
}

/** Copy a finished worker job (with signed result urls) into the library. Idempotent. */
export async function archiveWorkerJob(job: {
  id: string; engine: string; voice: string; label?: string; params?: Record<string, unknown>;
  created?: number; status: string; results: (LibLine & { url?: string })[];
}): Promise<LibJob | null> {
  if (job.status !== "done") return null;
  const existing = await getLibJob(job.id);
  if (existing) return existing;
  await Promise.all(
    job.results.map(async (r) => {
      const res = await fetch(r.url!, { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch ${r.id}: ${res.status}`);
      await putAudio(job.id, r.id, await res.arrayBuffer());
    }),
  );
  const lib: LibJob = {
    id: job.id, engine: job.engine, voice: job.voice, label: job.label, params: job.params,
    created: Math.round((job.created ?? Date.now() / 1000) * 1000), archived: Date.now(), source: "worker",
    results: job.results.map(({ id, text, duration, window, fits }) => ({ id, text, duration, window, fits })),
  };
  await putLibJob(lib);
  return lib;
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
  const page = await list({ prefix: `${ROOT}${id}/` });
  if (page.blobs.length) await del(page.blobs.map((b) => b.url));
}

export async function readAudio(jobId: string, lineId: string) {
  const r = await get(`${ROOT}${jobId}/${lineId}.wav`, { access: "private", useCache: false });
  return r && r.statusCode === 200 ? r : null;
}
