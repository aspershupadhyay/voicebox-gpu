// The Files page's file manager: folders, where each file sits and what's starred, kept in R2 as one small JSON file
// (workspace/files.json). Files themselves stay where they are: uploads in Appwrite (`m:<media id>`), generated takes,
// subtitles, images and videos in the R2 library (`g:<library id>`). Folders are `f:<folder id>` when moved. Writes read
// the latest copy first and change one thing, so two people filing different things never overwrite each other.
import { getJson, putJson } from "./store";
import { FOLDER_COLORS, type FolderColor } from "./workspace";

export { FOLDER_COLORS, type FolderColor };
export type Folder = { id: string; name: string; color: FolderColor; parent: string | null; created: number; by: string | null };
export type FileTree = { folders: Folder[]; place: Record<string, string>; starred: string[] };

const KEY = "workspace/files.json";
export const ITEM_RE = /^[mg]:[A-Za-z0-9._-]{1,64}$/;
export const FOLDER_RE = /^[a-z0-9]{6,16}$/;
const MAX_FOLDERS = 500;

export class FilesError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function load(): Promise<FileTree> {
  const s = await getJson<Partial<FileTree>>(KEY).catch(() => null);
  return { folders: s?.folders ?? [], place: s?.place ?? {}, starred: s?.starred ?? [] };
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
  return f;
}

/** True when `id` is `ancestor` or sits somewhere inside it. */
function within(t: FileTree, id: string | null, ancestor: string) {
  for (let cur = id, n = 0; cur && n < 64; n++) {
    if (cur === ancestor) return true;
    cur = t.folders.find((x) => x.id === cur)?.parent ?? null;
  }
  return false;
}

/** A name not already used by a sibling: "Thumbnails", "Thumbnails 2", ... */
function unique(t: FileTree, parent: string | null, name: string, except?: string) {
  const taken = new Set(t.folders.filter((f) => f.parent === parent && f.id !== except).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

export async function createFolder(input: { name?: unknown; parent?: unknown; color?: unknown }, by: string | null) {
  const t = await load();
  if (t.folders.length >= MAX_FOLDERS) throw new FilesError(`up to ${MAX_FOLDERS} folders`);
  const parent = input.parent ? String(input.parent) : null;
  folderOf(t, parent);
  const f: Folder = {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 10), name: unique(t, parent, cleanName(input.name ?? "Untitled folder")),
    color: cleanColor(input.color, t.folders.length), parent, created: Date.now(), by,
  };
  t.folders.push(f);
  await save(t);
  return f;
}

/** Rename, recolour or move a folder (into another folder, or to the top with parent null). */
export async function updateFolder(id: string, patch: { name?: unknown; color?: unknown; parent?: unknown }) {
  const t = await load();
  const f = folderOf(t, id)!;
  if (patch.parent !== undefined) {
    const parent = patch.parent ? String(patch.parent) : null;
    folderOf(t, parent);
    if (parent && within(t, parent, id)) throw new FilesError("a folder can't go inside itself");
    f.parent = parent;
  }
  if (patch.name !== undefined || patch.parent !== undefined) f.name = unique(t, f.parent, patch.name !== undefined ? cleanName(patch.name) : f.name, f.id);
  if (patch.color !== undefined) f.color = cleanColor(patch.color);
  await save(t);
  return f;
}

/** Delete a folder. What was inside (files and folders) moves up to its parent; nothing is deleted with it. */
export async function deleteFolder(id: string) {
  const t = await load();
  const f = folderOf(t, id)!;
  let moved = 0;
  for (const c of t.folders) if (c.parent === id) { c.parent = f.parent; c.name = unique(t, f.parent, c.name, c.id); moved++; }
  for (const [k, v] of Object.entries(t.place)) if (v === id) { if (f.parent) t.place[k] = f.parent; else delete t.place[k]; moved++; }
  t.folders = t.folders.filter((x) => x.id !== id);
  await save(t);
  return { deleted: f, moved };
}

/** Move files (m:/g: keys) and folders (f: keys) into a folder, or to the top level with folder null. */
export async function moveItems(keys: string[], folder: string | null) {
  const t = await load();
  folderOf(t, folder);
  let files = 0, folders = 0;
  for (const k of keys) {
    if (k.startsWith("f:")) {
      const f = folderOf(t, k.slice(2))!;
      if (folder && within(t, folder, f.id)) throw new FilesError(`"${f.name}" can't go inside itself`);
      f.parent = folder;
      f.name = unique(t, folder, f.name, f.id);
      folders++;
    } else if (ITEM_RE.test(k)) {
      if (folder) t.place[k] = folder; else delete t.place[k];
      files++;
    } else throw new FilesError(`not a file or folder: ${k}`);
  }
  await save(t);
  return { files, folders, folder };
}

export async function starItems(keys: string[], on: boolean) {
  const t = await load();
  const s = new Set(t.starred);
  for (const k of keys) {
    if (!ITEM_RE.test(k) && !/^f:[a-z0-9]{6,16}$/.test(k)) throw new FilesError(`not a file or folder: ${k}`);
    if (on) s.add(k); else s.delete(k);
  }
  t.starred = [...s];
  await save(t);
  return t.starred;
}

/** Forget deleted files (their folder and star). */
export async function forgetItems(keys: string[]) {
  const t = await load();
  let changed = false;
  for (const k of keys) {
    if (k in t.place) { delete t.place[k]; changed = true; }
  }
  const starred = t.starred.filter((k) => !keys.includes(k));
  if (starred.length !== t.starred.length) { t.starred = starred; changed = true; }
  if (changed) await save(t);
}

/** A folder by id, or by its name path ("Thumbnails/October"), case-insensitive. null for the top level. */
export function findFolder(t: FileTree, ref: string | null | undefined) {
  if (!ref || ref === "/" ) return null;
  const byId = t.folders.find((f) => f.id === ref);
  if (byId) return byId;
  let parent: string | null = null;
  let found: Folder | undefined;
  for (const part of ref.split("/").map((s) => s.trim()).filter(Boolean)) {
    found = t.folders.find((f) => f.parent === parent && f.name.toLowerCase() === part.toLowerCase());
    if (!found) throw new FilesError(`no folder called "${ref}" (list_files shows them)`, 404);
    parent = found.id;
  }
  return found ?? null;
}

/** "Thumbnails / October" for a folder id. */
export function pathOf(t: FileTree, id: string | null) {
  const parts: string[] = [];
  for (let cur = id, n = 0; cur && n < 64; n++) {
    const f = t.folders.find((x) => x.id === cur);
    if (!f) break;
    parts.unshift(f.name);
    cur = f.parent;
  }
  return parts.join(" / ");
}
