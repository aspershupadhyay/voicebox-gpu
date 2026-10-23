"use client";
// How each platform looks in the studio: its logo, in the page's own ink (no brand rainbows), plus a small glyph for a
// format's shape (vertical, wide, square, text, audio). One place, so the planner, the board and the drawer match.
import { Headphones, InstagramLogo, LinkedinLogo, TiktokLogo, XLogo, YoutubeLogo, type Icon } from "@phosphor-icons/react";
import { SHAPE, spaceOf, type SpaceId } from "@/lib/spaces";

export const NET: Record<string, { Icon: Icon }> = {
  youtube: { Icon: YoutubeLogo },
  instagram: { Icon: InstagramLogo },
  x: { Icon: XLogo },
  tiktok: { Icon: TiktokLogo },
  linkedin: { Icon: LinkedinLogo },
  podcast: { Icon: Headphones },
};

/** A platform's logo. solid = ink tile (e.g. already posted there); otherwise a quiet outline-weight mark. */
export function PlatformBadge({ net, space, size = 22, solid }: { net?: string; space?: string; size?: number; solid?: boolean }) {
  const key = net ?? spaceOf(space ?? "")?.network ?? "";
  const n = NET[key];
  if (!n) return null;
  const sp = space ? spaceOf(space) : null;
  return (
    <span className={`pbadge ${solid ? "solid" : ""}`} title={sp ? `${sp.networkLabel} ${sp.label}` : key} style={{ width: size, height: size }}>
      <n.Icon size={Math.round(size * 0.66)} weight={solid ? "fill" : "regular"} />
    </span>
  );
}

/** The outline of a format: a tall phone for Reels/Shorts, a wide screen for videos, a square, a text block, a wave. */
export function ShapeGlyph({ space, size = 14 }: { space: SpaceId; size?: number }) {
  const shape = SHAPE[space];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className="shape-glyph">
      {shape === "tall" && <rect x="4.5" y="1.5" width="7" height="13" rx="1.8" />}
      {shape === "wide" && <rect x="1.5" y="4" width="13" height="8" rx="1.6" />}
      {shape === "square" && <rect x="2.5" y="2.5" width="11" height="11" rx="1.8" />}
      {shape === "text" && <path d="M2.5 4h11M2.5 8h11M2.5 12h7" strokeLinecap="round" />}
      {shape === "audio" && <path d="M2 8h1.5M5 5v6M8 3v10M11 5.5v5M14 8h-.5" strokeLinecap="round" />}
    </svg>
  );
}
