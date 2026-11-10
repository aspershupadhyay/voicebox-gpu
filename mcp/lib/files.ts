// The Files page's folder tree in R2 (workspace/files.json): folders, where each file sits, stars, the trash and which
// uploaded videos have a poster frame. Files themselves stay where they are: uploads in R2 (`m:<media id>`),
// generated takes, subtitles, images and videos in the R2 library (`g:<library id>`); folders are `f:<folder id>`.
// Writes read the latest copy first and change one thing, so two people filing different things never overwrite each
// other. The rules (category folders, trash, where a file shows) are in lib/filetree.ts, shared with the browser.
import { getJson, getJsonTagged, putJson, putJsonIf } from "./store";
import type { MediaKind } from "./workspace";
import {
  emptyFolders, FOLDER_COLORS, FOLDER_RE, holdsNothing, ITEM_RE, folderFor, normalize, pathOf, ROOT, subtree, TRASH_DAYS, within, newFolderId, type FileTree, type Folder, type FolderColor,
} from "./filetree";

export { emptyFolders, FOLDER_COLORS, FOLDER_RE, holdsNothing, ITEM_RE, pathOf, type FileTree, type Folder, type FolderColor };

const KEY = "workspace/files.json";
const MAX_FOLDERS = 500;
const FKEY = /^f:[a-z0-9]{6,16}$/;

export class FilesError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function load(): Promise<FileTree> {
  return normalize(await getJson<Partial<FileTree>>(KEY).catch(() => null));
}

// Writes are conditional: a change is saved only onto the copy it read (its ETag), else it reads again and changes
// again. Two saves at once (two people, the page and a model, a delete and the tidy-up) used to overwrite each other,
// and a file just deleted came back.
const tags = new WeakMap<FileTree, string | null>();
class Clash extends Error {}
async function loadW(): Promise<FileTree> {
  const { value, etag } = await getJsonTagged<Partial<FileTree>>(KEY);
  const t = normalize(value);
  tags.set(t, etag);
  return t;
}
async function save(t: FileTree) {
  if (!tags.has(t)) return putJson(KEY, t);
  if (!(await putJsonIf(KEY, t, tags.get(t) ?? null))) throw new Clash();
}
function retried<A extends unknown[], R>(f: (...a: A) => Promise<R>) {
  return async (...a: A): Promise<R> => {
    for (let i = 0; ; i++) {
      try { return await f(...a); } catch (e) {
        if (!(e instanceof Clash) || i >= 7) throw e instanceof Clash ? new FilesError("Files is busy: try again", 409) : e;
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 120 * (i + 1)));
      }
    }
  };
}

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
async function createFolder_(input: { id?: unknown; name?: unknown; parent?: unknown; color?: unknown }, by: string | null) {
  const t = await loadW();
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
export const createFolder = retried(createFolder_);

/** Rename, recolour or move a folder (into another folder, or to the top with parent null). Category folders can be
 *  renamed and recoloured but stay at the top. */
async function updateFolder_(id: string, patch: { name?: unknown; color?: unknown; parent?: unknown }) {
  const t = await loadW();
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
export const updateFolder = retried(updateFolder_);

/** Move files (m:/g:) and folders (f:) into a folder, or to the top level with folder null. */
async function moveItems_(keys: string[], folder: string | null) {
  const t = await loadW();
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
export const moveItems = retried(moveItems_);

/** Back to its kind's folder (Videos, Images, ...): forget where a file was put. */
async function autoFile_(keys: string[]) {
  const t = await loadW();
  for (const k of keys) delete t.place[k];
  await save(t);
}
export const autoFile = retried(autoFile_);

async function starItems_(keys: string[], on: boolean) {
  const t = await loadW();
  const s = new Set(t.starred);
  for (const k of keys) {
    if (!ITEM_RE.test(k) && !FKEY.test(k)) throw new FilesError(`not a file or folder: ${k}`);
    if (on) s.add(k); else s.delete(k);
  }
  t.starred = [...s];
  await save(t);
  return t.starred;
}
export const starItems = retried(starItems_);

// ── the trash: deleting puts things here for 30 days; restore puts them back where they were

async function trashItems_(keys: string[], by: string | null) {
  const t = await loadW();
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
export const trashItems = retried(trashItems_);

async function restoreItems_(keys: string[]) {
  const t = await loadW();
  let restored = 0;
  for (const k of keys) {
    if (!t.trash[k]) continue;
    delete t.trash[k];
    restored++;
    if (ITEM_RE.test(k)) {
      // a file whose folder is in the trash too: a folder tidied away as empty comes back with it; one someone
      // deleted stays there, and the file shows in its kind's folder (it used to stay hidden, and went with the folder)
      const chain: Folder[] = [];
      for (let cur: string | null = t.place[k] ?? null, n = 0; cur && cur !== ROOT && n < 64; n++) {
        const f = t.folders.find((x) => x.id === cur);
        if (!f) break;
        chain.push(f);
        cur = f.parent;
      }
      const gone = chain.filter((f) => t.trash[`f:${f.id}`]);
      if (gone.some((f) => !t.trash[`f:${f.id}`].auto)) delete t.place[k];
      else for (const f of gone) delete t.trash[`f:${f.id}`];
    }
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
export const restoreItems = retried(restoreItems_);

/** Tidy up: folders with nothing in them (rules in lib/filetree.ts emptyFolders) go to the trash, marked so a file
 *  restored into one brings it back. Answers the ones it moved. */
async function tidyFolders_(by = "Tidy") {
  const t = await loadW();
  const empty = emptyFolders(t);
  if (!empty.length) return [];
  const at = Date.now();
  const out = empty.map((f) => ({ id: f.id, path: pathOf(t, f.id) }));
  for (const f of empty) t.trash[`f:${f.id}`] = { at, by, auto: true };
  await save(t);
  return out;
}
export const tidyFolders = retried(tidyFolders_);

/** What deleting for good involves: the trashed folders (with their folders inside) and every file in them. */
export function forgetPlan(t: FileTree, keys: string[]) {
  const folders = new Set<string>();
  for (const k of keys) if (FKEY.test(k)) for (const id of subtree(t, k.slice(2))) folders.add(id);
  const files = new Set(keys.filter((k) => ITEM_RE.test(k)));
  for (const [k, f] of Object.entries(t.place)) if (folders.has(f)) files.add(k);
  return { folders, files: [...files] };
}

/** Drop files that were deleted for good (place, star, trash) and folders removed with them. */
async function forget_(files: string[], folders: Iterable<string> = []) {
  const t = await loadW();
  const gone = new Set(folders);
  for (const k of files) { delete t.place[k]; delete t.trash[k]; delete t.posters[k]; }
  for (const id of gone) delete t.trash[`f:${id}`];
  t.folders = t.folders.filter((f) => !gone.has(f.id) || f.system);
  for (const [k, f] of Object.entries(t.place)) if (gone.has(f)) delete t.place[k];
  const dead = new Set([...files, ...[...gone].map((id) => `f:${id}`)]);
  t.starred = t.starred.filter((k) => !dead.has(k));
  await save(t);
}
export const forget = retried(forget_);

/** Trash entries past their 30 days. */
export const expired = (t: FileTree, now = Date.now()) => Object.entries(t.trash).filter(([, v]) => now - v.at > TRASH_DAYS * 864e5).map(([k]) => k);

async function markPoster_(key: string) {
  const t = await loadW();
  t.posters[key] = Date.now();
  await save(t);
}
export const markPoster = retried(markPoster_);

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
