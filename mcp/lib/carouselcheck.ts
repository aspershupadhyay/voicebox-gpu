// Slide checks for a carousel before it goes to Instagram: each photo's size and shape (read from the first bytes of
// the original, so a 12 MB photo is never downloaded whole), and near-duplicates (a 64-bit difference hash of a tiny
// copy, compared pairwise). What each file measured is kept in R2 (workspace/carousel-checks/<media id>.json): files
// don't change, so a carousel is measured once.
import { getMedia } from "./data";
import { getJson, putJson } from "./store";
import { fileUrl, type Media } from "./workspace";

type Measured = { w: number | null; h: number | null; hash: string | null; v: 1 };
export type SlideCheck = { file_id: string; position: number; name: string; kind: string; w: number | null; h: number | null; issues: { level: "bad" | "warn"; text: string }[] };

const KEY = (id: string) => `workspace/carousel-checks/${id}.json`;

/** Width and height from an image's first bytes: PNG, JPEG, WebP, GIF. */
export function dims(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1], le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const u32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (b[0] === 0x89 && b[1] === 0x50) return { w: u32(16), h: u32(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: le16(6), h: le16(8) };
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (t === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (t === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (t === "VP8L") { const x = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (x & 0x3fff) + 1, h: ((x >> 14) & 0x3fff) + 1 }; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

/** A 64-bit difference hash of a 9×8 grey copy: near-identical photos differ in a few bits. */
async function dhash(m: Media) {
  const r = await fetch(fileUrl(m, "preview", 64).replace("output=webp", "output=png"), { cache: "no-store" });
  if (!r.ok) return null;
  const sharp = (await import("sharp")).default;
  const px = await sharp(Buffer.from(await r.arrayBuffer())).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? "1" : "0";
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

async function measure(m: Media): Promise<Measured> {
  const kept = await getJson<Measured>(KEY(m.$id)).catch(() => null);
  if (kept?.v === 1) return kept;
  let w: number | null = null, h: number | null = null;
  try {
    const r = await fetch(fileUrl(m), { headers: { Range: "bytes=0-131071" }, cache: "no-store" });
    const d = dims(new Uint8Array(await r.arrayBuffer()));
    if (d) ({ w, h } = d);
  } catch { /* unknown size: no size checks */ }
  const hash = await dhash(m).catch(() => null);
  const out: Measured = { w, h, hash, v: 1 };
  if (w || hash) await putJson(KEY(m.$id), out).catch(() => null);
  return out;
}

const bitsApart = (a: string, b: string) => { let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0; while (x) { n += Number(x & BigInt(1)); x >>= BigInt(1); } return n; };
const SHAPE = (r: number) => (Math.abs(r - 0.8) < 0.02 ? "4:5" : Math.abs(r - 1) < 0.02 ? "1:1" : Math.abs(r - 1.91) < 0.03 ? "1.91:1" : r < 1 ? `${r.toFixed(2)}:1 (tall)` : `${r.toFixed(2)}:1 (wide)`);

/** Every slide's problems for an Instagram carousel, in order. */
export async function checkSlides(items: { id: string; name?: string; kind?: string }[]) {
  const rows = await Promise.all(items.map(async (it, i) => {
    const base: SlideCheck = { file_id: it.id, position: i + 1, name: it.name ?? it.id, kind: it.kind ?? "other", w: null, h: null, issues: [] };
    if (!it.id.startsWith("m:")) { base.issues.push({ level: "bad", text: "Made on the GPU, not an upload: it can't go to Instagram from here" }); return { row: base, hash: null }; }
    if (it.kind !== "image") { if (it.kind !== "video") base.issues.push({ level: "bad", text: "Only photos and videos can go in a carousel" }); return { row: base, hash: null }; }
    const m = await getMedia(it.id.slice(2)).catch(() => null);
    if (!m?.token) { base.issues.push({ level: "warn", text: "Still uploading" }); return { row: base, hash: null }; }
    const got = await measure(m);
    return { row: { ...base, w: got.w, h: got.h }, hash: got.hash };
  }));
  const first = rows.find((r) => r.row.w && r.row.h)?.row;
  const firstR = first ? first.w! / first.h! : null;
  for (const { row } of rows) {
    if (!row.w || !row.h) continue;
    const r = row.w / row.h;
    if (r < 0.8 - 0.01) row.issues.push({ level: "bad", text: `Taller than 4:5 (${SHAPE(r)}): Instagram crops it` });
    else if (r > 1.91 + 0.02) row.issues.push({ level: "bad", text: `Wider than 1.91:1 (${SHAPE(r)}): Instagram crops it` });
    else if (Math.abs(r - 0.8) > 0.02 && Math.abs(r - 1) > 0.02) row.issues.push({ level: "warn", text: `${SHAPE(r)}: 4:5 or 1:1 fills the feed best` });
    if (firstR && row !== first && Math.abs(r - firstR) / firstR > 0.03) row.issues.push({ level: "warn", text: `Not the same shape as slide ${first!.position} (${SHAPE(firstR)}): every slide is cropped to the first one's shape` });
    if (Math.min(row.w, row.h) < 320) row.issues.push({ level: "bad", text: `Too small (${row.w}×${row.h})` });
    else if (row.w < 1080) row.issues.push({ level: "warn", text: `${row.w} px wide: under 1080 looks soft on phones` });
  }
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < i; j++) {
    const a = rows[i].hash, b = rows[j].hash;
    if (a && b && bitsApart(a, b) <= 5) { rows[i].row.issues.push({ level: "warn", text: `Looks the same as slide ${j + 1}: a duplicate?` }); break; }
  }
  const out = rows.map((r) => r.row);
  const bad = out.filter((r) => r.issues.some((x) => x.level === "bad")).length, warn = out.filter((r) => r.issues.length && !r.issues.some((x) => x.level === "bad")).length;
  const notes = [
    ...(items.length > 20 ? ["Instagram takes up to 20 slides; the rest won't go"] : []),
    ...(items.length < 2 ? ["A carousel needs two or more slides"] : []),
  ];
  return { slides: out, bad, warn, ok: out.length - bad - warn, notes };
}
