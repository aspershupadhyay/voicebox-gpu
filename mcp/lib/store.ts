// Object storage: two private buckets (the owner, 2026-11-10: "keep models and the heavy work on R2, move the files and
// audio work to Backblaze"). Backblaze B2 holds what people make and keep: Files (workspace/media/, their posters and
// photo thumbnails), downloads in progress, finished voice jobs (library/), publish cards and temporary uploads
// (B2_PREFIXES). R2 keeps the models, datasets, GPU caches and every small state file. B2 keeps a deleted file's old
// version for 30 days (a bucket lifecycle rule), so a delete there can be undone.
// B2 is used once B2_KEY_ID, B2_APP_KEY, B2_BUCKET and B2_ENDPOINT are set and B2_FILES=on; until a file has been moved
// (lib/b2move.ts), a read that misses on B2 looks in R2, and a delete removes both copies.
//
// R2: On the Worker, reads, writes, lists and deletes go through the R2
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
const enc = (key: string) => key.split("/").map(encodeURIComponent).join("/");
const url = (key: string) => `${ENDPOINT}/${enc(key)}`;

// ── Backblaze B2 (S3 API)
// Only files people open live on B2. Small state that's read all the time (accounts, publishing plans, Auto-DM, every
// .json) and the thumbnail cache stay on R2: every B2 read is a paid "Class B" transaction under a daily cap, and the
// first version (2026-11-10) put workspace/publish/ and cache/thumbs/ there, hit the free cap in hours and every read
// came back 403 (accounts vanished, downloads failed).
export const B2_PREFIXES = ["workspace/media/", "workspace/posters/", "workspace/downloads/", "workspace/publish/story/", "uploads/", "library/"];
/** The key belongs on B2 (whether or not B2 is switched on yet). */
export const b2Key = (key: string) => !key.endsWith(".json") && B2_PREFIXES.some((p) => key.startsWith(p));
/** Where that first version put things that belong on R2: read from B2 when R2 hasn't got them yet (copied over on
 *  the read), until the storage tool's move_to_r2 has brought them all back. */
export const LEGACY_B2 = ["workspace/publish/", "cache/thumbs/", "workspace/media/", "workspace/posters/", "workspace/downloads/", "uploads/", "library/"];
export const legacyKey = (key: string) => b2Ready() && !b2Key(key) && LEGACY_B2.some((p) => key.startsWith(p));
const legacyGone = new Set<string>(); // prefixes this instance found empty on B2: not listed there again
/** B2's key and bucket are set (what moving files needs). */
export const b2Ready = () => !!(process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET && process.env.B2_ENDPOINT);
/** New files go to B2. */
export const b2On = () => b2Ready() && process.env.B2_FILES === "on";
const onB2 = (key: string) => b2On() && b2Key(key);
/** A list under this prefix has to look at B2 too. */
const b2Overlaps = (prefix: string) => b2On() && B2_PREFIXES.some((p) => p.startsWith(prefix) || prefix.startsWith(p));
const legacyOverlaps = (prefix: string) => b2Ready() && !legacyGone.has(prefix) && ["workspace/publish/", "cache/thumbs/"].some((p) => p.startsWith(prefix) || prefix.startsWith(p));
let b2client: AwsClient | null = null;
function b2() {
  if (!b2Ready()) throw new Error("Backblaze is not configured (B2_KEY_ID / B2_APP_KEY / B2_BUCKET / B2_ENDPOINT).");
  const region = /s3\.([a-z0-9-]+)\.backblazeb2\.com/.exec(process.env.B2_ENDPOINT!)?.[1] ?? "us-east-005";
  // trimmed: a key pasted into the dashboard often brings a space or a line break along
  b2client ??= new AwsClient({ accessKeyId: process.env.B2_KEY_ID!.trim(), secretAccessKey: process.env.B2_APP_KEY!.trim(), service: "s3", region });
  return b2client;
}
const B2_BASE = () => `${process.env.B2_ENDPOINT!.trim().replace(/\/$/, "").replace(/^(?!https?:)/, "https://")}/${process.env.B2_BUCKET!.trim()}`;
const b2url = (key: string) => `${B2_BASE()}/${enc(key)}`;

/** B2 alone: the object (a Range header passes through), or null. */
export async function b2Get(key: string, init: RequestInit = {}): Promise<Response | null> {
  const r = await b2().fetch(b2url(key), { cache: "no-store", ...init });
  if (r.status === 404) return null;
  // B2 answers a HEAD for a file that isn't there with a bare 403 (a HEAD has no body to say why): ask with a one-byte
  // GET instead, which says NoSuchKey (not there: null) or gives the size (Content-Range), or the real reason
  if (r.status === 403 && init.method === "HEAD") {
    const g = await b2().fetch(b2url(key), { cache: "no-store", headers: { Range: "bytes=0-0" } });
    if (g.status === 404) return null;
    const body = g.ok ? "" : await g.text();
    if (/NoSuchKey|not\s*found|does not exist/i.test(body)) return null;
    if (!g.ok) throw new Error(`B2 HEAD ${key}: ${g.status} ${(body.match(/<Code>([^<]*)<\/Code>/)?.[1] ?? "")} ${(body.match(/<Message>([^<]*)<\/Message>/)?.[1] ?? body.slice(0, 160))}`.trim());
    await g.body?.cancel().catch(() => null);
    const size = Number(/\/(\d+)$/.exec(g.headers.get("content-range") ?? "")?.[1] ?? g.headers.get("content-length") ?? 0);
    return new Response(null, { status: 200, headers: { "content-length": String(size), "content-type": g.headers.get("content-type") ?? "" } });
  }
  if (!r.ok) throw new Error(`B2 ${init.method ?? "GET"} ${key}: ${r.status}`);
  return r;
}
/** Bytes into B2: a stream needs its size (sent as Content-Length through a FixedLengthStream on the Worker). */
export async function putB2(key: string, body: Uint8Array | ReadableStream<Uint8Array>, type: string, size?: number) {
  const signed = await b2().sign(b2url(key), { method: "PUT", headers: { "Content-Type": type, "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
  let sent: BodyInit = body as BodyInit;
  if (body instanceof ReadableStream) {
    const FLS = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
    if (FLS && size! > 0) { const t = new FLS(size!); void body.pipeTo(t.writable).catch(() => {}); sent = t.readable; }
    else sent = new Uint8Array(await new Response(body).arrayBuffer());
  }
  const r = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: sent, ...(sent instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
  if (!r.ok) throw new Error(`B2 PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function listXml(base: string, client: AwsClient, prefix: string, delimiter: boolean, each: (xml: string) => void) {
  let token = "";
  do {
    const u = new URL(base);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix);
    u.searchParams.set("max-keys", "1000");
    if (delimiter) u.searchParams.set("delimiter", "/");
    if (token) u.searchParams.set("continuation-token", token);
    const r = await client.fetch(u.toString(), { cache: "no-store" });
    if (!r.ok) throw new Error(`storage LIST ${prefix}: ${r.status}`);
    const xml = await r.text();
    each(xml);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? "") : "";
  } while (token);
}
const contents = (xml: string, out: StoredObj[]) => {
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const f = (tag: string) => m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
    out.push({ key: unxml(f("Key")), size: Number(f("Size")), modified: Date.parse(f("LastModified")) });
  }
};
/** Every object under a prefix on B2 alone. */
export async function listB2(prefix: string): Promise<StoredObj[]> {
  const out: StoredObj[] = [];
  await listXml(B2_BASE(), b2(), prefix, false, (x) => contents(x, out));
  return out;
}
/** Can the Worker reach B2 with its key? What Backblaze answers (never the key itself). */
export async function b2Check() {
  const id = (process.env.B2_KEY_ID ?? "").trim();
  const shape = { key_id_length: id.length, key_id_start: id.slice(0, 6), app_key_length: (process.env.B2_APP_KEY ?? "").trim().length,
    bucket: process.env.B2_BUCKET?.trim(), endpoint: process.env.B2_ENDPOINT?.trim(), spaces_trimmed: id !== process.env.B2_KEY_ID || (process.env.B2_APP_KEY ?? "") !== (process.env.B2_APP_KEY ?? "").trim() };
  const r = await b2().fetch(`${B2_BASE()}?list-type=2&max-keys=1`, { cache: "no-store" });
  const body = r.ok ? "" : await r.text();
  return { ok: r.ok, status: r.status, ...(body ? { b2_says: (body.match(/<Code>([^<]*)<\/Code>/)?.[1] ?? "") + ": " + (body.match(/<Message>([^<]*)<\/Message>/)?.[1] ?? body.slice(0, 200)) } : {}), ...shape };
}
/** B2 only: one object's size, or null. */
export async function headB2(key: string) {
  const r = await b2Get(key, { method: "HEAD" });
  return r ? Number(r.headers.get("content-length") ?? 0) : null;
}

/** The object, or null when it doesn't exist. */
export async function getObj(key: string): Promise<Response | null> {
  if (onB2(key)) { const r = await b2Get(key); if (r) return r; } // not moved yet: R2 still has it
  const r = await getR2(key);
  if (r || !legacyKey(key)) return r;
  return fromLegacy(key);
}
/** A file the first B2 version put on B2 that belongs on R2: read it there once and keep it on R2 from now on. */
async function fromLegacy(key: string): Promise<Response | null> {
  const b = await b2Get(key).catch((e) => { console.error("b2 legacy", (e as Error).message); return null; });
  if (!b) return null;
  const type = b.headers.get("content-type") || typeOf(key);
  const bytes = new Uint8Array(await b.arrayBuffer());
  await putObj(key, bytes, type).catch(() => null);
  return new Response(bytes, { headers: { "content-type": type, "content-length": String(bytes.length) } });
}
/** R2 alone. */
export async function getR2(key: string): Promise<Response | null> {
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
  if (onB2(key)) {
    const r = await b2Get(key, { method: "HEAD" });
    if (r) return { size: Number(r.headers.get("content-length") ?? 0), type: r.headers.get("content-type") ?? "" };
  }
  const b = bound();
  if (b) {
    const o = await b.head(key);
    if (o) return { size: o.size, type: o.httpMetadata?.contentType ?? "" };
    if (!legacyKey(key)) return null;
    const l = await b2Get(key, { method: "HEAD" }).catch(() => null);
    return l ? { size: Number(l.headers.get("content-length") ?? 0), type: l.headers.get("content-type") ?? "" } : null;
  }
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
  if (onB2(key)) return putB2(key, bytes, type);
  const b = bound();
  if (b) return void (await b.put(key, bytes, { httpMetadata: { contentType: type } }));
  const signed = await aws().sign(url(key), { method: "PUT", headers: { "Content-Type": type, "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
  const r = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
  if (!r.ok) throw new Error(`storage PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/** A body of known size straight into the bucket, never held whole in memory (a Worker has 128 MB): through the
 *  binding with a fixed-length stream. False off Cloudflare (no binding): the caller buffers it instead. */
export async function putStream(key: string, body: ReadableStream<Uint8Array>, size: number, type = typeOf(key)) {
  const FLS0 = (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream;
  if (onB2(key)) { if (!FLS0 || !(size > 0)) return false; await putB2(key, body, type, size); return true; }
  return putStreamR2(key, body, size, type);
}
/** R2 alone. */
export async function putStreamR2(key: string, body: ReadableStream<Uint8Array>, size: number, type = typeOf(key)) {
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
  let r = await aws().fetch(url(key), { cache: "no-store", headers: { "Accept-Encoding": "identity" } });
  // still on B2 from the first version: copy it to R2, then read it with R2's tag
  if (r.status === 404 && legacyKey(key) && (await fromLegacy(key))) r = await aws().fetch(url(key), { cache: "no-store", headers: { "Accept-Encoding": "identity" } });
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

/** Every object under a prefix (ListObjectsV2, paginated), from both buckets where the prefix reaches B2's part. */
export async function listObjs(prefix: string): Promise<StoredObj[]> {
  if (!b2Overlaps(prefix)) {
    if (!legacyOverlaps(prefix)) return listR2(prefix);
    const [r2, old] = await Promise.all([listR2(prefix), listB2(prefix).catch(() => [] as StoredObj[])]);
    if (!old.length) legacyGone.add(prefix);
    const seen = new Set(r2.map((o) => o.key));
    return [...r2, ...old.filter((o) => !seen.has(o.key) && legacyKey(o.key))];
  }
  const [r2, onb2] = await Promise.all([listR2(prefix), listB2(prefix)]);
  const seen = new Set(onb2.map((o) => o.key));
  return [...onb2, ...r2.filter((o) => !seen.has(o.key))];
}
/** R2 alone. */
export async function listR2(prefix: string): Promise<StoredObj[]> {
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
  if (!b2Overlaps(prefix)) return listDirsR2(prefix);
  const out = new Set(await listDirsR2(prefix));
  await listXml(B2_BASE(), b2(), prefix, true, (xml) => {
    for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>/g)) out.add(unxml(m[1]).slice(prefix.length).replace(/\/$/, ""));
  });
  return [...out];
}
async function listDirsR2(prefix: string): Promise<string[]> {
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
  // a legacy copy goes too, or a deleted plan or account would come back from B2 on the next read
  await delB2(keys.filter((k) => onB2(k) || legacyKey(k)));
  return delR2(keys);
}
/** B2 alone (deletes are free there). A delete leaves the old version for 30 days (the bucket's lifecycle rule). */
export async function delB2(keys: string[]) {
  for (let i = 0; i < keys.length; i += 16) {
    await Promise.all(keys.slice(i, i + 16).map(async (k) => {
      const r = await b2().fetch(b2url(k), { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error(`B2 DELETE ${k}: ${r.status}`);
    }));
  }
}
/** R2 alone: one object's size, or null. */
export async function headR2(key: string) {
  const b = bound();
  if (b) { const o = await b.head(key); return o ? o.size : null; }
  const r = await aws().fetch(url(key), { method: "HEAD", cache: "no-store" });
  return r.ok ? Number(r.headers.get("content-length") ?? 0) : null;
}
/** R2 alone. */
export async function delR2(keys: string[]) {
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
  if (onB2(to)) {
    if (onB2(from)) {
      const signed = await b2().sign(b2url(to), { method: "PUT", headers: { "x-amz-copy-source": `/${process.env.B2_BUCKET!.trim()}/${enc(from)}`, "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
      const r = await fetch(signed.url, { method: "PUT", headers: signed.headers });
      if (r.ok) return;
      if (r.status !== 404) throw new Error(`B2 COPY ${from} → ${to}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    // across the two buckets (or not moved yet): the bytes pass through, streamed
    const src = await getObj(from);
    if (!src?.body) throw new Error(`storage COPY ${from}: not found`);
    return putB2(to, src.body, src.headers.get("content-type") || typeOf(to), Number(src.headers.get("content-length") ?? 0));
  }
  if (onB2(from)) {
    const src = await getObj(from);
    if (!src?.body) throw new Error(`storage COPY ${from}: not found`);
    const size = Number(src.headers.get("content-length") ?? 0);
    if (!(await putStreamR2(to, src.body, size))) await putObj(to, await src.arrayBuffer());
    return;
  }
  const signed = await aws().sign(url(to), { method: "PUT", headers: { "x-amz-copy-source": `/${BUCKET}/${from.split("/").map(encodeURIComponent).join("/")}`, "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
  const r = await fetch(signed.url, { method: "PUT", headers: signed.headers });
  if (!r.ok) throw new Error(`storage COPY ${from} → ${to}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export const delPrefix = async (prefix: string) => delObjs((await listObjs(prefix)).map((o) => o.key));

const WINDOW = 3 * 3600_000;

/** Presigned URL (query-signed SigV4). GETs carry the right content type even if the object was stored without one.
 *  `stable` signs as of the start of the current 3-hour window (and lives 3 h longer), so the same file gets the same
 *  link all window long and the browser's cache keeps thumbnails and audio between visits. */
export const presign = (key: string, method: "GET" | "PUT" = "GET", ttlSec = 6 * 3600, download?: string, stable = false) =>
  presignOn(onB2(key), key, method, ttlSec, download, stable);
/** A presigned link to R2's copy, whichever bucket the key belongs on (a file not moved to B2 yet). */
export const presignR2 = (key: string, method: "GET" | "PUT" = "GET", ttlSec = 6 * 3600, download?: string, stable = false) =>
  presignOn(false, key, method, ttlSec, download, stable);
async function presignOn(b2k: boolean, key: string, method: "GET" | "PUT", ttlSec: number, download?: string, stable = false) {
  const u = new URL(b2k ? b2url(key) : url(key));
  const start = stable ? Math.floor(Date.now() / WINDOW) * WINDOW : 0;
  u.searchParams.set("X-Amz-Expires", String(Math.min(ttlSec + (stable ? WINDOW / 1000 : 0), 7 * 24 * 3600)));
  if (method === "GET") {
    u.searchParams.set("response-content-type", typeOf(key));
    if (download) u.searchParams.set("response-content-disposition", `attachment; filename="${download.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  }
  const datetime = stable ? new Date(start).toISOString().replace(/[:-]|\.\d{3}/g, "") : undefined;
  return ((b2k ? b2() : aws()).sign(u.toString(), { method, aws: { signQuery: true, datetime } })).then((r) => r.url);
}
