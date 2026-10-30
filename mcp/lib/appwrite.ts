// Server side of the shared workspace: plain REST calls to Appwrite Cloud with the project's API key (APPWRITE_API_KEY),
// or with a user's JWT when we only need to know who they are. The browser talks to Appwrite directly for live sync.
// The workspace's rows go through listOf/rowOf/insert/patch/remove: Appwrite today, Postgres on Neon with DB_BACKEND=neon
// (lib/db.ts, docs/MIGRATION.md phase 2), so every caller works on either without knowing which.
import { AW, POST_FIELDS, type Comment, type Media, type Member, type Post } from "./workspace";
import { delObjs, presign, putObj } from "./store";
import { FILES_ON_R2, adopt, assertRoom, fileSig, mediaKey } from "./r2files";

export class AppwriteError extends Error {
  constructor(message: string, public status: number, public type = "") { super(message); }
}

export const hasKey = () => !!process.env.APPWRITE_API_KEY;
/** The shared workspace is there: Appwrite's key, or the rows in Postgres (DB_BACKEND=neon) / accounts there (AUTH_BACKEND=neon). */
export const hasWorkspace = () => hasKey() || process.env.DB_BACKEND === "neon";
export const hasPeople = () => hasKey() || process.env.AUTH_BACKEND === "neon";

async function aw<T>(path: string, init: { method?: string; body?: unknown; jwt?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Appwrite-Project": AW.project };
  if (init.jwt) headers["X-Appwrite-JWT"] = init.jwt;
  else if (process.env.APPWRITE_API_KEY) headers["X-Appwrite-Key"] = process.env.APPWRITE_API_KEY;
  else throw new AppwriteError("The shared workspace is not configured (APPWRITE_API_KEY).", 503);
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${AW.endpoint}${path}`, { method: init.method ?? "GET", headers, cache: "no-store", body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new AppwriteError(data.message || `Appwrite ${r.status}`, r.status, data.type);
  return data as T;
}

const q = (...queries: object[]) => queries.map((x) => `queries[]=${encodeURIComponent(JSON.stringify(x))}`).join("&");
const rows = (table: string) => `/tablesdb/${AW.db}/tables/${table}/rows`;

export type Table = "posts" | "comments" | "activity" | "media";
const onNeon = () => process.env.DB_BACKEND === "neon";
const pg = () => import("./db");
const at = (table: Table, id: string) => `${rows(table)}/${encodeURIComponent(id)}`;

export async function listOf<T>(table: Table, ...qs: object[]): Promise<T[]> {
  return onNeon() ? (await pg()).listRows<T>(table, qs as never) : (await aw<{ rows: T[] }>(`${rows(table)}?${q(...qs)}`)).rows;
}
export const rowOf = async <T>(table: Table, id: string): Promise<T> => (onNeon() ? (await pg()).getRow<T>(table, id) : aw<T>(at(table, id)));
export async function insert<T>(table: Table, data: Record<string, unknown>, rowId = "unique()", extra: object = {}): Promise<T> {
  return onNeon() ? (await pg()).insertRow<T>(table, data, rowId === "unique()" ? undefined : rowId) : aw<T>(rows(table), { method: "POST", body: { rowId, data, ...extra } });
}
export const patch = async <T>(table: Table, id: string, data: Record<string, unknown>): Promise<T> =>
  onNeon() ? (await pg()).patchRow<T>(table, id, data) : aw<T>(at(table, id), { method: "PATCH", body: { data } });
export const remove = async (table: Table, id: string) => { if (onNeon()) await (await pg()).deleteRow(table, id); else await aw(at(table, id), { method: "DELETE" }); };

/** With DB_BACKEND=neon, each write to Postgres is copied back to Appwrite under the same id (lib/db.ts), so unsetting
 *  the switch loses nothing. Never fails the real write: a row Appwrite never had is skipped. */
export async function awMirror(op: "create" | "update" | "delete", table: Table, id: string, data?: Record<string, unknown>) {
  if (!hasKey()) return; // Appwrite already gone (the Cloudflare move): nothing to keep in step
  try {
    if (op === "create") await aw(rows(table), { method: "POST", body: { rowId: id, data } });
    else if (op === "update") await aw(at(table, id), { method: "PATCH", body: { data } });
    else await aw(at(table, id), { method: "DELETE" });
  } catch (e) {
    if (!(e instanceof AppwriteError && e.status === 404)) console.warn(`appwrite copy (${op} ${table}/${id}) failed: ${(e as Error).message}`);
  }
}

/** Every row of a table, oldest first, 100 at a time (the copy into Postgres: lib/db.ts). */
export async function allRows(table: "posts" | "comments" | "activity" | "media") {
  const out: Record<string, unknown>[] = [];
  for (let after: string | null = null; ;) {
    const page: { rows: Record<string, unknown>[] } = await aw(`${rows(table)}?${q({ method: "orderAsc", attribute: "$sequence" }, { method: "limit", values: [100] }, ...(after ? [{ method: "cursorAfter", values: [after] }] : []))}`);
    out.push(...page.rows);
    if (page.rows.length < 100) return out;
    after = String(page.rows[page.rows.length - 1].$id);
  }
}

// ── people

export type AwUser = { $id: string; name: string; email: string };

/** Who a browser JWT belongs to (throws when it is expired or forged). */
export const userFromJwt = (jwt: string) => aw<AwUser>("/account", { jwt });

/** Create a person's account with the server key. The caller has already checked they're on the list (lib/access.ts),
 *  so an uninvited email never gets an account. Throws AppwriteError 409 when the email already has one. */
export const createUser = (email: string, password: string, name: string) =>
  aw<AwUser>("/users", { method: "POST", body: { userId: "unique()", email, password, name } });

/** For moving sign-in off Appwrite (lib/users.ts): is this Appwrite's password for that email? Opens a session to find
 *  out (no key needed) and closes it again; the account, or null when the password is wrong. */
export async function checkAppwritePassword(email: string, password: string): Promise<AwUser | null> {
  const r = await fetch(`${AW.endpoint}/account/sessions/email`, { method: "POST", headers: { "X-Appwrite-Project": AW.project, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), cache: "no-store" });
  if (r.status === 401 || r.status === 400) return null;
  if (!r.ok) throw new AppwriteError(`Appwrite ${r.status}`, r.status);
  const s = (await r.json()) as { $id: string; userId: string };
  const user = await aw<AwUser>(`/users/${encodeURIComponent(s.userId)}`);
  await aw(`/users/${encodeURIComponent(s.userId)}/sessions/${encodeURIComponent(s.$id)}`, { method: "DELETE" }).catch(() => null);
  return user;
}

/** The Appwrite account with this email, if there is one. */
export async function findAppwriteUser(email: string) {
  const r = await aw<{ users: AwUser[] }>(`/users?${q({ method: "equal", attribute: "email", values: [email] }, { method: "limit", values: [1] })}`);
  return r.users[0] ?? null;
}

/** Put a signed-in user on the studio team. Idempotent. */
export async function ensureMember(user: AwUser) {
  try {
    await aw(`/teams/${AW.team}/memberships`, { method: "POST", body: { userId: user.$id, roles: ["owner"], name: user.name } });
  } catch (e) {
    if (!(e instanceof AppwriteError && e.status === 409)) throw e; // already a member
  }
}

/** Take someone off the studio team (Settings → Security). Their next request is refused (lib/session.ts). */
export async function removeMember(email: string) {
  if (process.env.AUTH_BACKEND === "neon") return (await import("./users")).setMember(email, false);
  const r = await aw<{ memberships: { $id: string; userEmail: string }[] }>(`/teams/${AW.team}/memberships?${q({ method: "limit", values: [100] })}`);
  const m = r.memberships.find((x) => x.userEmail.toLowerCase() === email.toLowerCase());
  if (m) await aw(`/teams/${AW.team}/memberships/${m.$id}`, { method: "DELETE" });
  return !!m;
}

export async function listMembers(): Promise<Member[]> {
  if (process.env.AUTH_BACKEND === "neon") {
    const users = await (await import("./users")).listUsers();
    if (users.length || !hasKey()) return users;
    // nobody moved yet: Appwrite's team still says who's in (an empty list would let anyone found the studio)
  }
  return appwriteMembers();
}

/** The studio team as Appwrite has it (also what lib/users.ts copies over). */
export async function appwriteMembers(): Promise<Member[]> {
  const r = await aw<{ memberships: { userId: string; userName: string; userEmail: string }[] }>(`/teams/${AW.team}/memberships?${q({ method: "limit", values: [25] })}`);
  return r.memberships.map((m) => ({ id: m.userId, name: m.userName || m.userEmail.split("@")[0], email: m.userEmail }));
}

// ── posts (used by the MCP tools; the dashboard writes straight from the browser)

const PERMS: string[] = []; // table-level team permissions cover every row

export async function listPosts(opts: { status?: string; limit?: number } = {}) {
  const qs = [{ method: "orderDesc", attribute: "$updatedAt" }, { method: "limit", values: [Math.min(opts.limit ?? 50, 200)] }];
  if (opts.status) qs.push({ method: "equal", attribute: "status", values: [opts.status] } as never);
  return listOf<Post>("posts", ...qs);
}

export const getPost = (id: string) => rowOf<Post>("posts", id);

function pickPost(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of POST_FIELDS) if (data[k] !== undefined) out[k] = data[k];
  return out;
}

export async function createPost(data: Partial<Post>, actor: { id?: string; name: string }, rowId = "unique()") {
  const row = await insert<Post>("posts", { status: "idea", platforms: [], jobs: [], ...pickPost(data), owner_id: actor.id ?? null, owner_name: actor.name }, rowId, { permissions: PERMS });
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

// ── media

export async function getMedia(id: string) {
  return rowOf<Media>("media", id);
}

export async function listMedia(postId?: string, limit = 100) {
  const qs: object[] = [{ method: "orderDesc", attribute: "$createdAt" }, { method: "limit", values: [Math.min(limit, 1000)] }];
  if (postId) qs.push({ method: "equal", attribute: "post_id", values: [postId] });
  return listOf<Media>("media", ...qs);
}

/** Give an uploaded file a token so it plays in <img>/<video> anywhere, and (optionally) back it up to R2. */
export async function finalizeMedia(mediaId: string, opts: { backup: boolean }) {
  const m = await getMedia(mediaId);
  const change: Partial<Media> = {};
  if (!m.token) {
    const t = await aw<{ secret: string }>(`/tokens/buckets/${AW.bucket}/files/${m.file_id}`, { method: "POST", body: {} });
    change.token = t.secret;
  }
  let backup: string | undefined;
  if (opts.backup && !m.r2_key) {
    if ((m.size ?? 0) > BACKUP_MAX) backup = `skipped: larger than ${BACKUP_MAX / 1e6} MB (back it up from the Media page later)`;
    else {
      try {
        change.r2_key = await backupToR2(m);
      } catch (e) {
        backup = `R2 backup failed: ${(e as Error).message}`;
      }
    }
  }
  const row = Object.keys(change).length ? await patch<Media>("media", mediaId, change) : m;
  return { media: row, backup };
}

const BACKUP_MAX = 180e6; // a serverless function holds the file in memory for the copy

async function backupToR2(m: Media) {
  const r = await fetch(`${AW.endpoint}/storage/buckets/${AW.bucket}/files/${m.file_id}/download`, {
    headers: { "X-Appwrite-Project": AW.project, "X-Appwrite-Key": process.env.APPWRITE_API_KEY ?? "" }, cache: "no-store",
  });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const key = `workspace/media/${m.file_id}/${m.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)}`;
  await putObj(key, await r.arrayBuffer(), m.mime || "application/octet-stream");
  return key;
}

/** R2 is the fallback: if Appwrite is unreachable (or the plan ends) the backed-up copy still plays. */
export const backupUrl = (m: Media) => (m.r2_key ? presign(m.r2_key, "GET", 6 * 3600) : null);

// ── used by the MCP tools

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

/** Move every file still kept in Appwrite Storage to R2 (docs/MIGRATION.md 2b): its bytes to its Files key, its
 *  row to an r2_ id with a token, so it's served by /api/m like any new upload. Appwrite's copy stays until Appwrite goes. */
export async function filesToR2() {
  const left = (await listOf<Media>("media", { method: "limit", values: [1000] })).filter((m) => !m.file_id.startsWith("r2_"));
  const moved: string[] = [], skipped: string[] = [];
  for (const m of left) {
    if ((m.size ?? 0) > BACKUP_MAX) { skipped.push(`${m.name} (larger than ${BACKUP_MAX / 1e6} MB)`); continue; }
    const r = await fetch(`${AW.endpoint}/storage/buckets/${AW.bucket}/files/${m.file_id}/download`, {
      headers: { "X-Appwrite-Project": AW.project, "X-Appwrite-Key": process.env.APPWRITE_API_KEY ?? "" }, cache: "no-store",
    });
    if (!r.ok) { skipped.push(`${m.name} (download ${r.status})`); continue; }
    const fileId = `r2_${m.file_id}`.slice(0, 36);
    const key = mediaKey(fileId, m.name);
    await putObj(key, await r.arrayBuffer(), m.mime || "application/octet-stream");
    await patch<Media>("media", m.$id, { file_id: fileId, r2_key: key, token: fileSig(key) });
    moved.push(m.name);
  }
  return { moved, skipped };
}

/** Delete a workspace file: the stored file and its row (an Appwrite file's R2 backup copy, if any, stays; a file kept
 *  in R2 goes with its row). */
export async function deleteMediaRow(id: string, actor: { id?: string; name: string }) {
  const m = await getMedia(id);
  if (m.file_id.startsWith("r2_")) { if (m.r2_key) await delObjs([m.r2_key]); }
  else await aw(`/storage/buckets/${AW.bucket}/files/${encodeURIComponent(m.file_id)}`, { method: "DELETE" }).catch(() => {});
  await remove("media", id);
  await logActivity({ post_id: m.post_id, verb: "deleted", text: m.name }, actor);
  return m;
}

/** Rename a workspace file (the row's name; the stored file keeps its id). */
export async function renameMedia(id: string, name: string, actor: { id?: string; name: string }) {
  const before = await getMedia(id);
  const row = await patch<Media>("media", id, { name: name.slice(0, 255) });
  await logActivity({ post_id: before.post_id, verb: "renamed", text: `${before.name} → ${row.name}` }, actor);
  return row;
}

/** Attach an upload to a post (or take it off one with null). */
/** A view token for one stored file that stops working at `expire` (share links: lib/shares.ts). */
export const createFileToken = (fileId: string, expire: string) => aw<{ $id: string; secret: string }>(`/tokens/buckets/${AW.bucket}/files/${encodeURIComponent(fileId)}`, { method: "POST", body: { expire } });
export const deleteFileToken = (tokenId: string) => aw(`/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" }).catch(() => null);

export async function setMediaPost(id: string, postId: string | null) {
  return patch<Media>("media", id, { post_id: postId });
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

const CHUNK = 5 * 1024 * 1024; // Appwrite takes uploads over 5 MB in Content-Range chunks
const FETCH_MAX = 150e6;

/** Pull a file from a URL into the workspace's media bucket (chunked like the web SDK), then token + R2 backup it. */
export async function addMediaFromUrl(url: string, opts: { name?: string; postId?: string | null; backup: boolean }, actor: { id?: string; name: string }) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`could not fetch the file: ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const mime = (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
  const name = (opts.name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "file")).slice(0, 255);
  return addMediaBytes(bytes, mime, name, opts, actor);
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4",
  mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", pdf: "application/pdf", txt: "text/plain",
  md: "text/markdown", srt: "application/x-subrip", vtt: "text/vtt", json: "application/json", csv: "text/csv" };
export const mimeFor = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Store bytes in the workspace's media bucket (chunked like the web SDK), then token + R2 backup it. */
export async function addMediaBytes(bytes: Uint8Array, mime: string, name: string, opts: { postId?: string | null; backup: boolean }, actor: { id?: string; name: string }) {
  if (bytes.length > FETCH_MAX) throw new Error(`file is ${(bytes.length / 1e6).toFixed(0)} MB; upload files over ${FETCH_MAX / 1e6} MB from the Media page`);
  if (mime === "application/octet-stream") mime = mimeFor(name);
  const fileId = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  if (FILES_ON_R2) {
    await assertRoom(bytes.length);
    const key = mediaKey(fileId, name);
    await putObj(key, bytes as BodyInit, mime);
    return mediaRow(`r2_${fileId}`, name, mime, bytes.length, key, opts, actor);
  }
  await sendChunks(fileId, name, mime, bytes.length, async (start, end) => bytes.slice(start, end).buffer as ArrayBuffer);
  return mediaRow(fileId, name, mime, bytes.length, null, opts, actor);
}

type AwFile = { $id: string; chunksTotal: number; chunksUploaded: number };
const fileState = (fileId: string) =>
  aw<AwFile>(`/storage/buckets/${AW.bucket}/files/${encodeURIComponent(fileId)}`).catch((e: AppwriteError) => (e.status === 404 ? null : Promise.reject(e)));
const done = (f: AwFile | null) => !!f && f.chunksTotal > 0 && f.chunksUploaded >= f.chunksTotal;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upload size bytes as Appwrite's 5 MB Content-Range chunks, in order, the next chunk read while this one goes up.
 *  Survives Appwrite's edge giving up on a slow answer (a "503 first byte timeout", mostly on the last chunk while
 *  Appwrite assembles a big video, which often finishes anyway): after any failure it asks Appwrite how far the file
 *  got, carries on from there, and only resends what's missing. A file that's already whole is left as it is. */
async function sendChunks(fileId: string, name: string, mime: string, size: number, read: (start: number, end: number) => Promise<ArrayBuffer>) {
  if (done(await fileState(fileId))) return;
  const total = Math.max(1, Math.ceil(size / CHUNK));
  let next: Promise<ArrayBuffer> | null = read(0, Math.min(size, CHUNK));
  for (let i = 0; i < total; i++) {
    const start = i * CHUNK, end = Math.min(size, start + CHUNK);
    const bytes = await next!;
    next = end < size ? read(end, Math.min(size, end + CHUNK)) : null;
    next?.catch(() => null); // a failed read surfaces when awaited, not as an unhandled rejection
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.set("fileId", fileId);
      form.set("file", new Blob([bytes], { type: mime }), name);
      const headers: Record<string, string> = { "X-Appwrite-Project": AW.project, "X-Appwrite-Key": process.env.APPWRITE_API_KEY ?? "" };
      if (size > CHUNK) headers["Content-Range"] = `bytes ${start}-${end - 1}/${size}`;
      if (start || attempt) headers["X-Appwrite-ID"] = fileId; // a retried first chunk continues the same file
      let why = "";
      let status = 0;
      try {
        const up = await fetch(`${AW.endpoint}/storage/buckets/${AW.bucket}/files`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(150_000) });
        if (up.ok) break;
        status = up.status;
        why = (await up.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      } catch (e) {
        why = (e as Error).message;
      }
      // how far did it get? The last chunk can still be being assembled: give it a while before sending it again
      for (let look = 0; look < (i === total - 1 ? 20 : 2); look++) {
        const f = await fileState(fileId).catch(() => null);
        if (done(f)) return;
        if (f && f.chunksUploaded > i) break;
        if (status && status < 500 && status !== 408 && status !== 409 && status !== 429) break; // a real refusal: looking won't help
        await sleep(3000);
      }
      const f = await fileState(fileId).catch(() => null);
      if (done(f)) return;
      if (f && f.chunksUploaded > i) break; // this chunk did land
      if ((status && status < 500 && status !== 408 && status !== 409 && status !== 429) || attempt >= 4)
        throw new AppwriteError(`upload failed${status ? ` (${status})` : ""}: ${why || "no answer"}`, status || 502);
      await sleep(2000 * 2 ** attempt);
    }
  }
}

async function mediaRow(fileId: string, name: string, mime: string, size: number, r2Key: string | null, opts: { postId?: string | null; backup: boolean }, actor: { id?: string; name: string }) {
  const { kindOf } = await import("./workspace");
  const row = await insert<Media>("media", {
    file_id: fileId, name, mime, size, kind: kindOf(mime, name), post_id: opts.postId ?? null, uploaded_by: actor.id ?? null, uploaded_name: actor.name, ...(r2Key ? { r2_key: r2Key } : {}),
    ...(fileId.startsWith("r2_") && r2Key ? { token: fileSig(r2Key) } : {}),
  });
  await logActivity({ post_id: opts.postId ?? null, verb: "uploaded", text: name }, actor);
  return finalizeMedia(row.$id, { backup: opts.backup });
}

/** A file already in R2 (the upload endpoint, lib/inbox.ts) into the workspace's media bucket, 5 MB at a time, so a
 *  big video never sits whole in the function's memory. The R2 copy stays as the file's backup. */
export async function addMediaFromR2(key: string, size: number, mime: string, name: string, fileId: string, opts: { postId?: string | null }, actor: { id?: string; name: string }) {
  // a second save of the same file (a retry after a timeout) finds it: the row it already has, or the file without one
  const id = FILES_ON_R2 ? `r2_${fileId}`.slice(0, 36) : fileId;
  const had = await listOf<Media>("media", { method: "equal", attribute: "file_id", values: [id] }, { method: "limit", values: [1] }).catch(() => null);
  if (had?.[0]) return finalizeMedia(had[0].$id, { backup: false });
  if (FILES_ON_R2) {
    // kept where it is in R2 (a download's slot moves to its Files key first): no copy into Appwrite
    const at = await adopt(key, fileId, name);
    return mediaRow(id, name, mime, size, at, { ...opts, backup: false }, actor);
  }
  const src = await presign(key, "GET", 3600);
  const read = async (start: number, end: number) => {
    for (let attempt = 0; ; attempt++) {
      const part = await fetch(src, { headers: size ? { Range: `bytes=${start}-${end - 1}` } : {}, cache: "no-store" }).catch((e: Error) => e);
      if (!(part instanceof Error) && part.ok) return part.arrayBuffer();
      if (attempt >= 3) throw new Error(`could not read the upload: ${part instanceof Error ? part.message : part.status}`);
      await sleep(1000 * 2 ** attempt);
    }
  };
  await sendChunks(fileId, name, mime, size, read);
  return mediaRow(fileId, name, mime, size, key, { ...opts, backup: false }, actor);
}
