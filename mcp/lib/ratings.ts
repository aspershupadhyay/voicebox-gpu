// Your 👍/👎 on voiced lines, for every voice (built-in, cloned or trained), one file per voice:
// ratings/<engine>/<voice>.json. Each entry keeps the line's text and the scores the review measured (script match,
// voice match), so the ratings can be checked against the scores and used to steer the voice: trained voices also
// feed the voice coach and preference training (coach.ts, pairs.ts).
import { getJson, putJson } from "./store";

export type Rated = { job: string; line: string; rating: 1 | -1; text: string; match: number | null; sim: number | null; duration: number; at: number };
type File = { engine: string; voice: string; lines: Rated[] };

const KEEP = 2000;
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "_";
const key = (engine: string, voice: string) => `ratings/${safe(engine)}/${safe(voice)}.json`;
const num = (x: unknown) => (typeof x === "number" && isFinite(x) ? Math.round(x * 1000) / 1000 : null);

/** Set (1 / -1) or clear (0) the rating of one line. */
export async function rateLine(input: { engine: string; voice: string; job: string; line: string; rating: number; text?: string; match?: unknown; sim?: unknown; duration?: number }) {
  if (!input.engine || !input.voice || !input.job || !input.line) throw new Error("engine, voice, job and line are required");
  const f = (await getJson<File>(key(input.engine, input.voice))) ?? { engine: input.engine, voice: input.voice, lines: [] };
  f.lines = f.lines.filter((l) => !(l.job === input.job && l.line === input.line));
  if (input.rating) f.lines = [...f.lines, { job: input.job, line: input.line, rating: (input.rating > 0 ? 1 : -1) as 1 | -1, text: String(input.text ?? "").slice(0, 600),
    match: num(input.match), sim: num(input.sim), duration: Number(input.duration) || 0, at: Date.now() }].slice(-KEEP);
  await putJson(key(input.engine, input.voice), f);
  return summary(f);
}

function summary(f: File) {
  const up = f.lines.filter((l) => l.rating > 0).length;
  return { engine: f.engine, voice: f.voice, rated: f.lines.length, up, down: f.lines.length - up };
}

/** How a voice has been rated, and the ratings of one job's lines (to show them again). */
export async function ratingsOf(engine: string, voice: string, job?: string) {
  const f = (await getJson<File>(key(engine, voice))) ?? { engine, voice, lines: [] };
  return { ...summary(f), lines: job ? Object.fromEntries(f.lines.filter((l) => l.job === job).map((l) => [l.line, l.rating])) : undefined };
}
