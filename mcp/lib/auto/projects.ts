// Projects (docs/FACTORY.md B, the owner's rule: "an agent may delete only what it works on, in its own folder, and
// clean up when it's done"). A project is one piece of work by one caller (a model key, a connector, a person): a Files
// folder Projects/<name>-<id>, a sandbox workspace p-<id> and a suggested branch. What a tool makes with `project` set
// lands in that folder and is recorded as the project's, so its owner deletes it (to the trash) without asking;
// anything else still waits for the owner. finish keeps what's marked keep (back to its kind's folder, or keep_to) and
// trashes the rest, the folder and the workspace.
import { randomBytes } from "node:crypto";
import { getJson, getJsonTagged, listObjs, putJson, putJsonIf } from "../store";

export type Owned = { by: string; made: number; tool: string };
export type Project = {
  id: string; name: string; folder: string; path: string; workspace: string; branch: string;
  owner: string; created: number; updated: number; status: "live" | "finished" | "stopped";
  files: Record<string, Owned>; jobs: string[]; calls: number;
  finished?: { at: number; by: string; kept: string[]; removed: string[] };
};

const KEY = (id: string) => `auto/projects/${id}.json`;
const JOB = (job: string) => `auto/projects/jobs/${job}.json`;
export const ID_RE = /^[a-f0-9]{6}$/;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "work";

export async function getProject(id: string) {
  if (!ID_RE.test(id)) throw new Error("project: the 6-character id project start gave");
  const p = await getJson<Project>(KEY(id));
  if (!p) throw new Error(`no project ${id}: project action=list shows yours`);
  return p;
}

/** Change a project safely when two calls land at once (ETag write, read again on a clash). */
async function change(id: string, fn: (p: Project) => void) {
  for (let i = 0; i < 6; i++) {
    const { value, etag } = await getJsonTagged<Project>(KEY(id));
    if (!value) throw new Error(`no project ${id}`);
    fn(value);
    value.updated = Date.now();
    if (await putJsonIf(KEY(id), value, etag)) return value;
  }
  throw new Error("the project is busy: try again");
}

export async function startProject(name: string, owner: string) {
  const id = randomBytes(3).toString("hex");
  const s = slug(name);
  const path = `Projects/${s}-${id}`;
  const folder = await (await import("./bench")).ensureFolder(path, { name: owner });
  const p: Project = {
    id, name: name.slice(0, 80), folder: folder!, path, workspace: `p-${id}`, branch: `agent/${slug(owner)}/${s}-${id}`,
    owner, created: Date.now(), updated: Date.now(), status: "live", files: {}, jobs: [], calls: 0,
  };
  await putJson(KEY(id), p);
  return p;
}

export async function listProjects(opts: { owner?: string; live?: boolean } = {}) {
  const objs = (await listObjs("auto/projects/")).filter((o) => /^auto\/projects\/[a-f0-9]{6}\.json$/.test(o.key))
    .sort((a, b) => b.modified - a.modified).slice(0, 200);
  const all = (await Promise.all(objs.map((o) => getJson<Project>(o.key).catch(() => null)))).filter((p): p is Project => !!p);
  return all.filter((p) => (!opts.owner || p.owner === opts.owner) && (!opts.live || p.status === "live"));
}

/** A project a call may use: it exists, it's live and it's the caller's. */
export async function usable(id: string, owner: string) {
  const p = await getProject(id);
  if (p.status !== "live") throw new Error(`project ${id} is ${p.status}: start a new one`);
  if (p.owner !== owner) throw new Error(`project ${id} belongs to ${p.owner}, not you: start your own with project action=start`);
  return p;
}

/** Record what a call made inside a project (file ids, and jobs whose outputs come later through get_job). */
export async function record(id: string, made: { files: string[]; jobs: string[] }, tool: string, by: string) {
  if (!made.files.length && !made.jobs.length && tool !== "*") return;
  await change(id, (p) => {
    for (const f of made.files) p.files[f] ??= { by, made: Date.now(), tool };
    p.jobs = [...new Set([...p.jobs, ...made.jobs])].slice(-300);
    p.calls++;
  });
  await Promise.all(made.jobs.map((j) => putJson(JOB(j), { project: id })));
}

export const projectOfJob = (job: string) => getJson<{ project: string }>(JOB(job)).then((x) => x?.project ?? null).catch(() => null);

/** Ids a tool's answer names as made: Files ids, and job ids (a voice or image job's item is g:<job id> once done). */
export function madeIn(text: string) {
  const files = [...new Set([...text.matchAll(/"(?:file_id|file|id)":\s*"([mg]:[A-Za-z0-9._-]{1,64})"/g)].map((m) => m[1]))];
  const jobs = [...new Set([...text.matchAll(/"(?:job_id|id)":\s*"([a-f0-9]{12})"/g)].map((m) => m[1]))];
  return { files, jobs };
}

/** True when every key is a file (or the folder) of a live project this owner runs: then deleting needs no approval. */
export async function ownsAll(owner: string, keys: string[]) {
  if (!keys.length) return false;
  const mine = await listProjects({ owner, live: true });
  const owned = new Set(mine.flatMap((p) => [...Object.keys(p.files), `f:${p.folder}`]));
  return keys.every((k) => owned.has(k));
}

/** Done: keep the deliverables, trash the rest (30 days), the folder once nothing else is in it, and the workspace. */
export async function finishProject(id: string, owner: string, opts: { keep?: string[]; keep_to?: string | null; by: string }) {
  const p = await usable(id, owner);
  const files = await import("../files");
  const keep = [...new Set(opts.keep ?? [])];
  const stray = keep.filter((k) => !p.files[k]);
  if (stray.length) throw new Error(`keep only names the project's own files; not its: ${stray.join(", ")} (project action=status lists them)`);
  const t = await files.getTree();
  const removed = Object.keys(p.files).filter((k) => !keep.includes(k) && !t.trash[k]);
  if (keep.length) {
    if (opts.keep_to) await files.moveItems(keep, (await (await import("./bench")).ensureFolder(opts.keep_to, { name: opts.by }))!);
    else await files.autoFile(keep); // back to its kind's folder: Videos, Images, Audio…
  }
  if (removed.length) await files.trashItems(removed, opts.by);
  const after = await files.getTree();
  const others = Object.entries(after.place).filter(([k, f]) => f === p.folder && !after.trash[k] && !p.files[k]).length
    + after.folders.filter((f) => f.parent === p.folder && !after.trash[`f:${f.id}`]).length;
  const folderGone = !others && !after.trash[`f:${p.folder}`];
  if (folderGone) await files.trashItems([`f:${p.folder}`], opts.by);
  let workspace = "removed";
  try {
    const b = await import("./bench");
    const j = await b.submit({ op: "drop", workspace: p.workspace }, { model: opts.by, folder: null, label: `clean up ${p.workspace}` });
    const done = await b.wait(j.id, 20);
    if (done.status !== "done") workspace = `clean-up ${done.status}${done.error ? `: ${done.error}` : ""}`;
  } catch (e) { workspace = `not removed now (${(e as Error).message.slice(0, 80)}); it goes when the runtime stops`; }
  const done = await change(id, (x) => { x.status = "finished"; x.finished = { at: Date.now(), by: opts.by, kept: keep, removed }; });
  return { project: id, status: done.status, kept: keep.map((k) => ({ file: k, to: opts.keep_to ?? "its kind's folder" })), removed: removed.length, removed_files: removed.slice(0, 40),
    folder: folderGone ? "in the trash" : `kept: ${others} other thing${others === 1 ? "" : "s"} in it`, workspace, note: "Removed files are in the trash for 30 days (restore_files)." };
}

/** The owner's Stop on the dashboard: no more calls under it, its running jobs cancelled. Files stay. */
export async function stopProject(id: string, by: string) {
  const p = await getProject(id);
  const { call } = await import("../worker");
  await Promise.all(p.jobs.slice(-30).map((j) => call(`/jobs/${j}/cancel`, { body: {} }).catch(() => null)));
  return change(id, (x) => { x.status = "stopped"; x.finished = { at: Date.now(), by, kept: [], removed: [] }; });
}

/** One line each for the dashboard and status. */
export const summary = (p: Project) => ({
  id: p.id, name: p.name, owner: p.owner, status: p.status, folder: p.path, workspace: p.workspace, branch: p.branch,
  files: Object.keys(p.files).length, jobs: p.jobs.length, calls: p.calls, created: p.created, updated: p.updated,
});
