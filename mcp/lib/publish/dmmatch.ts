// Auto-DM's matching, with no server code in it, so the dashboard runs the very same checks as the webhook (the editor's
// "try a comment" answers as you type). Used by lib/publish/autodm.ts (automations), its comment rules, and the caption
// scan that finds "Comment CATCH" in a post.

export type DmMatch = "word" | "exact" | "fuzzy" | "any";
export type Matcher = { match: DmMatch; keywords: string[]; exclude: string[]; typos: number };

export const norm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/(\p{L})\1{2,}/gu, "$1$1").replace(/\s+/g, " ").trim();
export const tokens = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Damerau-Levenshtein (optimal string alignment), stopping early past `max`. */
export function distance(a: string, b: string, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}
const allowed = (kw: string, typos: number) => (typos > 0 ? typos : kw.length <= 3 ? 0 : kw.length <= 6 ? 1 : 2);

export function hasWord(t: string, kw: string) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(kw)}($|[^\\p{L}\\p{N}])`, "u").test(t);
}

/** Which keyword a text matches, or null. "any" answers "*". */
export function matchText(a: Matcher, text: string): string | null {
  const t = norm(text);
  if (a.exclude.some((x) => x && hasWord(t, norm(x)))) return null;
  if (a.match === "any") return t || text ? "*" : null;
  const toks = tokens(text);
  for (const k of a.keywords) {
    const kw = norm(k);
    if (!kw) continue;
    if (a.match === "exact") { if (toks.join(" ") === tokens(k).join(" ")) return k; continue; }
    if (hasWord(t, kw)) return k;
    if (a.match === "fuzzy") {
      const kt = tokens(k), n = kt.length, joined = kt.join(" "), max = allowed(joined.replace(/ /g, ""), a.typos);
      if (!max) continue;
      // a typo almost never changes the first letter, and keeping it stops look-alike words ("match" for CATCH)
      const near = (w: string) => w[0] === joined[0] && distance(w, joined, max) <= max;
      for (let i = 0; i + n <= toks.length; i++) if (near(toks.slice(i, i + n).join(" "))) return k;
      // "c a t c h" spelled out
      if (n === 1 && toks.length > 1 && toks.every((x) => x.length === 1) && near(toks.join(""))) return k;
    }
  }
  return null;
}

export const LINK = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|net|org|io|ly|me|co|app|link|xyz|shop|site)\b(\/\S*)?/i;

/** A comment rule: its words (as words, or with typos), or any link. */
export function modMatch(r: { words: string[]; match: "word" | "fuzzy"; links: boolean }, text: string): string | null {
  if (r.links && LINK.test(text)) return "a link";
  return r.words.length ? matchText({ match: r.match, keywords: r.words, exclude: [], typos: 0 }, text) : null;
}

const NOT_KEYWORDS = new Set("below here now down this that the a an it me us your our my and or if to for in on with link bio comments comment dm dms yes no below👇".split(" "));

/** "Comment CATCH below", "type 'PROMPT'", "DM me LINK": the keyword a caption asks for, or null. It must be in capitals
 * or in quotes, so "comment below" or "drop a comment" never count. */
export function keywordFrom(caption: string): string | null {
  const re = /\b(?:comment|type|reply|write|drop|dm\s+(?:me|us)|send\s+(?:me|us)|message\s+(?:me|us))(?:\s+(?:the\s+word|with|me|us))?\s*[:\-–]?\s*(["“'‘«]?)([\p{L}\p{N}]{2,24})(["”'’»]?)/giu;
  for (const m of caption.matchAll(re)) {
    const word = m[2], quoted = !!m[1] && !!m[3];
    if (NOT_KEYWORDS.has(word.toLowerCase())) continue;
    if (quoted || (word === word.toUpperCase() && /\p{Lu}/u.test(word))) return word.toUpperCase();
  }
  return null;
}

/** The first link written in a text, made https. */
export function firstLink(text: string | null | undefined): string | null {
  const m = /https?:\/\/[^\s"'<>)\]]+/i.exec(text ?? "");
  return m ? m[0].replace(/[.,!?;:]+$/, "") : null;
}

export const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i;
/** An email address written in a message, cleaned, or null. */
export function emailIn(text: string): string | null {
  const m = EMAIL.exec(text);
  return m ? m[0].toLowerCase().replace(/[.]+$/, "") : null;
}
