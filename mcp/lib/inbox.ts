// Saving files straight into Files, for any AI or script (Settings → Upload keys, the save_file MCP tool, and
// /api/files/upload + /api/files/complete). An MCP call or a Vercel request can carry about 4.5 MB, so the bytes skip
// both: step 1 hands out a presigned R2 address (one hour) and a signed ticket; step 2 is one `curl -T file <address>`
// (up to 2 GB); step 3 turns the ticket in, and the file is copied into the workspace 5 MB at a time, filed in its
// folder and attached to its post. The R2 copy stays as its backup. A ticket works once and only for its own file.
// With `carousel` (a carousel's id or a name; a new name makes one) and `position` (1 = first), a post's ten photos
// land as one stack on the Files page, in that order whatever order the uploads finish in (lib/carousels.ts).
import { createHash, createHmac, randomBytes } from "node:crypto";
import { addMediaFromR2, mimeFor } from "./data";
import { after } from "next/server";
import { joinCarousel } from "./carousels";
import { assertRoom } from "./r2files";
import { fileUrl } from "./workspace";
import { findFolder, getTree, moveItems } from "./files";
import { getJson, headObj, presign, putJson, putObj, putStream } from "./store";
import { safeEqual } from "./worker";

export const MAX_BYTES = 2e9;
const TTL = 3600_000;
const secret = () => {
  const s = process.env.PUBLISH_KEY || process.env.MCP_TOKEN || "";
  if (s.length < 16) throw new Error("Set MCP_TOKEN on Vercel first.");
  return s;
};
const sign = (body: string) => createHmac("sha256", secret()).update(`voicebox-inbox-v1:${body}`).digest("base64url");

type Ticket = { f: string; k: string; n: string; m: string; p: string | null; d: string | null; e: number; c?: string; o?: number; s?: number };
/** The most a PUT through our own domain can carry: Cloudflare caps a request body at 100 MB. Bigger files use the
 *  presigned R2 address. */
export const PUT_MAX = 95e6;

export async function startUpload(input: { name?: unknown; type?: unknown; size?: unknown; folder?: unknown; post_id?: unknown; carousel?: unknown; position?: unknown }, origin?: string) {
  const name = String(input.name ?? "").trim().replace(/[\\/\0]/g, "_").slice(-200);
  if (!name || !/\.[A-Za-z0-9]{1,8}$/.test(name)) throw new Error("name needs a file extension, e.g. clip.mp4");
  const size = input.size == null ? null : Number(input.size);
  if (size != null && (!isFinite(size) || size < 0 || size > MAX_BYTES)) throw new Error("files go up to 2 GB");
  await assertRoom(size);
  const mime = String(input.type ?? "") || mimeFor(name);
  let folder: string | null = null;
  if (input.folder) {
    const f = findFolder(await getTree(), String(input.folder));
    if (!f) throw new Error(`no folder "${input.folder}"`);
    folder = f.system ? null : f.id;
  }
  const carousel = input.carousel == null || input.carousel === "" ? undefined : String(input.carousel).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 120);
  const position = input.position == null || input.position === "" ? undefined : Number(input.position);
  if (position != null && (!Number.isInteger(position) || position < 1 || position > 100)) throw new Error("position: 1 to 100 (1 = first in the carousel)");
  if (position != null && !carousel) throw new Error("position needs a carousel");
  const fileId = randomBytes(10).toString("hex");
  const key = `workspace/media/${fileId}/${name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)}`;
  const t: Ticket = { f: fileId, k: key, n: name, m: mime, p: input.post_id ? String(input.post_id).slice(0, 64) : null, d: folder, e: Date.now() + TTL,
    ...(carousel ? { c: carousel } : {}), ...(position ? { o: position } : {}), ...(size != null ? { s: size } : {}) };
  const body = Buffer.from(JSON.stringify(t)).toString("base64url");
  const ticket = `${body}.${sign(body)}`;
  const upload_url = await presign(key, "PUT", TTL / 1000);
  // the same upload through our own domain (app/api/files/put): for clients that can't reach the R2 hostname
  const base = (await import("./colab")).appOrigin(origin) || "https://voiceboxstudio.pages.dev";
  const put_url = base && (size == null || size <= PUT_MAX) ? `${base}/api/files/put/${ticket}` : null;
  return { upload_url, put_url, ticket, expires_at: new Date(t.e).toISOString(), max_bytes: MAX_BYTES, put_max_bytes: PUT_MAX, content_type: mime, carousel: carousel ?? null, position: position ?? null };
}

function readTicket(ticket: string): Ticket {
  const [body, mac] = String(ticket).split(".");
  if (!body || !mac || !safeEqual(mac, sign(body))) throw new Error("that ticket isn't valid");
  let t: Ticket;
  try { t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Ticket; } catch { throw new Error("that ticket isn't valid"); }
  if (Date.now() > t.e + TTL) throw new Error("that ticket has expired; start the upload again");
  return t;
}

const DONE = (f: string) => `workspace/inbox/${f}.json`;
const RECEIPT = (f: string) => `workspace/inbox/${f}.put.json`;
type Receipt = { bytes: number; sha256: string; content_type: string; at: string };

/** Step 2 through our own domain: the raw bytes of a PUT stream into R2 through the Worker's binding, unchanged, and
 *  the answer is a receipt with their size and SHA-256. A ticket takes one PUT, before it expires, of exactly the
 *  size it was started with (when one was given), and a type that matches its file's (or application/octet-stream). */
export async function putUpload(ticket: string, req: Request) {
  const t = readTicket(ticket);
  if (Date.now() > t.e) throw new UploadError(410, "this upload address has expired; start the upload again");
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (!Number.isInteger(len) || len < 0) throw new UploadError(411, "send Content-Length (curl -T <file> or --data-binary @<file> do)");
  if (len > PUT_MAX) throw new UploadError(413, `over ${PUT_MAX / 1e6} MB through this address: PUT it to upload_url instead`);
  if (t.s != null && len !== t.s) throw new UploadError(400, `this ticket is for ${t.s} bytes; the request has ${len}`);
  const type = alias((req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase());
  if (type && type !== "application/octet-stream" && type !== alias(t.m.toLowerCase()))
    throw new UploadError(415, `this ticket is for ${t.m} (${t.n}); send that Content-Type or application/octet-stream`);
  if (await headObj(t.k)) throw new UploadError(409, "this ticket's file is already uploaded: turn the ticket in with save_file { ticket }");
  if (!req.body && len > 0) throw new UploadError(400, "no body");
  const [toStore, toHash] = (req.body ?? new Response(new Uint8Array()).body!).tee();
  const hashing = sha256Of(toHash);
  hashing.catch(() => null); // a failed store says why below; the hash's own failure isn't the news
  const streamed = await putStream(t.k, toStore, len, t.m);
  if (!streamed) await putObj(t.k, await new Response(toStore).arrayBuffer(), t.m); // off Cloudflare, or an empty file
  const sha256 = await hashing;
  const head = await headObj(t.k);
  if (!head || head.size !== len) throw new UploadError(500, `stored ${head?.size ?? 0} bytes of ${len}; PUT it again`);
  const r: Receipt = { bytes: len, sha256, content_type: t.m, at: new Date().toISOString() };
  await putJson(RECEIPT(t.f), r);
  return { ...r, name: t.n, next: "call save_file again with { ticket } (or POST it to /api/files/complete)" };
}

const ALIASES: Record<string, string> = { "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav", "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "audio/mp3": "audio/mpeg" };
const alias = (m: string) => ALIASES[m] ?? m;

export class UploadError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function sha256Of(body: ReadableStream<Uint8Array>) {
  const DS = (crypto as unknown as { DigestStream?: new (a: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream;
  if (DS) { const d = new DS("SHA-256"); await body.pipeTo(d); return Buffer.from(await d.digest).toString("hex"); }
  const h = createHash("sha256");
  const rd = body.getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; h.update(value); }
  return h.digest("hex");
}

type Done = { media: string; name: string; carousel?: { error?: string } | null };

/** Join the ticket's carousel; on failure the answer says so, and turning the same ticket in again tries again. */
async function joinFor(t: Ticket, mediaId: string, actor: { name: string }) {
  if (!t.c) return null;
  return joinCarousel(t.c, `m:${mediaId}`, { position: t.o, post: t.p, by: actor.name }).catch((e: Error) => ({ error: e.message, retry: "turn the same ticket in again" }));
}

/** Start several uploads at once (one carousel's photos): each file gets its own address and ticket. */
export async function startUploads(input: { files?: unknown; folder?: unknown; post_id?: unknown; carousel?: unknown }, origin?: string) {
  const files = Array.isArray(input.files) ? input.files as Record<string, unknown>[] : [];
  if (!files.length || files.length > 100) throw new Error("files: 1 to 100 of {name, size?, type?, position?}");
  const auto = files.every((f) => f.position == null) && !!input.carousel; // no positions given: the order they're listed in
  const out = await Promise.all(files.map((f, i) => startUpload({ ...f, folder: input.folder, post_id: input.post_id, carousel: input.carousel, position: f.position ?? (auto ? i + 1 : undefined) }, origin)));
  return out.map((r, i) => ({ name: String(files[i].name), ...r }));
}

/** Turn in several tickets at once: the files are copied side by side, each joining its carousel (the writes are
 *  conditional and retried, so none drops out). */
export async function completeUploads(tickets: string[], actor: { id?: string; name: string }) {
  if (!tickets.length || tickets.length > 100) throw new Error("tickets: 1 to 100");
  return Promise.all(tickets.map((tk) => completeUpload(tk, actor).catch((e: Error) => ({ ticket: tk.slice(0, 16), error: e.message }))));
}

export async function completeUpload(ticket: string, actor: { id?: string; name: string }) {
  const t = readTicket(ticket);
  const done = await getJson<Done>(DONE(t.f)).catch(() => null);
  if (done) {
    if (t.c && (!done.carousel || done.carousel.error)) {
      // the file is in; only the carousel failed last time: try that again
      const carousel = await joinFor(t, done.media, actor);
      await putJson(DONE(t.f), { ...done, carousel });
      return { ...done, carousel, file_id: `m:${done.media}`, already: true };
    }
    return { ...done, file_id: `m:${done.media}`, already: true };
  }
  const head = await headObj(t.k);
  if (!head) throw new Error("nothing was uploaded yet: PUT the file to upload_url first (curl -T <file> '<upload_url>')");
  if (head.size > MAX_BYTES) throw new Error("files go up to 2 GB");
  if (t.s != null && head.size !== t.s) throw new Error(`the upload has ${head.size} bytes; this ticket is for ${t.s}. PUT it again`);
  const receipt = await getJson<Receipt>(RECEIPT(t.f)).catch(() => null);
  const { media } = await addMediaFromR2(t.k, head.size, t.m, t.n, t.f, { postId: t.p }, actor);
  if (t.d) await moveItems([`m:${media.$id}`], t.d);
  // the file is saved either way; a carousel that can't take it says so in the answer
  const carousel = await joinFor(t, media.$id, actor);
  await putJson(DONE(t.f), { media: media.$id, name: media.name, carousel });
  warmPreviews(media);
  return { media: media.$id, file_id: `m:${media.$id}`, name: media.name, kind: media.kind, mb: Math.round(head.size / 1e5) / 10, bytes: head.size, ...(receipt ? { sha256: receipt.sha256 } : {}), folder: t.d, post_id: t.p, carousel, already: false };
}

/** Make (and cache) an image's card and screen sizes now, so the first look in Files is instant. */
function warmPreviews(m: { kind: string; file_id: string; token: string | null }) {
  if (m.kind !== "image" || !m.token || m.file_id.startsWith("r2_")) return; // an R2 photo's sizes are made on first look
  const urls = [480, 1280, 1920].map((w) => fileUrl(m, "preview", w));
  const go = Promise.allSettled(urls.map((u) => fetch(u, { cache: "no-store" }).then((r) => r.arrayBuffer())));
  try { after(() => go); } catch { /* outside a request: let it run */ }
}

// ── upload keys: a key that can only save files (for an AI or a script), revocable in Settings

const KEYS = "workspace/upload-keys.json";
type Key = { id: string; name: string; hash: string; at: number; by: string; used: number | null };
const hash = (k: string) => createHash("sha256").update(k).digest("hex");

export async function listKeys() {
  return ((await getJson<Key[]>(KEYS).catch(() => null)) ?? []).map(({ hash: _, ...k }) => k);
}
export async function createKey(name: string, by: string) {
  const all = (await getJson<Key[]>(KEYS).catch(() => null)) ?? [];
  if (all.length >= 10) throw new Error("Up to 10 upload keys; revoke one first.");
  const key = `vbup_${randomBytes(24).toString("base64url")}`;
  const k: Key = { id: randomBytes(6).toString("hex"), name: name.trim().slice(0, 60) || "Upload key", hash: hash(key), at: Date.now(), by, used: null };
  await putJson(KEYS, [...all, k]);
  return { key, id: k.id, name: k.name };
}
export async function revokeKey(id: string) {
  const all = (await getJson<Key[]>(KEYS).catch(() => null)) ?? [];
  await putJson(KEYS, all.filter((k) => k.id !== id));
}
/** The request carries an upload key (Bearer vbup_…): it may start and finish uploads, nothing else. */
export async function uploadKeyOk(req: Request) {
  const b = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!b.startsWith("vbup_")) return null;
  const all = (await getJson<Key[]>(KEYS).catch(() => null)) ?? [];
  const k = all.find((x) => safeEqual(x.hash, hash(b)));
  if (!k) return null;
  if (!k.used || Date.now() - k.used > 3600_000) { k.used = Date.now(); await putJson(KEYS, all).catch(() => {}); }
  return k;
}
