// Ask Voicebox API (cookie session or Bearer MCP_TOKEN, like every dashboard route).
//   GET    /api/ask                  chats, and which brains are ready
//   GET    /api/ask/c/<id>           one chat (a running Antigravity message catches up here)
//   POST   /api/ask/c                {text, id?, brain?}: Gemini answers as NDJSON events; Antigravity starts on the worker
//   POST   /api/ask/c/<id>/decide    {approval, approve}: run or decline a parked action
//   DELETE /api/ask/c/<id>
//   POST   /api/ask/prefs            {brain}: auto | gemini | antigravity
//   GET    /api/ask/agy              Antigravity on the worker: installed, signed in, sign-in link
//   POST   /api/ask/agy/login | /api/ask/agy/code {code} | /api/ask/agy/logout
import { currentUser, isAuthed } from "@/lib/session";
import { CID_RE, decide, deleteConvo, geminiReady, getConvo, getPrefs, listConvos, newConvo, newId, saveConvo, setPrefs, updateConvo, type Brain, type Convo } from "@/lib/ask";
import { agyStatus, logout, pollRun, sendCode, startLogin, startRun, workerOnline } from "@/lib/agy";
import { WorkerOffline } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ path?: string[] }> };
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const fail = (e: unknown) => bad(e instanceof WorkerOffline ? "The Colab worker is off: start it on GPU & engines, or switch Ask Voicebox to Gemini." : (e as Error).message, e instanceof WorkerOffline ? 503 : 502);
const STUCK_MS = 6 * 60_000; // a run that never finished (the page closed mid-stream) stops blocking the chat

async function who() {
  const u = await currentUser();
  return { name: u?.name?.split(" ")[0] || "Owner", id: u?.id };
}

async function brains() {
  const prefs = await getPrefs();
  return { brain: prefs.brain, gemini: geminiReady(), antigravity: { signed_in: !!prefs.agy, email: prefs.agy?.email ?? null, worker: await workerOnline() } };
}

async function pick(asked?: unknown): Promise<Brain> {
  const prefs = await getPrefs();
  const want = asked === "gemini" || asked === "antigravity" ? asked : prefs.brain;
  const agyOk = !!prefs.agy && (await workerOnline());
  if (want === "gemini") {
    if (!geminiReady()) throw new Error("Gemini isn't set up: add GEMINI_API_KEY (a free AI Studio key) in Vercel, or use Antigravity.");
    return "gemini";
  }
  if (want === "antigravity") {
    if (!prefs.agy) throw new Error("Antigravity isn't signed in: Settings → Ask Voicebox → Sign in with Google.");
    if (!agyOk) throw new Error("Antigravity runs on the Colab worker, which is off: start it, or switch to Gemini.");
    return "antigravity";
  }
  if (agyOk) return "antigravity";
  if (geminiReady()) return "gemini";
  throw new Error(prefs.agy ? "The Colab worker is off and Gemini isn't set up (GEMINI_API_KEY)." : "Set up a brain first: Settings → Ask Voicebox.");
}

export async function GET(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return bad("unauthorized", 401);
  const [b, c] = (await ctx.params).path ?? [];
  try {
    if (!b) return Response.json({ chats: await listConvos(), ...(await brains()) });
    if (b === "c" && c) {
      let convo = await getConvo(c);
      if (!convo) return bad("no such chat", 404);
      if (convo.running?.brain === "antigravity") convo = await pollRun(convo);
      return Response.json(convo);
    }
    if (b === "agy") return Response.json(await agyStatus());
    return bad("not found", 404);
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return bad("unauthorized", 401);
  const [b, c, d] = (await ctx.params).path ?? [];
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (b === "prefs") {
      const brain = body.brain;
      if (brain !== "auto" && brain !== "gemini" && brain !== "antigravity") return bad("brain is auto, gemini or antigravity");
      await setPrefs({ brain });
      return Response.json(await brains());
    }
    if (b === "agy" && c === "login") return Response.json(await startLogin());
    if (b === "agy" && c === "code") {
      const code = String(body.code ?? "").trim();
      if (!/^[\w./~+-]{8,600}$/.test(code)) return bad("paste the whole code Google showed you");
      return Response.json(await sendCode(code));
    }
    if (b === "agy" && c === "logout") { await logout(); return Response.json({ ok: true }); }
    if (b === "c" && c && d === "decide") {
      if (!CID_RE.test(c)) return bad("bad chat id");
      return Response.json(await decide(c, String(body.approval ?? ""), body.approve === true, await who()));
    }
    if (b === "c" && !c) return message(body);
    return bad("not found", 404);
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return bad("unauthorized", 401);
  const [b, c] = (await ctx.params).path ?? [];
  if (b !== "c" || !c || !CID_RE.test(c)) return bad("not found", 404);
  await deleteConvo(c);
  return Response.json({ ok: true });
}

async function message(body: Record<string, unknown>) {
  const text = String(body.text ?? "").trim();
  if (!text) return bad("say something");
  if (text.length > 20_000) return bad("that's too long (20,000 characters max)");
  const me = await who();
  let convo: Convo | null = body.id ? await getConvo(String(body.id)) : null;
  if (body.id && !convo) return bad("no such chat", 404);
  if (convo?.running && Date.now() - convo.running.since < STUCK_MS) return bad("still working on the last message", 409);
  const brain = await pick(body.brain);
  convo = convo ?? newConvo(text, me.name);
  convo.msgs.push({ id: newId(8), role: "user", text, at: Date.now(), by: me.name });
  convo.running = { brain, since: Date.now() };
  await saveConvo(convo);

  if (brain === "antigravity") {
    try {
      return Response.json(await startRun(convo, text, me));
    } catch (e) {
      const saved = await updateConvo(convo.id, (x) => {
        x.running = null;
        x.msgs.push({ id: newId(8), role: "assistant", at: Date.now(), brain, error: true, text: `Couldn't reach Antigravity: ${(e as Error).message}` });
      });
      return Response.json(saved);
    }
  }

  const { runGemini } = await import("@/lib/gemini");
  const cid = convo.id;
  const start = convo;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* the page went away; keep going */ } };
      send({ t: "convo", convo: start });
      let saved: Convo;
      try {
        const { msg, history } = await runGemini(start, text, me, send);
        saved = await updateConvo(cid, (x) => { x.msgs.push(msg); x.gemini = history; x.running = null; });
      } catch (e) {
        saved = await updateConvo(cid, (x) => {
          x.running = null;
          x.msgs.push({ id: newId(8), role: "assistant", at: Date.now(), brain: "gemini", error: true, text: (e as Error).message });
        });
      }
      send({ t: "done", convo: saved });
      try { ctrl.close(); } catch { /* closed */ }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
