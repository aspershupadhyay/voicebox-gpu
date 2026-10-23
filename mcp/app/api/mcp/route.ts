// Voicebox MCP: exposes the Colab GPU worker (Kokoro, Chatterbox, Orpheus, Qwen TTS + Whisper subtitles + Wan / LTX video) as MCP tools.
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { loadWorker, STALE_MS } from "@/lib/registry";
import { call, safeEqual, WorkerOffline } from "@/lib/worker";
import { archiveWorkerJob, listLibrary, presignPath } from "@/lib/library";
import { getSettings, updateSettings, VISUAL_STYLES, withDefaults } from "@/lib/settings";
import { isCustomVoice, listMyVoices, refSync } from "@/lib/voices";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENGINES = ["kokoro", "chatterbox", "orpheus", "qwen"] as const;
const ALL_ENGINES = ["kokoro", "chatterbox", "orpheus", "qwen", "whisper", "enhance", "wan", "wan14", "ltx", "animate", "zimage", "qwenimage"] as const;
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
          "Engines: kokoro (fast drafts, many languages), chatterbox (emotion dial + cloning, 23 languages incl. Hindi), orpheus (most human, English; tags like <laugh> <sigh>), qwen (best cloning of the user's recorded voice; 10 languages, no Hindi; params.language takes names like English).",
          "No length limit: long text is split at sentences, voiced in one batch and re-joined.",
          "subtitles: true adds Whisper large-v3 word-timed SRT/VTT per line and for the whole timeline (uses each line's start when given), plus a match score vs the script.",
          "voice: 'female' / 'male' presets, an engine voice (e.g. tara, dan, af_heart), or the name of a recorded voice from my_voices (qwen or chatterbox).",
          "style sets the delivery (default 'tech'): tech = bright YouTube-tech pace (~185 wpm), hype = max energy for promos, narrator = calm documentary (~165 wpm), neutral = engine defaults. Explicit params override the style. For energy the voice matters most (Orpheus temperature does not add energy): orpheus mia/leo, kokoro am_fenrir/af_bella; chatterbox via exaggeration.",
          "First use of an engine installs + loads it (several minutes); the job keeps running, so poll with get_job.",
        ].join(" "),
        inputSchema: z.object({
          engine: z.enum(ENGINES).optional().describe("default from settings (qwen unless changed)"),
          voice: z.string().optional().describe("default from settings"),
          lines: z.array(line).min(1).max(1000),
          subtitles: z.boolean().optional().describe("also make word-timed subtitles with Whisper large-v3"),
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
      async ({ wait_seconds, ...body }) => {
        try {
          const full = withDefaults(body, await getSettings());
          const ref = typeof full.voice === "string" && isCustomVoice(full.voice) ? await refSync(full.voice) : null;
          const job = await call<Job>("/jobs", { body: ref ? { ...full, ref } : full });
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
      "make_video",
      {
        title: "Script -> finished video",
        description: [
          "Turn a script into a finished, captioned, mastered video in one job: every scene is one voiced line plus one shot.",
          "You (the assistant) should write a concrete `visual` for each scene: subject, setting, light, camera, e.g. 'a glowing smartphone on a dark desk, blue location pin hovering above'. Never put words/text in visuals. Without one, a visual metaphor is imagined from the line.",
          "Voice: every voice_lines option (engine, voice incl. the user's recorded voice, style, takes, pronounce, [pause] markers); defaults come from settings.",
          "platform sets the frame and the sound: shorts/reels/tiktok = 1080x1920 with bold pop-up word captions, youtube/podcast = 1920x1080 with clean subtitles; audio mastered to -14 LUFS.",
          "visuals: images (default; Z-Image stills with smooth Ken Burns camera moves, seconds per scene) or clips (each still animated by Wan 2.2, a few minutes per scene). visual_style: tech, neon, minimal, photo, paper, blueprint.",
          "music_url: optional music bed, levelled (music_lufs, default -28) and ducked under the voice. A scene may give image_url to use its own picture.",
          "Keep scenes to 1-2 sentences (3-8 s each); 6-12 scenes makes a 30-60 s short. Rendering takes minutes: poll get_job; the MP4 (+ voiceover.wav and .srt) lands in the library.",
        ].join(" "),
        inputSchema: z.object({
          scenes: z.array(z.object({
            text: z.string().min(1).max(2000).describe("what is said in this scene"),
            visual: z.string().max(1500).optional().describe("what we see: concrete, visual, no on-screen text"),
            image_url: z.string().url().optional().describe("use this picture instead of generating one"),
          })).min(1).max(80),
          platform: z.enum(PLATFORMS).optional().describe("default from settings"),
          aspect: z.enum(["16:9", "9:16", "1:1"]).optional().describe("override the platform's frame"),
          engine: z.enum(ENGINES).optional(), voice: z.string().optional(),
          style: z.enum(["tech", "hype", "narrator", "neutral"]).optional(),
          takes: z.number().int().min(1).max(4).optional(),
          pronounce: z.record(z.string(), z.string()).optional(),
          visuals: z.enum(["images", "clips"]).optional(),
          visual_style: z.enum(VISUAL_STYLES).optional(),
          captions_look: z.enum(["bold", "clean", "none"]).optional().describe("default: bold for vertical, clean for wide"),
          transition: z.enum(["fade", "cut"]).optional(),
          music_url: z.string().url().optional(), music_lufs: z.number().min(-40).max(-18).optional(),
          seed: z.number().int().optional(),
          label: z.string().max(80).optional(),
          wait_seconds: z.number().min(0).max(MAX_WAIT).optional().describe("default 10; renders take minutes"),
        }),
      },
      async ({ wait_seconds, ...body }) => {
        try {
          const full = withDefaults({ ...body, kind: "story" }, await getSettings());
          const ref = typeof full.voice === "string" && isCustomVoice(full.voice) ? await refSync(full.voice) : null;
          const job = await call<Job>("/jobs", { body: ref ? { ...full, ref } : full });
          return text(withHint(await waitFor(job.id, wait_seconds ?? 10)));
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
          "url: any audio or video link. params.mode: enhance (default; denoise + restore) or denoise (noise only, exact original tone); params.strength 0-1 (default 0.6; higher for noisy, echoey rooms).",
        ].join(" "),
        inputSchema: z.object({
          url: z.string().url(),
          params: z.object({ mode: z.enum(["enhance", "denoise"]).optional(), strength: z.number().min(0).max(1).optional(), steps: z.number().int().min(16).max(128).optional() }).optional(),
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
        description: "The user's saved defaults (engine, voice, style, platform, takes, pronunciation dictionary, studio enhance switches, script-video look). Every tool fills unset arguments from these.",
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
          visuals: z.enum(["images", "clips"]).optional(), visual_style: z.enum(VISUAL_STYLES).optional(),
          captions_look: z.enum(["auto", "bold", "clean", "none"]).optional(), transition: z.enum(["fade", "cut"]).optional(),
          music_lufs: z.number().min(-40).max(-18).optional(),
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
        description: "Voices the user recorded in the dashboard (Voices page). Use a name as `voice` with engine qwen (best match) or chatterbox (Hindi, emotion dial).",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          return text((await listMyVoices(false)).map((v) => ({ name: v.name, label: v.label, seconds: v.duration, transcript: v.transcript })));
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "animate",
      {
        title: "Generate a video clip",
        description: [
          "Render a short video on the GPU worker and save it to the library (MP4 + poster).",
          "model wan: Wan 2.2 TI2V 5B, sharp 720p, best prompt following, silent, up to 5 s; quality fast = 4-step Turbo (a few minutes), full = 30 steps (~10x slower).",
          "model wan14: Wan 2.2 I2V A14B + Lightning, best Wan quality, image-to-video ONLY (needs image_url or from_library), 480p 16 fps, up to 5 s, A100 only; adult: true adds an opt-in community NSFW LoRA (adults only, never real people).",
          "model ltx: LTX-2.5 distilled, picture + matching soundtrack from the same prompt, up to 10 s; quality full = two-stage at 2x resolution (text-to-video only). Describe sounds too (\"Audio: ...\").",
          "quality draft (all three): quickest preview (tiny decoder / half size). Use it to find the prompt and seed, then re-run fast or full.",
          "model animate: Wan 2.2 Animate 14B, the character in image_url performs the motion in video_url (an exercise, a dance), up to 10 s, 16 fps, A100 only; prompt optional; retarget (default true) fits the motion to the character's body.",
          "Prompts: subject, action, place, camera move, light, style; 40-100 words for wan. With a start frame (image_url or from_library) describe the motion, not the look.",
          "Video and voice engines never share the GPU: this unloads voice engines first. First use downloads the weights (wan ~23 GB, wan14 ~69 GB, ltx ~71 GB, animate ~85 GB).",
          "Rendering takes minutes: this returns a job id; poll get_job until done (the finished clip is archived to the library).",
        ].join(" "),
        inputSchema: z.object({
          prompt: z.string().max(4000).describe("the shot (animate: optional scene/style hint)"),
          model: z.enum(["wan", "wan14", "ltx", "animate"]).optional().describe("default wan"),
          aspect: z.enum(["9:16", "16:9", "1:1"]).optional().describe("default 9:16"),
          seconds: z.number().min(1).max(10).optional().describe("default 5 (wan max 5, ltx max 10)"),
          quality: z.enum(["draft", "fast", "full"]).optional().describe("draft = quickest preview; full = wan and ltx only; default fast"),
          seed: z.number().int().optional(),
          negative: z.string().max(2000).optional().describe("things to avoid"),
          audio: z.boolean().optional().describe("ltx only: generate the soundtrack (default true)"),
          adult: z.boolean().optional().describe("wan14 only: enable the adult LoRA (default false)"),
          image_url: z.string().url().optional().describe("start frame (animate: the character), public or signed https URL"),
          video_url: z.string().url().optional().describe("animate only: the driving video whose motion is copied"),
          retarget: z.boolean().optional().describe("animate only: fit the motion to the character's proportions (default true)"),
          from_library: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("start from a library video's poster frame"),
          label: z.string().max(80).optional(),
          wait_seconds: z.number().min(0).max(MAX_WAIT).optional().describe("block up to this long (default 10; renders take minutes)"),
        }),
      },
      async ({ wait_seconds, from_library, ...body }) => {
        try {
          const image_url = from_library ? await presignPath(`library/${from_library}/poster.jpg`, 3600) : body.image_url;
          if (body.model === "animate" && (!image_url || !body.video_url)) throw new Error("model animate needs image_url (the character) and video_url (the motion)");
          if (body.model !== "animate" && body.prompt.trim().length < 3) throw new Error("prompt is required");
          const job = await call<Job>("/jobs", { body: { ...body, image_url, kind: body.model === "animate" ? "animate" : "video" } });
          return text(withHint(await waitFor(job.id, wait_seconds ?? 10)));
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
  },
  {
    serverInfo: { name: "voicebox", version: "2.0.0" },
    instructions: [
      "Voicebox: the user's own GPU voice + video studio (Colab worker). Typical flows:",
      "1) Check worker_status first; if offline, ask the user to run the Colab notebook.",
      "2) Voiceover: voice_lines with lines of 1-3 sentences. The user's recorded voices (my_voices) work on qwen. Defaults (engine, voice, platform, pronunciations) come from get_settings, so most calls only need lines.",
      "3) Before a long or term-heavy script, preview_pronunciation and add fixes via pronounce.",
      "4) Finished video from a script: make_video with scenes [{text, visual}]; write a concrete visual for each scene.",
      "5) A recording from a bad mic: clean_audio. A rough take the user performed: revoice into their clean voice.",
      "6) Long jobs return a job id: poll get_job (each call waits up to 45 s). Results are archived to the dashboard library; links expire after 6 h.",
      "Scores: match = how closely Whisper heard the script (>=0.95 good); similarity = voice match vs the recording (>=0.86 same speaker).",
    ].join("\n"),
  },
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
