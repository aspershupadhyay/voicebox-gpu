// The one-click post pipeline: script → hook score → voice it → subtitles → thumbnail → package → schedule, from one
// post. A post that already has its own video (an upload) skips the script and voice steps. The package is the title,
// description, tags, hashtags and credits from Radar's research (lib/postpack.ts). Each
// step reads what the post already has (a script, a voiceover, its subtitles, a cover, publish times), so nothing that's
// done is done again; "run" starts what's missing in order, on the GPU worker where it needs one. The run is kept in R2
// (workspace/pipelines/<post>.json) and moved along by whoever looks (the post's Pipeline panel every few seconds, the
// post_pipeline MCP tool) and by the 10-minute sweep, so it finishes with the drawer closed. It never publishes:
// schedule sets each target's time (the next posting slot) and moves it to Scheduled; sending stays the composer's.
import { addMediaFromUrl, getPost, linkJob, listMedia, updatePost } from "./appwrite";
import { archiveWorkerJob, getLibJob, signer, type LibJob } from "./library";
import { getJson, listObjs, putJson } from "./store";
import { call, WorkerOffline } from "./worker";
import type { Post } from "./workspace";

export const STEPS = ["script", "hook", "voice", "subtitles", "thumbnail", "package", "schedule"] as const;
export type StepId = (typeof STEPS)[number];
export type StepState = "done" | "todo" | "running" | "blocked" | "warn" | "failed";
export type Step = { id: StepId; label: string; state: StepState; detail: string; job?: string | null; at?: number | null };

type Running = { job: string; at: number; error?: string | null };
type Run = {
  post: string; by: string; started: number; auto: boolean; force?: boolean;
  jobs: Partial<Record<"voice" | "subtitles" | "thumbnail", Running>>;
  log: { at: number; text: string; ok?: boolean }[]; finished?: number | null;
};

const KEY = (post: string) => `workspace/pipelines/${post}.json`;
const HOOK_OK = 70, HOOK_MIN = 50; // 70+ is strong; under 50 the run waits for a better script (or "run anyway")
const actorOf = (by: string) => ({ name: by });
const line = (r: Run, text: string, ok?: boolean) => { r.log = [...r.log, { at: Date.now(), text, ...(ok !== undefined ? { ok } : {}) }].slice(-40); };

async function getRun(post: string) { return getJson<Run>(KEY(post)).catch(() => null); }
async function putRun(r: Run) { await putJson(KEY(r.post), r); }

const scriptLines = (s: string | null | undefined) => (s ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
/** The format the hook and the thumbnail are judged for: the post's first publishable target. */
async function formatOf(post: Post) {
  const { getTargets } = await import("./spacestore");
  const { targetsOf } = await import("./spaces");
  const ts = targetsOf(post, await getTargets());
  const fmt = ts.map((t) => t.space).find((s) => ["yt_video", "yt_short", "ig_reel", "ig_post"].includes(s)) as "yt_video" | "yt_short" | "ig_reel" | "ig_post" | undefined;
  return { fmt: fmt ?? null, targets: ts };
}

/** The post's newest voiceover in the library. */
async function voiceOf(post: Post): Promise<LibJob | null> {
  for (const id of [...(post.jobs ?? [])].reverse()) {
    const j = await getLibJob(id);
    if (j && (!j.kind || j.kind === "tts")) return j;
  }
  return null;
}

/** Where every step stands, from the post itself and the run in flight. */
export async function pipelineStatus(postId: string) {
  const [post, run] = await Promise.all([getPost(postId), getRun(postId)]);
  const { hookScore } = await import("./writing");
  const { fmt, targets } = await formatOf(post);
  const lines = scriptLines(post.script);
  const words = lines.join(" ").split(/\s+/).filter(Boolean).length;
  const hook = lines.length ? hookScore(post.script ?? "", { fmt }) : null;
  const [voice, media] = await Promise.all([voiceOf(post), listMedia(post.$id, 100).catch(() => [])]);
  const busy = (k: "voice" | "subtitles" | "thumbnail") => run?.jobs[k] && !run.jobs[k]!.error ? run.jobs[k]! : null;
  const failed = (k: "voice" | "subtitles" | "thumbnail") => run?.jobs[k]?.error ?? null;
  const cover = post.cover ? media.find((m) => m.$id === post.cover) : media.find((m) => m.kind === "image");
  // a post with its own video or photos needs no script or voiceover
  const own = !lines.length && media.some((m) => m.kind === "video" || m.kind === "image");
  const ownWhat = media.some((m) => m.kind === "video") ? "its own video" : "its own photos";
  const pack = await (await import("./postpack")).getPack(post.$id);
  const open = targets.filter((t) => t.status !== "posted");
  const timed = open.filter((t) => t.due_at);
  const skip = (id: StepId, label: string): Step => ({ id, label, state: "done", detail: `Not needed: the post has ${ownWhat}` });
  const steps: Step[] = [
    own ? skip("script", "Script") : { id: "script", label: "Script", state: words >= 5 ? "done" : "todo", detail: words >= 5 ? `${words} words, ${lines.length} lines` : "Write the script (one line per beat)" },
    own ? skip("hook", "Hook score") : { id: "hook", label: "Hook score", state: !hook ? "blocked" : hook.score >= HOOK_OK ? "done" : hook.score >= HOOK_MIN ? "warn" : "todo",
      detail: !hook ? "Needs a script" : `${hook.score}/100 · ${hook.grade}${hook.score < HOOK_OK ? ` · ${hook.checks.find((c) => !c.ok)?.label ?? "tighten the opening"}` : ""}` },
    own ? skip("voice", "Voice it") : { id: "voice", label: "Voice it", state: voice ? "done" : busy("voice") ? "running" : failed("voice") ? "failed" : words < 5 ? "blocked" : "todo",
      detail: voice ? `${voice.voice} · ${Math.round(voice.results.reduce((s, r) => s + r.duration, 0))} s` : busy("voice") ? "Voicing on the GPU" : failed("voice") ?? (words < 5 ? "Needs a script" : "Voice the script on the GPU"), job: voice?.id ?? busy("voice")?.job ?? null },
    own ? skip("subtitles", "Subtitles") : { id: "subtitles", label: "Subtitles", state: voice?.subs ? "done" : busy("subtitles") ? "running" : failed("subtitles") ? "failed" : voice ? "todo" : "blocked",
      detail: voice?.subs ? `${voice.subs.cues} captions` : busy("subtitles") ? "Whisper is listening" : failed("subtitles") ?? (voice ? "Word-timed captions from the voiceover" : "Needs the voiceover") },
    { id: "thumbnail", label: "Thumbnail", state: cover || own ? "done" : busy("thumbnail") ? "running" : failed("thumbnail") ? "failed" : "todo",
      detail: cover ? cover.name : own ? "The video's own frame (or its first photo)" : busy("thumbnail") ? "Drawing on the GPU" : failed("thumbnail") ?? "A cover drawn from the title", job: busy("thumbnail")?.job ?? null },
    { id: "package", label: "Title, description, hashtags", state: pack ? "done" : "todo",
      detail: pack ? `“${pack.keyword}” · SEO ${pack.seo.score} · ${pack.hashtags.length} hashtags${pack.credit ? " · credited" : ""}` : "Researched title, description, tags, hashtags and credits" },
    { id: "schedule", label: "Schedule", state: !open.length ? (targets.length ? "done" : "todo") : timed.length === open.length ? "done" : "todo",
      detail: !targets.length ? "Pick where it goes first" : !open.length ? "Posted" : timed.length === open.length ? `${open.length} target${open.length === 1 ? "" : "s"} timed · ${new Date(Math.min(...timed.map((t) => Date.parse(t.due_at!)))).toUTCString().slice(0, 22)} UTC` : `${open.length - timed.length} without a time: the next posting slot` },
  ];
  const next = steps.find((s) => s.state === "todo" || s.state === "failed" || (s.id === "hook" && s.state === "warn" && !run?.force))?.id ?? null;
  return { post_id: post.$id, title: post.title, steps, running: !!run?.auto && !run.finished, next, log: run?.log ?? [], hook: hook ? { score: hook.score, grade: hook.grade, opener: hook.opener } : null,
    done: steps.every((s) => s.state === "done" || s.state === "warn") };
}

/** Start one step now (or, with "all", turn the run on so it does every missing step in order). */
export async function runPipeline(postId: string, step: StepId | "all", by: string, opts: { force?: boolean } = {}) {
  const run: Run = (await getRun(postId)) ?? { post: postId, by, started: Date.now(), auto: false, jobs: {}, log: [] };
  if (step === "all") {
    run.auto = true; run.finished = null; run.by = by; run.started = Date.now(); run.force = !!opts.force;
    for (const k of Object.keys(run.jobs) as (keyof Run["jobs"])[]) if (run.jobs[k]?.error) delete run.jobs[k]; // failed steps get another go
    line(run, `Run all, by ${by}`);
    await putRun(run);
    return advance(postId);
  }
  if (step === "voice" || step === "subtitles" || step === "thumbnail") { delete run.jobs[step]; await start(run, await getPost(postId), step); }
  else if (step === "schedule") await schedule(run, await getPost(postId));
  else if (step === "package") await pack(run, postId);
  else throw new Error("the script and its hook are yours (or Claude's) to write: update_post, then hook_score");
  await putRun(run);
  return pipelineStatus(postId);
}

export async function stopPipeline(postId: string) {
  const run = await getRun(postId);
  if (run) { run.auto = false; line(run, "Stopped"); await putRun(run); }
  return pipelineStatus(postId);
}

/** Move a run along: collect finished GPU jobs, then (when it's running) start the next missing step. */
export async function advance(postId: string) {
  const run = await getRun(postId);
  if (!run) return pipelineStatus(postId);
  let post = await getPost(postId);
  let changed = false;
  for (const k of ["voice", "subtitles", "thumbnail"] as const) {
    const r = run.jobs[k];
    if (!r || r.error) continue;
    try {
      const job = await call<Parameters<typeof archiveWorkerJob>[0] & { error?: string }>(`/jobs/${r.job}`);
      if (job.status === "error") { r.error = job.error || "the GPU job failed"; line(run, `${k}: ${r.error}`, false); changed = true; continue; }
      if (job.status !== "done") continue;
      const lib = await archiveWorkerJob(job);
      if (k === "voice") { await linkJob(post.$id, job.id, actorOf(run.by)); line(run, "Voiced and attached", true); }
      if (k === "subtitles") line(run, "Subtitles made", true);
      if (k === "thumbnail" && lib?.images?.length) {
        const sign = await signer(900);
        const url = await sign(lib.id, lib.images[0].file);
        const { getSettings } = await import("./settings");
        const { media } = await addMediaFromUrl(url, { name: `${post.title.slice(0, 60)} thumbnail.png`, postId: post.$id, backup: (await getSettings()).backup_media }, actorOf(run.by));
        if (!post.cover) await updatePost(post.$id, { cover: media.$id }, actorOf(run.by));
        line(run, "Thumbnail added as the cover", true);
      }
      delete run.jobs[k]; changed = true;
      post = await getPost(postId);
    } catch (e) {
      if (e instanceof WorkerOffline) break; // the GPU went away: pick it up when it's back
      r.error = (e as Error).message; line(run, `${k}: ${r.error}`, false); changed = true;
    }
  }
  if (run.auto && !run.finished) {
    const s = await pipelineStatus(postId);
    const st = (id: StepId) => s.steps.find((x) => x.id === id)!;
    const go = async (k: "voice" | "subtitles" | "thumbnail") => { if (!run.jobs[k]) { await start(run, post, k).catch((e) => { line(run, `${k}: ${(e as Error).message}`, false); if (!(e instanceof WorkerOffline)) run.jobs[k] = { job: "", at: Date.now(), error: (e as Error).message }; }); changed = true; } };
    if (st("script").state !== "done") { run.auto = false; line(run, "Waiting for a script", false); changed = true; }
    else if (st("hook").state === "todo" && !run.force) { run.auto = false; line(run, `Hook ${s.hook?.score}/100: improve the opening, or run anyway`, false); changed = true; }
    else {
      if (st("voice").state === "todo") await go("voice");
      if (st("thumbnail").state === "todo") await go("thumbnail"); // the GPU queues it behind the voice
      if (st("subtitles").state === "todo" && st("voice").state === "done") await go("subtitles");
      const gpuLeft = (["voice", "subtitles", "thumbnail"] as const).some((k) => ["todo", "running"].includes(st(k).state) || run.jobs[k] && !run.jobs[k]!.error);
      if (!gpuLeft && st("package").state === "todo") { await pack(run, postId); changed = true; }
      if (!gpuLeft && st("schedule").state === "todo") { await schedule(run, post); changed = true; }
      const after = await pipelineStatus(postId);
      if (after.steps.every((x) => ["done", "warn", "failed"].includes(x.state)) && !Object.values(run.jobs).some((j) => j && !j.error)) {
        run.finished = Date.now(); run.auto = false;
        const bad = after.steps.filter((x) => x.state === "failed");
        line(run, bad.length ? `Finished, ${bad.length} step${bad.length === 1 ? "" : "s"} failed` : "Everything's ready: it's scheduled", !bad.length);
        changed = true;
      }
    }
  }
  if (changed) await putRun(run);
  return pipelineStatus(postId);
}

/** Start a GPU step: the voiceover (with word-timed subtitles), subtitles for an older voiceover, or a thumbnail. */
async function start(run: Run, post: Post, k: "voice" | "subtitles" | "thumbnail") {
  const { fmt } = await formatOf(post);
  if (k === "voice") {
    const ls = scriptLines(post.script);
    if (!ls.length) throw new Error("no script yet");
    const { getSettings, withDefaults } = await import("./settings");
    const { withProfile } = await import("./profiles");
    const { isCustomVoice, refSync } = await import("./voices");
    const platform = fmt === "yt_short" ? "shorts" : fmt === "ig_reel" ? "reels" : "youtube";
    const body = { lines: ls.map((t, i) => ({ id: String(i + 1).padStart(2, "0"), text: t })), label: post.title, platform, subtitles: true };
    const full = await withProfile(withDefaults(body as never, await getSettings()));
    const ref = typeof full.voice === "string" && isCustomVoice(full.voice) ? await refSync(full.voice) : null;
    const job = await call<{ id: string }>("/jobs", { body: ref ? { ...full, ref } : full });
    run.jobs.voice = { job: job.id, at: Date.now() };
    line(run, `Voicing ${ls.length} lines (${full.engine} · ${full.voice})`);
  } else if (k === "subtitles") {
    const voice = await voiceOf(post);
    if (!voice) throw new Error("voice it first");
    const sign = await signer();
    const job = await call<{ id: string }>("/jobs", { body: { kind: "transcribe", attach_to: voice.id, label: `Subtitles · ${voice.label || voice.id}`,
      sources: await Promise.all(voice.results.map(async (r) => ({ id: r.id, text: r.text, start: (r as { start?: number }).start, url: await sign(voice.id, `${r.id}.wav`) }))) } });
    run.jobs.subtitles = { job: job.id, at: Date.now() };
    line(run, "Making subtitles");
  } else {
    const aspect = fmt === "yt_video" ? "16:9" : fmt === "ig_post" ? "3:4" : fmt ? "9:16" : "16:9";
    const prompt = `${fmt === "yt_video" ? "YouTube thumbnail" : "Cover image"} for "${post.title}": one bold, instantly readable subject that shows the idea, dramatic light, high contrast, clean background with room for a short title, photoreal, sharp focus, no text, no watermark`;
    const job = await call<{ id: string }>("/jobs", { body: { kind: "image", model: "zimage", prompt, aspect, count: 1, label: `Thumbnail · ${post.title}`.slice(0, 80) } });
    run.jobs.thumbnail = { job: job.id, at: Date.now() };
    line(run, `Drawing a ${aspect} thumbnail`);
  }
}

/** The package: researched title, description, tags, hashtags and credits on the post, its captions and plans. */
async function pack(run: Run, postId: string) {
  try {
    const { packPost } = await import("./postpack");
    const r = await packPost(postId, actorOf(run.by));
    line(run, `Package: “${r.pack.title}” · SEO ${r.pack.seo.score} · ${r.pack.hashtags.slice(0, 4).map((h) => `#${h}`).join(" ")}`, true);
  } catch (e) { line(run, `Package: ${(e as Error).message}`, false); }
}

/** Every target without a time gets the next free posting slot (or tomorrow at the same hour as its last post); all
 *  open targets move to Scheduled. Nothing is sent: armed publish plans go out at those times, others wait for you. */
async function schedule(run: Run, post: Post) {
  const { targets } = await formatOf(post);
  if (!targets.length) { line(run, "Schedule: pick where it goes first (Publish to)", false); return; }
  const [{ getRules }, { nextSlot }, { getTargets, setTargets }, { targetsOf }] = await Promise.all([import("./publish/plans"), import("./publish/run"), import("./spacestore"), import("./spaces")]);
  const [rules, map] = await Promise.all([getRules(), getTargets()]);
  const taken = (space: string) => Object.entries(map).flatMap(([pid, ts]) => (pid === post.$id ? [] : ts.filter((t) => t.space === space && t.due_at).map((t) => Date.parse(t.due_at!))));
  let n = 0;
  const next = targetsOf(post, map).map((t) => {
    if (t.status === "posted") return t;
    let due = t.due_at;
    if (!due) {
      due = nextSlot(rules, t.space, taken(t.space)) ?? new Date(Date.now() + 24 * 3600_000).toISOString();
      n++;
    }
    return { ...t, due_at: due, status: "scheduled" as const };
  });
  await setTargets(post.$id, next, actorOf(run.by));
  line(run, n ? `Scheduled: ${n} target${n === 1 ? "" : "s"} got the next posting slot` : "Scheduled at the times already set", true);
}

/** The sweep: every run that's on moves along (so it finishes with nobody watching). */
export async function advancePipelines(budgetMs = 60_000) {
  const until = Date.now() + budgetMs;
  const keys = (await listObjs("workspace/pipelines/").catch(() => [])).map((o) => o.key);
  for (const k of keys) {
    if (Date.now() > until) break;
    const r = await getJson<Run>(k).catch(() => null);
    if (r?.auto && !r.finished) await advance(r.post).catch(() => null);
  }
}
