// What each voice has learned. Every reviewed voiceover reports its trials (each take of each sentence: the
// temperature it used, how faithfully it read the script, how much it sounded like the recording). We keep a running
// tally per engine + voice in R2 and, once there's enough evidence, feed back:
//  - sim_base: the similarity this voice normally reaches, so "drifted off-voice" is judged against the voice itself;
//  - params.temperature: the setting that has scored best for this voice, used whenever a request doesn't set one.
import { getJson, putJson } from "./store";

type Bucket = { n: number; sum: number };
export type Profile = { engine: string; voice: string; style: string; sims: number[]; temps: Record<string, Bucket>; jobs: number; updated: number };
export type Trial = { engine: string; temperature?: number | null; text?: number | null; sim?: number | null; mos?: number | null; picked?: boolean };

// per engine + voice + delivery style: a hype read and a calm narration want different settings
const safe = (x: string) => x.replace(/[^A-Za-z0-9_-]/g, "_");
const key = (engine: string, voice: string, style = "tech") => `profiles/${engine}/${safe(voice)}/${safe(style)}.json`;
const MIN_TEMP_TRIALS = 3; // per setting
const MIN_TOTAL = 10;      // across settings, before a learned temperature is used
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** One trial's quality, on the same footing for every setting: script accuracy first, voice match second. */
const quality = (t: Trial) => (t.text ?? 0) + 0.5 * (t.sim ?? 0) + (t.mos != null ? 0.05 * (t.mos - 3.5) : 0);

export async function getProfile(engine: string, voice: string, style?: string) {
  return getJson<Profile>(key(engine, voice, style)).catch(() => null);
}

export async function learnFromJob(job: { engine?: string; voice?: string; style?: string; trials?: Trial[] | null; mode?: string }) {
  if (!job.engine || !job.voice || !job.trials?.length || job.mode) return null;
  const mine = job.trials.filter((t) => t.engine === job.engine);
  if (!mine.length) return null;
  const style = job.style || "tech";
  const p: Profile = (await getProfile(job.engine, job.voice, style)) ?? { engine: job.engine, voice: job.voice, style, sims: [], temps: {}, jobs: 0, updated: 0 };
  for (const t of mine) {
    if (t.picked && t.sim != null) p.sims.push(t.sim);
    if (t.temperature != null && t.text != null) {
      const b = (p.temps[t.temperature.toFixed(2)] ??= { n: 0, sum: 0 });
      b.n += 1; b.sum += quality(t);
    }
  }
  p.sims = p.sims.slice(-80);
  p.jobs += 1;
  p.updated = Date.now();
  await putJson(key(job.engine, job.voice, style), p);
  return p;
}

/** What to send the worker for this voice: its usual similarity, and its best temperature once proven. */
export async function profileFor(engine?: string, voice?: string, style?: string) {
  if (!engine || !voice) return null;
  const p = await getProfile(engine, voice, style);
  if (!p) return null;
  const out: { sim_base?: number; params?: Record<string, number> } = {};
  if (p.sims.length >= 5) out.sim_base = Math.round(median(p.sims)! * 1000) / 1000;
  const buckets = Object.entries(p.temps).filter(([, b]) => b.n >= MIN_TEMP_TRIALS);
  const total = Object.values(p.temps).reduce((s, b) => s + b.n, 0);
  if (buckets.length >= 2 && total >= MIN_TOTAL) {
    const [best] = buckets.sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)[0];
    out.params = { temperature: Number(best) };
  }
  return Object.keys(out).length ? out : null;
}

/** For the Voices page and MCP: a readable summary of what's been learned. */
export async function describeProfile(engine: string, voice: string, style = "tech") {
  const p = await getProfile(engine, voice, style);
  if (!p) return null;
  const learned = await profileFor(engine, voice, style);
  return {
    engine, voice, style, jobs: p.jobs, usual_similarity: learned?.sim_base ?? null, best_temperature: learned?.params?.temperature ?? null,
    settings_tried: Object.entries(p.temps).map(([t, b]) => ({ temperature: Number(t), trials: b.n, score: Math.round((b.sum / b.n) * 1000) / 1000 }))
      .sort((a, b) => a.temperature - b.temperature),
  };
}

/** Attach the learned profile to a voice job body (no-op when the voice has no history yet). */
export async function withProfile<T extends Record<string, unknown>>(body: T): Promise<T> {
  if (body.kind && body.kind !== "story") return body;
  const prof = await profileFor(body.engine as string | undefined, body.voice as string | undefined, (body.style as string | undefined) ?? "tech").catch(() => null);
  return prof ? { ...body, profile: prof } : body;
}
