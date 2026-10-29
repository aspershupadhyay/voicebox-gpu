// Publishing, the parts both the dashboard and the server need: which spaces Voicebox can post to by itself, every
// option a YouTube upload or an Instagram post takes, and the plan that ties a post's target to an account. Plans live in
// R2 (workspace/publish/plans/, see plans.ts); the runner (run.ts) moves them along.
import type { SpaceId } from "../spaces";

export type Network = "youtube" | "instagram";
/** Spaces Voicebox posts to itself; the rest get a hand-off (copy the caption, download the file, mark it posted). */
export const PUBLISHABLE: Partial<Record<SpaceId, Network>> = { yt_video: "youtube", yt_short: "youtube", ig_reel: "instagram", ig_post: "instagram", ig_story: "instagram" };
export const networkOf = (space: string) => PUBLISHABLE[space as SpaceId] ?? null;

export const YT_CATEGORIES: [string, string][] = [
  ["1", "Film & Animation"], ["2", "Autos & Vehicles"], ["10", "Music"], ["15", "Pets & Animals"], ["17", "Sports"], ["19", "Travel & Events"],
  ["20", "Gaming"], ["22", "People & Blogs"], ["23", "Comedy"], ["24", "Entertainment"], ["25", "News & Politics"], ["26", "Howto & Style"],
  ["27", "Education"], ["28", "Science & Technology"], ["29", "Nonprofits & Activism"],
];
export const LANGUAGES: [string, string][] = [
  ["", "Not set"], ["en", "English"], ["hi", "Hindi"], ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
  ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["ar", "Arabic"], ["ru", "Russian"], ["id", "Indonesian"], ["tr", "Turkish"], ["bn", "Bengali"],
];

export type YtOptions = {
  title: string; description: string; tags: string[]; category: string;
  privacy: "public" | "unlisted" | "private";
  /** upload ahead and let YouTube flip it public at the publish time (exact to the minute); off = upload at the time */
  youtube_schedules: boolean;
  made_for_kids: boolean; synthetic: boolean; license: "youtube" | "creativeCommon"; embeddable: boolean; public_stats: boolean;
  notify: boolean; playlist: string | null; language: string | null; recording_date: string | null;
};
export type IgOptions = {
  caption: string;
  /** Reels: show in the main feed too (else only the Reels tab) */
  share_to_feed: boolean;
  collaborators: string[]; user_tags: string[]; location_id: string | null; audio_name: string | null;
  /** Trial reels go to non-followers first; graduate by hand (MANUAL) or when it does well (SS_PERFORMANCE) */
  trial: null | "MANUAL" | "SS_PERFORMANCE";
  /** Reels cover: a frame (ms into the video), when no cover image is picked */
  thumb_offset_ms: number | null;
  alt_text: string | null; ai_generated: boolean;
  /** posted as the first comment right after it goes live (hashtags there keep the caption clean) */
  first_comment: string | null;
  /** Stories: card = the whole post as a card on a blur with your @handle (like sharing a post by hand; default),
   *  fit = the whole picture on a blur, fill = Instagram's own crop to 9:16 (lib/publish/storycard.ts) */
  story_style?: "card" | "fit" | "fill";
};

export type PlanState = "draft" | "armed" | "queued" | "uploading" | "processing" | "published" | "failed" | "canceled";
export const PLAN_LABEL: Record<PlanState, string> = {
  draft: "Not set to go", armed: "Goes out automatically", queued: "Starting", uploading: "Uploading", processing: "Processing",
  published: "Live", failed: "Failed", canceled: "Stopped",
};
export const BUSY: PlanState[] = ["queued", "uploading", "processing"];

export type LogLine = { at: number; text: string; ok?: boolean };
/** Progress kept between runs, so a big upload carries on where the last run stopped. */
export type RunState = {
  started: number; lock?: number | null;
  yt_session?: string | null; offset?: number; size?: number; video_id?: string | null;
  ig_children?: string[]; ig_container?: string | null; ig_media?: string | null;
  /** a video story being built on the GPU worker, and where it lands */
  story_job?: string | null; story_url?: string | null;
  /** YouTube: uploaded early, goes public at publish_at on its own */
  publish_at?: string | null;
};
export type Plan = {
  post: string; space: SpaceId; network: Network; account: string | null;
  /** what goes out, in order: m:<media row id> (an upload) or j:<library job id> (a generated video) */
  media: string[];
  /** thumbnail (YouTube) or Reels cover: m:<media row id>, an image */
  cover: string | null;
  /** now: when you press Publish. scheduled: at the target's publish time (the board's date). */
  when: "now" | "scheduled";
  yt?: YtOptions; ig?: IgOptions;
  state: PlanState; progress: number; step: string | null; error: string | null;
  attempts: number; next_try: number | null; run: RunState | null;
  result: { id: string; url: string; at: number; private_only?: boolean; marked?: boolean } | null;
  log: LogLine[]; updated: number; by: string;
};

export type Rules = {
  /** master switch: nothing goes out by itself while this is off (Publish now still works) */
  autopilot: boolean;
  /** failed runs try again (5 min, 20 min, 1 h…) up to this many times */
  retries: number;
  /** move the target to Posted and fill its live link when it goes out */
  mark_posted: boolean;
  /** push to the phone (the ntfy topic from GPU & engines) on publish and on failure */
  notify: boolean;
  /** when something goes live on `from`, give the post a `to` target too, `hours` later, with the same file */
  crosspost: { id: string; from: SpaceId; to: SpaceId; hours: number; on: boolean }[];
  /** the time zone slots are in (the browser's, when rules are saved) */
  tz: string;
  /** posting slots: a post moved to Scheduled without a time gets the next free slot of its space */
  slots: { id: string; space: SpaceId; day: number; time: string }[];
  /** added to every caption / description of that space */
  footer: Partial<Record<SpaceId, string>>;
  /** Instagram first comment for new plans (e.g. the hashtags) */
  first_comment: string;
  /** YouTube defaults for new plans */
  yt_defaults: Pick<YtOptions, "category" | "privacy" | "made_for_kids" | "synthetic" | "notify" | "license" | "language" | "youtube_schedules"> & { playlist: string | null; tags: string[] };
};

export const DEFAULT_RULES: Rules = {
  autopilot: true, retries: 3, mark_posted: true, notify: true, crosspost: [], tz: "UTC", slots: [], footer: {}, first_comment: "",
  yt_defaults: { category: "28", privacy: "public", made_for_kids: false, synthetic: false, notify: true, license: "youtube", language: null, youtube_schedules: true, playlist: null, tags: [] },
};

export const LIMITS = { yt_title: 100, yt_description: 5000, yt_tags: 500, ig_caption: 2200, ig_hashtags: 30, ig_mentions: 20, ig_collaborators: 3, ig_carousel: 20, ig_comment: 2200 };

/** Problems that stop a plan from going out, worded for the person fixing them. */
export function planProblems(p: Pick<Plan, "network" | "space" | "account" | "media" | "yt" | "ig">, kinds: Record<string, "image" | "video" | "other">): string[] {
  const out: string[] = [];
  if (!p.account) out.push(p.network === "youtube" ? "Pick a YouTube channel" : "Pick an Instagram account");
  const k = p.media.map((m) => kinds[m] ?? "other");
  if (!p.media.length) out.push(p.space === "ig_post" ? "Pick a photo or video" : "Pick the video");
  if (p.network === "youtube") {
    if (p.media.length > 1) out.push("YouTube takes one video");
    if (k.some((x) => x !== "video")) out.push("YouTube needs a video file");
    if (!p.yt?.title.trim()) out.push("Add a title");
    if ((p.yt?.title.length ?? 0) > LIMITS.yt_title) out.push(`Title over ${LIMITS.yt_title} characters`);
    if (/[<>]/.test(`${p.yt?.title}${p.yt?.description}`)) out.push("YouTube doesn't allow < or > in the title or description");
    if ((p.yt?.description.length ?? 0) > LIMITS.yt_description) out.push(`Description over ${LIMITS.yt_description} characters`);
    if ((p.yt?.tags.join(",").length ?? 0) > LIMITS.yt_tags) out.push(`Tags over ${LIMITS.yt_tags} characters in all`);
  } else {
    const c = p.ig?.caption ?? "";
    if (c.length > LIMITS.ig_caption) out.push(`Caption over ${LIMITS.ig_caption} characters`);
    if ((c.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > LIMITS.ig_hashtags) out.push(`More than ${LIMITS.ig_hashtags} hashtags`);
    if ((c.match(/@[\w.]+/g) ?? []).length > LIMITS.ig_mentions) out.push(`More than ${LIMITS.ig_mentions} @mentions`);
    if ((p.ig?.collaborators.length ?? 0) > LIMITS.ig_collaborators) out.push(`Up to ${LIMITS.ig_collaborators} collaborators`);
    if (p.space === "ig_reel" && (p.media.length > 1 || k.some((x) => x !== "video"))) out.push("A Reel is one video");
    if (p.space === "ig_story" && p.media.length > 1) out.push("A Story is one photo or video");
    if (p.space === "ig_post" && p.media.length > LIMITS.ig_carousel) out.push(`A carousel holds up to ${LIMITS.ig_carousel}`);
    if (k.some((x) => x === "other")) out.push("Only photos and videos can go to Instagram");
  }
  return out;
}

export const hashtags = (s: string) => [...new Set((s.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.toLowerCase()))];
