// Ask Voicebox's Gemini brain: the Gemini API with function calling over every Voicebox tool (lib/mcptools.ts), run
// in-process here on Vercel. The key is GEMINI_API_KEY (an AI Studio key; the free tier is enough for two people);
// GEMINI_MODEL picks the model (default: Google's latest Flash). Risky calls are parked for approval (lib/ask.ts).
import { z } from "zod";
import { approvalNotes, ASK_ACTOR, gateFor, localTools, newId, runTool, type Convo, type Msg, type Step } from "./ask";
import { INSTRUCTIONS } from "./mcptools";

type Part = { text?: string; thought?: boolean; functionCall?: { id?: string; name: string; args?: Record<string, unknown> }; functionResponse?: unknown; thoughtSignature?: string };
type Content = { role: "user" | "model"; parts: Part[] };
export type AskEvent =
  | { t: "step"; tool: string; args?: Record<string, unknown> }
  | { t: "result"; tool: string; ok: boolean; note?: string; waiting?: boolean }
  | { t: "text"; text: string }
  | { t: "error"; text: string };

const MODEL = () => process.env.GEMINI_MODEL || "gemini-flash-latest";
const MAX_STEPS = 24;
const BUDGET_MS = 250_000; // the route may run 300 s

let decls: unknown[] | null = null;
function declarations(tools: ReturnType<typeof localTools>) {
  if (decls) return decls;
  decls = [...tools.values()].map((t) => {
    let schema: Record<string, unknown> = { type: "object", properties: {} };
    if (t.schema) {
      try {
        schema = z.toJSONSchema(t.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
        delete schema.$schema;
      } catch { /* keep the empty object */ }
    }
    return { name: t.name, description: t.description.slice(0, 1500), parametersJsonSchema: schema };
  });
  return decls;
}

function system(who: string) {
  const now = new Date().toISOString();
  return [
    `You are Ask Voicebox, the assistant built into the Voicebox dashboard. You're talking with ${who}, one of the two creators. Now: ${now}.`,
    "Do the work yourself with the tools instead of explaining how. Look things up before acting (list_files, workspace_board, get_post) and use real ids from results.",
    "Keep replies short and plain: what you did, what's waiting, what's next. Reply in the language the person writes in. No markdown headings; short lists are fine.",
    "Some actions (deleting, emptying the trash, changing settings, starting or stopping the GPU, training) wait for the person to approve them: when a tool says WAITING FOR APPROVAL, tell them it's waiting for their click and carry on with the rest.",
    "Never invent results, links or ids.",
    "",
    INSTRUCTIONS,
  ].join("\n");
}

async function generate(contents: Content[], sys: string, tools: unknown[]) {
  const r = await fetch(`${process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com"}/v1beta/models/${encodeURIComponent(MODEL())}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: "AUTO" } } }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await r.json().catch(() => null)) as { candidates?: { content?: Content; finishReason?: string }[]; error?: { message?: string; status?: string } } | null;
  if (!r.ok) {
    if (r.status === 429) throw new Error("Gemini's free limit is used up for the moment: try again in a minute, or switch Ask Voicebox to Antigravity in Settings.");
    if (r.status === 400 && /API key/i.test(data?.error?.message ?? "")) throw new Error("GEMINI_API_KEY isn't a working key (AI Studio → Get API key).");
    throw new Error(`Gemini said ${r.status}: ${data?.error?.message?.slice(0, 300) ?? "no answer"}`);
  }
  const c = data?.candidates?.[0];
  if (!c?.content?.parts?.length) throw new Error(`Gemini gave no answer${c?.finishReason ? ` (${c.finishReason})` : ""}`);
  return { ...c.content, role: "model" as const };
}

/** Keep the history small: the last turns, starting at a person's message, with big tool results cut down. */
function trim(contents: Content[]) {
  let out = contents.slice(-40);
  const start = out.findIndex((c) => c.role === "user" && c.parts.some((p) => p.text));
  out = start > 0 ? out.slice(start) : out;
  return out.map((c) => ({
    ...c,
    parts: c.parts.map((p) => {
      if (!p.functionResponse) return p;
      const s = JSON.stringify(p.functionResponse);
      return s.length > 3000 ? { functionResponse: { ...(p.functionResponse as object), response: { result: "(cut from history)" } } } : p;
    }),
  }));
}

/** One turn: the person's message in, Gemini works through the tools, its reply out. Events stream as it goes. */
export async function runGemini(c: Convo, userText: string, who: { name: string }, emit: (e: AskEvent) => void): Promise<{ msg: Msg; history: Content[] }> {
  const tools = localTools({ name: `${ASK_ACTOR.name} (Gemini, for ${who.name})` }, gateFor(c.id));
  const fdecls = declarations(tools);
  const contents: Content[] = [...((c.gemini as Content[] | undefined) ?? [])];
  const lastAssistant = [...c.msgs].reverse().find((m) => m.role === "assistant")?.at ?? 0;
  contents.push({ role: "user", parts: [{ text: approvalNotes(c, lastAssistant) + userText }] });
  const steps: Step[] = [];
  const t0 = Date.now();
  const sys = system(who.name);
  let reply = "";
  for (let i = 0; i < MAX_STEPS; i++) {
    if (Date.now() - t0 > BUDGET_MS) { reply = (reply ? reply + "\n\n" : "") + "I ran out of time on this one: ask me to carry on."; break; }
    const model = await generate(contents, sys, fdecls);
    contents.push(model);
    const said = model.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
    if (said) { reply = said; emit({ t: "text", text: said }); }
    const calls = model.parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
    if (!calls.length) break;
    const responses: Part[] = [];
    for (const fc of calls) {
      emit({ t: "step", tool: fc.name, args: fc.args });
      const r = await runTool(tools, fc.name, fc.args ?? {});
      const note = r.text.replace(/\s+/g, " ").slice(0, 160);
      steps.push({ tool: fc.name, args: fc.args, ok: r.ok || r.waiting, note: r.ok || r.waiting ? undefined : note, waiting: r.waiting });
      emit({ t: "result", tool: fc.name, ok: !!(r.ok || r.waiting), note: r.ok || r.waiting ? undefined : note, waiting: r.waiting });
      responses.push({ functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response: { result: r.text } } } as Part);
    }
    contents.push({ role: "user", parts: responses });
  }
  const msg: Msg = { id: newId(8), role: "assistant", at: Date.now(), brain: "gemini", text: reply || "Done.", steps };
  return { msg, history: trim(contents) };
}
