// Ask Voicebox: an assistant inside the dashboard that does the work itself, with the same tools Claude gets over MCP
// (lib/mcptools.ts), so the two creators don't spend their own Claude tokens on chores. Two brains:
// - Gemini through the Gemini API (GEMINI_API_KEY on Vercel, free tier is fine): runs right here (lib/gemini.ts).
// - Antigravity CLI on the Colab worker, signed in with the owner's Google account so it runs on their Google AI plan
//   (worker/ask.py). It reaches the tools through /api/mcp?ask=1 with a token minted for that one conversation.
// Either way, anything that deletes, spends GPU time or changes settings waits here until a person approves it.
// Conversations live in R2 (workspace/ask/), shared by both creators like the rest of the workspace.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import { registerTools, type Actor, type Gate, type ToolServer } from "./mcptools";
import { sign, verify } from "./oauth";
import { delObjs, getJson, putJson } from "./store";

export type Brain = "gemini" | "antigravity";
export type Step = { tool: string; args?: Record<string, unknown>; ok?: boolean; note?: string; waiting?: boolean };
export type Msg = { id: string; role: "user" | "assistant"; text: string; at: number; by?: string; brain?: Brain; steps?: Step[]; error?: boolean };
export type Approval = {
  id: string; tool: string; args: Record<string, unknown>; label: string; at: number;
  status: "waiting" | "done" | "declined" | "failed"; result?: string; by?: string;
};
export type Convo = {
  id: string; title: string; created: number; updated: number; by: string;
  msgs: Msg[]; approvals: Approval[];
  gemini?: unknown[]; // Gemini's own history (its tool calls and thought signatures), so a follow-up keeps context
  agy?: { conversation?: string; job?: string; msg?: string; seen?: number };
  running?: { brain: Brain; since: number } | null;
};
export type ConvoSummary = { id: string; title: string; updated: number; by: string; waiting: number };
export type Prefs = { brain: "auto" | Brain; agy?: { blob: string; email?: string | null; at: number } | null };

export const ASK_ACTOR: Actor = { name: "Ask Voicebox" };
export const CID_RE = /^[a-z0-9]{8,24}$/;
const DIR = "workspace/ask";
const INDEX = `${DIR}/index.json`;
const PREFS = `${DIR}/prefs.json`;
const MAX_CONVOS = 60;

export const newId = (n = 12) => Array.from(randomBytes(n), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

// ── what waits for a person

const ALWAYS = new Set(["delete_post", "delete_media", "delete_files", "delete_folder", "empty_trash", "update_settings", "train_voice", "cancel_job"]);
const TITLES: Record<string, string> = {
  delete_post: "Delete a post", delete_media: "Delete an upload", delete_files: "Move files to the trash", delete_folder: "Move a folder to the trash",
  empty_trash: "Empty the trash for good", update_settings: "Change settings", train_voice: "Train a voice model (GPU time)", cancel_job: "Cancel a running job",
  gpu: "GPU", engine: "Delete an engine's downloaded weights",
};

export function needsApproval(name: string, args: Record<string, unknown>) {
  if (ALWAYS.has(name)) return true;
  if (name === "gpu") return !!args.action && !["status", "notify_test"].includes(String(args.action));
  if (name === "engine") return args.action === "forget";
  return false;
}

function label(name: string, args: Record<string, unknown>) {
  if (name === "delete_files" && args.forever) return `Delete ${(args.items as unknown[])?.length ?? ""} file(s) for good`;
  if (name === "delete_files") return `Move ${(args.items as unknown[])?.length ?? ""} file(s) to the trash`;
  if (name === "gpu") return `GPU: ${String(args.action).replace(/_/g, " ")}${args.gpu ? ` (${args.gpu})` : ""}`;
  const t = TITLES[name] ?? name.replace(/_/g, " ");
  const brief = JSON.stringify(args);
  return brief === "{}" ? t : `${t}: ${brief.length > 120 ? brief.slice(0, 117) + "..." : brief}`;
}

/** A gate for one conversation: a risky call is parked as an approval and the assistant is told it's waiting. */
export const gateFor = (cid: string): Gate => async (name, args) => {
  if (!needsApproval(name, args)) return null;
  const a = await addApproval(cid, name, args);
  return { content: [{ type: "text", text: `WAITING FOR APPROVAL (${a.id}): "${a.label}" needs a person to click Approve in Ask Voicebox; it runs then. Tell them it's waiting; don't call it again.` }] };
};

/** The gate on /api/mcp?ask=1 (Antigravity on the worker): the conversation comes from the token. */
export const askGate: Gate = async (name, args, ctx) => {
  const cid = (ctx as { http?: { authInfo?: { extra?: { conversation?: string } } } } | undefined)?.http?.authInfo?.extra?.conversation;
  if (cid && CID_RE.test(cid)) return gateFor(cid)(name, args, ctx);
  return needsApproval(name, args) ? { content: [{ type: "text", text: "Not allowed from here: a person has to do this on the dashboard." }], isError: true } : null;
};

// ── tokens for Antigravity's MCP calls (one conversation, 45 minutes)

export const mintAskToken = (cid: string) => sign({ typ: "ask", cid, exp: Math.floor(Date.now() / 1000) + 45 * 60 });
export const verifyAskToken = (t: string) => verify<{ typ: "ask"; cid: string; exp: number }>(t, "ask") ?? null;

// ── the tools, in-process (Gemini's calls and approved actions run here)

export type LocalTool = { name: string; description: string; schema?: z.ZodType; cb: (args: unknown, ctx: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> };

export function localTools(who: Actor, gate?: Gate) {
  const tools = new Map<string, LocalTool>();
  const collector = {
    registerTool(name: string, config: { title?: string; description?: string; inputSchema?: z.ZodType }, cb: LocalTool["cb"]) {
      tools.set(name, { name, description: config.description ?? config.title ?? name, schema: config.inputSchema, cb });
    },
  } as unknown as ToolServer;
  registerTools(collector, who, gate);
  return tools;
}

/** Run one tool by name with raw arguments (validated like the MCP server does). Text out, capped. */
export async function runTool(tools: Map<string, LocalTool>, name: string, raw: unknown, cap = 24_000) {
  const t = tools.get(name);
  if (!t) return { ok: false, text: `ERROR: no tool called ${name}` };
  const parsed = t.schema ? t.schema.safeParse(raw ?? {}) : { success: true as const, data: {} };
  if (!parsed.success) return { ok: false, text: `ERROR: bad arguments for ${name}: ${parsed.error.message.slice(0, 800)}` };
  try {
    const r = await t.cb(parsed.data, {});
    const out = r.content.map((c) => c.text ?? "").join("\n");
    return { ok: !r.isError && !out.startsWith("WAITING FOR APPROVAL"), text: out.length > cap ? out.slice(0, cap) + `\n...(cut: ${out.length} chars)` : out, waiting: out.startsWith("WAITING FOR APPROVAL") };
  } catch (e) {
    return { ok: false, text: `ERROR: ${(e as Error).message}` };
  }
}

// ── storage

const key = (id: string) => `${DIR}/c/${id}.json`;

export async function getConvo(id: string) {
  if (!CID_RE.test(id)) return null;
  return getJson<Convo>(key(id)).catch(() => null);
}

export async function saveConvo(c: Convo) {
  c.updated = Date.now();
  await putJson(key(c.id), c);
  const idx = (await getJson<ConvoSummary[]>(INDEX).catch(() => null)) ?? [];
  const row: ConvoSummary = { id: c.id, title: c.title, updated: c.updated, by: c.by, waiting: c.approvals.filter((a) => a.status === "waiting").length };
  const next = [row, ...idx.filter((r) => r.id !== c.id)].sort((a, b) => b.updated - a.updated);
  const drop = next.slice(MAX_CONVOS);
  await putJson(INDEX, next.slice(0, MAX_CONVOS));
  if (drop.length) await delObjs(drop.map((r) => key(r.id))).catch(() => null);
  return c;
}

/** Change a conversation from its latest copy (Antigravity's MCP calls write approvals while a run is going). */
export async function updateConvo(id: string, fn: (c: Convo) => void) {
  const c = await getConvo(id);
  if (!c) throw new Error("no such conversation");
  fn(c);
  return saveConvo(c);
}

export const listConvos = async () => (await getJson<ConvoSummary[]>(INDEX).catch(() => null)) ?? [];

export async function deleteConvo(id: string) {
  if (!CID_RE.test(id)) return;
  await delObjs([key(id)]);
  const idx = await listConvos();
  await putJson(INDEX, idx.filter((r) => r.id !== id));
}

export function newConvo(firstText: string, by: string): Convo {
  const t = firstText.replace(/\s+/g, " ").trim();
  return { id: newId(), title: t.length > 60 ? t.slice(0, 57) + "..." : t || "New chat", created: Date.now(), updated: Date.now(), by, msgs: [], approvals: [] };
}

async function addApproval(cid: string, tool: string, args: Record<string, unknown>) {
  const a: Approval = { id: newId(8), tool, args, label: label(tool, args), at: Date.now(), status: "waiting" };
  await updateConvo(cid, (c) => {
    if (c.approvals.filter((x) => x.status === "waiting").length >= 20) throw new Error("20 actions are already waiting for approval");
    c.approvals.push(a);
  });
  return a;
}

/** Approve (run it now, as the person who clicked) or decline a parked action. */
export async function decide(cid: string, aid: string, approve: boolean, who: Actor) {
  const c = await getConvo(cid);
  const a = c?.approvals.find((x) => x.id === aid);
  if (!c || !a) throw new Error("that action isn't waiting any more");
  if (a.status !== "waiting") return c;
  if (!approve) {
    return updateConvo(cid, (x) => { const y = x.approvals.find((z) => z.id === aid)!; y.status = "declined"; y.by = who.name; });
  }
  await updateConvo(cid, (x) => { x.approvals.find((z) => z.id === aid)!.status = "done"; }); // claimed: a double click runs it once
  const r = await runTool(localTools({ name: `${who.name} (Ask Voicebox)`, id: who.id }), a.tool, a.args, 4000);
  return updateConvo(cid, (x) => {
    const y = x.approvals.find((z) => z.id === aid)!;
    y.status = r.ok ? "done" : "failed";
    y.result = r.text.slice(0, 2000);
    y.by = who.name;
    x.msgs.push({ id: newId(8), role: "assistant", at: Date.now(), text: r.ok ? `Done: ${a.label}.` : `That didn't work: ${r.text.replace(/^ERROR:\s*/, "").slice(0, 400)}`, error: !r.ok });
  });
}

/** What happened to parked actions since the assistant last spoke, for the next prompt. */
export function approvalNotes(c: Convo, since: number) {
  const lines = c.approvals.filter((a) => a.status !== "waiting" && a.at >= since - 36e5).map((a) => `- ${a.label}: ${a.status}${a.by ? ` by ${a.by}` : ""}${a.result ? ` (${a.result.slice(0, 200)})` : ""}`);
  return lines.length ? `Actions that needed approval:\n${lines.join("\n")}\n\n` : "";
}

// ── preferences (which brain; Antigravity's saved sign-in, encrypted)

export async function getPrefs(): Promise<Prefs> {
  return (await getJson<Prefs>(PREFS).catch(() => null)) ?? { brain: "auto" };
}
export async function setPrefs(p: Partial<Prefs>) {
  const next = { ...(await getPrefs()), ...p };
  await putJson(PREFS, next);
  return next;
}

const boxKey = () => createHash("sha256").update(`voicebox-ask-agy-v1:${process.env.ASK_SECRET || process.env.MCP_TOKEN || ""}`).digest();

/** Antigravity's sign-in files, sealed so R2 alone never holds a usable Google login. */
export function seal(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", boxKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}
export function unseal(sealed: string) {
  try {
    const [iv, tag, body] = sealed.split(".").map((s) => Buffer.from(s, "base64url"));
    const d = createDecipheriv("aes-256-gcm", boxKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const geminiReady = () => !!process.env.GEMINI_API_KEY;
