// The Writing room's rules (the /writing page and the hook_score, title_lab, captions and weekly_digest MCP tools): a
// hook score for scripts, a title model learned from your own hits, thumbnail brief checks, captions fitted to each
// platform, and the weekly digest. No AI model here: everything is read from your own numbers and plain rules, so it
// is instant and free; the writing itself happens when you ask Claude through the MCP tools, which use these same
// rules to score what it writes. Pure and browser-safe (the page and the server share it).
import type { Fmt } from "./analytics";
import type { SpaceId } from "./spaces";

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const WPM = 160; // a creator's speaking pace

/** A post as the Writing room sees it: what went out, how it did against your usual for its format. */
export type WItem = {
  id: string; network: "youtube" | "instagram"; fmt: Fmt; title: string; url: string; thumb: string | null; at: number;
  views: number | null; score: number | null; duration: number | null; tags: string[]; post: string | null;
};
/** A rival's upload with how it did against that rival's own usual. */
export type WRival = { id: string; owner: string; name: string; avatar: string | null; title: string; thumb: string | null; url: string; at: number; fmt: Fmt; views: number; x: number | null };

/* ───────────── titles */

/** Title habits: what a title does, checked on every title. Hits are compared with the rest on each. */
export const PATTERNS: [string, (t: string) => boolean][] = [
  ["A number", (t) => /\d/.test(t)],
  ["A question", (t) => /\?/.test(t)],
  ["How / why / what", (t) => /\b(how|why|what)\b/i.test(t)],
  ["“I” or “my”", (t) => /\b(I|I'm|I've|my|me)\b/.test(t)],
  ["“You”", (t) => /\byou(r|'re)?\b/i.test(t)],
  ["A word in CAPS", (t) => /\b[A-Z]{3,}\b/.test(t.replace(/\b(AI|GPT|API|USA|UK|CEO|SEO|LLM|MCP|AGI)\b/g, ""))],
  ["Under 50 characters", (t) => t.length < 50],
];
export const STOP = new Set("a an the and or but of to in on for with is are was were be been it this that these those i you he she we they my your our their me us them how why what when who which from by at as so not no do does did can will just about into than then there here new vs its it's i'm you're im".split(" "));
export const topicWords = (t: string) => [...new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/))].filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));

/** What usually works before there are enough of your own posts to learn from (from common YouTube title research). */
const PRIOR: Record<string, number> = { "A number": 0.12, "A question": 0.04, "How / why / what": 0.06, "“I” or “my”": 0.04, "“You”": 0.08, "A word in CAPS": 0.03, "Under 50 characters": 0.1 };
export const HIT = 1.5; // 1.5× your usual for its format counts as a hit

export type Lift = { label: string; a: number; b: number; lift: number };
export type TitleModel = {
  /** "yours" once there are 3 hits and 3 others to compare; "general" until then */
  basis: "yours" | "general"; hits: number; rest: number; lifts: Lift[];
  words: { word: string; n: number }[]; len: number | null;
  top: { title: string; score: number; url: string; thumb: string | null; fmt: Fmt }[];
};

export function titleModel(items: Pick<WItem, "title" | "score" | "url" | "thumb" | "fmt">[]): TitleModel {
  const rated = items.filter((i) => i.score != null && i.title);
  const hits = rated.filter((i) => i.score! >= HIT), rest = rated.filter((i) => i.score! < HIT);
  const yours = hits.length >= 3 && rest.length >= 3;
  const share = (xs: typeof rated, f: (t: string) => boolean) => (xs.length ? xs.filter((x) => f(x.title)).length / xs.length : 0);
  // a gap seen in a few posts is mostly noise: shrink it toward nothing until there are a dozen of each to compare
  const trust = Math.min(hits.length, rest.length) / (Math.min(hits.length, rest.length) + 8);
  const lifts = PATTERNS.map(([label, f]) => {
    const a = share(hits, f), b = share(rest, f);
    return { label, a, b, lift: yours ? (a - b) * trust : PRIOR[label] ?? 0 };
  }).sort((x, y) => y.lift - x.lift);
  const n = new Map<string, number>();
  for (const h of hits) for (const w of topicWords(h.title)) n.set(w, (n.get(w) ?? 0) + 1);
  return {
    basis: yours ? "yours" : "general", hits: hits.length, rest: rest.length, lifts,
    words: [...n].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([word, c]) => ({ word, n: c })),
    len: median(hits.map((h) => h.title.length)),
    top: [...hits].sort((a, b) => b.score! - a.score!).slice(0, 8).map((h) => ({ title: h.title, score: h.score!, url: h.url, thumb: h.thumb, fmt: h.fmt })),
  };
}

export type TitleScore = { title: string; score: number; parts: { label: string; on: boolean; delta: number }[]; notes: string[] };

/** A title against your model: 50 for a plain title, up or down by what your hits do more (or less) than the rest. */
export function scoreTitle(raw: string, m: TitleModel): TitleScore {
  const title = raw.trim();
  const parts: TitleScore["parts"] = [];
  const notes: string[] = [];
  let s = 50;
  for (const l of m.lifts) {
    const f = PATTERNS.find((p) => p[0] === l.label)![1];
    const on = f(title);
    const delta = on ? Math.round(clamp(l.lift * 90, -12, 15)) : 0;
    s += delta;
    parts.push({ label: l.label, on, delta });
    if (!on && l.lift >= 0.12) notes.push(m.basis === "yours" ? `${Math.round(l.a * 100)}% of your hits use ${l.label.toLowerCase()} (${Math.round(l.b * 100)}% of the rest)` : `Try ${l.label.toLowerCase()}`);
  }
  const len = title.length;
  if (len > 70) { s -= 10; notes.push(`${len} characters: phones cut titles at about 60`); }
  else if (m.len && Math.abs(len - m.len) <= 15) s += 5;
  const mine = topicWords(title);
  const shared = m.words.filter((w) => mine.includes(w.word)).slice(0, 3);
  if (shared.length) { s += shared.length * 4; parts.push({ label: `Hit words: ${shared.map((w) => w.word).join(", ")}`, on: true, delta: shared.length * 4 }); }
  if (/^(how i|my|vlog|update|episode|part \d)\b/i.test(title) && m.basis === "general") notes.push("Diary-style openings rarely travel beyond your followers");
  if (!title) return { title, score: 0, parts, notes: ["Write a title"] };
  return { title, score: Math.round(clamp(s, 1, 99)), parts, notes: notes.slice(0, 3) };
}

/* ───────────── hooks */

export type Check = { id: string; label: string; ok: boolean; part: number; weight: number; why: string };
export type LineNote = { i: number; text: string; notes: string[]; tone: "ok" | "warn" | "bad" };
export type HookResult = {
  score: number; grade: "Scroll-stopper" | "Strong" | "Getting there" | "Weak" | "Empty";
  opener: string; words: number; secs: number; checks: Check[]; lines: LineNote[];
};

const WARMUP = /\b(hi|hey|hello)\s+(guys|everyone|everybody|friends|all)\b|welcome (back )?to|in (this|today'?s) video|today (i'?m|i am|we'?re|we are) (going to|gonna)|before we (start|begin|get started)|don'?t forget to (like|subscribe)|my name is|what'?s up (guys|everyone)/i;
const LOOP = /\?|\b(why|how|what happens|here'?s|the (secret|truth|reason|trick)|nobody|no one|most people|turns out|until|this is (why|how|what)|you won'?t|wait|watch|the one thing|stop)\b/i;
const STAKES = /\b(but|stop|never|mistake|wrong|actually|instead|without|lose|losing|save|free|before|after|fail|worst|best|only|cost|broke|secret|fast|faster)\b/i;
const FILLER = /\b(just|really|very|basically|actually|literally|kind of|sort of|i think|maybe|honestly|pretty much|you know)\b/gi;
const PASSIVE = /\b(was|were|been|being|is|are)\s+\w+ed\b/i;
const WEAK_START = /^(so|um|uh|and so|basically|okay so|alright so|now)\b[,\s]/i;

/** How long a script runs aloud, and what length suits the format (Shorts and Reels: under a minute). */
export const secsOf = (s: string) => Math.round((words(s).length / WPM) * 60);
export const SHORT: Fmt[] = ["yt_short", "ig_reel"];

/** The opening: the first line, or the first two sentences if the script is one block, capped at 30 words. */
function openerOf(script: string) {
  const lines = script.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  const first = lines.length > 1 ? lines[0] : (lines[0].match(/[^.!?]+[.!?]*/g) ?? [lines[0]]).slice(0, 2).join(" ");
  return words(first).slice(0, 30).join(" ");
}

/** A script's hook score, 0 to 100, from eight checks on its opening and its rhythm, with a note on every weak line.
 *  `fmt` and `best` (your best-performing length in seconds, from analytics) make the length check yours. */
export function hookScore(script: string, opts: { fmt?: Fmt | null; best?: number | null } = {}): HookResult {
  const text = script.trim();
  const opener = openerOf(text);
  const ow = words(opener);
  const firstSentence = words((opener.match(/[^.!?]+[.!?]*/) ?? [opener])[0]);
  const all = words(text);
  const secs = secsOf(text);
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const avg = lines.length ? all.length / lines.length : 0;
  const longest = Math.max(0, ...lines.map((l) => words(l).length));
  const short = opts.fmt ? SHORT.includes(opts.fmt) : secs <= 90;
  const target = opts.best ?? (short ? 45 : null);
  const proper = /\s[A-Z][a-z]{2,}/.test(` ${opener.split(/\s+/).slice(1).join(" ")}`);

  const fast = firstSentence.length <= 12 ? 1 : firstSentence.length <= 18 ? 0.5 : 0;
  const lenPart = !target ? 1 : Math.abs(secs - target) <= target * 0.25 ? 1 : Math.abs(secs - target) <= target * 0.6 ? 0.5 : 0;
  const checks: Check[] = [
    { id: "fast", label: "Gets to it fast", weight: 20, part: fast, ok: fast === 1, why: `The first sentence is ${firstSentence.length} words. Under 12 lands before the thumb moves on.` },
    { id: "warmup", label: "No warm-up", weight: 15, part: WARMUP.test(opener) ? 0 : 1, ok: !WARMUP.test(opener), why: WARMUP.test(opener) ? `“${(opener.match(WARMUP) ?? [""])[0]}” spends the first seconds on nothing. Start on the point.` : "It opens on the point, not a greeting." },
    { id: "loop", label: "Opens a loop", weight: 15, part: LOOP.test(opener) ? 1 : 0, ok: LOOP.test(opener), why: LOOP.test(opener) ? "It raises a question the viewer stays to have answered." : "Nothing makes them wonder. Ask a question, or tease what's coming (“here's why…”)." },
    { id: "specific", label: "Specific", weight: 15, part: /\d/.test(opener) || proper ? 1 : 0, ok: /\d/.test(opener) || proper, why: /\d/.test(opener) || proper ? "A number or a name makes it concrete." : "No number or name. “3 mistakes” beats “some mistakes”." },
    { id: "you", label: "Talks to them", weight: 10, part: /\byou(r|'re)?\b/i.test(opener) ? 1 : 0, ok: /\byou(r|'re)?\b/i.test(opener), why: /\byou(r|'re)?\b/i.test(opener) ? "“You” puts the viewer in it." : "Say “you”: make it about the viewer's problem." },
    { id: "stakes", label: "Stakes or contrast", weight: 10, part: STAKES.test(opener) ? 1 : 0, ok: STAKES.test(opener), why: STAKES.test(opener) ? "There's something to gain or lose." : "No tension. Add a but, a mistake, a cost, a before and after." },
    { id: "rhythm", label: "One beat per line", weight: 10, part: !lines.length ? 0 : avg <= 16 && longest <= 28 ? 1 : avg <= 22 ? 0.5 : 0, ok: avg <= 16 && longest <= 28 && lines.length > 0, why: `${Math.round(avg)} words a line on average, the longest ${longest}. Short lines read and voice better.` },
    { id: "length", label: "Length fits", weight: 5, part: lenPart, ok: lenPart === 1, why: target ? `About ${secs} s aloud; ${opts.best ? "your best performers run" : "this format works best at"} about ${target} s.` : `About ${secs} s aloud.` },
  ];
  const score = text ? Math.round(checks.reduce((s, c) => s + c.weight * c.part, 0)) : 0;

  const notes: LineNote[] = lines.map((l, i) => {
    const n: string[] = [];
    const w = words(l).length;
    if (w > 24) n.push(`${w} words: split it into two beats`);
    const fill = [...new Set((l.match(FILLER) ?? []).map((f) => f.toLowerCase()))];
    if (fill.length) n.push(`Filler: ${fill.join(", ")}`);
    if (PASSIVE.test(l)) n.push("Passive: say who did it");
    if (WEAK_START.test(l)) n.push(`Starts with “${l.match(WEAK_START)![1]}”: cut it`);
    if (i === 0 && WARMUP.test(l)) n.push("Warm-up line: start on the point");
    if (i > 0 && words(l)[0]?.toLowerCase() === words(lines[i - 1])[0]?.toLowerCase() && w > 2) n.push("Same first word as the line before");
    return { i, text: l, notes: n, tone: n.length >= 2 ? "bad" : n.length ? "warn" : "ok" };
  });
  const grade = !text ? "Empty" : score >= 85 ? "Scroll-stopper" : score >= 70 ? "Strong" : score >= 50 ? "Getting there" : "Weak";
  return { score, grade, opener, words: all.length, secs, checks, lines: notes };
}

/* ───────────── thumbnails */

export type Brief = { text: string; subject: string; emotion: string; setting: string };
export const EMOTIONS = ["Shocked", "Curious", "Excited", "Serious", "Confident", "Confused", "Laughing", "Worried"] as const;

/** Checks for a thumbnail brief: short overlay text that adds to the title rather than repeating it, one subject, a face. */
export function briefChecks(b: Brief, title: string): Check[] {
  const tw = words(b.text);
  const overlap = (() => {
    const a = topicWords(b.text), t = new Set(topicWords(title));
    return a.length ? a.filter((w) => t.has(w)).length / a.length : 0;
  })();
  const out: Check[] = [
    { id: "short", label: "Four words or fewer", weight: 30, part: tw.length && tw.length <= 4 ? 1 : 0, ok: !!tw.length && tw.length <= 4, why: tw.length ? `${tw.length} words. A thumbnail is read in a glance; four is the most that lands.` : "Add the few words that go on the image." },
    { id: "adds", label: "Adds to the title", weight: 25, part: overlap <= 0.5 ? 1 : 0, ok: overlap <= 0.5, why: overlap > 0.5 ? "It repeats the title. Say the other half of the story." : "Title and image say different things, so together they say more." },
    { id: "subject", label: "One clear subject", weight: 20, part: b.subject.trim() && !/\b(and|with|plus|,)\b/i.test(b.subject) ? 1 : b.subject.trim() ? 0.5 : 0, ok: !!b.subject.trim() && !/\b(and|with|plus|,)\b/i.test(b.subject), why: "One thing to look at reads at the size of a stamp." },
    { id: "face", label: "A face with a feeling", weight: 15, part: b.emotion ? 1 : 0, ok: !!b.emotion, why: b.emotion ? `${b.emotion} face: eyes go to faces first.` : "Pick an expression: faces pull the eye." },
    { id: "big", label: "Big enough to read", weight: 10, part: b.text.length <= 22 ? 1 : 0, ok: b.text.length <= 22, why: `${b.text.length} characters. Under 22 stays big on a phone.` },
  ];
  return out;
}

/** The brief as an image prompt (for Images). */
export const briefPrompt = (b: Brief, title: string) =>
  [`YouTube thumbnail for “${title || "my video"}”.`, b.subject && `${b.subject}${b.emotion ? `, ${b.emotion.toLowerCase()} expression` : ""}, close up, filling the left half.`,
    b.setting && `Background: ${b.setting}, simple and uncluttered.`, b.text && `Bold text on the right: “${b.text}”.`, "High contrast, bright subject, flat colours, crisp, 16:9."].filter(Boolean).join(" ");

/* ───────────── captions */

/** Each space's caption limit (what the platform accepts) and what reads well there. */
export const CAPTION: Partial<Record<SpaceId, { limit: number; tags: number; hint: string }>> = {
  yt_video: { limit: 5000, tags: 3, hint: "The description: the first two lines show under the video" },
  yt_short: { limit: 5000, tags: 3, hint: "The first line shows; #shorts helps it find the Shorts feed" },
  yt_post: { limit: 1500, tags: 0, hint: "Community post: short, ends on a question" },
  ig_reel: { limit: 2200, tags: 8, hint: "First line is the hook; hashtags after a break" },
  ig_post: { limit: 2200, tags: 8, hint: "First line is the hook; hashtags after a break" },
  ig_story: { limit: 200, tags: 1, hint: "A sticker-length line" },
  x_post: { limit: 280, tags: 2, hint: "280 characters, one or two hashtags at most" },
  x_thread: { limit: 280, tags: 1, hint: "The opening post of the thread" },
  tt_video: { limit: 2200, tags: 4, hint: "Short and punchy, four hashtags" },
  li_post: { limit: 3000, tags: 3, hint: "Short paragraphs, three hashtags at the end" },
  pod_episode: { limit: 4000, tags: 0, hint: "Show notes: what it's about, who's on it" },
};
export const captionLimit = (space: SpaceId) => CAPTION[space]?.limit ?? 2200;

const stripTags = (s: string) => s.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const sentences = (s: string) => s.replace(/\n+/g, " ").match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
function fit(s: string, max: number) {
  if (s.length <= max) return s;
  let out = "";
  for (const x of sentences(s)) { if ((out ? out.length + 1 : 0) + x.length > max) break; out = out ? `${out} ${x}` : x; }
  return out || `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** A caption fitted to one space from the post's base caption: its length, line breaks and hashtags (your best tags
 *  first). The starting point the page and Claude edit from, never sent without being seen. */
export function adaptCaption(base: string, space: SpaceId, o: { title?: string; tags?: string[] } = {}): string {
  const rule = CAPTION[space] ?? { limit: 2200, tags: 5, hint: "" };
  const own = (base.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase());
  let tags = [...new Set([...own, ...(o.tags ?? []).map((t) => (t.startsWith("#") ? t : `#${t}`).toLowerCase())])];
  if (space === "yt_short") tags = ["#shorts", ...tags.filter((t) => t !== "#shorts")];
  tags = tags.slice(0, rule.tags);
  const body = stripTags(base) || (o.title ?? "");
  const tagLine = tags.join(" ");
  switch (space) {
    case "x_post": case "x_thread": case "ig_story": {
      const room = rule.limit - (tagLine ? tagLine.length + 1 : 0);
      return [fit(body, room), tagLine].filter(Boolean).join(" ");
    }
    case "li_post":
      return fit([sentences(body).join("\n\n"), tagLine].filter(Boolean).join("\n\n"), rule.limit);
    case "yt_video":
      return fit([body, tagLine].filter(Boolean).join("\n\n"), rule.limit);
    case "tt_video":
      return [fit(body, 150), tagLine].filter(Boolean).join(" ");
    case "yt_post":
      return fit(/\?\s*$/.test(body) ? body : `${body}\n\nWhat do you think?`, rule.limit);
    default:
      return fit([body, tagLine].filter(Boolean).join("\n\n"), rule.limit);
  }
}

/* ───────────── the weekly digest */

export type Idea = { title: string; why: string; fmt: Fmt | null; from: "follow-up" | "rival" | "format" | "gap" };
export type Digest = {
  from: number; to: number;
  posts: number; prev_posts: number; views: number; prev_views: number;
  hits: number; median_score: number | null;
  best: WItem[]; worst: WItem[]; rivals: WRival[]; gaps: string[]; ideas: Idea[];
  /** one sentence that sums the week up */
  line: string;
};

const FMT_NAME: Record<Fmt, string> = { yt_video: "YouTube video", yt_short: "Short", ig_reel: "Reel", ig_post: "Instagram post" };
const x = (v: number) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}×`;

/** The last seven days against the seven before: what worked, what didn't, what rivals did, and what to post next. */
export function weeklyDigest(items: WItem[], rivals: WRival[], lengths: { label: string; n: number; median: number }[] = [], now = Date.now()): Digest {
  const D = 86_400_000, from = now - 7 * D;
  const week = items.filter((i) => i.at >= from && i.at <= now), prev = items.filter((i) => i.at >= from - 7 * D && i.at < from);
  const sumV = (xs: WItem[]) => xs.reduce((s, i) => s + (i.views ?? 0), 0);
  const rated = week.filter((i) => i.score != null).sort((a, b) => b.score! - a.score!);
  const best = rated.filter((i) => i.score! >= 1).slice(0, 3);
  const worst = rated.filter((i) => i.score! < 0.7).slice(-2).reverse();
  const rw = rivals.filter((r) => r.at >= from && r.x != null && r.x >= HIT).sort((a, b) => b.x! - a.x!).slice(0, 6);
  // topics their hits are about that none of your titles in 90 days touch
  const mine = new Set(items.flatMap((i) => topicWords(i.title)));
  const count = new Map<string, number>();
  for (const r of rivals.filter((r) => r.x != null && r.x >= HIT && r.at >= now - 30 * D)) for (const w of topicWords(r.title)) if (!mine.has(w)) count.set(w, (count.get(w) ?? 0) + 1);
  const gaps = [...count].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);

  const ideas: Idea[] = [];
  const top = rated[0] ?? [...items].filter((i) => i.score != null).sort((a, b) => b.score! - a.score!)[0];
  if (top && top.score! >= 1.2) ideas.push({ title: `Follow-up: ${top.title.replace(/\s*\(part \d+\)$/i, "")} (part 2)`, why: `“${top.title.slice(0, 60)}” did ${x(top.score!)} your usual. Same hook, a new angle, linked back to it.`, fmt: top.fmt, from: "follow-up" });
  const rv = rw[0] ?? rivals.filter((r) => r.x != null && r.x >= HIT).sort((a, b) => b.x! - a.x!)[0];
  if (rv) ideas.push({ title: `Your take: ${rv.title}`, why: `${rv.name} got ${x(rv.x!)} their usual with it ${Math.max(1, Math.round((now - rv.at) / D))} days ago. Say what they missed.`, fmt: rv.fmt, from: "rival" });
  if (gaps.length >= 2) ideas.push({ title: `Your angle on “${gaps[0]}”`, why: `“${gaps[0]}” and “${gaps[1]}” keep showing up in your rivals' hits this month and in none of your titles.`, fmt: null, from: "gap" });
  const bestLen = [...lengths].filter((l) => l.n >= 2).sort((a, b) => b.median - a.median)[0];
  if (bestLen && ideas.length < 4) ideas.push({ title: `Another ${bestLen.label.toLowerCase()} one`, why: `${bestLen.label} posts get your most views (a median of ${bestLen.median.toLocaleString()}). Make the next one that length.`, fmt: null, from: "format" });

  const views = sumV(week), pv = sumV(prev);
  const scores = rated.map((i) => i.score!);
  const change = pv ? (views - pv) / pv : null;
  const line = !week.length
    ? prev.length ? "Nothing went out this week. One post keeps the channel warm; the ideas below are ready to start." : "No posts in the last two weeks yet. Start with one of the ideas below."
    : `${week.length} post${week.length === 1 ? "" : "s"} this week${change == null ? "" : `, views ${change >= 0 ? "up" : "down"} ${Math.abs(Math.round(change * 100))}% on the week before`}${best[0] ? `. “${best[0].title.slice(0, 50)}” led at ${x(best[0].score!)} your usual` : ""}.`;
  return {
    from, to: now, posts: week.length, prev_posts: prev.length, views, prev_views: pv,
    hits: scores.filter((s) => s >= HIT).length, median_score: median(scores),
    best, worst, rivals: rw, gaps, ideas, line,
  };
}

export const fmtName = (f: Fmt | null) => (f ? FMT_NAME[f] : "Any format");
