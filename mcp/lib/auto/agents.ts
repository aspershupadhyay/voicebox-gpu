// Agents and audit (docs/AUTOMATION.md, block 9 and the learning loop). Roles are named jobs (researcher, editor,
// publisher, auditor) with the model meant for them, the tools they may use (enforced when a client sends X-Role) and
// a brief. Scorecards come from the call log: per model and per role, calls, how many worked, QA verdicts, redos,
// approvals hit. The audit reads a period of the log, finds what keeps going wrong (the same error again and again, QA
// fails, the owner saying no, work done twice) and writes suggested lessons with the evidence; an auditor model can
// read the same evidence (packet) and add its own. The owner approves lessons; playbook serves them to every model.
import { getJson } from "../store";
import { listApprovals, mutate, readLog, type LogEntry } from "./control";
import { addLesson, type Evidence } from "./memory";

export type Role = { name: string; model: string; purpose: string; tools: string[]; brief: string; by: string; at: number };
const ROLES = "auto/roles.json";

const READ = ["playbook", "memory", "control", "approvals", "get_job", "list_jobs", "worker_status"];
export const DEFAULT_ROLES: Omit<Role, "by" | "at">[] = [
  { name: "researcher", model: "any", purpose: "Finds what to post: Radar, keywords, rivals, the web; writes ideas and drafts.",
    tools: [...READ, "radar", "keyword_research", "radar_watch", "seo_score", "title_lab", "hook_score", "analytics", "weekly_digest", "browse", "run",
      "workspace_board", "content_calendar", "create_post", "update_post", "comment_on_post", "get_post", "workspace_activity", "list_files", "get_file", "download", "downloads"],
    brief: "Read playbook (search the topic) first. Quote Radar's and keyword_research's numbers with their parts; never invent volumes. Ideas go on the board as status idea, with why in the notes." },
  { name: "editor", model: "any", purpose: "Makes the pieces: voice, edits, captions, templates, repurposing; checks every render.",
    tools: [...READ, "voice_lines", "preview_pronunciation", "list_voices", "my_voices", "clean_audio", "revoice", "transcribe", "imagine", "edit_video", "inspect_media",
      "repurpose", "video_template", "run", "browse", "list_files", "get_file", "save_file", "add_media", "upload_media", "get_post", "update_post", "attach_voiceover", "carousels", "captions"],
    brief: "Every render gets QA (edit_video does it): fix FAIL lines before handing over. Check 390 px. Captions inside the safe zone. Save results in the post's folder." },
  { name: "publisher", model: "any", purpose: "Packages and schedules posts; never publishes now without the owner.",
    tools: [...READ, "post_package", "publish_post", "publish_status", "publish_accounts", "auto_post", "automation_rules", "content_calendar", "workspace_board", "get_post",
      "update_post", "captions", "analytics", "list_files", "get_file", "carousels"],
    brief: "Every arm gets the post package first (title, description, hashtags, the credit). Publishing now goes straight out (no approval since 2026-11-01): only when the user asked. Check publish_status after." },
  { name: "auditor", model: "the strongest", purpose: "Reviews the other models' work, writes lessons with evidence, reviews PRs.",
    tools: [...READ, "audit", "agents", "workflow", "repo", "inspect_media", "browse", "run", "list_files", "get_file", "analytics"],
    brief: "Start with audit action=packet for the period. A lesson is one sentence a model can follow next time, with the evidence. Don't re-suggest rejected lessons." },
];

export async function roles(): Promise<Role[]> {
  const saved = (await getJson<{ list: Role[] }>(ROLES).catch(() => null))?.list;
  return saved?.length ? saved : DEFAULT_ROLES.map((r) => ({ ...r, by: "default", at: 0 }));
}
export async function role(name: string) { return (await roles()).find((r) => r.name === name.toLowerCase()) ?? null; }

export async function saveRole(r: Partial<Role> & { name: string }, by: string) {
  const name = r.name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error("name: a short word, e.g. researcher");
  const cur = await roles();
  const have = cur.find((x) => x.name === name);
  const next: Role = { name, model: (r.model ?? have?.model ?? "any").slice(0, 60), purpose: (r.purpose ?? have?.purpose ?? "").slice(0, 300),
    tools: (r.tools ?? have?.tools ?? []).slice(0, 120), brief: (r.brief ?? have?.brief ?? "").slice(0, 2000), by, at: Date.now() };
  await mutate<{ list: Role[] }>(ROLES, { list: [] }, () => ({ list: [next, ...cur.filter((x) => x.name !== name)].slice(0, 20) }));
  return next;
}

// ── scorecards ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Card = { who: string; calls: number; ok: number; failed: number; gated: number; qa: { pass: number; warn: number; fail: number }; redos: number; tools: Record<string, number>; last: number };

const sameCall = (a: LogEntry, b: LogEntry) => a.tool === b.tool && a.model === b.model;

/** Per model (and role, when the client named one): what it did over the period and how it went. A redo is the same
 *  tool called again by the same model within an hour after a failure or a QA FAIL. */
export function scorecards(log: LogEntry[], by: "model" | "role" = "model") {
  const cards = new Map<string, Card>();
  const sorted = [...log].sort((a, b) => a.t - b.t);
  sorted.forEach((e, i) => {
    const who = by === "role" ? e.role ?? "(no role)" : e.model;
    const c = cards.get(who) ?? { who, calls: 0, ok: 0, failed: 0, gated: 0, qa: { pass: 0, warn: 0, fail: 0 }, redos: 0, tools: {}, last: 0 };
    c.calls++; c.last = Math.max(c.last, e.t); c.tools[e.tool] = (c.tools[e.tool] ?? 0) + 1;
    if (e.gate) c.gated++; else if (e.ok) c.ok++; else c.failed++;
    if (e.qa === "PASS") c.qa.pass++; else if (e.qa === "WARN") c.qa.warn++; else if (e.qa === "FAIL") c.qa.fail++;
    if ((!e.ok && !e.gate) || e.qa === "FAIL") {
      const again = sorted.slice(i + 1).find((x) => sameCall(x, e) && x.t - e.t < 3600_000);
      if (again) c.redos++;
    }
    cards.set(who, c);
  });
  return [...cards.values()].sort((a, b) => b.calls - a.calls).map((c) => ({
    ...c, ok_rate: c.calls ? Math.round((c.ok / Math.max(1, c.calls - c.gated)) * 100) : null,
    qa_pass_rate: c.qa.pass + c.qa.warn + c.qa.fail ? Math.round(((c.qa.pass + c.qa.warn) / (c.qa.pass + c.qa.warn + c.qa.fail)) * 100) : null,
    tools: Object.entries(c.tools).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} ${n}`),
  }));
}

// ── the audit ───────────────────────────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.replace(/\b[a-f0-9]{10,}\b/g, "<id>").replace(/\d+(\.\d+)?/g, "<n>").replace(/\s+/g, " ").slice(0, 120);
const ev = (e: LogEntry, what: string): Evidence => ({ at: e.t, model: e.model, tool: e.tool, what: what.slice(0, 200) });

/** What the period's log says, as findings with evidence; the rule-based ones also become suggested lessons. */
export async function audit(hours = 24, write = true) {
  const since = Date.now() - hours * 3600_000;
  const log = await readLog({ limit: 1000, since, days: Math.ceil(hours / 24) + 1 });
  const work = log.filter((e) => e.via !== "audit");
  const findings: { kind: string; lesson: string; topic: string; evidence: Evidence[]; count: number }[] = [];

  // the same failure again and again: a model keeps calling a tool wrong
  const fails = new Map<string, LogEntry[]>();
  for (const e of work) if (!e.ok && !e.gate && e.err) { const k = `${e.tool}|${norm(e.err.replace(/^ERROR: /, ""))}`; fails.set(k, [...(fails.get(k) ?? []), e]); }
  for (const [k, es] of fails) {
    if (es.length < 3) continue;
    const [tool, err] = k.split("|");
    findings.push({ kind: "repeated error", topic: tool, count: es.length, evidence: es.slice(0, 5).map((e) => ev(e, e.err ?? "")),
      lesson: `${tool}: it failed ${es.length} times with "${err.slice(0, 90)}". Read the error's next step (or playbook) before calling it again with the same arguments.` });
  }
  // QA that fails: the same check failing across renders
  const qaFails = new Map<string, LogEntry[]>();
  for (const e of work) for (const c of e.qa_fail ?? []) qaFails.set(`${e.tool}|${c}`, [...(qaFails.get(`${e.tool}|${c}`) ?? []), e]);
  for (const [k, es] of qaFails) {
    if (es.length < 2) continue;
    const [tool, check] = k.split("|");
    findings.push({ kind: "QA fails", topic: tool, count: es.length, evidence: es.slice(0, 5).map((e) => ev(e, `QA FAIL ${check}`)),
      lesson: tool === "inspect_media"
        ? `Files checked for posting keep failing QA on "${check}" (${es.length} times): fix it with edit_video (its platform preset sets the shape and -14 LUFS) before arming a post.`
        : `${tool}: renders keep failing QA on "${check}" (${es.length} times). Set it right in the spec before rendering (the platform preset, the safe zones) instead of fixing it after.` });
  }
  // the owner said no
  const denied = (await listApprovals()).filter((a) => a.status === "denied" && (a.decided ?? 0) >= since);
  for (const a of denied)
    findings.push({ kind: "owner said no", topic: a.tool ?? a.action, count: 1, evidence: [{ at: a.decided ?? a.created, model: a.by, tool: a.tool ?? a.action, what: `denied: ${a.summary}${a.note ? ` (${a.note})` : ""}` }],
      lesson: `The owner refused "${a.summary.slice(0, 120)}"${a.note ? `: ${a.note}` : ""}. Don't ask for it again without a new reason.` });
  // work done twice: the same edit or render sent again and again
  const redo = new Map<string, LogEntry[]>();
  for (const e of work) if (["edit_video", "repurpose", "video_template", "voice_lines", "imagine"].includes(e.tool) && e.args) redo.set(`${e.model}|${e.tool}|${e.args}`, [...(redo.get(`${e.model}|${e.tool}|${e.args}`) ?? []), e]);
  for (const [k, es] of redo) {
    if (es.length < 3) continue;
    const [model, tool] = k.split("|");
    findings.push({ kind: "same work repeated", topic: tool, count: es.length, evidence: es.slice(0, 3).map((e) => ev(e, `same arguments again: ${e.args?.slice(0, 120)}`)),
      lesson: `${tool}: ${model} sent the identical request ${es.length} times. Check get_job or Files for the earlier result before making it again.` });
  }

  const lessons = [];
  if (write) for (const f of findings.filter((x) => x.kind !== "owner said no" || x.evidence.length))
    lessons.push(await addLesson({ text: f.lesson, topic: f.topic, evidence: f.evidence, by: "audit (rules)" }));
  return { period_h: hours, calls: log.length, scorecards: scorecards(work), by_role: scorecards(work, "role"), findings, lessons: lessons.map((l) => ({ id: l.id, text: l.text, seen: l.seen, status: l.status })) };
}

/** The evidence for an auditor model: the period's failures, QA verdicts, approvals, and per-model cards, short. */
export async function packet(hours = 24) {
  const since = Date.now() - hours * 3600_000;
  const log = await readLog({ limit: 1000, since, days: Math.ceil(hours / 24) + 1 });
  const approvals = (await listApprovals()).filter((a) => a.created >= since);
  const { lessons } = await import("./memory");
  const known = await lessons();
  return {
    period_h: hours, scorecards: scorecards(log),
    failures: log.filter((e) => !e.ok && !e.gate).slice(0, 60).map((e) => ({ at: new Date(e.t).toISOString().slice(0, 16), model: e.model, tool: e.tool, args: e.args?.slice(0, 160), err: e.err?.slice(0, 200) })),
    qa: log.filter((e) => e.qa).slice(0, 40).map((e) => ({ at: new Date(e.t).toISOString().slice(0, 16), model: e.model, tool: e.tool, qa: e.qa, failed: e.qa_fail })),
    approvals: approvals.map((a) => ({ what: a.summary, by: a.by, status: a.status, note: a.note })),
    lessons_already: known.filter((l) => l.status !== "rejected").slice(0, 40).map((l) => `${l.status}: ${l.text}`),
    rejected: known.filter((l) => l.status === "rejected").slice(0, 20).map((l) => l.text),
    next: "Write each new lesson with memory action=lesson_add (text: one sentence a model can follow, topic: the tool or area, evidence: the lines above). Don't repeat lessons_already or rejected.",
  };
}
