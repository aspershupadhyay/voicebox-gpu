// The made carousels in R2 (workspace/carousels.json); the rules and a post's own carousels are in
// lib/carouselrules.ts. Ten files uploaded at once each add themselves here at the same moment, so every write is
// conditional (the copy we read, by its ETag) and retried: nobody's file drops out of a carousel.
import { CAROUSEL_RE, MAX_ITEMS, placeAt, POST_GROUP_RE, type Carousel } from "./carouselrules";
import { FilesError } from "./files";
import { ITEM_RE, newFolderId } from "./filetree";
import { getJsonTagged, putJsonIf } from "./store";

export { CAROUSEL_RE, POST_GROUP_RE, type Carousel };

const KEY = "workspace/carousels.json";
const MAX = 1000;
type Doc = { carousels: Carousel[] };

export async function getCarousels(): Promise<Carousel[]> {
  return (await getJsonTagged<Doc>(KEY)).value?.carousels ?? [];
}

/** Read, change, write if nobody wrote in between; else again (a few times, with a little jitter). */
async function change<T>(fn: (list: Carousel[]) => T): Promise<T> {
  for (let i = 0; i < 8; i++) {
    const { value, etag } = await getJsonTagged<Doc>(KEY);
    const list = structuredClone(value?.carousels ?? []);
    const out = fn(list);
    if (await putJsonIf(KEY, { carousels: list }, etag)) return out;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120 * (i + 1)));
  }
  throw new FilesError("carousels are busy: try again", 409);
}

const cleanName = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
function cleanItems(v: unknown) {
  const k = Array.isArray(v) ? [...new Set(v.map(String))] : [];
  if (!k.every((x) => ITEM_RE.test(x))) throw new FilesError("items: file ids such as m:<upload id> or g:<generated id>");
  if (k.length > MAX_ITEMS) throw new FilesError(`a carousel holds up to ${MAX_ITEMS} files`);
  return k;
}
/** A file sits in one carousel: take these out of every other (and drop carousels left empty). */
function release(list: Carousel[], keys: string[], except?: string) {
  const set = new Set(keys);
  for (const c of list) if (c.id !== except) c.items = c.items.filter((k) => !set.has(k));
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].items.length && list[i].id !== except) list.splice(i, 1);
}
const find = (list: Carousel[], ref: string) => list.find((c) => c.id === ref) ?? list.find((c) => c.name.toLowerCase() === ref.trim().toLowerCase());

/** Group files as a carousel (in this order). The browser may pick the id, so the stack shows the moment you click. */
export async function createCarousel(input: { id?: unknown; name?: unknown; items?: unknown; post?: unknown }, by: string | null) {
  const items = cleanItems(input.items);
  if (items.length < 1) throw new FilesError("a carousel needs files");
  const id = input.id == null ? newFolderId() : String(input.id);
  if (!CAROUSEL_RE.test(id)) throw new FilesError("bad carousel id");
  return change((list) => {
    const have = list.find((c) => c.id === id);
    if (have) return have; // a retried request
    if (list.length >= MAX) throw new FilesError(`up to ${MAX} carousels`);
    release(list, items);
    const c: Carousel = { id, name: cleanName(input.name) || "Carousel", items, post: input.post ? String(input.post).slice(0, 64) : null, created: Date.now(), by };
    list.push(c);
    return c;
  });
}

/** Rename, reorder (items: the full new order), add or remove files, or set which post it's for. */
export async function updateCarousel(id: string, patch: { name?: unknown; items?: unknown; add?: unknown; remove?: unknown; post?: unknown }) {
  const order = patch.items === undefined ? null : cleanItems(patch.items);
  const add = patch.add === undefined ? [] : cleanItems(patch.add);
  const drop = new Set(patch.remove === undefined ? [] : cleanItems(patch.remove));
  return change((list) => {
    const c = list.find((x) => x.id === id);
    if (!c) throw new FilesError("that carousel doesn't exist", 404);
    if (patch.name !== undefined) c.name = cleanName(patch.name) || c.name;
    if (patch.post !== undefined) c.post = patch.post ? String(patch.post).slice(0, 64) : null;
    if (order) { release(list, order, id); c.items = order; }
    if (add.length) { release(list, add, id); c.items = [...c.items.filter((k) => !add.includes(k)), ...add]; }
    if (drop.size) c.items = c.items.filter((k) => !drop.has(k));
    if (c.items.length > MAX_ITEMS) throw new FilesError(`a carousel holds up to ${MAX_ITEMS} files`);
    if (c.pos) for (const k of Object.keys(c.pos)) if (!c.items.includes(k)) delete c.pos[k];
    if (!c.items.length) list.splice(list.indexOf(c), 1);
    return { ...c, ungrouped: !c.items.length };
  });
}

/** Ungroup: the carousel goes, its files stay where they are. */
export async function ungroupCarousel(id: string) {
  return change((list) => {
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) throw new FilesError("that carousel doesn't exist", 404);
    const [c] = list.splice(i, 1);
    return { ungrouped: c.id, files: c.items.length };
  });
}

/** An uploaded file joins a carousel by id or by name; a name not used yet makes a new one (the upload API, save_file). */
export async function joinCarousel(ref: string, key: string, opts: { position?: number | null; post?: string | null; by: string | null }) {
  if (!ITEM_RE.test(key)) throw new FilesError(`not a file: ${key}`);
  return change((list) => {
    let c = find(list, ref);
    if (!c) {
      if (POST_GROUP_RE.test(ref)) throw new FilesError("a post's own carousel fills itself: upload with post_id instead");
      if (list.length >= MAX) throw new FilesError(`up to ${MAX} carousels`);
      c = { id: CAROUSEL_RE.test(ref) ? ref : newFolderId(), name: cleanName(ref) || "Carousel", items: [], post: opts.post ?? null, created: Date.now(), by: opts.by };
      list.push(c);
    }
    release(list, [key], c.id);
    if (c.items.length >= MAX_ITEMS && !c.items.includes(key)) throw new FilesError(`a carousel holds up to ${MAX_ITEMS} files`);
    Object.assign(c, placeAt(c, key, opts.position));
    if (!c.post && opts.post) c.post = opts.post;
    return { id: c.id, name: c.name, position: c.items.indexOf(key) + 1, files: c.items.length };
  });
}

/** Files deleted for good leave their carousels. */
export async function forgetInCarousels(keys: string[]) {
  const list = await getCarousels();
  if (!list.some((c) => c.items.some((k) => keys.includes(k)))) return;
  await change((l) => release(l, keys));
}
