// Where each post goes (its targets, see spaces.ts), kept in R2 as one small JSON file: workspace/spaces.json
// ({ posts: { <post id>: Target[] } }). Writes read the latest copy first and change one post, so two people editing
// different posts never overwrite each other. The Appwrite post is updated to match (platforms, stage, publish time).
import { getJson, putJson } from "./store";
import { cleanTargets, postFromTargets, type Target, type TargetMap } from "./spaces";
import { getPost, hasKey, updatePost } from "./appwrite";

const KEY = "workspace/spaces.json";

export async function getTargets(): Promise<TargetMap> {
  return (await getJson<{ posts: TargetMap }>(KEY).catch(() => null))?.posts ?? {};
}

/** Replace one post's targets (and sync the post). Returns the cleaned targets. */
export async function setTargets(postId: string, given: unknown, actor: { id?: string; name: string }, sync = true): Promise<Target[]> {
  const targets = cleanTargets(given);
  const all = await getTargets();
  all[postId] = targets;
  await putJson(KEY, { posts: all });
  if (sync && hasKey()) {
    const p = await getPost(postId);
    const next = postFromTargets(targets);
    const patch: Record<string, unknown> = {};
    if (JSON.stringify(next.platforms) !== JSON.stringify(p.platforms)) patch.platforms = next.platforms;
    if (next.status && next.status !== p.status) patch.status = next.status;
    if (next.due_at !== undefined && next.due_at !== p.due_at) patch.due_at = next.due_at;
    const live = targets.find((t) => t.link)?.link;
    if (live && !p.link) patch.link = live;
    if (next.status === "posted" && !p.posted_at) patch.posted_at = new Date().toISOString();
    if (Object.keys(patch).length) await updatePost(postId, patch, actor);
  }
  return targets;
}

export async function dropTargets(postId: string) {
  const all = await getTargets();
  if (!(postId in all)) return;
  delete all[postId];
  await putJson(KEY, { posts: all });
}
