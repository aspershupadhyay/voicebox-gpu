// Content spaces: where a post goes, one level finer than the platform (Instagram → Reels / Posts / Stories). A post can
// target several spaces at once (cross-posting); each target has its own stage, publish time and live link.
// Targets are kept in R2 (workspace/spaces.json, see spacestore.ts) next to the Appwrite post; the post's `platforms`
// array stays in sync (the platform of each target) so the board filters and older tools keep working.
import { STATUSES, type Platform, type Post, type Status } from "./workspace";

export const NETWORKS = [
  { id: "youtube", label: "YouTube", spaces: [
    { id: "yt_video", label: "Videos", legacy: "youtube", about: "Long-form, 16:9" },
    { id: "yt_short", label: "Shorts", legacy: "shorts", about: "Vertical, under 3 min" },
    { id: "yt_post", label: "Posts", legacy: "youtube", about: "Community posts: text, polls, images" },
  ] },
  { id: "instagram", label: "Instagram", spaces: [
    { id: "ig_reel", label: "Reels", legacy: "reels", about: "Vertical video" },
    { id: "ig_post", label: "Posts", legacy: "instagram", about: "Photos and carousels" },
    { id: "ig_story", label: "Stories", legacy: "instagram", about: "24-hour stories" },
  ] },
  { id: "x", label: "X", spaces: [
    { id: "x_post", label: "Posts", legacy: "x", about: "Up to 280 characters" },
    { id: "x_thread", label: "Threads", legacy: "x", about: "A run of posts" },
  ] },
  { id: "tiktok", label: "TikTok", spaces: [{ id: "tt_video", label: "Videos", legacy: "tiktok", about: "Vertical video" }] },
  { id: "linkedin", label: "LinkedIn", spaces: [{ id: "li_post", label: "Posts", legacy: "linkedin", about: "Text, images, documents" }] },
  { id: "podcast", label: "Podcast", spaces: [{ id: "pod_episode", label: "Episodes", legacy: "podcast", about: "Audio episodes" }] },
] as const;

export type SpaceId = (typeof NETWORKS)[number]["spaces"][number]["id"];
export type Space = { id: SpaceId; label: string; legacy: Platform; about: string; network: string; networkLabel: string };
export const SPACES: Space[] = NETWORKS.flatMap((n) => n.spaces.map((s) => ({ ...s, network: n.id, networkLabel: n.label })));
export const SPACE_IDS = SPACES.map((s) => s.id) as [SpaceId, ...SpaceId[]];
export const spaceOf = (id: string) => SPACES.find((s) => s.id === id);
export const spaceName = (id: string) => { const s = spaceOf(id); return s ? `${s.networkLabel} ${s.label}` : id; };

export type Target = { space: SpaceId; status: Status; due_at?: string | null; link?: string | null; posted_at?: string | null };
export type TargetMap = Record<string, Target[]>;
/** Weekly goal per space (how many posts a week you're aiming for), shared by the whole studio. */
export type Goals = Partial<Record<SpaceId, number>>;

/** The shape a format takes on screen: vertical video, wide video, square, text, audio. */
export const SHAPE: Record<SpaceId, "tall" | "wide" | "square" | "text" | "audio"> = {
  yt_video: "wide", yt_short: "tall", yt_post: "text", ig_reel: "tall", ig_post: "square", ig_story: "tall",
  x_post: "text", x_thread: "text", tt_video: "tall", li_post: "square", pod_episode: "audio",
};

const RANK = Object.fromEntries(STATUSES.map((s, i) => [s.id, i])) as Record<Status, number>;
const FIRST_FOR: Partial<Record<Platform, SpaceId>> = { youtube: "yt_video", shorts: "yt_short", reels: "ig_reel", instagram: "ig_post", x: "x_post", tiktok: "tt_video", linkedin: "li_post", podcast: "pod_episode" };

/** A post's targets: the stored ones, else one per platform it already had (from before spaces existed). */
export function targetsOf(p: Pick<Post, "$id" | "platforms" | "status" | "due_at" | "link">, map: TargetMap): Target[] {
  const stored = map[p.$id];
  if (stored) return stored;
  return [...new Set((p.platforms ?? []).map((x) => FIRST_FOR[x]).filter(Boolean) as SpaceId[])]
    .map((space) => ({ space, status: p.status, due_at: p.due_at, link: p.link }));
}

/** What the Appwrite post should say once its targets change: platforms of every target; the stage of the furthest-behind
 *  target (a post is "posted" only when every target is); the earliest publish time still ahead. */
export function postFromTargets(targets: Target[]): { platforms: Platform[]; status?: Status; due_at?: string | null } {
  const platforms = [...new Set(targets.map((t) => spaceOf(t.space)?.legacy).filter(Boolean) as Platform[])];
  if (!targets.length) return { platforms };
  const status = targets.reduce((a, t) => (RANK[t.status] < RANK[a] ? t.status : a), targets[0].status);
  const open = targets.filter((t) => t.status !== "posted" && t.due_at).map((t) => t.due_at!).sort();
  return { platforms, status, ...(open.length ? { due_at: open[0] } : {}) };
}

export function cleanGoals(given: unknown): Goals {
  const out: Goals = {};
  if (!given || typeof given !== "object") return out;
  for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
    if (spaceOf(k) && typeof v === "number" && v > 0) out[k as SpaceId] = Math.min(50, Math.round(v));
  }
  return out;
}

/** When something went live: the target's own posted_at, else the post's. */
export const shippedAt = (t: Target, p: Pick<Post, "posted_at" | "$updatedAt">) => (t.status === "posted" ? t.posted_at ?? p.posted_at ?? p.$updatedAt : null);

export function cleanTargets(given: unknown): Target[] {
  if (!Array.isArray(given)) return [];
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const t of given.slice(0, 30)) {
    if (!t || typeof t !== "object") continue;
    const x = t as Record<string, unknown>;
    if (!spaceOf(String(x.space)) || seen.has(String(x.space))) continue;
    seen.add(String(x.space));
    const status = (STATUSES.some((s) => s.id === x.status) ? x.status : "idea") as Status;
    const due = typeof x.due_at === "string" && !Number.isNaN(Date.parse(x.due_at)) ? new Date(x.due_at).toISOString() : null;
    const link = typeof x.link === "string" && /^https?:\/\//.test(x.link) ? x.link.slice(0, 500) : null;
    const posted = status === "posted" && typeof x.posted_at === "string" && !Number.isNaN(Date.parse(x.posted_at)) ? new Date(x.posted_at).toISOString() : null;
    out.push({ space: x.space as SpaceId, status, due_at: due, link, posted_at: posted });
  }
  return out;
}
