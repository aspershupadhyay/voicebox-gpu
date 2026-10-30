// Automations (docs/AUTOMATION.md, phase 7): saved workflows of steps over the MCP tools, run on a schedule (the
// 10-minute sweep), on events (a download lands, a post goes live) or by hand, with nobody there. A step calls a tool
// through the same guarded path as a model (lib/auto/wrap.ts: the call log, the kill switch, the units cap, the
// approvals), so a workflow can't do what a model couldn't. Long jobs and approvals park the run; the sweep moves it
// on. Steps pass results along with {{steps.<as>.<path>}}; foreach runs a step per item of a list.
import { randomBytes } from "node:crypto";
import { getJson, putJson } from "../store";
import { getApproval, getControl, mutate } from "./control";

export type Step = {
  tool: string; args?: Record<string, unknown>; as?: string; wait?: boolean; if?: string;
  foreach?: string; limit?: number; continue_on_error?: boolean;
};
export type Schedule = { every: "hour" | "day" | "week"; at?: string; days?: number[]; tz?: string };
export const EVENTS = { "download.done": "a download landed in Files", "post.live": "a post went live (YouTube or Instagram)" } as const;
export type EventName = keyof typeof EVENTS;
export type Trigger = { event: EventName; delay_h?: number; match?: Record<string, string> };
export type Flow = {
  id: string; name: string; about?: string; steps: Step[]; schedule?: Schedule | null; triggers?: Trigger[]; input?: Record<string, unknown>;
  enabled: boolean; by: string; created: number; updated: number; next_run?: number | null; last?: { run: string; status: string; at: number } | null;
};
type Log = { at: number; step: number; tool?: string; ok: boolean; note: string };
export type Run = {
  id: string; flow: string; name: string; status: "running" | "waiting" | "done" | "error" | "stopped";
  steps: Step[]; i: number; sub: number; items?: unknown[] | null; partial?: unknown[];
  results: Record<string, unknown>; input: Record<string, unknown>; event?: Record<string, unknown> | null;
  wait?: { job?: string; approval?: string; args?: Record<string, unknown>; why?: string } | null;
  log: Log[]; trigger: string; by: string; started: number; updated: number; finished?: number; not_before?: number; error?: string;
};

const FLOWS = "auto/flows.json";
const RUNS = "auto/runs.json";
const runKey = (id: string) => `auto/runs/${id}.json`;
const MAX_STEPS = 40, MAX_EACH = 20;
const NO_STEP = new Set(["workflow"]); // a workflow doesn't start workflows (no loops)

// ── workflows ───────────────────────────────────────────────────────────────────────────────────────────────────

export async function listFlows(): Promise<Flow[]> {
  return (await getJson<{ list: Flow[] }>(FLOWS).catch(() => null))?.list ?? [];
}
export async function getFlow(ref: string) {
  const all = await listFlows();
  return all.find((f) => f.id === ref) ?? all.find((f) => f.name.toLowerCase() === ref.toLowerCase()) ?? null;
}

export function check(f: { name?: unknown; steps?: unknown; schedule?: unknown; triggers?: unknown }) {
  const name = String(f.name ?? "").trim();
  if (!name || name.length > 80) throw new Error("name: 1 to 80 characters");
  const steps = f.steps as Step[];
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) throw new Error(`steps: 1 to ${MAX_STEPS}`);
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    if (!s || typeof s.tool !== "string") throw new Error(`step ${i + 1}: tool is required`);
    if (NO_STEP.has(s.tool)) throw new Error(`step ${i + 1}: a workflow can't call ${s.tool}`);
    if (s.as) { if (!/^[a-z][a-z0-9_]{0,30}$/.test(s.as)) throw new Error(`step ${i + 1}: as is a short name (letters, digits, _)`); seen.add(s.as); }
    if (s.limit != null && (s.limit < 1 || s.limit > MAX_EACH)) throw new Error(`step ${i + 1}: limit 1 to ${MAX_EACH}`);
  });
  const sc = f.schedule as Schedule | null | undefined;
  if (sc) {
    if (!["hour", "day", "week"].includes(sc.every)) throw new Error("schedule.every: hour, day or week");
    if (sc.at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(sc.at)) throw new Error("schedule.at: HH:MM");
    if (sc.tz) { try { new Intl.DateTimeFormat("en", { timeZone: sc.tz }); } catch { throw new Error(`schedule.tz: ${sc.tz} isn't a time zone (e.g. Asia/Kolkata)`); } }
  }
  for (const t of (f.triggers as Trigger[] | undefined) ?? []) if (!(t.event in EVENTS)) throw new Error(`triggers: event is one of ${Object.keys(EVENTS).join(", ")}`);
  return { name, steps };
}

/** Steps that publish: a workflow with these and a schedule or a trigger needs the owner's approval to save. */
export const publishes = (steps: Step[]) =>
  steps.some((s) => (s.tool === "publish_post" && ["now", "arm", "share_to_story"].includes(String(s.args?.go))) || (s.tool === "auto_post" && ["now", "arm"].includes(String(s.args?.go ?? "arm"))) || s.tool === "automation_rules");

export async function saveFlow(input: Partial<Flow> & { id?: string }, by: string) {
  const { name, steps } = check(input);
  let out: Flow | null = null;
  await mutate<{ list: Flow[] }>(FLOWS, { list: [] }, (b) => {
    const have = b.list.find((f) => f.id === input.id || (!input.id && f.name.toLowerCase() === name.toLowerCase()));
    const now = Date.now();
    const f: Flow = {
      id: have?.id ?? randomBytes(5).toString("hex"), name, about: input.about?.slice(0, 300) ?? have?.about, steps,
      schedule: input.schedule === undefined ? have?.schedule ?? null : input.schedule, triggers: input.triggers ?? have?.triggers ?? [],
      input: input.input ?? have?.input ?? {}, enabled: input.enabled ?? have?.enabled ?? true, by: have?.by ?? by,
      created: have?.created ?? now, updated: now, last: have?.last ?? null, next_run: null,
    };
    if (f.schedule && f.enabled) f.next_run = nextRun(f.schedule, now);
    out = f;
    return { list: [f, ...b.list.filter((x) => x.id !== f.id)].slice(0, 100) };
  });
  return out!;
}

export async function deleteFlow(id: string) {
  await mutate<{ list: Flow[] }>(FLOWS, { list: [] }, (b) => ({ list: b.list.filter((f) => f.id !== id) }));
}

export async function setEnabled(id: string, enabled: boolean) {
  await mutate<{ list: Flow[] }>(FLOWS, { list: [] }, (b) => ({
    list: b.list.map((f) => (f.id === id ? { ...f, enabled, next_run: enabled && f.schedule ? nextRun(f.schedule, Date.now()) : null } : f)),
  }));
}

// ── time zones and schedules ────────────────────────────────────────────────────────────────────────────────────

function parts(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour, M: +p.minute, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
/** The UTC instant of a wall-clock time in a zone (offset found from the zone itself, so summer time is right). */
function zoned(y: number, m: number, d: number, H: number, M: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, H, M);
  const p = parts(guess, tz);
  const off = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M) - guess;
  return guess - off;
}

/** The next time a schedule fires after `from`. */
export function nextRun(s: Schedule, from: number) {
  const tz = s.tz || "UTC";
  const [H, M] = (s.at ?? "09:00").split(":").map(Number);
  if (s.every === "hour") {
    const p = parts(from, tz);
    let t = zoned(p.y, p.m, p.d, p.H, M, tz);
    while (t <= from) t += 3600_000;
    return t;
  }
  for (let i = 0; i < 9; i++) {
    const p = parts(from + i * 86_400_000, tz);
    if (s.every === "week" && !(s.days?.length ? s.days : [1]).includes(p.dow)) continue;
    const t = zoned(p.y, p.m, p.d, H, M, tz);
    if (t > from) return t;
  }
  return from + 7 * 86_400_000;
}

// ── runs ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Summary = { id: string; flow: string; name: string; status: Run["status"]; trigger: string; started: number; updated: number; error?: string };
export async function listRuns() { return (await getJson<{ list: Summary[] }>(RUNS).catch(() => null))?.list ?? []; }
export const getRun = (id: string) => getJson<Run>(runKey(id)).catch(() => null);

async function saveRun(r: Run) {
  r.updated = Date.now();
  await putJson(runKey(r.id), r);
  await mutate<{ list: Summary[] }>(RUNS, { list: [] }, (b) => ({
    list: [{ id: r.id, flow: r.flow, name: r.name, status: r.status, trigger: r.trigger, started: r.started, updated: r.updated, ...(r.error ? { error: r.error } : {}) },
      ...b.list.filter((x) => x.id !== r.id)].slice(0, 200),
  }));
  if (r.status === "done" || r.status === "error" || r.status === "stopped")
    await mutate<{ list: Flow[] }>(FLOWS, { list: [] }, (b) => ({ list: b.list.map((f) => (f.id === r.flow ? { ...f, last: { run: r.id, status: r.status, at: r.updated } } : f)) })).catch(() => null);
}

export async function startRun(flow: Flow, o: { trigger: string; by: string; input?: Record<string, unknown>; event?: Record<string, unknown>; delay_h?: number }) {
  const now = Date.now();
  const r: Run = {
    id: randomBytes(6).toString("hex"), flow: flow.id, name: flow.name, status: "running", steps: flow.steps, i: 0, sub: 0, results: {},
    input: { ...(flow.input ?? {}), ...(o.input ?? {}) }, event: o.event ?? null, log: [], trigger: o.trigger, by: o.by, started: now, updated: now,
    ...(o.delay_h ? { not_before: now + o.delay_h * 3600_000 } : {}),
  };
  await saveRun(r);
  return r;
}

export async function stopRun(id: string, by: string) {
  const r = await getRun(id);
  if (!r) throw new Error("no such run");
  if (["done", "error", "stopped"].includes(r.status)) return r;
  r.status = "stopped"; r.finished = Date.now(); r.error = `stopped by ${by}`;
  await saveRun(r);
  return r;
}

// ── templating ──────────────────────────────────────────────────────────────────────────────────────────────────

function lookup(scope: Record<string, unknown>, path: string): unknown {
  let cur: unknown = scope;
  for (const k of path.trim().split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && k === "length") return cur.length;
    cur = (cur as Record<string, unknown>)[/^\d+$/.test(k) && Array.isArray(cur) ? Number(k) : k];
  }
  return cur;
}

/** {{path}} in a string; a string that is only {{path}} keeps the value's own type (a list stays a list). */
export function fill(v: unknown, scope: Record<string, unknown>): unknown {
  if (typeof v === "string") {
    const whole = v.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (whole) return lookup(scope, whole[1]);
    return v.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, p) => { const x = lookup(scope, p); return x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x); });
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, scope));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, scope)]));
  return v;
}

const truthy = (v: unknown) => !(v == null || v === false || v === 0 || v === "" || v === "false" || (Array.isArray(v) && !v.length));

// ── running tools in-process, guarded like a model's call ───────────────────────────────────────────────────────

type Entry = { schema?: { safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } }; handler: (a: unknown, ctx: unknown) => Promise<{ content: { text?: string }[]; isError?: boolean }> };
const REGS = new Map<string, Map<string, Entry>>();

/** Every tool, guarded and logged as coming `via` this path (a workflow, the lean endpoint). */
export async function registry(via = "workflow") {
  const have = REGS.get(via);
  if (have) return have;
  const reg = new Map<string, Entry & { description?: string; title?: string }>();
  const stub = { registerTool: (name: string, cfg: { inputSchema?: Entry["schema"]; description?: string; title?: string }, handler: Entry["handler"]) => { reg.set(name, { schema: cfg.inputSchema, handler, description: cfg.description, title: cfg.title }); } };
  const { guarded } = await import("./wrap");
  const g = guarded(stub as never, via);
  (await import("../mcptools")).registerTools(g, { name: via === "workflow" ? "Workflow" : "Claude (MCP)" });
  (await import("./tools")).registerAutoTools(g);
  REGS.set(via, reg);
  return reg;
}

/** Call a tool in-process. ctx carries the caller's headers (X-Model, X-Role) when there is a caller. */
export async function callTool(tool: string, args: unknown, model: string, via = "workflow", ctx?: unknown): Promise<{ ok: boolean; value: unknown; text: string }> {
  const e = (await registry(via)).get(tool);
  if (!e) return { ok: false, value: null, text: `no tool called ${tool}` };
  const parsed = e.schema ? e.schema.safeParse(args ?? {}) : { success: true, data: args };
  if (!parsed.success) return { ok: false, value: null, text: `bad arguments for ${tool}: ${parsed.error!.issues.map((i) => `${i.path.join(".") || "(args)"} ${i.message}`).join("; ")}` };
  const c = ctx ?? { http: { req: new Request("https://workflow.local/", { headers: { "x-model": model } }), authInfo: { clientId: via } } };
  const res = await e.handler(parsed.data, c);
  const text = res.content.map((x) => x.text ?? "").join("\n");
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* plain text */ }
  return { ok: !res.isError, value, text };
}

const jobOf = (v: unknown) => {
  const o = v as { job_id?: string; id?: string; status?: string } | null;
  const id = o?.job_id ?? (typeof o?.id === "string" && /^[a-f0-9]{12}$/.test(o.id) ? o.id : undefined);
  return id && (o?.status === "queued" || o?.status === "running") ? id : null;
};

/** Move one run along until it finishes, parks (a job or an approval), or the time is up. */
export async function advance(r: Run, until: number): Promise<Run> {
  if (!["running", "waiting"].includes(r.status)) return r;
  if (r.not_before && Date.now() < r.not_before) return r;
  const c = await getControl();
  if (c.paused) { if (r.status !== "waiting" || r.wait?.why !== "paused") { r.status = "waiting"; r.wait = { why: "paused" }; await saveRun(r); } return r; }
  const model = `workflow:${r.name}`.slice(0, 60);
  const note = (step: number, ok: boolean, msg: string, tool?: string) => { r.log.push({ at: Date.now(), step: step + 1, tool, ok, note: msg.slice(0, 300) }); r.log = r.log.slice(-200); };
  const done = (value: unknown) => {
    const s = r.steps[r.i];
    if (s.foreach) {
      (r.partial ??= []).push(value);
      r.sub++;
      if (r.sub >= (r.items?.length ?? 0)) { if (s.as) r.results[s.as] = r.partial; r.i++; r.sub = 0; r.items = null; r.partial = []; }
    } else {
      if (s.as) r.results[s.as] = value;
      r.i++;
    }
  };
  if (r.wait?.why === "paused") r.wait = null;
  r.status = "running";
  while (Date.now() < until) {
    if (r.wait?.job) {
      const j = await callTool("get_job", { job_id: r.wait.job, wait_seconds: Math.max(0, Math.min(40, Math.floor((until - Date.now()) / 1000) - 5)) }, model);
      const st = (j.value as { status?: string })?.status;
      if (st === "queued" || st === "running") { r.status = "waiting"; await saveRun(r); return r; }
      note(r.i, j.ok && st !== "error", j.ok ? `job ${r.wait.job} ${st}` : j.text, "get_job");
      r.wait = null;
      if ((!j.ok || st === "error") && !r.steps[r.i].continue_on_error) { r.status = "error"; r.error = `step ${r.i + 1}: the job ${st ?? "failed"}: ${j.text.slice(0, 200)}`; break; }
      done(j.value);
      continue;
    }
    if (r.wait?.approval) {
      const a = await getApproval(r.wait.approval);
      if (a?.status === "pending") { r.status = "waiting"; await saveRun(r); return r; }
      if (a?.status !== "approved") { r.status = "error"; r.error = `step ${r.i + 1}: the owner ${a?.status === "denied" ? "said no" : `didn't decide (${a?.status ?? "gone"})`}`; break; }
    }
    const s = r.steps[r.i];
    if (!s) { r.status = "done"; break; }
    const scope = { steps: r.results, input: r.input, event: r.event ?? {}, now: new Date().toISOString(), today: new Date().toISOString().slice(0, 10) };
    // if: "{{steps.x.y}}" runs the step when that's set (non-empty); "!{{…}}" when it isn't
    const neg = !!s.if?.startsWith("!");
    if (s.if && !r.sub && truthy(fill(s.if.replace(/^!/, ""), scope)) === neg) {
      note(r.i, true, `skipped (${s.if} is ${neg ? "set" : "empty"})`, s.tool);
      r.i++;
      continue;
    }
    let item: unknown;
    if (s.foreach) {
      if (r.items == null) {
        const list = fill(s.foreach, scope);
        r.items = Array.isArray(list) ? list.slice(0, Math.min(s.limit ?? MAX_EACH, MAX_EACH)) : [];
        r.sub = 0; r.partial = [];
        if (!r.items.length) { note(r.i, true, "nothing to go through", s.tool); if (s.as) r.results[s.as] = []; r.i++; r.items = null; continue; }
      }
      item = r.items[r.sub];
    }
    const args = r.wait?.approval ? { ...(r.wait.args ?? {}), approval_id: r.wait.approval } : (fill(s.args ?? {}, { ...scope, item, index: r.sub }) as Record<string, unknown>);
    r.wait = null;
    const res = await callTool(s.tool, args, model);
    const ap = res.text.match(/NEEDS APPROVAL \(id ([a-f0-9]{10})\)/);
    if (ap) { r.wait = { approval: ap[1], args }; r.status = "waiting"; note(r.i, true, `waiting for the owner's approval (${ap[1]})`, s.tool); await saveRun(r); return r; }
    if (res.text.startsWith("PAUSED")) { r.status = "waiting"; r.wait = { why: "paused" }; await saveRun(r); return r; }
    if (!res.ok) {
      note(r.i, false, res.text, s.tool);
      if (!s.continue_on_error) { r.status = "error"; r.error = `step ${r.i + 1} (${s.tool}): ${res.text.slice(0, 300)}`; break; }
      done({ error: res.text.slice(0, 500) });
      continue;
    }
    const job = s.wait === false ? null : jobOf(res.value);
    note(r.i, true, job ? `started job ${job}` : `ok${s.foreach ? ` (${r.sub + 1} of ${r.items?.length})` : ""}`, s.tool);
    if (job) { r.wait = { job }; continue; }
    done(res.value);
  }
  if (r.status === "done" || r.status === "error") r.finished = Date.now();
  else if (r.wait) r.status = "waiting"; // out of time while a job or the owner is still busy
  await saveRun(r);
  return r;
}

/** The sweep's part: due schedules start, then every open run moves along while there's time. */
export async function sweep(budgetMs = 60_000) {
  const until = Date.now() + budgetMs;
  const now = Date.now();
  const c = await getControl();
  const out = { started: 0, advanced: 0 };
  if (!c.paused) {
    for (const f of await listFlows()) {
      if (!f.enabled || !f.schedule) continue;
      if (!f.next_run) { await mutate<{ list: Flow[] }>(FLOWS, { list: [] }, (b) => ({ list: b.list.map((x) => (x.id === f.id ? { ...x, next_run: nextRun(f.schedule!, now) } : x)) })); continue; }
      if (f.next_run > now) continue;
      await mutate<{ list: Flow[] }>(FLOWS, { list: [] }, (b) => ({ list: b.list.map((x) => (x.id === f.id ? { ...x, next_run: nextRun(f.schedule!, now + 60_000) } : x)) }));
      await startRun(f, { trigger: "schedule", by: "schedule" });
      out.started++;
    }
  }
  for (const s of (await listRuns()).filter((x) => x.status === "running" || x.status === "waiting").reverse()) {
    if (Date.now() > until) break;
    const r = await getRun(s.id);
    if (!r) continue;
    await advance(r, Math.min(until, Date.now() + 45_000));
    out.advanced++;
  }
  return out;
}

/** Something happened: every enabled workflow listening for it starts (after its delay). Never throws. */
export async function emit(event: EventName, data: Record<string, unknown>) {
  try {
    if ((await getControl()).paused) return 0;
    let n = 0;
    for (const f of await listFlows()) {
      if (!f.enabled) continue;
      for (const t of f.triggers ?? []) {
        if (t.event !== event) continue;
        if (t.match && Object.entries(t.match).some(([k, v]) => String(data[k] ?? "").toLowerCase() !== String(v).toLowerCase())) continue;
        await startRun(f, { trigger: event, by: "trigger", event: data, delay_h: t.delay_h });
        n++;
      }
    }
    return n;
  } catch (e) {
    console.warn("workflow trigger:", (e as Error).message);
    return 0;
  }
}

/** Ready-made workflows a model (or the owner) can save as they are or adapt. */
export const EXAMPLES: Record<string, Omit<Flow, "id" | "by" | "created" | "updated" | "enabled">> = {
  morning_ideas: {
    name: "Morning ideas", about: "Every morning: Radar's hottest topics that fit become 3 idea drafts on the board.",
    schedule: { every: "day", at: "07:30", tz: "Asia/Kolkata" },
    steps: [
      { tool: "radar", args: {}, as: "radar" },
      { tool: "create_post", foreach: "{{steps.radar.blips}}", limit: 3, as: "drafts",
        args: { title: "{{item.topic}}", status: "idea", notes: "From Radar {{today}}: {{item.why}}\nAngles: {{item.angles}}" } },
    ],
  },
  check_downloads: {
    name: "Check new downloads", about: "When a download lands, each video is QA-checked for Reels and gets a contact sheet in Files.",
    triggers: [{ event: "download.done" }],
    steps: [{ tool: "inspect_media", foreach: "{{event.files}}", limit: 5, args: { file: "{{item}}", checks: ["probe", "qa", "sheet"] }, as: "checks", continue_on_error: true }],
  },
  check_after_48h: {
    name: "48 hours after a post goes live", about: "Reads the post's numbers 48 h after it went live, against the usual.",
    triggers: [{ event: "post.live", delay_h: 48 }],
    steps: [{ tool: "analytics", args: { view: "overview", range: 7 }, as: "numbers" }],
  },
  nightly_audit: {
    name: "Nightly audit", about: "Every night: the day's calls reviewed; what keeps going wrong becomes suggested lessons for the owner.",
    schedule: { every: "day", at: "23:40", tz: "Asia/Kolkata" },
    steps: [{ tool: "audit", args: { action: "run", hours: 24 }, as: "audit" }],
  },
  translate_and_dub: {
    name: "Translate and dub", about: "Hears a video, then stops for the model to translate the words (input.script) and voices and lays them on. Run with input {video, script, voice}.",
    steps: [
      { tool: "voice_lines", args: { lines: [{ text: "{{input.script}}" }], voice: "{{input.voice}}" }, as: "vo" },
      { tool: "repurpose", args: { recipe: "add_voiceover", inputs: { v: "{{input.video}}", vo: "g:{{steps.vo.id}}" }, options: { voice: "vo", original_volume_db: "mute" } }, as: "dubbed" },
    ],
  },
};
