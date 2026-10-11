// JSON API behind the dashboard (cookie session or Bearer MCP_TOKEN).
import { isAuthed } from "@/lib/session";
import { call, WorkerOffline } from "@/lib/worker";
import { loadWorker, STALE_MS } from "@/lib/registry";
import { archiveWorkerJob, deleteLibJob, getLibJob, listLibrary, putAudio, putLibJob, type LibJob } from "@/lib/library";

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
    if (a === "jobs" && !b) return Response.json(await call("/jobs"));
    if (a === "jobs" && b) {
      const job = await call<Parameters<typeof archiveWorkerJob>[0]>(`/jobs/${b}`);
      const lib = job.status === "done" ? await archiveWorkerJob(job) : null;
      return Response.json({ ...job, library: lib });
    }
    if (a === "library" && !b) return Response.json({ jobs: await listLibrary() });
    if (a === "library" && b) {
      const j = await getLibJob(b);
      return j ? Response.json(j) : Response.json({ error: "not found" }, { status: 404 });
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
    if (a === "jobs" && !b) return Response.json(await call("/jobs", { body }), { status: 202 });
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
  const line = file.replace(/\.wav$/, "");
  if (!ID.test(line)) return Response.json({ error: "bad line id" }, { status: 400 });
  await putAudio(job, line, await req.arrayBuffer());
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
