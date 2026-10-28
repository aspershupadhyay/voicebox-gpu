// Saving files straight into Files, for any AI or script (Settings → Upload keys, the save_file MCP tool, and
// /api/files/upload + /api/files/complete). An MCP call or a Vercel request can carry about 4.5 MB, so the bytes skip
// both: step 1 hands out a presigned R2 address (one hour) and a signed ticket; step 2 is one `curl -T file <address>`
// (up to 2 GB); step 3 turns the ticket in, and the file is copied into the workspace 5 MB at a time, filed in its
// folder and attached to its post. The R2 copy stays as its backup. A ticket works once and only for its own file.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { addMediaFromR2, mimeFor } from "./appwrite";
import { findFolder, getTree, moveItems } from "./files";
import { getJson, headObj, presign, putJson } from "./store";
import { safeEqual } from "./worker";

export const MAX_BYTES = 2e9;
const TTL = 3600_000;
const secret = () => {
  const s = process.env.PUBLISH_KEY || process.env.MCP_TOKEN || "";
  if (s.length < 16) throw new Error("Set MCP_TOKEN on Vercel first.");
  return s;
};
const sign = (body: string) => createHmac("sha256", secret()).update(`voicebox-inbox-v1:${body}`).digest("base64url");

type Ticket = { f: string; k: string; n: string; m: string; p: string | null; d: string | null; e: number };

export async function startUpload(input: { name?: unknown; type?: unknown; size?: unknown; folder?: unknown; post_id?: unknown }) {
  const name = String(input.name ?? "").trim().replace(/[\\/\0]/g, "_").slice(-200);
  if (!name || !/\.[A-Za-z0-9]{1,8}$/.test(name)) throw new Error("name needs a file extension, e.g. clip.mp4");
  const size = input.size == null ? null : Number(input.size);
  if (size != null && (!isFinite(size) || size < 0 || size > MAX_BYTES)) throw new Error("files go up to 2 GB");
  const mime = String(input.type ?? "") || mimeFor(name);
  let folder: string | null = null;
  if (input.folder) {
    const f = findFolder(await getTree(), String(input.folder));
    if (!f) throw new Error(`no folder "${input.folder}"`);
    folder = f.system ? null : f.id;
  }
  const fileId = randomBytes(10).toString("hex");
  const key = `workspace/media/${fileId}/${name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)}`;
  const t: Ticket = { f: fileId, k: key, n: name, m: mime, p: input.post_id ? String(input.post_id).slice(0, 64) : null, d: folder, e: Date.now() + TTL };
  const body = Buffer.from(JSON.stringify(t)).toString("base64url");
  const upload_url = await presign(key, "PUT", TTL / 1000);
  return { upload_url, ticket: `${body}.${sign(body)}`, expires_at: new Date(t.e).toISOString(), max_bytes: MAX_BYTES, content_type: mime };
}

function readTicket(ticket: string): Ticket {
  const [body, mac] = String(ticket).split(".");
  if (!body || !mac || !safeEqual(mac, sign(body))) throw new Error("that ticket isn't valid");
  const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Ticket;
  if (Date.now() > t.e + TTL) throw new Error("that ticket has expired; start the upload again");
  return t;
}

const DONE = (f: string) => `workspace/inbox/${f}.json`;

export async function completeUpload(ticket: string, actor: { id?: string; name: string }) {
  const t = readTicket(ticket);
  const done = await getJson<{ media: string; name: string }>(DONE(t.f)).catch(() => null);
  if (done) return { ...done, file_id: `m:${done.media}`, already: true };
  const head = await headObj(t.k);
  if (!head) throw new Error("nothing was uploaded yet: PUT the file to upload_url first (curl -T <file> '<upload_url>')");
  if (head.size > MAX_BYTES) throw new Error("files go up to 2 GB");
  const { media } = await addMediaFromR2(t.k, head.size, t.m, t.n, t.f, { postId: t.p }, actor);
  if (t.d) await moveItems([`m:${media.$id}`], t.d);
  await putJson(DONE(t.f), { media: media.$id, name: media.name });
  return { media: media.$id, file_id: `m:${media.$id}`, name: media.name, kind: media.kind, mb: Math.round(head.size / 1e5) / 10, folder: t.d, post_id: t.p, already: false };
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
