// The off-Cloudflare backup (docs/MIGRATION.md phase 2): Neon's object storage (S3-compatible, NEON_S3_*) keeps a copy
// of what can't be made again. Once a night (the sweep, after 02:00 UTC): the four workspace tables as one gzipped JSON
// (db/<day>.json.gz, the last 14 kept), activity older than a year pruned, then the trained voices and their data
// (models/, datasets/ in R2) copied over, only what's new or changed, a part at a time so a big model never sits whole
// in memory. A copy that runs out of time carries on at the next sweep. R2 is only ever read here.
import { AwsClient } from "aws4fetch";
import { gzipSync } from "node:zlib";
import { getJsonTagged, listObjs, presign, putJsonIf } from "./store";

const KEEP_DUMPS = 14;
const MIRRORED = ["models/", "datasets/"]; // the trained voices: never deleted or rewritten in R2
const PART = 32 * 1024 * 1024;
const STATE = "backups/state.json"; // in R2: the last run, so the panel can show it

export type BackupState = { day?: string; dump?: { at: string; key: string; bytes: number; rows: Record<string, number> }; pruned?: number;
  models?: { at: string; done: boolean; copied: number; bytes: number; total: number; left: number; error?: string }; error?: string };

export const hasBackup = () => !!(process.env.NEON_S3_ENDPOINT && process.env.NEON_S3_ACCESS_KEY_ID && process.env.NEON_S3_SECRET_ACCESS_KEY && process.env.NEON_S3_BUCKET);

let client: AwsClient | null = null;
const neonS3 = () => (client ??= new AwsClient({ accessKeyId: process.env.NEON_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.NEON_S3_SECRET_ACCESS_KEY!, service: "s3", region: process.env.NEON_S3_REGION || "auto" }));
const at = (key = "") => `${process.env.NEON_S3_ENDPOINT!.replace(/\/$/, "")}/${process.env.NEON_S3_BUCKET}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}`;

async function call(key: string, init: RequestInit & { query?: Record<string, string> } = {}) {
  const u = new URL(at(key));
  for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, v);
  const signed = await neonS3().sign(u.toString(), { method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string>), "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
  const r = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: init.body, cache: "no-store" });
  if (!r.ok) throw new Error(`backup ${init.method ?? "GET"} ${key}: ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r;
}

/** Everything under a prefix in the backup bucket. */
export async function backupList(prefix: string) {
  const out: { key: string; size: number }[] = [];
  let token = "";
  do {
    const q: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) q["continuation-token"] = token;
    const xml = await (await call("", { query: q })).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const f = (t: string) => m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? "";
      out.push({ key: f("Key").replace(/&amp;/g, "&"), size: Number(f("Size")) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? "" : "";
  } while (token);
  return out;
}

export const backupPut = (key: string, bytes: Uint8Array, type = "application/octet-stream") => call(key, { method: "PUT", body: bytes as BodyInit, headers: { "Content-Type": type } });
export const backupDel = (key: string) => call(key, { method: "DELETE" });

/** One object of any size: a plain PUT up to one part, else a multipart upload fed by `read` part by part. */
export async function backupStream(key: string, size: number, read: (start: number, end: number) => Promise<Uint8Array>) {
  if (size <= PART) return void (await backupPut(key, await read(0, size)));
  const id = (await (await call(key, { method: "POST", query: { uploads: "" } })).text()).match(/<UploadId>([\s\S]*?)<\/UploadId>/)?.[1];
  if (!id) throw new Error(`backup: no upload id for ${key}`);
  try {
    const etags: string[] = [];
    for (let n = 1, start = 0; start < size; n++, start += PART) {
      const r = await call(key, { method: "PUT", query: { partNumber: String(n), uploadId: id }, body: (await read(start, Math.min(size, start + PART))) as BodyInit });
      etags.push(r.headers.get("etag") ?? "");
    }
    const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    await call(key, { method: "POST", query: { uploadId: id }, body: xml, headers: { "Content-Type": "application/xml" } });
  } catch (e) {
    await call(key, { method: "DELETE", query: { uploadId: id } }).catch(() => null);
    throw e;
  }
}

/** The four tables as one gzipped JSON, the last 14 kept. */
export async function dumpDb(day: string) {
  const { sql } = await import("./db");
  const rows: Record<string, number> = {};
  const data: Record<string, unknown[]> = {};
  for (const t of ["posts", "comments", "activity", "media"]) {
    data[t] = (await sql().query(`select * from ${t} order by created_at`)) as unknown[];
    rows[t] = data[t].length;
  }
  const bytes = gzipSync(JSON.stringify({ at: new Date().toISOString(), tables: data }));
  const key = `db/${day}.json.gz`;
  await backupPut(key, new Uint8Array(bytes), "application/gzip");
  const old = (await backupList("db/")).map((o) => o.key).sort().slice(0, -KEEP_DUMPS);
  for (const k of old) await backupDel(k).catch(() => null);
  return { at: new Date().toISOString(), key, bytes: bytes.length, rows };
}

/** Copy what's new or changed under models/ and datasets/ until `ms` runs out. */
async function mirrorModels(ms: number) {
  const until = Date.now() + ms;
  const have = new Map((await Promise.all(MIRRORED.map(backupList))).flat().map((o) => [o.key, o.size]));
  const all = (await Promise.all(MIRRORED.map(listObjs))).flat();
  const want = all.filter((o) => have.get(o.key) !== o.size);
  const total = all.reduce((n, o) => n + o.size, 0);
  let copied = 0, bytes = 0;
  for (const o of want) {
    if (Date.now() > until) break;
    const src = await presign(o.key, "GET", 3600);
    await backupStream(o.key, o.size, async (start, end) => {
      const r = await fetch(src, { headers: o.size ? { Range: `bytes=${start}-${end - 1}` } : {}, cache: "no-store" });
      if (!r.ok) throw new Error(`read ${o.key}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    copied++; bytes += o.size;
  }
  return { at: new Date().toISOString(), done: copied === want.length, copied, bytes, total, left: want.length - copied };
}

/** The sweep's nightly turn: the dump and the prune once a day, the models copy until it has caught up. Never throws. */
export async function nightly(ms = 120_000) {
  if (!hasBackup()) return null;
  const start = Date.now();
  const { value, etag } = await getJsonTagged<BackupState>(STATE);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const dueDump = now.getUTCHours() >= 2 && value?.day !== day;
  const dueModels = dueDump || (value?.models && !value.models.done);
  if (!dueDump && !dueModels) return null;
  const next: BackupState = { ...(value ?? {}), day: dueDump ? day : value?.day };
  if (!(await putJsonIf(STATE, next, etag))) return null; // another sweep has it
  if (dueDump) {
    const { hasDb } = await import("./db");
    if (hasDb()) {
      try {
        next.dump = await dumpDb(day);
        if (process.env.DB_BACKEND === "neon") next.pruned = await pruneActivity();
        next.error = undefined;
      } catch (e) { next.error = (e as Error).message; }
    }
  }
  try {
    next.models = await mirrorModels(Math.max(10_000, ms - (Date.now() - start)));
  } catch (e) {
    next.models = { ...(next.models ?? { copied: 0, bytes: 0, total: 0, left: 0 }), at: new Date().toISOString(), done: false, error: (e as Error).message };
  }
  const { putJson } = await import("./store");
  await putJson(STATE, next);
  return next;
}

/** The activity feed keeps a year. */
async function pruneActivity() {
  const { sql } = await import("./db");
  const r = (await sql().query("delete from activity where created_at < now() - interval '1 year' returning id")) as unknown[];
  return r.length;
}

export const backupState = async () => (await getJsonTagged<BackupState>(STATE)).value;
