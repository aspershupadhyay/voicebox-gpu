// Every MCP tool call goes through here (app/api/mcp/route.ts wraps the server before the tools are registered):
// it's logged with the model that made it, the kill switch and the day's units cap are checked before anything that
// spends or changes things, and risky actions wait for the owner's approval (lib/auto/control.ts).
import { createHash } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import type { ToolServer } from "../mcptools";
import { ASK_FIRST, capApprovedToday, getControl, logCall, requestApproval, unitsToday, useApproval, type AskKey } from "./control";

type Args = Record<string, unknown>;
type Ctx = { http?: { req?: Request; authInfo?: { clientId?: string } }; authInfo?: { clientId?: string } } | undefined;
type Result = { content: { type: string; text?: string }[]; isError?: boolean };

/** Which approval a call needs, if any; `always` asks even when the owner switched that kind off (the platform repo's
 *  merges). Later phases add their own. */
type Gate = AskKey | { key: AskKey; always: boolean } | null;
export const GATES: Record<string, (a: Args) => Gate | Promise<Gate>> = {
  publish_post: (a) => (a.go === "now" || a.go === "share_to_story" ? "publish_now" : null),
  auto_post: (a) => (a.go === "now" ? "publish_now" : null),
  automation_rules: (a) => (a.set && Object.keys(a.set as object).length ? "publishing_rules" : null),
  delete_post: () => "delete", delete_media: () => "delete", delete_folder: () => "delete", delete_files: () => "delete", empty_trash: () => "delete",
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
  run: () => true, edit_video: () => true, inspect_media: () => true, browse: (a) => a.action !== "search", repurpose: () => true, video_template: (a) => a.action !== "list",
  repo: (a) => a.action === "checkout" || a.action === "push",
};
/** Changes that aren't GPU work but still stop while paused (the gated ones always do). */
const PAUSES: Record<string, (a: Args) => boolean> = {
  publish_post: (a) => !!a.go && a.go !== "save", auto_post: () => true,
  repo: (a) => ["branch", "commit", "push", "pr", "comment", "merge", "allow"].includes(String(a.action)),
  workflow: (a) => ["save", "run", "enable"].includes(String(a.action)),
};

/** Which model made the call: the X-Model header (Gemini CLI and others set it, docs/AUTOMATION.md), else the client
 *  in the user agent, else the OAuth client. */
export function modelOf(ctx: Ctx) {
  const h = ctx?.http?.req?.headers;
  const x = h?.get("x-model")?.trim();
  if (x) return x.replace(/[^\w .:/@+-]/g, "").slice(0, 60) || "unknown";
  const ua = (h?.get("user-agent") ?? "").toLowerCase();
  for (const [k, v] of [["claude", "claude"], ["anthropic", "claude"], ["gemini", "gemini"], ["openai", "openai"], ["cursor", "cursor"]] as const)
    if (ua.includes(k)) return v;
  const cid = ctx?.http?.authInfo?.clientId ?? ctx?.authInfo?.clientId;
  return cid === "owner" ? "owner token" : cid ? `oauth:${cid.slice(0, 12)}` : "unknown";
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
export async function preflight(tool: string, args: Args, model: string): Promise<Result | null> {
  const g = (await GATES[tool]?.(args)) ?? null;
  const gate = typeof g === "string" ? g : g?.key ?? null;
  const always = typeof g === "object" && !!g?.always;
  const spends = SPENDS[tool]?.(args) ?? false;
  if (!gate && !spends && !PAUSES[tool]?.(args)) return null;
  const c = await getControl();
  if (c.paused)
    return stop(`PAUSED: the owner stopped all automation${c.paused_at ? ` at ${new Date(c.paused_at).toISOString().slice(0, 16)}Z` : ""} (${c.pause_reason ?? "stop_all"}). Nothing that spends or changes things runs until they resume it in Settings → Automation. Reading still works.`);
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

/** The server, with every tool registered on it guarded and logged. `via` marks calls that didn't come straight from
 *  a model (a workflow, a sandbox script). */
export function guarded(server: ToolServer, via?: string): ToolServer {
  const orig = server.registerTool.bind(server) as (name: string, cfg: Record<string, unknown>, h: (a: Args, ctx: Ctx) => Promise<Result>) => unknown;
  const registerTool = (name: string, cfg: Record<string, unknown>, handler: (a: Args, ctx: Ctx) => Promise<Result>) => {
    let schema = cfg.inputSchema as z.ZodObject | undefined;
    if (GATES[name] && schema && typeof schema.extend === "function")
      schema = schema.extend({ approval_id: z.string().regex(/^[a-f0-9]{10}$/).optional().describe("the id from approvals, once the owner approved this exact call") });
    return orig(name, { ...cfg, ...(schema ? { inputSchema: schema } : {}) }, async (args: Args, ctx: Ctx) => {
      const t = Date.now();
      const model = modelOf(ctx);
      let res: Result;
      let gate: string | undefined;
      try {
        const blocked = await preflight(name, args ?? {}, model);
        if (blocked) { res = blocked; gate = said(blocked).split(/[:(]/)[0].trim(); }
        else res = await handler(args, ctx);
      } catch (e) {
        res = stop(`ERROR: ${(e as Error).message}`);
      }
      const text = said(res);
      const from = via ?? (ctx?.http?.authInfo?.clientId?.startsWith("run:") ? "code" : undefined); // a sandbox script
      later(logCall({ t, tool: name, model, client: ctx?.http?.authInfo?.clientId, args: trimArgs(args ?? {}), ok: !res.isError, ms: Date.now() - t,
        ...(res.isError ? { err: text.slice(0, 300) } : {}), ...(jobIn(text) ? { job: jobIn(text) } : {}), ...(gate ? { gate } : {}), ...(from ? { via: from } : {}) }));
      return res;
    });
  };
  return new Proxy(server, { get: (o, k) => (k === "registerTool" ? registerTool : Reflect.get(o, k)) }) as ToolServer;
}
