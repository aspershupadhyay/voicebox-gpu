// Object storage: one private Cloudflare R2 bucket. On the Worker, reads, writes, lists and deletes go through the R2
// binding (BUCKET in wrangler.jsonc: inside Cloudflare, no signing, no extra TLS hop, a few ms); anywhere else, and for
// presigned links, conditional writes and copies, over the S3 API (signed with aws4fetch). R2 has no egress fees, so
// audio/video play straight from presigned URLs.
import { AwsClient } from "aws4fetch";

type R2Obj = { size: number; etag: string; httpEtag: string; uploaded: Date; key: string; httpMetadata?: { contentType?: string } };
type R2Body = R2Obj & { body: ReadableStream };
type R2Bucket = {
  get(key: string): Promise<R2Body | null>; head(key: string): Promise<R2Obj | null>;
  put(key: string, v: ArrayBuffer | Uint8Array | string | ReadableStream, o?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(o: { prefix?: string; cursor?: string; delimiter?: string; limit?: number }): Promise<{ objects: R2Obj[]; truncated: boolean; cursor?: string; delimitedPrefixes: string[] }>;
};
/** The Worker's R2 binding, or null off Cloudflare (next dev, scripts) or when the bucket names don't match. */
function bound(): R2Bucket | null {
  if ((process.env.R2_BUCKET || "voicebox") !== "voicebox" || process.env.R2_ENDPOINT) return null;
  const ctx = (globalThis as Record<symbol, { env?: { BUCKET?: R2Bucket } } | undefined>)[Symbol.for("__cloudflare-context__")];
  return ctx?.env?.BUCKET ?? null;
}

const BUCKET = process.env.R2_BUCKET || "voicebox";
// R2_ENDPOINT (optional) points at another S3-compatible store, e.g. a local one for testing
const ENDPOINT = `${process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`}/${BUCKET}`;
const TYPES: Record<string, string> = {
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", webm: "audio/webm", ogg: "audio/ogg", srt: "application/x-subrip",
  vtt: "text/vtt", json: "application/json", mp4: "video/mp4", jpg: "image/jpeg", png: "image/png", webp: "image/webp", zip: "application/zip",
  // Files uploads live here too (docs/MIGRATION.md): a GET carries the type the key's extension names
  jpeg: "image/jpeg", gif: "image/gif", avif: "image/avif", heic: "image/heic", svg: "image/svg+xml", mov: "video/quicktime", m4v: "video/mp4",
  mkv: "video/x-matroska", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg", pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
  csv: "text/csv", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export const typeOf = (name: string) => TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

let client: AwsClient | null = null;
function aws() {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)
    throw new Error("Storage is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).");
  client ??= new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  return client;
}
const url = (key: string) => `${ENDPOINT}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** The object, or null when it doesn't exist. */
export async function getObj(key: string): Promise<Response | null> {
  const b = bound();
  if (b) {
    const o = await b.get(key);
    if (!o) return null;
    return new Response(o.body, { headers: { "content-type": o.httpMetadata?.contentType || typeOf(key), "content-length": String(o.size), etag: o.httpEtag } });
  }
  const r = await aws().fetch(url(key), { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`storage GET ${key}: ${r.status}`);
  return r;
}

/** An object's size and type, or null when it doesn't exist. */
export async function headObj(key: string): Promise<{ size: number; type: string } | null> {
  const b = bound();
  if (b) { const o = await b.head(key); return o ? { size: o.size, type: o.httpMetadata?.contentType ?? "" } : null; }
  const r = await aws().fetch(url(key), { method: "HEAD", cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`storage HEAD ${key}: ${r.status}`);
  return { size: Number(r.headers.get("content-length") ?? 0), type: r.headers.get("content-type") ?? "" };
}

export async function getJson<T>(key: string): Promise<T | null> {
  const r = await getObj(key);
  return r ? ((await r.json()) as T) : null;
}

export async function putObj(key: string, body: BodyInit, type = typeOf(key)) {
  // Sign headers only (UNSIGNED-PAYLOAD), then send plain bytes: a body inside a signed Request goes out chunked on
  // Vercel, and R2 rejects that with 411 MissingContentLength.
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const b = bound();
  if (b) return void (await b.put(key, bytes, { httpMetadata: { contentType: type } }));
  const signed = await aws().sign(url(key), { method: "PUT", headers: { "Content-Type": type, "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
  const r = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
  if (!r.ok) throw new Error(`storage PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/** A body of known size straight into the bucket, never held whole in memory (a Worker has 128 MB): through the
 *  binding with a fixed-length stream. False off Cloudflare (no binding): the caller buffers it instead. */
export async function putStream(key: string, body: ReadableStream<Uint8Array>, size: number, type = typeOf(key)) {
  const b = bound();
  const FLS = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (!b || !FLS || !(size > 0)) return false;
  const { readable, writable } = new FLS(size);
  const piping = body.pipeTo(writable);
  await Promise.all([b.put(key, readable, { httpMetadata: { contentType: type } }), piping]);
  return true;
}

export const putJson = (key: string, value: unknown) => putObj(key, JSON.stringify(value, null, 2), "application/json");

/** A JSON object with its ETag, for a write that must not overwrite someone else's (putJsonIf). */
export async function getJsonTagged<T>(key: string): Promise<{ value: T | null; etag: string | null }> {
  // uncompressed, or the tag comes back weak (W/"…", for the gzipped copy) and never matches on the write
  const r = await aws().fetch(url(key), { cache: "no-store", headers: { "Accept-Encoding": "identity" } });
  if (r.status === 404) return { value: null, etag: null };
  if (!r.ok) throw new Error(`storage GET ${key}: ${r.status}`);
  const etag = r.headers.get("etag")?.replace(/^W\//, "") ?? null;
  return { value: (await r.json()) as T, etag };
}

/** Write only if the object is still the copy we read (its ETag), or still missing (etag null). False when someone
 *  wrote in between (R2 answers 412): read again, change again, try again. */
export async function putJsonIf(key: string, value: unknown, etag: string | null) {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
  const cond: Record<string, string> = etag ? { "If-Match": etag } : { "If-None-Match": "*" };
  const signed = await aws().sign(url(key), { method: "PUT", headers: { "Content-Type": "application/json", "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD", ...cond } });
  const r = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
  if (r.status === 412 || r.status === 409) return false;
  if (!r.ok) throw new Error(`storage PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return true;
}

export type StoredObj = { key: string; size: number; modified: number };

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Every object under a prefix (ListObjectsV2, paginated). */
export async function listObjs(prefix: string): Promise<StoredObj[]> {
  const out: StoredObj[] = [];
  const b = bound();
  if (b) {
    for (let cursor: string | undefined; ;) {
      const r = await b.list({ prefix, cursor, limit: 1000 });
      for (const o of r.objects) out.push({ key: o.key, size: o.size, modified: o.uploaded.getTime() });
      if (!r.truncated) return out;
      cursor = r.cursor;
    }
  }
  let token = "";
  do {
    const u = new URL(ENDPOINT);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix);
    u.searchParams.set("max-keys", "1000");
    if (token) u.searchParams.set("continuation-token", token);
    const r = await aws().fetch(u.toString(), { cache: "no-store" });
    if (!r.ok) throw new Error(`storage LIST ${prefix}: ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const f = (tag: string) => m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
      out.push({ key: unxml(f("Key")), size: Number(f("Size")), modified: Date.parse(f("LastModified")) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? "") : "";
  } while (token);
  return out;
}

/** The "folders" directly under a prefix (ListObjectsV2 with a delimiter): one request however many files they hold. */
export async function listDirs(prefix: string): Promise<string[]> {
  const out: string[] = [];
  const b = bound();
  if (b) {
    for (let cursor: string | undefined; ;) {
      const r = await b.list({ prefix, cursor, delimiter: "/", limit: 1000 });
      for (const d of r.delimitedPrefixes) out.push(d.slice(prefix.length).replace(/\/$/, ""));
      if (!r.truncated) return out;
      cursor = r.cursor;
    }
  }
  let token = "";
  do {
    const u = new URL(ENDPOINT);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix);
    u.searchParams.set("delimiter", "/");
    u.searchParams.set("max-keys", "1000");
    if (token) u.searchParams.set("continuation-token", token);
    const r = await aws().fetch(u.toString(), { cache: "no-store" });
    if (!r.ok) throw new Error(`storage LIST ${prefix}: ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>/g)) out.push(unxml(m[1]).slice(prefix.length).replace(/\/$/, ""));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? "") : "";
  } while (token);
  return out;
}

export async function delObjs(keys: string[]) {
  const b = bound();
  if (b) { for (let i = 0; i < keys.length; i += 1000) await b.delete(keys.slice(i, i + 1000)); return; }
  for (let i = 0; i < keys.length; i += 16) {
    await Promise.all(keys.slice(i, i + 16).map(async (k) => {
      const r = await aws().fetch(url(k), { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error(`storage DELETE ${k}: ${r.status}`);
    }));
  }
}

/** Copy an object inside the bucket (no bytes pass through here; up to 5 GB). */
export async function copyObj(from: string, to: string) {
  const signed = await aws().sign(url(to), { method: "PUT", headers: { "x-amz-copy-source": `/${BUCKET}/${from.split("/").map(encodeURIComponent).join("/")}`, "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
  const r = await fetch(signed.url, { method: "PUT", headers: signed.headers });
  if (!r.ok) throw new Error(`storage COPY ${from} → ${to}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export const delPrefix = async (prefix: string) => delObjs((await listObjs(prefix)).map((o) => o.key));

const WINDOW = 3 * 3600_000;

/** Presigned URL (query-signed SigV4). GETs carry the right content type even if the object was stored without one.
 *  `stable` signs as of the start of the current 3-hour window (and lives 3 h longer), so the same file gets the same
 *  link all window long and the browser's cache keeps thumbnails and audio between visits. */
export async function presign(key: string, method: "GET" | "PUT" = "GET", ttlSec = 6 * 3600, download?: string, stable = false) {
  const u = new URL(url(key));
  const start = stable ? Math.floor(Date.now() / WINDOW) * WINDOW : 0;
  u.searchParams.set("X-Amz-Expires", String(Math.min(ttlSec + (stable ? WINDOW / 1000 : 0), 7 * 24 * 3600)));
  if (method === "GET") {
    u.searchParams.set("response-content-type", typeOf(key));
    if (download) u.searchParams.set("response-content-disposition", `attachment; filename="${download.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  }
  const datetime = stable ? new Date(start).toISOString().replace(/[:-]|\.\d{3}/g, "") : undefined;
  return (await aws().sign(u.toString(), { method, aws: { signQuery: true, datetime } })).url;
}
