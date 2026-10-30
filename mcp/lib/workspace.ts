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

/** A Postgres row (lib/db.ts; a live one from Neon Realtime in the browser) in Appwrite's shape, so the pages and the
 *  tools read either the same way: $id and the two times, times as ISO strings, a size as a number. */
export function fromPg<T>(table: string, r: Record<string, unknown>): T {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  const { id, created_at, updated_at, ...rest } = r;
  for (const k of ["due_at", "posted_at"]) if (k in rest) rest[k] = iso(rest[k]);
  if (rest.size != null) rest.size = Number(rest.size);
  return { $id: String(id), $createdAt: iso(created_at), $updatedAt: iso(updated_at), $sequence: "", $tableId: table, $databaseId: "studio", $permissions: [], ...rest } as T;
}

export const POST_FIELDS =["title", "status", "platforms", "script", "caption", "notes", "due_at", "posted_at", "link", "assignee_id", "assignee_name", "jobs", "cover"] as const;

export function kindOf(mime: string, name = ""): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (/pdf|text|document|sheet|presentation/.test(mime) || /\.(pdf|txt|md|docx?|srt|vtt)$/i.test(name)) return "doc";
  return "other";
}

/** A file whose bytes live in R2 (lib/r2files.ts), not Appwrite Storage. */
export const onR2 = (m: Pick<Media, "file_id">) => m.file_id.startsWith("r2_");

type Stored = Pick<Media, "file_id" | "token"> & Partial<Pick<Media, "r2_key">>;
/** The dashboard's own address: relative in the browser, absolute on the server (the worker, Instagram, MCP answers). */
const site = () => typeof window !== "undefined" ? "" : process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}`
  : process.env.APP_URL?.replace(/\/$/, "") || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

/** A token URL for a stored file. Tokens are secrets kept in team-only rows, so <img>/<video> work without a session cookie.
 *  An R2 file goes through /api/m with the same query (mode, width, output), so callers don't need to know which. */
export function fileUrl(m: Stored, mode: "view" | "download" | "preview" = "view", w?: number) {
  const r2 = onR2(m) && m.r2_key;
  const u = r2 ? new URL(`${site() || "http://x"}/api/m/${m.token ?? ""}/${m.r2_key}`) : new URL(`${AW.endpoint}/storage/buckets/${AW.bucket}/files/${m.file_id}/${mode}`);
  if (r2) {
    if (mode !== "view") u.searchParams.set("mode", mode);
    if (mode === "preview" && w) { u.searchParams.set("width", String(w)); u.searchParams.set("output", "webp"); }
    return site() ? u.toString() : `${u.pathname}${u.search}`;
  }
  u.searchParams.set("project", AW.project);
  if (m.token) u.searchParams.set("token", m.token);
  if (mode === "preview" && w) { u.searchParams.set("width", String(w)); u.searchParams.set("quality", "82"); u.searchParams.set("output", "webp"); }
  return u.toString();
}

/** A photo sized for this screen (Appwrite resizes and sends WebP), so a 12 MB camera shot opens in a blink and always
 *  fits. Animated GIFs, SVGs and HEIC go as they are. Widths come in steps so the browser's cache is reused. */
export function screenPreview(m: Stored & Pick<Media, "mime" | "name">) {
  if (/gif|svg|heic|heif/i.test(`${m.mime ?? ""} ${m.name}`)) return null;
  const want = typeof window === "undefined" ? 1920 : Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1);
  const w = [1280, 1920, 2560, 3200].find((x) => x >= want) ?? 3200;
  return fileUrl(m, "preview", w);
}

// ── Files page (folders live in R2, lib/files.ts): the folder colours and how a generated library item reads as a file
export const FOLDER_COLORS = ["lavender", "sky", "peach", "mint", "rose", "sand"] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];
type LibLike = { id: string; kind?: string; label?: string; results: { text: string }[] };
/** A voiceover is audio, a subtitle job a doc. */
export const libKind = (j: Pick<LibLike, "kind">): MediaKind => (j.kind === "video" ? "video" : j.kind === "image" ? "image" : j.kind === "transcribe" ? "doc" : "audio");
export const libType = (j: Pick<LibLike, "kind">) => ({ video: "Video", image: "Image", transcribe: "Subtitles" } as Record<string, string>)[j.kind ?? ""] ?? "Voiceover";
export const libName = (j: LibLike) => j.label || (j.results[0]?.text ?? "").replace(/<[^>]+>/g, "").slice(0, 70) || j.id;

export const initials = (name?: string | null) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
