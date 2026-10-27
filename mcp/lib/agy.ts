// Ask Voicebox's Antigravity brain: Antigravity CLI (agy) on the Colab worker, signed in with the owner's Google account
// (their Google AI plan pays for it, not an API key). The worker side is worker/ask.py: it installs agy, runs the
// Google sign-in (a link and a code pasted back here), and runs one `agy -p` per message with the Voicebox MCP server
// (/api/mcp?ask=1, a token for that conversation only). The sign-in files are kept sealed in R2 (lib/ask.ts seal), so
// a fresh Colab runtime is signed in again without asking. agy uses no GPU: the thinking happens at Google.
import { approvalNotes, getPrefs, mintAskToken, newId, seal, setPrefs, unseal, updateConvo, type Convo, type Step } from "./ask";
import { appOrigin } from "./colab";
import { loadWorker, STALE_MS } from "./registry";
import { call } from "./worker";

export type AgyStatus = { online: boolean; installed?: boolean; signed_in?: boolean; login?: { url: string; expires: number } | null; email?: string | null; saved?: boolean; error?: string; version?: string };
type Run = { status: "running" | "done" | "error"; events: { kind: "tool" | "text"; tool?: string; ok?: boolean; text?: string }[]; text?: string; conversation?: string | null; error?: string | null };

export async function workerOnline() {
  const rec = await loadWorker();
  return !!rec && Date.now() - rec.last_seen < STALE_MS;
}

/** The saved sign-in, unsealed for the worker (null when there's none or it can't be opened). */
async function savedAuth() {
  const p = await getPrefs();
  return p.agy?.blob ? unseal(p.agy.blob) : null;
}

export async function agyStatus(): Promise<AgyStatus> {
  const prefs = await getPrefs();
  const base = { saved: !!prefs.agy, email: prefs.agy?.email ?? null };
  if (!(await workerOnline())) return { online: false, ...base };
  try {
    const s = await call<Omit<AgyStatus, "online">>("/ask/status", { timeoutMs: 15_000 });
    return { online: true, ...base, ...s, email: s.email ?? base.email };
  } catch (e) {
    return { online: true, ...base, error: (e as Error).message };
  }
}

/** Start the Google sign-in on the worker: a link to open. The code it shows has to come back within a minute. */
export async function startLogin() {
  const r = await call<{ url: string | null; expires: number; signed_in?: boolean; blob?: string }>("/ask/login", { body: {}, timeoutMs: 120_000 }); // a fresh worker installs agy first
  if (r.signed_in && r.blob) { // it was signed in already (a sign-in restored on this runtime)
    const prefs = await getPrefs();
    await setPrefs({ agy: { blob: seal(r.blob), email: prefs.agy?.email ?? null, at: Date.now() } });
  }
  return { url: r.url, expires: r.expires, signed_in: !!r.signed_in };
}

export async function sendCode(code: string) {
  const r = await call<{ ok: boolean; blob?: string; email?: string | null; error?: string }>("/ask/login/code", { body: { code }, timeoutMs: 90_000 });
  if (r.ok && r.blob) await setPrefs({ agy: { blob: seal(r.blob), email: r.email ?? null, at: Date.now() } });
  return { ok: r.ok, email: r.email ?? null, error: r.error };
}

export async function logout() {
  await setPrefs({ agy: null });
  if (await workerOnline()) await call("/ask/logout", { body: {}, timeoutMs: 20_000 }).catch(() => null);
}

const RULES = [
  "You are Ask Voicebox, the assistant built into the Voicebox dashboard, working for one of its two creators.",
  "Do the work with the voicebox MCP tools only. Never run shell commands and never read or write files on this machine.",
  "Look things up before acting (list_files, workspace_board, get_post) and use real ids from results. Never invent results, links or ids.",
  "Some actions wait for the person to approve them: when a tool says WAITING FOR APPROVAL, tell them it's waiting for their click and carry on.",
  "Reply short and plain, in the language the person writes in: what you did, what's waiting, what's next.",
].join("\n");

/** Start one message on the worker. The reply fills in as pollRun picks up what agy did. */
export async function startRun(c: Convo, userText: string, who: { name: string }) {
  const history = c.agy?.conversation ? "" : c.msgs.slice(-8, -1).map((m) => `${m.role === "user" ? m.by ?? "Person" : "You"}: ${m.text.slice(0, 1500)}`).join("\n");
  const lastAssistant = [...c.msgs].reverse().find((m) => m.role === "assistant")?.at ?? 0;
  const prompt = [RULES, `Now: ${new Date().toISOString()}. You're talking with ${who.name}.`, history ? `Earlier in this chat:\n${history}` : "",
    approvalNotes(c, lastAssistant), `${who.name}: ${userText}`].filter(Boolean).join("\n\n");
  const r = await call<{ id: string }>("/ask", {
    body: { prompt, mcp_url: `${appOrigin()}/api/mcp?ask=1`, token: mintAskToken(c.id), conversation: c.agy?.conversation ?? null, auth: await savedAuth() },
    timeoutMs: 120_000,
  });
  const msg = newId(8);
  return updateConvo(c.id, (x) => {
    x.agy = { ...x.agy, job: r.id, msg, seen: 0 };
    x.msgs.push({ id: msg, role: "assistant", at: Date.now(), brain: "antigravity", text: "", steps: [] });
    x.running = { brain: "antigravity", since: Date.now() };
  });
}

/** Bring a running Antigravity message up to date (called while the dashboard watches the chat). */
export async function pollRun(c: Convo) {
  if (c.running?.brain !== "antigravity" || !c.agy?.job) return c;
  let r: Run;
  try {
    r = await call<Run>(`/ask/${c.agy.job}`, { timeoutMs: 15_000 });
  } catch (e) {
    if (Date.now() - (c.running.since ?? 0) < 10 * 60_000) return c; // the worker may be busy or reconnecting
    r = { status: "error", events: [], error: `lost the worker: ${(e as Error).message}` };
  }
  const steps: Step[] = r.events.filter((e) => e.kind === "tool").map((e) => ({ tool: e.tool ?? "tool", ok: e.ok }));
  const said = r.text || r.events.filter((e) => e.kind === "text").map((e) => e.text).join("\n").trim();
  return updateConvo(c.id, (x) => {
    const m = x.msgs.find((y) => y.id === x.agy?.msg);
    if (m) {
      m.steps = steps;
      m.text = r.status === "error" ? `Antigravity stopped: ${r.error ?? "unknown error"}` : said;
      m.error = r.status === "error";
      if (r.status !== "running" && !m.text) m.text = "Done.";
    }
    if (r.conversation) x.agy = { ...x.agy, conversation: r.conversation };
    if (r.status !== "running") x.running = null;
  });
}
