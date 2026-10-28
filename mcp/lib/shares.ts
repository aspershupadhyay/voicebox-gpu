// Share links: a private, expiring link to one carousel or one folder for someone without an account (a client, an
// editor). The link is /s/<token>: 32 random bytes, shown once when it's made and never stored (R2 keeps only its
// SHA-256, like the upload keys). Opening it shows only what that one share names, read-only: the carousel's photos in
// order, or the folder's files (and its subfolders'), live. Uploads are served by Appwrite tokens made for this share
// that stop working when it expires (and are deleted when it's revoked); generated files by R2 links good for an hour.
// Nothing else is reachable from it: no other files, no names of folders around it, no way to change anything.
// Kept in R2: workspace/shares.json.
import { createHash, randomBytes } from "node:crypto";
import { createFileToken, deleteFileToken, getMedia } from "./appwrite";
import { CAROUSEL_RE, POST_GROUP_RE } from "./carouselrules";
import { catalog, carouselDetail } from "./filemanager";
import { FilesError } from "./files";
import { FOLDER_RE, subtree } from "./filetree";
import { listSummaries, signer } from "./library";
import { getJsonTagged, putJson, putJsonIf } from "./store";
import { AW } from "./workspace";

export type Share = {
  id: string; hash: string; kind: "carousel" | "folder"; ref: string; name: string; created: number; by: string;
  expires: number; revoked: number | null; downloads: boolean; views: number; last_view: number | null;
  /** Appwrite view tokens made for this share, per media row id */
  tokens: Record<string, { id: string; secret: string }>;
};
type Doc = { shares: Share[] };
const KEY = "workspace/shares.json";
const MAX_FILES = 300;
export const DAYS = [1, 3, 7, 30] as const;
const hashOf = (token: string) => createHash("sha256").update(`voicebox-share-v1:${token}`).digest("hex");
export const TOKEN_RE = /^[A-Za-z0-9_-]{40,48}$/;

async function change<T>(fn: (d: Doc) => T): Promise<T> {
  for (let i = 0; i < 6; i++) {
    const { value, etag } = await getJsonTagged<Doc>(KEY);
    const d = structuredClone(value ?? { shares: [] });
    const out = fn(d);
    if (await putJsonIf(KEY, d, etag).catch(() => false)) return out;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120 * (i + 1)));
  }
  const d = structuredClone((await getJsonTagged<Doc>(KEY)).value ?? { shares: [] });
  const out = fn(d);
  await putJson(KEY, d);
  return out;
}
const all = async () => (await getJsonTagged<Doc>(KEY)).value?.shares ?? [];
/** What the dashboard and the MCP tools see: never the token, never the file tokens. */
const outOf = (s: Share) => ({ id: s.id, kind: s.kind, ref: s.ref, name: s.name, created: s.created, by: s.by, expires: s.expires, downloads: s.downloads, views: s.views,
  last_view: s.last_view, state: s.revoked ? "revoked" : s.expires < Date.now() ? "expired" : "active" });

/** Make a link. Returns the address once: it can't be shown again (only revoked). */
export async function createShare(input: { kind?: unknown; ref?: unknown; days?: unknown; downloads?: unknown }, by: string, origin: string) {
  const kind = input.kind === "folder" ? "folder" : input.kind === "carousel" ? "carousel" : null;
  const ref = String(input.ref ?? "");
  if (!kind) throw new FilesError("kind: carousel or folder");
  const days = Number(input.days ?? 7);
  if (!(DAYS as readonly number[]).includes(days)) throw new FilesError(`days: ${DAYS.join(", ")}`);
  let name = "";
  if (kind === "carousel") {
    if (!CAROUSEL_RE.test(ref) && !POST_GROUP_RE.test(ref)) throw new FilesError("bad carousel id");
    name = (await carouselDetail(ref)).name;
  } else {
    if (!FOLDER_RE.test(ref)) throw new FilesError("bad folder id");
    const { tree } = await catalog();
    const f = tree.folders.find((x) => x.id === ref);
    if (!f || tree.trash[`f:${ref}`]) throw new FilesError("that folder doesn't exist", 404);
    name = f.name;
  }
  const token = randomBytes(32).toString("base64url");
  const hash = hashOf(token);
  const s: Share = { id: hash.slice(0, 12), hash, kind, ref, name, created: Date.now(), by, expires: Date.now() + days * 86_400_000, revoked: null,
    downloads: input.downloads !== false, views: 0, last_view: null, tokens: {} };
  await change((d) => {
    d.shares = d.shares.filter((x) => !x.revoked && x.expires > Date.now() - 30 * 86_400_000).slice(-499); // old ones fall away
    d.shares.push(s);
  });
  return { ...outOf(s), url: `${origin}/s/${token}` };
}

export async function listShares(filter: { kind?: string; ref?: string } = {}) {
  return (await all()).filter((s) => (!filter.kind || s.kind === filter.kind) && (!filter.ref || s.ref === filter.ref)).sort((a, b) => b.created - a.created).map(outOf);
}

/** Revoke: the link stops at once, and its Appwrite file tokens are deleted. */
export async function revokeShare(id: string) {
  const s = await change((d) => { const x = d.shares.find((y) => y.id === id); if (x && !x.revoked) x.revoked = Date.now(); return x ? structuredClone(x) : null; });
  if (!s) throw new FilesError("no such link", 404);
  await Promise.all(Object.values(s.tokens).map((t) => deleteFileToken(t.id)));
  return outOf(s);
}

export type SharedFile = { id: string; name: string; kind: string; thumb: string | null; view: string | null; download: string | null; poster?: string | null; mb: number | null };

/** The page behind a link: null when it doesn't exist, ran out or was revoked. Counts the visit. */
export async function openShare(token: string): Promise<{ share: ReturnType<typeof outOf>; files: SharedFile[] } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const hash = hashOf(token);
  const s = (await all()).find((x) => x.hash === hash);
  if (!s || s.revoked || s.expires < Date.now()) return null;
  // what it names, now: the carousel's files in order, or everything in the folder and its subfolders
  const { items, tree } = await catalog();
  let keys: string[];
  if (s.kind === "carousel") keys = (await carouselDetail(s.ref).catch(() => null))?.items.map((i) => i.id) ?? [];
  else {
    if (tree.trash[`f:${s.ref}`] || !tree.folders.some((f) => f.id === s.ref)) return null;
    const sub = subtree(tree, s.ref);
    keys = items.filter((i) => !i.trashed && i.folder && sub.has(i.folder)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((i) => i.id);
  }
  keys = keys.slice(0, MAX_FILES);
  const byId = new Map(items.map((i) => [i.id, i]));
  // a view token per upload, made once and good until the link runs out
  const need = keys.filter((k) => k.startsWith("m:") && !s.tokens[k.slice(2)]);
  const made: Record<string, { id: string; secret: string }> = {};
  const expire = new Date(s.expires).toISOString();
  for (let i = 0; i < need.length; i += 8) {
    await Promise.all(need.slice(i, i + 8).map(async (k) => {
      const m = await getMedia(k.slice(2)).catch(() => null);
      if (!m) return;
      const t = await createFileToken(m.file_id, expire).catch(() => null);
      if (t) made[m.$id] = { id: t.$id, secret: t.secret };
    }));
  }
  await change((d) => {
    const x = d.shares.find((y) => y.id === s.id);
    if (!x) return;
    Object.assign(x.tokens, made);
    x.views += 1; x.last_view = Date.now();
  }).catch(() => null);
  const tokens = { ...s.tokens, ...made };
  const sign = await signer(3600);
  const sums = keys.some((k) => k.startsWith("g:")) ? new Map((await listSummaries()).map((j) => [`g:${j.id}`, j])) : new Map();
  const files: SharedFile[] = [];
  for (const k of keys) {
    const it = byId.get(k);
    if (!it) continue;
    if (k.startsWith("m:")) {
      const m = await getMedia(k.slice(2)).catch(() => null);
      const t = m && tokens[m.$id];
      if (!m || !t) continue;
      const u = (mode: string, w?: number) => {
        const x = new URL(`${AW.endpoint}/storage/buckets/${AW.bucket}/files/${m.file_id}/${mode}`);
        x.searchParams.set("project", AW.project); x.searchParams.set("token", t.secret);
        if (w) { x.searchParams.set("width", String(w)); x.searchParams.set("quality", "82"); x.searchParams.set("output", "webp"); }
        return x.toString();
      };
      const img = m.kind === "image" && !/gif|svg|heic/i.test(`${m.mime} ${m.name}`);
      files.push({ id: k, name: m.name, kind: m.kind, thumb: img ? u("preview", 480) : null, view: img ? u("preview", 1920) : u("view"), download: s.downloads ? u("download") : null, mb: it.mb });
    } else {
      const j = sums.get(k);
      if (!j) continue;
      const kind = it.kind;
      if (kind === "image" && j.image) files.push({ id: k, name: it.name, kind, thumb: await sign(j.id, j.image.thumb), view: await sign(j.id, j.image.file ?? j.image.thumb), download: s.downloads ? await sign(j.id, j.image.file ?? j.image.thumb) : null, mb: it.mb });
      else if (kind === "video" && j.video) files.push({ id: k, name: it.name, kind, thumb: j.video.poster ? await sign(j.id, "poster.jpg") : null, poster: j.video.poster ? await sign(j.id, "poster.jpg") : null, view: await sign(j.id, "video.mp4"), download: s.downloads ? await sign(j.id, "video.mp4") : null, mb: it.mb });
      else if (kind === "audio" && j.first) files.push({ id: k, name: it.name, kind, thumb: null, view: await sign(j.id, `${j.first}.wav`), download: s.downloads ? await sign(j.id, `${j.first}.wav`) : null, mb: it.mb });
    }
  }
  return { share: outOf(s), files };
}
