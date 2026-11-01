// The automation suite's safety layer (docs/AUTOMATION.md, phase 1): the owner's switches (kill switch, the day's
// Colab units cap, which actions ask first), the approvals inbox, and the call log of every MCP call with the model
// that made it. Everything lives in R2 under auto/; writes that several calls race on use conditional puts.
import { randomBytes } from "node:crypto";
import { getJson, getJsonTagged, listObjs, putJsonIf } from "../store";

const CONTROL = "auto/control.json";
const APPROVALS = "auto/approvals.json";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read, change, write back only if nobody wrote in between (else read again): for files several calls append to. */
export async function mutate<T>(key: string, empty: T, fn: (cur: T) => T | Promise<T>): Promise<T> {
  for (let i = 0; i < 8; i++) {
    const { value, etag } = await getJsonTagged<T>(key);
    const next = await fn(value ?? structuredClone(empty));
    if (await putJsonIf(key, next, etag)) return next;
    await sleep(60 + Math.random() * 240 * (i + 1));
  }
  throw new Error(`${key} kept changing under us: try again`);
}

// ── the owner's switches ──────────────────────────────────────────────────────────────────────────────────────────

/** What waits for the owner's click (Settings → Automation). Each can be switched off there. */
export const ASK_FIRST = {
  delete: "Deleting files for good (not to the trash)",
  publishing_rules: "Changing the publishing rules or a schedule that publishes",
  over_cap: "Spending past the day's units cap",
  merge_pr: "Merging a pull request",
  push_protected: "Pushing to a protected branch",
  add_repo: "Adding a repo to the allow-list",
} as const;
export type AskKey = keyof typeof ASK_FIRST;
export const ASK_KEYS = Object.keys(ASK_FIRST) as AskKey[];

export type Control = {
  /** the kill switch: while paused, nothing that spends or changes things runs from a model or an automation */
  paused: boolean; paused_at?: number; paused_by?: string; pause_reason?: string;
  /** Colab compute units a day models and automations may spend; 0 = no cap */
  cap_units: number;
  ask_first: AskKey[];
  /** repos models may work on (phase 3), owner/name */
  repos: string[];
  /** calls that spend (GPU jobs, renders, runs) one key (one model, one person) may make a day (UTC); 0 = no cap. Beside
   *  the global units cap, so one model's batch can't eat the day for everyone (docs/FACTORY.md E). */
  key_cap: number;
  updated?: number;
};

export const CONTROL_DEFAULTS: Control = { paused: false, cap_units: 0, ask_first: [...ASK_KEYS], repos: [], key_cap: 0 };

export async function getControl(): Promise<Control> {
  const c = await getJson<Partial<Control>>(CONTROL).catch(() => null);
  return { ...CONTROL_DEFAULTS, ...(c ?? {}), ask_first: (c?.ask_first ?? CONTROL_DEFAULTS.ask_first).filter((k) => k in ASK_FIRST), repos: [...(c?.repos ?? [])] };
}

/** The owner's changes from the dashboard (never from a model: the MCP tools only read these). */
export async function setControl(patch: Record<string, unknown>, by: string): Promise<Control> {
  return mutate<Control>(CONTROL, CONTROL_DEFAULTS, (raw) => {
    const c = { ...CONTROL_DEFAULTS, ...raw };
    if (typeof patch.cap_units === "number" && Number.isFinite(patch.cap_units)) c.cap_units = Math.max(0, Math.min(500, Math.round(patch.cap_units * 10) / 10));
    if (typeof patch.key_cap === "number" && Number.isFinite(patch.key_cap)) c.key_cap = Math.max(0, Math.min(10_000, Math.round(patch.key_cap)));
    if (Array.isArray(patch.ask_first)) c.ask_first = [...new Set(patch.ask_first.map(String).filter((k): k is AskKey => k in ASK_FIRST))];
    if (Array.isArray(patch.repos)) c.repos = [...new Set(patch.repos.map((r) => String(r).trim().toLowerCase()).filter((r) => /^[a-z0-9_.-]{1,39}\/[a-z0-9_.-]{1,100}$/.test(r)))].slice(0, 20);
    if (patch.paused === false) { c.paused = false; delete c.paused_at; delete c.paused_by; delete c.pause_reason; }
    if (patch.paused === true && !c.paused) { c.paused = true; c.paused_at = Date.now(); c.paused_by = by; c.pause_reason = String(patch.reason ?? "paused from the dashboard").slice(0, 200); }
    c.updated = Date.now();
    return c;
  });
}

// ── units ───────────────────────────────────────────────────────────────────────────────────────────────────────

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
let usageCache: { at: number; balance: number | null } | null = null;

/** Colab units spent today (UTC): the balance at the day's first look minus now. null when Colab isn't connected. */
export async function unitsToday(): Promise<{ spent: number | null; balance: number | null; day: string }> {
  const d = day();
  if (!usageCache || Date.now() - usageCache.at > 60_000) {
    const u = await import("../colab").then((c) => c.usage()).catch(() => null);
    usageCache = { at: Date.now(), balance: u && Number.isFinite(u.balance) ? u.balance : null };
  }
  const balance = usageCache.balance;
  if (balance == null) return { spent: null, balance: null, day: d };
  const rec = await mutate<{ day: string; start: number; last: number }>("auto/units.json", { day: d, start: balance, last: balance }, (r) => {
    if (r.day !== d) return { day: d, start: balance, last: balance };
    // units bought during the day raise the balance: the rise isn't negative spending
    return { ...r, start: r.start + Math.max(0, balance - r.last), last: balance };
  }).catch(() => null);
  return { spent: rec ? Math.max(0, Math.round((rec.start - balance) * 100) / 100) : null, balance, day: d };
}

// ── approvals ───────────────────────────────────────────────────────────────────────────────────────────────────

export type Approval = {
  id: string; action: AskKey; summary: string; tool?: string; hash?: string; by: string;
  status: "pending" | "approved" | "denied" | "used" | "expired";
  created: number; decided?: number; decided_by?: string; note?: string; used?: number;
  /** over_cap: good for the rest of the day it was asked on, not once */
  day?: string;
};
type Book = { list: Approval[] };
const TTL = 24 * 3600_000;

const fresh = (a: Approval, now = Date.now()) =>
  a.status === "pending" && now - a.created > TTL ? { ...a, status: "expired" as const } : a;

export async function listApprovals(): Promise<Approval[]> {
  const b = await getJson<Book>(APPROVALS).catch(() => null);
  return (b?.list ?? []).map((a) => fresh(a));
}

export async function getApproval(id: string) {
  return (await listApprovals()).find((a) => a.id === id) ?? null;
}

/** Ask the owner. The same pending ask (same action, same call) is reused instead of piling up. */
export async function requestApproval(a: { action: AskKey; summary: string; tool?: string; hash?: string; by: string }): Promise<Approval> {
  let out: Approval | null = null;
  await mutate<Book>(APPROVALS, { list: [] }, (b) => {
    const list = b.list.map((x) => fresh(x));
    const same = list.find((x) => x.status === "pending" && x.action === a.action && x.hash === a.hash && x.summary === a.summary);
    if (same) { out = same; return { list }; }
    out = { id: randomBytes(5).toString("hex"), ...a, summary: a.summary.slice(0, 400), status: "pending", created: Date.now(),
      ...(a.action === "over_cap" ? { day: day() } : {}) };
    return { list: [out, ...list].slice(0, 200) };
  });
  const got = out as Approval | null;
  if (got && got.created > Date.now() - 5000) {
    // a push to the owner's phone when ntfy is set up (Settings → GPU & engines)
    await import("../colab").then((c) => c.notify("Approval needed", `${got.by}: ${got.summary}`, "raised_hand")).catch(() => null);
  }
  return got!;
}

export async function decideApproval(id: string, ok: boolean, by: string, note?: string) {
  let out: Approval | null = null;
  await mutate<Book>(APPROVALS, { list: [] }, (b) => ({
    list: b.list.map((x) => {
      if (x.id !== id) return x;
      const f = fresh(x);
      if (f.status !== "pending") throw new Error(`that request is ${f.status}`);
      out = { ...f, status: ok ? "approved" : "denied", decided: Date.now(), decided_by: by, ...(note ? { note: note.slice(0, 300) } : {}) };
      return out;
    }),
  }));
  if (!out) throw new Error("no such request");
  return out as Approval;
}

/** Spend an approval on the call it was asked for: approved, same action and call, not used yet. over_cap ones last
 *  the day. Returns the reason it can't be used, or null when it was used. */
export async function useApproval(id: string, action: AskKey, hash?: string): Promise<string | null> {
  let why: string | null = "no such request";
  await mutate<Book>(APPROVALS, { list: [] }, (b) => ({
    list: b.list.map((x) => {
      if (x.id !== id) return x;
      const f = fresh(x);
      if (f.action !== action) { why = `that approval is for ${f.action}, not ${action}`; return f; }
      if (f.action === "over_cap") {
        why = f.status === "approved" || f.status === "used" ? (f.day === day() ? null : "that approval was for another day") : `that request is ${f.status}`;
        return f;
      }
      if (f.status !== "approved") { why = f.status === "pending" ? "the owner hasn't decided yet" : `that request is ${f.status}`; return f; }
      if (hash && f.hash && f.hash !== hash) { why = "that approval was for a different call (other arguments)"; return f; }
      why = null;
      return { ...f, status: "used", used: Date.now() };
    }),
  }));
  return why;
}

/** The over-cap approval for today, if the owner gave one. */
export async function capApprovedToday() {
  return (await listApprovals()).some((a) => a.action === "over_cap" && (a.status === "approved" || a.status === "used") && a.day === day());
}

// ── the call log ────────────────────────────────────────────────────────────────────────────────────────────────

export type LogEntry = {
  t: number; tool: string; model: string; client?: string; args?: string; ok: boolean; ms: number; err?: string;
  job?: string; gate?: string; via?: string; role?: string;
  /** a render's QA verdict and the checks it failed (edit_video, repurpose, inspect_media), for the audit */
  qa?: "PASS" | "WARN" | "FAIL"; qa_fail?: string[];
};
const logKey = (t: number) => { const d = new Date(t).toISOString(); return `auto/log/${d.slice(0, 10)}/${d.slice(11, 13)}.json`; };

/** One call, appended to its hour's file. Never throws: the log must not break a call. */
export async function logCall(e: LogEntry) {
  await mutate<{ list: LogEntry[] }>(logKey(e.t), { list: [] }, (b) => ({ list: [...b.list, e].slice(-2000) })).catch((err) => console.warn("call log:", (err as Error).message));
}

/** The latest calls, newest first, reading back an hour at a time (up to `days`). */
export async function readLog(opts: { limit?: number; model?: string; tool?: string; since?: number; days?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 1000);
  const days = Math.min(opts.days ?? 2, 31);
  const keys: string[] = [];
  for (let i = 0; i < days; i++) keys.push(...(await listObjs(`auto/log/${day(Date.now() - i * 86_400_000)}/`).catch(() => [])).map((o) => o.key));
  keys.sort().reverse();
  const out: LogEntry[] = [];
  for (const k of keys) {
    const b = await getJson<{ list: LogEntry[] }>(k).catch(() => null);
    for (const e of [...(b?.list ?? [])].reverse()) {
      if (opts.since && e.t < opts.since) continue;
      if (opts.model && e.model !== opts.model) continue;
      if (opts.tool && e.tool !== opts.tool) continue;
      out.push(e);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// ── the kill switch ─────────────────────────────────────────────────────────────────────────────────────────────

/** Stop everything: pause models and automations, cancel every queued and running job on the worker, stop the
 *  runtime the app started. Each step is tried even if one before it fails. */
export async function stopAll(by: string, reason = "stop_all") {
  const out: Record<string, unknown> = {};
  await setControl({ paused: true, reason }, by);
  out.paused = true;
  try {
    const { call } = await import("../worker");
    const { jobs } = await call<{ jobs: { id: string; status: string }[] }>("/jobs", { timeoutMs: 10_000 });
    const live = jobs.filter((j) => j.status === "queued" || j.status === "running");
    await Promise.all(live.map((j) => call(`/jobs/${j.id}/cancel`, { body: {}, timeoutMs: 10_000 }).catch(() => null)));
    out.jobs_cancelled = live.length;
  } catch (e) {
    out.jobs_cancelled = `none (${(e as Error).message.slice(0, 120)})`;
  }
  try {
    const colab = await import("../colab");
    const s = await colab.getSession();
    if (s && !s.stopped && s.endpoint) { await colab.stopRuntime(s.endpoint, `stop_all by ${by}`); out.runtime = `stopped the ${s.gpu}`; }
    else out.runtime = "none running from the app";
  } catch (e) {
    out.runtime = `couldn't stop it (${(e as Error).message.slice(0, 120)})`;
  }
  return out;
}


// ── per key: spending calls a day ─────────────────────────────────────────────────────────────────────────────────

const USAGE = (day: string) => `auto/usage/${day}.json`;
const today = () => new Date().toISOString().slice(0, 10);

/** Today's spending calls per key. */
export async function keyUsage(): Promise<Record<string, number>> {
  return (await getJson<Record<string, number>>(USAGE(today())).catch(() => null)) ?? {};
}

/** One more spending call for this key today (an ETag write, so two calls at once both count). */
export async function countKey(model: string) {
  const { getJsonTagged, putJsonIf } = await import("../store");
  for (let i = 0; i < 5; i++) {
    const { value, etag } = await getJsonTagged<Record<string, number>>(USAGE(today()));
    const v = { ...(value ?? {}) };
    v[model] = (v[model] ?? 0) + 1;
    if (await putJsonIf(USAGE(today()), v, etag)) return v[model];
  }
  return null;
}
