// Everything the Files page can do to a file, on the server, for the dashboard routes and the MCP tools alike: one
// catalog of uploads (Appwrite) and generated items (R2 library) with their folders, stars and the trash; rename,
// trash / restore / delete for good, import from a link, poster frames for uploaded videos and the sidebar's
// favourites. The folder tree itself is lib/files.ts (rules in lib/filetree.ts).
import { addMediaFromUrl, deleteMediaRow, getMedia, hasKey, listMedia, listPosts, renameMedia } from "./appwrite";
import { groupsOf, POST_GROUP_RE, type Group } from "./carouselrules";
import { createCarousel, forgetInCarousels, getCarousels, updateCarousel } from "./carousels";
import { expired, FilesError, findFolder, forget, forgetPlan, getTree, markPoster, moveItems, pathOf, restoreItems, trashItems, type FileTree } from "./files";
import { folderFor, isTrashed } from "./filetree";
import { deleteLibJob, getLibJob, listSummaries, renameLibJob, signer, withUrls, type LibSummary } from "./library";
import { presign, putObj } from "./store";
import { fileUrl, libKind, libName, libType, type Media } from "./workspace";

type Actor = { id?: string; name: string };

export type FileItem = {
  id: string; source: "upload" | "generated"; name: string; kind: "image" | "video" | "audio" | "doc" | "other"; type: string;
  mb: number | null; created: string; by: string | null; folder: string | null; folder_path: string; starred: boolean;
  trashed?: string; post_id?: string | null; url?: string | null; dashboard: string; carousel?: string;
};

const sumKind = (j: LibSummary) => libKind(j);
const fromMedia = (m: Media, t: FileTree): FileItem => {
  const key = `m:${m.$id}`;
  const folder = folderFor(t, key, m.kind);
  return { id: key, source: "upload", name: m.name, kind: m.kind, type: m.kind === "doc" ? "Doc" : m.kind[0].toUpperCase() + m.kind.slice(1),
    mb: m.size ? +(m.size / 1e6).toFixed(2) : null, created: m.$createdAt, by: m.uploaded_name, folder, folder_path: pathOf(t, folder) || "All files",
    starred: t.starred.includes(key), trashed: t.trash[key] ? new Date(t.trash[key].at).toISOString() : undefined, post_id: m.post_id,
    url: m.token ? fileUrl(m) : null, dashboard: `/files?file=${encodeURIComponent(key)}` };
};
const fromJob = (j: LibSummary, t: FileTree): FileItem => {
  const key = `g:${j.id}`;
  const folder = folderFor(t, key, sumKind(j));
  return { id: key, source: "generated", name: libName({ ...j, results: [{ text: j.text }] }), kind: sumKind(j), type: libType(j),
    mb: j.video?.size ? +(j.video.size / 1e6).toFixed(2) : null, created: new Date(j.created).toISOString(), by: null, folder,
    folder_path: pathOf(t, folder) || "All files", starred: t.starred.includes(key), trashed: t.trash[key] ? new Date(t.trash[key].at).toISOString() : undefined,
    dashboard: `/files#${j.id}` };
};

/** Every file with its folder and star; `trash` lists what's in the trash instead. Uploads are skipped (with a note)
 *  when the workspace isn't connected. */
export async function catalog(opts: { trash?: boolean } = {}) {
  const [tree, media, jobs, made, posts] = await Promise.all([
    getTree(),
    hasKey() ? listMedia(undefined, 1000).catch((e: Error) => e) : Promise.resolve(new Error("the shared workspace isn't connected (APPWRITE_API_KEY)")),
    listSummaries(),
    getCarousels().catch(() => []),
    hasKey() ? listPosts({ limit: 200 }).catch(() => []) : Promise.resolve([]),
  ]);
  const all = [...(media instanceof Error ? [] : media.map((m) => fromMedia(m, tree))), ...jobs.map((j) => fromJob(j, tree))];
  const live = all.filter((i) => !isTrashed(tree, i.id));
  const titles = new Map(posts.map((p) => [p.$id, p.title]));
  const members = live.map((i) => ({ key: i.id, kind: i.kind, post: i.post_id ?? null, at: Date.parse(i.created) }));
  const groups = groupsOf(made, members, (id) => titles.get(id));
  const allGroups = groupsOf(made, members, (id) => titles.get(id), 1); // for the API: a made one with one file so far too
  const inGroup = new Map(groups.flatMap((g) => g.items.map((k) => [k, g.id] as const)));
  for (const i of live) { const g = inGroup.get(i.id); if (g) i.carousel = g; }
  const items = all.filter((i) => isTrashed(tree, i.id) === !!opts.trash).sort((a, b) => b.created.localeCompare(a.created));
  return { tree, items, groups, allGroups, note: media instanceof Error ? `uploads not listed: ${media.message}` : undefined };
}

// ── carousels: a post's photos and clips as one stack (rules in lib/carouselrules.ts, storage in lib/carousels.ts)

const groupOut = (g: Group, items: FileItem[]) => {
  const by = new Map(items.map((i) => [i.id, i]));
  return { id: g.id, name: g.name, made: g.made, post_id: g.post, files: g.items.length, created: new Date(g.created).toISOString(),
    dashboard: `/files?carousel=${encodeURIComponent(g.id)}`,
    items: g.items.map((k, n) => { const i = by.get(k); return { position: n + 1, id: k, name: i?.name, kind: i?.kind, url: i?.url ?? null }; }) };
};

/** Every carousel (or one post's), each with its files in order. */
export async function carouselList(opts: { post_id?: string } = {}) {
  const { items, allGroups } = await catalog();
  return allGroups.filter((g) => !opts.post_id || g.post === opts.post_id).map((g) => groupOut(g, items));
}

export async function carouselDetail(id: string) {
  const { items, allGroups } = await catalog();
  const g = allGroups.find((x) => x.id === id) ?? allGroups.find((x) => x.name.toLowerCase() === id.trim().toLowerCase());
  if (!g) throw new FilesError(`no carousel ${id} (the carousels tool lists them)`, 404);
  return groupOut(g, items);
}

/** Change a carousel. A post's own one (post-<id>) becomes a made one first, keeping its files, order and name. */
export async function changeCarousel(id: string, patch: { name?: unknown; items?: unknown; add?: unknown; remove?: unknown }, by: string | null) {
  if (!POST_GROUP_RE.test(id)) return updateCarousel(id, patch);
  const { groups } = await catalog();
  const g = groups.find((x) => x.id === id);
  if (!g) throw new FilesError(`no carousel ${id}`, 404);
  const c = await createCarousel({ name: g.name, items: g.items, post: g.post }, by);
  return updateCarousel(c.id, patch);
}

/** One file with links that work for the next 6 hours (a generated item's every file; an upload's view/download link). */
export async function fileDetail(key: string) {
  const { tree, items } = await catalog();
  const item = items.find((i) => i.id === key) ?? (await catalog({ trash: true })).items.find((i) => i.id === key);
  if (!item) throw new FilesError(`no file ${key} (list_files shows ids)`, 404);
  if (item.source === "upload") return { ...item, download: item.url ? item.url.replace(/\/view\?/, "/download?") : null };
  const j = await getLibJob(key.slice(2));
  if (!j) throw new FilesError("library item not found", 404);
  const w = await withUrls(j, await signer());
  const links: Record<string, string> = {};
  for (const r of w.results) if (r.audio) links[`${r.id}.wav`] = r.audio;
  const extra = w as unknown as { video_url?: string; poster_url?: string | null; images?: { file: string; url: string }[] };
  if (extra.video_url) links["video.mp4"] = extra.video_url;
  if (extra.poster_url) links["poster.jpg"] = extra.poster_url;
  for (const im of extra.images ?? []) links[im.file] = im.url;
  return { ...item, folder_path: pathOf(tree, item.folder) || "All files", lines: j.results.map((r) => ({ id: r.id, text: r.text, seconds: r.duration })), links, zip: `/api/zip/${j.id}` };
}

export async function renameItem(key: string, name: string, actor: Actor) {
  const n = name.replace(/[\u0000-\u001f]+/g, " ").trim();
  if (!n) throw new FilesError("a file needs a name");
  if (key.startsWith("m:")) return { id: key, name: (await renameMedia(key.slice(2), n, actor)).name };
  if (key.startsWith("g:")) return { id: key, name: (await renameLibJob(key.slice(2), n)).label };
  throw new FilesError(`not a file: ${key}`);
}

/** Delete: to the trash (30 days), or for good with `forever`. */
export async function deleteItems(keys: string[], actor: Actor, forever = false) {
  if (!forever) return { ...(await trashItems(keys, actor.name)), deleted: [], failed: [] };
  return deleteForever(keys, actor);
}

/** Delete for good: an upload's stored file and row (its R2 backup stays), a generated item's whole folder in R2; a
 *  folder goes with every folder and file inside it. */
export async function deleteForever(keys: string[], actor: Actor) {
  const plan = forgetPlan(await getTree(), keys);
  const files = plan.files;
  const out = await Promise.allSettled(files.map((k) => {
    if (k.startsWith("m:")) return deleteMediaRow(k.slice(2), actor);
    if (k.startsWith("g:")) return deleteLibJob(k.slice(2));
    return Promise.reject(new FilesError(`not a file: ${k}`));
  }));
  const deleted = files.filter((_, i) => out[i].status === "fulfilled");
  const failed = files.flatMap((k, i) => (out[i].status === "rejected" ? [{ id: k, error: ((out[i] as PromiseRejectedResult).reason as Error).message }] : []));
  const folders = failed.length ? [] : [...plan.folders]; // folders only go once everything in them did (they stay in the trash)
  await forget(deleted, folders);
  if (deleted.length) await forgetInCarousels(deleted).catch(() => null);
  return { trashed: 0, deleted, folders: folders.length, failed };
}

export async function restore(keys: string[]) {
  return restoreItems(keys);
}

/** Empty the trash: everything in it, for good. */
export async function emptyTrash(actor: Actor) {
  const t = await getTree();
  return deleteForever(Object.keys(t.trash), actor);
}

/** Things past their 30 days in the trash go for good (run now and then, after a request). */
export async function purgeTrash() {
  const t = await getTree();
  const old = expired(t);
  if (old.length) await deleteForever(old, { name: "Trash (30 days)" });
}

/** Copy a file from a link into the shared uploads, filed in a folder. */
export async function importUrl(url: string, opts: { name?: string; folder?: string | null; postId?: string | null; backup: boolean }, actor: Actor) {
  if (!/^https?:\/\//i.test(url)) throw new FilesError("only http(s) links can be imported");
  const folder = opts.folder ? findFolder(await getTree(), opts.folder) : null;
  const { media, backup } = await addMediaFromUrl(url, { name: opts.name, postId: opts.postId, backup: opts.backup }, actor);
  if (folder && !folder.system) await moveItems([`m:${media.$id}`], folder.id);
  return { media, backup, folder: folder?.id ?? null };
}

// ── poster frames for uploaded videos (the browser grabs a frame; a card never has to load the video itself)

const posterKey = (key: string) => `workspace/posters/${key.replace(":", "_")}.jpg`;
export const posterUrl = (key: string) => presign(posterKey(key), "GET", 6 * 3600, undefined, true);

export async function savePoster(key: string, jpegBase64: string) {
  if (!/^m:[A-Za-z0-9._-]{1,64}$/.test(key)) throw new FilesError("posters are for uploaded videos");
  const bytes = Buffer.from(jpegBase64.replace(/^data:[^,]*,/, ""), "base64");
  if (bytes.length < 200 || bytes.length > 1_500_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new FilesError("a JPEG frame, up to 1.5 MB");
  await putObj(posterKey(key), bytes, "image/jpeg");
  await markPoster(key);
  return { poster: await posterUrl(key) };
}

/** The tree for the browser, with a link to each video poster and the made carousels. */
export async function treeForBrowser() {
  const [t, carousels] = await Promise.all([getTree(), getCarousels().catch(() => [])]);
  const posters = Object.fromEntries(await Promise.all(Object.keys(t.posters).map(async (k) => [k, await posterUrl(k)] as const)));
  return { ...t, poster_urls: posters, carousels };
}

/** The sidebar's Favourites: starred things with a name, a thumbnail and a link. */
export async function favourites() {
  const t = await getTree();
  const keys = t.starred.filter((k) => !isTrashed(t, k) && !(k.startsWith("f:") && t.trash[k])).slice(0, 8);
  const sign = await signer();
  const sums = keys.some((k) => k.startsWith("g:")) ? new Map((await listSummaries()).map((j) => [`g:${j.id}`, j])) : new Map<string, LibSummary>();
  const out = await Promise.all(keys.map(async (k) => {
    if (k.startsWith("f:")) {
      const f = t.folders.find((x) => x.id === k.slice(2));
      return f ? { key: k, name: f.name, kind: "folder", color: f.color, thumb: null, href: `/files?folder=${f.id}` } : null;
    }
    if (k.startsWith("g:")) {
      const j = sums.get(k);
      if (!j) return null;
      const thumb = j.image ? await sign(j.id, j.image.thumb) : j.video?.poster ? await sign(j.id, "poster.jpg") : null;
      return { key: k, name: libName({ ...j, results: [{ text: j.text }] }), kind: libKind(j), color: null, thumb, href: `/files?file=g:${j.id}` };
    }
    if (!hasKey()) return null;
    const m = await getMedia(k.slice(2)).catch(() => null);
    if (!m) return null;
    const thumb = m.token && m.kind === "image" ? fileUrl(m, "preview", 96) : t.posters[k] ? await posterUrl(k) : null;
    return { key: k, name: m.name, kind: m.kind, color: null, thumb, href: `/files?file=${encodeURIComponent(k)}` };
  }));
  return out.filter(Boolean);
}
