// The voice coach: how each trained voice (any person's Orpheus model or fine-tuned Qwen voice) gets better with use.
//  1. Every line a trained voice reads is kept with its scores: did it say the words (Whisper), does it still sound like
//     the person, does it sound natural (UTMOS), and how it was delivered (pitch spread, pace, pauses). People can rate a
//     line up or down too.
//  2. report() turns that into weak spots ("questions come out flat", "rushes long sentences", words it keeps missing).
//  3. nextScript() writes the next recording session around those weak spots (coachbank.ts). Recording it and adding it
//     to the dataset is what actually teaches the model: a model never trains on its own output.
//  4. With 15+ new minutes the dataset retrains itself (datasets.autoTrain), and a retrained model is compared with the
//     one in use on sentences neither has heard (startGate / resolveGate): it only replaces it if it scores at least as well.
// Stored per person in R2: coach/<name>.json, and coach/gates/<benchmark job>.json pointing back at the person.
import { BANK, CAT_LABEL, CAT_TIP, TEST, type Cat } from "./coachbank";
import { getJson, putJson } from "./store";
import { call } from "./worker";

export type Entry = {
  t: number; job: string; id: string; engine: string; text: string; cats: Cat[]; dur: number; words: number;
  match?: number | null; sim?: number | null; mos?: number | null; pitch?: number | null; pause?: number | null; missed?: string[]; rating?: 1 | -1;
};
export type Gate = {
  engine: "orpheus" | "qwen"; job: string; prev: string; bench?: string; stage: "comparing" | "promoted" | "kept" | "error";
  at: number; old?: number | null; new?: number | null; note?: string;
};
type Coach = { name: string; lines: Entry[]; given: string[]; gates: Gate[]; updated: number };
type Result = { id: string; text: string; duration: number; similarity?: number | null; spoken?: string;
  takes?: { match?: number | null; similarity?: number | null; mos?: number | null } | null;
  review?: { issues: { missed: string[] }[] } | null; delivery?: { pitch_st?: number | null; pause_s?: number | null } | null };

const KEEP = 400;          // lines remembered per person
const MIN_LINES = 8;       // before weak spots are called
export const RETRAIN_MINUTES = 15; // new recorded minutes that start a retrain (datasets.autoTrain): a retrain is 1-2 GPU hours
const TIE = 0.01;          // a retrained model within this of the old score still wins: it learned from more of you

const safe = (x: string) => x.replace(/[^a-z0-9_-]/g, "_");
const key = (name: string) => `coach/${safe(name)}.json`;
const gateKey = (bench: string) => `coach/gates/${safe(bench)}.json`;
const load = async (name: string): Promise<Coach> =>
  (await getJson<Coach>(key(name)).catch(() => null)) ?? { name, lines: [], given: [], gates: [], updated: 0 };
const save = (c: Coach) => putJson(key(c.name), { ...c, updated: Date.now() });
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const STOP = new Set("that this with have from they them then than what when your just like into over also very".split(" "));
const countWords = (s: string) => (s.match(/[A-Za-z0-9']+/g) ?? []).length;

/** Whose trained voice a job used: myvoice <name> (or "me" = the newest model), or qwen ft_<name>. Others aren't coached. */
export async function personOf(engine?: string, voice?: string): Promise<string | null> {
  if (!engine || !voice) return null;
  if (engine === "qwen") return voice.startsWith("ft_") && !voice.includes("--") ? voice.slice(3) : null;
  if (engine !== "myvoice" || voice.includes("--")) return null;
  if (["me", "default", "female", "male"].includes(voice)) {
    const { listModels } = await import("./voicemodel");
    return (await listModels())[0]?.name ?? null;
  }
  return voice;
}

export function categorize(text: string): Cat[] {
  const n = countWords(text);
  const cats: Cat[] = [];
  if (/\?/.test(text)) cats.push("question");
  if (/!|\b(wow|no way|wait|unbelievable|wild|whoa|oh no)\b/i.test(text)) cats.push("excited");
  if (/\d|\b(hundred|thousand|million|billion|trillion|percent|point (?:one|two|three|four|five|six|seven|eight|nine|oh|zero))\b/i.test(text)) cats.push("numbers");
  if (/\b[A-Z]{2,}[a-z]?s?\b/.test(text) || /\b(kubernetes|docker|pytorch|javascript|typescript|python|linux|postgres|redis|github|react|next\.?js|rust)\b/i.test(text)) cats.push("tech");
  if (n > 28) cats.push("long");
  if (n <= 5) cats.push("short");
  if (!cats.length) cats.push("story");
  return cats;
}

type Flag = "words" | "voice" | "robotic" | "flat" | "rushed" | "slow" | "pause" | "disliked";
export const FLAG_LABEL: Record<Flag, string> = {
  words: "skips or garbles words", voice: "drifts away from your voice", robotic: "sounds synthetic", flat: "flat, monotone delivery",
  rushed: "rushed", slow: "drags", pause: "odd long pauses", disliked: "rated down",
};
// what to record more of for each kind of problem
const FLAG_CATS: Record<Flag, Cat[]> = {
  words: ["tech", "numbers"], voice: ["story", "long"], robotic: ["story", "excited"], flat: ["excited", "question"],
  rushed: ["long", "short"], slow: ["short", "excited"], pause: ["long", "story"], disliked: [],
};

function flags(e: Entry, simBase: number | null): Flag[] {
  const out: Flag[] = [];
  if ((e.match != null && e.match < 0.9) || e.missed?.length) out.push("words");
  if (e.sim != null && simBase != null && e.sim < simBase - 0.06) out.push("voice");
  if (e.mos != null && e.mos < 3.0) out.push("robotic");
  if (e.pitch != null && e.pitch < 2.5 && e.words >= 6) out.push("flat");
  const wpm = e.dur > 0 ? (e.words / e.dur) * 60 : null;
  if (wpm != null && e.words >= 8 && wpm > 200) out.push("rushed");
  if (wpm != null && e.words >= 8 && wpm < 110) out.push("slow");
  if (e.pause != null && e.pause > 1.3 && !/\[pause|\.\.\.|…/i.test(e.text)) out.push("pause");
  if (e.rating === -1) out.push("disliked");
  return out;
}

function entryFrom(job: string, engine: string, r: Result): Entry {
  return {
    t: Date.now(), job, id: r.id, engine, text: r.text.slice(0, 400), cats: categorize(r.text), dur: r.duration, words: countWords(r.spoken || r.text),
    match: r.takes?.match ?? null, sim: r.takes?.similarity ?? r.similarity ?? null, mos: r.takes?.mos ?? null,
    pitch: r.delivery?.pitch_st ?? null, pause: r.delivery?.pause_s ?? null,
    missed: [...new Set((r.review?.issues ?? []).flatMap((i) => i.missed))].slice(0, 12),
  };
}

/** A finished voiceover (archived to the library): remember how every line went, if a trained voice read it. */
export async function recordJob(job: { id: string; kind?: string; mode?: string; engine?: string; voice?: string; results: Result[] }) {
  if ((job.kind && job.kind !== "tts") || job.mode) return null;
  const name = await personOf(job.engine, job.voice);
  if (!name || !job.results?.length) return null;
  const c = await load(name);
  const have = new Set(c.lines.map((l) => `${l.job}/${l.id}`));
  const add = job.results.filter((r) => r.text && r.duration > 0 && !have.has(`${job.id}/${r.id}`)).map((r) => entryFrom(job.id, job.engine!, r));
  if (!add.length) return null;
  c.lines = [...c.lines, ...add].slice(-KEEP);
  await save(c);
  return add.length;
}

/** Every rated line of this person: "job/line" -> 1 | -1 (the pair builder counts these double). */
export async function ratingsFor(name: string) {
  const c = await load(name);
  return new Map(c.lines.filter((l) => l.rating).map((l) => [`${l.job}/${l.id}`, l.rating as number]));
}

/** A thumbs up / down on one line (0 clears it). Lines that were never recorded (an older job) are added from what the page sends. */
export async function rate(input: { engine: string; voice: string; job: string; line: string; rating: number; text?: string; duration?: number }) {
  const name = await personOf(input.engine, input.voice);
  if (!name) throw new Error("only lines read by a trained voice (Your model, or ft_ on Qwen3-TTS) can be rated");
  const c = await load(name);
  let e = c.lines.find((l) => l.job === input.job && l.id === input.line);
  if (!e) {
    if (!input.text) throw new Error("that line isn't known yet: send its text");
    e = entryFrom(input.job, input.engine, { id: input.line, text: input.text, duration: Number(input.duration) || 0 });
    c.lines = [...c.lines, e].slice(-KEEP);
  }
  if (input.rating > 0) e.rating = 1; else if (input.rating < 0) e.rating = -1; else delete e.rating;
  await save(c);
  return { name, rating: e.rating ?? 0 };
}

type Spot = { cat: Cat; label: string; lines: number; problem_rate: number; issues: { flag: Flag; label: string; lines: number }[] };

function analyse(c: Coach) {
  const lines = c.lines;
  const simBase = median(lines.map((l) => l.sim).filter((x): x is number => x != null));
  const fl = lines.map((l) => flags(l, lines.length >= 5 ? simBase : null));
  const bad = fl.filter((f) => f.length).length;
  const overall = lines.length ? bad / lines.length : 0;
  const tally = (idx: number[]) => {
    const m = new Map<Flag, number>();
    idx.forEach((i) => fl[i].forEach((f) => m.set(f, (m.get(f) ?? 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([flag, n]) => ({ flag, label: FLAG_LABEL[flag], lines: n }));
  };
  const spots: (Spot & { excess: number })[] = (Object.keys(CAT_LABEL) as Cat[]).map((cat) => {
    const idx = lines.map((l, i) => (l.cats.includes(cat) ? i : -1)).filter((i) => i >= 0);
    const rateBad = idx.length ? idx.filter((i) => fl[i].length).length / idx.length : 0;
    return { cat, label: CAT_LABEL[cat], lines: idx.length, problem_rate: Math.round(rateBad * 100) / 100, issues: tally(idx),
      excess: (rateBad - overall) * Math.sqrt(idx.length) };
  });
  const weak = lines.length < MIN_LINES ? [] : spots
    .filter((s) => s.lines >= 3 && s.problem_rate >= Math.max(0.25, overall + 0.1))
    .sort((a, b) => b.excess - a.excess).slice(0, 3).map(({ excess: _, ...s }) => s);
  // problems that show up everywhere, whatever the sentence
  const everywhere = lines.length < MIN_LINES ? [] : tally(lines.map((_, i) => i)).filter((x) => x.lines >= 3 && x.lines / lines.length >= 0.15);
  const missed = new Map<string, number>();
  // little words ("a", "and") drop out of fast speech and Whisper alike: not a pronunciation problem
  lines.forEach((l) => l.missed?.forEach((w) => { const k = w.toLowerCase(); if (k.length > 3 && !STOP.has(k)) missed.set(k, (missed.get(k) ?? 0) + 1); }));
  const words = [...missed.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([word, times]) => ({ word, times }));
  return { simBase, overall, spots: spots.map(({ excess: _, ...s }) => s), weak, everywhere, words };
}

/** What the coach has learned about one voice: how it's doing, where it's weak, what to record next. */
export async function report(name: string) {
  const c = await load(name);
  await refreshGate(c).catch(() => null);
  const a = analyse(c);
  const avg = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 1000) / 1000 : null; };
  const recent = c.lines.slice(-60);
  return {
    name, lines: c.lines.length, rated_up: c.lines.filter((l) => l.rating === 1).length, rated_down: c.lines.filter((l) => l.rating === -1).length,
    recent: { lines: recent.length, words: avg(recent.map((l) => l.match)), like_you: avg(recent.map((l) => l.sim)), natural: avg(recent.map((l) => l.mos)),
      pitch_spread: avg(recent.map((l) => l.pitch)) },
    problem_rate: Math.round(a.overall * 100) / 100, weak_spots: a.weak, everywhere: a.everywhere, missed_words: a.words,
    by_kind: a.spots.filter((s) => s.lines > 0), focus: focusOf(a).map((cat) => ({ cat, label: CAT_LABEL[cat] })),
    enough: c.lines.length >= MIN_LINES, gates: c.gates.slice(0, 6), retrain_minutes: RETRAIN_MINUTES,
    feedback: await (await import("./pairs")).pairStats(name),
  };
}

function focusOf(a: ReturnType<typeof analyse>): Cat[] {
  const out = new Set<Cat>(a.weak.map((s) => s.cat));
  a.everywhere.forEach((x) => FLAG_CATS[x.flag].forEach((cat) => out.add(cat)));
  return [...out].slice(0, 3);
}

// sentences that put a word the voice keeps missing in a few natural places
const WORD_LINES = [
  (w: string) => `Let's talk about ${w}, because ${w} is the part people get wrong.`,
  (w: string) => `Once ${w} clicks, everything else makes sense.`,
  (w: string) => `I use ${w} almost every day.`,
];

const shuffle = <T,>(xs: T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** The next recording session for this voice, ~minutes long at a natural pace: more of what it's weak at, a spread of
 *  everything else, and its missed words in context. Sentences aren't repeated across scripts until the bank runs out. */
export async function nextScript(name: string, minutes = 8) {
  const c = await load(name);
  const a = analyse(c);
  const focus = focusOf(a);
  const budget = Math.max(2, Math.min(20, minutes)) * 150; // words, at about 150 a minute
  const given = new Set(c.given);
  const pool = (cat: Cat) => { let p = BANK[cat].filter((s) => !given.has(s)); if (!p.length) { BANK[cat].forEach((s) => given.delete(s)); p = [...BANK[cat]]; } return shuffle(p); };
  const cats = Object.keys(BANK) as Cat[];
  const share: Record<string, number> = {};
  const rest = cats.filter((x) => !focus.includes(x));
  for (const cat of cats) share[cat] = focus.length ? (focus.includes(cat) ? 0.6 / focus.length : 0.4 / rest.length) : 1 / cats.length;
  const picked: { text: string; cat: Cat | "word" }[] = [];
  for (const w of a.words.slice(0, 5)) picked.push({ text: WORD_LINES[picked.length % WORD_LINES.length](w.word), cat: "word" });
  const lists: Record<string, { text: string; cat: Cat }[]> = {};
  for (const cat of cats) {
    const want = share[cat] * budget;
    let n = 0;
    lists[cat] = [];
    for (const s of pool(cat)) { if (n >= want) break; lists[cat].push({ text: s, cat }); n += countWords(s); }
  }
  // interleave the groups so the session keeps changing mood, like a real video
  for (let i = 0; Object.values(lists).some((l) => i < l.length); i++) for (const cat of shuffle(cats)) if (lists[cat][i]) picked.push(lists[cat][i]);
  picked.forEach((p) => given.add(p.text));
  c.given = [...given].slice(-600);
  await save(c);
  const words = picked.reduce((s, p) => s + countWords(p.text), 0);
  return {
    name, minutes: Math.round((words / 150) * 10) / 10, focus: focus.map((cat) => ({ cat, label: CAT_LABEL[cat], tip: CAT_TIP[cat] })),
    words_to_practise: a.words.slice(0, 5).map((w) => w.word), lines: picked,
    how: "Read it in one or two sessions on the Your model page (Add recordings → Read along) or record it anywhere and upload it. With Train automatically on, "
      + `${RETRAIN_MINUTES}+ new minutes retrain the voice, and the new model only replaces the current one if it scores at least as well.`,
  };
}

// ── the comparison gate: a retrained model only goes live if it holds up ───────────────────────────────────────────

const ENGINE = { orpheus: "myvoice", qwen: "qwen" } as const;
const voiceFor = (eng: "orpheus" | "qwen", name: string, fresh: boolean) => `${eng === "qwen" ? "ft_" : ""}${name}${fresh ? "--new" : ""}`;

/** A model just finished training for a person who already has one: voice the TEST sentences with both (same settings),
 *  scored like the benchmark, and switch only if the new one does at least as well. */
export async function startGate(name: string, eng: "orpheus" | "qwen", job: string, prev: string, link: Record<string, unknown>) {
  const c = await load(name);
  if (c.gates.some((g) => g.job === job && g.stage !== "error")) return c.gates.find((g) => g.job === job)!;
  const { refSync, getMyVoice } = await import("./voices");
  const { profileFor } = await import("./profiles");
  const engine = ENGINE[eng];
  const target = (await getMyVoice(name)) ? await refSync(name) : null;
  const params = (await profileFor(engine, voiceFor(eng, name, false), "tech").catch(() => null))?.params ?? {};
  let body: Record<string, unknown> = {
    kind: "benchmark", label: `Model check · ${name}`, style: "tech", platform: "youtube", lines: TEST,
    candidates: [{ engine, voice: voiceFor(eng, name, false), label: "Current model", params }, { engine, voice: voiceFor(eng, name, true), label: "New model", params }],
    ...(target ? { target_voice: name, target_ref: target, refs: { [name]: target } } : {}),
  };
  if (eng === "qwen") body = { ...body, qmodels: { ...(await (await import("./qwenmodels")).qwenModelLinks()), [`${name}--new`]: link } };
  else body = { ...body, models: { ...(await (await import("./voicemodel")).modelLinks()), [`${name}--new`]: link } };
  const g: Gate = { engine: eng, job, prev, stage: "comparing", at: Date.now() };
  try {
    const j = await call<{ id: string }>("/jobs", { body });
    g.bench = j.id;
    await putJson(gateKey(j.id), { name });
  } catch (e) {
    g.stage = "error";
    g.note = `couldn't start the comparison: ${(e as Error).message}`;
  }
  c.gates = [g, ...c.gates.filter((x) => x.job !== job)].slice(0, 20);
  await save(c);
  return g;
}

async function promote(name: string, g: Gate) {
  if (g.engine === "qwen") await (await import("./qwenmodels")).promoteQwenModel(name, g.job);
  else await (await import("./voicemodel")).promoteModel(name, g.job);
}

/** Storage: keep the model in use, the one before it and the newest candidate; delete older ones. */
async function prune(name: string, g: Gate) {
  const lib = g.engine === "qwen" ? await import("./qwenmodels") : await import("./voicemodel");
  await lib.pruneModels(name).catch(() => null);
}

type BenchJob = { id: string; status: string; error?: string | null; benchmark?: { candidates: { label: string; score?: number | null; error?: string }[] } | null };

/** A finished (or failed) comparison: decide, and switch the model when the new one held up. Idempotent. */
export async function resolveGate(job: BenchJob) {
  const ref = await getJson<{ name: string }>(gateKey(job.id)).catch(() => null);
  if (!ref) return null;
  const c = await load(ref.name);
  const g = c.gates.find((x) => x.bench === job.id);
  if (!g || g.stage !== "comparing" || ["queued", "running"].includes(job.status)) return g ?? null;
  if (job.status !== "done") {
    g.stage = "error";
    g.note = `the comparison ${job.status === "cancelled" ? "was cancelled" : `failed: ${job.error ?? "unknown error"}`}; the current model stays`;
  } else {
    const by = (l: string) => job.benchmark?.candidates.find((x) => x.label === l);
    const old = by("Current model"), neu = by("New model");
    g.old = old?.score ?? null;
    g.new = neu?.score ?? null;
    if (!neu || neu.error || g.new == null) {
      g.stage = "kept";
      g.note = `the new model couldn't voice the test (${neu?.error?.slice(0, 120) ?? "no score"}); the current one stays`;
    } else if (!old || old.error || g.old == null || g.new >= g.old - TIE) {
      await promote(ref.name, g);
      g.stage = "promoted";
      g.note = g.old == null ? "switched to the new model" : `switched: the new model scored ${g.new.toFixed(3)} vs ${g.old.toFixed(3)}`;
    } else {
      g.stage = "kept";
      g.note = `kept the current model: it scored ${g.old.toFixed(3)}, the new one ${g.new.toFixed(3)}. Record a little more and it retrains.`;
    }
  }
  g.at = Date.now();
  await save(c);
  await prune(ref.name, g);
  return g;
}

/** A comparison still marked running: look it up on the worker (it may have finished with nobody watching). */
async function refreshGate(c: Coach) {
  const g = c.gates.find((x) => x.stage === "comparing" && x.bench);
  if (!g) return;
  const j = await call<BenchJob & { kind?: string }>(`/jobs/${g.bench}`).catch((e: Error) => (/404|not found/i.test(e.message) ? null : undefined));
  if (j === undefined) return; // offline: ask again later
  if (j === null) {
    if (Date.now() - g.at < 3 * 3600_000) return;
    g.stage = "error";
    g.note = "the comparison never finished (the worker restarted?); the current model stays";
    await save(c);
    return;
  }
  if (j.status === "done") {
    const { archiveWorkerJob } = await import("./library");
    await archiveWorkerJob(j as unknown as Parameters<typeof archiveWorkerJob>[0]).catch(() => null);
  }
  const done = await resolveGate(j);
  if (done) Object.assign(g, done);
}

/** Buttons on the Your model page: compare again, or use the new model anyway. */
export async function gateAction(name: string, action: "use" | "compare", job: string) {
  const c = await load(name);
  const g = c.gates.find((x) => x.job === job);
  if (!g) throw new Error("no comparison for that model");
  if (action === "use") {
    await promote(name, g);
    g.stage = "promoted";
    g.note = "switched by hand";
    g.at = Date.now();
    await save(c);
    return g;
  }
  const { gateLink } = g.engine === "qwen" ? await import("./qwenmodels") : await import("./voicemodel");
  c.gates = c.gates.filter((x) => x !== g);
  await save(c);
  return startGate(name, g.engine, g.job, g.prev, await gateLink(name, g.job));
}
