// Stories the way you'd share one by hand: Instagram's API takes a story as a bare photo or video and crops it to fill
// 9:16 (a 4:5 post loses its top and bottom, a wide one most of itself). Here the story is built first, like the app's
// own "Add post to your story": the whole post as a card with rounded corners, your picture and @handle above it, on a
// blurred, darkened copy of itself. Photos are drawn here (sharp); videos by the GPU worker's ffmpeg (kind "storycard",
// worker/gateway.py), which lays them out the same way. Styles: card (default), fit (the whole picture on the blur, no
// card or handle), fill (Instagram's own crop). The built file goes to R2 (workspace/publish/story/) and Instagram
// fetches it from a link that works for a day. Instagram's API can't add the tappable "post" sticker; the card is the
// picture of it.
import { createHash } from "node:crypto";
import { presign, putObj } from "../store";
import type { Source } from "./sources";
import { jpegUrl } from "./sources";

export type StoryStyle = "card" | "fit" | "fill";
const W = 1080, H = 1920, CARD_W = 920, CARD_H = 1300, HEAD = 76, GAP = 22, RADIUS = 34;

/** Where the card and the header sit for a picture of w×h (the worker uses the same numbers for videos). */
export function layout(w: number, h: number, style: StoryStyle) {
  const scale = Math.min((style === "fit" ? W : CARD_W) / w, (style === "fit" ? H : CARD_H) / h);
  const cw = Math.round((w * scale) / 2) * 2, ch = Math.round((h * scale) / 2) * 2;
  const block = style === "card" ? HEAD + GAP + ch : ch;
  const top = Math.round((H - block) / 2);
  return { cw, ch, x: Math.round((W - cw) / 2), y: style === "card" ? top + HEAD + GAP : top, hx: Math.round((W - cw) / 2), hy: top, radius: style === "card" ? RADIUS : 0 };
}

/** Your picture and @handle, white on clear, as a PNG strip (drawn with next/og so it has a real font). */
export async function headerPng(handle: string, avatar: string | null, width = CARD_W) {
  const { ImageResponse } = await import("next/og");
  const { createElement: h } = await import("react");
  const pic = avatar ? await fetch(avatar, { cache: "no-store" }).then(async (r) => (r.ok ? `data:${r.headers.get("content-type") ?? "image/jpeg"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}` : null)).catch(() => null) : null;
  const res = new ImageResponse(
    h("div", { style: { display: "flex", alignItems: "center", width: "100%", height: "100%", gap: 18 } },
      pic ? h("img", { src: pic, width: 64, height: 64, style: { borderRadius: 32, border: "3px solid #ffffff" } })
        : h("div", { style: { width: 64, height: 64, borderRadius: 32, background: "#ffffff" } }),
      h("div", { style: { color: "#ffffff", fontSize: 34, fontWeight: 700, letterSpacing: -0.3 } }, handle ? `@${handle.replace(/^@/, "")}` : "")),
    { width, height: HEAD },
  );
  return Buffer.from(await res.arrayBuffer());
}

/** A photo story, built: 1080×1920 JPEG bytes. */
export async function photoStory(src: Source, style: StoryStyle, who: { handle: string; avatar: string | null }) {
  const sharp = (await import("sharp")).default;
  const url = src.m ? jpegUrl(src.m, 1440) : src.url;
  const r = await fetch(url!, { cache: "no-store" });
  if (!r.ok) throw new Error(`Couldn't read ${src.name} for the story (${r.status})`);
  const img = Buffer.from(await r.arrayBuffer());
  const meta = await sharp(img).rotate().metadata();
  const w = meta.autoOrient?.width ?? meta.width ?? 1080, hgt = meta.autoOrient?.height ?? meta.height ?? 1350;
  const L = layout(w, hgt, style);
  const bg = await sharp(img).rotate().resize(W, H, { fit: "cover" }).blur(48).modulate({ brightness: 0.62 }).toBuffer();
  let card = await sharp(img).rotate().resize(L.cw, L.ch, { fit: "fill" }).toBuffer();
  if (L.radius) {
    const mask = Buffer.from(`<svg width="${L.cw}" height="${L.ch}"><rect width="${L.cw}" height="${L.ch}" rx="${L.radius}" ry="${L.radius}"/></svg>`);
    card = await sharp(card).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  }
  const layers: { input: Buffer; left: number; top: number }[] = [{ input: card, left: L.x, top: L.y }];
  if (style === "card") layers.push({ input: await headerPng(who.handle, who.avatar, L.cw), left: L.hx, top: L.hy });
  return sharp(bg).composite(layers).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

/** Keep a built story where Instagram can fetch it, for a day. */
export async function keep(post: string, bytes: Buffer | Uint8Array, ext: "jpg" | "png" | "mp4") {
  const key = `workspace/publish/story/${post}-${createHash("sha1").update(bytes).digest("hex").slice(0, 12)}.${ext}`;
  await putObj(key, bytes as BodyInit, ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : "video/mp4");
  return { key, url: await presign(key, "GET", 24 * 3600) };
}

/** A place in R2 for the worker to put a built video story, and the link to read it back. */
export async function videoSlot(post: string) {
  const key = `workspace/publish/story/${post}-${Date.now().toString(36)}.mp4`;
  return { key, put: await presign(key, "PUT", 6 * 3600), get: await presign(key, "GET", 24 * 3600) };
}
