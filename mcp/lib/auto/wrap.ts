// Every MCP tool call goes through here (app/api/mcp/route.ts wraps the server before the tools are registered):
// it's logged with the model that made it, the kill switch and the day's units cap are checked before anything that
// spends or changes things, and risky actions wait for the owner's approval (lib/auto/control.ts).
import { createHash } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import type { ToolServer } from "../mcptools";
import { caller } from "./caller";
import { loosen, normalize } from "./ids";
import { ASK_FIRST, capApprovedToday, getControl, logCall, requestApproval, unitsToday, useApproval, type AskKey } from "./control";

type Args = Record<string, unknown>;
type Auth = { clientId?: string; extra?: Record<string, unknown> };
type Ctx = { http?: { req?: Request; authInfo?: Auth }; authInfo?: Auth } | undefined;
type Result = { content: { type: string; text?: string }[]; isError?: boolean };

/** Which approval a call needs, if any; `always` asks even when the owner switched that kind off (the platform repo's
 *  merges). Later phases add their own. */
type Gate = AskKey | { key: AskKey; always: boolean } | null;
export const GATES: Record<string, (a: Args) => Gate | Promise<Gate>> = {
  // publishing now no longer asks first (the owner's call, 2026-11-01: "remove the post approval, I don't want that").
  // Scheduled publishing never asked; the publishing rules and schedules that publish still do.
  automation_rules: (a) => (a.set && Object.keys(a.set as object).length ? "publishing_rules" : null),
  // the owner's call (2026-10-31): nothing that can be brought back asks first. The trash keeps files and folders 30
  // days (restore_files) and a deleted post is in the nightly database dump (14 days); only what's gone for good asks.
  delete_files: (a) => (a.forever ? "delete" : null), delete_media: () => "delete", empty_trash: () => "delete",
  workflow: async (a) => {
    // a schedule or a trigger on steps that publish: the owner says yes once, when it's saved or switched on
    if (a.action !== "save" && a.action !== "enable") return null;
    const fl = await import("./flows");
    const have = typeof a.id === "string" ? await fl.getFlow(a.id) : null;
    const base = typeof a.example === "string" ? fl.EXAMPLES[a.example] : undefined;
    const steps = (a.steps ?? have?.steps ?? base?.steps ?? []) as import("./flows").Step[];
    const auto = a.schedule ?? a.triggers ?? (a.action === "enable" ? have?.schedule ?? have?.triggers?.length : have?.schedule ?? base?.schedule ?? base?.triggers);
    return auto && fl.publishes(steps) ? "publishing_rules" : null;
  },
  repo: async (a) => {
    if (a.action === "allow") return "add_repo";
    if (a.action === "merge") {
      const r = await import("./repo");
      const repo = String(a.repo ?? "").toLowerCase();
      // a red or unknown PR is refused by the tool itself: the owner isn't asked about something that can't merge
      const s = await r.allowed(repo).then(() => r.status(repo, Number(a.pr))).catch(() => null);
      return s?.green ? { key: "merge_pr", always: repo === r.PLATFORM } : null;
    }
    if ((a.action === "commit" || a.action === "push") && typeof a.repo === "string" && typeof a.branch === "string") {
      const r = await import("./repo");
      const w = await r.writable(a.repo.toLowerCase(), a.branch).catch(() => null); // a bad branch is refused by the tool itself
      return w?.protected ? "push_protected" : null;
    }
    return null;
  },
};

/** Calls that spend Colab units or change things: stopped by the kill switch; the GPU ones also count against the cap. */
export const SPENDS: Record<string, (a: Args) => boolean> = {
  voice_lines: () => true, revoice: () => true, clean_audio: () => true, transcribe: () => true, imagine: () => true,
  train_voice: () => true, benchmark_voices: () => true, download: () => true, post_pipeline: () => true,
  voice_dataset: (a) => !!a.action && a.action !== "list",
  gpu: (a) => a.action === "start" || a.action === "train_draft",
  run: () => true, factory: (a) => a.action === "start", edit_video: () => true, inspect_media: () => true, browse: (a) => a.action !== "search", repurpose: () => true, video_template: (a) => a.action !== "list",
  repo: (a) => a.action === "checkout" || a.action === "push",
};
/** Changes that aren't GPU work but still stop while paused (the gated ones always do). */
const PAUSES: Record<string, (a: Args) => boolean> = {
  publish_post: (a) => !!a.go && a.go !== "save", auto_post: () => true,
  repo: (a) => ["branch", "commit", "push", "pr", "comment", "merge", "allow"].includes(String(a.action)),
  workflow: (a) => ["save", "run", "enable"].includes(String(a.action)),
  agents: (a) => a.action === "save", project: (a) => a.action === "start" || a.action === "finish", memory: (a) => ["note_set", "lesson_add", "skill_save", "ledger_add"].includes(String(a.action)),
};

/** Which model made the call: the name on its model key (lib/auto/keys.ts), else the X-Model header (Gemini CLI and
 *  others set it, docs/AUTOMATION.md), else the client in the user agent, else the OAuth client. */
export function modelOf(ctx: Ctx) {
  const keyed = (ctx?.http?.authInfo ?? ctx?.authInfo)?.extra?.model;
  if (typeof keyed === "string") return keyed;
  const h = ctx?.http?.req?.headers;
  const x = h?.get("x-model")?.trim();
  if (x) return x.replace(/[^\w .:/@+-]/g, "").slice(0, 60) || "unknown";
  const ua = (h?.get("user-agent") ?? "").toLowerCase();
  for (const [k, v] of [["claude", "claude"], ["anthropic", "claude"], ["gemini", "gemini"], ["openai", "openai"], ["cursor", "cursor"]] as const)
    if (ua.includes(k)) return v;
  const cid = ctx?.http?.authInfo?.clientId ?? ctx?.authInfo?.clientId;
  return cid === "owner" ? "owner token" : cid ? `oauth:${cid.slice(0, 12)}` : "unknown";
}

/** The role a client works as (X-Role: researcher, editor, publisher, auditor…; lib/auto/agents.ts), if it said. */
export function roleOf(ctx: Ctx) {
  const keyed = (ctx?.http?.authInfo ?? ctx?.authInfo)?.extra?.role; // a key held to a role can't leave it
  if (typeof keyed === "string") return keyed;
  const r = ctx?.http?.req?.headers?.get("x-role")?.trim().toLowerCase();
  return r && /^[a-z][a-z0-9-]{1,30}$/.test(r) ? r : undefined;
}

const trimArgs = (a: Args) => {
  const s = JSON.stringify(a, (_k, v) => (typeof v === "string" && v.length > 120 ? `${v.slice(0, 117)}…` : v));
  return s && s.length > 600 ? `${s.slice(0, 597)}…` : s;
};
export const callHash = (tool: string, a: Args) => {
  const { approval_id: _drop, ...rest } = a;
  return createHash("sha256").update(tool + JSON.stringify(rest, Object.keys(rest).sort())).digest("hex").slice(0, 16);
};
const said = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");
const jobIn = (t: string) => t.match(/"(?:id|job_id)":\s*"([a-f0-9]{12})"/)?.[1];
const stop = (msg: string): Result => ({ content: [{ type: "text", text: msg }], isError: true });

/** Fire and forget past the response when there is one (after), else just wait for it. */
export function later(p: Promise<unknown>) {
  try { after(() => p); } catch { void p; }
}

/** One line the owner reads in the inbox. */
function describe(tool: string, a: Args) {
  if (tool === "repo") return `${a.action} ${a.repo}${a.pr ? ` PR #${a.pr}` : ""}${a.branch ? ` on ${a.branch}` : ""}${Array.isArray(a.files) ? ` (${a.files.length} files)` : ""}`;
  return `${tool} ${trimArgs(a)}`;
}

/** The checks one call has to pass before it runs. null = go; else the answer to give instead. */
export async function preflight(tool: string, args: Args, model: string, roleName?: string): Promise<Result | null> {
  // a model deletes its own project's files (to the trash) without asking; anything else still waits (projects.ts)
  const own = tool === "delete_files" && !args.forever && Array.isArray(args.items)
    && await (await import("./projects")).ownsAll(model, args.items as string[]).catch(() => false);
  if (roleName) {
    const r = await (await import("./agents")).role(roleName);
    if (!r) return stop(`NO SUCH ROLE: ${roleName}. agents action=list shows the roles; or connect without X-Role.`);
    if (r.tools.length && !r.tools.includes(tool)) return stop(`NOT YOUR ROLE: the ${r.name} role doesn't use ${tool} (it uses ${r.tools.slice(0, 12).join(", ")}…). Hand it to the right role, or ask the owner to change the role (agents).`);
  }
  const g = own ? null : (await GATES[tool]?.(args)) ?? null;
  const gate = typeof g === "string" ? g : g?.key ?? null;
  const always = typeof g === "object" && !!g?.always;
  const spends = SPENDS[tool]?.(args) ?? false;
  if (!gate && !spends && !PAUSES[tool]?.(args)) return null;
  const c = await getControl();
  if (c.paused)
    return stop(`PAUSED: the owner stopped all automation${c.paused_at ? ` at ${new Date(c.paused_at).toISOString().slice(0, 16)}Z` : ""} (${c.pause_reason ?? "stop_all"}). Nothing that spends or changes things runs until they resume it in Settings → Automation. Reading still works.`);
  if (spends && c.key_cap > 0 && model !== "owner token") {
    const used = (await (await import("./control")).keyUsage())[model] ?? 0;
    if (used >= c.key_cap)
      return stop(`OVER YOUR DAILY CAP: ${model} made ${used} of the ${c.key_cap} spending calls one key may make a day (the owner set it in Settings → Automation, so one batch can't take the day from everyone). It resets at 00:00 UTC. Reading still works.`);
  }
  if (spends && c.cap_units > 0) {
    const u = await unitsToday();
    if (u.spent != null && u.spent >= c.cap_units && !(await capApprovedToday())) {
      if (!c.ask_first.includes("over_cap"))
        return stop(`OVER THE CAP: ${u.spent} of the day's ${c.cap_units} Colab units are spent; the owner set it as a hard stop. It resets at 00:00 UTC, or the owner raises it in Settings → Automation.`);
      const ap = await requestApproval({ action: "over_cap", summary: `Spend past today's cap (${u.spent} of ${c.cap_units} units), starting with ${tool}`, tool, by: model });
      return stop(`NEEDS APPROVAL (id ${ap.id}): ${u.spent} of the day's ${c.cap_units} Colab units are spent. The owner has been asked to allow more today (Settings → Automation). Call approvals action=wait id=${ap.id}, then repeat this call.`);
    }
  }
  if (gate && (always || c.ask_first.includes(gate))) {
    const h = callHash(tool, args);
    const id = typeof args.approval_id === "string" ? args.approval_id : "";
    if (id) {
      const why = await useApproval(id, gate, h);
      if (why) return stop(`APPROVAL NOT USABLE (${id}): ${why}. ${why.includes("hasn't decided") ? `Call approvals action=wait id=${id}.` : "Call this tool again without approval_id to ask afresh."}`);
      return null;
    }
    const ap = await requestApproval({ action: gate, summary: describe(tool, args), tool, hash: h, by: model });
    return stop(`NEEDS APPROVAL (id ${ap.id}): ${ASK_FIRST[gate].toLowerCase()} waits for the owner's click in Settings → Automation. Call approvals action=wait id=${ap.id} (waits up to 45 s a call); once approved, repeat this exact call with approval_id "${ap.id}". Don't retry without it.`);
  }
  return null;
}

/** Answers cost tokens: JSON goes out compact (no indentation), and for a model (not a script or a workflow, which
 *  read every row) lists past 25 are cut with a note on how to get the rest. */
const LIST_MAX = 25;
export function brief(res: Result, how: "compact" | "brief", tool: string): Result {
  if (!res.content?.length) return res;
  return { ...res, content: res.content.map((c) => {
    if (c.type !== "text" || !c.text || !/^\s*[[{]/.test(c.text)) return c;
    let v: unknown;
    try { v = JSON.parse(c.text); } catch { return c; }
    let cut = 0;
    const walk = (x: unknown, depth: number): unknown => {
      if (Array.isArray(x)) {
        const keep = how === "brief" && x.length > LIST_MAX ? (cut += x.length - LIST_MAX, x.slice(0, LIST_MAX)) : x;
        return keep.map((y) => walk(y, depth + 1));
      }
      if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).filter(([, y]) => how === "compact" || (y !== null && y !== undefined)).map(([k, y]) => [k, walk(y, depth + 1)]));
      return x;
    };
    const out = walk(v, 0) as Record<string, unknown>;
    const note = cut ? { _more: `${cut} more rows cut: pass detail "full", page with limit/offset where the tool has them, or read them in run with vb.${tool}(…)` } : {};
    return { ...c, text: JSON.stringify(Array.isArray(out) || !cut ? (cut ? { rows: out, ...note } : out) : { ...out, ...note }) };
  }) };
}

/** Tools that make files, and where a project puts them: save_to (a folder path), folder (an id), workspace. */
const PROJECT_TOOLS: Record<string, ("save_to" | "folder" | "workspace")[]> = {
  run: ["save_to", "workspace"], edit_video: ["save_to"], video_template: ["save_to"], repurpose: ["save_to"], inspect_media: ["save_to"], browse: ["save_to"],
  save_file: ["folder"], upload_media: ["folder"], add_media: ["folder"], import_file: ["folder"], upload_link: [], factory: [], voice_lines: [], imagine: [], transcribe: [], clean_audio: [], revoice: [], download: ["folder"],
};

/** A call with `project`: checked to be the caller's, its outputs sent to the project's folder and workspace unless
 *  the call names others. Returns the project id. */
async function intoProject(tool: string, a: Args, model: string) {
  if (typeof a.project !== "string" || !PROJECT_TOOLS[tool]) return null;
  const p = await (await import("./projects")).usable(a.project, model);
  for (const k of PROJECT_TOOLS[tool]) {
    if (a[k] !== undefined) continue;
    a[k] = k === "save_to" ? p.path : k === "folder" ? p.folder : p.workspace;
  }
  if (tool !== "upload_link" && tool !== "factory") delete a.project; // the link itself carries the project, for what's dropped later
  return p.id;
}

/** What a call made is the project's: files now, and the files a job saves when get_job sees it finish. */
async function owned(tool: string, proj: string | null, text: string, model: string) {
  const pr = await import("./projects");
  const made = pr.madeIn(text);
  const GEN = ["voice_lines", "imagine", "transcribe", "clean_audio", "revoice"]; // their job is the Files item g:<job>
  if (GEN.includes(tool) && /"status":\s*"done"/.test(text)) made.files.push(...made.jobs.map((j) => `g:${j}`));
  if (tool === "get_job") {
    const id = text.match(/"(?:job_id|id)":\s*"([a-f0-9]{12})"/)?.[1];
    proj = id ? await pr.projectOfJob(id) : null;
    if (!proj) return;
    made.jobs = [];
    if (/"status":\s*"done"/.test(text) && id && !/"op":\s*"/.test(text)) made.files.push(`g:${id}`); // a voice or image job (not a bench job) is its own item
  }
  await pr.record(proj!, made, tool, model).catch(() => {});
}

/** The server, with every tool registered on it guarded and logged. `via` marks calls that didn't come straight from
 *  a model (a workflow, a sandbox script). */
export function guarded(server: ToolServer, via?: string): ToolServer {
  const orig = server.registerTool.bind(server) as (name: string, cfg: Record<string, unknown>, h: (a: Args, ctx: Ctx) => Promise<Result>) => unknown;
  const registerTool = (name: string, cfg: Record<string, unknown>, handler: (a: Args, ctx: Ctx) => Promise<Result>) => {
    let schema = cfg.inputSchema as z.ZodObject | undefined;
    let urlRequired = false;
    if (schema && typeof schema.extend === "function") ({ schema, urlRequired } = loosen(name, schema)); // one id shape (ids.ts)
    if (schema && !schema.shape.detail) // short answers by default; everything on request (docs/FACTORY.md C)
      schema = schema.safeExtend({ detail: z.enum(["brief", "full"]).optional().describe("full: the whole answer (default brief: compact, long lists cut)") });
    if (schema && PROJECT_TOOLS[name] && !schema.shape.project)
      schema = schema.safeExtend({ project: z.string().regex(/^[a-f0-9]{6}$/).optional().describe("a project id (project start): what this makes lands in its folder and is yours to delete") });
    if (GATES[name] && schema && typeof schema.extend === "function")
      schema = schema.safeExtend({ approval_id: z.string().regex(/^[a-f0-9]{10}$/).optional().describe("the id from approvals, once the owner approved this exact call") });
    return orig(name, { ...cfg, ...(schema ? { inputSchema: schema } : {}) }, async (args: Args, ctx: Ctx) => {
      const t = Date.now();
      const model = modelOf(ctx);
      const roleName = roleOf(ctx);
      let res: Result;
      let gate: string | undefined;
      let proj: string | null = null;
      try {
        const a = await normalize(name, args ?? {}, urlRequired);
        const blocked = await preflight(name, a, model, roleName);
        if (blocked) { res = blocked; gate = said(blocked).split(/[:(]/)[0].trim(); }
        else {
          proj = await intoProject(name, a, model);
          if (SPENDS[name]?.(a)) later((await import("./control")).countKey(model).catch(() => null)); // the per-key daily cap
          res = await caller.run({ model }, () => handler(a, ctx)); // jobs it sends carry the caller (fair queues)
        }
      } catch (e) {
        res = stop(`ERROR: ${(e as Error).message}`);
      }
      if (!res.isError && (proj || name === "get_job")) later(owned(name, proj, said(res), model));
      const from = via ?? (ctx?.http?.authInfo?.clientId?.startsWith("run:") ? "code" : undefined); // a sandbox script
      res = brief(res, (args?.detail === "full" || from === "code" || from === "workflow" || (from && from !== "lean")) ? "compact" : "brief", name);
      const text = said(res);
      const qa = text.match(/"(?:verdict|qa)":\s*"(PASS|WARN|FAIL)"/)?.[1] as "PASS" | "WARN" | "FAIL" | undefined;
      const qaFail = [...text.matchAll(/FAIL ([a-z][a-z "]{2,40}?):/g)].map((m) => m[1].replace(/"/g, "").trim()).slice(0, 6);
      later(logCall({ t, tool: name, model, client: ctx?.http?.authInfo?.clientId, args: trimArgs(args ?? {}), ok: !res.isError, ms: Date.now() - t,
        ...(res.isError ? { err: text.slice(0, 300) } : {}), ...(jobIn(text) ? { job: jobIn(text) } : {}), ...(gate ? { gate } : {}), ...(from ? { via: from } : {}), ...(roleName ? { role: roleName } : {}),
        ...(qa ? { qa } : {}), ...(qaFail.length ? { qa_fail: qaFail } : {}) }));
      return res;
    });
  };
  return new Proxy(server, { get: (o, k) => (k === "registerTool" ? registerTool : Reflect.get(o, k)) }) as ToolServer;
}
