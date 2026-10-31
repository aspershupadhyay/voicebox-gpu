// Formats: a series' look saved once (docs/FACTORY.md I), so a video is only its content. A format holds the brand
// (colours, font), the platform and shape, the caption style, an optional logo and music bed (Files ids), beat sync,
// a sticker on the opening scene and an outro scene. The factory and edit_video take format: "<id>" and fill in
// whatever the call doesn't say; the same outro and brand every time means the same rendered scenes, so the factory's
// cache serves them instead of the GPU. Three come built in; saving one with the same id replaces it (kept in R2).
import type { Brand } from "./templates";
import { getJson, putJson } from "../store";

export type Sticker = string | { kind: string; text?: string; at?: number; position?: "top" | "middle" | "bottom" | "corner"; lottie?: string };
export type Format = {
  id: string; name: string; about: string;
  platform: "reels" | "shorts" | "tiktok" | "youtube" | "ig_post" | "square"; shape?: "9:16" | "16:9" | "1:1" | "4:5"; fit?: "crop" | "pad" | "blur";
  brand: Brand;
  captions: { style: "pop" | "bold" | "clean"; position: "lower" | "middle" | "upper" } | null;
  logo?: string; music?: string; music_db?: number;
  /** edit_video: cuts and text land on the music's beats */
  beat_sync?: boolean;
  /** the opening scene's sticker (factory), unless the scene has its own */
  hook_sticker?: Sticker;
  /** a last scene added to every video: its line is voiced like the rest */
  outro?: { line: string; template: string; fields: Record<string, unknown> };
  /** edit_video: the source credited on screen (pass credit: "@who on YouTube") */
  credit?: boolean;
  /** edit_video: the clip's own sound under a voiceover */
  original_volume_db?: number;
  voice?: { engine?: string; voice?: string; style?: "tech" | "hype" | "narrator" | "neutral" };
  built_in?: boolean;
};

const HANDLE = "@catchtheerror";
const INK = "#ffffff", BG = "#0a0a0a";

export const BUILT_IN: Format[] = [
  {
    id: "news", name: "CatchTheError News", built_in: true,
    about: "Fast tech and AI news, 20-45 s: the claim on screen in the first second, pop captions, a red ERROR badge on the hook, the follow card at the end.",
    platform: "shorts", shape: "9:16", fit: "crop",
    brand: { bg: BG, ink: INK, accent: "#ff453a", font: "Inter" },
    captions: { style: "pop", position: "lower" }, music_db: -18, beat_sync: true,
    hook_sticker: { kind: "badge", text: "ERROR CAUGHT", position: "top" },
    outro: { line: "Follow CatchTheError so you catch the next one.", template: "title_card", fields: { title: "CatchTheError", sub: `Follow ${HANDLE}`, sticker: { kind: "follow", text: HANDLE } } },
    voice: { style: "tech" },
  },
  {
    id: "explainer", name: "Explainer", built_in: true,
    about: "One idea taught in 30-60 s: list and quote scenes, clean captions in the middle band, a save card at the end.",
    platform: "reels", shape: "9:16", fit: "crop",
    brand: { bg: BG, ink: INK, accent: "#ffb020", font: "Inter" },
    captions: { style: "clean", position: "middle" }, music_db: -20,
    hook_sticker: { kind: "arrow", position: "bottom" },
    outro: { line: "Save this, you'll want it later.", template: "title_card", fields: { title: "Save this", sub: HANDLE, sticker: { kind: "check" } } },
    voice: { style: "narrator" },
  },
  {
    id: "clip", name: "Clip + commentary", built_in: true,
    about: "Someone else's clip (a download) with your take over it: blurred fill to 9:16, the source credited on screen, its sound under your voice, bold captions, cuts on the beat.",
    platform: "reels", shape: "9:16", fit: "blur",
    brand: { bg: BG, ink: INK, accent: "#ff453a", font: "Inter" },
    captions: { style: "bold", position: "lower" }, credit: true, original_volume_db: -14, music_db: -22, beat_sync: true,
  },
];

const KEY = "auto/formats.json";
type Doc = { formats: Format[] };

export async function listFormats(): Promise<Format[]> {
  const own = (await getJson<Doc>(KEY).catch(() => null))?.formats ?? [];
  const ids = new Set(own.map((f) => f.id));
  return [...own, ...BUILT_IN.filter((f) => !ids.has(f.id))];
}

export async function getFormat(id: string): Promise<Format> {
  const f = (await listFormats()).find((x) => x.id === id);
  if (!f) throw new Error(`no format "${id}" (formats action list shows them)`);
  return f;
}

const hex = (c: unknown, d: string) => (typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : d);
export async function saveFormat(f: Partial<Format> & { id: string }) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(f.id)) throw new Error("id: lowercase letters, digits and dashes (up to 31)");
  const base = BUILT_IN.find((x) => x.id === f.id) ?? (await listFormats()).find((x) => x.id === f.id) ?? BUILT_IN[0];
  const next: Format = {
    ...base, ...f, built_in: false,
    name: String(f.name ?? base.name).slice(0, 60), about: String(f.about ?? base.about).slice(0, 400),
    brand: { bg: hex(f.brand?.bg, base.brand.bg), ink: hex(f.brand?.ink, base.brand.ink), accent: hex(f.brand?.accent, base.brand.accent),
      font: typeof f.brand?.font === "string" && /^[A-Za-z0-9 ]{2,40}$/.test(f.brand.font) ? f.brand.font : base.brand.font },
  };
  const doc = (await getJson<Doc>(KEY).catch(() => null)) ?? { formats: [] };
  doc.formats = [next, ...doc.formats.filter((x) => x.id !== f.id)].slice(0, 40);
  await putJson(KEY, doc);
  return next;
}

/** Drop a saved format; a built-in one goes back to how it shipped. */
export async function deleteFormat(id: string) {
  const doc = (await getJson<Doc>(KEY).catch(() => null)) ?? { formats: [] };
  const had = doc.formats.length;
  doc.formats = doc.formats.filter((x) => x.id !== id);
  if (doc.formats.length === had) throw new Error(BUILT_IN.some((x) => x.id === id) ? `"${id}" is already as it shipped` : `no saved format "${id}"`);
  await putJson(KEY, doc);
  return { deleted: id, restored: BUILT_IN.some((x) => x.id === id) };
}

type Scene = { line: string; template?: string; fields?: Record<string, unknown>; clip?: string; from?: number };
type Video = { name: string; scenes: Scene[]; platform?: string; shape?: string; music?: string; captions?: boolean; format?: string; brand?: Brand; logo?: string; caption_style?: Format["captions"] };

/** A factory video with its format's look filled in where the video doesn't say: brand, platform, shape, music,
 *  captions, logo, the opening scene's sticker, and the outro scene after the last. */
export function applyFormat(v: Video, f: Format): Video {
  const scenes = v.scenes.map((s, i) => (i === 0 && f.hook_sticker && s.template && !(s.fields && "sticker" in s.fields) ? { ...s, fields: { ...(s.fields ?? {}), sticker: f.hook_sticker } } : s));
  if (f.outro && !scenes.some((s) => s.line.trim() === f.outro!.line)) scenes.push({ line: f.outro.line, template: f.outro.template, fields: f.outro.fields });
  return {
    ...v, scenes, platform: v.platform ?? f.platform, shape: v.shape ?? f.shape, music: v.music ?? f.music, brand: v.brand ?? f.brand,
    logo: v.logo ?? f.logo, caption_style: f.captions ?? undefined, captions: v.captions ?? (f.captions ? true : false),
  };
}

/** An edit_video call with its format's defaults filled in where the call doesn't say. inputs may gain "fmt_music" and
 *  "fmt_logo" (the format's Files ids). */
export function applyToEdit(inputs: Record<string, string>, spec: Record<string, unknown>, f: Format, credit?: string) {
  const ins = { ...inputs };
  const s: Record<string, unknown> = { platform: f.platform, ...(f.shape ? { shape: f.shape } : {}), ...(f.fit ? { fit: f.fit } : {}), ...spec };
  // captions only when someone speaks: a voiceover, or the clip's own sound left on (Whisper on music alone invents
  // words: seen on the first test, "I'LL SEE" over a muted clip and a beat)
  const speaks = !!spec.voice || (spec.original_volume_db !== "mute" && spec.original_volume_db !== -60);
  if (spec.captions === undefined && f.captions && speaks) s.captions = { ...f.captions };
  if (!spec.music && f.music) { ins.fmt_music = f.music; s.music = { src: "fmt_music", volume_db: f.music_db ?? -18, duck: true }; }
  else if (spec.music && f.music_db != null && (spec.music as { volume_db?: number }).volume_db == null) s.music = { ...(spec.music as object), volume_db: f.music_db };
  if (!spec.logo && f.logo) { ins.fmt_logo = f.logo; s.logo = { src: "fmt_logo", corner: "tr", size: 0.12 }; }
  if (spec.beat_sync === undefined && f.beat_sync && s.music) s.beat_sync = true;
  if (spec.original_volume_db === undefined && f.original_volume_db != null && spec.voice) s.original_volume_db = f.original_volume_db;
  if (f.credit && credit) s.texts = [...((spec.texts as unknown[]) ?? []), { text: `Source: ${credit}`.slice(0, 120), position: "top", size: 34, box: true }];
  return { inputs: ins, spec: s };
}
