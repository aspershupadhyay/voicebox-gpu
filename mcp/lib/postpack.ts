// The post package: everything a post needs to go out well, made from Radar's research on its topic (lib/radar-data.ts)
// with plain rules, no AI model on the server. For any post (a single video, a Reel or Short, a carousel, a photo, a
// voiced script): the best title of a scored set (search and click, lib/radar.ts titleScore), a YouTube description that
// says the keyword early and covers the words searchers add, tags from the long tail, hashtags the videos ranking for it
// actually use, and credits for footage that came from someone else (read from the file names: a Pinterest pin, a
// TikTok or Instagram handle, a link), then the same set fitted to every target: the YouTube plan's title, description
// and tags, Instagram's caption, the hand-off captions for X, TikTok and LinkedIn. It never overwrites what a person
// wrote: a field is only filled when it's empty or still holds what the last package put there (unless overwrite).
// Kept in R2 at workspace/packs/<post>.json. autoPost() is the one click: a file becomes a post with its targets, its
// package and plans armed for the next posting slots (or sent now). The dashboard (Files, the post's pipeline) and
// Claude (post_package, auto_post, and publish_post before it arms or sends) all go through here.
import type { Fmt } from "./analytics";
import { getJson, putJson } from "./store";
import type { SpaceId } from "./spaces";
import type { Media, Post } from "./workspace";

const KEY = (post: string) => `workspace/packs/${post}.json`;
const PUBLISH_FMT = ["yt_video", "yt_short", "ig_reel", "ig_post"] as const;
type Actor = { id?: string; name: string };

export type PackKind = "video" | "carousel" | "photo" | "voiced" | "text";
export type Pack = {
  post: string; at: number; by: string;
  keyword: string; fmt: Fmt; kind: PackKind;
  title: string;
  /** every title it weighed, best first: overall score = search and click together */
  titles: { title: string; score: number; seo: number; click: number; from: string }[];
  /** the YouTube description, and how search reads the title, description and tags together */
  description: string; seo: { score: number; failing: string[] };
  /** YouTube tags, and the hashtags (without #) best first */
  tags: string[]; hashtags: string[];
  /** Instagram's caption */
  caption: string;
  credit: string | null; credit_from: string | null;
  research: { opportunity: number; verdict: string; confidence: string; sources: string } | null;
  /** what the last apply wrote where (so a later package can tell a person's edit from its own) */
  applied: Record<string, string>;
};

/* ───────────── reading a post */

const EXT = /\.(mp4|mov|m4v|webm|mkv|avi|jpe?g|png|webp|gif|heic|mp3|wav|m4a)$/i;
/** A file name as words: no extension, no downloader's stamp, no ids. */
export function cleanName(name: string) {
  return name.replace(EXT, "").replace(/^[0-9a-f]{6,}[-_]/i, "")
    .replace(/\b(from[_ -]+)?(klickpin|snapinsta|snaptik|ssstik|savefrom|y2mate|igram|fastdl|pinterestdownloader|tikmate|savetik|sssinstagram|instadownloader)(\.(com|io|app|net|org))?\b[_ -]*/gi, "")
    .replace(/[_ -]*pin[_ -]?id[_ -]*\d+/gi, "").replace(/[_ -]*(carousel|slide|img|image|video|vid)[_ -]*\d+\b/gi, "")
    .replace(/\b\d{4,}\b/g, "").replace(/[_]+/g, " ").replace(/\s*-\s*$/, "").replace(/^\s*-\s*/, "").replace(/\s+/g, " ").trim();
}
/** A title that's really a file name ("IMG_2041.mp4", "From_Klickpin.com-_Tiny_House…") */
export const looksLikeFile = (t: string) => EXT.test(t) || /_/.test(t) || /pin[-_ ]?id/i.test(t) || /^(img|vid|dsc|pxl|screen ?shot|video|untitled)[\s_-]*\d/i.test(t) || /klickpin|snapinsta|ssstik/i.test(t);

const STOPS = new Set("a an the and or but of to in on for with is are was were be that this these those will you your my our their it its how why what when who which from by at as so not into than then there here just about ever every that's".split(" "));
/** The topic to research: the title's leading run of meaningful words (up to four), else its first meaningful words. */
export function keywordOf(title: string) {
  const ws = cleanName(title).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  const lead: string[] = [];
  for (const w of ws) { if (STOPS.has(w) || /^\d+$/.test(w)) { if (lead.length >= 2) break; continue; } lead.push(w); if (lead.length >= 4) break; }
  return (lead.length >= 2 ? lead : ws.filter((w) => !STOPS.has(w)).slice(0, 3)).join(" ").slice(0, 80);
}

/** Who to credit, from what the user said or the files' names and the post's notes. */
export function creditOf(given: string | null | undefined, names: string[], notes: string | null | undefined): { line: string | null; from: string | null } {
  if (given?.trim()) return { line: given.trim().replace(/^credits?:\s*/i, ""), from: "given" };
  const note = /(?:^|\n)\s*(?:credits?|via|source|by)\s*[:\-]\s*(.+)/i.exec(notes ?? "");
  if (note) return { line: note[1].trim().slice(0, 200), from: "the post's notes" };
  for (const n of names) {
    const pin = /pin[-_ ]?id[-_ ]?(\d{6,})/i.exec(n);
    if (pin) return { line: `the original creator on Pinterest (pinterest.com/pin/${pin[1]})`, from: n };
    const tt = /tiktok[^@]*@([\w.]{2,24})|@([\w.]{2,24})[^\w]*tiktok/i.exec(n);
    if (tt) return { line: `@${tt[1] ?? tt[2]} on TikTok`, from: n };
    const ig = /instagram\.com\/(?:p|reel)\/([\w-]+)/i.exec(n) ?? /(?:snapinsta|igram|fastdl|sssinstagram)/i.exec(n);
    if (ig) return { line: ig[1] ? `the original post (instagram.com/p/${ig[1]})` : "the original creator on Instagram", from: n };
    const at = /(?:^|[\s_(-])@([\w.]{2,30})/.exec(n);
    if (at) return { line: `@${at[1]}`, from: n };
    if (/klickpin|pinterest/i.test(n)) return { line: "the original creator on Pinterest", from: n };
    if (/ssstik|snaptik|tikmate|savetik/i.test(n)) return { line: "the original creator on TikTok", from: n };
  }
  return { line: null, from: null };
}

const titleCase = (s: string) => s.replace(/(^|[\s(/-])([\p{Ll}])/gu, (_m, a: string, b: string) => a + b.toUpperCase())
  .replace(/\b(A|An|The|And|Or|Of|To|In|On|For|Vs|With|At|By)\b/g, (m, _x, i: number) => (i === 0 ? m : m.toLowerCase()))
  .replace(/\b(ai|gpt|api|llm|mcp|seo|ui|ux|ios|diy)\b/gi, (m) => m.toUpperCase());
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

async function formatOf(post: Post, media: Media[]) {
  const { getTargets } = await import("./spacestore");
  const { targetsOf } = await import("./spaces");
  const targets = targetsOf(post, await getTargets());
  const fromTargets = targets.map((t) => t.space).find((s) => (PUBLISH_FMT as readonly string[]).includes(s)) as Fmt | undefined;
  const videos = media.filter((m) => m.kind === "video").length, images = media.filter((m) => m.kind === "image").length;
  const kind: PackKind = videos === 1 && !images ? "video" : images > 1 || (videos && images) ? "carousel" : images === 1 ? "photo" : (post.script ?? "").trim() ? "voiced" : "text";
  const fmt: Fmt = fromTargets ?? (kind === "video" ? "ig_reel" : kind === "carousel" || kind === "photo" ? "ig_post" : "yt_video");
  return { targets, fmt, kind };
}

/* ───────────── making the package */

/** The package for a post, made fresh from the research (nothing is written: applyPack does that). */
export async function buildPack(postId: string, o: { keyword?: string | null; credit?: string | null; by: string }): Promise<Pack> {
  const [{ getPost, listMedia }, rd, radar, { titleModel }, prev] = await Promise.all([import("./appwrite"), import("./radar-data"), import("./radar"), import("./writing"), getPack(postId)]);
  const post = await getPost(postId);
  const media = await listMedia(postId, 100).catch(() => [] as Media[]);
  const { fmt, kind } = await formatOf(post, media);
  const own = looksLikeFile(post.title) ? cleanName(post.title) : post.title.trim();
  const kw = (o.keyword?.trim() || prev?.keyword || keywordOf(own || media[0]?.name || "")).slice(0, 80);
  if (kw.length < 2) throw new Error("this post has no title to research: give it a title or pass keyword");
  const room = await (await import("./writing-data")).writingData().catch(() => null);
  const model = room ? titleModel(room.items) : null;
  const r = await rd.keyword(kw, { fmt, me: room ? { items: room.items, rivals: room.rivals, model, needs: room.needs } : undefined }).catch(() => null);
  const related = (r?.related ?? []).slice(0, 8).map((x) => x.word);
  const K = titleCase(kw), year = new Date().getFullYear();
  const short = fmt === "yt_short" || fmt === "ig_reel";

  // titles: the post's own (cleaned) against honest keyword-first shapes; nothing that claims what the post didn't do
  const tail = (r?.longtail ?? []).map((l) => l.q).filter((q) => q.split(" ").length <= kw.split(" ").length + 3);
  const extra = tail.map((q) => q.replace(new RegExp(`^${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "").trim()).find((x) => x && x.split(" ").length <= 3);
  const q1 = (r?.questions ?? []).find((q) => q.split(" ").length >= kw.split(" ").length + 2 && q.split(" ").length <= 10);
  const cands: [string, string][] = [
    ...(own && own.length >= 8 ? [[titleCase(own), "the post's own title"] as [string, string]] : []),
    [`${K} (${year})`, "keyword first, dated"],
    ...(related.length >= 2 ? [[`${K}: ${titleCase(related[0])} & ${titleCase(related[1])}`, "keyword first, covers what searchers add"] as [string, string]] : []),
    ...(extra ? [[`${K} ${titleCase(extra)}`, "a long-tail search, word for word"] as [string, string]] : []),
    ...(kind === "video" || kind === "carousel" || kind === "photo" ? [[`${K} You'll Want to Save`, "keyword first, made to be saved"] as [string, string]] : [[`${K} Explained Simply`, "plain and short"] as [string, string]]),
    ...(q1 ? [[`${titleCase(q1)}?`, "a question people type"] as [string, string]] : []),
    ...(kind === "voiced" ? (r?.titles ?? []).filter((t) => !/^I Tried/i.test(t.title)).slice(0, 4).map((t) => [t.title, t.from] as [string, string]) : []),
  ];
  const seen = new Set<string>();
  const titles = cands.filter(([t]) => { const k = t.toLowerCase(); if (seen.has(k) || t.length > 100) return false; seen.add(k); return true; })
    .map(([title, from]) => ({ title, from, ...radar.titleScore(title, kw, model, { related, fmt }) }))
    .sort((a, b) => b.score - a.score);
  // a person's own title stays unless a researched one is clearly better
  const mine = titles.find((t) => t.from === "the post's own title");
  const best = mine && !looksLikeFile(post.title) && titles[0].score - mine.score < 8 ? mine : titles[0];

  const hashtags = [...new Set([...(r?.hashtags ?? []).map((h) => h.tag), radar.norm(kw).replace(/[^\p{L}\p{N}]+/gu, "")])].filter((h) => h.length >= 3 && h.length <= 24).slice(0, 8);
  const credit = creditOf(o.credit ?? prev?.credit ?? null, media.map((m) => m.name), post.notes);
  const said = (post.caption ?? "").replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "").trim();
  const script = (post.script ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const summary = said.length >= 20 ? said.split(/\n{2,}/)[0]
    : script.length ? script.slice(0, 2).join(" ")
    : `${cap(kw)}${kind === "carousel" ? ", slide by slide" : kind === "photo" ? ", in one picture" : kind === "video" ? ", in one short video" : ""}.`;
  const cover = related.slice(0, 4);
  const keywordsLine = cover.length ? `More on ${kw}: ${listOf(cover)}.` : "";
  const creditLine = credit.line ? `Credit: ${credit.line}. All rights belong to the original creator.` : "";
  const ytTags = (short ? ["shorts", ...hashtags.filter((h) => h !== "shorts")] : hashtags).slice(0, 3).map((h) => `#${h}`).join(" ");
  const description = [summary, keywordsLine, short ? "" : `Subscribe for more on ${kw}.`, creditLine, ytTags].filter(Boolean).join("\n\n").slice(0, 4900).replace(/[<>]/g, "");
  const tags = [...new Set([kw, ...tail.slice(0, 8), ...cover.map((w) => `${kw.split(" ").slice(0, 2).join(" ")} ${w}`)])].reduce<string[]>((acc, t) => (acc.join(",").length + t.length < 470 && acc.length < 15 ? [...acc, t] : acc), []);
  const igTags = hashtags.slice(0, 5).map((h) => `#${h}`).join(" ");
  const caption = [best.title, summary !== best.title ? summary : "", kind === "carousel" ? "Save this for later and send it to someone who'd love it." : "Save this for later.", creditLine, igTags].filter(Boolean).join("\n\n").slice(0, 2150);
  const seo = radar.seoScore({ q: kw, title: best.title, description, tags, related, fmt });
  return {
    post: postId, at: Date.now(), by: o.by, keyword: kw, fmt, kind, title: best.title, titles: titles.slice(0, 6), description,
    seo: { score: seo.score, failing: seo.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.why}`) },
    tags, hashtags, caption, credit: credit.line, credit_from: credit.from,
    research: r ? { opportunity: r.opportunity, verdict: r.verdict, confidence: r.confidence, sources: `${r.sources.filter((s) => s.ok).length} of ${r.sources.length} sources answered` } : null,
    applied: prev?.applied ?? {},
  };
}

export async function getPack(postId: string) { return getJson<Pack>(KEY(postId)).catch(() => null); }

/* ───────────── writing it everywhere */

/** Put the package on the post, its targets' captions and its publish plans. Only empty fields, or ones still holding
 *  what the last package wrote, change (overwrite: every field). Returns what changed. */
export async function applyPack(pack: Pack, actor: Actor, o: { overwrite?: boolean } = {}) {
  const [{ getPost, updatePost }, { captionsFor, setCaptions }, plans, { BUSY, networkOf }, { adaptCaption }, { targetsOf }, { getTargets }] = await Promise.all([
    import("./appwrite"), import("./captions"), import("./publish/plans"), import("./publish/shared"), import("./writing"), import("./spaces"), import("./spacestore"),
  ]);
  const post = await getPost(pack.post);
  const free = (key: string, cur: string | null | undefined) => o.overwrite || !(cur ?? "").trim() || (cur ?? "").trim() === (pack.applied[key] ?? "").trim();
  const changed: string[] = [];
  const applied: Record<string, string> = { ...pack.applied };
  const patch: Partial<Post> = {};
  if (looksLikeFile(post.title) || free("title", post.title)) if (post.title !== pack.title) { patch.title = pack.title; applied.title = pack.title; }
  if (free("caption", post.caption)) { patch.caption = pack.caption; applied.caption = pack.caption; }
  if (Object.keys(patch).length) { await updatePost(pack.post, patch, actor); changed.push(...Object.keys(patch).map((k) => `post ${k}`)); }

  const targets = targetsOf(post, await getTargets());
  const caps = await captionsFor(pack.post);
  const capFor = (space: SpaceId) => space.startsWith("ig_") ? pack.caption : space.startsWith("yt_") ? pack.description : adaptCaption(pack.caption, space, { title: pack.title, tags: pack.hashtags });
  const nextCaps: Record<string, string> = {};
  for (const t of targets) {
    if (t.status === "posted") continue;
    const k = `cap:${t.space}`, v = capFor(t.space);
    if (free(k, caps[t.space])) { nextCaps[t.space] = v; applied[k] = v; }
  }
  if (Object.keys(nextCaps).length) { await setCaptions(pack.post, nextCaps).catch(() => null); changed.push(`captions for ${Object.keys(nextCaps).join(", ")}`); }

  for (const t of targets) {
    if (!networkOf(t.space)) continue;
    const p = await plans.getPlan(pack.post, t.space);
    if (!p || BUSY.includes(p.state) || p.state === "published") continue;
    let touched = false;
    if (p.yt) {
      // the plan was seeded from the post's title and caption when it was made: those count as not written by a person
      if (free(`yt.title:${t.space}`, p.yt.title) || p.yt.title === post.title) { p.yt.title = pack.title.slice(0, 100); applied[`yt.title:${t.space}`] = p.yt.title; touched = true; }
      if (free(`yt.description:${t.space}`, p.yt.description) || p.yt.description.trim() === (post.caption ?? "").trim()) { p.yt.description = pack.description; applied[`yt.description:${t.space}`] = pack.description; touched = true; }
      if (!p.yt.tags.length || o.overwrite || p.yt.tags.join(",") === (applied[`yt.tags:${t.space}`] ?? "")) { p.yt.tags = pack.tags; applied[`yt.tags:${t.space}`] = pack.tags.join(","); touched = true; }
    }
    if (p.ig && t.space !== "ig_story") {
      if (free(`ig.caption:${t.space}`, p.ig.caption) || p.ig.caption.trim() === (post.caption ?? "").trim()) { p.ig.caption = pack.caption; applied[`ig.caption:${t.space}`] = pack.caption; touched = true; }
    }
    // whoever wrote it, it never goes out without hashtags, the credit, or tags
    const top = topUp(p.yt ? p.yt.description : p.ig?.caption ?? "", pack, p.yt ? 4900 : 2150, p.yt ? (t.space === "yt_short" ? ["shorts", ...pack.hashtags] : pack.hashtags).slice(0, 3) : pack.hashtags.slice(0, 5));
    if (t.space !== "ig_story" && top.text !== (p.yt ? p.yt.description : p.ig?.caption)) {
      if (p.yt) p.yt.description = top.text.replace(/[<>]/g, ""); else if (p.ig) p.ig.caption = top.text;
      touched = true; changed.push(`${t.space}: added ${top.added.join(" and ")}`);
    }
    if (p.yt && !p.yt.tags.length && pack.tags.length) { p.yt.tags = pack.tags; touched = true; }
    if (touched) { p.log.push({ at: Date.now(), text: `Title, description and hashtags from the post package (${pack.keyword}), by ${actor.name}` }); await plans.putPlan(p); changed.push(`${t.space} plan`); }
  }
  const saved: Pack = { ...pack, applied };
  await putJson(KEY(pack.post), saved);
  return { pack: saved, changed };
}

/** A caption or description with the credit and hashtags added if it has none (a person's words stay as they are). */
export function topUp(text: string, pack: Pick<Pack, "credit" | "hashtags">, max: number, tags: string[]) {
  let out = text.trim();
  const added: string[] = [];
  if (pack.credit && !/\bcredits?\b|\bvia @|all rights belong/i.test(out)) {
    const line = `Credit: ${pack.credit}. All rights belong to the original creator.`;
    const at = out.search(/(^|\n)\s*#[\p{L}\p{N}_]+(\s+#[\p{L}\p{N}_]+)*\s*$/u);
    out = at >= 0 ? `${out.slice(0, at).trim()}\n\n${line}\n\n${out.slice(at).trim()}` : `${out}\n\n${line}`;
    added.push("the credit");
  }
  if (!/#[\p{L}\p{N}_]+/u.test(out) && tags.length) { out = `${out}\n\n${tags.map((h) => `#${h}`).join(" ")}`; added.push("hashtags"); }
  return { text: out.trim().slice(0, max), added };
}

/** Build and apply in one go (the pipeline's step, publish_post's safety net). */
export async function packPost(postId: string, actor: Actor, o: { keyword?: string | null; credit?: string | null; overwrite?: boolean } = {}) {
  const pack = await buildPack(postId, { keyword: o.keyword, credit: o.credit, by: actor.name });
  return applyPack(pack, actor, { overwrite: o.overwrite });
}

/** A package made in the last day is good enough to send with; else make one. Never throws (sending goes on). */
export async function ensurePack(postId: string, actor: Actor) {
  const have = await getPack(postId);
  if (have && Date.now() - have.at < 24 * 3600_000) return applyPack(have, actor).catch(() => null);
  return packPost(postId, actor).catch(() => null);
}

/* ───────────── the one click */

/** Files become a post that's ready to go: the post (titled from research), its targets (a video: Reel and Short; photos:
 *  an Instagram carousel or photo; wide video: a YouTube video), the package, and a plan per target with the files and
 *  account, timed at the next posting slots and armed (go "arm", the default), sent now ("now"), or left to look at
 *  ("draft"). Only targets on a connected account are made. */
export async function autoPost(files: string[], actor: Actor, o: { go?: "draft" | "arm" | "now"; spaces?: SpaceId[]; keyword?: string | null; credit?: string | null; title?: string | null; post_id?: string | null } = {}) {
  const [aw, { listAccounts }, plansMod, { getTargets, setTargets }, { targetsOf }, { nextSlot }] = await Promise.all([
    import("./appwrite"), import("./publish/accounts"), import("./publish/plans"), import("./spacestore"), import("./spaces"), import("./publish/run"),
  ]);
  const ids = [...new Set(files.map((f) => f.replace(/^m:/, "")))].filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, 20);
  if (!ids.length) throw new Error("give the files to post (m:<upload id>, from Files or list_files)");
  const media = await Promise.all(ids.map((id) => aw.getMedia(id).catch(() => null)));
  const ok = media.filter((m): m is Media => !!m && (m.kind === "video" || m.kind === "image"));
  if (!ok.length) throw new Error("only photos and videos can be posted");
  const videos = ok.filter((m) => m.kind === "video"), images = ok.filter((m) => m.kind === "image");
  const accounts = await listAccounts();
  const has = (n: "youtube" | "instagram") => accounts.some((a) => a.network === n);
  const want: SpaceId[] = o.spaces?.length ? o.spaces
    : videos.length === 1 && !images.length ? ["ig_reel", "yt_short"]
    : ["ig_post"];
  const spaces = want.filter((s) => (s.startsWith("yt_") ? has("youtube") : s.startsWith("ig_") ? has("instagram") : false));
  if (!spaces.length) throw new Error(`connect ${want.some((s) => s.startsWith("yt_")) ? "YouTube" : "Instagram"} first (Posts → Autopilot)`);

  // the post: the one given, the one the files already belong to, or a new one named from the first file
  let post = o.post_id ? await aw.getPost(o.post_id) : ok[0].post_id ? await aw.getPost(ok[0].post_id).catch(() => null) : null;
  const made = !post;
  if (!post) post = await aw.createPost({ title: (o.title?.trim() || cleanName(ok[0].name) || "New post").slice(0, 200), status: "draft", platforms: [] }, actor);
  const pid = post.$id;
  await Promise.all(ok.filter((m) => m.post_id !== pid).map((m) => aw.setMediaPost(m.$id, pid)));

  // targets, each at its next posting slot (or now)
  const [rules, map] = await Promise.all([plansMod.getRules(), getTargets()]);
  const taken = (space: string) => Object.entries(map).flatMap(([p, ts]) => (p === pid ? [] : ts.filter((t) => t.space === space && t.due_at).map((t) => Date.parse(t.due_at!))));
  const cur = targetsOf(post, map);
  const now = o.go === "now";
  const next = [...cur.filter((t) => !spaces.includes(t.space)), ...spaces.map((space) => {
    const have = cur.find((t) => t.space === space);
    if (have?.status === "posted") return have;
    if (o.go === "draft") return have ?? { space, status: "draft" as const }; // set up to check in the composer: nothing on the calendar yet
    const due = now ? new Date().toISOString() : have?.due_at ?? nextSlot(rules, space, taken(space)) ?? new Date(Date.now() + 24 * 3600_000).toISOString();
    return { space, status: "scheduled" as const, due_at: due };
  })];
  await setTargets(pid, next, actor);

  // the package, then a plan per target with the files and the account
  const pack = await buildPack(pid, { keyword: o.keyword, credit: o.credit, by: actor.name });
  const mediaRefs = (space: SpaceId) => space === "ig_post" ? ok.map((m) => `m:${m.$id}`).slice(0, 20) : videos.length ? [`m:${videos[0].$id}`] : [`m:${ok[0].$id}`];
  const out: { space: SpaceId; state: string; due_at: string | null; error?: string }[] = [];
  for (const space of spaces) {
    const network = space.startsWith("yt_") ? "youtube" : "instagram";
    const acc = accounts.filter((a) => a.network === network);
    const curPlan = await plansMod.getPlan(pid, space);
    if (curPlan && (curPlan.state === "published" || ["queued", "uploading", "processing"].includes(curPlan.state))) { out.push({ space, state: curPlan.state, due_at: null }); continue; }
    const plan = plansMod.editPlan(curPlan, pid, space, { media: mediaRefs(space), ...(curPlan?.account ? {} : acc.length ? { account: acc[0].id } : {}) }, actor.name, rules, { title: pack.title, caption: space.startsWith("yt_") ? pack.description : pack.caption });
    await plansMod.putPlan(plan);
    out.push({ space, state: plan.state, due_at: next.find((t) => t.space === space)?.due_at ?? null });
  }
  const { pack: saved, changed } = await applyPack(pack, actor);
  if (o.go === "arm" || o.go === "now" || o.go === undefined) {
    const { publishPost } = await import("./publish/api");
    for (const r of out) {
      if (r.state === "published") continue;
      const res = await publishPost([pid, r.space, "go"], { mode: o.go === "now" ? "now" : "arm" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) r.error = j.error ?? `couldn't ${o.go === "now" ? "send" : "arm"} it`;
      else r.state = j.plan?.state ?? r.state;
    }
  }
  return { post_id: pid, made_post: made, title: saved.title, targets: out, pack: saved, changed, autopilot: rules.autopilot, post: await aw.getPost(pid).catch(() => post) };
}
