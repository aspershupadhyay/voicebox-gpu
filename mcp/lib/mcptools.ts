// Voicebox tools: everything on the dashboard, as tools (served by the MCP route, app/api/mcp/route.ts). The Colab GPU worker (Kokoro, Chatterbox, Orpheus, Qwen TTS,
// Whisper subtitles, Resemble Enhance clean-up, Z-Image / Qwen-Image stills) plus the shared workspace in Appwrite
// (posts and their scripts, calendar, comments, media, activity), so an assistant can plan, write, voice and file a post.
import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { loadWorker, STALE_MS } from "@/lib/registry";
import { call, WorkerOffline } from "@/lib/worker";
import { archiveWorkerJob, listLibrary, presignPath } from "@/lib/library";
import { getSettings, updateSettings, withDefaults } from "@/lib/settings";
import { describeProfile, profileFor, withProfile } from "@/lib/profiles";
import { listDataset } from "@/lib/datasets";
import { listModels } from "@/lib/voicemodel";
import {
  addComment, createPost, deletePost, getPost, hasKey, linkJob, listActivity, listComments, listMedia, listMembers, listPosts, postsBetween, updatePost, addMediaBytes, deleteMediaRow, mimeFor } from "@/lib/appwrite";
import { SPACE_IDS, spaceName, targetsOf, type TargetMap } from "@/lib/spaces";
import { dropTargets, getTargets, setTargets } from "@/lib/spacestore";
import { fileUrl, PLATFORMS as POST_PLATFORMS, STATUSES, type Post } from "@/lib/workspace";
import { isCustomVoice, listMyVoices, refSync } from "@/lib/voices";

const ENGINES = ["kokoro", "chatterbox", "orpheus", "qwen", "myvoice", "cosyvoice"] as const;
const ALL_ENGINES = ["kokoro", "chatterbox", "orpheus", "qwen", "myvoice", "cosyvoice", "whisper", "enhance", "apbwe", "zimage", "qwenimage"] as const;
const POST_STATUS = STATUSES.map((s) => s.id) as [Post["status"], ...Post["status"][]];
const POST_PLAT = POST_PLATFORMS.map((p) => p.id) as [Post["platforms"][number], ...Post["platforms"][number][]];
const POST_ID = z.string().regex(/^[A-Za-z0-9._-]{1,36}$/);
const PLATFORMS = ["youtube", "shorts", "reels", "tiktok", "podcast", "raw"] as const;
const MAX_WAIT = 45; // seconds a tool call may block; Vercel caps the request at maxDuration

type Job = { id: string; status: string; progress: { done: number; total: number }; [k: string]: unknown };

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ ...text(e instanceof WorkerOffline ? `OFFLINE: ${e.message}` : `ERROR: ${(e as Error).message}`), isError: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(id: string, seconds: number): Promise<Job> {
  const until = Date.now() + Math.min(seconds, MAX_WAIT) * 1000;
  let job = await call<Job>(`/jobs/${id}`);
  while (["queued", "running"].includes(job.status) && Date.now() < until) {
    await sleep(Math.min(4000, Math.max(0, until - Date.now())));
    job = await call<Job>(`/jobs/${id}`);
  }
  await import("@/lib/telemetry").then((t) => t.noteJob(job as unknown as Parameters<typeof t.noteJob>[0])).catch(() => null); // Health page
  if (job.status === "error" && (job.kind as string) === "train") {
    // "exit 1" says nothing: the end of the train log is the actual reason
    const log = await call<{ text: string }>("/logs/train?n=60").then((r) => r.text.slice(-6000)).catch(() => null);
    return { ...job, log } as Job;
  }
  if (job.status === "done" && (job.kind as string) === "dataset") {
    // a finished dataset batch only counts once it's stored (and, if asked, training has been started)
    const { archiveDataset, autoTrain } = await import("@/lib/datasets");
    const dj = job as unknown as Parameters<typeof archiveDataset>[0];
    const part = await archiveDataset(dj);
    return { ...job, part: part ? await autoTrain(dj, part) : null } as Job;
  }
  if (job.status === "done" && (job.kind as string) === "train") {
    // a trained model counts once it's stored (a retrain then gets compared with the model in use: voice_coach)
    const tj = job as unknown as { train_engine?: string };
    const model = tj.train_engine === "qwen"
      ? await (await import("@/lib/qwenmodels")).archiveQwenModel(job as unknown as Parameters<typeof import("@/lib/qwenmodels").archiveQwenModel>[0]).catch((e: Error) => ({ error: e.message }))
      : await (await import("@/lib/voicemodel")).archiveModel(job as unknown as Parameters<typeof import("@/lib/voicemodel").archiveModel>[0]).catch((e: Error) => ({ error: e.message }));
    return { ...job, model: model ?? { saved: false, note: "still uploading the model; call get_job again in a minute" } } as Job;
  }
  if ((job.kind as string) === "eagle") return job; // a draft model, not audio: nothing for the Library
  if (job.status === "done") {
    try {
      const lib = await archiveWorkerJob(job as unknown as Parameters<typeof archiveWorkerJob>[0]);
      if (lib) job = { ...job, library: { saved: true, dashboard: `/files#${lib.id}`, zip: `/api/zip/${lib.id}` } };
    } catch (e) {
      job = { ...job, library: { saved: false, error: (e as Error).message } };
    }
  }
  return job;
}

function withHint(job: Job) {
  if (["queued", "running"].includes(job.status))
    return { ...job, next: `Still ${job.status} (${job.progress.done}/${job.progress.total}). Call get_job with job_id "${job.id}" to keep waiting.` };
  if (job.status === "done")
    return { ...job, next: "Download each result's url (or zip_url for everything). Links are signed and expire in 6 hours." };
  return job;
}

const line = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("file name stem, e.g. vo-03; defaults to 01, 02, ..."),
  text: z.string().min(1).max(100_000),
  window: z.number().positive().optional().describe("seconds available on the timeline; result gets fits=true/false"),
  start: z.number().min(0).optional().describe("timeline start in seconds (used to place this line in the combined subtitles)"),
  params: z.record(z.string(), z.any()).optional().describe("per-line overrides, e.g. {exaggeration: 0.8}"),
});

export type ToolServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];
export type Actor = { name: string; id?: string };

/** Every Voicebox tool on `server`. `who` is the author shown in the activity feed. */
export function registerTools(server: ToolServer, who: Actor = { name: "Claude (MCP)" }) {
  const CLAUDE = who;
  server.registerTool(
    "worker_status",
    {
      title: "Worker status",
      description: "Is the Colab GPU worker online? Shows GPU, VRAM, which engines are loaded, queue length, the worker version vs the latest, and (once Colab is connected on Health) colab: compute units left, hourly burn, runtimes assigned and the current session. Start / stop / configure the GPU with the gpu tool. logs: the end of one log (an engine name, gateway or train), e.g. to see how long a load took.",
      inputSchema: z.object({ logs: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(), lines: z.coerce.number().int().min(1).max(400).optional() }),
    },
    async ({ logs: want, lines }) => {
      const rec = await loadWorker();
      const { WORKER_VERSION } = await import("@/lib/bundle");
      const colab = await import("@/lib/colab").then((c) => c.status()).catch((e: Error) => ({ error: e.message }));
      if (!rec) return text({ online: false, latest_worker_version: WORKER_VERSION, colab, hint: "No worker has registered: gpu action start, or run the Colab notebook." });
      const age = Math.round((Date.now() - rec.last_seen) / 1000);
      if (age * 1000 > STALE_MS) return text({ online: false, last_seen_s_ago: age, latest_worker_version: WORKER_VERSION, colab, hint: "Colab runtime stopped: gpu action start, or re-run the notebook." });
      try {
        const h = await call<Record<string, unknown> & { engine_errors?: Record<string, string> }>("/health");
        // "exited while loading" says nothing: the end of each failing engine's log is the reason
        const found = await Promise.all(Object.keys(h.engine_errors ?? {}).map(async (n) =>
          [n, await call<{ text: string }>(`/logs/${n}?n=40`).then((r) => r.text.slice(-4000)).catch(() => null)] as const));
        const logs: Record<string, string | null> = Object.fromEntries(found);
        if (want) logs[want] = await call<{ text: string }>(`/logs/${want}?n=${lines ?? 80}`).then((r) => r.text.slice(-12000)).catch((e: Error) => e.message);
        return text({ online: true, last_seen_s_ago: age, ...h, latest_worker_version: WORKER_VERSION, colab, ...(Object.keys(logs).length ? { engine_logs: logs } : {}) });
      } catch (e) {
        return text({ online: false, last_seen_s_ago: age, registered: rec, error: (e as Error).message, colab });
      }
    },
  );

  server.registerTool(
    "list_voices",
    {
      title: "List voices and parameters",
      description:
        "Engines, voices, presets (female/male), every tunable parameter with default/min/max, post-processing defaults, delivery styles, publishing platforms (loudness + caption presets), and uploaded reference voices.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return text(await call("/voices"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "voice_lines",
    {
      title: "Generate voiceover lines",
      description: [
        "Synthesise one or more lines on the GPU worker and return signed WAV links (48 kHz mono, trimmed, mastered for the platform: broadcast voice chain + -14 LUFS by default).",
        "platform (default youtube) masters for where it's going: youtube / shorts / reels / tiktok = -14 LUFS, podcast = -16 LUFS, raw = no mastering (peak -3 dBFS, for mixing yourself); shorts/reels/tiktok also cut subtitles into 1-3 word pop-up captions. Each result reports its lufs.",
        "takes: 2-4 = best-of-N: every sentence is voiced N times and the take Whisper hears most accurately (and, for a cloned voice, that sounds most like the recording) wins. Costs N x the time; worth it for final renders.",
        "Script markup: [pause], [pause 0.8], [pause 500ms], [beat], [breath] insert real silence. Tech terms are said right automatically (SQL -> sequel, GPU -> G P U, JSON -> jay-son, 16GB -> 16 gigabytes, markdown and URLs cleaned); pronounce: {word: 'how to say it'} adds your own, lexicon: false turns it off. The script itself is untouched for subtitles.",
        "With a recorded voice on qwen, lines in Devanagari (Hindi) are voiced by Chatterbox in the same voice automatically. With subtitles on and a cloned voice, each line also gets similarity (voice match vs the recording; 0.86+ = same speaker).",
        "Engines: kokoro (fast drafts, many languages), chatterbox (emotion dial + cloning, 23 languages incl. Hindi), orpheus (most human, English; tags like <laugh> <sigh>), qwen (best cloning of the user's recorded voice, or a fine-tuned voice ft_<name> from my_voices.fine_tuned; 10 languages, no Hindi; params.language takes names like English), myvoice (a fine-tuned Orpheus model of one of the two creators, once trained: English; voice = the person's model name from my_voices.trained, 'me' = the newest; most human, carries delivery across sentences), cosyvoice (CosyVoice 2: fast zero-shot cloning of a recorded voice, like qwen; params speed, seed; new, being compared).",
        "No length limit: long text is split at sentences, voiced in one batch and re-joined.",
        "subtitles: true adds Whisper large-v3 word-timed SRT/VTT per line and for the whole timeline (uses each line's start when given), plus a match score vs the script.",
        "voice: 'female' / 'male' presets, an engine voice (e.g. tara, dan, af_heart), or the name of a recorded voice from my_voices (qwen or chatterbox).",
        "style sets the delivery (default 'tech'): tech = bright YouTube-tech pace (~185 wpm), hype = max energy for promos, narrator = calm documentary (~165 wpm), neutral = engine defaults. Explicit params override the style. For energy the voice matters most (Orpheus temperature does not add energy): orpheus mia/leo, kokoro am_fenrir/af_bella; chatterbox via exaggeration.",
        "First use of an engine installs + loads it (several minutes); the job keeps running, so poll with get_job.",
        "post_id: voice a workspace post. Without lines, its script is used (one line per non-empty line); the voiceover is attached to the post either way.",
        "review (default on, from settings): Whisper listens back to every sentence; any sentence that skipped, swapped or invented words, or drifted off the voice, is re-voiced (up to 2 more tries, trying the voice's settings a little either side). Each result reports review {retried, fixed, issues:[{missed, added}]}. The scores teach the voice its best settings over time (voice_profile).",
      ].join(" "),
      inputSchema: z.object({
        engine: z.enum(ENGINES).optional().describe("default from settings (qwen unless changed)"),
        voice: z.string().optional().describe("default from settings"),
        lines: z.array(line).min(1).max(1000).optional().describe("required unless post_id is given"),
        post_id: POST_ID.optional().describe("workspace post: voice its script and attach the result to it"),
        review: z.boolean().optional().describe("listen back and re-voice sentences that missed (default on)"),
        review_batch: z.boolean().optional().describe("benchmarking only: true = the review hears every take in one batched call, false = four at a time (default: the worker's setting)"),
        subtitles: z.boolean().optional().describe("also make word-timed subtitles with Whisper large-v3 turbo (turn off to finish faster: ~110 s on a 9-minute voiceover)"),
        polish: z.boolean().optional().describe("studio polish: AP-BWE adds the 12-24 kHz air the 24 kHz voice models leave out (24 -> 48 kHz, the voice itself untouched), kept only where it still sounds like the voice; ~5 s on a 9-minute voiceover (Resemble Enhance, ~90 s, if it fails). Default on for myvoice, off otherwise"),
        language: z.string().max(8).optional().describe("ISO code for Whisper/Chatterbox, e.g. en, hi; omit to auto-detect"),
        style: z.enum(["tech", "hype", "narrator", "neutral"]).optional().describe("delivery style; default tech"),
        platform: z.enum(PLATFORMS).optional().describe("where it's going: sets loudness + caption cut; default youtube"),
        takes: z.number().int().min(1).max(4).optional().describe("best-of-N per sentence (default 1)"),
        captions: z.enum(["subtitles", "punchy"]).optional().describe("override the platform's caption cut"),
        pronounce: z.record(z.string(), z.string()).optional().describe("custom pronunciations, e.g. {\"Kubernetes\": \"koo-ber-net-eez\"}"),
        lexicon: z.boolean().optional().describe("built-in tech pronunciation (default true)"),
        params: z.record(z.string(), z.any()).optional().describe("engine params for all lines (override the style); see list_voices"),
        post: z
          .object({
            tempo: z.number().min(0.5).max(2).optional().describe("pitch-preserving pace multiplier, e.g. 1.05"),
            polish_engine: z.enum(["apbwe", "resemble"]).optional().describe("benchmarking: which model studio polish runs on (default: the worker's setting)"),
            trim: z.boolean().optional(),
            trim_db: z.number().optional(),
            normalize_dbfs: z.number().nullable().optional(),
            sample_rate: z.number().int().nullable().optional(),
            master: z.enum(PLATFORMS).nullable().optional().describe("override the platform's mastering; raw/null = peak normalise only"),
          })
          .optional(),
        label: z.string().max(80).optional(),
        wait_seconds: z.number().min(0).max(MAX_WAIT).optional().describe(`block up to this long for results (default ${MAX_WAIT})`),
      }),
    },
    async ({ wait_seconds, post_id, polish, ...body }) => {
      try {
        if (polish !== undefined) body.post = { ...(body.post ?? {}), enhance: polish ? "auto" : false } as typeof body.post;
        let post: Post | null = null;
        if (post_id) {
          post = await getPost(post_id);
          if (!body.lines?.length) {
            const ls = (post.script ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
            if (!ls.length) throw new Error(`post "${post.title}" has no script yet; update_post with a script first`);
            body.lines = ls.map((t, i) => ({ id: String(i + 1).padStart(2, "0"), text: t }));
          }
          body.label ??= post.title;
          const plat = post.platforms.find((x) => (PLATFORMS as readonly string[]).includes(x === "instagram" ? "reels" : x));
          if (!body.platform && plat) body.platform = (plat === "instagram" ? "reels" : plat) as (typeof PLATFORMS)[number];
        }
        if (!body.lines?.length) throw new Error("send lines, or a post_id whose script to voice");
        const full = await withProfile(withDefaults(body, await getSettings()));
        const ref = typeof full.voice === "string" && isCustomVoice(full.voice) ? await refSync(full.voice) : null;
        const job = await call<Job>("/jobs", { body: ref ? { ...full, ref } : full });
        if (post) await linkJob(post.$id, job.id, CLAUDE);
        return text(withHint(await waitFor(job.id, wait_seconds ?? MAX_WAIT)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "revoice",
    {
      title: "Re-voice a performance in a recorded voice",
      description: [
        "Speech-to-speech: take a performance (any audio or video URL: a phone voice memo, a rough take, a screen recording) and re-speak it in a recorded voice (my_voices name, or female/male) with Chatterbox VC.",
        "Timing, emphasis and emotion come from the performance, the voice and studio clarity from the recording, so it stays in sync with the original video. Up to 15 minutes.",
        "Mastered for the platform like voice_lines; subtitles: true adds word-timed captions of what was said plus the voice match score.",
      ].join(" "),
      inputSchema: z.object({
        url: z.string().url().describe("the performance: public or signed https link to audio or video"),
        voice: z.string().optional().describe("recorded voice name (my_voices) or female/male; default from settings"),
        enhance: z.boolean().optional().describe("denoise the performance first (default from settings: on)"),
        platform: z.enum(PLATFORMS).optional().describe("default youtube"),
        subtitles: z.boolean().optional(),
        language: z.string().max(8).optional().describe("for the subtitles, e.g. en, hi"),
        label: z.string().max(80).optional(),
        wait_seconds: z.number().min(0).max(MAX_WAIT).optional().describe(`block up to this long (default ${MAX_WAIT})`),
      }),
    },
    async ({ wait_seconds, ...body }) => {
      try {
        const s = await getSettings();
        const full = withDefaults({ ...body, kind: "revoice", voice: body.voice ?? (s.engine === "qwen" || s.engine === "chatterbox" ? s.voice : "female") }, s);
        const ref = isCustomVoice(String(full.voice)) ? await refSync(String(full.voice)) : null;
        const job = await call<Job>("/jobs", { body: { ...full, ...(ref ? { ref } : {}) } });
        return text(withHint(await waitFor(job.id, wait_seconds ?? MAX_WAIT)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "clean_audio",
    {
      title: "Studio clean-up of a recording",
      description: [
        "Make a recording from a bad mic sound studio-grade: Resemble Enhance removes noise and room echo and restores the detail a cheap mic or phone loses (to 44.1 kHz), then it is mastered for the platform. Same length as the input, so it stays in sync with video.",
        "It measures the recording first (noise floor, bandwidth, room echo, clipping) and runs only what it needs: DeepFilterNet for noise, Resemble Enhance to restore a thin or echoey recording, both when needed, then checks it still sounds like the same person. The result reports cleanup {steps, why, before, after}.",
        "url: any audio or video link. cleanup: auto (default), denoise (noise only, keeps the exact tone) or enhance (always restore).",
      ].join(" "),
      inputSchema: z.object({
        url: z.string().url(),
        cleanup: z.enum(["auto", "denoise", "enhance"]).optional().describe("default auto: measured per recording"),
        params: z.object({ strength: z.number().min(0).max(1).optional(), steps: z.number().int().min(16).max(128).optional() }).optional().describe("Resemble Enhance fine-tuning"),
        platform: z.enum(PLATFORMS).optional(),
        subtitles: z.boolean().optional(),
        label: z.string().max(80).optional(),
        wait_seconds: z.number().min(0).max(MAX_WAIT).optional(),
      }),
    },
    async ({ wait_seconds, ...body }) => {
      try {
        const job = await call<Job>("/jobs", { body: withDefaults({ ...body, kind: "clean" }, await getSettings()) });
        return text(withHint(await waitFor(job.id, wait_seconds ?? MAX_WAIT)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "preview_pronunciation",
    {
      title: "Preview what the voice will read",
      description: "Dry run of the pronunciation layer (no GPU, instant): shows exactly what the engine will say for each line after tech terms, the user's dictionary, markdown/URL clean-up and [pause] markers. Use it before a long render to catch mispronunciations, then fix them with pronounce.",
      inputSchema: z.object({
        lines: z.array(z.string().max(5000)).min(1).max(200),
        pronounce: z.record(z.string(), z.string()).optional(),
        lexicon: z.boolean().optional(),
      }),
    },
    async (body) => {
      try {
        const s = await getSettings();
        return text(await call("/speakable", { body: { ...body, pronounce: { ...s.pronounce, ...(body.pronounce ?? {}) }, lexicon: body.lexicon ?? s.lexicon } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_settings",
    {
      title: "Studio defaults",
      description: "The user's saved defaults (engine, voice, style, platform, takes, pronunciation dictionary, studio enhance switches, R2 backup of workspace uploads). Every tool fills unset arguments from these.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return text(await getSettings());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_settings",
    {
      title: "Change studio defaults",
      description: "Save new defaults (only the keys given change). pronounce REPLACES the dictionary: read get_settings first and send the merged map. Only change settings when the user asks.",
      inputSchema: z.object({
        engine: z.enum(ENGINES).optional(), voice: z.string().max(64).optional(), style: z.enum(["tech", "hype", "narrator", "neutral"]).optional(),
        platform: z.enum(PLATFORMS).optional(), takes: z.number().int().min(1).max(4).optional(), subtitles: z.boolean().optional(),
        lexicon: z.boolean().optional(), pronounce: z.record(z.string(), z.string()).optional(),
        enhance_recordings: z.boolean().optional(), enhance_input: z.boolean().optional(), enhance_output: z.boolean().optional(),
        backup_media: z.boolean().optional().describe("copy workspace uploads to R2 as a backup"),
        review: z.boolean().optional().describe("listen back to every voiceover and re-voice sentences that missed"),
      }),
    },
    async (patch) => {
      try {
        return text(await updateSettings(patch));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "my_voices",
    {
      title: "List the user's recorded voices",
      description: "The studio's voices. recorded: voices recorded in the dashboard (Voices page); use a name as `voice` with engine qwen (best match) or chatterbox (Hindi, emotion dial). trained: each person's own trained model; use its name as `voice` with engine myvoice (the most natural English read). fine_tuned: fine-tuned Qwen3-TTS voices; use ft_<name> as `voice` with engine qwen.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const { listQwenModels } = await import("@/lib/qwenmodels");
        const [recorded, trained, tuned] = await Promise.all([listMyVoices(false), listModels().catch(() => []), listQwenModels().catch(() => [])]);
        return text({ recorded: recorded.map((v) => ({ name: v.name, label: v.label, seconds: v.duration, transcript: v.transcript })),
          trained: trained.map((m) => ({ name: m.name, engine: "myvoice", minutes_trained_on: m.minutes, trained: new Date(m.created).toISOString().slice(0, 10) })),
          fine_tuned: tuned.map((m) => ({ voice: `ft_${m.name}`, engine: "qwen", minutes_trained_on: m.minutes, trained: new Date(m.created).toISOString().slice(0, 10) })) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gpu",
    {
      title: "Control the Colab GPU",
      description: "The GPU without opening Colab (Colab is connected on the Health page). Actions: status (default): compute units left, hourly burn, runtimes assigned, the current session, settings. start: assign a Colab GPU and launch the worker on it; it shows online in worker_status in about 2 min. Pick by purpose: voice (voiceovers, subtitles, clean-up: settings voice_gpu, an L4 by default, far cheaper and plenty for them) or heavy (training, RLHF polish, video: settings heavy_gpu, an A100); or name gpu (A100 / L4 / H100 / T4 / G4) outright; high_ram true/false overrides the setting. status shows rates: the units an hour Colab really charged per runtime kind. stop: release a runtime (endpoint, default the current session's; with nothing else known, the only runtime assigned) and billing stops at once. restart_worker: restart the worker process on the running GPU (keeps the runtime; force: true even while a job runs). update_worker: fetch the newest worker code and restart with it (worker 3.1.0+). selfcheck: run the worker's quick self-check (results in worker_status.selfcheck). train_draft: train an EAGLE draft for Orpheus (faster single-request decoding): voices sentences (default 6000) for its data, trains it, then benchmarks Orpheus plain vs with the draft; it's switched on only if it measured faster. Takes the whole GPU (~45-60 min on an L4); returns a job id for get_job. settings: change gpu (default for start without a purpose), voice_gpu, heavy_gpu, high_ram, idle_stop_min (0 = never; stops a GPU started from the app after that many idle minutes), remind_hours (0 = never), low_units (warn below), ntfy (on / off: phone push via the ntfy app). notify_test: send a test push.",
      inputSchema: z.object({
        action: z.enum(["status", "start", "stop", "restart_worker", "update_worker", "selfcheck", "train_draft", "settings", "notify_test"]).optional(),
        sentences: z.number().int().min(500).max(30000).optional().describe("train_draft: sentences voiced for its data (default 6000)"),
        epochs: z.number().int().min(1).max(5).optional().describe("train_draft: passes over the data (default 2)"),
        gpu: z.enum(["A100", "L4", "H100", "T4", "G4"]).optional(),
        purpose: z.enum(["voice", "heavy"]).optional(),
        high_ram: z.boolean().optional(),
        voice_gpu: z.enum(["A100", "L4", "H100", "T4", "G4"]).optional(),
        heavy_gpu: z.enum(["A100", "L4", "H100", "T4", "G4"]).optional(),
        endpoint: z.string().max(200).optional(),
        force: z.boolean().optional(),
        idle_stop_min: z.number().min(0).max(600).optional(),
        remind_hours: z.number().min(0).max(12).optional(),
        low_units: z.number().min(0).max(500).optional(),
        ntfy: z.enum(["on", "off"]).optional(),
      }),
    },
    async ({ action, gpu, purpose, high_ram, voice_gpu, heavy_gpu, endpoint, force, idle_stop_min, remind_hours, low_units, ntfy, sentences, epochs }) => {
      try {
        const colab = await import("@/lib/colab");
        if (action === "start") return text({ ...(await colab.start(colab.appOrigin(), gpu, { purpose, high_ram })), next: "The worker comes online in about 2 min: check worker_status." });
        if (action === "stop") {
          let ep = endpoint ?? (await colab.getSession())?.endpoint;
          if (!ep) {
            const all = await colab.runtimes();
            if (all.length !== 1) throw new Error(all.length ? `${all.length} runtimes are assigned: pass endpoint (${all.map((r) => `${r.accelerator} ${r.endpoint}`).join(", ")})` : "no runtime is assigned");
            ep = all[0].endpoint;
          }
          return text(await colab.stopRuntime(ep, "stopped by an agent"));
        }
        if (action === "restart_worker") return text(await call("/admin/restart", { body: { force: !!force } }));
        if (action === "update_worker") return text(await call("/admin/update", { body: { url: `${colab.appOrigin()}/api/bundle` }, timeoutMs: 55_000 }));
        if (action === "selfcheck") return text(await call("/selfcheck", { body: {} }));
        if (action === "train_draft") return text(await call("/jobs", { body: { kind: "eagle", sentences, epochs, label: "Orpheus draft (EAGLE)" } }));
        if (action === "notify_test") return text({ sent: await colab.notify("Voicebox test", "Notifications work: GPU reminders arrive here.", "bell") });
        if (action === "settings") {
          const cur = await colab.getConfig();
          const topic = ntfy === "off" ? null : ntfy === "on" ? (cur.ntfy_topic ?? `voicebox-${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`) : undefined;
          const next = await colab.setConfig({ gpu, voice_gpu, heavy_gpu, high_ram, idle_stop_min, remind_hours, low_units, ...(topic !== undefined ? { ntfy_topic: topic } : {}) });
          return text({ ...next, ...(next.ntfy_topic ? { ntfy_subscribe: `Install the ntfy app and subscribe to ${next.ntfy_topic} (https://ntfy.sh/${next.ntfy_topic})` } : {}) });
        }
        return text(await colab.status());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "voice_coach",
    {
      title: "How a trained voice is improving",
      description: "The voice coach for one person's trained voice (myvoice <name> or qwen ft_<name>). Every voiceover it reads is scored line by line (words heard, voice match, naturalness, pitch spread, pace, pauses) and people can rate lines. action report (default): weak spots (e.g. flat questions, rushed long sentences), words it keeps missing (fix with pronounce in update_settings), recent scores, and the last model comparisons. action script: the next recording session (~minutes long) written around those weak spots; record it and add it with voice_dataset (auto_train: true) — 15+ new minutes retrain the voice, and the retrain goes live only if it beats the current model. action rate: thumbs up (1) / down (-1) / clear (0) on one line of a finished job (job_id + line id). RLHF: report.feedback counts preference pairs (the review's kept take vs its worst take, ratings count double); action practice voices ~40 bank sentences 3 takes each to collect pairs (minutes of GPU); action polish (100+ pairs, 200 better) runs DPO on the Orpheus model in use (~15-30 min on an A100), then the model check decides whether it goes live.",
      inputSchema: z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/).describe("whose voice (the dataset / model name)"),
        action: z.enum(["report", "script", "rate", "practice", "polish"]).optional(),
        minutes: z.number().min(2).max(20).optional().describe("script: session length (default 8)"),
        job_id: z.string().optional().describe("rate: the voiceover job"),
        line: z.string().optional().describe("rate: the line id"),
        rating: z.number().int().min(-1).max(1).optional().describe("rate: 1 good, -1 bad, 0 clear"),
      }),
    },
    async ({ name, action, minutes, job_id, line, rating }) => {
      try {
        const coach = await import("@/lib/coach");
        if (action === "script") return text(await coach.nextScript(name, minutes ?? 8));
        if (action === "practice" || action === "polish") {
          const pairs = await import("@/lib/pairs");
          const { withProfile } = await import("@/lib/profiles");
          const job = await call<Job>("/jobs", { body: action === "polish" ? await pairs.dpoJobBody(name) : await withProfile(await pairs.practiceJobBody(name)) });
          return text(withHint(job));
        }
        if (action === "rate") {
          if (!job_id || !line || rating == null) throw new Error("rate needs job_id, line and rating");
          const { getLibJob } = await import("@/lib/library");
          const lib = await getLibJob(job_id);
          if (!lib) throw new Error("that job isn't in the library (yet)");
          const r = lib.results.find((x) => x.id === line);
          return text(await coach.rate({ engine: lib.engine, voice: lib.voice, job: job_id, line, rating, text: r?.text, duration: r?.duration }));
        }
        return text(await coach.report(name));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "voice_profile",
    {
      title: "What a voice has learned",
      description: "Per engine + voice + delivery style: how many reviewed voiceovers it has, its usual voice-match score, the temperature that has scored best (used automatically when a request doesn't set one), and every setting tried with its average score.",
      inputSchema: z.object({ engine: z.enum(ENGINES), voice: z.string().max(64), style: z.enum(["tech", "hype", "narrator", "neutral"]).optional() }),
    },
    async ({ engine, voice, style }) => {
      try {
        return text((await describeProfile(engine, voice, style)) ?? { engine, voice, style: style ?? "tech", jobs: 0, note: "no reviewed voiceovers yet" });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "voice_dataset",
    {
      title: "Your voice dataset",
      description: "Training data collected for the user's own voice model (Professional voice clone page (Voices)): sessions, clips, minutes (15 works, 30 good, 60 best). add_urls adds recordings (long audio/video of only the user speaking, any https link): the worker cleans them, cuts 2-20 s clips at sentence ends with Whisper, drops noisy/clipped/mis-timed ones. One dataset per person (name = that person's model name). Training: auto_train starts it as soon as the batch is stored (once 15+ minutes are collected; a voice that already has a model retrains once 15+ new minutes are in), else train_voice (or the Professional voice clone page (Voices)'s Train button) runs it on the GPU worker (about 1-2 h); the result is engine myvoice, voice = the dataset name.",
      inputSchema: z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/).optional().describe("dataset name = whose voice (each person has their own, e.g. their first name); default me"),
        add_urls: z.array(z.string().url()).max(20).optional().describe("recordings to add"),
        auto_train: z.boolean().optional().describe("start training on the whole dataset once these are stored, if it has 15+ minutes"),
        wait_seconds: z.number().min(0).max(MAX_WAIT).optional(),
      }),
    },
    async ({ name, add_urls, auto_train, wait_seconds }) => {
      try {
        const ds = name ?? "me";
        if (add_urls?.length) {
          const job = await call<Job>("/jobs", { body: { kind: "dataset", name: ds, sources: add_urls.map((url, i) => ({ url, name: `recording ${i + 1}` })), label: `Dataset · ${ds}`, auto_train } });
          const j = await waitFor(job.id, wait_seconds ?? 10);
          return text({ job: withHint(j), dataset: await listDataset(ds) });
        }
        return text(await listDataset(ds));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "train_voice",
    {
      title: "Train a voice model",
      description: "Train a voice on everything collected in a dataset (voice_dataset), on the GPU worker; other jobs wait. engine orpheus (default): an Orpheus 3B LoRA, about 1-2 h, voice = the name on engine myvoice. engine qwen: a full Qwen3-TTS 1.7B fine-tune (needs an A100/L4/A10 runtime), voice ft_<name> on engine qwen. Any amount trains; 15+ minutes kept sounds right, 30 good, 60 best. A first model goes live as soon as it's stored; a retrain is first compared with the model in use on held-out sentences and replaces it only if it scores at least as well (voice_coach shows the result). Follow it with get_job.",
      inputSchema: z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/).describe("the dataset to train on (whose voice)"),
        engine: z.enum(["orpheus", "qwen"]).optional().describe("which model learns the voice (default orpheus)"),
      }),
    },
    async ({ name, engine }) => {
      try {
        const { listDataset, trainJobBody, TRAIN_MIN_MINUTES } = await import("@/lib/datasets");
        const d = await listDataset(name);
        if (!d.clips) throw new Error(`${name} has no clips yet: add recordings with voice_dataset first`);
        const note = d.minutes < TRAIN_MIN_MINUTES ? `only ${d.minutes} min: it trains, but ${TRAIN_MIN_MINUTES}+ min sounds much more like the speaker` : undefined;
        const running = (await call<{ jobs: { kind: string; voice: string; status: string; id: string }[] }>("/jobs")).jobs
          .find((j) => j.kind === "train" && j.voice === name && ["queued", "running"].includes(j.status) && ((j as { train_engine?: string }).train_engine ?? "orpheus") === (engine ?? "orpheus"));
        if (running) return text({ already_training: running.id, next: `Call get_job with job_id "${running.id}" to follow it.` });
        return text({ ...withHint(await call<Job>("/jobs", { body: await trainJobBody(name, undefined, engine ?? "orpheus") })), note });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "benchmark_voices",
    {
      title: "Benchmark voices",
      description: "Voice the same held-out sentences with several engines/voices (e.g. the user's trained model 'myvoice', their Qwen and Chatterbox clones, an Orpheus preset) and score each the same way: script accuracy, voice match vs the user's real recording (target_voice), naturalness (UTMOS), speed. Each candidate runs at its learned settings. Returns a ranked table; audio for every line lands in the library for A/B listening. Takes minutes: poll get_job.",
      inputSchema: z.object({
        lines: z.array(z.string().min(3).max(500)).min(1).max(20).describe("sentences the trained model never heard"),
        candidates: z.array(z.object({ engine: z.enum(ENGINES), voice: z.string().max(64).optional(), label: z.string().max(60).optional() })).min(1).max(6),
        target_voice: z.string().max(64).optional().describe("the user's recorded voice to measure similarity against (my_voices name)"),
        style: z.enum(["tech", "hype", "narrator", "neutral"]).optional(),
        wait_seconds: z.number().min(0).max(MAX_WAIT).optional(),
      }),
    },
    async ({ lines, candidates, target_voice, style, wait_seconds }) => {
      try {
        const names = new Set([...candidates.map((c) => c.voice ?? ""), target_voice ?? ""].filter((v) => isCustomVoice(v)));
        const refs = Object.fromEntries((await Promise.all([...names].map(async (v) => [v, await refSync(v)] as const))).filter(([, r]) => r));
        const cands = await Promise.all(candidates.map(async (c) => {
          const prof = await profileFor(c.engine, c.voice, style ?? "tech").catch(() => null);
          return { ...c, params: prof?.params ?? {} };
        }));
        const job = await call<Job>("/jobs", { body: { kind: "benchmark", lines, candidates: cands, target_voice, target_ref: target_voice ? refs[target_voice] : undefined, refs, style: style ?? "tech", platform: "youtube", label: "Benchmark" } });
        const j = await waitFor(job.id, wait_seconds ?? 10);
        return text(j.status === "done" ? { benchmark: (j as Record<string, unknown>).benchmark, library: (j as Record<string, unknown>).library } : withHint(j));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "imagine",
    {
      title: "Generate images",
      description: [
        "Generate 1-4 images on the GPU worker and save them to the library (full PNGs + thumbnails).",
        "model zimage (default): Z-Image-Turbo 6B, photoreal, 8 steps, ~2 s per image, up to 1344 px; Apache-2.0, commercial use OK. No negative prompt (no CFG).",
        "model qwenimage: Qwen-Image-2.1, native 2K, best text rendering (put exact words in quotes), edits/combines up to 10 reference images (image_urls or from_library; refer to them as image 1, image 2...), transparent: true gives an RGBA PNG; quality 'quality' = base model, 40 steps. Qwen Research license: NON-commercial only.",
        "Prompts: subject, setting, light, lens, style; concrete nouns over adjectives. Each image uses seed+i.",
        "First use downloads the weights (zimage ~33 GB, qwenimage ~33 GB, +14 GB for quality). Returns a job id; poll get_job until done.",
      ].join(" "),
      inputSchema: z.object({
        prompt: z.string().min(3).max(4000),
        model: z.enum(["zimage", "qwenimage"]).optional().describe("default zimage"),
        aspect: z.enum(["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"]).optional().describe("default 1:1"),
        count: z.number().int().min(1).max(4).optional().describe("default 1"),
        quality: z.enum(["turbo", "quality"]).optional().describe("qwenimage only; default turbo"),
        transparent: z.boolean().optional().describe("qwenimage only: transparent background"),
        seed: z.number().int().optional(),
        negative: z.string().max(2000).optional(),
        image_urls: z.array(z.string().url()).max(10).optional().describe("qwenimage only: reference images to edit/combine"),
        from_library: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}(:\d{1,2})?$/)).max(10).optional().describe("qwenimage only: library ids (image sets as <id>:<index>) to use as references"),
        label: z.string().max(80).optional(),
        wait_seconds: z.number().min(0).max(MAX_WAIT).optional().describe("block up to this long (default 30)"),
      }),
    },
    async ({ wait_seconds, from_library, image_urls, ...body }) => {
      try {
        const refs = [...(image_urls ?? [])];
        if (from_library?.length) {
          const { getLibJob } = await import("@/lib/library");
          for (const ref of from_library) {
            const [id, n] = ref.split(":");
            const lib = await getLibJob(id);
            if (!lib) throw new Error(`library item ${id} not found`);
            const path = lib.kind === "image" && lib.images?.length ? lib.images[Math.min(lib.images.length - 1, Number(n) || 0)].file : lib.video?.poster ? "poster.jpg" : null;
            if (!path) throw new Error(`library item ${id} has no image`);
            refs.push(await presignPath(`library/${lib.id}/${path}`, 3600));
          }
        }
        const job = await call<Job>("/jobs", { body: { ...body, model: body.model ?? "zimage", kind: "image", image_urls: refs.length ? refs.slice(0, 10) : undefined } });
        return text(withHint(await waitFor(job.id, wait_seconds ?? 30)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: "Status and results of any job (voice, clean-up, re-voice, subtitles, images, dataset batches). Waits up to wait_seconds for it to finish. A finished dataset batch is stored in the dataset here (and starts training if it was sent with auto_train).",
      inputSchema: z.object({
        job_id: z.string().regex(/^[a-f0-9]{12}$/),
        wait_seconds: z.number().min(0).max(MAX_WAIT).optional(),
      }),
    },
    async ({ job_id, wait_seconds }) => {
      try {
        return text(withHint(await waitFor(job_id, wait_seconds ?? MAX_WAIT)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "transcribe",
    {
      title: "Transcribe to subtitles",
      description:
        "Whisper large-v3 on any audio/video URLs (or a library job id): word timestamps, SRT + VTT + JSON, 99 languages. Pass text to get a match score vs a script.",
      inputSchema: z
        .object({
          sources: z.array(z.object({ url: z.string().url(), name: z.string().optional(), text: z.string().optional() })).max(200).optional(),
          library_job: z.string().optional().describe("subtitle an existing library job; results attach to it"),
          language: z.string().max(8).optional(),
          label: z.string().max(80).optional(),
          wait_seconds: z.number().min(0).max(MAX_WAIT).optional(),
        })
        .refine((v) => v.sources?.length || v.library_job, "send sources or library_job"),
    },
    async ({ sources, library_job, language, label, wait_seconds }) => {
      try {
        let body: Record<string, unknown> = { kind: "transcribe", language, label };
        if (library_job) {
          const { getLibJob, signer } = await import("@/lib/library");
          const lib = await getLibJob(library_job);
          if (!lib) throw new Error("library job not found");
          const sign = await signer();
          body = { ...body, attach_to: lib.id, label: label || `Subtitles · ${lib.label || lib.id}`,
            sources: await Promise.all(lib.results.map(async (r) => ({ id: r.id, text: r.text, start: r.start, url: await sign(lib.id, `${r.id}.wav`) }))) };
        } else {
          body.sources = sources!.map((s, i) => ({ id: String(i + 1).padStart(2, "0"), ...s }));
        }
        const job = await call<Job>("/jobs", { body });
        return text(withHint(await waitFor(job.id, wait_seconds ?? MAX_WAIT)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_library",
    {
      title: "List saved voiceovers",
      description:
        "Every finished job saved permanently in the dashboard's Files page (survives the Colab runtime). Download with Bearer MCP_TOKEN: GET /api/zip/<id> (all lines) or /api/audio/<id>/<line>.wav.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    },
    async ({ limit }) => {
      try {
        const jobs = (await listLibrary()).slice(0, limit ?? 30);
        return text(jobs.map((j) => ({ id: j.id, engine: j.engine, voice: j.voice, label: j.label, created: new Date(j.created).toISOString(),
          lines: j.results.length, seconds: +j.results.reduce((s, r) => s + r.duration, 0).toFixed(1), zip: `/api/zip/${j.id}` })));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_jobs",
    { title: "List jobs", description: "The 30 most recent jobs on the worker.", inputSchema: z.object({}) },
    async () => {
      try {
        return text(await call("/jobs"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel job",
      description: "Cancel a queued job, or stop a running one after its current line.",
      inputSchema: z.object({ job_id: z.string().regex(/^[a-f0-9]{12}$/) }),
    },
    async ({ job_id }) => {
      try {
        return text(await call(`/jobs/${job_id}/cancel`, { body: {} }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_reference_voice",
    {
      title: "Add reference voice",
      description:
        "Upload a clip (5-20 s of clean speech) so chatterbox can clone it; then use its name as `voice` with engine chatterbox.",
      inputSchema: z
        .object({
          name: z.string().regex(/^[a-z0-9_-]{2,40}$/),
          url: z.string().url().optional().describe("https link to a wav/mp3/flac"),
          audio_b64: z.string().max(14_000_000).optional().describe("base64 audio, if no url"),
          transcript: z.string().max(1000).optional(),
        })
        .refine((v) => v.url || v.audio_b64, "send url or audio_b64"),
    },
    async (args) => {
      try {
        return text(await call("/refs", { body: args, timeoutMs: 55_000 }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "engine",
    {
      title: "Load or unload an engine",
      description:
        "Prewarm an engine before a batch (install + load runs in the background) or unload it to free VRAM. Engines are also loaded on demand and evicted LRU.",
      inputSchema: z.object({ name: z.enum(ALL_ENGINES), action: z.enum(["load", "unload", "forget"]).describe("forget = unload and delete its downloaded weights to free disk") }),
    },
    async ({ name, action }) => {
      try {
        return text(await call(`/engines/${name}/${action}`, { body: {} }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── shared workspace (Appwrite): the same posts, calendar, comments and media the two of you see on the dashboard

  const brief = (p: Post, tmap?: TargetMap) => ({
    id: p.$id, title: p.title, status: p.status, platforms: p.platforms,
    ...(tmap ? { goes_to: targetsOf(p, tmap).map((t) => ({ space: t.space, name: spaceName(t.space), status: t.status, due_at: t.due_at ?? null, link: t.link ?? null })) } : {}), due_at: p.due_at, owner: p.owner_name, assignee: p.assignee_name,
    voiceovers: p.jobs?.length ?? 0, script_words: p.script?.trim() ? p.script.trim().split(/\s+/).length : 0, updated: p.$updatedAt,
    link: `/posts?post=${p.$id}`,
  });
  const ws = async <T,>(fn: () => Promise<T>) => {
    if (!hasKey()) return { ...text("ERROR: the shared workspace is not configured on the server (APPWRITE_API_KEY)."), isError: true };
    try { return text(await fn()); } catch (e) { return fail(e); }
  };
  const files = async <T,>(fn: () => Promise<T>) => { try { return text(await fn()); } catch (e) { return fail(e); } };
  const FILE_ID = z.string().regex(/^[mg]:[A-Za-z0-9._-]{1,64}$/).describe("a file id from list_files: m:<upload id> or g:<generated id>");
  const ITEM_ID = z.string().regex(/^(?:[mg]:[A-Za-z0-9._-]{1,64}|f:[a-z0-9]{6,16})$/).describe("a file id (m:… / g:…) or a folder as f:<folder id>");
  const FOLDER_REF = z.string().max(300).describe("a folder id, or its path by name such as \"Thumbnails/October\"");
  const COLOR = z.enum(["lavender", "sky", "peach", "mint", "rose", "sand"]);
  const folderId = async (ref?: string | null) => {
    if (!ref) return null;
    const fs = await import("@/lib/files");
    return fs.findFolder(await fs.getTree(), ref)?.id ?? null;
  };
  const resolveMember = async (who?: string | null) => {
    if (!who) return { assignee_id: null, assignee_name: null };
    const m = (await listMembers()).find((x) => [x.id, x.email.toLowerCase(), x.name.toLowerCase(), x.name.split(" ")[0].toLowerCase()].includes(who.toLowerCase()));
    if (!m) throw new Error(`no workspace member matches "${who}"; see workspace_members`);
    return { assignee_id: m.id, assignee_name: m.name };
  };
  const postFields = {
    title: z.string().min(1).max(200).optional(),
    status: z.enum(POST_STATUS).optional().describe("idea, draft (in production), review, scheduled, posted"),
    platforms: z.array(z.enum(POST_PLAT)).optional().describe("where it goes: youtube, shorts, reels, instagram, tiktok, x, linkedin, podcast"),
    script: z.string().max(100_000).optional().describe("what will be said; one line per beat; [pause]/[beat] markers work"),
    caption: z.string().max(10_000).optional().describe("post caption + hashtags"),
    notes: z.string().max(10_000).optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional().describe("publish time, ISO 8601 with offset; null clears it"),
    link: z.string().url().nullable().optional().describe("the live post URL once it's out"),
    assignee: z.string().nullable().optional().describe("who owns it: a member's name, first name or email (see workspace_members); null = nobody"),
    targets: z.array(z.object({
      space: z.enum(SPACE_IDS).describe("yt_video, yt_short, yt_post (YouTube Videos/Shorts/Posts), ig_reel, ig_post, ig_story (Instagram), x_post, x_thread (X), tt_video (TikTok), li_post (LinkedIn), pod_episode (Podcast)"),
      status: z.enum(POST_STATUS).optional(), due_at: z.string().datetime({ offset: true }).nullable().optional(), link: z.string().url().nullable().optional(),
    })).max(20).optional().describe("where the post goes (cross-posting: several spaces), each with its own stage, publish time and live link; platforms/status/due_at of the post follow"),
  };
  const applyTargets = async (postId: string, given: { space: string; status?: string; due_at?: string | null; link?: string | null }[] | undefined, mode: "replace" | "merge", fallback: Post) => {
    if (!given) return;
    const cur = targetsOf(fallback, await getTargets());
    const fill = (t: (typeof given)[number]) => ({ status: fallback.status === "posted" ? "draft" : fallback.status, due_at: fallback.due_at, link: null, ...t });
    const next = mode === "replace" ? given.map(fill) : [...cur.map((c) => { const g = given.find((x) => x.space === c.space); return g ? { ...c, ...g } : c; }), ...given.filter((g) => !cur.some((c) => c.space === g.space)).map(fill)];
    await setTargets(postId, next, CLAUDE);
  };

  server.registerTool(
    "workspace_board",
    {
      title: "The shared board",
      description: "Posts the two creators are working on, newest first, with status (idea -> draft -> review -> scheduled -> posted), where each goes (goes_to: content spaces like Instagram Reels or YouTube Shorts, each with its own stage), due date, owner and how many voiceovers each has. Filter by status, platform, space or text. Use get_post for the full script, caption, comments and media.",
      inputSchema: z.object({
        status: z.enum(POST_STATUS).optional(), platform: z.enum(POST_PLAT).optional(),
        space: z.enum(SPACE_IDS).optional().describe("only posts going to this content space (e.g. ig_reel, yt_short, x_post)"),
        search: z.string().max(200).optional().describe("matches title, script and caption"), limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ status, platform, space, search, limit }) => ws(async () => {
      const [all, tmap] = await Promise.all([listPosts({ status, limit: search || platform || space ? 200 : limit ?? 50 }), getTargets()]);
      let posts = all;
      if (platform) posts = posts.filter((p) => p.platforms.includes(platform));
      if (space) posts = posts.filter((p) => targetsOf(p, tmap).some((t) => t.space === space));
      if (search) posts = posts.filter((p) => `${p.title} ${p.script ?? ""} ${p.caption ?? ""}`.toLowerCase().includes(search.toLowerCase()));
      return posts.slice(0, limit ?? 50).map((p) => brief(p, tmap));
    }),
  );

  server.registerTool(
    "get_post",
    {
      title: "Open a post",
      description: "Everything about one workspace post: script, caption, notes, schedule, comments thread, attached media (with view links) and voiceover library ids (open them with list_library / get_job).",
      inputSchema: z.object({ post_id: POST_ID }),
    },
    async ({ post_id }) => ws(async () => {
      const [p, comments, media, activity, tmap] = await Promise.all([getPost(post_id), listComments(post_id), listMedia(post_id), listActivity(15, post_id), getTargets()]);
      return {
        ...brief(p, tmap), script: p.script, caption: p.caption, notes: p.notes, posted_at: p.posted_at, live_link: p.link, voiceover_jobs: p.jobs,
        comments: comments.map((c) => ({ by: c.author_name, at: c.$createdAt, text: c.body })),
        media: media.map((m) => ({ id: m.$id, name: m.name, kind: m.kind, mb: m.size ? +(m.size / 1e6).toFixed(1) : null, url: m.token ? fileUrl(m) : null, backed_up: !!m.r2_key })),
        activity: activity.map((a) => `${a.$createdAt.slice(0, 16)} ${a.actor_name ?? "someone"} ${a.verb} ${a.text ?? ""}`.trim()),
      };
    }),
  );

  server.registerTool(
    "create_post",
    {
      title: "Create a post",
      description: "Add a post to the shared board (it appears live on both creators' screens). Good for turning an idea into a planned piece: give it a title, where it goes (targets: content spaces such as ig_reel + yt_short + tt_video to cross-post), a draft script and caption, and a due_at to put it on the calendar. Write scripts as the creator would say them, one line per beat.",
      inputSchema: z.object({ ...postFields, title: z.string().min(1).max(200) }),
    },
    async ({ assignee, targets, ...data }) => ws(async () => {
      const p = await createPost({ ...data, ...(assignee !== undefined ? await resolveMember(assignee) : {}) } as Partial<Post>, CLAUDE);
      await applyTargets(p.$id, targets, "replace", p);
      return brief(targets ? await getPost(p.$id) : p, await getTargets());
    }),
  );

  server.registerTool(
    "update_post",
    {
      title: "Edit a post",
      description: "Change any field of a post: move it along (status), rewrite or append to the script, set the caption, schedule it (due_at), assign it, add the live link. Only the fields you send change. script_mode append adds to the end of the existing script.",
      inputSchema: z.object({ post_id: POST_ID, ...postFields, script_mode: z.enum(["replace", "append"]).optional().describe("default replace"),
        targets_mode: z.enum(["merge", "replace"]).optional().describe("merge (default): update the spaces you name and add new ones (cross-post), keep the rest; replace: exactly these spaces") }),
    },
    async ({ post_id, assignee, script_mode, targets, targets_mode, ...data }) => ws(async () => {
      if (script_mode === "append" && data.script) data.script = `${((await getPost(post_id)).script ?? "").trimEnd()}\n${data.script}`.trim();
      if (data.status === "posted") (data as Partial<Post>).posted_at ??= new Date().toISOString();
      const fields = { ...data, ...(assignee !== undefined ? await resolveMember(assignee) : {}) } as Partial<Post>;
      let p = Object.keys(fields).length ? await updatePost(post_id, fields, CLAUDE) : await getPost(post_id);
      if (targets) { await applyTargets(post_id, targets, targets_mode ?? "merge", p); p = await getPost(post_id); }
      return brief(p, await getTargets());
    }),
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete a post",
      description: "Permanently delete a post from the board (its media files stay in the Media library). Only when the user explicitly asks.",
      inputSchema: z.object({ post_id: POST_ID }),
    },
    async ({ post_id }) => ws(async () => { await deletePost(post_id, CLAUDE); await dropTargets(post_id); return { deleted: post_id }; }),
  );

  server.registerTool(
    "comment_on_post",
    {
      title: "Comment on a post",
      description: "Leave a note in a post's discussion thread (both creators see it live, signed as Claude). Use it for review feedback, script suggestions, or to explain what you changed.",
      inputSchema: z.object({ post_id: POST_ID, text: z.string().min(1).max(5000) }),
    },
    async ({ post_id, text: body }) => ws(async () => { const c = await addComment(post_id, body, CLAUDE); return { id: c.$id, post_id }; }),
  );

  server.registerTool(
    "content_calendar",
    {
      title: "Content calendar",
      description: "Scheduled posts between two dates (default: today through the next 14 days), in publish order, plus the unscheduled posts still in progress. Use it to plan a week, find gaps, or spread posts across platforms.",
      inputSchema: z.object({
        from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
      }),
    },
    async ({ from, to }) => ws(async () => {
      const start = from ?? new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
      const end = to ?? new Date(Date.parse(start) + 14 * 864e5).toISOString();
      const [scheduled, all, tmap] = await Promise.all([postsBetween(start, end), listPosts({ limit: 200 }), getTargets()]);
      return { from: start, to: end, scheduled: scheduled.map((p) => brief(p, tmap)), unscheduled: all.filter((p) => !p.due_at && p.status !== "posted").map((p) => brief(p, tmap)) };
    }),
  );

  // ── publishing (lib/publish/*): YouTube and Instagram straight from a post; the rest get a hand-off
  const PUB_SPACE = z.enum(["yt_video", "yt_short", "ig_reel", "ig_post", "ig_story"]);
  const toRef = (f: string) => (f.startsWith("g:") ? `j:${f.slice(2)}` : f);

  server.registerTool(
    "publish_accounts",
    {
      title: "Publishing accounts and queue",
      description: "The YouTube channels and Instagram accounts connected for publishing (connect them on the dashboard: Posts → Autopilot), every publish plan with its state (draft, armed = goes out automatically at the target's publish time, queued/uploading/processing, published with its link, failed with the error and next retry), and the automation rules. Also whether each network is set up on the server.",
      inputSchema: z.object({}),
    },
    async () => ws(async () => {
      const r = await (await import("@/lib/publish/api")).publishGet([]);
      const j = await r.json();
      return { ...j, plans: j.plans.map((p: Record<string, unknown>) => ({ ...p, log: (p.log as unknown[]).slice(-5) })) };
    }),
  );

  server.registerTool(
    "publish_post",
    {
      title: "Publish a post",
      description: "Set up and send a post's target to YouTube (yt_video, yt_short) or Instagram (ig_reel, ig_post: a photo, video or carousel of up to 20, ig_story). The post must already have that target (update_post targets). Pass files from list_files / workspace_media (m:<upload id>, or g:<generated video id>); cover is an image (m:) used as the YouTube thumbnail or the Reel cover. account: an id from publish_accounts (left out: the only one connected). YouTube options: title, description, tags, category (id, 28 = Science & Technology, 27 Education, 22 People & Blogs, 24 Entertainment), privacy, made_for_kids, synthetic (realistic AI voice/visuals: disclose it), playlist (id), language, notify, youtube_schedules (upload early, YouTube flips it public on the minute). Instagram options: caption, share_to_feed, collaborators (up to 3 usernames), user_tags, trial (MANUAL / SS_PERFORMANCE trial reel), audio_name, alt_text, ai_generated, first_comment, location_id. go: save (default, just saves), arm (goes out by itself at the target's publish time), now (publish right away). Only publish when the user asked; it's public and can't be undone from here.",
      inputSchema: z.object({
        post_id: POST_ID, space: PUB_SPACE,
        account: z.string().max(64).optional(), files: z.array(FILE_ID).max(20).optional(), cover: FILE_ID.nullable().optional(),
        go: z.enum(["save", "arm", "now", "disarm"]).optional(),
        youtube: z.object({
          title: z.string().max(100), description: z.string().max(5000), tags: z.array(z.string().max(100)).max(60), category: z.string().max(3),
          privacy: z.enum(["public", "unlisted", "private"]), made_for_kids: z.boolean(), synthetic: z.boolean(), playlist: z.string().max(64).nullable(),
          language: z.string().max(8).nullable(), notify: z.boolean(), youtube_schedules: z.boolean(), license: z.enum(["youtube", "creativeCommon"]),
          embeddable: z.boolean(), public_stats: z.boolean(), recording_date: z.string().nullable(),
        }).partial().optional(),
        instagram: z.object({
          caption: z.string().max(2200), share_to_feed: z.boolean(), collaborators: z.array(z.string().max(30)).max(3), user_tags: z.array(z.string().max(30)).max(20),
          trial: z.enum(["MANUAL", "SS_PERFORMANCE"]).nullable(), audio_name: z.string().max(100).nullable(), alt_text: z.string().max(1000).nullable(),
          ai_generated: z.boolean(), first_comment: z.string().max(2200).nullable(), location_id: z.string().max(30).nullable(), thumb_offset_ms: z.number().int().min(0).nullable(),
        }).partial().optional(),
      }),
    },
    async ({ post_id, space, account, files, cover, go, youtube, instagram }) => ws(async () => {
      const api = await import("@/lib/publish/api");
      let acc = account;
      if (!acc) {
        const { listAccounts } = await import("@/lib/publish/accounts");
        const mine = (await listAccounts()).filter((a) => a.network === (space.startsWith("yt") ? "youtube" : "instagram"));
        if (mine.length === 1) acc = mine[0].id;
      }
      const body: Record<string, unknown> = {
        ...(acc ? { account: acc } : {}), ...(files ? { media: files.map(toRef) } : {}), ...(cover !== undefined ? { cover: cover ? toRef(cover) : null } : {}),
        ...(youtube ? { yt: youtube } : {}), ...(instagram ? { ig: instagram } : {}), ...(go === "now" ? { when: "now" } : go === "arm" ? { when: "scheduled" } : {}),
      };
      const saved = await (await api.publishPost([post_id, space], body)).json();
      if (saved.error) throw new Error(saved.error);
      if (!go || go === "save") return saved;
      const r = await api.publishPost([post_id, space, "go"], { mode: go });
      const j = await r.json();
      if (!r.ok) throw new Error(`${j.error}${j.problems?.length > 1 ? ` (also: ${j.problems.slice(1).join("; ")})` : ""}`);
      return { ...j, next: go === "now" ? "Going out now: check publish_status in a minute (a big YouTube upload takes a few)." : "Armed: the autopilot sends it at the target's publish time (checks every 10 min)." };
    }),
  );

  server.registerTool(
    "publish_status",
    {
      title: "Publish status",
      description: "Where one post's target stands: state, progress, the live link once it's out, what's stopping it (problems), and its history. stop cancels a run in progress; retry tries a failed one again.",
      inputSchema: z.object({ post_id: POST_ID, space: PUB_SPACE, action: z.enum(["status", "stop", "retry"]).optional() }),
    },
    async ({ post_id, space, action }) => ws(async () => {
      const api = await import("@/lib/publish/api");
      if (action === "stop" || action === "retry") { const r = await api.publishPost([post_id, space, action === "stop" ? "cancel" : "retry"], {}); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; }
      return (await api.publishGet([post_id, space])).json();
    }),
  );

  server.registerTool(
    "automation_rules",
    {
      title: "Publishing automation rules",
      description: "Read or change the autopilot: autopilot (master switch), retries, mark_posted, notify (phone push), crosspost rules [{from, to, hours, on}] (live on one space → queued on another N hours later), slots [{space, day 0=Sun..6, time \"HH:MM\"}] (a post moved to Scheduled without a time gets the next free slot), footer {space: text} added to new captions, first_comment (Instagram default), yt_defaults, tz (IANA time zone the slots are in). Only change what the user asked; lists replace the whole list.",
      inputSchema: z.object({ set: z.record(z.string(), z.unknown()).optional(), run_now: z.boolean().optional() }),
    },
    async ({ set, run_now }) => ws(async () => {
      const api = await import("@/lib/publish/api");
      if (run_now) return (await api.publishPost(["sweep"], {})).json();
      if (set) return (await api.publishPost(["rules"], { rules: set })).json();
      return { rules: await (await import("@/lib/publish/plans")).getRules() };
    }),
  );

  server.registerTool(
    "workspace_media",
    {
      title: "Workspace media",
      description: "Files in the shared Media library (images, videos, audio, docs), newest first, optionally only one post's. Each has a view url that works in a browser.",
      inputSchema: z.object({ post_id: POST_ID.optional() }),
    },
    async ({ post_id }) => ws(async () => (await listMedia(post_id)).map((m) => ({
      id: m.$id, name: m.name, kind: m.kind, mb: m.size ? +(m.size / 1e6).toFixed(1) : null, post_id: m.post_id, by: m.uploaded_name, at: m.$createdAt,
      url: m.token ? fileUrl(m) : null, backed_up_to_r2: !!m.r2_key,
    }))),
  );

  server.registerTool(
    "add_media",
    {
      title: "Add a file to the workspace",
      description: "Copy a file from a URL (a generated image or voiceover link from this server, or any public link) into the shared uploads on the Files page, optionally attached to a post and filed in a folder. Up to 150 MB; it is also backed up to R2 when the backup setting is on.",
      inputSchema: z.object({ url: z.string().url(), name: z.string().max(200).optional(), post_id: POST_ID.optional(), folder: FOLDER_REF.optional() }),
    },
    async ({ url, name, post_id, folder }) => ws(async () => {
      const { media, backup, folder: placed } = await (await import("@/lib/filemanager")).importUrl(url, { name, postId: post_id, folder, backup: (await getSettings()).backup_media }, CLAUDE);
      return { id: media.$id, file_id: `m:${media.$id}`, name: media.name, kind: media.kind, url: fileUrl(media), folder: placed, r2_backup: media.r2_key ? "saved" : backup ?? "off" };
    }),
  );

  server.registerTool(
    "upload_media",
    {
      title: "Upload a file to the workspace",
      description: "Upload a file's bytes (base64) into the shared uploads on the Files page, optionally attached to a post and filed in a folder: a thumbnail, a script PDF, a short clip, subtitles. Up to ~3 MB this way (the server takes 4.5 MB requests); for bigger files use add_media with a link (up to 150 MB), or the Files page (2 GB).",
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe("file name with extension, e.g. thumb.png"),
        content_base64: z.string().min(4).max(4_400_000), mime: z.string().max(100).optional().describe("default: from the file extension"),
        post_id: POST_ID.optional(), folder: FOLDER_REF.optional(),
      }),
    },
    async ({ name, content_base64, mime, post_id, folder }) => ws(async () => {
      const into = await folderId(folder);
      const bytes = new Uint8Array(Buffer.from(content_base64.replace(/^data:[^,]*,/, ""), "base64"));
      const { media, backup } = await addMediaBytes(bytes, mime || mimeFor(name), name, { postId: post_id ?? null, backup: (await getSettings()).backup_media }, CLAUDE);
      if (into) await (await import("@/lib/files")).moveItems([`m:${media.$id}`], into);
      return { id: media.$id, file_id: `m:${media.$id}`, name: media.name, kind: media.kind, mb: +(bytes.length / 1e6).toFixed(2), url: fileUrl(media), folder: into, r2_backup: media.r2_key ? "saved" : backup ?? "off" };
    }),
  );

  server.registerTool(
    "delete_media",
    {
      title: "Delete a workspace file",
      description: "Permanently delete a file from the shared Media library (workspace_media lists ids). Only when the user explicitly asks.",
      inputSchema: z.object({ media_id: POST_ID }),
    },
    async ({ media_id }) => ws(async () => { const m = await deleteMediaRow(media_id, CLAUDE); return { deleted: media_id, name: m.name }; }),
  );

  // ── Files: the file manager (folders, move, rename, star, delete) over uploads and generated items alike
  server.registerTool(
    "list_files",
    {
      title: "List files and folders",
      description:
        "The dashboard's Files page, a Drive-like file manager over uploads (shared workspace) and generated items (voiceovers, subtitles, images, videos). The top level holds five category folders that file everything by kind on their own (Videos, Images, Audio, Docs & scripts, Other) beside your own folders. Without `folder` it shows the top level; `everywhere` searches every folder; `trash` lists the trash. Each file has an id (m:… upload, g:… generated) for move_files, rename_file, star_files, get_file and delete_files.",
      inputSchema: z.object({
        folder: FOLDER_REF.optional(), everywhere: z.boolean().optional().describe("list files from every folder (default: only this folder; on when search is set)"),
        search: z.string().max(200).optional(), kind: z.enum(["image", "video", "audio", "doc", "other"]).optional(),
        source: z.enum(["upload", "generated"]).optional(), starred: z.boolean().optional(), trash: z.boolean().optional().describe("list what's in the trash instead"),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    },
    async ({ folder, everywhere, search, kind, source, starred, trash, limit }) => files(async () => {
      const { catalog } = await import("@/lib/filemanager");
      const fs = await import("@/lib/files");
      const { tree, items, note } = await catalog({ trash });
      if (trash) {
        const folders = tree.folders.filter((f) => tree.trash[`f:${f.id}`]).map((f) => ({ id: `f:${f.id}`, name: f.name, deleted: new Date(tree.trash[`f:${f.id}`].at).toISOString() }));
        return { trash: { folders, files: items.slice(0, limit ?? 100), total: items.length }, note: "Things stay 30 days; restore_files brings them back." };
      }
      const live = tree.folders.filter((f) => !tree.trash[`f:${f.id}`]);
      const here = fs.findFolder(tree, folder);
      const id = here?.id ?? null;
      const all = everywhere || !!search;
      const inside = (fid: string | null): number => items.filter((i) => i.folder === fid).length + live.filter((f) => f.parent === fid).reduce((n, f) => n + inside(f.id), 0);
      const q = search?.toLowerCase();
      const shown = items.filter((i) => (all || i.folder === id) && (!kind || i.kind === kind) && (!source || i.source === source) && (starred === undefined || i.starred === starred) &&
        (!q || `${i.name} ${i.type} ${i.folder_path}`.toLowerCase().includes(q)));
      return {
        folder: here ? { id: here.id, name: here.name, path: fs.pathOf(tree, here.id), color: here.color, parent: here.parent, category: here.system ?? null } : null,
        folders: live.filter((f) => (all && q ? f.name.toLowerCase().includes(q) : f.parent === id))
          .map((f) => ({ id: f.id, name: f.name, path: fs.pathOf(tree, f.id), color: f.color, items: inside(f.id), category: f.system ?? null, starred: tree.starred.includes(`f:${f.id}`) })),
        files: shown.slice(0, limit ?? 100), total: shown.length, note,
      };
    }),
  );

  server.registerTool(
    "get_file",
    {
      title: "One file, with download links",
      description: "A file's details and links that work for 6 hours: an upload's view/download link, or every file of a generated item (each line's WAV, the MP4, images) plus its zip path (GET with Bearer MCP_TOKEN).",
      inputSchema: z.object({ file_id: FILE_ID }),
    },
    async ({ file_id }) => files(async () => (await import("@/lib/filemanager")).fileDetail(file_id)),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create a folder",
      description: "Make a folder on the Files page, at the top level or inside `parent`. A taken name gets a number (\"Thumbnails 2\"). Colours: lavender, sky, peach, mint, rose, sand.",
      inputSchema: z.object({ name: z.string().min(1).max(80), parent: FOLDER_REF.optional(), color: COLOR.optional() }),
    },
    async ({ name, parent, color }) => files(async () => (await import("@/lib/files")).createFolder({ name, color, parent: await folderId(parent) }, CLAUDE.name)),
  );

  server.registerTool(
    "update_folder",
    {
      title: "Rename, recolour or move a folder",
      description: "Change a folder's name or colour, or move it inside another folder (parent) or to the top level (parent \"/\").",
      inputSchema: z.object({ folder: FOLDER_REF, name: z.string().min(1).max(80).optional(), color: COLOR.optional(), parent: FOLDER_REF.optional() }),
    },
    async ({ folder, name, color, parent }) => files(async () => {
      const id = await folderId(folder);
      if (!id) throw new Error("pick a folder (the top level can't be renamed)");
      return (await import("@/lib/files")).updateFolder(id, { name, color, parent: parent === undefined ? undefined : await folderId(parent) });
    }),
  );

  server.registerTool(
    "delete_folder",
    {
      title: "Delete a folder",
      description: "Move a folder, with everything in it, to the trash (kept 30 days; restore_files with f:<folder id> brings it back). Category folders can't be deleted. Only when the user asks.",
      inputSchema: z.object({ folder: FOLDER_REF }),
    },
    async ({ folder }) => files(async () => {
      const id = await folderId(folder);
      if (!id) throw new Error("pick a folder");
      return (await import("@/lib/files")).trashItems([`f:${id}`], CLAUDE.name);
    }),
  );

  server.registerTool(
    "move_files",
    {
      title: "Move files and folders",
      description: "File things into a folder (to), or back to the top level (to \"/\"). items: file ids from list_files and/or folders as f:<folder id>.",
      inputSchema: z.object({ items: z.array(ITEM_ID).min(1).max(500), to: FOLDER_REF }),
    },
    async ({ items, to }) => files(async () => (await import("@/lib/files")).moveItems(items, await folderId(to))),
  );

  server.registerTool(
    "rename_file",
    {
      title: "Rename a file",
      description: "Rename an upload or a generated item (its title on the Files page; links and ids stay the same). Keep an upload's extension.",
      inputSchema: z.object({ file_id: FILE_ID, name: z.string().min(1).max(200) }),
    },
    async ({ file_id, name }) => files(async () => (await import("@/lib/filemanager")).renameItem(file_id, name, CLAUDE)),
  );

  server.registerTool(
    "star_files",
    {
      title: "Star or unstar",
      description: "Star files or folders (f:<id>) so they show under Starred on the Files page, or unstar them with starred false.",
      inputSchema: z.object({ items: z.array(ITEM_ID).min(1).max(500), starred: z.boolean().default(true) }),
    },
    async ({ items, starred }) => files(async () => ({ starred: await (await import("@/lib/files")).starItems(items, starred) })),
  );

  server.registerTool(
    "delete_files",
    {
      title: "Delete files",
      description: "Move files (or folders as f:<id>) to the trash, kept 30 days. With forever: true they're deleted for good instead (an upload's R2 backup copy stays). Only when the user explicitly asks; forever only when they ask for that too.",
      inputSchema: z.object({ items: z.array(ITEM_ID).min(1).max(500), forever: z.boolean().optional() }),
    },
    async ({ items, forever }) => files(async () => (await import("@/lib/filemanager")).deleteItems(items, CLAUDE, !!forever)),
  );

  server.registerTool(
    "restore_files",
    {
      title: "Restore from the trash",
      description: "Bring files or folders (f:<id>) back from the trash to where they were (list_files trash: true shows what's there).",
      inputSchema: z.object({ items: z.array(ITEM_ID).min(1).max(500) }),
    },
    async ({ items }) => files(async () => (await import("@/lib/filemanager")).restore(items)),
  );

  server.registerTool(
    "empty_trash",
    {
      title: "Empty the trash",
      description: "Delete everything in the trash for good. Can't be undone. Only when the user explicitly asks.",
      inputSchema: z.object({}),
    },
    async () => files(async () => (await import("@/lib/filemanager")).emptyTrash(CLAUDE)),
  );

  server.registerTool(
    "attach_voiceover",
    {
      title: "Attach a voiceover to a post",
      description: "Link a finished library voiceover (job id from list_library or voice_lines) to a post, so it shows under the post's Voiceovers. voice_lines with post_id does this automatically.",
      inputSchema: z.object({ post_id: POST_ID, job_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
    },
    async ({ post_id, job_id }) => ws(async () => brief(await linkJob(post_id, job_id, CLAUDE))),
  );

  server.registerTool(
    "workspace_activity",
    {
      title: "What changed",
      description: "The shared activity feed: who created, moved, edited, voiced, commented on or uploaded what, newest first. Use it to catch up on what the other creator did.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), post_id: POST_ID.optional() }),
    },
    async ({ limit, post_id }) => ws(async () => (await listActivity(limit ?? 30, post_id)).map((a) => ({ at: a.$createdAt, who: a.actor_name, did: a.verb, what: a.text, post_id: a.post_id }))),
  );

  server.registerTool(
    "workspace_members",
    {
      title: "Who's in the workspace",
      description: "The people on the shared workspace (name, email, id). Use a name or email as `assignee` on create_post / update_post.",
      inputSchema: z.object({}),
    },
    async () => ws(async () => listMembers()),
  );
}

export const INSTRUCTIONS = [
    "Voicebox: two creators' shared studio. Their own GPU voice studio (Colab worker) plus a shared workspace (board, calendar, comments, media) they both see live. Typical flows:",
    "1) Plan and write: workspace_board / content_calendar to see what's in flight; create_post or update_post to add ideas, write scripts (as the creator would say them, one line per beat) and captions, schedule with due_at; comment_on_post to leave review notes. workspace_activity shows what the other person did.",
    "2) Voice it: check worker_status (if offline, ask the user to run the Colab notebook), then voice_lines with post_id to voice a post's script and attach the result, or with lines for a one-off. The user's recorded voices (my_voices) work on qwen. Defaults come from get_settings.",
    "3) Before a long or term-heavy script, preview_pronunciation and add fixes via pronounce.",
    "4) A recording from a bad mic: clean_audio. A rough take the user performed: revoice into their clean voice. Subtitles for any file: transcribe. Stills and thumbnails: imagine, then add_media to put one on the post.",
    "5) Long jobs return a job id: poll get_job (each call waits up to 45 s). Results are archived to the dashboard's Files page; links expire after 6 h.",
    "6) The user's own voice model: voice_dataset to see or grow the training data, then the training notebook; once trained it is engine myvoice with voice = that person's name (my_voices lists both people's). benchmark_voices compares it with their clones on held-out sentences. voice_coach shows how a trained voice is doing and writes the next recording script around its weak spots; recording it makes the voice more natural (retrains only go live when they beat the current model).",
    "Content spaces: each post goes to one or more spaces (YouTube Videos / Shorts / Posts, Instagram Reels / Posts / Stories, X Posts / Threads, TikTok, LinkedIn, Podcast), each with its own stage and publish time; cross-post by adding targets (update_post targets, merge). Files: upload_media (bytes) or add_media (a link); delete_media / delete_post only when asked.",
    "Files page (a Drive-like file manager over uploads and generated items; category folders Videos, Images, Audio, Docs & scripts and Other file things by kind on their own): list_files browses folders and searches; get_file gives download links; create_folder / update_folder / move_files / rename_file / star_files keep it tidy (upload_media and add_media take a folder). delete_files and delete_folder move things to the trash (30 days, restore_files brings them back) and only when asked; forever / empty_trash only when asked for that.",
    "Publishing: publish_accounts shows the connected YouTube / Instagram accounts and the queue; publish_post sets up a target (files, cover, every YouTube or Instagram option) and saves, arms it for its publish time, or sends it now (only when asked); publish_status follows it; automation_rules reads or changes cross-posting, posting slots, retries and footers. X, TikTok, LinkedIn and podcasts stay hand-offs: the user posts those and marks them posted.",
    "7) Move the post along (status draft -> review -> scheduled -> posted) as work lands; add the live link when it's out. Never delete posts or change settings unless asked.",
    "Scores: match = how closely Whisper heard the script (>=0.95 good); similarity = voice match vs the recording (>=0.86 same speaker).",
].join("\n");
