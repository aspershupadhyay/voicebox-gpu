// Repos for models (docs/AUTOMATION.md, phase 3): read, branch, commit, open a PR, read its CI, comment, merge, on
// the repos the owner allowed (Settings → Automation), through GitHub's REST API with a fine-grained key that only
// reaches those repos (GITHUB_AGENT_TOKEN, a Vercel secret never shown to a model). Work happens on branches: the
// default branch and protected branches are never written by a model; a merge waits for the owner (always, on the
// platform repo). A workspace on the worker gets a clone for tests (bench op clone); its changes come back as a commit
// made here (bench op diff), so the key never sits where the sandbox could read it.
import { getControl } from "./control";

const API = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
/** The studio itself: models may open PRs here, but every merge waits for the owner. */
export const PLATFORM = (process.env.PLATFORM_REPO || "aspershupadhyay/voicebox-gpu").toLowerCase();
const NEVER = new Set(["main", "master", "production", "release"]);

export class RepoError extends Error {}

function token() {
  const t = process.env.GITHUB_AGENT_TOKEN;
  if (!t) throw new RepoError("GITHUB_AGENT_TOKEN isn't set on Vercel yet: the owner adds a fine-grained key (contents and pull requests, only the allowed repos). See docs/AUTOMATION.md, Waiting on the owner.");
  return t;
}

export async function gh<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const r = await fetch(`${API()}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${token()}`, Accept: init.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "voicebox-workbench", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    redirect: "follow",
  });
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { msg = (JSON.parse(text) as { message?: string }).message ?? msg; } catch { /* not JSON */ }
    const hint = r.status === 401 ? " (the key is wrong or expired: the owner makes a new one)" : r.status === 403 || r.status === 404 ? " (the key can't reach this, or it doesn't exist: check the repo is in the key's list)" : r.status === 409 ? " (it changed under you: read it again)" : r.status === 422 ? " (GitHub refused the input)" : "";
    throw new RepoError(`GitHub ${r.status}: ${msg}${hint}`);
  }
  if (init.raw) return text as T;
  return (text ? JSON.parse(text) : undefined) as T;
}

const REPO_RE = /^[a-z0-9_.-]{1,39}\/[a-z0-9_.-]{1,100}$/;

/** The repo, checked against the owner's allow-list. */
export async function allowed(repo: string) {
  const r = repo.trim().toLowerCase();
  if (!REPO_RE.test(r)) throw new RepoError("repo: owner/name");
  const c = await getControl();
  if (!c.repos.includes(r)) throw new RepoError(`${r} isn't on the allow-list (${c.repos.join(", ") || "empty"}). Ask with repo action=allow; the owner approves it.`);
  return r;
}

type RepoInfo = { default_branch: string; private: boolean; html_url: string };
const repoInfo = (r: string) => gh<RepoInfo>(`/repos/${r}`);

/** A branch a model may write: not the default, not main/master, not protected (protected ones need push_protected,
 *  which the caller's gate handles; the default branch never). */
export async function writable(r: string, branch: string) {
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes("..")) throw new RepoError("branch: letters, digits, . _ - /");
  const info = await repoInfo(r);
  if (branch === info.default_branch || NEVER.has(branch.toLowerCase())) throw new RepoError(`${branch} is ${branch === info.default_branch ? "the default branch" : "a release branch"}: models never push there. Work on a branch and open a PR.`);
  const b = await gh<{ protected: boolean }>(`/repos/${r}/branches/${encodeURIComponent(branch)}`).catch((e: Error) => (e.message.includes("404") ? null : Promise.reject(e)));
  return { info, exists: !!b, protected: !!b?.protected };
}

export async function tree(r: string, ref?: string, path = "") {
  const info = await repoInfo(r);
  const t = await gh<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(`/repos/${r}/git/trees/${encodeURIComponent(ref || info.default_branch)}?recursive=1`);
  const p = path.replace(/^\/+|\/+$/g, "");
  const files = t.tree.filter((e) => e.type === "blob" && (!p || e.path === p || e.path.startsWith(`${p}/`)));
  return { ref: ref || info.default_branch, count: files.length, files: files.slice(0, 400).map((f) => (f.size != null && f.size > 200_000 ? `${f.path} (${Math.round(f.size / 1000)} kB)` : f.path)),
    ...(files.length > 400 || t.truncated ? { note: "more files than shown: narrow it with path" } : {}) };
}

export async function read(r: string, path: string, ref?: string, from?: number, to?: number) {
  const text = await gh<string>(`/repos/${r}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, { raw: true });
  const lines = text.split("\n");
  const a = Math.max(1, from ?? 1), b = Math.min(lines.length, to ?? Math.min(lines.length, a + 399));
  return { path, lines: `${a}-${b} of ${lines.length}`, text: lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join("\n") };
}

export async function branch(r: string, name: string, from?: string) {
  const w = await writable(r, name);
  if (w.exists) return { branch: name, existed: true };
  const base = await gh<{ object: { sha: string } }>(`/repos/${r}/git/ref/heads/${encodeURIComponent(from || w.info.default_branch)}`);
  await gh(`/repos/${r}/git/refs`, { body: { ref: `refs/heads/${name}`, sha: base.object.sha } });
  return { branch: name, from: from || w.info.default_branch, sha: base.object.sha.slice(0, 7) };
}

export type Change = { path: string; content?: string; base64?: string; delete?: boolean };

/** One commit with every change, on a branch (made from the default branch if new). */
export async function commit(r: string, name: string, changes: Change[], message: string, model: string) {
  if (!changes.length || changes.length > 300) throw new RepoError("files: 1 to 300 changes");
  for (const c of changes) if (!c.path || c.path.startsWith("/") || c.path.split("/").includes("..") || c.path.startsWith(".git/")) throw new RepoError(`bad path: ${c.path}`);
  const w = await writable(r, name);
  if (!w.exists) await branch(r, name);
  const ref = await gh<{ object: { sha: string } }>(`/repos/${r}/git/ref/heads/${encodeURIComponent(name)}`);
  const head = await gh<{ tree: { sha: string } }>(`/repos/${r}/git/commits/${ref.object.sha}`);
  const entries = await Promise.all(changes.map(async (c) => {
    if (c.delete) return { path: c.path, mode: "100644", type: "blob", sha: null };
    const blob = await gh<{ sha: string }>(`/repos/${r}/git/blobs`, { body: c.base64 != null ? { content: c.base64, encoding: "base64" } : { content: c.content ?? "", encoding: "utf-8" } });
    return { path: c.path, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const t = await gh<{ sha: string }>(`/repos/${r}/git/trees`, { body: { base_tree: head.tree.sha, tree: entries } });
  const msg = `${message.trim().slice(0, 2000)}\n\nMade by ${model} through VoiceBox (the repo tool).`;
  const c = await gh<{ sha: string; html_url: string }>(`/repos/${r}/git/commits`, { body: { message: msg, tree: t.sha, parents: [ref.object.sha] } });
  await gh(`/repos/${r}/git/refs/heads/${encodeURIComponent(name)}`, { method: "PATCH", body: { sha: c.sha, force: false } });
  return { branch: name, commit: c.sha.slice(0, 7), url: c.html_url, files: changes.length, protected: w.protected };
}

export async function openPr(r: string, head: string, title: string, body: string, model: string, base?: string) {
  const info = await repoInfo(r);
  const pr = await gh<{ number: number; html_url: string }>(`/repos/${r}/pulls`, { body: { head, base: base || info.default_branch, title: title.slice(0, 250),
    body: `${body.slice(0, 20_000)}\n\n---\n_Opened by ${model} through VoiceBox. ${r === PLATFORM ? "The owner (or the auditor) merges it." : ""}_` } });
  return { pr: pr.number, url: pr.html_url };
}

type CheckRun = { id: number; name: string; status: string; conclusion: string | null; html_url: string; output?: { title?: string | null; summary?: string | null } };

/** A PR's state and its CI: every check, and for a failed one the end of its log (Actions jobs) or its summary. */
export async function status(r: string, pr: number) {
  const p = await gh<{ state: string; merged: boolean; mergeable: boolean | null; mergeable_state: string; head: { sha: string; ref: string }; base: { ref: string }; title: string; html_url: string }>(`/repos/${r}/pulls/${pr}`);
  const checks = await gh<{ check_runs: CheckRun[] }>(`/repos/${r}/commits/${p.head.sha}/check-runs?per_page=50`);
  const failed = checks.check_runs.filter((c) => ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion ?? ""));
  const logs = await Promise.all(failed.slice(0, 3).map(async (c) => {
    const log = await gh<string>(`/repos/${r}/actions/jobs/${c.id}/logs`, { raw: true }).catch(() => null);
    const tail = log ? log.split("\n").filter((l) => l.trim()).slice(-60).map((l) => l.replace(/^\S+Z\s/, "")).join("\n") : c.output?.summary?.slice(0, 2000) ?? null;
    return { check: c.name, tail };
  }));
  const pending = checks.check_runs.filter((c) => c.status !== "completed").length;
  return {
    pr, title: p.title, url: p.html_url, state: p.merged ? "merged" : p.state, branch: p.head.ref, base: p.base.ref, mergeable: p.mergeable, merge_state: p.mergeable_state,
    ci: checks.check_runs.length ? `${checks.check_runs.length - pending - failed.length} passed, ${failed.length} failed, ${pending} running` : "no checks on this commit",
    green: !failed.length && !pending,
    checks: checks.check_runs.map((c) => ({ name: c.name, result: c.conclusion ?? c.status })),
    ...(logs.length ? { failures: logs } : {}),
  };
}

export async function comment(r: string, pr: number, body: string, model: string) {
  const c = await gh<{ html_url: string }>(`/repos/${r}/issues/${pr}/comments`, { body: { body: `${body.slice(0, 20_000)}\n\n_${model} through VoiceBox_` } });
  return { url: c.html_url };
}

export async function merge(r: string, pr: number, method: "merge" | "squash" | "rebase" = "merge") {
  const s = await status(r, pr);
  if (s.state !== "open") throw new RepoError(`PR ${pr} is ${s.state}`);
  if (!s.green) throw new RepoError(`PR ${pr} isn't green (${s.ci}): fix it first`);
  const m = await gh<{ sha: string; merged: boolean }>(`/repos/${r}/pulls/${pr}/merge`, { method: "PUT", body: { merge_method: method } });
  return { merged: m.merged, sha: m.sha.slice(0, 7) };
}

/** For a clone on the worker: an https URL and the header that carries the key (never written into the clone). */
export async function cloneSpec(r: string, ref?: string) {
  const info = await repoInfo(r);
  return { url: `https://github.com/${r}.git`, ref: ref || info.default_branch, header: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token()}`).toString("base64")}` };
}
