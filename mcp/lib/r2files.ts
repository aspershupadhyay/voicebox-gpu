// Files uploads kept in R2 instead of Appwrite Storage (docs/MIGRATION.md, phase 1). A row whose file_id starts with
// "r2_" has its bytes at r2_key; its token is an HMAC of that key, so /api/m/<token>/<key> can check a link without
// reading the row (like an Appwrite file token: a secret kept in team-only rows that lets <img>/<video> work without a
// session). Photos get resized copies made once with sharp and kept under cache/thumbs/ (a bucket rule drops them after
// 30 days; they're made again on the next look). NEXT_PUBLIC_FILES_BACKEND=r2 sends new uploads here; rows already in
// Appwrite keep working as they are.
import { createHash, createHmac } from "node:crypto";
import { copyObj, delObjs, getObj, headObj, listObjs, presign, putObj } from "./store";
import { safeEqual } from "./worker";

export const FILES_ON_R2 = process.env.NEXT_PUBLIC_FILES_BACKEND === "r2";

/** Where an R2 file may live: what /api/m serves and nothing else (models, datasets and the rest stay private). */
export const SERVABLE = /^workspace\/media\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const secret = () => {
  const s = process.env.PUBLISH_KEY || process.env.MCP_TOKEN || "";
  if (s.length < 16) throw new Error("Set MCP_TOKEN on Vercel first.");
  return s;
};
export const fileSig = (key: string) => createHmac("sha256", secret()).update(`voicebox-file-v1:${key}`).digest("base64url");
export const sigOk = (key: string, sig: string) => SERVABLE.test(key) && safeEqual(sig, fileSig(key));

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
export const mediaKey = (fileId: string, name: string) => `workspace/media/${fileId}/${safeName(name)}`;

/** Bring an object that landed elsewhere (a download's slot) to its Files key, so its name says its type. */
export async function adopt(key: string, fileId: string, name: string) {
  const to = mediaKey(fileId, /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}.bin`);
  if (key === to) return to;
  if (!(await headObj(to))) await copyObj(key, to);
  await delObjs([key]).catch(() => null);
  return to;
}

export type ThumbFormat = "webp" | "png" | "jpg";
const THUMB_TYPE: Record<ThumbFormat, string> = { webp: "image/webp", png: "image/png", jpg: "image/jpeg" };
const thumbKey = (key: string, w: number, f: ThumbFormat) => `cache/thumbs/${createHash("sha256").update(key).digest("hex").slice(0, 24)}-${w}.${f}`;
/** Photos sharp can't (or shouldn't) resize go as they are. */
export const resizable = (key: string) => /\.(jpe?g|png|webp|avif|tiff?)$/i.test(key);

/** A resized copy of a photo, made once: its key, or the bytes too when it was just made. */
export async function thumb(key: string, width: number, format: ThumbFormat, quality = 82) {
  const w = Math.max(16, Math.min(3200, Math.round(width)));
  const k = thumbKey(key, w, format);
  if (await headObj(k)) return { key: k, type: THUMB_TYPE[format] };
  const src = await getObj(key);
  if (!src) throw new Error("file not found");
  // sharp is a native module: on Cloudflare Workers it isn't there, so the photo goes as it is (still cached by the CDN)
  const sharp = await import("sharp").then((m) => m.default).catch(() => null);
  if (!sharp) return { key, type: src.headers.get("content-type") || "image/jpeg" };
  const img = sharp(Buffer.from(await src.arrayBuffer())).rotate().resize({ width: w, withoutEnlargement: true });
  const out = await (format === "jpg" ? img.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }) : format === "png" ? img.png() : img.webp({ quality })).toBuffer();
  await putObj(k, new Uint8Array(out), THUMB_TYPE[format]);
  return { key: k, type: THUMB_TYPE[format], bytes: new Uint8Array(out) };
}

/** A link for one of these photos that a fetcher outside (Instagram, a share page) can use: presigned, no redirect. */
export async function thumbUrl(key: string, width: number, format: ThumbFormat, ttlSec = 6 * 3600) {
  if (!resizable(key)) return presign(key, "GET", ttlSec);
  return presign((await thumb(key, width, format, format === "jpg" ? 92 : 82)).key, "GET", ttlSec);
}

// ── the storage budget: R2's free tier is 10 GB, so new files stop at 90 % of it (STORAGE_CAP_GB, Settings → Usage)

const CAP = Number(process.env.STORAGE_CAP_GB || 9) * 1e9;
let seen: { at: number; bytes: number; parts: Record<string, number> } | null = null;

/** What the bucket holds, by top-level part (cache, models, workspace…), counted at most every 5 minutes. */
export async function storageUse(fresh = false) {
  if (!fresh && seen && Date.now() - seen.at < 5 * 60_000) return { ...seen, cap: CAP };
  const parts: Record<string, number> = {};
  let bytes = 0;
  for (const o of await listObjs("")) {
    const p = o.key.startsWith("workspace/") || o.key.startsWith("cache/") ? o.key.split("/").slice(0, 2).join("/") : o.key.split("/")[0];
    parts[p] = (parts[p] ?? 0) + o.size;
    bytes += o.size;
  }
  seen = { at: Date.now(), bytes, parts };
  return { ...seen, cap: CAP };
}

/** Refuse a new file that would take the bucket past the budget, saying what fills it. */
export async function assertRoom(size: number | null) {
  const u = await storageUse().catch(() => null);
  if (!u) return; // can't count right now: don't block an upload over it
  if (u.bytes + (size ?? 0) <= CAP) {
    if (seen) seen.bytes += size ?? 0;
    return;
  }
  const top = Object.entries(u.parts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${(v / 1e9).toFixed(1)} GB`).join(", ");
  throw Object.assign(new Error(`Storage is full: ${(u.bytes / 1e9).toFixed(1)} of ${(CAP / 1e9).toFixed(1)} GB used (${top}). Delete files (and empty the trash) to make room.`), { status: 507 });
}
