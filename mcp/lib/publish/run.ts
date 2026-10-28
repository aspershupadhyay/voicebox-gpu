// The publishing runner. drive() moves one plan along as far as the time it's given allows (a big YouTube upload goes
// up 32 MB at a time and the next run picks up at YouTube's offset); sweep() is the autopilot, run every 10 min by
// .github/workflows/sweep.yml: it starts plans whose time has come, carries on unfinished ones, retries failures with
// backoff, refreshes Instagram tokens, gives Scheduled posts without a time the next posting slot, and marks posts live.
import { captionFor } from "../captions";
import { logActivity } from "../appwrite";
import { notify } from "../colab";
import { spaceName, targetsOf, type SpaceId, type Target } from "../spaces";
import { getTargets, setTargets } from "../spacestore";
import { getAccount, listAccounts, type Account, type Tokens } from "./accounts";
import * as IG from "./instagram";
import { getPlan, getRules, listPlans, putPlan } from "./plans";
import { BUSY, networkOf, planProblems, type Plan, type Rules } from "./shared";
import { jpegUrl, range, resolve, sizeOf, type Source } from "./sources";
import * as YT from "./youtube";

const AUTOPILOT = { name: "Voicebox autopilot" };
const LOCK_MS = 290_000;
const YT_LEAD = 6 * 3600_000; // YouTube-scheduled uploads start this long before the publish time
const BACKOFF = [5, 20, 60, 180, 360, 720, 1440, 1440].map((m) => m * 60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Budget extends Error {}
class Stopped extends Error {}
/** Something that must not be retried by itself (the same photos are already live). */
class Hold extends Error {}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
/** Another plan on the same account that already put these exact files live: posting them again would be a repeat. */
export async function liveTwin(p: Pick<Plan, "post" | "space" | "network" | "account" | "media">, plans?: Plan[]) {
  if (!p.media.length) return null;
  return (plans ?? (await listPlans())).find((x) => x.state === "published" && x.result && x.network === p.network && x.account === p.account &&
    !(x.post === p.post && x.space === p.space) && sameSet(x.media, p.media)) ?? null;
}
/** Someone pressed Stop: the stored plan says canceled. Checked between pieces. */
async function checkStop(p: Plan) {
  const fresh = await getPlan(p.post, p.space);
  if (fresh?.state === "canceled") throw new Stopped();
}
const line = (p: Plan, text: string, ok?: boolean) => { p.log.push({ at: Date.now(), text, ...(ok !== undefined ? { ok } : {}) }); };

/** The target this plan is for (its stage and publish time live on the post, see spaces.ts). */
async function targetOf(p: Plan): Promise<Target | null> {
  const map = await getTargets();
  return (map[p.post] ?? []).find((t) => t.space === p.space) ?? null;
}

/** Can a person or the autopilot start it now? */
export async function readiness(p: Plan): Promise<string[]> {
  const kinds: Record<string, "image" | "video" | "other"> = {};
  await Promise.all(p.media.map(async (m) => { kinds[m] = await resolve(m).then((s) => s.kind).catch(() => "other" as const); }));
  const out = planProblems(p, kinds);
  if (p.account) { const a = await getAccount(p.account); if (!a) out.push("That account was disconnected"); else if (a.network !== p.network) out.push("Pick an account on the right network"); }
  return out;
}

/** Move one plan along for up to `budgetMs`. Never throws; failures land on the plan. */
export async function drive(post: string, space: string, budgetMs = 270_000): Promise<Plan | null> {
  const deadline = Date.now() + budgetMs;
  let p = await getPlan(post, space);
  if (!p) return null;
  if (!BUSY.includes(p.state) && !["armed", "failed"].includes(p.state)) return p;
  if (p.run?.lock && Date.now() - p.run.lock < LOCK_MS) return p; // another run has it
  const rules = await getRules();
  p.run = { started: Date.now(), ...(p.run ?? {}), lock: Date.now() };
  if (!BUSY.includes(p.state)) { p.state = "queued"; p.step = "Starting"; p.error = null; line(p, p.attempts ? `Trying again (attempt ${p.attempts + 1})` : "Started"); }
  await putPlan(p);
  try {
    const acc = p.account ? await getAccount(p.account) : null;
    if (!acc) throw new Error("No account picked, or it was disconnected. Connect it under Posts → Autopilot.");
    if (p.network === "youtube") await runYoutube(p, acc, deadline);
    else await runInstagram(p, acc, deadline);
    await finish(p, rules);
  } catch (e) {
    if (e instanceof Stopped) { const fresh = await getPlan(post, space); return fresh; }
    if (e instanceof Hold) { p.state = "failed"; p.error = e.message; p.step = null; p.next_try = null; line(p, e.message, false); p.run = p.run ? { ...p.run, lock: null } : null; return putPlan(p); }
    if (e instanceof Budget) { p.step = p.network === "youtube" ? `Uploading ${Math.round(p.progress * 100)}%` : "Instagram is processing"; line(p, "Paused to stay inside the time limit; carrying on next run"); }
    else await failed(p, e as Error, rules);
  }
  p.run = p.run ? { ...p.run, lock: null } : null;
  return putPlan(p);
}

async function failed(p: Plan, e: Error, rules: Rules) {
  p.attempts += 1;
  const transient = (e as YT.YtError | IG.IgError).transient ?? false;
  const again = (transient || p.attempts <= 1) && p.attempts <= rules.retries;
  p.state = "failed"; p.error = e.message; p.step = null;
  p.next_try = again ? Date.now() + BACKOFF[Math.min(p.attempts - 1, BACKOFF.length - 1)] : null;
  line(p, `${e.message}${again ? ` · next try ${new Date(p.next_try!).toISOString().slice(11, 16)} UTC` : ""}`, false);
  if (rules.notify) await notify(`Couldn't post to ${spaceName(p.space)}`, `${e.message}${again ? " Voicebox will try again." : ""}`, "warning").catch(() => null);
  await logActivity({ post_id: p.post, verb: "couldn't publish to", text: `${spaceName(p.space)}: ${e.message.slice(0, 120)}` }, AUTOPILOT).catch(() => null);
}

async function finish(p: Plan, rules: Rules) {
  p.state = "published"; p.progress = 1; p.error = null; p.next_try = null;
  const later = p.run?.publish_at && Date.parse(p.run.publish_at) > Date.now();
  p.step = later ? `Uploaded · YouTube makes it public ${new Date(p.run!.publish_at!).toUTCString().slice(0, 22)} UTC` : "Live";
  line(p, later ? "Uploaded; YouTube publishes it at the scheduled time" : `Live: ${p.result?.url}`, true);
  if (rules.mark_posted) await markLive(p, !later);
  if (rules.notify) await notify(later ? `Scheduled on ${spaceName(p.space)}` : `Live on ${spaceName(p.space)}`, p.result?.url ?? "", "tada").catch(() => null);
  await logActivity({ post_id: p.post, verb: later ? "scheduled on" : "published to", text: `${spaceName(p.space)} ${p.result?.url ?? ""}` }, AUTOPILOT).catch(() => null);
  await crosspost(p, rules).catch((e) => line(p, `Cross-post rule: ${(e as Error).message}`, false));
}

/** The board follows: the target goes to Posted (or Scheduled while YouTube holds it) with its live link. */
async function markLive(p: Plan, live: boolean) {
  const map = await getTargets();
  const { getPost } = await import("../appwrite");
  const post = await getPost(p.post).catch(() => null);
  if (!post) return;
  const ts = targetsOf(post, map).map((t) => (t.space === p.space ? { ...t, status: live ? ("posted" as const) : ("scheduled" as const), link: p.result?.url ?? t.link } : t));
  await setTargets(p.post, ts, AUTOPILOT);
  if (p.result && live) p.result.marked = true;
}

/** Cross-post rules: live on A → a target on B, N hours later, the same file, captions carried over. */
async function crosspost(p: Plan, rules: Rules) {
  const due = rules.crosspost.filter((r) => r.on && r.from === p.space);
  if (!due.length) return;
  const { getPost } = await import("../appwrite");
  const post = await getPost(p.post);
  const map = await getTargets();
  let targets = targetsOf(post, map);
  const accounts = await listAccounts();
  const base = Date.parse(p.run?.publish_at ?? "") || Date.now();
  for (const r of due) {
    if (targets.some((t) => t.space === r.to)) continue;
    const at = new Date(base + r.hours * 3600_000).toISOString();
    targets = [...targets, { space: r.to, status: "scheduled", due_at: at, link: null }];
    const net = networkOf(r.to);
    if (net && !(await getPlan(p.post, r.to))) {
      const acc = accounts.find((a) => a.network === net);
      const { editPlan } = await import("./plans");
      const caption = p.network === "youtube" ? p.yt!.description : p.ig!.caption;
      const next = editPlan(null, p.post, r.to, { account: acc?.id ?? null, media: p.media, cover: p.cover, when: "scheduled" }, AUTOPILOT.name, rules,
        { title: p.yt?.title ?? post.title, caption: (await captionFor(p.post, r.to)) ?? post.caption ?? caption });
      next.state = acc ? "armed" : "draft";
      line(next, `Made by the cross-post rule after ${spaceName(p.space)} went live`);
      await putPlan(next);
    }
    line(p, `Cross-posting to ${spaceName(r.to)} ${r.hours ? `${r.hours} h later` : "now"}`);
  }
  await setTargets(p.post, targets, AUTOPILOT);
}

// ── YouTube

async function runYoutube(p: Plan, acc: Account & { tokens: Tokens }, deadline: number) {
  const o = p.yt!;
  const token = await YT.accessToken(acc);
  const run = p.run!;
  const src = await resolve(p.media[0]);
  if (src.kind !== "video") throw new Error("YouTube needs a video file");
  const size = run.size || (await sizeOf(src));
  if (!size) throw new Error(`Couldn't tell how big ${src.name} is`);
  run.size = size;
  let video: { id: string; status?: { privacyStatus?: string } } | undefined;
  if (!run.video_id) {
    if (run.yt_session) {
      try { const s = await YT.uploadStatus(run.yt_session, token, size); run.offset = s.offset; video = s.video; }
      catch (e) { if ((e as YT.YtError).reason === "sessionGone") { run.yt_session = null; run.offset = 0; line(p, "Upload session expired; starting over"); } else throw e; }
    }
    if (!run.yt_session) {
      const t = await targetOf(p);
      const due = t?.due_at ? Date.parse(t.due_at) : 0;
      const publishAt = p.when === "scheduled" && o.youtube_schedules && o.privacy === "public" && due > Date.now() + 15 * 60_000 ? new Date(due).toISOString() : null;
      run.yt_session = await YT.startUpload(token, o, size, src.mime, publishAt);
      run.publish_at = publishAt; run.offset = 0;
      line(p, `Uploading ${src.name} (${(size / 1e6).toFixed(1)} MB) to ${acc.name}${publishAt ? `, public at ${publishAt.slice(0, 16).replace("T", " ")} UTC` : ""}`);
    }
    p.state = "uploading";
    while (!video && (run.offset ?? 0) < size) {
      if (Date.now() > deadline - 30_000) { await putPlan(p); throw new Budget(); }
      await checkStop(p);
      const from = run.offset ?? 0, to = Math.min(size, from + YT.CHUNK) - 1;
      const bytes = await range(src, from, to);
      try {
        const r = await YT.putChunk(run.yt_session!, token, bytes, from, size);
        run.offset = r.offset; video = r.video;
      } catch (e) {
        if ((e as YT.YtError).reason === "sessionGone") { run.yt_session = null; run.offset = 0; throw new Error("The upload session expired; it starts over on the next try"); }
        throw e;
      }
      p.progress = Math.min(0.94, (run.offset ?? 0) / size);
      p.step = `Uploading ${Math.round(p.progress * 100)}%`;
      await putPlan(p);
    }
    if (!video) { const s = await YT.uploadStatus(run.yt_session!, token, size); video = s.video; }
    if (!video) throw new Error("YouTube didn't confirm the upload");
    run.video_id = video.id;
    const short = p.space === "yt_short";
    p.result = { id: video.id, url: YT.watchUrl(video.id, short), at: Date.now() };
    line(p, `On YouTube: ${p.result.url}`, true);
    const wanted = run.publish_at ? "private" : o.privacy;
    if (video.status?.privacyStatus === "private" && wanted !== "private") {
      p.result.private_only = true;
      line(p, "YouTube kept it private: this Google Cloud project hasn't passed YouTube's API audit yet. Make it public in YouTube Studio, or apply for the audit (docs/PUBLISHING.md).", false);
    }
    await putPlan(p);
  }
  // after the upload: thumbnail and playlist (a failure here doesn't undo the upload)
  p.state = "processing"; p.progress = 0.97; p.step = "Thumbnail and playlist";
  const id = run.video_id!;
  if (p.cover && !p.log.some((l) => l.text.startsWith("Thumbnail"))) {
    try {
      const c = await resolve(p.cover);
      const url = c.m ? jpegUrl(c.m, 1280) : c.url;
      const bytes = new Uint8Array(await (await fetch(url!, { cache: "no-store" })).arrayBuffer());
      await YT.setThumbnail(token, id, bytes, "image/jpeg");
      line(p, "Thumbnail set", true);
    } catch (e) { line(p, `Thumbnail not set: ${(e as Error).message}`, false); }
  }
  if (o.playlist && !p.log.some((l) => l.text.startsWith("Added to playlist") || l.text.startsWith("Playlist"))) {
    try { await YT.addToPlaylist(token, o.playlist, id); line(p, "Added to playlist", true); }
    catch (e) { line(p, `Playlist: ${(e as Error).message}`, false); }
  }
}

// ── Instagram

async function igItem(s: Source): Promise<IG.IgItem> {
  if (s.kind === "image") {
    const url = s.m ? jpegUrl(s.m, 1440) : null;
    if (!url) throw new Error(`${s.name} isn't ready for Instagram`);
    return { kind: "image", url };
  }
  if (s.kind === "video") return { kind: "video", url: s.url };
  throw new Error(`${s.name}: only photos and videos go to Instagram`);
}

async function waitFinished(p: Plan, token: string, id: string, deadline: number, what: string) {
  for (;;) {
    const s = await IG.containerStatus(token, id);
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return s.status_code;
    if (s.status_code === "ERROR") throw new IG.IgError(`Instagram couldn't process ${what}${s.status ? `: ${s.status}` : ""}. Check the format (MP4 H.264/AAC, JPEG photos, 4:5 to 1.91:1 for feed).`);
    if (s.status_code === "EXPIRED") { p.run!.ig_container = null; p.run!.ig_children = []; throw new IG.IgError("Instagram's draft expired (24 h); it starts over on the next try", 0, 0, true); }
    if (Date.now() > deadline - 15_000) throw new Budget();
    await checkStop(p);
    p.step = `Instagram is processing ${what}`;
    await sleep(5000);
  }
}

async function runInstagram(p: Plan, acc: Account & { tokens: Tokens }, deadline: number) {
  const o = p.ig!;
  const token = await IG.accessToken(acc);
  const run = p.run!;
  const user = acc.id;
  if (!run.ig_media) {
    if (!run.ig_container && !run.ig_children?.length) {
      // never the same photos twice, and never past Instagram's daily publishing limit (it treats that as spam)
      if (!p.log.some((l) => l.text.startsWith("Posting again on purpose"))) {
        const twin = await liveTwin(p);
        if (twin) throw new Hold(`These files are already live on Instagram (${twin.result!.url}). Nothing was posted again.`);
      }
      const lim = await IG.publishingLimit(token, user).catch(() => null);
      if (lim && lim.used >= lim.total) throw new IG.IgError(`Instagram's limit of ${lim.total} posts a day is used up; Voicebox tries again later`, 0, 0, true);
    }
    if (!run.ig_container) {
      const srcs = await Promise.all(p.media.map(resolve));
      p.state = "uploading"; p.progress = 0.1; p.step = "Sending to Instagram";
      if (p.space === "ig_post" && srcs.length > 1) {
        run.ig_children ??= [];
        for (let i = run.ig_children.length; i < srcs.length; i++) {
          run.ig_children.push(await IG.createContainer(token, user, await igItem(srcs[i]), p.space, o, { child: true }));
          p.progress = 0.1 + (0.4 * (i + 1)) / srcs.length;
          await putPlan(p);
        }
        for (const [i, c] of run.ig_children.entries()) await waitFinished(p, token, c, deadline, `item ${i + 1}`);
        run.ig_container = await IG.createCarousel(token, user, run.ig_children, o);
      } else {
        const cover = p.cover && p.space === "ig_reel" ? await resolve(p.cover).then((c) => (c.m ? jpegUrl(c.m, 1080) : null)).catch(() => null) : null;
        run.ig_container = await IG.createContainer(token, user, await igItem(srcs[0]), p.space, o, { cover_url: cover });
      }
      line(p, "Instagram has the file; processing");
      p.state = "processing"; p.progress = 0.6;
      await putPlan(p);
    }
    await waitFinished(p, token, run.ig_container!, deadline, p.space === "ig_reel" ? "the reel" : p.space === "ig_story" ? "the story" : "the post");
    p.progress = 0.9; p.step = "Publishing";
    run.ig_media = await IG.publish(token, user, run.ig_container!);
    const url = (await IG.permalink(token, run.ig_media).catch(() => null)) ?? `https://www.instagram.com/${acc.handle ?? ""}`;
    p.result = { id: run.ig_media, url, at: Date.now() };
    await putPlan(p);
  }
  if (o.first_comment && p.space !== "ig_story" && !p.log.some((l) => l.text.startsWith("First comment"))) {
    try { await IG.comment(token, run.ig_media!, o.first_comment); line(p, "First comment posted", true); }
    catch (e) { line(p, `First comment not posted: ${(e as Error).message}`, false); }
  }
}

// ── posting slots

/** Minutes east of UTC for a time zone at a moment. */
function tzOffset(at: number, tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at) / 60_000;
}
/** The next free slot for a space, at least 10 min away, not within 30 min of another post on that space. */
export function nextSlot(rules: Rules, space: SpaceId, taken: number[], now = Date.now()): string | null {
  const slots = rules.slots.filter((s) => s.space === space);
  if (!slots.length) return null;
  const tz = rules.tz || "UTC";
  const cands: number[] = [];
  for (let d = 0; d < 21; d++) {
    const day = new Date(now + d * 864e5);
    const local = new Date(day.getTime() + tzOffset(day.getTime(), tz) * 60_000);
    for (const s of slots) {
      if (local.getUTCDay() !== s.day) continue;
      const [h, m] = s.time.split(":").map(Number);
      const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m);
      cands.push(guess - tzOffset(guess, tz) * 60_000);
    }
  }
  const t = cands.sort((a, b) => a - b).find((c) => c > now + 10 * 60_000 && !taken.some((x) => Math.abs(x - c) < 30 * 60_000));
  return t ? new Date(t).toISOString() : null;
}

async function fillSlots(rules: Rules) {
  if (!rules.slots.length) return 0;
  const map = await getTargets();
  let n = 0;
  for (const [post, ts] of Object.entries(map)) {
    if (!ts.some((t) => t.status === "scheduled" && !t.due_at && rules.slots.some((s) => s.space === t.space))) continue;
    const next = ts.map((t) => {
      if (t.status !== "scheduled" || t.due_at) return t;
      const taken = Object.values(map).flat().filter((x) => x.space === t.space && x.due_at).map((x) => Date.parse(x.due_at!));
      const at = nextSlot(rules, t.space, taken);
      if (at) { n++; map[post] = (map[post] ?? []).map((y) => (y.space === t.space ? { ...y, due_at: at } : y)); }
      return at ? { ...t, due_at: at } : t;
    });
    await setTargets(post, next, AUTOPILOT).catch(() => null);
  }
  return n;
}

// ── the autopilot

export async function sweep(budgetMs = 250_000) {
  const deadline = Date.now() + budgetMs;
  const rules = await getRules();
  const out = { started: [] as string[], continued: [] as string[], retried: [] as string[], marked: [] as string[], slotted: 0, refreshed: 0, errors: [] as string[] };
  // Instagram tokens: refresh well before the 60 days run out
  for (const a of await listAccounts()) {
    if (a.network !== "instagram" || !a.expires_at || a.expires_at - Date.now() > 20 * 864e5) continue;
    const full = await getAccount(a.id);
    if (full) await IG.accessToken(full, true).then(() => out.refreshed++).catch((e) => out.errors.push(`${a.handle}: ${(e as Error).message}`));
  }
  out.slotted = await fillSlots(rules).catch(() => 0);
  const [plans, map] = await Promise.all([listPlans(), getTargets()]);
  const now = Date.now();
  const due: [Plan, keyof typeof out][] = [];
  for (const p of plans) {
    const t = (map[p.post] ?? []).find((x) => x.space === p.space);
    const at = t?.due_at ? Date.parse(t.due_at) : null;
    const lockFree = !p.run?.lock || now - p.run.lock > LOCK_MS;
    if (BUSY.includes(p.state) && lockFree) due.push([p, "continued"]);
    else if (p.state === "armed" && rules.autopilot && at && t?.status !== "posted") {
      const lead = p.network === "youtube" && p.yt?.youtube_schedules && p.yt.privacy === "public" ? YT_LEAD : 0;
      if (now >= at - lead) due.push([p, "started"]);
    } else if (p.state === "failed" && p.next_try && p.next_try <= now && rules.autopilot) due.push([p, "retried"]);
    else if (p.state === "published" && p.run?.publish_at && Date.parse(p.run.publish_at) <= now && !p.result?.marked && rules.mark_posted) {
      p.step = "Live";
      line(p, "Public on YouTube now", true);
      await markLive(p, true).catch(() => null);
      await putPlan(p);
      out.marked.push(`${p.post}/${p.space}`);
    }
  }
  for (const [p, kind] of due.sort((a, b) => a[0].updated - b[0].updated)) {
    if (Date.now() > deadline - 40_000) break;
    const r = await drive(p.post, p.space, deadline - Date.now() - 5_000);
    (out[kind] as string[]).push(`${p.post}/${p.space}:${r?.state}`);
  }
  return out;
}
