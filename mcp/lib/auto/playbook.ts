// The know-how a model reads before it works (docs/AUTOMATION.md, block 3): the repo's rules and docs by section
// (generated into playbook-docs.ts at deploy), searched by keyword, so a model reads the 40 lines it needs instead of
// whole files. Lessons and saved skills join it in phase 8.
import { DOCS } from "./playbook-docs";

const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9'-]+/g) ?? [];
const STOP = new Set(["the", "and", "for", "with", "how", "what", "a", "an", "to", "of", "in", "on", "is", "it", "do", "i", "my", "our"]);

export function index() {
  return DOCS.map((d) => ({ doc: d.id, title: d.title, ...(d.about ? { about: d.about } : {}), sections: d.sections.map((s) => s.title) }));
}

export function read(docId: string, section?: string, part = 1) {
  const d = DOCS.find((x) => x.id === docId.toLowerCase().replace(/\.md$/, "").replace(/^docs\//, ""));
  if (!d) throw new Error(`no doc "${docId}": ${DOCS.map((x) => x.id).join(", ")}`);
  let secs = d.sections;
  if (section) {
    const q = section.toLowerCase();
    const n = Number(section);
    secs = Number.isInteger(n) && n >= 1 && n <= d.sections.length ? [d.sections[n - 1]] : d.sections.filter((s) => s.title.toLowerCase().includes(q));
    if (!secs.length) throw new Error(`no section like "${section}" in ${d.id}: ${d.sections.map((s, i) => `${i + 1}. ${s.title}`).join("; ")}`);
  }
  const body = secs.map((s) => `## ${s.title}\n\n${s.text}`).join("\n\n");
  const SIZE = 12_000;
  const parts = Math.max(1, Math.ceil(body.length / SIZE));
  const p = Math.min(Math.max(1, part), parts);
  return { doc: d.path, ...(section ? { sections: secs.map((s) => s.title) } : {}), part: `${p} of ${parts}`, text: body.slice((p - 1) * SIZE, p * SIZE) };
}

export function search(query: string, limit = 6) {
  const terms = [...new Set(words(query).filter((w) => !STOP.has(w)))];
  if (!terms.length) throw new Error("search needs a word or two, e.g. \"carousel slide shape\"");
  const hits: { doc: string; section: string; score: number; snippet: string }[] = [];
  for (const d of DOCS) for (const s of d.sections) {
    const title = s.title.toLowerCase(), text = s.text.toLowerCase();
    let score = 0, matched = 0;
    for (const t of terms) {
      const n = text.split(t).length - 1;
      if (title.includes(t)) score += 4;
      if (n) score += 1 + Math.min(n, 8) * 0.5;
      if (n || title.includes(t)) matched++;
    }
    score *= (matched / terms.length) ** 2; // a section with every word beats one that says one word a lot
    if (score < 2) continue; // a word in passing isn't a match
    const at = Math.max(0, ...terms.map((t) => text.indexOf(t)).filter((i) => i >= 0).slice(0, 1));
    const from = Math.max(0, at - 80);
    hits.push({ doc: d.id, section: s.title, score: Math.round(score * 10) / 10, snippet: `${from ? "…" : ""}${s.text.slice(from, from + 260).replace(/\s+/g, " ")}…` });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
