// Everything the Files page can do to a file, on the server, for the dashboard routes and the MCP tools alike: one
// catalog of uploads (Appwrite) and generated items (R2 library) with their folders and stars, rename, delete and
// import from a link. Folders themselves live in lib/files.ts.
import { addMediaFromUrl, deleteMediaRow, hasKey, listMedia, renameMedia } from "./appwrite";
import { FilesError, findFolder, forgetItems, getTree, moveItems, pathOf, type FileTree } from "./files";
import { deleteLibJob, getLibJob, listLibrary, renameLibJob, signer, withUrls, type LibJob } from "./library";
import { fileUrl, libKind, libName, libType, type Media } from "./workspace";

type Actor = { id?: string; name: string };

export type FileItem = {
  id: string; source: "upload" | "generated"; name: string; kind: "image" | "video" | "audio" | "doc" | "other"; type: string;
  mb: number | null; created: string; by: string | null; folder: string | null; folder_path: string; starred: boolean;
  post_id?: string | null; url?: string | null; dashboard: string;
};

const fromMedia = (m: Media, t: FileTree): FileItem => {
  const key = `m:${m.$id}`;
  const folder = t.place[key] ?? null;
  return { id: key, source: "upload", name: m.name, kind: m.kind, type: m.kind[0].toUpperCase() + m.kind.slice(1), mb: m.size ? +(m.size / 1e6).toFixed(2) : null,
    created: m.$createdAt, by: m.uploaded_name, folder, folder_path: pathOf(t, folder), starred: t.starred.includes(key), post_id: m.post_id,
    url: m.token ? fileUrl(m) : null, dashboard: `/files?file=${encodeURIComponent(key)}` };
};
const fromJob = (j: LibJob, t: FileTree): FileItem => {
  const key = `g:${j.id}`;
  const folder = t.place[key] ?? null;
  return { id: key, source: "generated", name: libName(j), kind: libKind(j), type: libType(j), mb: j.video?.size ? +(j.video.size / 1e6).toFixed(2) : null,
    created: new Date(j.created).toISOString(), by: null, folder, folder_path: pathOf(t, folder), starred: t.starred.includes(key), dashboard: `/files#${j.id}` };
};

/** Every file with its folder and star. Uploads are skipped (with a note) when the workspace isn't connected. */
export async function catalog() {
  const [tree, media, jobs] = await Promise.all([
    getTree(),
    hasKey() ? listMedia(undefined, 1000).catch((e: Error) => e) : Promise.resolve(new Error("the shared workspace isn't connected (APPWRITE_API_KEY)")),
    listLibrary(),
  ]);
  const items = [...(media instanceof Error ? [] : media.map((m) => fromMedia(m, tree))), ...jobs.map((j) => fromJob(j, tree))]
    .sort((a, b) => b.created.localeCompare(a.created));
  return { tree, items, note: media instanceof Error ? `uploads not listed: ${media.message}` : undefined };
}

/** One file with links that work for the next 6 hours (a generated item's every file; an upload's view/download link). */
export async function fileDetail(key: string) {
  const { tree, items } = await catalog();
  const item = items.find((i) => i.id === key);
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
  return { ...item, folder_path: pathOf(tree, item.folder), lines: j.results.map((r) => ({ id: r.id, text: r.text, seconds: r.duration })), links, zip: `/api/zip/${j.id}` };
}

export async function renameItem(key: string, name: string, actor: Actor) {
  const n = name.replace(/[\u0000-\u001f]+/g, " ").trim();
  if (!n) throw new FilesError("a file needs a name");
  if (key.startsWith("m:")) return { id: key, name: (await renameMedia(key.slice(2), n, actor)).name };
  if (key.startsWith("g:")) return { id: key, name: (await renameLibJob(key.slice(2), n)).label };
  throw new FilesError(`not a file: ${key}`);
}

/** Delete files for good: an upload's stored file and row (its R2 backup stays), a generated item's whole folder in R2. */
export async function deleteItems(keys: string[], actor: Actor) {
  const out = await Promise.allSettled(keys.map((k) => {
    if (k.startsWith("m:")) return deleteMediaRow(k.slice(2), actor);
    if (k.startsWith("g:")) return deleteLibJob(k.slice(2));
    return Promise.reject(new FilesError(`not a file: ${k}`));
  }));
  const deleted = keys.filter((_, i) => out[i].status === "fulfilled");
  const failed = keys.flatMap((k, i) => (out[i].status === "rejected" ? [{ id: k, error: ((out[i] as PromiseRejectedResult).reason as Error).message }] : []));
  if (deleted.length) await forgetItems(deleted);
  return { deleted, failed };
}

/** Copy a file from a link into the shared uploads, filed in a folder. */
export async function importUrl(url: string, opts: { name?: string; folder?: string | null; postId?: string | null; backup: boolean }, actor: Actor) {
  if (!/^https?:\/\//i.test(url)) throw new FilesError("only http(s) links can be imported");
  const folder = opts.folder ? findFolder(await getTree(), opts.folder) : null;
  const { media, backup } = await addMediaFromUrl(url, { name: opts.name, postId: opts.postId, backup: opts.backup }, actor);
  if (folder) await moveItems([`m:${media.$id}`], folder.id);
  return { media, backup, folder: folder?.id ?? null };
}
