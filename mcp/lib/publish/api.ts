// /api/dash/publish/... (behind the dashboard's own sign-in, see app/api/dash/[...path]/route.ts):
//   GET    publish                         accounts, plans, rules, which networks are set up
//   GET    publish/<post>/<space>          one plan + what's stopping it (and nudges an unfinished run along)
//   GET    publish/playlists/<account>     a channel's playlists        GET publish/limit/<account>  Instagram's posts left today
//   POST   publish/<post>/<space>          edit the plan (account, files, cover, when, yt / ig options)
//   POST   publish/<post>/<space>/go       { mode: "now" | "arm" | "disarm" }   …/cancel   …/retry
//   POST   publish/rules                   automation rules                     DELETE publish/accounts/<id>  disconnect
//   DELETE publish/<post>/<space>          forget the plan
//   GET    publish/autodm                  Auto-DM (lib/publish/autodm.ts): settings, automations, setup, 30-day numbers
//   GET    publish/autodm/media/<account>?after=   the account's posts and reels, a page at a time   …/autodm/posts  studio posts
//   GET    publish/autodm/activity?automation&account&status&q&before   …/autodm/contacts?account&q
//   POST   publish/autodm { on?, paused?, defaults? }   …/autodm/automation { automation }   …/autodm/delete|switch|order { ids, on? }
//   POST   publish/autodm/subscribe { account? }        …/autodm/test { text, media?, kind?, account?, automation? }
//   GET    publish/autodm/leads?account&q&automation   …/autodm/insights?days   …/autodm/suggest?account   …/autodm/comments?status&q
//   POST   publish/autodm/comment { id, action: hide|unhide|delete|dismiss }   …/autodm/report (make it now)
//   POST   publish/autodm/sync { what: test|all }   …/autodm/suggest { items }   …/autodm/ai { automation, question }
import { captionFor } from "../captions";
import { after } from "next/server";
import { getPost } from "../data";
import { currentUser } from "../session";
import { spaceOf, type SpaceId } from "../spaces";
import { configured, getAccount, listAccounts, removeAccount } from "./accounts";
import * as IG from "./instagram";
import { dropPlan, editPlan, getPlan, getRules, listPlans, putPlan, setRules } from "./plans";
import { AFTER_MS, drive, liveTwin, lockHeld, readiness, sweep } from "./run";
import { BUSY, networkOf, type Plan } from "./shared";
import * as YT from "./youtube";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const who = async () => (await currentUser())?.name ?? "Claude (MCP)";

/** An unfinished run with nobody driving it (the last one stopped at its time limit): carry on, after the response
 * (AFTER_MS: Cloudflare stops after() work 30 s after the response; the minute timer carries on from there). */
function nudge(p: Plan) {
  if (BUSY.includes(p.state) && !lockHeld(p)) after(() => drive(p.post, p.space, AFTER_MS).then(() => null));
}

export async function publishGet(path: string[], query?: URLSearchParams) {
  const [b, c] = path;
  if (b === "autodm") {
    const dm = await import("./autodm");
    const q = (k: string) => { const v = query?.get(k); return v ? v.slice(0, 100) : undefined; };
    if (!c) return Response.json(await dm.overview());
    if (c === "media" && path[2] && ID.test(path[2])) return Response.json(await dm.recentMedia(path[2], q("after")));
    if (c === "posts") return Response.json({ posts: await dm.studioPosts() });
    const kind = ["comment", "dm", "story", "mention", "ai"].includes(q("kind") ?? "") ? q("kind") : undefined;
    if (c === "activity") return Response.json({ events: await dm.activity({ automation: q("automation"), account: q("account"), status: q("status"), kind, q: q("q"), before: Number(q("before")) || undefined }) });
    if (c === "contacts") return Response.json({ contacts: await dm.contacts({ account: q("account"), q: q("q") }) });
    if (c === "leads") return Response.json({ leads: await dm.leads({ account: q("account"), q: q("q"), automation: q("automation") }) });
    const more = await import("./autodm-more");
    if (c === "insights") return Response.json(await more.insights(Number(q("days")) || 30));
    if (c === "suggest") return Response.json({ suggestions: await more.suggest(q("account")) });
    if (c === "comments") return Response.json({ events: await dm.activity({ kind: "mod", status: q("status"), q: q("q"), before: Number(q("before")) || undefined }) });
    return bad("not found", 404);
  }
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
  if (b === "autodm") {
    const dm = await import("./autodm");
    const ids = (v: unknown) => (Array.isArray(v) ? v : []).map(String).filter((x) => ID.test(x)).slice(0, 1000);
    try {
      if (!c) return Response.json({ settings: await dm.setGeneral(body, await who()) });
      if (c === "automation") return Response.json(await dm.saveAutomation((body.automation ?? body) as Record<string, unknown>, await who()));
      if (c === "delete") return Response.json({ deleted: await dm.removeAutomations(ids(body.ids)) });
      if (c === "switch") return Response.json({ changed: await dm.switchAutomations(ids(body.ids), body.on === true) });
      if (c === "order") return Response.json({ moved: await dm.reorder(ids(body.ids)) });
      if (c === "subscribe") return Response.json({ results: await dm.subscribe(typeof body.account === "string" && ID.test(body.account) ? body.account : undefined) });
      const more = await import("./autodm-more");
      if (c === "comment") {
        const action = ["hide", "unhide", "delete", "dismiss"].includes(String(body.action)) ? body.action as "hide" : null;
        if (!action || !Number.isSafeInteger(Number(body.id))) return bad("Give the comment's id and an action: hide, unhide, delete or dismiss");
        return Response.json(await more.modAct(Number(body.id), action));
      }
      if (c === "report") return Response.json({ report: await more.weekly() });
      if (c === "sync") return Response.json(await more.syncNow(body.what === "all" ? "all" : "test"));
      if (c === "suggest") return Response.json({ created: await more.createSuggested(Array.isArray(body.items) ? body.items : [], await who()) });
      if (c === "ai") return Response.json(await more.aiTest(String(body.automation ?? ""), String(body.question ?? "").slice(0, 1000)));
      if (c === "test") return Response.json(await dm.test(String(body.text ?? "").slice(0, 500), { account: typeof body.account === "string" ? body.account : null, media: typeof body.media === "string" ? body.media : null, kind: body.kind === "dm" || body.kind === "story" ? body.kind : "comment", automation: body.automation && typeof body.automation === "object" ? body.automation as Record<string, unknown> : undefined }));
    } catch (e) { return bad((e as Error).message); }
    return bad("not found", 404);
  }
  if (b === "rules") return Response.json({ rules: await setRules(body.rules as never ?? body) });
  if (b === "sweep") return Response.json(await sweep(240_000)); // run the autopilot now
  if (!b || !c || !ID.test(b) || !spaceOf(c)) return bad("not found", 404);
  if (!networkOf(c)) return bad(`Voicebox can't post to ${c} by itself yet; use the hand-off (copy and download).`);
  const cur = await getPlan(b, c);
  if (!d) {
    if (cur && BUSY.includes(cur.state)) return bad("It's going out right now. Stop it first to change it.", 409);
    const post = await getPost(b);
    const next = editPlan(cur, b, c as SpaceId, body, await who(), await getRules(), { title: post.title, caption: (await captionFor(b, c as SpaceId)) ?? post.caption ?? "" });
    // a finished or failed plan you edit goes back to waiting for you
    if (next.state === "published" || next.state === "canceled" || next.state === "failed") { if (body.reset) { next.state = "draft"; next.run = null; next.result = null; next.attempts = 0; next.error = null; next.progress = 0; next.step = null; } }
    await putPlan(next);
    return Response.json({ plan: next, problems: await readiness(next) });
  }
  if (d === "share" && c === "ig_story") {
    // share a live Instagram post or reel to the story, built like the app does it by hand (lib/publish/storycard.ts)
    const plans = await listPlans();
    const from = plans.find((p) => p.post === b && p.network === "instagram" && p.space !== "ig_story" && p.state === "published" && (!body.from || p.space === body.from))
      ?? plans.find((p) => p.post === b && p.network === "instagram" && p.space !== "ig_story" && p.media.length);
    if (!from?.media.length) return bad("Nothing on Instagram to share yet: post it (or set up its Post or Reel) first", 404);
    const post = await getPost(b);
    const { getTargets, setTargets } = await import("../spacestore");
    const { targetsOf } = await import("../spaces");
    const ts = targetsOf(post, await getTargets());
    if (!ts.some((t) => t.space === "ig_story")) await setTargets(b, [...ts, { space: "ig_story", status: "draft" }], { name: await who() });
    if (cur && BUSY.includes(cur.state)) return bad("The story is going out right now", 409);
    if (cur?.state === "published" && !body.again) return bad("This story is already up. Pass again: true to share it once more.", 409);
    const style = ["card", "fit", "fill"].includes(String(body.style)) ? body.style : cur?.ig?.story_style ?? "card";
    const base = cur && ["published", "failed", "canceled"].includes(cur.state) ? { ...cur, state: "draft" as const, run: null, result: null, attempts: 0, error: null, progress: 0, step: null } : cur;
    const next = editPlan(base, b, "ig_story", { account: from.account, media: [from.media[0]], ig: { story_style: style } }, await who(), await getRules(), { title: post.title, caption: "" });
    next.log.push({ at: Date.now(), text: `Shared from ${from.space === "ig_reel" ? "the Reel" : "the post"} by ${await who()}` });
    await putPlan(next);
    if (body.go === "now") return publishPost([b, c, "go"], { mode: "now", again: body.again });
    return Response.json({ plan: next, problems: await readiness(next) });
  }
  if (!cur) return bad("Set it up first", 404);
  if (d === "update") {
    // a video that's already up: send the plan's title, description, tags, privacy… and thumbnail to YouTube again
    if (cur.network !== "youtube" || cur.state !== "published" || !cur.result?.id) return bad("Only a YouTube video that's already up can be updated", 409);
    const acc = cur.account ? await getAccount(cur.account) : null;
    if (!acc) return bad("Its channel was disconnected", 409);
    const token = await YT.accessToken(acc);
    await YT.updateVideo(token, cur.result.id, cur.yt!);
    let thumb = "";
    if (cur.cover) {
      const { jpegUrl, resolve } = await import("./sources");
      const c = await resolve(cur.cover);
      const bytes = new Uint8Array(await (await fetch((c.m ? await jpegUrl(c.m, 1280) : c.url)!, { cache: "no-store" })).arrayBuffer());
      await YT.setThumbnail(token, cur.result.id, bytes, "image/jpeg").then(() => { thumb = " and thumbnail"; }).catch((e) => { thumb = ` (thumbnail not changed: ${(e as Error).message})`; });
    }
    cur.log.push({ at: Date.now(), text: `Updated on YouTube: details${thumb}, by ${await who()}`, ok: true });
    return Response.json({ plan: await putPlan(cur), problems: [] });
  }
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
    // nothing goes out bare: the post package (researched title, description, tags, hashtags, credits) fills what's
    // empty and adds hashtags and the credit where they're missing, whoever set it up (lib/postpack.ts)
    if (c !== "ig_story") {
      await (await import("../postpack")).ensurePack(b, { name: await who() });
      const fresh = await getPlan(b, c);
      if (fresh) Object.assign(cur, fresh);
    }
    const problems = await readiness(cur);
    if (problems.length) return Response.json({ error: problems[0], problems }, { status: 422 });
    const twin = await liveTwin(cur);
    if (twin && !body.again) return Response.json({ error: `These files are already live (${twin.result!.url}). Pass again: true to post them a second time.`, live: twin.result }, { status: 409 });
    if (twin) cur.log.push({ at: Date.now(), text: "Posting again on purpose (the same files are already live)" });
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
    after(() => drive(b, c, AFTER_MS).then(() => null)); // the minute timer carries on from there
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
    after(() => drive(b, c, AFTER_MS).then(() => null)); // the minute timer carries on from there
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
