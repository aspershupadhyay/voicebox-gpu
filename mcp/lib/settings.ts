// Studio-wide defaults, kept in R2 (settings.json) so the dashboard and every MCP client share them.
// A request's own values always win; settings only fill what it leaves out. Pronunciations merge (request wins per word).
import { getJson, putJson } from "./store";

export const PLATFORMS = ["youtube", "shorts", "reels", "tiktok", "podcast", "raw"] as const;
export const VISUAL_STYLES = ["tech", "neon", "minimal", "photo", "paper", "blueprint"] as const;

export type Settings = {
  engine: string; voice: string; style: string; platform: (typeof PLATFORMS)[number]; takes: number; subtitles: boolean;
  lexicon: boolean; pronounce: Record<string, string>;
  enhance_recordings: boolean; enhance_input: boolean; enhance_output: boolean;
  visuals: "images" | "clips"; visual_style: (typeof VISUAL_STYLES)[number]; captions_look: "auto" | "bold" | "clean" | "none";
  transition: "fade" | "cut"; music_lufs: number;
  backup_media: boolean; review: boolean;
};

export const DEFAULTS: Settings = {
  engine: "qwen", voice: "female", style: "tech", platform: "youtube", takes: 1, subtitles: true,
  lexicon: true, pronounce: {},
  enhance_recordings: true, enhance_input: true, enhance_output: false,
  visuals: "images", visual_style: "tech", captions_look: "auto", transition: "fade", music_lufs: -28,
  backup_media: true, review: true,
};

const KEY = "settings.json";

export async function getSettings(): Promise<Settings> {
  const s = await getJson<Partial<Settings>>(KEY).catch(() => null);
  return { ...DEFAULTS, ...(s ?? {}), pronounce: { ...(s?.pronounce ?? {}) } };
}

/** Validate + merge a partial update; unknown keys and bad values are dropped. */
export async function updateSettings(patch: Record<string, unknown>): Promise<Settings> {
  const cur = await getSettings();
  const next: Settings = { ...cur };
  const str = (k: keyof Settings, ok?: readonly string[]) => {
    const v = patch[k];
    if (typeof v === "string" && v.length <= 64 && (!ok || ok.includes(v))) (next as Record<string, unknown>)[k] = v;
  };
  const bool = (k: keyof Settings) => { if (typeof patch[k] === "boolean") (next as Record<string, unknown>)[k] = patch[k]; };
  str("engine", ["qwen", "myvoice", "orpheus", "chatterbox", "kokoro"]); str("voice"); str("style", ["tech", "hype", "narrator", "neutral"]);
  str("platform", PLATFORMS); str("visuals", ["images", "clips"]); str("visual_style", VISUAL_STYLES);
  str("captions_look", ["auto", "bold", "clean", "none"]); str("transition", ["fade", "cut"]);
  for (const k of ["subtitles", "lexicon", "enhance_recordings", "enhance_input", "enhance_output", "backup_media", "review"] as const) bool(k);
  if (typeof patch.takes === "number") next.takes = Math.max(1, Math.min(4, Math.round(patch.takes)));
  if (typeof patch.music_lufs === "number") next.music_lufs = Math.max(-40, Math.min(-18, patch.music_lufs));
  if (patch.pronounce && typeof patch.pronounce === "object") {
    next.pronounce = Object.fromEntries(Object.entries(patch.pronounce as Record<string, unknown>)
      .filter(([k, v]) => k.trim() && typeof v === "string" && v.trim()).slice(0, 300)
      .map(([k, v]) => [k.trim().slice(0, 60), (v as string).trim().slice(0, 120)]));
  }
  await putJson(KEY, next);
  return next;
}

type Body = Record<string, unknown> & { post?: Record<string, unknown>; pronounce?: Record<string, string> };

/** Fill a worker job body's gaps from the settings. kind: undefined (voice lines), story, revoice, clean, reference. */
export function withDefaults(body: Body, s: Settings): Body {
  const kind = body.kind as string | undefined;
  const out: Body = { ...body };
  if (!kind || kind === "story") {
    // the default voice only belongs to the default engine (a recorded voice means nothing to orpheus)
    if (!body.voice && (body.engine ?? s.engine) === s.engine) out.voice = s.voice;
    out.engine ??= s.engine; out.style ??= s.style; out.takes ??= s.takes; out.lexicon ??= s.lexicon;
    out.pronounce = { ...s.pronounce, ...(body.pronounce ?? {}) };
    out.post = { ...(body.post ?? {}) };
    if (s.enhance_output && out.post.enhance === undefined) out.post.enhance = true;
  }
  if (!kind) out.subtitles ??= s.subtitles;
  if (!kind || kind === "story") out.review ??= s.review;
  if (kind !== "reference") out.platform ??= s.platform;
  if (kind === "story") {
    out.visuals ??= s.visuals; out.visual_style ??= s.visual_style; out.transition ??= s.transition; out.music_lufs ??= s.music_lufs;
    if (s.captions_look !== "auto") out.captions_look ??= s.captions_look;
  }
  if (kind === "reference") out.enhance ??= s.enhance_recordings;
  if (kind === "revoice") out.enhance ??= s.enhance_input;
  return out;
}
