// Checks deploying a cloud GPU from the website (lib/clouddeploy.ts) against a fake GitHub and an in-memory bucket:
// tokens checked and sealed (only the last 4 shown), Deploy starts the workflow with the deploy id, the id is turned
// in once for the keys, the report lands, and the GitHub-only routes refuse anything without GitHub's token.
//   npx -y tsx scripts/check-clouddeploy.mts
import http from "node:http";
const mem = new Map<string, string>();
const obj = (key: string, v: string) => ({ key, size: v.length, etag: "e", httpEtag: '"e"', uploaded: new Date(), httpMetadata: {}, body: new Response(v).body });
(globalThis as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] = { env: { BUCKET: {
  get: async (k: string) => (mem.has(k) ? obj(k, mem.get(k)!) : null), head: async (k: string) => (mem.has(k) ? obj(k, mem.get(k)!) : null),
  put: async (k: string, v: unknown) => { mem.set(k, typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array)); },
  delete: async () => {}, list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }) } } };
process.env.WORKER_SECRET = "w".repeat(32); process.env.MCP_TOKEN = "m".repeat(32); process.env.GITHUB_AGENT_TOKEN = "ghp_fake";
const dispatched: { url: string; body: string; auth: string }[] = [];
const gh = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)).on("end", () => { dispatched.push({ url: req.url!, body: b, auth: String(req.headers.authorization) }); res.statusCode = 204; res.end(); }); });
await new Promise<void>((ok) => gh.listen(0, "127.0.0.1", () => ok()));
process.env.GITHUB_API_URL = `http://127.0.0.1:${(gh.address() as { port: number }).port}`;
const cd = await import("../lib/clouddeploy");
let fails = 0;
const ok = (c: boolean, what: string) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) fails++; };
const throws = async (f: () => Promise<unknown>) => f().then(() => false, () => true);

ok(await throws(() => cd.setTokens("modal", { token_id: "nope", token_secret: "as-12345678" }, "t")), "a Modal token id that isn't ak-… is refused");
ok(await throws(() => cd.setTokens("cerebrium", { token: "x".repeat(30), project: "proj" }, "t")), "a Cerebrium project id that isn't p-… is refused");
await cd.setTokens("modal", { token_id: "ak-abcdefgh1234", token_secret: "as-secretsecret9876" }, "Sparsh");
const st = await cd.tokensStatus();
ok(st.modal.saved && st.modal.last4 === "9876" && !JSON.stringify(st).includes("secretsecret"), "saved tokens show only their last 4 characters");
ok(!JSON.stringify([...mem.values()]).includes("as-secretsecret9876"), "the token is stored sealed, never in the clear");
ok(await throws(() => cd.startDeploy("cerebrium", "t")), "Deploy refuses a cloud whose tokens aren't saved");
const d = await cd.startDeploy("modal", "Sparsh");
const call = dispatched.at(-1)!;
ok(/\/actions\/workflows\/gpu-deploy\.yml\/dispatches$/.test(call.url) && JSON.parse(call.body).inputs.deploy === d.id && JSON.parse(call.body).ref === "main"
  && call.auth === "Bearer ghp_fake", "Deploy starts gpu-deploy.yml on main with the deploy id and the GitHub key");
ok(!call.body.includes("as-secret"), "the tokens never go to GitHub with the start");
const k1 = await cd.deployKeys("modal", d.id, "https://studio.example");
ok(!!k1 && k1.modal_token_secret === "as-secretsecret9876" && !!k1.cloud_key && k1.register_url === "https://studio.example/api/register", "the run turns the deploy id in for the keys");
ok((await cd.deployKeys("modal", d.id, "https://studio.example")) === null, "the deploy id works only once");
ok((await cd.deployKeys("cerebrium", d.id, "https://studio.example")) === null, "a deploy id is only for its own cloud");
await cd.deployReport(d.id, { ok: true, url: "https://x--voicebox-worker-gateway.us-east.modal.run", run_url: "https://github.com/run/1" });
const row = (await cd.listDeploys()).find((x) => x.id === d.id)!;
ok(row.status === "done" && row.run_url === "https://github.com/run/1", "the run's report marks the deploy done");
ok(!JSON.stringify(await cd.listDeploys()).includes("as-secret"), "the deploy list never carries a token");
const keysRoute = await import("../app/api/gpus/deploy-keys/route");
const reportRoute = await import("../app/api/gpus/deploy-report/route");
const post = (r: { POST: (q: Request) => Promise<Response> }, auth?: string) =>
  r.POST(new Request("https://x/api/gpus/deploy-keys", { method: "POST", headers: auth ? { authorization: auth } : {}, body: JSON.stringify({ cloud: "modal", deploy: d.id }) }));
ok((await post(keysRoute)).status === 401 && (await post(keysRoute, "Bearer " + process.env.WORKER_SECRET)).status === 401
  && (await post(keysRoute, "Bearer a.b.c")).status === 401, "deploy-keys refuses anything but GitHub's token (even WORKER_SECRET)");
ok((await post(reportRoute)).status === 401 && (await post(reportRoute, "Bearer a.b.c")).status === 401, "deploy-report refuses anything but GitHub's token");
gh.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
