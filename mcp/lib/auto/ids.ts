// One id shape for every file tool (docs/FACTORY.md A, Gemini's finding): a file is m:<upload id> or g:<generated id>,
// and every tool also takes the bare id (an upload's 20-character id, a generated item's 12-hex job id), and a
// file_id wherever it takes a url. guarded() (wrap.ts) runs normalize() before the tool, so the tools stay as they are.
import { z } from "zod";

type Args = Record<string, unknown>;

/** m:x / g:x as given; a bare 12-hex id is a generated item (a job id), any other bare id an upload. */
export function fileKey(x: string) {
  const s = x.trim();
  if (/^[mgf]:/.test(s) || /^https?:\/\//.test(s)) return s;
  return /^[a-f0-9]{12}$/.test(s) ? `g:${s}` : `m:${s}`;
}

const isId = (s: unknown): s is string => typeof s === "string" && /^(?:[mg]:)?[A-Za-z0-9._-]{1,64}$/.test(s.trim()) && !/^https?:/.test(s);

/** A Files id as a link the worker or a tool can fetch (6 h). */
export async function linkOf(ref: string) {
  return (await (await import("./bench")).inputFile(fileKey(ref))).url;
}

/** Arguments that hold file ids, per tool (top level only). */
const ID_ARGS: Record<string, string[]> = {
  get_file: ["file_id"], rename_file: ["file_id"], move_files: ["items"], star_files: ["items"], delete_files: ["items"], restore_files: ["items"],
  carousels: ["items", "add", "remove"], publish_post: ["files", "cover"], run: ["files"], inspect_media: ["file"],
};
/** Tools whose `url` can be a Files id instead (file_id is added beside it). */
export const URL_TOOLS = ["revoice", "clean_audio", "add_media", "add_reference_voice"];
/** Arrays of links that may hold Files ids. */
const URL_LISTS: Record<string, string[]> = { imagine: ["image_urls"], voice_dataset: ["add_urls"] };

/** The schema as a client sees it: ids loosened to take the bare form, `url` beside a `file_id`. Returns whether url
 *  was required, so normalize() can say so when neither came. */
export function loosen(name: string, schema: z.ZodObject): { schema: z.ZodObject; urlRequired: boolean } {
  const shape = schema.shape as Record<string, z.ZodType>;
  const ext: Record<string, z.ZodType> = {};
  let urlRequired = false;
  for (const k of ID_ARGS[name] ?? []) {
    const f = shape[k];
    if (!f) continue;
    const opt = f.safeParse(undefined).success;
    const one = z.string().max(2000).describe("a file id: m:<id>, g:<id> or the bare id" + (k === "items" ? ", or a folder as f:<id>" : "") + (name === "run" || name === "inspect_media" ? ", or a link" : ""));
    const isArr = f.def.type === "array" || (f.def as { innerType?: z.ZodType }).innerType?.def.type === "array";
    const t: z.ZodType = isArr ? z.array(one).max(500) : one;
    ext[k] = opt ? t.optional() : t;
  }
  if (name === "delete_media" && shape.media_id) ext.media_id = z.string().regex(/^(?:m:)?[A-Za-z0-9._-]{1,36}$/).describe("the upload's id: m:<id> or the bare id");
  if (URL_TOOLS.includes(name) && shape.url) {
    urlRequired = !shape.url.safeParse(undefined).success;
    ext.url = z.string().max(2000).optional().describe("a link to the file, or a Files id (m:… / g:…)");
    ext.file_id = z.string().max(80).optional().describe("instead of url: the file's id from list_files (m:… / g:…)");
  }
  return { schema: Object.keys(ext).length ? schema.extend(ext) : schema, urlRequired };
}

/** The arguments with every id in the shape the tool expects, and Files ids where a link goes turned into links. */
export async function normalize(name: string, args: Args, urlRequired: boolean): Promise<Args> {
  const a = { ...args };
  for (const k of ID_ARGS[name] ?? []) {
    const v = a[k];
    if (typeof v === "string" && isId(v)) a[k] = fileKey(v);
    else if (Array.isArray(v)) a[k] = v.map((x) => (isId(x) ? fileKey(x) : x));
  }
  if (name === "delete_media" && typeof a.media_id === "string") a.media_id = a.media_id.replace(/^m:/, "");
  if (URL_TOOLS.includes(name)) {
    const ref = typeof a.file_id === "string" && a.file_id ? a.file_id : typeof a.url === "string" && !/^https?:\/\//.test(a.url) && isId(a.url) ? a.url : null;
    delete a.file_id;
    if (ref) a.url = await linkOf(ref);
    if (urlRequired && !a.url) throw new Error("give url (a link) or file_id (m:… / g:… from list_files)");
    if (typeof a.url === "string" && !/^https?:\/\//.test(a.url)) throw new Error(`url: a https link or a Files id, not ${a.url.slice(0, 60)}`);
  }
  for (const k of URL_LISTS[name] ?? []) {
    if (Array.isArray(a[k])) a[k] = await Promise.all((a[k] as unknown[]).map(async (x) => (typeof x === "string" && /^[mg]:/.test(x) ? linkOf(x) : x)));
  }
  if (name === "transcribe" && Array.isArray(a.sources)) {
    a.sources = await Promise.all((a.sources as Args[]).map(async (s) => (typeof s?.url === "string" && /^[mg]:/.test(s.url) ? { ...s, url: await linkOf(s.url) } : s)));
  }
  return a;
}
