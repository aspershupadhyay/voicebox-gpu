// The shared ledger (docs/FACTORY.md E): agents never edit LEARNINGS.md, TOPICS.md or the scoreboard in a repo
// directly (two sessions doing it at once is a merge conflict). They add entries here, and one nightly PR folds the
// day's entries into those files for the owner to merge. Competing creatives (a judge picking the best of several
// models' hooks on one spine) keep their tally here too, so the factory learns which model is best at what.
import { randomBytes } from "node:crypto";
import { getJson, getJsonTagged, listObjs, putJson, putJsonIf, delObjs } from "../store";

export const LEDGER_FILES = ["LEARNINGS.md", "TOPICS.md", "SCOREBOARD.md", "SPEC.md"] as const;
export type Entry = { id: string; file: (typeof LEDGER_FILES)[number]; repo: string; text: string; by: string; at: number };
const KEY = (e: { at: number; id: string }) => `auto/ledger/pending/${e.at}-${e.id}.json`;
export const DEFAULT_REPO = "aspershupadhyay/videos-post";

export async function addEntry(file: Entry["file"], text: string, by: string, repo = DEFAULT_REPO) {
  const e: Entry = { id: randomBytes(4).toString("hex"), file, repo: repo.toLowerCase(), text: text.trim().slice(0, 2000), by, at: Date.now() };
  await putJson(KEY(e), e);
  return e;
}

export async function pending() {
  const objs = (await listObjs("auto/ledger/pending/")).sort((a, b) => a.key.localeCompare(b.key)).slice(0, 500);
  return (await Promise.all(objs.map((o) => getJson<Entry>(o.key).then((e) => (e ? { ...e, key: o.key } : null)).catch(() => null)))).filter((e): e is Entry & { key: string } => !!e);
}

/** Fold every pending entry into its file, one PR per repo (a branch ledger/<date>), and clear what went in. */
export async function fold(by: string) {
  const r = await import("./repo");
  const all = await pending();
  const day = new Date().toISOString().slice(0, 10);
  const out: { repo: string; pr?: string; entries: number; error?: string }[] = [];
  for (const repo of [...new Set(all.map((e) => e.repo))]) {
    const mine = all.filter((e) => e.repo === repo);
    try {
      await r.allowed(repo);
      const files = await Promise.all([...new Set(mine.map((e) => e.file))].map(async (file) => {
        const was = await r.readRaw(repo, file);
        const add = mine.filter((e) => e.file === file).map((e) => `- ${e.text.replace(/\n+/g, " ")} (${e.by}, ${new Date(e.at).toISOString().slice(0, 16)}Z)`).join("\n");
        return { path: file, content: `${was.replace(/\s*$/, "")}\n\n## From the agents (${day})\n\n${add}\n` };
      }));
      const branch = `ledger/${day}-${randomBytes(2).toString("hex")}`;
      await r.commit(repo, branch, files, `Ledger: ${mine.length} entries from the agents (${day})`, by);
      const pr = await r.openPr(repo, branch, `Ledger ${day}: ${mine.length} entries from the agents`, `The agents' notes for ${files.map((f) => f.path).join(", ")}, folded from the shared ledger (docs/FACTORY.md E). Merge to keep them.`, by) as { url?: string };
      await delObjs(mine.map((e) => e.key));
      out.push({ repo, pr: pr.url, entries: mine.length });
    } catch (e) {
      out.push({ repo, entries: mine.length, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/** Once a night (the first sweep after 02:00 UTC). */
export async function nightly() {
  const now = new Date();
  if (now.getUTCHours() < 2) return null;
  const mark = "auto/ledger/folded.json";
  const { value, etag } = await getJsonTagged<{ day: string }>(mark);
  const day = now.toISOString().slice(0, 10);
  if (value?.day === day || !(await putJsonIf(mark, { day }, etag))) return null;
  if (!(await pending()).length) return [];
  return fold("nightly ledger");
}

// ── competing creatives: the judge's tally per model ──────────────────────────────────────────────────────────────

type Tally = Record<string, { entries: number; wins: number; points: number }>;
export async function tally(results: { by: string; score: number; won: boolean }[], stage = "hook") {
  const key = `auto/ledger/tally-${stage}.json`;
  for (let i = 0; i < 5; i++) {
    const { value, etag } = await getJsonTagged<Tally>(key);
    const t = { ...(value ?? {}) };
    for (const r of results) {
      const x = (t[r.by] ??= { entries: 0, wins: 0, points: 0 });
      x.entries++; x.points += r.score; if (r.won) x.wins++;
    }
    if (await putJsonIf(key, t, etag)) return t;
  }
  return null;
}
export const getTally = async (stage = "hook") => (await getJson<Tally>(`auto/ledger/tally-${stage}.json`).catch(() => null)) ?? {};
