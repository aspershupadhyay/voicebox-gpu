// The automation suite's MCP tools (docs/AUTOMATION.md). Few tools, each with an action enum and a worked example;
// short answers; every error says the next step. Registered beside lib/mcptools.ts on the guarded server (wrap.ts).
import { z } from "zod";
import type { ToolServer } from "../mcptools";
import type { Change } from "./repo";
import { ASK_FIRST, ASK_KEYS, getApproval, getControl, listApprovals, readLog, requestApproval, stopAll, unitsToday, type AskKey } from "./control";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ ...text(`ERROR: ${(e as Error).message}`), isError: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (t?: number) => (t ? new Date(t).toISOString().slice(0, 16) + "Z" : undefined);
type Ctx = { http?: { req?: Request } } | undefined;
const modelName = async (ctx: Ctx) => (await import("./wrap")).modelOf(ctx as never);

export function registerAutoTools(server: ToolServer) {
  server.registerTool(
    "approvals",
    {
      title: "Approvals (the owner's go-ahead)",
      description: [
        "Risky actions wait for the owner's click in Settings → Automation: publishing now, deleting, changing publishing rules, spending past the day's units cap, merging a PR, pushing to a protected branch, adding a repo.",
        "A gated tool asks by itself and answers NEEDS APPROVAL (id …): then call this with action wait and that id (waits up to 45 s a call; call again while it's pending), and once approved repeat the exact same call with approval_id.",
        "action list (default): pending and recent requests. check: one request. request: ask ahead for something a later step needs (action_key + summary). Example: {\"action\":\"wait\",\"id\":\"3f9a0c1b2d\"}.",
      ].join(" "),
      inputSchema: z.object({
        action: z.enum(["list", "check", "wait", "request"]).optional(),
        id: z.string().regex(/^[a-f0-9]{10}$/).optional(),
        action_key: z.enum(ASK_KEYS as [AskKey, ...AskKey[]]).optional().describe("request: what it's for"),
        summary: z.string().min(5).max(400).optional().describe("request: one line the owner reads"),
        seconds: z.number().int().min(1).max(45).optional(),
      }),
    },
    async ({ action = "list", id, action_key, summary, seconds }, ctx) => {
      try {
        const view = (a: Awaited<ReturnType<typeof getApproval>>) => a && ({ id: a.id, status: a.status, what: ASK_FIRST[a.action], summary: a.summary, by: a.by, asked: iso(a.created), decided: iso(a.decided), note: a.note });
        if (action === "request") {
          if (!action_key || !summary) throw new Error("request needs action_key and summary");
          const a = await requestApproval({ action: action_key, summary, by: await modelName(ctx as Ctx) });
          return text({ ...view(a), next: `The owner has been asked. Call approvals action=wait id=${a.id}.` });
        }
        if (action === "check" || action === "wait") {
          if (!id) throw new Error(`${action} needs id`);
          const until = Date.now() + (action === "wait" ? (seconds ?? 45) * 1000 : 0);
          let a = await getApproval(id);
          while (a?.status === "pending" && Date.now() < until) { await sleep(3000); a = await getApproval(id); }
          if (!a) throw new Error("no such request: list shows the recent ones");
          const next = a.status === "approved" ? `Approved: repeat the call with approval_id "${a.id}".` : a.status === "pending" ? `Still waiting on the owner: call wait again.` : a.status === "denied" ? "Denied: don't do it; tell the user, with the owner's note if any." : `It's ${a.status}: ask afresh if it's still needed.`;
          return text({ ...view(a), next });
        }
        const all = await listApprovals();
        return text({ pending: all.filter((a) => a.status === "pending").map(view), recent: all.filter((a) => a.status !== "pending").slice(0, 10).map(view) });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "control",
    {
      title: "Control: budget, call log, kill switch",
      description: [
        "action status (default): whether automation is running or paused, today's Colab units spent against the owner's daily cap, what asks first, the repo allow-list.",
        "activity: the call log, newest first: every MCP call with the model that made it, the tool, trimmed inputs, ok or the error, time taken, the job it started (filters: model, tool, hours, limit).",
        "stop_all: the kill switch, for when something runs away: pauses every model and automation, cancels every queued and running job, stops the GPU. Only the owner resumes (Settings → Automation).",
        "Example: {\"action\":\"activity\",\"model\":\"gemini\",\"hours\":24}.",
      ].join(" "),
      inputSchema: z.object({
        action: z.enum(["status", "activity", "stop_all"]).optional(),
        model: z.string().max(60).optional(), tool: z.string().max(60).optional(),
        hours: z.number().min(1).max(24 * 31).optional(), limit: z.number().int().min(1).max(200).optional(),
        reason: z.string().max(200).optional().describe("stop_all: why, shown to the owner"),
      }),
    },
    async ({ action = "status", model, tool, hours, limit, reason }, ctx) => {
      try {
        if (action === "stop_all") {
          const who = await modelName(ctx as Ctx);
          return text({ ...(await stopAll(who, reason ?? `stop_all by ${who}`)), next: "Everything is stopped. Tell the user; only the owner can resume it (Settings → Automation)." });
        }
        if (action === "activity") {
          const since = hours ? Date.now() - hours * 3600_000 : undefined;
          const list = await readLog({ limit: limit ?? 30, model, tool, since, days: Math.ceil((hours ?? 48) / 24) });
          return text(list.map((e) => ({ at: iso(e.t), model: e.model, tool: e.tool, ok: e.ok, ms: e.ms, ...(e.err ? { err: e.err.slice(0, 160) } : {}), ...(e.job ? { job: e.job } : {}), ...(e.via ? { via: e.via } : {}), args: e.args })));
        }
        const [c, u] = await Promise.all([getControl(), unitsToday()]);
        return text({
          state: c.paused ? `PAUSED since ${iso(c.paused_at)} by ${c.paused_by} (${c.pause_reason})` : "running",
          units_today: { spent: u.spent, cap: c.cap_units || "no cap", balance: u.balance, ...(u.spent == null ? { note: "Colab isn't connected, so spending can't be counted" } : {}) },
          asks_first: c.ask_first.map((k) => ASK_FIRST[k]), repos: c.repos,
        });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "run",
    {
      title: "Run code on the Colab worker (sandbox)",
      description: [
        "Python (default), Node or Bash in a private workspace on the Colab worker (the L4: GPU, ffmpeg, pip): its own Linux user, no secrets, no way into the worker, a time limit (timeout_s, default 120, up to 1800) and a memory limit (memory_mb, default 8000).",
        "Code mode (on by default): `import voicebox as vb` calls any VoiceBox tool from the script, vb.<tool>(**args) (vb.tools(\"keyword\") lists them), so filter and loop in code and print only what matters: it saves tokens. Gated calls still wait for the owner.",
        "files: Files ids (m:…, g:…) or links, fetched into in/ first. Anything the code writes to out/ is saved to Files (folder save_to, default \"Workbench\"; null to keep it in the workspace only). The workspace (default \"default\", or a name per project) keeps its files between runs while the runtime is on; pip install --user works.",
        "Waits up to 45 s; a longer run returns its job id for get_job. Example: {\"code\":\"import voicebox as vb\\nposts = vb.workspace_board()\\nprint(len(posts))\"}.",
      ].join(" "),
      inputSchema: z.object({
        code: z.string().min(1).max(200_000),
        lang: z.enum(["python", "node", "bash"]).optional(),
        workspace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
        files: z.array(z.string().max(2000)).max(20).optional().describe("Files ids (m:…, g:…) or https links, fetched into in/"),
        args: z.array(z.string().max(500)).max(20).optional(),
        timeout_s: z.number().int().min(5).max(1800).optional(), memory_mb: z.number().int().min(256).max(48_000).optional(),
        voicebox: z.boolean().optional().describe("code mode: import voicebox (default true)"),
        save_to: z.string().max(200).nullable().optional().describe("folder for out/ files (default Workbench); null keeps them in the workspace"),
      }),
    },
    async ({ code, lang, workspace, files, args, timeout_s, memory_mb, voicebox, save_to }, ctx) => {
      try {
        const b = await import("./bench");
        const model = await modelName(ctx as Ctx);
        const t = timeout_s ?? 120;
        const origin = (await import("../colab")).appOrigin(ctx && (ctx as Ctx)?.http?.req ? new URL((ctx as Ctx)!.http!.req!.url).origin : undefined);
        const inputs = await Promise.all((files ?? []).map((f) => b.inputFile(f)));
        const job = await b.submit({ op: "run", code, lang, workspace, files: inputs, args, timeout_s: t, memory_mb,
          ...(voicebox === false ? {} : { voicebox_url: `${origin}/api/mcp`, voicebox_key: b.runKey(model, t), voicebox_model: model }) },
          { model, folder: save_to === undefined ? undefined : save_to });
        return text(await b.view(await b.wait(job.id, 45), { name: model }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "playbook",
    {
      title: "The playbook: the studio's rules and know-how",
      description: [
        "Read before working: how this studio wants things done (CLAUDE.md, the owner's feedback, the design rules, the automation plan, publishing, Radar, the API), by section, so you read only what the task needs.",
        "action search (default): the sections that match a few words, with a snippet. read: one doc (doc id), or one section of it (section: words from its title, or its number), in parts of 12k characters. index: every doc and its section titles.",
        "Example: {\"query\":\"instagram carousel slide shape\"} then {\"action\":\"read\",\"doc\":\"feedback\",\"section\":\"square and portrait\"}. The owner's feedback (doc feedback) wins over older rules.",
      ].join(" "),
      inputSchema: z.object({
        action: z.enum(["search", "read", "index"]).optional(),
        query: z.string().max(200).optional(), doc: z.string().max(60).optional(), section: z.string().max(120).optional(),
        part: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ action, query, doc, section, part }) => {
      try {
        const pb = await import("./playbook");
        const act = action ?? (doc ? "read" : query ? "search" : "index");
        if (act === "index") return text(pb.index());
        if (act === "read") { if (!doc) throw new Error("read needs doc (index lists them)"); return text(pb.read(doc, section, part)); }
        if (!query) throw new Error("search needs query");
        const hits = pb.search(query);
        return text(hits.length ? { hits, next: "read the best one: action read, doc, section" } : { hits, next: "nothing matched: try other words, or action index" });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "repo",
    {
      title: "Repos: read, branch, commit, PR, CI, merge",
      description: [
        "Work on the GitHub repos the owner allowed (list shows them), through VoiceBox's key, which you never see. Work on a branch and open a PR: the default branch (main) is never written by a model; a protected branch, a merge and adding a repo wait for the owner's approval (a merge on the studio's own repo always does).",
        "Actions: list; tree (files, path to narrow); read (path, from/to lines); branch (branch, from); commit (branch, files [{path, content} or {path, delete: true}], message: one commit, the branch made if new); pr (branch, title, body); status (pr: state, mergeable, every check, the end of a failed check's log); comment (pr, body); merge (pr, green only); allow (ask the owner to add a repo).",
        "To run tests: checkout clones it into a run workspace (workspace, dir default the repo name); then run code there (cd <dir>; pytest...), edit files there, and push commits the workspace's changes to branch. Example: {\"action\":\"commit\",\"repo\":\"aspershupadhyay/voicebox-workbench\",\"branch\":\"reel-cutter\",\"files\":[{\"path\":\"cut.py\",\"content\":\"...\"}],\"message\":\"Add the reel cutter\"}.",
      ].join(" "),
      inputSchema: z.object({
        action: z.enum(["list", "tree", "read", "branch", "commit", "pr", "status", "comment", "merge", "allow", "checkout", "push"]),
        repo: z.string().max(140).optional().describe("owner/name"),
        path: z.string().max(400).optional(), ref: z.string().max(100).optional(), from: z.union([z.number().int().min(1), z.string().max(100)]).optional(), to: z.number().int().min(1).optional(),
        branch: z.string().max(100).optional(),
        files: z.array(z.object({ path: z.string().min(1).max(400), content: z.string().max(2_000_000).optional(), delete: z.boolean().optional() })).max(300).optional(),
        message: z.string().max(2000).optional(), title: z.string().max(250).optional(), body: z.string().max(20_000).optional(),
        pr: z.number().int().min(1).optional(), method: z.enum(["merge", "squash", "rebase"]).optional(),
        workspace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(), dir: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/).optional(), fresh: z.boolean().optional(),
      }),
    },
    async (a, ctx) => {
      try {
        const r = await import("./repo");
        const model = await modelName(ctx as Ctx);
        if (a.action === "list") {
          const c = await getControl();
          return text({ repos: c.repos, platform: r.PLATFORM, key: process.env.GITHUB_AGENT_TOKEN ? "set" : "not set yet (the owner adds GITHUB_AGENT_TOKEN on Vercel)", rules: "branches and PRs only; merges and new repos wait for the owner" });
        }
        if (!a.repo) throw new Error(`${a.action} needs repo (owner/name)`);
        if (a.action === "allow") {
          const name = a.repo.trim().toLowerCase();
          if (!/^[a-z0-9_.-]{1,39}\/[a-z0-9_.-]{1,100}$/.test(name)) throw new Error("repo: owner/name");
          const c = await getControl();
          const { setControl } = await import("./control");
          await setControl({ repos: [...c.repos, name] }, model);
          return text({ allowed: name, repos: [...new Set([...c.repos, name])] });
        }
        const repo = await r.allowed(a.repo);
        const need = (k: keyof typeof a) => { if (a[k] == null || a[k] === "") throw new Error(`${a.action} needs ${String(k)}`); return a[k]; };
        switch (a.action) {
          case "tree": return text(await r.tree(repo, a.ref, a.path));
          case "read": return text(await r.read(repo, need("path") as string, a.ref, typeof a.from === "number" ? a.from : undefined, a.to));
          case "branch": return text(await r.branch(repo, need("branch") as string, typeof a.from === "string" ? a.from : undefined));
          case "commit": return text({ ...(await r.commit(repo, need("branch") as string, need("files") as Change[], (a.message ?? "Update from VoiceBox") as string, model)), next: "open a PR with action pr when it's ready" });
          case "pr": return text({ ...(await r.openPr(repo, need("branch") as string, need("title") as string, a.body ?? "", model)), next: "follow its CI with action status" });
          case "status": return text(await r.status(repo, need("pr") as number));
          case "comment": return text(await r.comment(repo, need("pr") as number, need("body") as string, model));
          case "merge": return text(await r.merge(repo, need("pr") as number, a.method));
          case "checkout": {
            const b = await import("./bench");
            const spec = await r.cloneSpec(repo, a.ref);
            const dir = a.dir ?? repo.split("/")[1];
            const job = await b.submit({ op: "clone", workspace: a.workspace ?? "default", dir, url: spec.url, ref: spec.ref, header: spec.header, fresh: a.fresh }, { model, folder: null, label: `clone ${repo}` });
            const done = await b.wait(job.id, 45);
            if (done.status === "error") throw new Error(done.error ?? "clone failed");
            return text({ job_id: done.id, status: done.status, workspace: a.workspace ?? "default", dir, head: done.bench.head, next: done.status === "done" ? `run code with workspace "${a.workspace ?? "default"}" (cd ${dir}); push commits the changes` : "get_job until it's done" });
          }
          case "push": {
            const b = await import("./bench");
            const dir = a.dir ?? repo.split("/")[1];
            const job = await b.submit({ op: "diff", workspace: a.workspace ?? "default", dir }, { model, folder: null, label: `changes in ${dir}` });
            const done = await b.wait(job.id, 45) as Awaited<ReturnType<typeof b.wait>> & { bench: { changes?: Change[] } };
            if (done.status !== "done") throw new Error(done.error ?? `reading the changes is ${done.status}: try again`);
            const changes = done.bench.changes ?? [];
            if (!changes.length) return text({ pushed: false, note: "no changes in the workspace's clone" });
            return text({ ...(await r.commit(repo, need("branch") as string, changes, (a.message ?? "Changes from the workbench") as string, model)), next: "open a PR with action pr" });
          }
        }
        throw new Error("unknown action");
      } catch (e) { return fail(e); }
    },
  );
}
