// Shared workspace (Appwrite Cloud): ids, types and labels used by the browser, the API routes and the MCP tools.
// Appwrite holds the team's posts, comments, activity and media; R2 stays the voiceover library and the media backup.

export const AW = {
  endpoint: process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://sgp.cloud.appwrite.io/v1",
  project: process.env.NEXT_PUBLIC_APPWRITE_PROJECT || "voicebox-studio",
  db: "studio",
  bucket: "media",
  team: "studio",
} as const;

export const STATUSES = [
  { id: "idea", label: "Ideas", hint: "Anything worth making" },
  { id: "draft", label: "In production", hint: "Script, voice, edit" },
  { id: "review", label: "Review", hint: "Waiting on the other one" },
  { id: "scheduled", label: "Scheduled", hint: "Has a date" },
  { id: "posted", label: "Posted", hint: "Live" },
] as const;
export type Status = (typeof STATUSES)[number]["id"];

export const PLATFORMS = [
  { id: "youtube", label: "YouTube" },
  { id: "shorts", label: "Shorts" },
  { id: "reels", label: "Reels" },
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "x", label: "X" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "podcast", label: "Podcast" },
] as const;
export type Platform = (typeof PLATFORMS)[number]["id"];

type Row = { $id: string; $createdAt: string; $updatedAt: string; $sequence: string; $tableId: string; $databaseId: string; $permissions: string[] };

export type Post = Row & {
  title: string; status: Status; platforms: Platform[]; script: string | null; caption: string | null; notes: string | null;
  due_at: string | null; posted_at: string | null; link: string | null; owner_id: string | null; owner_name: string | null;
  assignee_id: string | null; assignee_name: string | null; jobs: string[]; cover: string | null;
};
export type Comment = Row & { post_id: string; body: string; author_id: string | null; author_name: string | null };
export type Activity = Row & { post_id: string | null; verb: string; text: string | null; actor_id: string | null; actor_name: string | null };
export type MediaKind = "image" | "video" | "audio" | "doc" | "other";
export type Media = Row & {
  file_id: string; name: string; mime: string | null; size: number | null; kind: MediaKind; post_id: string | null;
  uploaded_by: string | null; uploaded_name: string | null; r2_key: string | null; token: string | null;
};
export type Member = { id: string; name: string; email: string };

export const POST_FIELDS = ["title", "status", "platforms", "script", "caption", "notes", "due_at", "posted_at", "link", "assignee_id", "assignee_name", "jobs", "cover"] as const;

export function kindOf(mime: string, name = ""): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (/pdf|text|document|sheet|presentation/.test(mime) || /\.(pdf|txt|md|docx?|srt|vtt)$/i.test(name)) return "doc";
  return "other";
}

/** A token URL for a stored file. Tokens are secrets kept in team-only rows, so <img>/<video> work without a session cookie. */
export function fileUrl(m: Pick<Media, "file_id" | "token">, mode: "view" | "download" | "preview" = "view", w?: number) {
  const u = new URL(`${AW.endpoint}/storage/buckets/${AW.bucket}/files/${m.file_id}/${mode}`);
  u.searchParams.set("project", AW.project);
  if (m.token) u.searchParams.set("token", m.token);
  if (mode === "preview" && w) { u.searchParams.set("width", String(w)); u.searchParams.set("quality", "82"); u.searchParams.set("output", "webp"); }
  return u.toString();
}

export const initials = (name?: string | null) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
