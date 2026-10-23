"use client";
// How each platform looks in the studio: its logo, brand colour and a cover gradient, plus a small glyph for a format's
// shape (vertical, wide, square, text, audio). One place, so the content planner, the board and the drawer match.
import { Headphones, InstagramLogo, LinkedinLogo, TiktokLogo, XLogo, YoutubeLogo, type Icon } from "@phosphor-icons/react";
import { SHAPE, spaceOf, type SpaceId } from "@/lib/spaces";

export const NET: Record<string, { Icon: Icon; color: string; grad: string }> = {
  youtube: { Icon: YoutubeLogo, color: "#ff0033", grad: "linear-gradient(140deg, #ff5a5f 0%, #e5002b 55%, #8f0019 100%)" },
  instagram: { Icon: InstagramLogo, color: "#e1306c", grad: "linear-gradient(140deg, #feda75 0%, #fa7e1e 22%, #d62976 52%, #962fbf 78%, #4f5bd5 100%)" },
  x: { Icon: XLogo, color: "#8b8b8b", grad: "linear-gradient(140deg, #3a3a3a 0%, #111 60%, #000 100%)" },
  tiktok: { Icon: TiktokLogo, color: "#fe2c55", grad: "linear-gradient(140deg, #25f4ee 0%, #101010 42%, #101010 58%, #fe2c55 100%)" },
  linkedin: { Icon: LinkedinLogo, color: "#0a66c2", grad: "linear-gradient(140deg, #5aa2e8 0%, #0a66c2 55%, #063f78 100%)" },
  podcast: { Icon: Headphones, color: "#8b5cf6", grad: "linear-gradient(140deg, #c4b5fd 0%, #8b5cf6 50%, #4c1d95 100%)" },
};

export const netOf = (space?: string | null) => NET[spaceOf(space ?? "")?.network ?? ""] ?? null;

/** A platform's logo in a soft tile of its colour. */
export function PlatformBadge({ net, space, size = 22, solid }: { net?: string; space?: string; size?: number; solid?: boolean }) {
  const n = net ? NET[net] : netOf(space);
  if (!n) return null;
  const sp = space ? spaceOf(space) : null;
  return (
    <span className={`pbadge ${solid ? "solid" : ""}`} title={sp ? `${sp.networkLabel} ${sp.label}` : net}
      style={{ width: size, height: size, ["--pc" as string]: n.color, ["--pg" as string]: n.grad }}>
      <n.Icon size={Math.round(size * 0.62)} weight="fill" />
    </span>
  );
}

/** The outline of a format: a tall phone for Reels/Shorts, a wide screen for videos, a square, a text block, a wave. */
export function ShapeGlyph({ space, size = 14 }: { space: SpaceId; size?: number }) {
  const shape = SHAPE[space];
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className="shape-glyph">
      {shape === "tall" && <rect x="4.5" y="1.5" width="7" height="13" rx="1.8" />}
      {shape === "wide" && <rect x="1.5" y="4" width="13" height="8" rx="1.6" />}
      {shape === "square" && <rect x="2.5" y="2.5" width="11" height="11" rx="1.8" />}
      {shape === "text" && <><path d="M2.5 4h11M2.5 8h11M2.5 12h7" strokeLinecap="round" /></>}
      {shape === "audio" && <path d="M2 8h1.5M5 5v6M8 3v10M11 5.5v5M14 8h-.5" strokeLinecap="round" />}
    </svg>
  );
}
