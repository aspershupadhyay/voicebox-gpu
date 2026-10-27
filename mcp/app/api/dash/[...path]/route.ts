// JSON API behind the dashboard (cookie session or Bearer MCP_TOKEN).
import { after } from "next/server";
import { currentUser, isAuthed } from "@/lib/session";
import { call, WorkerOffline } from "@/lib/worker";
import { loadWorker, STALE_MS } from "@/lib/registry";
import { archiveWorkerJob, deleteLibJob, FILE_RE, getLibJob, listLibrary, presignPath, presignPuts, putFile, putLibJob, signer, withUrls, type LibJob } from "@/lib/library";
import { getSettings, settingsFor, updateSettings, withDefaults } from "@/lib/settings";
import { describeProfile, profileFor, withProfile } from "@/lib/profiles";
import { archiveDataset, autoTrain, datasetManifest, deleteDatasetPart, listDataset, listDatasets, trainJobBody } from "@/lib/datasets";
import { archiveModel, currentModel, listModelsWithSamples } from "@/lib/voicemodel";
import { archiveKVoice, listKVoices } from "@/lib/kvoices";
import { dropTargets, getSpaces, setGoals, setTargets } from "@/lib/spacestore";
import { deleteMyVoice, getMyVoice, getSamples, isCustomVoice, listMyVoices, putMyVoice, recordSample, refSync, samplePutUrl, VOICE_RE, voicePutUrl } from "@/lib/voices";

type RefJob = { id: string; kind: string; status: string; voice: string; label?: string; version?: string; warnings?: string[];
  results: { id: string; text: string; duration: number; level_db?: number; enhanced?: boolean }[] };

/** A finished voice recording job: copy the cleaned reference into R2 (voices/<name>/) and save its metadata. Idempotent. */
async function archiveReference(job: RefJob) {
  const have = await getMyVoice(job.voice);
  if (have && have.version === job.version) return have;
  const r = job.results[0];
  const res = await call<{ failed: Record<string, string> }>(`/jobs/${job.id}/push`, { body: { targets: { "reference.wav": await voicePutUrl(job.voice) }, headers: {} }, timeoutMs: 55_000 });
  if (Object.keys(res.failed).length) throw new Error(`could not store the recording: ${Object.values(res.failed)[0]}`);
  const v = { name: job.voice, label: job.label || job.voice, transcript: r.text, duration: r.duration, version: job.version || String(Date.now()),
    created: have?.created ?? Date.now(), warnings: job.warnings ?? [], level_db: r.level_db, enhanced: !!r.enhanced };
  await putMyVoice(v);
  return v;
}

export const dynamic = "force-dynamic";
export const maxDuration = 300; // starting a Colab GPU waits on the VM to boot (lib/colab.ts)

type Ctx = { params: Promise<{ path: string[] }> };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const err = (e: unknown, status = 502) =>
  Response.json({ error: (e as Error).message, offline: e instanceof WorkerOffline }, { status: e instanceof WorkerOffline ? 503 : status });

async function guard(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return { deny: Response.json({ error: "unauthorized" }, { status: 401 }) };
  return { path: (await ctx.params).path };
}

export async function GET(req: Request, ctx: Ctx) {
  const g = await guard(req, ctx);
  if (g.deny) return g.deny;
  const [a, b, c] = g.path;
  try {
    if (a === "status") {
      const rec = await loadWorker();
      if (!rec) return Response.json({ online: false, reason: "never registered" });
      const age = Date.now() - rec.last_seen;
      if (age > STALE_MS) return Response.json({ online: false, reason: "heartbeat stale", last_seen: rec.last_seen });
      try {
        return Response.json({ online: true, last_seen: rec.last_seen, ...(await call<object>("/health", { timeoutMs: 8000 })) });
      } catch (e) {
        return Response.json({ online: false, reason: (e as Error).message, last_seen: rec.last_seen });
      }
    }
    if (a === "voices") return Response.json(await call("/voices"));
    if (a === "samples") return Response.json(await getSamples());
    if (a === "myvoices") return Response.json({ voices: await listMyVoices() });
    if (a === "settings") return Response.json(settingsFor(await getSettings(), (await currentUser())?.id));
    if (a === "ratings" && b && c) {
      const job = new URL(req.url).searchParams.get("job") ?? undefined;
      const { ratingsOf } = await import("@/lib/ratings");
      return Response.json(await ratingsOf(b, c, job && ID.test(job) ? job : undefined));
    }
    if (a === "profile" && b && c) {
      const style = new URL(req.url).searchParams.get("style") ?? "tech";
      return Response.json(await describeProfile(b, c, style) ?? { engine: b, voice: c, style, jobs: 0 });
    }
    if (a === "colab" && !b) return Response.json(await (await import("@/lib/colab")).status());
    if (a === "security" && !b) {
      // who can get in and from where, this browser's session, and the last sign-ins
      const acc = await import("@/lib/access");
      const { sessionInfo } = await import("@/lib/session");
      const s = await getSettings();
      const env = (process.env.WORKSPACE_EMAILS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      const members = await import("@/lib/appwrite").then((m) => (m.hasKey() ? m.listMembers() : [])).catch(() => []);
      const emails = [...new Set([...env, ...s.workspace_emails, ...members.map((m) => m.email.toLowerCase())])];
      const people = emails.map((email) => ({ email, name: members.find((m) => m.email.toLowerCase() === email)?.name ?? null,
        on_vercel: env.includes(email), invited: s.workspace_emails.includes(email), member: members.some((m) => m.email.toLowerCase() === email) }));
      const { allowedLogins } = await import("@/lib/github");
      return Response.json({ session: await sessionInfo(), me: (await currentUser())?.email ?? null, people, github: await allowedLogins(),
        log: await acc.signInLog(), session_days: (await import("@/lib/session")).SESSION_DAYS });
    }
    if (a === "health" && !b) {
      // the Health page: what's working, what isn't (job notes in R2) + the worker's own state and self-check
      const { healthSummary } = await import("@/lib/telemetry");
      const { WORKER_VERSION } = await import("@/lib/bundle");
      const [worker, metrics] = await Promise.all([call<Record<string, unknown>>("/health", { timeoutMs: 8000 }).catch((e: Error) => ({ offline: e.message })),
        call<Record<string, unknown>>("/metrics", { timeoutMs: 8000 }).catch(() => null)]); // older workers have no /metrics
      return Response.json({ ...(await healthSummary()), worker, metrics, latest_version: WORKER_VERSION });
    }
    if (a === "coach" && b && VOICE_RE.test(b)) return Response.json(await (await import("@/lib/coach")).report(b));
    if (a === "datasets" && !b) return Response.json({ datasets: await listDatasets() });
    if (a === "datasets" && b && VOICE_RE.test(b)) return Response.json(c === "manifest" ? await datasetManifest(b) : await listDataset(b));
    if (a === "model" && !b) return Response.json({ model: await currentModel(new URL(req.url).searchParams.get("name") ?? undefined) });
    if (a === "models" && !b) return Response.json({ models: await listModelsWithSamples() });
    if (a === "qmodels" && !b) return Response.json({ models: await (await import("@/lib/qwenmodels")).listQwenModelsWithSamples() });
    if (a === "kvoices" && !b) return Response.json({ voices: await listKVoices() });
    if (a === "spaces" && !b) return Response.json(await getSpaces());
    if (a === "files") {
      // the Files page: the folder tree (with video posters), the generated items as files, the sidebar's favourites
      const fm = await import("@/lib/filemanager");
      if (!b) {
        const t = await fm.treeForBrowser();
        const { expired } = await import("@/lib/files");
        if (expired(t).length) after(() => fm.purgeTrash().catch(() => null));
        return Response.json(t);
      }
      if (b === "items") {
        const { listSummaries } = await import("@/lib/library");
        const [sums, sign] = await Promise.all([listSummaries(), signer()]);
        return Response.json({ jobs: await Promise.all(sums.map(async (j) => ({
          ...j,
          cover: j.image ? await sign(j.id, j.image.thumb) : j.video?.poster ? await sign(j.id, "poster.jpg") : null,
          audio: (!j.kind || j.kind === "tts") && j.first ? await sign(j.id, `${j.first}.wav`) : null,
        }))) });
      }
      if (b === "favourites") return Response.json({ items: await fm.favourites() });
    }
    if (a === "logs" && b) return Response.json(await call(`/logs/${b}?n=200`));
    if (a === "jobs" && !b) return Response.json(await call("/jobs"));
    if (a === "jobs" && b) {
      const job = await call<Parameters<typeof archiveWorkerJob>[0]>(`/jobs/${b}`);
      if (new URL(req.url).searchParams.has("raw")) return Response.json(job); // status only, no archiving (sample script)
      await (await import("@/lib/telemetry")).noteJob(job as unknown as Parameters<typeof import("@/lib/telemetry").noteJob>[0]).catch(() => null); // Health page
      if (job.kind === ("dataset" as string)) {
        const dj = job as unknown as Parameters<typeof archiveDataset>[0];
        const stored = job.status === "done" ? await archiveDataset(dj) : null;
        const part = stored ? await autoTrain(dj, stored) : null;
        return Response.json({ ...job, part });
      }
      if (job.kind === ("voicewalk" as string)) {
        const kvoice = job.status === "done" ? await archiveKVoice(job as unknown as Parameters<typeof archiveKVoice>[0]) : null;
        return Response.json({ ...job, kvoice_saved: kvoice });
      }
      if (job.kind === ("train" as string)) {
        const qwen = (job as unknown as { train_engine?: string }).train_engine === "qwen";
        const model = job.status !== "done" ? null : qwen
          ? await (await import("@/lib/qwenmodels")).archiveQwenModel(job as unknown as Parameters<typeof import("@/lib/qwenmodels").archiveQwenModel>[0])
          : await archiveModel(job as unknown as Parameters<typeof archiveModel>[0]);
        const log = job.status === "error" ? await call<{ text: string }>("/logs/train?n=60").then((r) => r.text.slice(-6000)).catch(() => null) : null;
        return Response.json({ ...job, model, log });
      }
      if (job.kind === ("reference" as string)) {
        const myvoice = job.status === "done" ? await archiveReference(job as unknown as RefJob) : null;
        return Response.json({ ...job, myvoice });
      }
      if (job.kind === ("eagle" as string)) return Response.json(job); // a draft model, not audio: nothing for the Library
      const lib = job.status === "done" ? await archiveWorkerJob(job) : null;
      return Response.json({ ...job, library: lib });
    }
    if (a === "library" && !b) {
      const [jobs, sign] = await Promise.all([listLibrary(), signer()]);
      return Response.json({ jobs: await Promise.all(jobs.map((j) => withUrls(j, sign))) });
    }
    if (a === "library" && b) {
      const j = await getLibJob(b);
      return j ? Response.json(await withUrls(j, await signer())) : Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return err(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const g = await guard(req, ctx);
  if (g.deny) return g.deny;
  const [a, b, c] = g.path;
  try {
    let body = await req.json().catch(() => ({}));
    if (a === "settings") {
      const who = (await currentUser())?.id;
      return Response.json(settingsFor(await updateSettings(body, who), who));
    }
    if (a === "speakable") return Response.json(await call("/speakable", { body }));
    if (a === "coach") {
      // the voice coach: rate a line, get the next recording script, or act on a model comparison
      const coach = await import("@/lib/coach");
      if (b === "rate") {
        // every voice's ratings are kept (lib/ratings.ts); a trained voice's also go to its coach
        const input = { engine: String(body.engine ?? ""), voice: String(body.voice ?? ""), job: String(body.job ?? ""), line: String(body.line ?? ""),
          rating: Number(body.rating) || 0, text: body.text ? String(body.text) : undefined, duration: Number(body.duration) || 0 };
        if (!ID.test(input.job)) return Response.json({ error: "bad job" }, { status: 400 });
        const { rateLine } = await import("@/lib/ratings");
        const saved = await rateLine({ ...input, match: body.match, sim: body.sim });
        if (await coach.personOf(input.engine, input.voice)) await coach.rate(input).catch(() => null);
        return Response.json(saved);
      }
      if (b && VOICE_RE.test(b) && c === "script") return Response.json(await coach.nextScript(b, Number(body.minutes) || 8));
      if (b && VOICE_RE.test(b) && (c === "polish" || c === "practice")) {
        // RLHF: polish the model in use on preference pairs, or voice practice takes to collect more pairs
        const pairs = await import("@/lib/pairs");
        const job = await call("/jobs", { body: c === "polish" ? await pairs.dpoJobBody(b) : await withProfile(await pairs.practiceJobBody(b, Number(body.count) || 40)) });
        return Response.json(job, { status: 202 });
      }
      if (b && VOICE_RE.test(b) && c === "gate" && (body.action === "use" || body.action === "compare") && ID.test(String(body.job ?? "")))
        return Response.json(await coach.gateAction(b, body.action, String(body.job)));
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (a === "files") return await filesAction(b, c, body);
    if (a === "spaces" && b === "goals") return Response.json({ goals: await setGoals(body.goals) });
    if (a === "spaces" && b && ID.test(b)) {
      // a post's targets (where it goes, cross-posting); the post's platforms / stage / publish time follow
      const who = await currentUser();
      return Response.json({ targets: await setTargets(b, body.targets, who ? { id: who.id, name: who.name } : { name: "someone" }) });
    }
    if (a === "jobs" && !b) {
      if (!body.kind || ["story", "revoice", "clean"].includes(body.kind)) body = await withProfile(withDefaults(body, settingsFor(await getSettings(), (await currentUser())?.id)));
      if (body.kind === "story" || body.kind === "clean") {
        // uploads: scene images (scenes[i].image_key), the music bed (music_key), the recording to clean (source_key)
        const up = async (k: unknown) => {
          if (!/^uploads\/[A-Za-z0-9._-]+$/.test(String(k))) throw new Error("bad upload key");
          return presignPath(String(k), 3600);
        };
        if (Array.isArray(body.scenes)) body.scenes = await Promise.all(body.scenes.map(async (s: Record<string, unknown>) =>
          s.image_key ? { ...s, image_url: await up(s.image_key), image_key: undefined } : s));
        if (body.music_key) body.music_url = await up(body.music_key);
        if (body.source_key) body.url = await up(body.source_key);
        delete body.music_key; delete body.source_key;
      }
      if (body.kind === "transcribe") {
        // uploads live in the private bucket: hand the worker short-lived presigned links
        body.sources = await Promise.all(
          (body.sources ?? []).map(async (s: { blob?: string; url?: string }) =>
            s.blob ? { ...s, url: await presignPath(s.blob), blob: undefined } : s),
        );
        if (body.library) {
          // transcribe files already in the library (e.g. subtitles for an older voice job)
          const lib = await getLibJob(String(body.library));
          if (!lib) throw new Error("library job not found");
          const sign = await signer();
          body.sources = await Promise.all(lib.results.map(async (r) => ({ id: r.id, name: `${r.id}.wav`, text: r.text, start: r.start, url: await sign(lib.id, `${r.id}.wav`) })));
          body.label = body.label || `Subtitles · ${lib.label || lib.id}`;
          body.attach_to = lib.id;
        }
      }
      if (body.kind === "video") {
        // the start frame: an upload (uploads/...) or a library video's poster/source frame
        if (body.image_key) {
          if (!/^uploads\/[A-Za-z0-9._-]+$/.test(String(body.image_key))) throw new Error("bad image_key");
          body.image_url = await presignPath(String(body.image_key), 3600);
        } else if (body.image_from) {
          const lib = await getLibJob(String(body.image_from));
          if (lib?.kind === "image" && lib.images?.length) body.image_url = await presignPath(`library/${lib.id}/${lib.images[Math.max(0, Math.min(lib.images.length - 1, Number(body.image_index) || 0))].file}`, 3600);
          else if (!lib?.video?.poster) throw new Error("that library item has no frame to start from");
          else body.image_url = await presignPath(`library/${lib.id}/${body.image_frame === "source" && lib.gen?.source ? "source.jpg" : "poster.jpg"}`, 3600);
        }
        delete body.image_key; delete body.image_from; delete body.image_index;
      }
      if (body.kind === "image" || body.kind === "animate") {
        // uploads (uploads/...) or library items -> short-lived presigned links the worker can fetch
        const upload = async (k: unknown) => {
          if (!/^uploads\/[A-Za-z0-9._-]+$/.test(String(k))) throw new Error("bad upload key");
          return presignPath(String(k), 3600);
        };
        const fromLib = async (id: unknown) => {
          const [lid, n] = String(id).split(":"); // "<library id>:<image index>" picks one image of a set
          const lib = await getLibJob(lid);
          if (!lib) throw new Error("library item not found");
          if (lib.kind === "image" && lib.images?.length) return presignPath(`library/${lib.id}/${lib.images[Math.max(0, Math.min(lib.images.length - 1, Number(n) || 0))].file}`, 3600);
          if (lib.video?.poster) return presignPath(`library/${lib.id}/poster.jpg`, 3600);
          throw new Error("that library item has no image");
        };
        if (body.kind === "image") {
          const keys: unknown[] = Array.isArray(body.image_keys) ? body.image_keys.slice(0, 10) : [];
          const libs: unknown[] = Array.isArray(body.image_from) ? body.image_from.slice(0, 10) : [];
          body.image_urls = [...await Promise.all(keys.map(upload)), ...await Promise.all(libs.map(fromLib))].slice(0, 10);
          delete body.image_keys; delete body.image_from;
        } else {
          if (body.image_key) body.image_url = await upload(body.image_key);
          else if (body.image_from) body.image_url = await fromLib(body.image_from);
          if (body.video_key) body.video_url = await upload(body.video_key);
          else if (body.video_from) {
            const lib = await getLibJob(String(body.video_from));
            if (!lib || lib.kind !== "video") throw new Error("pick a video from the library");
            body.video_url = await presignPath(`library/${lib.id}/video.mp4`, 3600);
          }
          delete body.image_key; delete body.image_from; delete body.video_key; delete body.video_from;
        }
      }
      if (body.kind === "revoice") {
        // the performance: an upload (uploads/...) or a library video's soundtrack
        if (body.source_key) {
          if (!/^uploads\/[A-Za-z0-9._-]+$/.test(String(body.source_key))) throw new Error("bad source_key");
          body.url = await presignPath(String(body.source_key), 3600);
        } else if (body.source_from) {
          const lib = await getLibJob(String(body.source_from));
          if (!lib || lib.kind !== "video") throw new Error("pick a video from the library");
          body.url = await presignPath(`library/${lib.id}/video.mp4`, 3600);
        }
        delete body.source_key; delete body.source_from;
      }
      if (body.kind === "dataset") {
        // recordings for your own voice model: uploads -> short-lived links
        const name = String(body.name ?? "");
        if (!VOICE_RE.test(name)) throw new Error("name: lowercase letters, digits, - or _");
        body.sources = await Promise.all((body.sources ?? []).slice(0, 20).map(async (s: { key?: string; name?: string }) => {
          if (!/^uploads\/[A-Za-z0-9._-]+$/.test(String(s.key))) throw new Error("bad upload key");
          return { name: s.name, url: await presignPath(String(s.key), 6 * 3600) };
        }));
      }
      if (body.kind === "train") {
        // train your own voice on the worker: every collected session travels as a signed link
        const name = String(body.name ?? "");
        if (!VOICE_RE.test(name)) throw new Error("name: lowercase letters, digits, - or _");
        body = { ...body, ...(await trainJobBody(name, body.label, body.engine === "qwen" ? "qwen" : "orpheus")) };
      }
      if (body.kind === "voicewalk") {
        // find your voice in Kokoro: the recording to match travels as a signed link
        const name = String(body.name ?? "");
        if (!VOICE_RE.test(name)) throw new Error("name: lowercase letters, digits, - or _");
        const ref = isCustomVoice(String(body.voice ?? "")) ? await refSync(String(body.voice)) : null;
        if (!ref) throw new Error("voice: record your voice on the Voices page first, then pick it here");
        body.ref = ref;
        body.label = body.label ?? `Your voice in Kokoro · ${name}`;
      }
      if (body.kind === "benchmark") {
        // every recorded voice in the line-up (and the target you're measured against) travels as a signed link
        const names = new Set<string>([...(body.candidates ?? []).map((c: { voice?: string }) => String(c.voice ?? "")), String(body.target_voice ?? "")].filter((v) => isCustomVoice(v)));
        body.refs = Object.fromEntries((await Promise.all([...names].map(async (v) => [v, await refSync(v)] as const))).filter(([, r]) => r));
        if (body.target_voice && body.refs[body.target_voice]) body.target_ref = body.refs[body.target_voice];
        // each candidate at its own learned settings: a fair fight
        body.candidates = await Promise.all((body.candidates ?? []).map(async (cand: { engine?: string; voice?: string; params?: Record<string, number> }) => {
          const prof = await profileFor(cand.engine, cand.voice, body.style ?? "tech").catch(() => null);
          return { ...cand, params: { ...(prof?.params ?? {}), ...(cand.params ?? {}) } };
        }));
      }
      if ((!body.kind || body.kind === "revoice" || body.kind === "story") && typeof body.voice === "string" && isCustomVoice(body.voice)) {
        // a recorded voice: hand the worker a link to it (its disk is wiped whenever Colab recycles the runtime)
        const ref = await refSync(body.voice);
        if (ref) body.ref = ref;
      }
      return Response.json(await call("/jobs", { body }), { status: 202 });
    }
    if (a === "myvoices" && !b) {
      // POST {name, label?, key}: clean + transcribe an uploaded recording on the worker, then keep it in R2
      const name = String(body.name ?? "").toLowerCase();
      if (!VOICE_RE.test(name) || !isCustomVoice(name)) return Response.json({ error: "name: lowercase letters, digits, - or _ (not female/male/default)" }, { status: 400 });
      if (body.dataset) {
        // a voice from a Your model dataset: the worker picks ~15-20 s of its clean clips (any engine can then clone it)
        const ds = String(body.dataset);
        if (!VOICE_RE.test(ds)) return Response.json({ error: "dataset: lowercase letters, digits, - or _" }, { status: 400 });
        const parts = (await datasetManifest(ds)).parts.sort((x, y) => y.clips - x.clips);
        if (!parts.length) return Response.json({ error: `the ${ds} dataset is empty: collect first` }, { status: 400 });
        const job = await call("/jobs", { body: { kind: "reference", name, url: parts[0].url, from_dataset: true, label: String(body.label ?? name).slice(0, 60),
          version: Date.now().toString(36), max_seconds: body.max_seconds } });
        return Response.json(job, { status: 202 });
      }
      if (!/^uploads\/[A-Za-z0-9._-]+$/.test(String(body.key ?? ""))) return Response.json({ error: "upload the recording first" }, { status: 400 });
      const job = await call("/jobs", { body: { kind: "reference", name, url: await presignPath(String(body.key), 3600), label: String(body.label ?? name).slice(0, 60),
        version: Date.now().toString(36), language: body.language || undefined, enhance: body.enhance ?? (await getSettings()).enhance_recordings,
        max_seconds: body.max_seconds } });
      return Response.json(job, { status: 202 });
    }
    if (a === "samples" && b && c) {
      // POST {job, line, duration, text}: store one finished line as the audition sample for <engine>/<voice> (used by scripts/make-samples.py)
      if (!/^[a-z]+$/.test(b) || !/^[A-Za-z0-9_-]{1,40}$/.test(c) || !ID.test(String(body.job ?? "")) || !ID.test(String(body.line ?? ""))) return Response.json({ error: "bad sample" }, { status: 400 });
      const res = await call<{ failed: Record<string, string> }>(`/jobs/${body.job}/push`, { body: { targets: { [`${body.line}.wav`]: await samplePutUrl(b, c) }, headers: {} }, timeoutMs: 55_000 });
      if (Object.keys(res.failed).length) throw new Error(Object.values(res.failed)[0]);
      await recordSample(b, c, Number(body.duration) || 0, String(body.text ?? ""));
      return Response.json({ ok: true });
    }
    if (a === "jobs" && c === "cancel") return Response.json(await call(`/jobs/${b}/cancel`, { body: {} }));
    if (a === "engines" && b && (c === "load" || c === "unload" || c === "forget")) return Response.json(await call(`/engines/${b}/${c}`, { body: {} }));
    if (a === "library" && b && c === "presign") {
      // large uploads (videos) go straight to Blob: POST /library/<job>/presign {files: ["video.mp4", ...]}
      const files: string[] = Array.isArray(body.files) ? body.files.map(String) : [];
      if (!ID.test(b) || !files.length || !files.every((f) => FILE_RE.test(f))) return Response.json({ error: "bad job id or file names" }, { status: 400 });
      return Response.json(await presignPuts(b, files));
    }
    if (a === "security") {
      const acc = await import("@/lib/access");
      if (b === "signout-all") { await acc.signOutEverywhere(); return Response.json({ ok: true }); }
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "a valid email, please" }, { status: 400 });
      const s = await getSettings();
      if (b === "add") return Response.json(await updateSettings({ workspace_emails: [...s.workspace_emails, email] }).then(() => ({ ok: true })));
      if (b === "remove") {
        if (email === (await currentUser())?.email.toLowerCase()) return Response.json({ error: "you can't remove yourself" }, { status: 400 });
        if ((process.env.WORKSPACE_EMAILS ?? "").toLowerCase().split(",").map((x) => x.trim()).includes(email))
          return Response.json({ error: "this email is in WORKSPACE_EMAILS on Vercel: remove it there" }, { status: 400 });
        await updateSettings({ workspace_emails: s.workspace_emails.filter((x) => x !== email) });
        const { hasKey, removeMember } = await import("@/lib/appwrite");
        if (hasKey()) await removeMember(email);
        await acc.allowedEmails(true);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (a === "colab") {
      // the GPU from the app: connect Colab once, then start / stop runtimes, read the balance, set reminders
      const colab = await import("@/lib/colab");
      if (b === "auth") return Response.json({ url: await colab.authUrl() });
      if (b === "connect") return Response.json(await colab.connect(String(body.code ?? "")));
      if (b === "disconnect") { await colab.disconnect(); return Response.json({ ok: true }); }
      if (b === "start") return Response.json(await colab.start(new URL(req.url).origin, body.gpu,
        { purpose: body.purpose === "voice" || body.purpose === "heavy" ? body.purpose : undefined, high_ram: typeof body.high_ram === "boolean" ? body.high_ram : undefined }));
      if (b === "stop") {
        const ep = String(body.endpoint ?? (await colab.getSession())?.endpoint ?? "");
        if (!ep) return Response.json({ error: "no runtime to stop" }, { status: 400 });
        return Response.json(await colab.stopRuntime(ep));
      }
      if (b === "config") return Response.json(await colab.setConfig(body));
      if (b === "notify") return Response.json({ sent: await colab.notify("Voicebox test", "Notifications work: you'll get GPU reminders here.", "bell") });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (a === "worker" && b === "restart") return Response.json(await call("/admin/restart", { body: {} }));
    if (a === "worker" && b === "update") {
      // the worker fetches the newest code from this dashboard and restarts itself (no Colab restart needed)
      return Response.json(await call("/admin/update", { body: { url: `${new URL(req.url).origin}/api/bundle` }, timeoutMs: 55_000 }));
    }
    if (a === "worker" && b === "selfcheck") return Response.json(await call("/selfcheck", { body: {} }));
    if (a === "refs") return Response.json(await call("/refs", { body, timeoutMs: 55_000 }));
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return err(e);
  }
}

/** The Files page's file manager: folders, moving, stars, renaming, deleting and importing a link (lib/files.ts). */
async function filesAction(b: string | undefined, c: string | undefined, body: Record<string, unknown>) {
  const fs = await import("@/lib/files");
  const fm = await import("@/lib/filemanager");
  const who = await currentUser();
  const actor = who ? { id: who.id, name: who.name } : { name: "someone" };
  const keys = (v: unknown, folders = false) => {
    const k = Array.isArray(v) ? v.map(String) : [];
    if (!k.length || k.length > 500 || !k.every((x) => fs.ITEM_RE.test(x) || (folders && x.startsWith("f:") && fs.FOLDER_RE.test(x.slice(2)))))
      throw new fs.FilesError("items: 1-500 ids such as m:<upload id>, g:<library id> or f:<folder id>");
    return k;
  };
  const folder = (v: unknown) => {
    if (v == null || v === "") return null;
    if (!fs.FOLDER_RE.test(String(v))) throw new fs.FilesError("bad folder id");
    return String(v);
  };
  try {
    if (b === "folders" && !c) return Response.json(await fs.createFolder({ id: body.id, name: body.name, color: body.color, parent: folder(body.parent) }, actor.name));
    if (b === "folders" && c && fs.FOLDER_RE.test(c))
      return Response.json(await fs.updateFolder(c, { name: body.name, color: body.color, parent: body.parent === undefined ? undefined : folder(body.parent) }));
    if (b === "move") return Response.json(await fs.moveItems(keys(body.items, true), folder(body.folder)));
    if (b === "auto") { await fs.autoFile(keys(body.items)); return Response.json({ ok: true }); }
    if (b === "star") return Response.json({ starred: await fs.starItems(keys(body.items, true), !!body.on) });
    if (b === "rename") return Response.json(await fm.renameItem(keys([body.item])[0], String(body.name ?? ""), actor));
    if (b === "delete") return Response.json(await fm.deleteItems(keys(body.items, true), actor, body.forever === true));
    if (b === "restore") return Response.json(await fm.restore(keys(body.items, true)));
    if (b === "empty-trash") return Response.json(await fm.emptyTrash(actor));
    if (b === "poster") return Response.json(await fm.savePoster(keys([body.item])[0], String(body.data ?? "")));
    if (b === "import") {
      const r = await fm.importUrl(String(body.url ?? ""), { name: body.name ? String(body.name) : undefined, folder: folder(body.folder), backup: (await getSettings()).backup_media }, actor);
      return Response.json({ media: r.media, backup: r.backup, folder: r.folder });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    if (e instanceof fs.FilesError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/** Upload into the library: PUT /api/dash/library/<job>/<line>.wav (audio body) or .../<job>/job.json */
export async function PUT(req: Request, ctx: Ctx) {
  const g = await guard(req, ctx);
  if (g.deny) return g.deny;
  const [a, job, file] = g.path;
  if (a !== "library" || !ID.test(job ?? "") || !file) return Response.json({ error: "bad path" }, { status: 400 });
  if (file === "job.json") {
    const j = (await req.json()) as LibJob;
    await putLibJob({ ...j, id: job, archived: Date.now() });
    return Response.json({ ok: true });
  }
  if (!FILE_RE.test(file)) return Response.json({ error: "bad file name" }, { status: 400 });
  await putFile(job, file, await req.arrayBuffer());
  return Response.json({ ok: true });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await guard(req, ctx);
  if (g.deny) return g.deny;
  const [a, b] = g.path;
  if (a === "datasets" && b && VOICE_RE.test(b) && ID.test(String(g.path[2] ?? ""))) {
    await deleteDatasetPart(b, String(g.path[2]));
    return Response.json({ ok: true });
  }
  if (a === "files" && b === "folders" && g.path[2]) {
    const fs = await import("@/lib/files");
    if (!fs.FOLDER_RE.test(g.path[2])) return Response.json({ error: "bad folder id" }, { status: 400 });
    try {
      return Response.json(await fs.trashItems([`f:${g.path[2]}`], (await currentUser())?.name ?? null)); // to the trash
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: e instanceof fs.FilesError ? e.status : 502 });
    }
  }
  if (a === "spaces" && b && ID.test(b)) {
    await dropTargets(b);
    return Response.json({ ok: true });
  }
  if (a === "myvoices" && b) {
    if (!isCustomVoice(b)) return Response.json({ error: "bad voice" }, { status: 400 });
    await deleteMyVoice(b);
    return Response.json({ ok: true });
  }
  if (a === "library" && !b) {
    // bulk delete: { ids: [...] }
    const body = await req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length || ids.length > 500 || !ids.every((i) => ID.test(i))) return Response.json({ error: "ids must be 1-500 library job ids" }, { status: 400 });
    const out = await Promise.allSettled(ids.map((i) => deleteLibJob(i)));
    const failed = ids.filter((_, k) => out[k].status === "rejected");
    return Response.json({ deleted: ids.filter((i) => !failed.includes(i)), failed });
  }
  if (a !== "library" || !ID.test(b ?? "")) return Response.json({ error: "bad path" }, { status: 400 });
  await deleteLibJob(b);
  return Response.json({ ok: true });
}
