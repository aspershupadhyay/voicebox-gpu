// Voicebox MCP: exposes the Colab GPU worker (Kokoro, Chatterbox, Orpheus TTS + Whisper subtitles) as MCP tools.
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { loadWorker, STALE_MS } from "@/lib/registry";
import { call, safeEqual, WorkerOffline } from "@/lib/worker";
import { archiveWorkerJob, listLibrary } from "@/lib/library";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENGINES = ["kokoro", "chatterbox", "orpheus"] as const;
const ALL_ENGINES = ["kokoro", "chatterbox", "orpheus", "whisper"] as const;
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
  if (job.status === "done") {
    try {
      const lib = await archiveWorkerJob(job as unknown as Parameters<typeof archiveWorkerJob>[0]);
      if (lib) job = { ...job, library: { saved: true, dashboard: `/library#${lib.id}`, zip: `/api/zip/${lib.id}` } };
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

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "worker_status",
      {
        title: "Worker status",
        description: "Is the Colab GPU worker online? Shows GPU, VRAM, which engines are loaded, and queue length.",
        inputSchema: z.object({}),
      },
      async () => {
        const rec = await loadWorker();
        if (!rec) return text({ online: false, hint: "No worker has registered. Run the Colab notebook." });
        const age = Math.round((Date.now() - rec.last_seen) / 1000);
        if (age * 1000 > STALE_MS) return text({ online: false, last_seen_s_ago: age, hint: "Colab runtime stopped? Re-run the notebook." });
        try {
          return text({ online: true, last_seen_s_ago: age, ...(await call<Record<string, unknown>>("/health")) });
        } catch (e) {
          return text({ online: false, last_seen_s_ago: age, registered: rec, error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "list_voices",
      {
        title: "List voices and parameters",
        description:
          "Engines, voices, presets (female/male), every tunable parameter with default/min/max, post-processing defaults, and uploaded reference voices.",
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
          "Synthesise one or more lines on the GPU worker and return signed WAV links (48 kHz mono, trimmed, peak -3 dBFS by default).",
          "Engines: kokoro (fast drafts, many languages), chatterbox (emotion dial + cloning, 23 languages incl. Hindi), orpheus (most human, English; tags like <laugh> <sigh>).",
          "No length limit: long text is split at sentences, voiced in one batch and re-joined.",
          "subtitles: true adds Whisper large-v3 word-timed SRT/VTT per line and for the whole timeline (uses each line's start when given), plus a match score vs the script.",
          "voice: 'female' / 'male' presets, an engine voice (e.g. tara, dan, af_heart), or an uploaded reference name.",
          "style sets the delivery (default 'tech'): tech = bright YouTube-tech pace (~180 wpm), hype = max energy for promos, narrator = calm documentary (~135 wpm), neutral = engine defaults. Explicit params override the style. Liveliest voices for tech/hype: orpheus mia/leo/tara, kokoro am_fenrir/af_bella.",
          "First use of an engine installs + loads it (several minutes); the job keeps running, so poll with get_job.",
        ].join(" "),
        inputSchema: z.object({
          engine: z.enum(ENGINES),
          voice: z.string().optional().describe("default 'female'"),
          lines: z.array(line).min(1).max(1000),
          subtitles: z.boolean().optional().describe("also make word-timed subtitles with Whisper large-v3"),
          language: z.string().max(8).optional().describe("ISO code for Whisper/Chatterbox, e.g. en, hi; omit to auto-detect"),
          style: z.enum(["tech", "hype", "narrator", "neutral"]).optional().describe("delivery style; default tech"),
          params: z.record(z.string(), z.any()).optional().describe("engine params for all lines (override the style); see list_voices"),
          post: z
            .object({
              tempo: z.number().min(0.5).max(2).optional().describe("pitch-preserving pace multiplier, e.g. 1.05"),
              trim: z.boolean().optional(),
              trim_db: z.number().optional(),
              normalize_dbfs: z.number().nullable().optional(),
              sample_rate: z.number().int().nullable().optional(),
            })
            .optional(),
          label: z.string().max(80).optional(),
          wait_seconds: z.number().min(0).max(MAX_WAIT).optional().describe(`block up to this long for results (default ${MAX_WAIT})`),
        }),
      },
      async ({ wait_seconds, ...body }) => {
        try {
          const job = await call<Job>("/jobs", { body });
          return text(withHint(await waitFor(job.id, wait_seconds ?? MAX_WAIT)));
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "get_job",
      {
        title: "Get job",
        description: "Status and results of a voice job. Waits up to wait_seconds for it to finish.",
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
          "Every finished job saved permanently in the dashboard library (survives the Colab runtime). Download with Bearer MCP_TOKEN: GET /api/zip/<id> (all lines) or /api/audio/<id>/<line>.wav.",
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
        inputSchema: z.object({ name: z.enum(ALL_ENGINES), action: z.enum(["load", "unload"]) }),
      },
      async ({ name, action }) => {
        try {
          return text(await call(`/engines/${name}/${action}`, { body: {} }));
        } catch (e) {
          return fail(e);
        }
      },
    );
  },
  { serverInfo: { name: "voicebox", version: "1.0.0" } },
);

const authed = withMcpAuth(
  handler,
  (_req, token) => {
    const expected = process.env.MCP_TOKEN ?? "";
    if (expected.length < 24 || !token || !safeEqual(token, expected)) return undefined;
    return { token, clientId: "owner", scopes: ["voicebox"] };
  },
  { required: true },
);

export { authed as GET, authed as POST, authed as DELETE };
