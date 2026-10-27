// /api/dash/publish/... (behind the dashboard's own sign-in, see app/api/dash/[...path]/route.ts):
//   GET    publish                         accounts, plans, rules, which networks are set up
//   GET    publish/<post>/<space>          one plan + what's stopping it (and nudges an unfinished run along)
//   GET    publish/playlists/<account>     a channel's playlists        GET publish/limit/<account>  Instagram's posts left today
//   POST   publish/<post>/<space>          edit the plan (account, files, cover, when, yt / ig options)
//   POST   publish/<post>/<space>/go       { mode: "now" | "arm" | "disarm" }   …/cancel   …/retry
//   POST   publish/rules                   automation rules                     DELETE publish/accounts/<id>  disconnect
//   DELETE publish/<post>/<space>          forget the plan
import { after } from "next/server";
import { getPost } from "../appwrite";
import { currentUser } from "../session";
import { spaceOf, type SpaceId } from "../spaces";
import { configured, getAccount, listAccounts, removeAccount } from "./accounts";
import * as IG from "./instagram";
import { dropPlan, editPlan, getPlan, getRules, listPlans, putPlan, setRules } from "./plans";
import { drive, readiness, sweep } from "./run";
import { BUSY, networkOf } from "./shared";
import * as YT from "./youtube";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const who = async () => (await currentUser())?.name ?? "Claude (MCP)";
const LOCK_MS = 290_000;

/** An unfinished run with nobody driving it (the last one stopped at its time limit): carry on, after the response. */
function nudge(p: { post: string; space: string; state: string; run: { lock?: number | null } | null }) {
  if (BUSY.includes(p.state as never) && (!p.run?.lock || Date.now() - p.run.lock > LOCK_MS)) after(() => drive(p.post, p.space, 280_000).then(() => null));
}

export async function publishGet(path: string[]) {
  const [b, c] = path;
  if (!b) {
    const [accounts, plans, rules] = await Promise.all([listAccounts(), listPlans(), getRules()]);
    plans.filter((p) => BUSY.includes(p.state)).forEach(nudge);
    return Response.json({ accounts, plans, rules, configured: { youtube: configured("youtube"), instagram: configured("instagram") } });
  }
  if (b === "playlists" && c && ID.test(c)) {
    const a = await getAccount(c);
    if (!a || a.network !== "youtube") return bad("not a YouTube channel", 404);
    return Response.json({ playlists: await YT.playlists(await YT.accessToken(a)) });
  }
  if (b === "limit" && c && ID.test(c)) {
    const a = await getAccount(c);
    if (!a || a.network !== "instagram") return bad("not an Instagram account", 404);
    return Response.json(await IG.publishingLimit(await IG.accessToken(a), a.id));
  }
  if (b && c && ID.test(b) && spaceOf(c)) {
    const p = await getPlan(b, c);
    if (!p) return Response.json({ plan: null, problems: [] });
    nudge(p);
    return Response.json({ plan: p, problems: await readiness(p) });
  }
  return bad("not found", 404);
}

export async function publishPost(path: string[], body: Record<string, unknown>) {
  const [b, c, d] = path;
  if (b === "rules") return Response.json({ rules: await setRules(body.rules as never ?? body) });
  if (b === "sweep") return Response.json(await sweep(240_000)); // run the autopilot now
  if (!b || !c || !ID.test(b) || !spaceOf(c)) return bad("not found", 404);
  if (!networkOf(c)) return bad(`Voicebox can't post to ${c} by itself yet; use the hand-off (copy and download).`);
  const cur = await getPlan(b, c);
  if (!d) {
    if (cur && BUSY.includes(cur.state)) return bad("It's going out right now. Stop it first to change it.", 409);
    const post = await getPost(b);
    const next = editPlan(cur, b, c as SpaceId, body, await who(), await getRules(), { title: post.title, caption: post.caption ?? "" });
    // a finished or failed plan you edit goes back to waiting for you
    if (next.state === "published" || next.state === "canceled" || next.state === "failed") { if (body.reset) { next.state = "draft"; next.run = null; next.result = null; next.attempts = 0; next.error = null; next.progress = 0; next.step = null; } }
    await putPlan(next);
    return Response.json({ plan: next, problems: await readiness(next) });
  }
  if (!cur) return bad("Set it up first", 404);
  if (d === "go") {
    const mode = String(body.mode ?? "now");
    if (mode === "disarm") {
      if (cur.state !== "armed") return bad("It isn't set to go");
      cur.state = "draft"; cur.step = null;
      cur.log.push({ at: Date.now(), text: `Taken off autopilot by ${await who()}` });
      return Response.json({ plan: await putPlan(cur), problems: [] });
    }
    if (BUSY.includes(cur.state)) return Response.json({ plan: cur, problems: [] });
    if (cur.state === "published" && !body.again) return bad("It's already live. Pass again: true to post it a second time.", 409);
    const problems = await readiness(cur);
    if (problems.length) return Response.json({ error: problems[0], problems }, { status: 422 });
    if (cur.state === "published") { cur.run = null; cur.result = null; }
    cur.attempts = 0; cur.error = null; cur.next_try = null; cur.progress = 0;
    if (mode === "arm") {
      cur.when = "scheduled"; cur.state = "armed"; cur.step = null;
      cur.log.push({ at: Date.now(), text: `Set to go automatically by ${await who()}` });
      return Response.json({ plan: await putPlan(cur), problems: [] });
    }
    cur.when = "now"; cur.state = "queued"; cur.step = "Starting"; cur.run = null;
    cur.log.push({ at: Date.now(), text: `Publish now, by ${await who()}` });
    await putPlan(cur);
    after(() => drive(b, c, 280_000).then(() => null));
    return Response.json({ plan: cur, problems: [] }, { status: 202 });
  }
  if (d === "cancel") {
    if (cur.state === "published") return bad("It's already live; delete it on the platform itself.", 409);
    cur.state = "canceled"; cur.step = null; cur.next_try = null; cur.run = cur.run ? { ...cur.run, lock: null } : null;
    cur.log.push({ at: Date.now(), text: `Stopped by ${await who()}` });
    return Response.json({ plan: await putPlan(cur) });
  }
  if (d === "retry") {
    if (!["failed", "canceled"].includes(cur.state)) return bad("Nothing to retry");
    cur.state = "queued"; cur.error = null; cur.next_try = null; cur.step = "Starting";
    cur.log.push({ at: Date.now(), text: `Retry, by ${await who()}` });
    await putPlan(cur);
    after(() => drive(b, c, 280_000).then(() => null));
    return Response.json({ plan: cur }, { status: 202 });
  }
  return bad("not found", 404);
}

export async function publishDelete(path: string[]) {
  const [b, c] = path;
  if (b === "accounts" && c && ID.test(c)) {
    const a = await removeAccount(c);
    if (!a) return bad("not connected", 404);
    // plans on it go back to waiting for an account
    for (const p of (await listPlans()).filter((x) => x.account === c && !BUSY.includes(x.state) && x.state !== "published")) {
      p.account = null; if (p.state === "armed") p.state = "draft";
      p.log.push({ at: Date.now(), text: `${a.name} was disconnected` });
      await putPlan(p);
    }
    return Response.json({ ok: true });
  }
  if (b && c && ID.test(b) && spaceOf(c)) {
    const p = await getPlan(b, c);
    if (p && BUSY.includes(p.state)) return bad("It's going out right now. Stop it first.", 409);
    await dropPlan(b, c);
    return Response.json({ ok: true });
  }
  return bad("not found", 404);
}
