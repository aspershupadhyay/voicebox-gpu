// Object storage: one private Cloudflare R2 bucket over the S3 API (signed with aws4fetch).
// R2 has no egress fees and generous free operations, so audio/video play straight from presigned URLs.
import { AwsClient } from "aws4fetch";

const BUCKET = process.env.R2_BUCKET || "voicebox";
const ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`;
const TYPES: Record<string, string> = {
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", webm: "audio/webm", ogg: "audio/ogg", srt: "application/x-subrip",
  vtt: "text/vtt", json: "application/json", mp4: "video/mp4", jpg: "image/jpeg", png: "image/png", webp: "image/webp", zip: "application/zip",
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
  const r = await aws().fetch(url(key), { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`storage GET ${key}: ${r.status}`);
  return r;
}

export async function getJson<T>(key: string): Promise<T | null> {
  const r = await getObj(key);
  return r ? ((await r.json()) as T) : null;
}

export async function putObj(key: string, body: BodyInit, type = typeOf(key)) {
  const r = await aws().fetch(url(key), { method: "PUT", body, headers: { "Content-Type": type } });
  if (!r.ok) throw new Error(`storage PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export const putJson = (key: string, value: unknown) => putObj(key, JSON.stringify(value, null, 2), "application/json");

export type StoredObj = { key: string; size: number; modified: number };

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Every object under a prefix (ListObjectsV2, paginated). */
export async function listObjs(prefix: string): Promise<StoredObj[]> {
  const out: StoredObj[] = [];
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

export async function delObjs(keys: string[]) {
  for (let i = 0; i < keys.length; i += 16) {
    await Promise.all(keys.slice(i, i + 16).map(async (k) => {
      const r = await aws().fetch(url(k), { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error(`storage DELETE ${k}: ${r.status}`);
    }));
  }
}

export const delPrefix = async (prefix: string) => delObjs((await listObjs(prefix)).map((o) => o.key));

/** Presigned URL (query-signed SigV4). GETs carry the right content type even if the object was stored without one. */
export async function presign(key: string, method: "GET" | "PUT" = "GET", ttlSec = 6 * 3600, download?: string) {
  const u = new URL(url(key));
  u.searchParams.set("X-Amz-Expires", String(Math.min(ttlSec, 7 * 24 * 3600)));
  if (method === "GET") {
    u.searchParams.set("response-content-type", typeOf(key));
    if (download) u.searchParams.set("response-content-disposition", `attachment; filename="${download.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  }
  return (await aws().sign(u.toString(), { method, aws: { signQuery: true } })).url;
}
