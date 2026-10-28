// Server side of the shared workspace: plain REST calls to Appwrite Cloud with the project's API key (APPWRITE_API_KEY),
// or with a user's JWT when we only need to know who they are. The browser talks to Appwrite directly for live sync.
import { AW, POST_FIELDS, type Comment, type Media, type Member, type Post } from "./workspace";
import { presign, putObj } from "./store";

export class AppwriteError extends Error {
  constructor(message: string, public status: number, public type = "") { super(message); }
}

export const hasKey = () => !!process.env.APPWRITE_API_KEY;

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

// ── people

export type AwUser = { $id: string; name: string; email: string };

/** Who a browser JWT belongs to (throws when it is expired or forged). */
export const userFromJwt = (jwt: string) => aw<AwUser>("/account", { jwt });

/** Create a person's account with the server key. The caller has already checked they're on the list (lib/access.ts),
 *  so an uninvited email never gets an account. Throws AppwriteError 409 when the email already has one. */
export const createUser = (email: string, password: string, name: string) =>
  aw<AwUser>("/users", { method: "POST", body: { userId: "unique()", email, password, name } });

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
  const r = await aw<{ memberships: { $id: string; userEmail: string }[] }>(`/teams/${AW.team}/memberships?${q({ method: "limit", values: [100] })}`);
  const m = r.memberships.find((x) => x.userEmail.toLowerCase() === email.toLowerCase());
  if (m) await aw(`/teams/${AW.team}/memberships/${m.$id}`, { method: "DELETE" });
  return !!m;
}

export async function listMembers(): Promise<Member[]> {
  const r = await aw<{ memberships: { userId: string; userName: string; userEmail: string }[] }>(`/teams/${AW.team}/memberships?${q({ method: "limit", values: [25] })}`);
  return r.memberships.map((m) => ({ id: m.userId, name: m.userName || m.userEmail.split("@")[0], email: m.userEmail }));
}

// ── posts (used by the MCP tools; the dashboard writes straight from the browser)

const PERMS: string[] = []; // table-level team permissions cover every row

export async function listPosts(opts: { status?: string; limit?: number } = {}) {
  const qs = [{ method: "orderDesc", attribute: "$updatedAt" }, { method: "limit", values: [Math.min(opts.limit ?? 50, 200)] }];
  if (opts.status) qs.push({ method: "equal", attribute: "status", values: [opts.status] } as never);
  return (await aw<{ rows: Post[] }>(`${rows("posts")}?${q(...qs)}`)).rows;
}

export const getPost = (id: string) => aw<Post>(`${rows("posts")}/${encodeURIComponent(id)}`);

function pickPost(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of POST_FIELDS) if (data[k] !== undefined) out[k] = data[k];
  return out;
}

export async function createPost(data: Partial<Post>, actor: { id?: string; name: string }) {
  const row = await aw<Post>(rows("posts"), {
    method: "POST",
    body: { rowId: "unique()", data: { status: "idea", platforms: [], jobs: [], ...pickPost(data), owner_id: actor.id ?? null, owner_name: actor.name }, permissions: PERMS },
  });
  await logActivity({ post_id: row.$id, verb: "created", text: row.title }, actor);
  return row;
}

export async function updatePost(id: string, data: Partial<Post>, actor: { id?: string; name: string }) {
  const before = await getPost(id);
  const row = await aw<Post>(`${rows("posts")}/${encodeURIComponent(id)}`, { method: "PATCH", body: { data: pickPost(data) } });
  if (data.status && data.status !== before.status) await logActivity({ post_id: id, verb: "moved", text: `${before.status} → ${data.status}` }, actor);
  else await logActivity({ post_id: id, verb: "edited", text: Object.keys(pickPost(data)).join(", ") }, actor);
  return row;
}

export async function listComments(postId: string) {
  return (await aw<{ rows: Comment[] }>(`${rows("comments")}?${q({ method: "equal", attribute: "post_id", values: [postId] }, { method: "orderAsc", attribute: "$createdAt" }, { method: "limit", values: [200] })}`)).rows;
}

export async function addComment(postId: string, body: string, actor: { id?: string; name: string }) {
  const row = await aw<Comment>(rows("comments"), { method: "POST", body: { rowId: "unique()", data: { post_id: postId, body, author_id: actor.id ?? null, author_name: actor.name } } });
  await logActivity({ post_id: postId, verb: "commented", text: body.slice(0, 200) }, actor);
  return row;
}

export async function logActivity(a: { post_id?: string | null; verb: string; text?: string }, actor: { id?: string; name: string }) {
  await aw(rows("activity"), {
    method: "POST",
    body: { rowId: "unique()", data: { post_id: a.post_id ?? null, verb: a.verb, text: (a.text ?? "").slice(0, 500), actor_id: actor.id ?? null, actor_name: actor.name } },
  }).catch(() => {}); // the feed is nice-to-have; never fail the real write over it
}

// ── media

export async function getMedia(id: string) {
  return aw<Media>(`${rows("media")}/${encodeURIComponent(id)}`);
}

export async function listMedia(postId?: string, limit = 100) {
  const qs: object[] = [{ method: "orderDesc", attribute: "$createdAt" }, { method: "limit", values: [Math.min(limit, 1000)] }];
  if (postId) qs.push({ method: "equal", attribute: "post_id", values: [postId] });
  return (await aw<{ rows: Media[] }>(`${rows("media")}?${q(...qs)}`)).rows;
}

/** Give an uploaded file a token so it plays in <img>/<video> anywhere, and (optionally) back it up to R2. */
export async function finalizeMedia(mediaId: string, opts: { backup: boolean }) {
  const m = await getMedia(mediaId);
  const patch: Partial<Media> = {};
  if (!m.token) {
    const t = await aw<{ secret: string }>(`/tokens/buckets/${AW.bucket}/files/${m.file_id}`, { method: "POST", body: {} });
    patch.token = t.secret;
  }
  let backup: string | undefined;
  if (opts.backup && !m.r2_key) {
    if ((m.size ?? 0) > BACKUP_MAX) backup = `skipped: larger than ${BACKUP_MAX / 1e6} MB (back it up from the Media page later)`;
    else {
      try {
        patch.r2_key = await backupToR2(m);
      } catch (e) {
        backup = `R2 backup failed: ${(e as Error).message}`;
      }
    }
  }
  const row = Object.keys(patch).length ? await aw<Media>(`${rows("media")}/${mediaId}`, { method: "PATCH", body: { data: patch } }) : m;
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
  return (await aw<{ rows: { $createdAt: string; post_id: string | null; verb: string; text: string | null; actor_name: string | null }[] }>(`${rows("activity")}?${q(...qs)}`)).rows;
}

export async function postsBetween(from: string, to: string) {
  return (await aw<{ rows: Post[] }>(`${rows("posts")}?${q(
    { method: "greaterThanEqual", attribute: "due_at", values: [from] }, { method: "lessThan", attribute: "due_at", values: [to] },
    { method: "orderAsc", attribute: "due_at" }, { method: "limit", values: [200] })}`)).rows;
}

/** Delete a workspace file: the stored file and its row (the R2 backup copy, if any, stays). */
export async function deleteMediaRow(id: string, actor: { id?: string; name: string }) {
  const m = await getMedia(id);
  await aw(`/storage/buckets/${AW.bucket}/files/${encodeURIComponent(m.file_id)}`, { method: "DELETE" }).catch(() => {});
  await aw(`${rows("media")}/${encodeURIComponent(id)}`, { method: "DELETE" });
  await logActivity({ post_id: m.post_id, verb: "deleted", text: m.name }, actor);
  return m;
}

/** Rename a workspace file (the row's name; the stored file keeps its id). */
export async function renameMedia(id: string, name: string, actor: { id?: string; name: string }) {
  const before = await getMedia(id);
  const row = await aw<Media>(`${rows("media")}/${encodeURIComponent(id)}`, { method: "PATCH", body: { data: { name: name.slice(0, 255) } } });
  await logActivity({ post_id: before.post_id, verb: "renamed", text: `${before.name} → ${row.name}` }, actor);
  return row;
}

export async function deletePost(id: string, actor: { id?: string; name: string }) {
  const p = await getPost(id);
  await aw(`${rows("posts")}/${encodeURIComponent(id)}`, { method: "DELETE" });
  await logActivity({ verb: "deleted", text: p.title }, actor);
}

/** Attach a finished voiceover (library job id) to a post. */
export async function linkJob(postId: string, jobId: string, actor: { id?: string; name: string }) {
  const p = await getPost(postId);
  if ((p.jobs ?? []).includes(jobId)) return p;
  const row = await aw<Post>(`${rows("posts")}/${encodeURIComponent(postId)}`, { method: "PATCH", body: { data: { jobs: [...(p.jobs ?? []), jobId] } } });
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
  for (let start = 0; start < Math.max(bytes.length, 1); start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    const form = new FormData();
    form.set("fileId", fileId);
    form.set("file", new Blob([bytes.slice(start, end)], { type: mime }), name);
    const headers: Record<string, string> = { "X-Appwrite-Project": AW.project, "X-Appwrite-Key": process.env.APPWRITE_API_KEY ?? "" };
    if (bytes.length > CHUNK) { headers["Content-Range"] = `bytes ${start}-${end - 1}/${bytes.length}`; if (start) headers["X-Appwrite-ID"] = fileId; }
    const up = await fetch(`${AW.endpoint}/storage/buckets/${AW.bucket}/files`, { method: "POST", headers, body: form });
    if (!up.ok) throw new AppwriteError(`upload failed: ${(await up.text()).slice(0, 200)}`, up.status);
  }
  return mediaRow(fileId, name, mime, bytes.length, null, opts, actor);
}

async function mediaRow(fileId: string, name: string, mime: string, size: number, r2Key: string | null, opts: { postId?: string | null; backup: boolean }, actor: { id?: string; name: string }) {
  const { kindOf } = await import("./workspace");
  const row = await aw<Media>(rows("media"), { method: "POST", body: { rowId: "unique()", data: {
    file_id: fileId, name, mime, size, kind: kindOf(mime, name), post_id: opts.postId ?? null, uploaded_by: actor.id ?? null, uploaded_name: actor.name, ...(r2Key ? { r2_key: r2Key } : {}),
  } } });
  await logActivity({ post_id: opts.postId ?? null, verb: "uploaded", text: name }, actor);
  return finalizeMedia(row.$id, { backup: opts.backup });
}

/** A file already in R2 (the upload endpoint, lib/inbox.ts) into the workspace's media bucket, 5 MB at a time, so a
 *  big video never sits whole in the function's memory. The R2 copy stays as the file's backup. */
export async function addMediaFromR2(key: string, size: number, mime: string, name: string, fileId: string, opts: { postId?: string | null }, actor: { id?: string; name: string }) {
  const src = await presign(key, "GET", 3600);
  for (let start = 0; start < Math.max(size, 1); start += CHUNK) {
    const end = Math.min(size, start + CHUNK);
    const part = await fetch(src, { headers: size ? { Range: `bytes=${start}-${end - 1}` } : {}, cache: "no-store" });
    if (!part.ok) throw new Error(`could not read the upload: ${part.status}`);
    const form = new FormData();
    form.set("fileId", fileId);
    form.set("file", new Blob([await part.arrayBuffer()], { type: mime }), name);
    const headers: Record<string, string> = { "X-Appwrite-Project": AW.project, "X-Appwrite-Key": process.env.APPWRITE_API_KEY ?? "" };
    if (size > CHUNK) { headers["Content-Range"] = `bytes ${start}-${end - 1}/${size}`; if (start) headers["X-Appwrite-ID"] = fileId; }
    const up = await fetch(`${AW.endpoint}/storage/buckets/${AW.bucket}/files`, { method: "POST", headers, body: form });
    if (!up.ok) throw new AppwriteError(`upload failed: ${(await up.text()).slice(0, 200)}`, up.status);
  }
  return mediaRow(fileId, name, mime, size, key, { ...opts, backup: false }, actor);
}
