// Memory (docs/AUTOMATION.md, block 10 and the learning loop): what carries across sessions and models. Notes are
// decisions and facts anyone can read back by key or search; lessons are what the audit (or a model, or the owner)
// learned, with the evidence, suggested → approved by the owner (→ promoted into docs/FEEDBACK.md by a PR); skills are
// scripts that worked, saved by name, that a `run` can import (from skills import <name>). playbook serves the
// approved lessons and the skills to every model.
import { randomBytes } from "node:crypto";
import { getJson } from "../store";
import { mutate } from "./control";

const NOTES = "auto/notes.json", LESSONS = "auto/lessons.json", SKILLS = "auto/skills.json";

export type Note = { key: string; text: string; tags: string[]; by: string; at: number };
export type Evidence = { at: number; model: string; tool: string; what: string };
export type Lesson = {
  id: string; text: string; topic: string; evidence: Evidence[]; status: "suggested" | "approved" | "rejected" | "promoted";
  by: string; created: number; decided?: number; decided_by?: string; seen: number; pr?: string;
};
export type Skill = { name: string; about: string; code: string; by: string; at: number; uses: number };

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? []);
const score = (q: string, text: string) => { const w = words(text); return [...words(q)].filter((x) => w.has(x)).length; };

// ── notes ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function notes() { return (await getJson<{ list: Note[] }>(NOTES).catch(() => null))?.list ?? []; }
export async function setNote(key: string, text: string, tags: string[], by: string) {
  const k = key.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").slice(0, 80);
  if (!k) throw new Error("key: a short name, e.g. brand/colours");
  await mutate<{ list: Note[] }>(NOTES, { list: [] }, (b) => ({
    list: text ? [{ key: k, text: text.slice(0, 4000), tags: tags.slice(0, 8), by, at: Date.now() }, ...b.list.filter((n) => n.key !== k)].slice(0, 500) : b.list.filter((n) => n.key !== k),
  }));
  return k;
}
export async function findNotes(q?: string) {
  const all = await notes();
  if (!q) return all.slice(0, 50);
  return all.map((n) => ({ n, s: score(q, `${n.key} ${n.tags.join(" ")} ${n.text}`) + (n.key.includes(q.toLowerCase()) ? 3 : 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 20).map((x) => x.n);
}

// ── lessons ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function lessons() { return (await getJson<{ list: Lesson[] }>(LESSONS).catch(() => null))?.list ?? []; }

/** A lesson (suggested). The same lesson again adds its evidence and counts it seen, instead of a duplicate. */
export async function addLesson(l: { text: string; topic?: string; evidence?: Evidence[]; by: string; key?: string }) {
  let out: Lesson | null = null;
  await mutate<{ list: Lesson[] }>(LESSONS, { list: [] }, (b) => {
    const same = b.list.find((x) => x.status !== "rejected" && (x.text.toLowerCase() === l.text.toLowerCase() || (l.key && x.id === l.key)));
    if (same) {
      // seen again only when there's new evidence (an audit re-reading the same hours doesn't count it twice)
      const known = new Set(same.evidence.map((e) => `${e.at}|${e.tool}|${e.model}`));
      const fresh = (l.evidence ?? []).filter((e) => !known.has(`${e.at}|${e.tool}|${e.model}`));
      out = { ...same, seen: same.seen + (fresh.length || !l.evidence?.length ? 1 : 0), evidence: [...fresh, ...same.evidence].slice(0, 12) };
      return { list: b.list.map((x) => (x.id === same.id ? out! : x)) };
    }
    out = { id: l.key ?? randomBytes(5).toString("hex"), text: l.text.slice(0, 600), topic: (l.topic ?? "general").slice(0, 40), evidence: (l.evidence ?? []).slice(0, 12),
      status: "suggested", by: l.by, created: Date.now(), seen: 1 };
    return { list: [out, ...b.list].slice(0, 400) };
  });
  return out!;
}

export async function decideLesson(id: string, status: "approved" | "rejected" | "promoted", by: string, patch: { text?: string; pr?: string } = {}) {
  let out: Lesson | null = null;
  await mutate<{ list: Lesson[] }>(LESSONS, { list: [] }, (b) => ({
    list: b.list.map((x) => (x.id === id ? (out = { ...x, ...(patch.text ? { text: patch.text.slice(0, 600) } : {}), ...(patch.pr ? { pr: patch.pr } : {}), status, decided: Date.now(), decided_by: by }) : x)),
  }));
  if (!out) throw new Error("no such lesson");
  return out as Lesson;
}

/** The lessons that hold (approved or promoted), the ones matching a query first. */
export async function servedLessons(q?: string, limit = 12) {
  const live = (await lessons()).filter((l) => l.status === "approved" || l.status === "promoted");
  if (!q) return live.slice(0, limit);
  return live.map((l) => ({ l, s: score(q, `${l.topic} ${l.text}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.l);
}

/** Promote: the lesson becomes a rule in docs/FEEDBACK.md through a PR on the studio's repo (the owner merges it). */
export async function promote(id: string, by: string) {
  const l = (await lessons()).find((x) => x.id === id);
  if (!l) throw new Error("no such lesson");
  if (l.status === "suggested") throw new Error("approve it first");
  const r = await import("./repo");
  const repo = await r.allowed(r.PLATFORM).catch(() => { throw new Error(`promoting needs ${r.PLATFORM} on the repo allow-list and GITHUB_AGENT_TOKEN; it's served to every model already`); });
  const cur = await r.read(repo, "docs/FEEDBACK.md", undefined, 1, 100_000);
  const text = cur.text.split("\n").map((x) => x.replace(/^\d+\t/, "")).join("\n");
  const head = "## Lessons from the models";
  const intro = "Lessons the audit found and the owner approved (lib/auto/memory.ts), newest first.";
  const bullet = `- **${l.topic}**: ${l.text} (seen ${l.seen}×, approved by ${l.decided_by ?? by})`;
  // newest first, under the section's line; the section goes above the first round of feedback the first time
  const next = text.includes(intro) ? text.replace(intro, `${intro}\n\n${bullet}`).replace(`${bullet}\n\n- `, `${bullet}\n- `) :
    text.replace(/\n## /, `\n${head}\n\n${intro}\n\n${bullet}\n\n## `);
  const branch = `lessons/${l.id}`;
  await r.commit(repo, branch, [{ path: "docs/FEEDBACK.md", content: next }], `Lesson: ${l.text.slice(0, 60)}`, `auditor (${by})`);
  const pr = await r.openPr(repo, branch, `Lesson: ${l.text.slice(0, 70)}`, `${l.text}\n\nEvidence:\n${l.evidence.map((e) => `- ${new Date(e.at).toISOString().slice(0, 16)} ${e.model} ${e.tool}: ${e.what}`).join("\n")}`, `auditor (${by})`);
  await decideLesson(id, "promoted", by, { pr: pr.url });
  return pr;
}

// ── skills ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function skills() { return (await getJson<{ list: Skill[] }>(SKILLS).catch(() => null))?.list ?? []; }
export async function saveSkill(s: { name: string; about: string; code: string; by: string }) {
  const name = s.name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) throw new Error("name: a Python module name (letters, digits, _), e.g. reel_cutter");
  if (s.code.length > 100_000) throw new Error("code: up to 100,000 characters");
  await mutate<{ list: Skill[] }>(SKILLS, { list: [] }, (b) => {
    const have = b.list.find((x) => x.name === name);
    return { list: [{ name, about: s.about.slice(0, 300), code: s.code, by: s.by, at: Date.now(), uses: have?.uses ?? 0 }, ...b.list.filter((x) => x.name !== name)].slice(0, 200) };
  });
  return name;
}
export async function skillCode(names: string[]) {
  const all = await skills();
  const out: Record<string, string> = {};
  for (const n of names) {
    const s = all.find((x) => x.name === n);
    if (!s) throw new Error(`no skill ${n} (memory action skills lists them)`);
    out[n] = s.code;
  }
  if (names.length) await mutate<{ list: Skill[] }>(SKILLS, { list: [] }, (b) => ({ list: b.list.map((x) => (names.includes(x.name) ? { ...x, uses: x.uses + 1 } : x)) })).catch(() => null);
  return out;
}
export async function findSkills(q?: string) {
  const all = await skills();
  const list = q ? all.map((s) => ({ s, n: score(q, `${s.name.replace(/_/g, " ")} ${s.about}`) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.s) : all;
  return list.slice(0, 20).map(({ code, ...rest }) => ({ ...rest, lines: code.split("\n").length }));
}
