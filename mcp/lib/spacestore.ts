// Where each post goes (its targets, see spaces.ts) and the studio's weekly goals, kept in R2 as one small JSON file:
// workspace/spaces.json ({ posts: { <post id>: Target[] }, goals: { <space>: n } }). Writes read the latest copy first and
// change one thing, so two people editing different posts never overwrite each other. The Appwrite post is updated to
// match its targets (platforms, stage, publish time).
import { getJson, putJson } from "./store";
import { cleanGoals, cleanTargets, postFromTargets, type Goals, type Target, type TargetMap } from "./spaces";
import { getPost, hasKey, updatePost } from "./appwrite";

const KEY = "workspace/spaces.json";
type Store = { posts: TargetMap; goals: Goals };

async function load(): Promise<Store> {
  const s = await getJson<Partial<Store>>(KEY).catch(() => null);
  return { posts: s?.posts ?? {}, goals: s?.goals ?? {} };
}

export async function getSpaces() {
  return load();
}

export async function getTargets(): Promise<TargetMap> {
  return (await load()).posts;
}

export async function setGoals(given: unknown): Promise<Goals> {
  const s = await load();
  s.goals = cleanGoals(given);
  await putJson(KEY, s);
  return s.goals;
}

/** Replace one post's targets (and sync the post). Returns the cleaned targets. */
export async function setTargets(postId: string, given: unknown, actor: { id?: string; name: string }, sync = true): Promise<Target[]> {
  const s = await load();
  const before = s.posts[postId] ?? [];
  const now = new Date().toISOString();
  // when each target went live: kept from before, or now for one that just moved to posted
  const targets = cleanTargets(given).map((t) => (t.status === "posted" ? { ...t, posted_at: t.posted_at ?? before.find((b) => b.space === t.space)?.posted_at ?? now } : t));
  s.posts[postId] = targets;
  await putJson(KEY, s);
  if (sync && hasKey()) {
    const p = await getPost(postId);
    const next = postFromTargets(targets);
    const patch: Record<string, unknown> = {};
    if (JSON.stringify(next.platforms) !== JSON.stringify(p.platforms)) patch.platforms = next.platforms;
    if (next.status && next.status !== p.status) patch.status = next.status;
    if (next.due_at !== undefined && next.due_at !== p.due_at) patch.due_at = next.due_at;
    const live = targets.find((t) => t.link)?.link;
    if (live && !p.link) patch.link = live;
    if (next.status === "posted" && !p.posted_at) patch.posted_at = now;
    if (Object.keys(patch).length) await updatePost(postId, patch, actor);
  }
  return targets;
}

export async function dropTargets(postId: string) {
  const s = await load();
  if (!(postId in s.posts)) return;
  delete s.posts[postId];
  await putJson(KEY, s);
}
