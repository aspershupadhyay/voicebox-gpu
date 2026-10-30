// What a plan sends: m:<media row> (a file uploaded to the workspace) or j:<library job> (a video Voicebox made). Each one
// resolves to a public URL that serves byte ranges (Instagram fetches it; YouTube gets it piece by piece from us).
import { getMedia } from "../appwrite";
import { getLibJob } from "../library";
import { thumbUrl } from "../r2files";
import { presign } from "../store";
import { AW, fileUrl, type Media } from "../workspace";

export type Source = { ref: string; kind: "image" | "video" | "other"; name: string; mime: string; size: number; url: string; width?: number; height?: number; duration?: number; m?: Media };

export async function resolve(ref: string): Promise<Source> {
  const [t, id] = ref.split(":");
  if (t === "m") {
    const m = await getMedia(id);
    if (!m.token && !m.r2_key) throw new Error(`${m.name} isn't ready yet (still uploading?)`);
    const url = m.r2_key ? await presign(m.r2_key, "GET", 24 * 3600) : fileUrl(m);
    return { ref, kind: m.kind === "image" || m.kind === "video" ? m.kind : "other", name: m.name, mime: m.mime ?? "application/octet-stream", size: m.size ?? 0, url, m };
  }
  if (t === "j") {
    const j = await getLibJob(id);
    if (!j) throw new Error(`Generated item ${id} is gone from Files`);
    if (j.kind !== "video" || !j.video) throw new Error(`${j.label || id} isn't a video`);
    return { ref, kind: "video", name: `${(j.label || id).slice(0, 80)}.mp4`, mime: "video/mp4", size: j.video.size, url: await presign(`library/${id}/video.mp4`, "GET", 24 * 3600),
      width: j.video.width, height: j.video.height, duration: j.video.duration };
  }
  throw new Error(`Unknown file ${ref}`);
}

/** A photo as a JPEG at a sensible size (Instagram only takes JPEG; YouTube thumbnails want ≤ 1280 wide). A photo
 *  kept in R2 is converted once with sharp and handed out as a presigned link (no redirect for Instagram to follow). */
export async function jpegUrl(m: Media, width: number) {
  if (m.file_id.startsWith("r2_")) return m.r2_key ? thumbUrl(m.r2_key, width, "jpg", 24 * 3600) : null;
  if (!m.token) return null;
  const u = new URL(`${AW.endpoint}/storage/buckets/${AW.bucket}/files/${m.file_id}/preview`);
  u.search = new URLSearchParams({ project: AW.project, token: m.token, width: String(width), output: "jpg", quality: "92" }).toString();
  return u.toString();
}

/** The size of a source when the row doesn't say (HEAD, else a one-byte range). */
export async function sizeOf(s: Source) {
  if (s.size > 0) return s.size;
  const r = await fetch(s.url, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
  const total = Number((r.headers.get("content-range") ?? "").split("/")[1]) || Number(r.headers.get("content-length")) || 0;
  await r.body?.cancel().catch(() => null);
  return total;
}

/** Bytes [from, to] of a source. */
export async function range(s: Source, from: number, to: number) {
  const r = await fetch(s.url, { headers: { Range: `bytes=${from}-${to}` }, cache: "no-store" });
  if (r.status !== 206 && !(r.status === 200 && from === 0)) throw new Error(`Couldn't read ${s.name} from storage (${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (r.status === 200 && buf.byteLength > to - from + 1) return buf.subarray(0, to - from + 1);
  return buf;
}
