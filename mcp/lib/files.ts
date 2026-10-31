// The Files page's folder tree in R2 (workspace/files.json): folders, where each file sits, stars, the trash and which
// uploaded videos have a poster frame. Files themselves stay where they are: uploads in R2 (`m:<media id>`),
// generated takes, subtitles, images and videos in the R2 library (`g:<library id>`); folders are `f:<folder id>`.
// Writes read the latest copy first and change one thing, so two people filing different things never overwrite each
// other. The rules (category folders, trash, where a file shows) are in lib/filetree.ts, shared with the browser.
import { getJson, putJson } from "./store";
import type { MediaKind } from "./workspace";
import {
  FOLDER_COLORS, FOLDER_RE, ITEM_RE, folderFor, normalize, pathOf, ROOT, subtree, TRASH_DAYS, within, newFolderId, type FileTree, type Folder, type FolderColor,
} from "./filetree";

export { FOLDER_COLORS, FOLDER_RE, ITEM_RE, pathOf, type FileTree, type Folder, type FolderColor };

const KEY = "workspace/files.json";
const MAX_FOLDERS = 500;
const FKEY = /^f:[a-z0-9]{6,16}$/;

export class FilesError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function load(): Promise<FileTree> {
  return normalize(await getJson<Partial<FileTree>>(KEY).catch(() => null));
}
const save = (t: FileTree) => putJson(KEY, t);

export const getTree = load;

const cleanName = (s: unknown) => {
  const n = String(s ?? "").replace(/[\u0000-\u001f/\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!n) throw new FilesError("a folder needs a name");
  return n;
};
const cleanColor = (c: unknown, i = 0): FolderColor => (FOLDER_COLORS.includes(c as FolderColor) ? (c as FolderColor) : FOLDER_COLORS[i % FOLDER_COLORS.length]);

function folderOf(t: FileTree, id: string | null | undefined) {
  if (id == null) return null;
  const f = t.folders.find((x) => x.id === id);
  if (!f) throw new FilesError("that folder doesn't exist", 404);
  if (t.trash[`f:${f.id}`]) throw new FilesError(`"${f.name}" is in the trash: restore it first`, 409);
  return f;
}

/** A name not already used by a sibling: "Thumbnails", "Thumbnails 2", ... */
function unique(t: FileTree, parent: string | null, name: string, except?: string) {
  const taken = new Set(t.folders.filter((f) => f.parent === parent && f.id !== except && !t.trash[`f:${f.id}`]).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

/** Make a folder. The browser picks the id itself (so the folder shows the moment you click), else one is made here. */
export async function createFolder(input: { id?: unknown; name?: unknown; parent?: unknown; color?: unknown }, by: string | null) {
  const t = await load();
  if (t.folders.length >= MAX_FOLDERS) throw new FilesError(`up to ${MAX_FOLDERS} folders`);
  const id = input.id == null ? newFolderId() : String(input.id);
  if (!FOLDER_RE.test(id) || id.startsWith("sys")) throw new FilesError("bad folder id");
  const exists = t.folders.find((f) => f.id === id);
  if (exists) return exists; // a retried request
  const parent = input.parent ? String(input.parent) : null;
  folderOf(t, parent);
  const f: Folder = {
    id, name: unique(t, parent, cleanName(input.name ?? "Untitled folder")),
    color: cleanColor(input.color, t.folders.length), parent, created: Date.now(), by,
  };
  t.folders.push(f);
  await save(t);
  return f;
}

/** Rename, recolour or move a folder (into another folder, or to the top with parent null). Category folders can be
 *  renamed and recoloured but stay at the top. */
export async function updateFolder(id: string, patch: { name?: unknown; color?: unknown; parent?: unknown }) {
  const t = await load();
  const f = folderOf(t, id)!;
  if (patch.parent !== undefined) {
    const parent = patch.parent ? String(patch.parent) : null;
    if (f.system && parent) throw new FilesError(`"${f.name}" sorts files by kind and stays at the top`);
    folderOf(t, parent);
    if (parent && within(t, parent, id)) throw new FilesError("a folder can't go inside itself");
    f.parent = parent;
  }
  if (patch.name !== undefined || patch.parent !== undefined) f.name = unique(t, f.parent, patch.name !== undefined ? cleanName(patch.name) : f.name, f.id);
  if (patch.color !== undefined) f.color = cleanColor(patch.color);
  await save(t);
  return f;
}

/** Move files (m:/g:) and folders (f:) into a folder, or to the top level with folder null. */
export async function moveItems(keys: string[], folder: string | null) {
  const t = await load();
  folderOf(t, folder);
  let files = 0, folders = 0;
  for (const k of keys) {
    if (FKEY.test(k)) {
      const f = folderOf(t, k.slice(2))!;
      if (f.system) { if (folder) throw new FilesError(`"${f.name}" sorts files by kind and stays at the top`); continue; }
      if (folder && within(t, folder, f.id)) throw new FilesError(`"${f.name}" can't go inside itself`);
      f.parent = folder;
      f.name = unique(t, folder, f.name, f.id);
      folders++;
    } else if (ITEM_RE.test(k)) {
      t.place[k] = folder ?? ROOT;
      files++;
    } else throw new FilesError(`not a file or folder: ${k}`);
  }
  await save(t);
  return { files, folders, folder };
}

/** Back to its kind's folder (Videos, Images, ...): forget where a file was put. */
export async function autoFile(keys: string[]) {
  const t = await load();
  for (const k of keys) delete t.place[k];
  await save(t);
}

export async function starItems(keys: string[], on: boolean) {
  const t = await load();
  const s = new Set(t.starred);
  for (const k of keys) {
    if (!ITEM_RE.test(k) && !FKEY.test(k)) throw new FilesError(`not a file or folder: ${k}`);
    if (on) s.add(k); else s.delete(k);
  }
  t.starred = [...s];
  await save(t);
  return t.starred;
}

// ── the trash: deleting puts things here for 30 days; restore puts them back where they were

export async function trashItems(keys: string[], by: string | null) {
  const t = await load();
  const at = Date.now();
  for (const k of keys) {
    if (FKEY.test(k)) {
      const f = t.folders.find((x) => x.id === k.slice(2));
      if (!f) throw new FilesError("that folder doesn't exist", 404);
      if (f.system) throw new FilesError(`"${f.name}" sorts files by kind and can't be deleted`);
    } else if (!ITEM_RE.test(k)) throw new FilesError(`not a file or folder: ${k}`);
    t.trash[k] = { at, by };
  }
  await save(t);
  return { trashed: keys.length };
}

export async function restoreItems(keys: string[]) {
  const t = await load();
  let restored = 0;
  for (const k of keys) {
    if (!t.trash[k]) continue;
    delete t.trash[k];
    restored++;
    if (FKEY.test(k)) {
      // a folder comes back under its old parent, or at the top if that's gone or still in the trash
      const f = t.folders.find((x) => x.id === k.slice(2));
      if (f?.parent && (!t.folders.some((x) => x.id === f.parent) || t.trash[`f:${f.parent}`])) f.parent = null;
      if (f) f.name = unique(t, f.parent, f.name, f.id);
    }
  }
  await save(t);
  return { restored };
}

/** What deleting for good involves: the trashed folders (with their folders inside) and every file in them. */
export function forgetPlan(t: FileTree, keys: string[]) {
  const folders = new Set<string>();
  for (const k of keys) if (FKEY.test(k)) for (const id of subtree(t, k.slice(2))) folders.add(id);
  const files = new Set(keys.filter((k) => ITEM_RE.test(k)));
  for (const [k, f] of Object.entries(t.place)) if (folders.has(f)) files.add(k);
  return { folders, files: [...files] };
}

/** Drop files that were deleted for good (place, star, trash) and folders removed with them. */
export async function forget(files: string[], folders: Iterable<string> = []) {
  const t = await load();
  const gone = new Set(folders);
  for (const k of files) { delete t.place[k]; delete t.trash[k]; delete t.posters[k]; }
  for (const id of gone) delete t.trash[`f:${id}`];
  t.folders = t.folders.filter((f) => !gone.has(f.id) || f.system);
  for (const [k, f] of Object.entries(t.place)) if (gone.has(f)) delete t.place[k];
  const dead = new Set([...files, ...[...gone].map((id) => `f:${id}`)]);
  t.starred = t.starred.filter((k) => !dead.has(k));
  await save(t);
}

/** Trash entries past their 30 days. */
export const expired = (t: FileTree, now = Date.now()) => Object.entries(t.trash).filter(([, v]) => now - v.at > TRASH_DAYS * 864e5).map(([k]) => k);

export async function markPoster(key: string) {
  const t = await load();
  t.posters[key] = Date.now();
  await save(t);
}

/** A folder by id, or by its name path ("Thumbnails/October"), case-insensitive. null for the top level. */
export function findFolder(t: FileTree, ref: string | null | undefined) {
  if (!ref || ref === "/") return null;
  const live = t.folders.filter((f) => !t.trash[`f:${f.id}`]);
  const byId = live.find((f) => f.id === ref);
  if (byId) return byId;
  let parent: string | null = null;
  let found: Folder | undefined;
  for (const part of ref.split("/").map((s) => s.trim()).filter(Boolean)) {
    found = live.find((f) => f.parent === parent && f.name.toLowerCase() === part.toLowerCase());
    if (!found) throw new FilesError(`no folder called "${ref}" (list_files shows them)`, 404);
    parent = found.id;
  }
  return found ?? null;
}

/** A folder by id or name path, made (each missing part of the path) when it doesn't exist yet: "Images/Samurai"
 *  makes Samurai inside the Images category. null for the top level. */
export async function folderOrMake(ref: string | null | undefined, by: string | null) {
  if (!ref || ref === "/") return null;
  try { return findFolder(await load(), ref); } catch (e) { if (!(e instanceof FilesError) || e.status !== 404) throw e; }
  let parent: string | null = null;
  let f: Folder | null = null;
  for (const part of ref.split("/").map((s) => s.trim()).filter(Boolean)) {
    const t = await load();
    f = t.folders.find((x) => x.parent === parent && x.name.toLowerCase() === part.toLowerCase() && !t.trash[`f:${x.id}`]) ?? await createFolder({ name: part, parent }, by);
    parent = f.id;
  }
  return f;
}

/** Where a file shows on the Files page, for answers: the internal id apart from the name and path people read, so
 *  a model never mistakes "sysimages" for a folder called that. */
export async function whereFiled(key: string, kind: MediaKind) {
  const t = await load();
  const id = folderFor(t, key, kind);
  if (!id) return { folder_id: "/", folder_name: "Files", folder_path: "/" };
  const f = t.folders.find((x) => x.id === id);
  return { folder_id: id, folder_name: f?.name ?? id, folder_path: pathOf(t, id).split(" / ").join("/") };
}
