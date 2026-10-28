// Captions fitted to each place a post goes (the Writing room → Captions, and the captions MCP tool): X gets 280
// characters, Instagram 2,200 with hashtags after a break, LinkedIn short paragraphs. Kept in R2 next to the targets
// (workspace/captions.json: { posts: { <post id>: { <space>: caption } } }); the publish composer starts a target from
// its own caption when there is one, else from the post's. Writes read the latest copy and change one post.
import { getJson, putJson } from "./store";
import { spaceOf, type SpaceId } from "./spaces";
import { captionLimit } from "./writing";

const KEY = "workspace/captions.json";
export type CaptionMap = Partial<Record<SpaceId, string>>;
type Store = { posts: Record<string, CaptionMap> };

async function load(): Promise<Store> {
  const s = await getJson<Partial<Store>>(KEY).catch(() => null);
  return { posts: s?.posts ?? {} };
}

export async function getCaptions(): Promise<Record<string, CaptionMap>> {
  return (await load()).posts;
}

export async function captionsFor(postId: string): Promise<CaptionMap> {
  return (await load()).posts[postId] ?? {};
}

/** One target's own caption, if it has one. */
export async function captionFor(postId: string, space: SpaceId): Promise<string | null> {
  return (await captionsFor(postId))[space] ?? null;
}

/** Merge captions into a post's set; an empty string removes that space's own caption (it goes back to the post's). */
export async function setCaptions(postId: string, given: unknown): Promise<CaptionMap> {
  if (!given || typeof given !== "object") throw new Error("captions must be an object of { space: caption }");
  const s = await load();
  const cur: CaptionMap = { ...(s.posts[postId] ?? {}) };
  for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
    if (!spaceOf(k)) throw new Error(`unknown space: ${k}`);
    if (typeof v !== "string") continue;
    const text = v.trim();
    if (!text) { delete cur[k as SpaceId]; continue; }
    const max = captionLimit(k as SpaceId);
    if (text.length > max) throw new Error(`${k}: ${text.length} characters, over its ${max} limit`);
    cur[k as SpaceId] = text;
  }
  if (Object.keys(cur).length) s.posts[postId] = cur; else delete s.posts[postId];
  await putJson(KEY, s);
  return cur;
}

export async function dropCaptions(postId: string) {
  const s = await load();
  if (!(postId in s.posts)) return;
  delete s.posts[postId];
  await putJson(KEY, s);
}
