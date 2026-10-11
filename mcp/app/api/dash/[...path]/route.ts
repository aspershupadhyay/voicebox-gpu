// JSON API behind the dashboard (cookie session or Bearer MCP_TOKEN).
import { isAuthed } from "@/lib/session";
import { call, WorkerOffline } from "@/lib/worker";
import { loadWorker, STALE_MS } from "@/lib/registry";
import { archiveWorkerJob, deleteLibJob, FILE_RE, getLibJob, listLibrary, presignPath, putFile, putLibJob, signer, withUrls, type LibJob } from "@/lib/library";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  const [a, b] = g.path;
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
    if (a === "logs" && b) return Response.json(await call(`/logs/${b}?n=200`));
    if (a === "jobs" && !b) return Response.json(await call("/jobs"));
    if (a === "jobs" && b) {
      const job = await call<Parameters<typeof archiveWorkerJob>[0]>(`/jobs/${b}`);
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
    const body = await req.json().catch(() => ({}));
    if (a === "jobs" && !b) {
      if (body.kind === "transcribe") {
        // uploads live in private Blob: hand the worker short-lived presigned links
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
      return Response.json(await call("/jobs", { body }), { status: 202 });
    }
    if (a === "jobs" && c === "cancel") return Response.json(await call(`/jobs/${b}/cancel`, { body: {} }));
    if (a === "engines" && b && (c === "load" || c === "unload")) return Response.json(await call(`/engines/${b}/${c}`, { body: {} }));
    if (a === "refs") return Response.json(await call("/refs", { body, timeoutMs: 55_000 }));
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return err(e);
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
  if (a !== "library" || !ID.test(b ?? "")) return Response.json({ error: "bad path" }, { status: 400 });
  await deleteLibJob(b);
  return Response.json({ ok: true });
}
