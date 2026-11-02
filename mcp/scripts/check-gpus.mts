// Checks the Colab / Modal routing (lib/worker.ts, lib/gpus.ts) against two fake gateways and an in-memory bucket:
// preference, fallback both ways, a job's follow-ups going to the GPU that has it, a sleeping Modal never woken by a
// read, the monthly cap, and heavy jobs kept off Modal.   npx -y tsx scripts/check-gpus.mts
import http from "node:http";
import { promises as fs } from "node:fs";

const mem = new Map<string, string>();
const obj = (key: string, v: string) => ({ key, size: v.length, etag: "e", httpEtag: '"e"', uploaded: new Date(), httpMetadata: { contentType: "application/json" }, body: new Response(v).body });
(globalThis as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] = { env: { BUCKET: {
  get: async (k: string) => (mem.has(k) ? obj(k, mem.get(k)!) : null),
  head: async (k: string) => (mem.has(k) ? obj(k, mem.get(k)!) : null),
  put: async (k: string, v: unknown) => { mem.set(k, typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array)); },
  delete: async () => {}, list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
} } };
process.env.WORKER_SECRET = "x".repeat(32);

type Fake = { name: string; hits: string[]; jobs: string[]; url: string; down?: boolean; auth?: string };
function fake(name: string): Promise<Fake> {
  const f: Fake = { name, hits: [], jobs: [], url: "" };
  const srv = http.createServer((req, res) => {
    if (f.down) { req.socket.destroy(); return; }
    f.hits.push(`${req.method} ${req.url}`);
    f.auth = req.headers.authorization;
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/jobs" && req.method === "POST") { const id = `${name[0]}${String(f.jobs.length).padStart(11, "0")}`; f.jobs.push(id); return res.end(JSON.stringify({ id, on: name })); }
      if (req.url === "/jobs") return res.end(JSON.stringify({ jobs: f.jobs.map((id) => ({ id })) }));
      if (req.url?.startsWith("/jobs/")) return res.end(JSON.stringify({ id: req.url.split("/")[2], on: name }));
      res.end(JSON.stringify({ ok: true, on: name, gpu: { name } }));
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => { f.url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`; ok(f); }));
}

const colab = await fake("colab"), modal = await fake("modal");
process.env.MODAL_WORKER_URL = modal.url;
const reg = await import("../lib/registry");
const gp = await import("../lib/gpus");
const { call } = await import("../lib/worker");
await fs.rm("/tmp/voicebox-worker.json", { force: true }); await fs.rm("/tmp/voicebox-worker.json.modal", { force: true });
const beat = (b: "colab" | "modal", ago = 0) => reg.saveWorker({ url: b === "colab" ? colab.url : modal.url, started_at: Date.now() / 1000 - 600, last_seen: Date.now() - ago }, b);
const prefs = async (p: Record<string, unknown>) => { mem.set("voicebox/gpu-prefs.json", JSON.stringify({ ...gp.DEFAULT_PREFS, ...p })); await new Promise((r) => setTimeout(r, 4100)); };
let fails = 0;
const ok = (c: boolean, what: string) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) fails++; };
const on = async (p: Promise<unknown>) => ((await p) as { on: string }).on;
const reset = () => { colab.hits = []; modal.hits = []; };

// 1. Colab on, Colab first: new work and reads go to Colab
await beat("colab"); await beat("modal", 10 * 60_000);
ok((await on(call("/jobs", { body: { kind: "tts" } }))) === "colab", "Colab first: a job goes to Colab");
// 2. Colab off: the job falls back to Modal, which is woken first
await beat("colab", 10 * 60_000); reset();
ok((await on(call("/jobs", { body: { kind: "tts" } }))) === "modal", "Colab off: the job falls back to Modal");
ok(modal.hits[0] === "GET /health", "a sleeping Modal is woken (/health) before the job");
const mjob = modal.jobs.at(-1)!;
// 3. that job's progress goes to Modal; a Colab job's to Colab
ok((await on(call(`/jobs/${mjob}`))) === "modal", "a Modal job's progress is asked of Modal");
await beat("colab");
ok((await on(call(`/jobs/${colab.jobs[0]}`))) === "colab", "a Colab job's progress is asked of Colab");
// 4. the job list merges both while both are up
const list = (await call<{ jobs: { id: string }[] }>("/jobs")).jobs.map((j) => j.id);
ok(list.includes(mjob) && list.includes(colab.jobs[0]), "the job list has both GPUs' jobs");
// 5. Modal first, Modal asleep, Colab on: a read never wakes Modal; work does
await prefs({ prefer: "modal" }); await beat("modal", 10 * 60_000); reset();
ok((await on(call("/voices"))) === "colab" && !modal.hits.length, "a read with Modal asleep goes to Colab and never wakes Modal");
ok((await on(call("/jobs", { body: { kind: "tts" } }))) === "modal", "Modal first: a job wakes Modal");
// 6. Modal unreachable: falls back to Colab
modal.down = true; await beat("modal", 10 * 60_000);
const t0 = Date.now();
ok((await on(call("/engines/qwen/load", { body: {} }).catch((e) => ({ on: `ERR ${(e as Error).message}` })))) === "colab", "Modal down: the work falls back to Colab");
console.log(`     (took ${Math.round((Date.now() - t0) / 1000)} s)`);
modal.down = false;
// 7. no fallback: Modal down means an error, not Colab
await prefs({ prefer: "colab", fallback: false }); await beat("colab", 10 * 60_000); reset();
const e7 = await call("/jobs", { body: { kind: "tts" } }).then(() => "sent", (e) => (e as Error).message);
ok(/Colab is off/.test(e7) && !modal.hits.length, "fallback off: Colab off is an error, Modal untouched");
// 8. heavy jobs stay off Modal unless allowed
await prefs({ prefer: "colab" });
const e8 = await call("/jobs", { body: { kind: "train" } }).then(() => "sent", (e) => (e as Error).message);
ok(/Colab is off/.test(e8), "training never goes to Modal by default");
await prefs({ prefer: "colab", modal_heavy: true });
ok((await on(call("/jobs", { body: { kind: "train" } }))) === "modal", "with modal_heavy on, training can go to Modal");
// 9. the monthly cap
await prefs({ prefer: "colab", modal_cap_h: 1 }); await beat("modal", 10 * 60_000);
mem.set("voicebox/modal-usage.json", JSON.stringify({ month: new Date().toISOString().slice(0, 7), seconds: 3700 }));
const e9 = await call("/jobs", { body: { kind: "tts" } }).then(() => "sent", (e) => (e as Error).message);
ok(/used its 1 h/.test(e9), "past the monthly cap, Modal takes no new work");
// 10. heartbeats count Modal time
mem.delete("voicebox/modal-usage.json");
const boot = Date.now() / 1000 - 30;
await gp.countModal(boot); await new Promise((r) => setTimeout(r, 1100)); await gp.countModal(boot);
const u = await gp.modalUsage();
ok(u.seconds >= 30 && u.seconds < 40, `Modal heartbeats count its awake time (${u.seconds.toFixed(1)} s)`);
// 11. Modal's own key: the dashboard sends it to Modal (Colab keeps WORKER_SECRET), and worker routes know it
await prefs({ prefer: "colab" }); await beat("colab"); await beat("modal");
const key = await gp.newModalKey("check");
await call("/jobs", { body: { kind: "tts" } });
ok(colab.auth === `Bearer ${process.env.WORKER_SECRET}`, "Colab gets WORKER_SECRET");
await prefs({ prefer: "modal" });
await call("/jobs", { body: { kind: "tts" } });
ok(modal.auth === `Bearer ${key}`, "Modal gets its own key");
const req = (t?: string) => new Request("https://x/api/register", { headers: t ? { authorization: `Bearer ${t}` } : {} });
ok((await gp.workerCaller(req(key))) === "modal" && (await gp.workerCaller(req(process.env.WORKER_SECRET))) === "worker"
  && (await gp.workerCaller(req("vbmd_wrong"))) === null && (await gp.workerCaller(req())) === null, "worker routes tell Modal's key, WORKER_SECRET and anything else apart");
const cmds = gp.setupCommands(key, "https://studio.example");
ok(cmds.length === 4 && cmds.every((c) => !c.includes(process.env.WORKER_SECRET!)) && cmds.filter((c) => c.includes(key)).length === 3, "the setup commands carry Modal's key, never WORKER_SECRET");
const key2 = await gp.newModalKey("check");
ok(key2 !== key && (await gp.workerCaller(req(key))) === null, "a new Modal key retires the old one");
// 12. the test wake: wakes a sleeping Modal even though /health is a read, and says what GPU answered
await beat("modal", 10 * 60_000); reset();
const { testModal } = await import("../lib/worker");
const tm = await testModal();
ok(tm.ok && tm.gpu === "modal" && !tm.was_awake && modal.hits.length >= 2, "Test Modal wakes it and reports its GPU");
// 13. Cerebrium, the second cloud GPU: fallback down the list, its own job notes, its own cap, the shared key
const cere = await fake("cerebrium");
process.env.CEREBRIUM_WORKER_URL = cere.url;
await prefs({ prefer: "colab", fallback: true });
await beat("colab", 10 * 60_000); await beat("modal", 10 * 60_000);
await reg.saveWorker({ url: cere.url, started_at: Date.now() / 1000 - 600, last_seen: Date.now() - 10 * 60_000 }, "cerebrium");
modal.down = true; reset(); cere.hits = [];
ok((await on(call("/jobs", { body: { kind: "tts" } }))) === "cerebrium", "Colab off and Modal down: the job falls to Cerebrium");
ok(cere.auth === `Bearer ${key2}`, "Cerebrium gets the cloud key");
const cjob = cere.jobs.at(-1)!;
ok((await on(call(`/jobs/${cjob}`))) === "cerebrium", "a Cerebrium job's progress is asked of Cerebrium");
modal.down = false;
await prefs({ prefer: "cerebrium" });
await reg.saveWorker({ url: cere.url, started_at: Date.now() / 1000 - 600, last_seen: Date.now() }, "cerebrium");
ok((await on(call("/jobs", { body: { kind: "tts" } }))) === "cerebrium", "Cerebrium first: a job goes to Cerebrium");
await prefs({ prefer: "cerebrium", cerebrium_cap_h: 1 }); await reg.saveWorker({ url: cere.url, last_seen: Date.now() - 10 * 60_000 }, "cerebrium");
mem.set("voicebox/cerebrium-usage.json", JSON.stringify({ month: new Date().toISOString().slice(0, 7), seconds: 3700 }));
await beat("modal");
ok((await on(call("/jobs", { body: { kind: "tts" } }))) !== "cerebrium", "past Cerebrium's cap, the job goes to the next GPU");
ok(gp.URL_RE.cerebrium.test("https://api.cerebrium.ai/v4/p-abc12345/voicebox-worker") && !gp.URL_RE.cerebrium.test("https://api.cerebrium.ai.evil.com/v4/p-abc12345/x")
  && !gp.URL_RE.cerebrium.test("https://evil.com/api.cerebrium.ai/v4/p-abc12345/x"), "Cerebrium addresses: the real form passes, look-alikes don't");
const cc = gp.setupCommands(key2, "https://studio.example", "cerebrium");
ok(cc.length === 4 && cc.some((c) => c.includes("cerebrium deploy")) && !cc.join("").includes(process.env.WORKER_SECRET!), "Cerebrium's setup commands carry the cloud key, never WORKER_SECRET");
// 14. an open dashboard never keeps a cloud GPU awake: status, metrics and the job list never reach an idle one
await prefs({ prefer: "colab", fallback: true });
await beat("colab", 10 * 60_000); await beat("modal");
mem.delete("voicebox/modal-jobs.json"); mem.delete("voicebox/cerebrium-jobs.json");
await reg.saveWorker({ url: cere.url, started_at: Date.now() / 1000 - 600, last_seen: Date.now(), running: 0, queue: 0 }, "cerebrium");
await new Promise((r) => setTimeout(r, 3100)); // job notes are cached 3 s
reset(); cere.hits = [];
for (const p of ["/health", "/metrics", "/jobs"]) await call(p).catch(() => null);
ok(!modal.hits.length && !cere.hits.length, "status, metrics and the job list never reach an awake but idle cloud GPU");
await reg.saveWorker({ url: modal.url, started_at: Date.now() / 1000 - 600, last_seen: Date.now(), running: 1, queue: 0 }, "modal");
reset();
await call("/jobs").catch(() => null);
ok(modal.hits.includes("GET /jobs") && !cere.hits.includes("GET /jobs"), "the job list asks a cloud GPU only while it's busy");
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
