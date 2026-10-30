// The factory (docs/FACTORY.md D): N videos in about the time of one. A batch goes through stages that overlap:
// every script checked (script_check), one voice job for every line of every video (the model loads once), each
// scene rendered once and cached by its content (a fix re-renders only that scene), then one join per video (scenes
// cut to their line's length, the lines as one voice, music, captions) with QA. Renders run on the worker's render
// lane (bench, 4 at once on the L4's CPUs) while the GPU lane is free for the next batch's voice. Every step goes
// through the same guarded path as a model's own call (approvals, the units cap, the call log), as the caller.
import { createHash, randomBytes } from "node:crypto";
import { getJson, getJsonTagged, listObjs, putJson, putJsonIf } from "../store";

// ── the script check ────────────────────────────────────────────────────────────────────────────────────────────

export const BANNED_OPENERS = ["in this video", "hey guys", "hi guys", "welcome back", "welcome to", "have you ever wondered", "did you know", "let's dive in", "let's talk about", "today we", "today i", "so,", "imagine a world", "in today's"];
const WPM = 165;
const LIMITS: Record<string, [number, number]> = { reels: [20, 90], shorts: [15, 60], tiktok: [15, 90], youtube: [45, 1200], ig_post: [5, 60], square: [5, 60] };

export type Check = { status: "PASS" | "WARN" | "FAIL"; check: string; why: string };
export function scriptCheck(lines: string[], platform = "reels") {
  const ls = lines.map((l) => l.trim()).filter(Boolean);
  const words = ls.join(" ").split(/\s+/).filter(Boolean).length;
  const secs = Math.round((words / WPM) * 60);
  const out: Check[] = [];
  const add = (status: Check["status"], check: string, why: string) => out.push({ status, check, why });
  if (!ls.length) return { verdict: "FAIL" as const, words: 0, seconds: 0, checks: [{ status: "FAIL" as const, check: "script", why: "no lines" }] };
  const hook = ls[0], hw = hook.split(/\s+/).length;
  const opener = BANNED_OPENERS.find((b) => hook.toLowerCase().startsWith(b));
  add(opener ? "FAIL" : "PASS", "opener", opener ? `opens with "${opener}": start on the claim, the number or the surprise instead` : "opens on the point");
  add(hw > 16 ? "FAIL" : hw > 12 ? "WARN" : "PASS", "hook length", `${hw} words in the first line (aim for 12 or fewer: it has to land in ~3 s)`);
  add(/\?$/.test(hook) && hw < 6 ? "WARN" : "PASS", "hook", /\?$/.test(hook) && hw < 6 ? "a bare question: give it a stake (who, what number, what's wrong)" : "has a stake");
  const [lo, hi] = LIMITS[platform] ?? LIMITS.reels;
  add(secs > hi ? "FAIL" : secs < lo ? "WARN" : "PASS", "length", `${words} words ≈ ${secs} s at ${WPM} wpm; ${platform} wants ${lo}-${hi} s`);
  add(ls.length < 3 ? "WARN" : "PASS", "spine", ls.length < 3 ? "under 3 beats: hook, the turn, the payoff" : `${ls.length} beats`);
  const long = ls.filter((l) => l.split(/\s+/).length > 28);
  add(long.length ? "WARN" : "PASS", "line length", long.length ? `${long.length} line(s) over 28 words: one beat per line reads better on screen` : "every beat is short");
  const nums = ls.filter((l) => /\d/.test(l));
  add("PASS", "numbers on screen", nums.length ? `${nums.length} line(s) with a number: put each number on screen as it's said` : "no numbers");
  const end = ls[ls.length - 1];
  const kind = /\?$/.test(end) ? "a question" : /(follow|subscribe|comment|send|share|link|save this)/i.test(end) ? "a call to action" : "a closing line";
  add(/^(thanks for watching|that's it|that's all)/i.test(end) ? "WARN" : "PASS", "ending", `ends on ${kind}${/^(thanks for watching|that's it|that's all)/i.test(end) ? ": a filler ending loses the replay; end on the payoff or the brand's line" : ""}`);
  const order = { FAIL: 0, WARN: 1, PASS: 2 } as const;
  out.sort((a, b) => order[a.status] - order[b.status]);
  return { verdict: out.some((c) => c.status === "FAIL") ? "FAIL" as const : out.some((c) => c.status === "WARN") ? "WARN" as const : "PASS" as const, words, seconds: secs, checks: out };
}

// ── a batch ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type Scene = { line: string; template?: string; fields?: Record<string, unknown>; clip?: string; from?: number };
export type VideoSpec = { name: string; scenes: Scene[]; platform?: string; shape?: string; music?: string; captions?: boolean };
type SceneState = { file?: string; job?: string; err?: string; dur?: number; voice?: string; cached?: boolean; len?: number; redone?: boolean };
/** How long a line will take before it's voiced (165 wpm and a little), so scenes render while the voice job runs. */
/** A list's points all land within its line (by 75% of it): the scene is cut to the line, so points paced for a
 *  longer scene never showed (seen on the L4: only the first of three). */
const listPace = (line: number, n: number) => ({ lead: 0.3, per_item: Math.max(0.4, (line * 0.75 - 0.3) / Math.max(2, n)) });
const estimate = (line: string) => line.trim().split(/\s+/).length / 2.75 + 0.6;
type Item = { name: string; spec: VideoSpec; check?: { verdict: string; issues: string[] }; scenes: SceneState[]; join?: string; file?: string; qa?: { verdict: string; issues?: string[] }; err?: string; state: "check" | "voice" | "scenes" | "join" | "done" | "error" };
export type Batch = {
  id: string; by: string; created: number; updated: number; status: "running" | "done" | "error" | "stopped";
  voice: { engine?: string; voice?: string; style?: string }; draft: boolean; project?: string; force: boolean;
  voice_job?: string; items: Item[]; log: string[]; timing: Record<string, number>;
};

const KEY = (id: string) => `auto/factory/${id}.json`;
const CACHE = (h: string) => `auto/factory/cache/${h}.json`;
export const sceneKey = (s: Scene, shape: string, draft: boolean, dur: number) =>
  createHash("sha256").update(JSON.stringify([s.template, s.fields, shape, draft, Math.round(dur * 10)])).digest("hex").slice(0, 24);

async function save(b: Batch) {
  b.updated = Date.now();
  await putJson(KEY(b.id), b);
}
export const getBatch = async (id: string) => {
  if (!/^fb[a-f0-9]{8}$/.test(id)) throw new Error("batch: the id factory start gave (fb…)");
  const b = await getJson<Batch>(KEY(id));
  if (!b) throw new Error(`no batch ${id}`);
  return b;
};

export async function startBatch(videos: VideoSpec[], opts: { by: string; voice?: Batch["voice"]; draft?: boolean; project?: string; force?: boolean }) {
  if (!videos.length || videos.length > 20) throw new Error("videos: 1 to 20");
  for (const v of videos) {
    if (!v.scenes?.length || v.scenes.length > 30) throw new Error(`${v.name}: 1 to 30 scenes`);
    for (const s of v.scenes) if (!s.line?.trim() || (!s.template && !s.clip)) throw new Error(`${v.name}: every scene needs a line and a template or a clip`);
  }
  const b: Batch = {
    id: `fb${randomBytes(4).toString("hex")}`, by: opts.by, created: Date.now(), updated: Date.now(), status: "running",
    voice: opts.voice ?? {}, draft: opts.draft ?? true, ...(opts.project ? { project: opts.project } : {}), force: !!opts.force,
    items: videos.map((v) => ({ name: v.name.slice(0, 60), spec: v, scenes: v.scenes.map(() => ({})), state: "check" })), log: [], timing: { start: Date.now() },
  };
  await putJsonIf(KEY(b.id), b, null);
  return b;
}

type Call = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; value: unknown; text: string }>;
const v = <T,>(x: unknown) => x as T;
const note = (b: Batch, s: string) => { b.log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); b.log = b.log.slice(-60); };

/** Move a batch along as far as it goes in `ms`; called by factory status and the sweep. One mover at a time (a lock). */
export async function advance(id: string, call: Call, ms = 40_000): Promise<Batch> {
  const lock = await getJsonTagged<{ until: number }>(`auto/factory/${id}.lock`);
  if (lock.value && lock.value.until > Date.now()) return getBatch(id);
  if (!(await putJsonIf(`auto/factory/${id}.lock`, { until: Date.now() + ms + 20_000 }, lock.etag))) return getBatch(id);
  const b = await getBatch(id);
  const until = Date.now() + ms;
  try {
    while (b.status === "running" && Date.now() < until) {
      const before = JSON.stringify(b.items.map((i) => [i.state, i.scenes, i.join, i.file]));
      await step(b, call);
      await save(b);
      if (JSON.stringify(b.items.map((i) => [i.state, i.scenes, i.join, i.file])) === before) await new Promise((r) => setTimeout(r, 4000));
    }
  } finally {
    await putJson(`auto/factory/${id}.lock`, { until: 0 });
  }
  return b;
}

const shapeOf = (v: VideoSpec) => v.shape ?? (v.platform === "youtube" ? "16:9" : "9:16");

async function step(b: Batch, call: Call) {
  const live = b.items.filter((i) => i.state !== "error" && i.state !== "done");
  // 1. every script checked at once (pure, no GPU)
  for (const it of live.filter((i) => i.state === "check")) {
    const c = scriptCheck(it.spec.scenes.map((s) => s.line), it.spec.platform ?? "reels");
    it.check = { verdict: c.verdict, issues: c.checks.filter((x) => x.status !== "PASS").map((x) => `${x.status} ${x.check}: ${x.why}`) };
    if (c.verdict === "FAIL" && !b.force) { it.state = "error"; it.err = "the script failed its check (pass force to voice it anyway)"; continue; }
    it.state = "voice";
  }
  // 2. one voice job for every line of every video
  const toVoice = b.items.filter((i) => i.state === "voice");
  if (toVoice.length && !b.voice_job) {
    const lines = toVoice.flatMap((it) => it.spec.scenes.map((s, k) => ({ id: `v${b.items.indexOf(it)}s${k}`, text: s.line })));
    // a draft skips Whisper's listen-back (the delivery run has it)
    const r = await call("voice_lines", { lines, ...b.voice, review: !b.draft, platform: "raw", wait_seconds: 0, label: `factory ${b.id} (${lines.length} lines)` });
    const job = v<{ id?: string; job_id?: string }>(r.value)?.id ?? v<{ job_id?: string }>(r.value)?.job_id;
    if (!r.ok || !job) { for (const it of toVoice) { it.state = "error"; it.err = `voice: ${r.text.slice(0, 200)}`; } return; }
    b.voice_job = job; b.timing.voice_start = Date.now();
    note(b, `voice job ${job}: ${lines.length} lines for ${toVoice.length} videos; scenes render meanwhile`);
  } else if (toVoice.length && b.voice_job) {
    const r = await call("get_job", { job_id: b.voice_job, wait_seconds: 0 });
    const j = v<{ status?: string; error?: string; results?: { id: string; url?: string; audio?: string; duration?: number }[] }>(r.value);
    if (j?.status === "error" || j?.status === "cancelled") { for (const it of toVoice) { it.state = "error"; it.err = `voice: ${j.error ?? j.status}`; } return; }
    if (j?.status === "done") {
      b.timing.voice_s = Math.round((Date.now() - (b.timing.voice_start ?? Date.now())) / 1000);
      const by = new Map((j.results ?? []).map((x) => [x.id, x]));
      for (const it of toVoice) {
        const n = b.items.indexOf(it);
        it.scenes = it.scenes.map((s, k) => { const x = by.get(`v${n}s${k}`); return { ...s, voice: x?.url ?? x?.audio, dur: x?.duration }; });
        if (it.scenes.some((s) => !s.voice)) { it.state = "error"; it.err = "voice: some lines came back without audio"; continue; }
        it.state = "scenes";
      }
      note(b, `voice done in ${b.timing.voice_s} s`);
    }
  }
  // 3. scenes, overlapped with the voice: rendered to the estimated length (with slack) while the voice job runs,
  // cached by content; a scene whose real line came out longer than it is renders again at the real length
  // only beside a GPU voice: Kokoro voices on the CPU, and 15 Chromium renders starve it (measured: 61 s → 184 s)
  const overlap = (b.voice.engine ?? "qwen") !== "kokoro";
  const scened = b.items.filter((i) => i.state === "scenes" || (overlap && i.state === "voice"));
  if (scened.length && !b.project && !b.timing.folders) { // made once, before 15 renders race to make it
    const bench = await import("./bench");
    await bench.ensureFolder("Factory/scenes", { name: b.by });
    b.timing.folders = 1;
  }
  await Promise.all(scened.flatMap((it) => it.spec.scenes.map(async (sc, k) => {
    const st = it.scenes[k];
    if (st.err) return;
    if (sc.clip) { st.file = sc.clip; st.len = 1e9; return; }
    const need = (st.dur ?? estimate(sc.line)) + 0.25;
    if (st.file && (st.len ?? 0) >= need) return;
    if (st.file && st.dur != null) { st.file = undefined; st.job = undefined; st.redone = true; } // too short for the real line
    if (st.file) return; // rendered to the estimate; the voice decides
    const len = st.dur != null ? need + 0.5 : Math.ceil((estimate(sc.line) * 1.3 + 1) * 2) / 2;
    const h = sceneKey(sc, shapeOf(it.spec), b.draft, len);
    if (!st.job) {
      const hit = await getJson<{ file: string; len?: number }>(CACHE(h)).catch(() => null);
      if (hit) { st.file = hit.file; st.len = hit.len ?? len; st.cached = true; return; }
      const fields = { ...(sc.fields ?? {}), seconds: len, ...(sc.template === "list" ? listPace(st.dur ?? estimate(sc.line), (sc.fields?.items as unknown[] | undefined)?.length ?? 2) : {}) };
      const r = await call("video_template", { template: sc.template, fields, shape: shapeOf(it.spec), quality: b.draft ? "draft" : "standard", ...(b.draft ? { size: "half" } : {}), name: `${it.name}-s${k + 1}`, ...(b.project ? { project: b.project } : { save_to: "Factory/scenes" }) });
      const x = v<{ job_id?: string; status?: string; file?: { file_id?: string }; error?: string }>(r.value);
      if (!r.ok) { st.err = r.text.slice(0, 200); return; }
      if (x?.file?.file_id) { st.file = x.file.file_id; st.len = len; await putJson(CACHE(h), { file: st.file, len }); return; }
      st.job = x?.job_id; st.len = len;
      return;
    }
    const r = await call("get_job", { job_id: st.job, wait_seconds: 0 });
    const x = v<{ status?: string; file?: { file_id?: string; error?: string } | string; error?: string }>(r.value);
    const fid = typeof x?.file === "object" ? x.file?.file_id : undefined;
    if (fid) { st.file = fid; await putJson(CACHE(h), { file: st.file, len: st.len }); }
    else if (x?.status === "error" || x?.status === "cancelled") st.err = x.error ?? `render ${x.status}`;
    else if (x?.status === "done") st.err = `the render finished but its file wasn't saved (${JSON.stringify(x.file ?? null).slice(0, 120)})`; // never wait on it forever
    else if (!r.ok) st.err = r.text.slice(0, 200);
  })));
  for (const it of scened) {
    const bad = it.scenes.find((s) => s.err);
    if (bad) { it.state = "error"; it.err = `scene: ${bad.err}`; continue; }
    if (it.state === "scenes" && it.scenes.every((s, k) => s.file && (s.len ?? 0) >= (s.dur ?? estimate(it.spec.scenes[k].line)) + 0.25)) it.state = "join";
  }
  // 4. one join per video: scenes cut to their lines, the lines as one voice, music, captions; QA comes with it
  await Promise.all(b.items.filter((i) => i.state === "join").map(async (it) => {
    if (!it.join) {
      const inputs: Record<string, string> = {};
      it.scenes.forEach((s, k) => { inputs[`s${k}`] = s.file!; inputs[`l${k}`] = s.voice!; });
      if (it.spec.music) inputs.music = it.spec.music;
      const spec = {
        platform: it.spec.platform ?? "reels", fit: "crop", ...(b.draft ? { fps: 15, quality: "fast" } : {}), original_volume_db: "mute",
        clips: it.scenes.map((s, k) => ({ src: `s${k}`, ...(it.spec.scenes[k].from != null ? { from: it.spec.scenes[k].from } : {}), to: (it.spec.scenes[k].from ?? 0) + (s.dur ?? 3) + 0.25 })),
        voice: { src: it.scenes.map((_, k) => `l${k}`), gap_s: 0.25 },
        ...(it.spec.music ? { music: { src: "music", duck: true } } : {}), ...(it.spec.captions === false ? {} : { captions: { style: "pop" } }),
        name: it.name,
      };
      const r = await call("edit_video", { inputs, spec, ...(b.project ? { project: b.project } : { save_to: "Factory" }) });
      const x = v<{ job_id?: string; file?: { file_id?: string }; qa?: Item["qa"] }>(r.value);
      if (!r.ok) { it.state = "error"; it.err = `join: ${r.text.slice(0, 200)}`; return; }
      it.join = x?.job_id;
      if (x?.file?.file_id) { it.file = x.file.file_id; it.qa = x.qa; it.state = "done"; }
      return;
    }
    const r = await call("get_job", { job_id: it.join, wait_seconds: 0 });
    const x = v<{ status?: string; file?: { file_id?: string } | string; qa?: Item["qa"]; error?: string }>(r.value);
    const fid = typeof x?.file === "object" ? x.file?.file_id : undefined;
    if (fid) { it.file = fid; it.qa = x!.qa; it.state = "done"; }
    else if (x?.status === "error" || x?.status === "cancelled") { it.state = "error"; it.err = `join: ${x.error ?? x.status}`; }
    else if (x?.status === "done") { it.state = "error"; it.err = `join: finished but its file wasn't saved (${JSON.stringify(x.file ?? null).slice(0, 120)})`; }
  }));
  if (b.items.every((i) => i.state === "done" || i.state === "error")) {
    b.status = b.items.some((i) => i.state === "done") ? "done" : "error";
    b.timing.total_s = Math.round((Date.now() - b.timing.start) / 1000);
    note(b, `finished in ${b.timing.total_s} s`);
  }
}

/** Only what a model needs: per video its state, file and QA, failures with the reason; never the job logs. */
export function view(b: Batch) {
  return {
    batch: b.id, status: b.status, draft: b.draft, ...(b.timing.total_s ? { seconds: b.timing.total_s } : {}), ...(b.timing.voice_s ? { voice_s: b.timing.voice_s } : {}),
    videos: b.items.map((i) => ({
      name: i.name, state: i.state, ...(i.file ? { file: i.file } : {}), ...(i.qa ? { qa: i.qa.verdict, ...(i.qa.issues?.length ? { issues: i.qa.issues } : {}) } : {}),
      ...(i.err ? { error: i.err } : {}), ...(i.check && i.check.verdict !== "PASS" ? { script: i.check } : {}),
      ...(i.state === "scenes" ? { scenes: `${i.scenes.filter((s) => s.file).length}/${i.scenes.length} (${i.scenes.filter((s) => s.cached).length} from cache)` } : {}),
    })),
    next: b.status === "running" ? `call factory action=status batch="${b.id}" again (each call moves it on for up to 40 s)` : b.status === "done" ? "Check each file (inspect_media checks [\"sheet\"]), then fix a scene and run the batch again: unchanged scenes come from the cache." : "Read the errors.",
  };
}

export async function listBatches(by?: string) {
  const objs = (await listObjs("auto/factory/")).filter((o) => /^auto\/factory\/fb[a-f0-9]{8}\.json$/.test(o.key)).sort((a, b) => b.modified - a.modified).slice(0, 30);
  const all = (await Promise.all(objs.map((o) => getJson<Batch>(o.key).catch(() => null)))).filter((x): x is Batch => !!x);
  return all.filter((x) => !by || x.by === by);
}

export async function runningBatches() {
  return (await listBatches()).filter((b) => b.status === "running" && Date.now() - b.updated < 6 * 3600_000);
}
