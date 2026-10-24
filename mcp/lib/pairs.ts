// Preference pairs for RLHF (DPO) on a trained Orpheus voice, any person's. Every reviewed voiceover in a trained voice
// leaves pairs.json on the worker (gateway._save_pairs): per chunk, the codec tokens of the take the review kept and of
// its worst take, with their scores. We keep one file per job, pairs/<name>/<job>.json, and when it's time to polish:
//  - automatic pairs (RLAIF): the kept take beats the worst one when the scores clearly differ;
//  - people's ratings count double: a 👍 line's takes are a sure pair; a 👎 line's kept take becomes the loser to any
//    other take of the same sentence.
// buildPairs() writes the training set to pairs/<name>/_build/<time>.json and hands the worker a signed link.
import { delObjs, getJson, listObjs, presign, putJson } from "./store";
import { call } from "./worker";

type Take = { take: number; picked: boolean; score: number; text: number | null; sim: number | null; missed: string[]; codes: number[] };
type PairsFile = { voice: string; speaker: string; chunks: { line: string; chunk: number; said: string; takes: Take[] }[]; job?: string };
export type Pair = { said: string; chosen: number[]; rejected: number[]; weight: number; from: string };

export const MIN_PAIRS = 100;   // below this a polish has too little to go on
export const GOOD_PAIRS = 200;  // what we ask for
const MIN_GAP = 0.04;           // automatic pairs need the scores to clearly disagree
const dir = (name: string) => `pairs/${name.replace(/[^a-z0-9_-]/g, "_")}/`;

/** A finished trained-voice voiceover: store its takes as pairs for that person. Idempotent. */
export async function archivePairs(job: { id: string; engine?: string; voice?: string; pairs?: { chunks: number; pairs: number } | null; mode?: string }) {
  if (job.engine !== "myvoice" || !job.pairs?.chunks || job.mode) return null;
  const { personOf } = await import("./coach");
  const name = await personOf(job.engine, job.voice);
  if (!name) return null;
  const key = `${dir(name)}${job.id}.json`;
  if ((await listObjs(key)).length) return key;
  const res = await call<{ failed: Record<string, string> }>(`/jobs/${job.id}/push`, { body: { targets: { "pairs.json": await presign(key, "PUT", 3600) }, headers: {} }, timeoutMs: 55_000 });
  return Object.keys(res.failed).length ? null : key;
}

async function files(name: string) {
  const objs = (await listObjs(dir(name))).filter((o) => o.key.endsWith(".json") && !o.key.includes("/_build/"));
  return (await Promise.all(objs.map(async (o) => ({ job: o.key.slice(dir(name).length, -5), f: await getJson<PairsFile>(o.key).catch(() => null) }))))
    .filter((x): x is { job: string; f: PairsFile } => !!x.f);
}

/** Every pair this person's takes and ratings make. */
export async function collectPairs(name: string): Promise<Pair[]> {
  const { ratingsFor } = await import("./coach");
  const rated = await ratingsFor(name); // "job/line" -> 1 | -1
  const out: Pair[] = [];
  for (const { job, f } of await files(name)) {
    for (const ch of f.chunks) {
      const r = rated.get(`${job}/${ch.line}`) ?? 0;
      const kept = ch.takes.find((t) => t.picked);
      const other = ch.takes.find((t) => !t.picked);
      if (!kept || !other) continue;
      if (r < 0) out.push({ said: ch.said, chosen: other.codes, rejected: kept.codes, weight: 2, from: "you: 👎" });
      else if (r > 0) out.push({ said: ch.said, chosen: kept.codes, rejected: other.codes, weight: 2, from: "you: 👍" });
      else if (kept.score - other.score >= MIN_GAP) out.push({ said: ch.said, chosen: kept.codes, rejected: other.codes, weight: 1, from: "review" });
    }
  }
  return out;
}

export async function pairStats(name: string) {
  const all = await collectPairs(name).catch(() => [] as Pair[]);
  return { pairs: all.length, from_you: all.filter((p) => p.weight > 1).length, min: MIN_PAIRS, good: GOOD_PAIRS };
}

/** The worker body for an RLHF polish of <name>'s Orpheus model in use. */
export async function dpoJobBody(name: string) {
  const { listModels, gateLink } = await import("./voicemodel");
  const live = (await listModels()).find((m) => m.name === name);
  if (!live) throw new Error(`${name} has no trained Orpheus model yet: train it first`);
  const pairs = await collectPairs(name);
  if (pairs.length < MIN_PAIRS) throw new Error(`${name} has ${pairs.length} preference pairs; a polish needs ${MIN_PAIRS} (${GOOD_PAIRS} is better). Make practice takes, or use the voice with Best of 2-3 takes.`);
  const key = `${dir(name)}_build/${Date.now()}.json`;
  await putJson(key, { pairs: pairs.map(({ said, chosen, rejected, weight }) => ({ said, chosen, rejected, weight })) });
  // keep the last three builds only
  const builds = (await listObjs(`${dir(name)}_build/`)).sort((a, b) => b.modified - a.modified);
  if (builds.length > 3) await delObjs(builds.slice(3).map((o) => o.key));
  return { kind: "train", method: "dpo", engine: "orpheus", name, adapter: await gateLink(name, live.job), pairs_url: await presign(key, "GET", 12 * 3600),
    pairs: pairs.length, minutes: live.minutes, speaker: live.speaker, label: `Polish with feedback · ${name}` };
}

/** Practice takes: sentences from the coach's bank voiced 3 times each, so the review has winners and losers to learn from. */
export async function practiceJobBody(name: string, count = 40) {
  const { BANK } = await import("./coachbank");
  const all = Object.values(BANK).flat().filter((s) => s.split(" ").length >= 6);
  const pick = all.sort(() => Math.random() - 0.5).slice(0, Math.max(10, Math.min(60, count)));
  return { engine: "myvoice", voice: name, takes: 3, review: true, platform: "raw", style: "tech", label: `Practice takes · ${name}`,
    lines: pick.map((text, i) => ({ id: `p${String(i + 1).padStart(2, "0")}`, text })) };
}
