// The Files page's folder tree as plain data, shared by the browser and the server (no storage here; lib/files.ts keeps
// it in R2). Like Google Drive: five category folders (Videos, Images, Audio, Docs & scripts, Other) file everything by
// kind on their own; your folders sit beside them. A file you move lives where you put it (`place`), "/" meaning the
// top level; anything else sits in its kind's folder. Deleted things go to the trash first (30 days), folders with
// everything in them.
import { FOLDER_COLORS, type FolderColor, type MediaKind } from "./workspace";

export { FOLDER_COLORS, type FolderColor };
export type Folder = { id: string; name: string; color: FolderColor; parent: string | null; created: number; by: string | null; system?: MediaKind };
export type Trashed = { at: number; by: string | null };
export type FileTree = { folders: Folder[]; place: Record<string, string>; starred: string[]; trash: Record<string, Trashed>; posters: Record<string, number> };

export const ITEM_RE = /^[mg]:[A-Za-z0-9._-]{1,64}$/;
export const FOLDER_RE = /^[a-z0-9]{6,16}$/;
export const ROOT = "/";
export const TRASH_DAYS = 30;

/** The category folders, in the order they show. Their ids are fixed so every copy of the tree agrees. */
export const SYSTEM: { id: string; kind: MediaKind; name: string; color: FolderColor }[] = [
  { id: "sysvideos", kind: "video", name: "Videos", color: "rose" },
  { id: "sysimages", kind: "image", name: "Images", color: "sky" },
  { id: "sysaudio", kind: "audio", name: "Audio", color: "lavender" },
  { id: "sysdocs", kind: "doc", name: "Docs & scripts", color: "mint" },
  { id: "sysother", kind: "other", name: "Other", color: "sand" },
];
export const systemOf = (kind: MediaKind) => SYSTEM.find((s) => s.kind === kind)!.id;

/** A tree as stored (possibly from an older version), with every field and the category folders present. */
export function normalize(s: Partial<FileTree> | null | undefined): FileTree {
  const folders = [...(s?.folders ?? [])];
  for (const [i, c] of SYSTEM.entries()) {
    const have = folders.find((f) => f.id === c.id);
    if (!have) folders.splice(i, 0, { id: c.id, name: c.name, color: c.color, parent: null, created: 0, by: null, system: c.kind });
    else { have.system = c.kind; have.parent = null; }
  }
  return { folders, place: s?.place ?? {}, starred: s?.starred ?? [], trash: s?.trash ?? {}, posters: s?.posters ?? {} };
}

/** True when the folder (or one above it) is in the trash. */
export function folderTrashed(t: FileTree, id: string | null) {
  for (let cur = id, n = 0; cur && n < 64; n++) {
    if (t.trash[`f:${cur}`]) return true;
    cur = t.folders.find((f) => f.id === cur)?.parent ?? null;
  }
  return false;
}

/** Where a file shows: the folder it was put in, the top level ("/" -> null), else its kind's folder. */
export function folderFor(t: FileTree, key: string, kind: MediaKind): string | null {
  const p = t.place[key];
  if (p === ROOT) return null;
  if (p && t.folders.some((f) => f.id === p) && !folderTrashed(t, p)) return p;
  return systemOf(kind);
}

/** In the trash itself, or inside a trashed folder. */
export function isTrashed(t: FileTree, key: string) {
  if (t.trash[key]) return true;
  const p = t.place[key];
  return !!p && p !== ROOT && t.folders.some((f) => f.id === p) && folderTrashed(t, p);
}

/** True when `id` is `ancestor` or sits somewhere inside it. */
export function within(t: FileTree, id: string | null, ancestor: string) {
  for (let cur = id, n = 0; cur && n < 64; n++) {
    if (cur === ancestor) return true;
    cur = t.folders.find((x) => x.id === cur)?.parent ?? null;
  }
  return false;
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

/** A folder and every folder inside it. */
export function subtree(t: FileTree, id: string) {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of t.folders) if (f.parent && out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

export const newFolderId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
