// The workbench from the dashboard's side (worker/bench.py runs it): send a bench job to the Colab worker, wait on
// it, and when it's done save what it made (files the code wrote to out/) into Files. Answers stay short: the result,
// trimmed output, saved file ids and the next step.
import { call } from "../worker";
import { sign } from "../oauth";
import { getJson, putJson } from "../store";

export type BenchJob = {
  id: string; kind: "bench"; status: string; error?: string | null; label?: string;
  bench: {
    op: string; stage?: string; workspace?: string; lang?: string; exit?: number | null; seconds?: number; killed?: string; tail?: string;
    stdout?: string; stderr?: string; isolation?: string[]; inputs?: { name: string; mb: number }[];
    outputs?: { name: string; path: string; bytes: number }[]; notes?: string[]; [k: string]: unknown;
  };
};
type Saved = { saved: { path: string; file_id?: string; error?: string }[]; folder: string | null };

const SAVE_KEY = (id: string) => `auto/bench/${id}.json`;

/** A key for code mode (import voicebox): a run token that lasts as long as the run plus 10 minutes, carrying the
 *  model's name for the call log. The MCP route accepts it like an OAuth access token. */
export function runKey(model: string, seconds: number) {
  return sign({ typ: "run", model: model.slice(0, 60), exp: Math.floor(Date.now() / 1000) + seconds + 600 });
}

export async function submit(body: Record<string, unknown>, opts: { model: string; folder?: string | null; label?: string }) {
  const job = await call<BenchJob>("/jobs", { body: { kind: "bench", label: opts.label ?? `${body.op} by ${opts.model}`, ...body } });
  if (opts.folder !== undefined) await putJson(`auto/bench/${job.id}.want.json`, { folder: opts.folder });
  return job;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function wait(id: string, seconds: number) {
  const until = Date.now() + Math.min(seconds, 45) * 1000;
  let job = await call<BenchJob>(`/jobs/${id}`);
  while (["queued", "running"].includes(job.status) && Date.now() < until) {
    await sleep(Math.min(2500, Math.max(0, until - Date.now())));
    job = await call<BenchJob>(`/jobs/${id}`);
  }
  return job;
}

/** Save a finished job's outputs into Files once (a folder named when it was sent; "Workbench" by default). */
async function saveOutputs(job: BenchJob, actor: { name: string }): Promise<Saved | null> {
  const outs = job.bench.outputs ?? [];
  if (job.status !== "done" || !outs.length) return null;
  const have = await getJson<Saved>(SAVE_KEY(job.id)).catch(() => null);
  if (have) return have;
  const want = await getJson<{ folder: string | null }>(`auto/bench/${job.id}.want.json`).catch(() => null);
  if (want && want.folder === null) return { saved: [], folder: null }; // asked not to save
  const folder = want?.folder ?? "Workbench";
  const inbox = await import("../inbox");
  const folderId = await ensureFolder(folder, actor);
  const starts = await inbox.startUploads({ files: outs.map((o) => ({ name: o.path.split("/").pop() || o.name, size: o.bytes })), folder: folderId });
  const targets = Object.fromEntries(outs.map((o, i) => [o.name, starts[i].upload_url]));
  const pushed = await call<{ pushed: string[]; failed: Record<string, string> }>(`/jobs/${job.id}/push`, { body: { targets, headers: {} }, timeoutMs: 280_000 });
  const tickets = starts.filter((_, i) => pushed.pushed.includes(outs[i].name)).map((s) => s.ticket);
  const done = tickets.length ? await inbox.completeUploads(tickets, actor) : [];
  let k = 0;
  const saved = outs.map((o) => {
    if (pushed.failed[o.name]) return { path: o.path, error: pushed.failed[o.name] };
    const d = done[k++] as { file_id?: string; error?: string };
    return d?.file_id ? { path: o.path, file_id: d.file_id } : { path: o.path, error: d?.error ?? "not saved" };
  });
  const out = { saved, folder };
  await putJson(SAVE_KEY(job.id), out);
  return out;
}

/** A folder by its name path, made part by part where it's missing (as downloads do). Returns its id. */
export async function ensureFolder(path: string, actor: { name: string }) {
  const fs = await import("../files");
  let parent: string | null = null;
  for (const part of path.split("/").map((x) => x.trim()).filter(Boolean)) {
    const t = await fs.getTree();
    const have = t.folders.find((f) => f.parent === parent && f.name.toLowerCase() === part.toLowerCase() && !t.trash[`f:${f.id}`]);
    parent = have ? have.id : (await fs.createFolder({ name: part, parent }, actor.name)).id;
  }
  return parent;
}

/** What a model sees for a bench job: short, with the next step. Saves outputs once the job is done. */
export async function view(job: BenchJob, actor: { name: string } = { name: "Workbench" }) {
  const b = job.bench ?? ({} as BenchJob["bench"]);
  if (job.status === "queued" || job.status === "running")
    return { job_id: job.id, status: job.status, stage: b.stage, ...(b.tail ? { output_so_far: b.tail } : {}), next: `Call get_job with job_id "${job.id}" to keep waiting.` };
  let files: Saved | { error: string } | null = null;
  try { files = await saveOutputs(job, actor); } catch (e) { files = { error: `outputs not saved: ${(e as Error).message}` }; }
  const base = { job_id: job.id, status: job.status, op: b.op, ...(job.error ? { error: job.error } : {}) };
  if (b.op === "run") {
    return {
      ...base, exit: b.exit, seconds: b.seconds, ...(b.killed ? { killed: b.killed } : {}), workspace: b.workspace,
      stdout: b.stdout ?? "", ...(b.stderr ? { stderr: b.stderr } : {}),
      ...(b.outputs?.length ? { outputs: files ?? b.outputs } : {}), ...(b.notes ? { notes: b.notes } : {}),
      next: job.status === "error" ? "Fix the input the error names and run again." : b.exit === 0 ? "Done." : b.killed ? `It was stopped (${b.killed}): give it a longer timeout_s or memory_mb, or do less per run.` : "It failed: read stderr, fix the code, run again (the workspace keeps its files).",
    };
  }
  if (b.op === "edit" || b.op === "inspect") {
    const qa = (b.op === "edit" ? b.qa : (b.report as { qa?: unknown } | undefined)?.qa) as { verdict: string; checks: { status: string; check: string; why: string }[] } | undefined;
    const issues = qa?.checks.filter((c) => c.status !== "PASS").map((c) => `${c.status} ${c.check}: ${c.why}`);
    const saved = files && "saved" in files ? files.saved : undefined;
    if (b.op === "edit") {
      return {
        ...base, seconds: b.seconds_out, render_s: b.render_s, ...(b.captions ? { captions: b.captions } : {}),
        qa: qa ? { verdict: qa.verdict, ...(issues?.length ? { issues } : {}) } : null,
        file: saved?.[0] ?? (files && "error" in files ? files : b.outputs?.[0]?.name),
        next: job.status === "error" ? "Fix what the error names and send the edit again." : qa?.verdict === "FAIL" ? "Fix the FAIL lines (change the spec) and render again before posting." : "Done: it's in Files. inspect_media with checks [\"sheet\"] shows its frames.",
      };
    }
    const rep = { ...(b.report as Record<string, unknown> | undefined) };
    if (qa) rep.qa = { verdict: qa.verdict, ...(issues?.length ? { issues } : {}) };
    return { ...base, ...rep, ...(saved?.length ? { sheet_file: saved[0] } : {}), next: job.status === "error" ? "Fix what the error names and try again." : "Done." };
  }
  return { ...base, ...b, ...(files ? { files } : {}) };
}

/** A Files id (m:…, g:…) or a web address, as {url, name} the worker can fetch. A generated item gives its main file
 *  (the video, else the first file). */
export async function inputFile(ref: string): Promise<{ url: string; name: string }> {
  if (/^https?:\/\//.test(ref)) return { url: ref, name: decodeURIComponent(new URL(ref).pathname.split("/").pop() || "file") };
  const d = await (await import("../filemanager")).fileDetail(ref) as { name: string; download?: string | null; url?: string | null; links?: Record<string, string> };
  if (d.download || d.url) return { url: (d.download ?? d.url)!, name: d.name };
  const links = Object.entries(d.links ?? {});
  const main = links.find(([n]) => n === "video.mp4") ?? links[0];
  if (!main) throw new Error(`${ref} has no file to fetch`);
  return { url: main[1], name: main[0] };
}
