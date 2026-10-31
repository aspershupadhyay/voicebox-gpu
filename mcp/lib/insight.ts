// What each photo looks like, for smart search on the Files page. Two halves:
//  - here, on the server (sharp, no AI): the shape and the colours it's mostly made of, named (red, blue, white…) so "red" finds red photos;
//  - in the browser (components/smartsearch.ts): MobileCLIP, a small image-and-text model, turns each photo into 512
//    numbers and picks tags from a list of everyday things (bottle, strawberry, person, laptop…). Searching "red bottle"
//    compares the words' numbers with every photo's, so it finds photos nobody named or tagged. The browser sends the
//    numbers and tags back here so every device and the MCP tools share them.
// Kept in R2: workspace/insight/index.json (hash, shape, colours, tags per file) and workspace/insight/emb.json (the
// numbers, only the browser's search reads them). Every write is conditional and retried, like the carousels.
import { getMedia } from "./data";
import { catalog, type FileItem } from "./filemanager";
import { ITEM_RE } from "./filetree";
import { listSummaries, signer } from "./library";
import { getJsonTagged, putJson, putJsonIf } from "./store";
import { fileUrl } from "./workspace";

export type Look = { h: string | null; ar: number | null; c: string[]; hex: string | null; t?: string[]; e?: 1; at: number };
type Index = { v: 1; files: Record<string, Look> };
type Emb = { v: 1; model: string; files: Record<string, string> };

const KEY = "workspace/insight/index.json";
const EMB = "workspace/insight/emb.json";
export const MODEL = "Xenova/mobileclip_s0";

async function change<D, T>(key: string, empty: D, fn: (d: D) => T): Promise<T> {
  for (let i = 0; i < 6; i++) {
    const { value, etag } = await getJsonTagged<D>(key);
    const d = structuredClone(value ?? empty);
    const out = fn(d);
    if (await putJsonIf(key, d, etag).catch(() => false)) return out;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120 * (i + 1)));
  }
  const d = structuredClone((await getJsonTagged<D>(key)).value ?? empty);
  const out = fn(d);
  await putJson(key, d);
  return out;
}

export async function getIndex(): Promise<Index> {
  return (await getJsonTagged<Index>(KEY)).value ?? { v: 1, files: {} };
}
export async function getEmbeddings(): Promise<Emb> {
  return (await getJsonTagged<Emb>(EMB)).value ?? { v: 1, model: MODEL, files: {} };
}

// ── colours: every pixel of a 24×24 copy into a named colour; the names that cover 12% or more of it

const NAMES = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "black", "white", "grey"] as const;
export const COLOR_NAMES: readonly string[] = NAMES;
function nameOf(r: number, g: number, b: number): (typeof NAMES)[number] {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.13) return "black";
  if (l > 0.9 && s < 0.35) return "white";
  if (s < 0.16 || d < 0.08) return l > 0.72 ? "white" : l < 0.2 ? "black" : "grey";
  let h = 0;
  const R = r / 255, G = g / 255, B = b / 255;
  if (mx === R) h = ((G - B) / d) % 6; else if (mx === G) h = (B - R) / d + 2; else h = (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 14 || h >= 345) return l < 0.32 && s < 0.6 ? "brown" : "red";
  if (h < 40) return l < 0.45 ? "brown" : "orange";
  if (h < 66) return l < 0.3 ? "brown" : "yellow";
  if (h < 160) return "green";
  if (h < 196) return "teal";
  if (h < 256) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

async function look(url: string): Promise<Omit<Look, "at"> | null> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  const sharp = (await import("sharp")).default;
  const buf = Buffer.from(await r.arrayBuffer());
  const meta = await sharp(buf).metadata();
  const px = await sharp(buf).removeAlpha().resize(24, 24, { fit: "fill" }).raw().toBuffer();
  const count = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 2 < px.length; i += 3) {
    const k = nameOf(px[i], px[i + 1], px[i + 2]);
    const c = count.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += px[i]; c.g += px[i + 1]; c.b += px[i + 2];
    count.set(k, c);
  }
  const total = px.length / 3;
  const top = [...count].sort((a, b) => b[1].n - a[1].n);
  const c = top.filter(([, v]) => v.n / total >= 0.12).slice(0, 3).map(([k]) => k);
  const d = top[0]?.[1];
  const hex = d ? `#${[d.r, d.g, d.b].map((v) => Math.round(v / d.n).toString(16).padStart(2, "0")).join("")}` : null;
  return { h: null, ar: meta.width && meta.height ? +(meta.width / meta.height).toFixed(3) : null, c, hex };
}

/** Look at the photos nobody has looked at yet, for up to `budgetMs`. Returns how many are left. */
export async function scan(budgetMs = 20_000) {
  const until = Date.now() + budgetMs;
  const [{ items }, idx, sums] = await Promise.all([catalog(), getIndex(), listSummaries()]);
  const thumbs = new Map(sums.filter((j) => j.image).map((j) => [`g:${j.id}`, j.image!.thumb]));
  const todo = items.filter((i) => i.kind === "image" && !idx.files[i.id]?.at && (i.id.startsWith("m:") ? !!i.url : thumbs.has(i.id)));
  const sign = await signer(900);
  const done: Record<string, Omit<Look, "at" | "t" | "e">> = {};
  let n = 0;
  const work = async () => {
    while (n < todo.length && Date.now() < until - 2500) {
      const it = todo[n++];
      try {
        const url = it.id.startsWith("m:") ? await getMedia(it.id.slice(2)).then((m) => fileUrl(m, "preview", 64).replace("output=webp", "output=png")) : await sign(it.id.slice(2), thumbs.get(it.id)!);
        const l = await look(url);
        done[it.id] = l ?? { h: null, ar: null, c: [], hex: null };
      } catch { done[it.id] = { h: null, ar: null, c: [], hex: null }; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, work));
  if (Object.keys(done).length) await change<Index, void>(KEY, { v: 1, files: {} }, (d) => { for (const [k, v] of Object.entries(done)) d.files[k] = { ...d.files[k], ...v, at: Date.now() }; });
  return { looked: Object.keys(done).length, left: Math.max(0, todo.length - Object.keys(done).length) };
}

const TAG_RE = /^[a-z][a-z0-9 '-]{0,39}$/;
/** What the browser's model saw: tags and the 512 numbers (int8, base64) for each photo. */
export async function saveVision(rows: unknown) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, 64) as { id?: unknown; emb?: unknown; tags?: unknown }[];
  const ok = list.filter((r) => typeof r.id === "string" && ITEM_RE.test(r.id) && typeof r.emb === "string" && /^[A-Za-z0-9+/=_-]{600,800}$/.test(r.emb));
  if (!ok.length) return { saved: 0 };
  const tags = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase().trim()).filter((x) => TAG_RE.test(x)).slice(0, 8) : []);
  await change<Emb, void>(EMB, { v: 1, model: MODEL, files: {} }, (d) => { d.model = MODEL; for (const r of ok) d.files[r.id as string] = r.emb as string; });
  await change<Index, void>(KEY, { v: 1, files: {} }, (d) => {
    for (const r of ok) { const was = d.files[r.id as string] ?? { h: null, ar: null, c: [], hex: null, at: 0 }; d.files[r.id as string] = { ...was, t: tags(r.tags), e: 1 }; }
  });
  return { saved: ok.length };
}

/** For the browser: what's known about every photo (it works out which it hasn't seen from its own list). */
export async function insightForBrowser() {
  return { files: (await getIndex()).files, colors: COLOR_NAMES, model: MODEL };
}

// ── search (MCP and scripts): by name, tags and colours. Meaning-search lives in the browser, where the model runs.

export async function searchPhotos(query: string, limit = 30) {
  const [idx, { items }] = await Promise.all([getIndex(), catalog()]);
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const out: (FileItem & { score: number })[] = [];
  for (const i of items) {
    const l = idx.files[i.id];
    const hay = [i.name.toLowerCase(), ...(l?.t ?? []), ...(l?.c ?? [])];
    let score = 0;
    for (const w of words) {
      const stem = w.replace(/(es|s)$/, "");
      if (l?.c.includes(w)) score += 2;
      else if (l?.t?.some((t) => t === w || t === stem || t.split(" ").includes(stem))) score += 3;
      else if (hay[0].includes(w)) score += 1.5;
    }
    if (score) out.push({ ...i, tags: l?.t, colors: l?.c, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...i }) => ({ ...i, match: +(score / (words.length * 3)).toFixed(2) }));
}
