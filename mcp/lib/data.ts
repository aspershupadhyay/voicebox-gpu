// Server side of the shared workspace: posts, comments, activity and media rows in Postgres on Neon (lib/db.ts), the
// files themselves in R2 (lib/r2files.ts), the team in the users table (lib/users.ts). The MCP tools, the API routes and
// the publishing code all come through here. (Until 2026-10-31 this was lib/appwrite.ts: docs/MIGRATION.md.)
import { POST_FIELDS, kindOf, type Comment, type Media, type Member, type Post } from "./workspace";
import { delObjs, presign, putObj, putStream } from "./store";
import { adopt, assertRoom, fileSig, mediaKey } from "./r2files";
import { DataError, deleteRow, getRow, hasDb, insertRow, listRows, patchRow, type Q, type Table } from "./db";

export { DataError, type Table };

/** The shared workspace is there: the database is configured. */
export const hasWorkspace = () => hasDb();

export const listOf = <T>(table: Table, ...qs: object[]): Promise<T[]> => listRows<T>(table, qs as Q[]);
export const rowOf = <T>(table: Table, id: string): Promise<T> => getRow<T>(table, id);
export const insert = <T>(table: Table, data: Record<string, unknown>, rowId?: string): Promise<T> => insertRow<T>(table, data, rowId);
export const patch = <T>(table: Table, id: string, data: Record<string, unknown>): Promise<T> => patchRow<T>(table, id, data);
export const remove = (table: Table, id: string) => deleteRow(table, id);

// ── people

/** The studio team (the users table, lib/users.ts). */
export async function listMembers(): Promise<Member[]> {
  return (await import("./users")).listUsers();
}

/** Take someone off the studio team (Settings → Security). Their next request is refused (lib/session.ts). */
export async function removeMember(email: string) {
  return (await import("./users")).setMember(email, false);
}

// ── posts

export async function listPosts(opts: { status?: string; limit?: number } = {}) {
  const qs: object[] = [{ method: "orderDesc", attribute: "$updatedAt" }, { method: "limit", values: [Math.min(opts.limit ?? 50, 200)] }];
  if (opts.status) qs.push({ method: "equal", attribute: "status", values: [opts.status] });
  return listOf<Post>("posts", ...qs);
}

export const getPost = (id: string) => rowOf<Post>("posts", id);

function pickPost(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of POST_FIELDS) if (data[k] !== undefined) out[k] = data[k];
  return out;
}

export async function createPost(data: Partial<Post>, actor: { id?: string; name: string }, rowId?: string) {
  const row = await insert<Post>("posts", { status: "idea", platforms: [], jobs: [], ...pickPost(data), owner_id: actor.id ?? null, owner_name: actor.name }, rowId);
  await logActivity({ post_id: row.$id, verb: "created", text: row.title }, actor);
  return row;
}

export async function updatePost(id: string, data: Partial<Post>, actor: { id?: string; name: string }) {
  const before = await getPost(id);
  const row = await patch<Post>("posts", id, pickPost(data));
  if (data.status && data.status !== before.status) await logActivity({ post_id: id, verb: "moved", text: `${before.status} → ${data.status}` }, actor);
  else await logActivity({ post_id: id, verb: "edited", text: Object.keys(pickPost(data)).join(", ") }, actor);
  return row;
}

export async function listComments(postId: string) {
  return listOf<Comment>("comments", { method: "equal", attribute: "post_id", values: [postId] }, { method: "orderAsc", attribute: "$createdAt" }, { method: "limit", values: [200] });
}

export async function addComment(postId: string, body: string, actor: { id?: string; name: string }) {
  const row = await insert<Comment>("comments", { post_id: postId, body, author_id: actor.id ?? null, author_name: actor.name });
  await logActivity({ post_id: postId, verb: "commented", text: body.slice(0, 200) }, actor);
  return row;
}

export async function logActivity(a: { post_id?: string | null; verb: string; text?: string }, actor: { id?: string; name: string }) {
  await insert("activity", { post_id: a.post_id ?? null, verb: a.verb, text: (a.text ?? "").slice(0, 500), actor_id: actor.id ?? null, actor_name: actor.name }).catch(() => {}); // the feed is nice-to-have; never fail the real write over it
}

export async function deletePost(id: string, actor: { id?: string; name: string }) {
  const p = await getPost(id);
  await remove("posts", id);
  await logActivity({ verb: "deleted", text: p.title }, actor);
}

/** Attach a finished voiceover (library job id) to a post. */
export async function linkJob(postId: string, jobId: string, actor: { id?: string; name: string }) {
  const p = await getPost(postId);
  if ((p.jobs ?? []).includes(jobId)) return p;
  const row = await patch<Post>("posts", postId, { jobs: [...(p.jobs ?? []), jobId] });
  await logActivity({ post_id: postId, verb: "voiced", text: jobId }, actor);
  return row;
}

export async function listActivity(limit = 30, postId?: string) {
  const qs: object[] = [{ method: "orderDesc", attribute: "$createdAt" }, { method: "limit", values: [Math.min(limit, 100)] }];
  if (postId) qs.push({ method: "equal", attribute: "post_id", values: [postId] });
  return listOf<{ $createdAt: string; post_id: string | null; verb: string; text: string | null; actor_name: string | null }>("activity", ...qs);
}

export async function postsBetween(from: string, to: string) {
  return listOf<Post>("posts",
    { method: "greaterThanEqual", attribute: "due_at", values: [from] }, { method: "lessThan", attribute: "due_at", values: [to] },
    { method: "orderAsc", attribute: "due_at" }, { method: "limit", values: [200] });
}

// ── media (every file lives in R2 under workspace/media/, served by /api/m with its row's token)

export const getMedia = (id: string) => rowOf<Media>("media", id);

export async function listMedia(postId?: string, limit = 100) {
  const qs: object[] = [{ method: "orderDesc", attribute: "$createdAt" }, { method: "limit", values: [Math.min(limit, 1000)] }];
  if (postId) qs.push({ method: "equal", attribute: "post_id", values: [postId] });
  return listOf<Media>("media", ...qs);
}

/** A file's row, with its token made if it somehow has none (a row written by hand). */
export async function finalizeMedia(mediaId: string) {
  const m = await getMedia(mediaId);
  const media = !m.token && m.r2_key ? await patch<Media>("media", mediaId, { token: fileSig(m.r2_key) }) : m;
  return { media, backup: undefined as string | undefined };
}

/** A short-lived direct link to the file in R2. */
export const backupUrl = (m: Media) => (m.r2_key ? presign(m.r2_key, "GET", 6 * 3600) : null);

/** Delete a workspace file: its bytes in R2 and its row. */
export async function deleteMediaRow(id: string, actor: { id?: string; name: string }) {
  const m = await getMedia(id);
  if (m.r2_key) await delObjs([m.r2_key]);
  await remove("media", id);
  await logActivity({ post_id: m.post_id, verb: "deleted", text: m.name }, actor);
  return m;
}

/** Rename a workspace file (the row's name; the stored file keeps its key). */
export async function renameMedia(id: string, name: string, actor: { id?: string; name: string }) {
  const before = await getMedia(id);
  const row = await patch<Media>("media", id, { name: name.slice(0, 255) });
  await logActivity({ post_id: before.post_id, verb: "renamed", text: `${before.name} → ${row.name}` }, actor);
  return row;
}

/** Attach an upload to a post (or take it off one with null). */
export const setMediaPost = (id: string, postId: string | null) => patch<Media>("media", id, { post_id: postId });

const FETCH_MAX = 150e6;

/** Pull a file from a URL into Files. */
export async function addMediaFromUrl(url: string, opts: { name?: string; postId?: string | null; backup?: boolean }, actor: { id?: string; name: string }) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`could not fetch the file: ${r.status}`);
  const mime = (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
  const name = (opts.name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "file")).slice(0, 255);
  const size = Number(r.headers.get("content-length") ?? 0);
  if (size > FETCH_MAX) { r.body?.cancel().catch(() => null); throw new Error(`file is ${(size / 1e6).toFixed(0)} MB; use download or save_file for files over ${FETCH_MAX / 1e6} MB`); }
  // streamed when its size is known (a Worker has 128 MB of memory), else read whole
  const streamed = r.body && size > 0 ? await addMediaStream(r.body as ReadableStream<Uint8Array>, size, mime, name, opts, actor) : null;
  return streamed ?? addMediaBytes(new Uint8Array(await r.arrayBuffer()), mime, name, opts, actor);
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4",
  mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", pdf: "application/pdf", txt: "text/plain",
  md: "text/markdown", srt: "application/x-subrip", vtt: "text/vtt", json: "application/json", csv: "text/csv",
  svg: "image/svg+xml", avif: "image/avif", heic: "image/heic", zip: "application/zip", flac: "audio/flac", aac: "audio/aac" };
export const mimeFor = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Store bytes in Files (R2) and give them a row. */
export async function addMediaBytes(bytes: Uint8Array, mime: string, name: string, opts: { postId?: string | null; backup?: boolean }, actor: { id?: string; name: string }) {
  if (bytes.length > FETCH_MAX) throw new Error(`file is ${(bytes.length / 1e6).toFixed(0)} MB; upload files over ${FETCH_MAX / 1e6} MB from the Files page`);
  if (mime === "application/octet-stream") mime = mimeFor(name);
  const fileId = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  await assertRoom(bytes.length);
  const key = mediaKey(fileId, name);
  await putObj(key, bytes as BodyInit, mime);
  return mediaRow(`r2_${fileId}`, name, mime, bytes.length, key, opts, actor);
}

/** A download's body into Files as it arrives (size known), so a big video never sits whole in the Worker's memory.
 *  Null when it can't be streamed here (no size, or not on Cloudflare): the caller buffers or hands it on. */
export async function addMediaStream(body: ReadableStream<Uint8Array>, size: number, mime: string, name: string, opts: { postId?: string | null }, actor: { id?: string; name: string }) {
  if (!(size > 0)) return null;
  if (mime === "application/octet-stream") mime = mimeFor(name);
  await assertRoom(size);
  const fileId = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const key = mediaKey(fileId, name);
  if (!(await putStream(key, body, size, mime))) return null;
  return mediaRow(`r2_${fileId}`, name, mime, size, key, opts, actor);
}

async function mediaRow(fileId: string, name: string, mime: string, size: number, r2Key: string, opts: { postId?: string | null }, actor: { id?: string; name: string }) {
  const media = await insert<Media>("media", {
    file_id: fileId, name, mime, size, kind: kindOf(mime, name), post_id: opts.postId ?? null, uploaded_by: actor.id ?? null, uploaded_name: actor.name,
    r2_key: r2Key, token: fileSig(r2Key),
  });
  await logActivity({ post_id: opts.postId ?? null, verb: "uploaded", text: name }, actor);
  return { media, backup: undefined as string | undefined };
}

/** A file already in R2 (the upload endpoint, a download) into Files: moved to its Files key, given a row. A second
 *  save of the same file (a retry after a timeout) finds the row it already has. */
export async function addMediaFromR2(key: string, size: number, mime: string, name: string, fileId: string, opts: { postId?: string | null }, actor: { id?: string; name: string }) {
  const id = `r2_${fileId}`.slice(0, 36);
  const had = await listOf<Media>("media", { method: "equal", attribute: "file_id", values: [id] }, { method: "limit", values: [1] }).catch(() => null);
  if (had?.[0]) return finalizeMedia(had[0].$id);
  const at = await adopt(key, fileId, name);
  return mediaRow(id, name, mime, size, at, opts, actor);
}
