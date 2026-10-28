// Carousels on the Files page, as plain data shared by the browser and the server (lib/carousels.ts keeps them in R2).
// A carousel is a post's set of photos and clips kept together as one stack instead of ten loose files. Two kinds:
//  - made ones: you grouped files (Files → select → Group as carousel), or a script uploaded them with `carousel`
//    (save_file, /api/files/upload). They keep their own order and name.
//  - a post's own: two or more photos or clips attached to the same post group themselves, in upload order, named
//    after the post. Renaming or reordering one turns it into a made one.
// A file sits in one carousel at most. A carousel shows while two or more of its files are out of the trash.
import type { MediaKind } from "./workspace";

export type Carousel = { id: string; name: string; items: string[]; post: string | null; created: number; by: string | null; pos?: Record<string, number> };
export type Group = { id: string; name: string; items: string[]; post: string | null; made: boolean; created: number };
export type Member = { key: string; kind: MediaKind; post: string | null; at: number };

export const CAROUSEL_RE = /^[a-z0-9]{6,16}$/;
export const POST_GROUP_RE = /^post-[A-Za-z0-9_-]{1,64}$/;
export const GROUP_KEY_RE = /^c:(?:[a-z0-9]{6,16}|post-[A-Za-z0-9_-]{1,64})$/;
export const MAX_ITEMS = 100;
export const visual = (k: MediaKind) => k === "image" || k === "video";

/** Every carousel worth showing: the made ones (in their own order), then each post's loose photos and clips. Only
 *  `members` count (pass the files out of the trash); `title` names a post's group. `min`: how many files a made one
 *  needs to show (the API also lists one that has a single file so far). */
export function groupsOf(made: Carousel[], members: Member[], title: (postId: string) => string | undefined = () => undefined, min = 2): Group[] {
  const live = new Map(members.map((m) => [m.key, m]));
  const taken = new Set<string>();
  const out: Group[] = [];
  for (const c of made) {
    const items = c.items.filter((k) => live.has(k) && !taken.has(k));
    items.forEach((k) => taken.add(k));
    if (items.length >= min) out.push({ id: c.id, name: c.name, items, post: c.post, made: true, created: c.created });
  }
  const byPost = new Map<string, Member[]>();
  for (const m of members) if (m.post && visual(m.kind) && !taken.has(m.key)) byPost.set(m.post, [...(byPost.get(m.post) ?? []), m]);
  for (const [post, ms] of byPost) {
    if (ms.length < 2) continue;
    ms.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    out.push({ id: `post-${post}`, name: title(post) || "Post carousel", items: ms.map((m) => m.key), post, made: false, created: ms[0].at });
  }
  return out;
}

/** Put a file in at its numbered spot (1 = first): files sent with a position keep that order, whatever order their
 *  uploads finish in; files without one go to the end. */
export function placeAt(c: Carousel, key: string, position?: number | null) {
  const items = c.items.filter((k) => k !== key);
  const pos = { ...(c.pos ?? {}) };
  if (position == null) { delete pos[key]; items.push(key); }
  else {
    pos[key] = position;
    const at = items.findIndex((k) => pos[k] != null && pos[k] > position);
    items.splice(at < 0 ? items.length : at, 0, key);
  }
  return { ...c, items, pos };
}
