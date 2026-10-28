"use client";
// How each platform looks in the studio: YouTube and Instagram as their own marks (drawn here, flat: the red play tile, the
// camera glyph on a solid tile, no gradients), the rest in the page's own ink, plus a small glyph for a format's shape
// (vertical, wide, square, text, audio). One place, so the planner, the board and the drawer match.
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

/** YouTube's mark: the rounded red tile with a white play triangle. */
function YtMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="1" y="4.5" width="22" height="15" rx="4.6" fill="var(--yt-red)" />
      <path d="M10 8.9v6.2l5.4-3.1z" fill="var(--on-brand)" />
    </svg>
  );
}
/** Instagram's camera glyph, white on a solid tile (flat: the studio has no gradients). */
function IgMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6.2" fill="var(--ig-pink)" />
      <rect x="6" y="6" width="12" height="12" rx="3.6" fill="none" stroke="var(--on-brand)" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.9" fill="none" stroke="var(--on-brand)" strokeWidth="1.8" />
      <circle cx="15.6" cy="8.4" r="1.05" fill="var(--on-brand)" />
    </svg>
  );
}

/** A platform's logo. YouTube and Instagram always show their own mark; the others: solid = ink tile (e.g. already
 *  posted there), otherwise a quiet outline-weight mark. */
export function PlatformBadge({ net, space, size = 22, solid }: { net?: string; space?: string; size?: number; solid?: boolean }) {
  const key = net ?? spaceOf(space ?? "")?.network ?? "";
  const n = NET[key];
  if (!n) return null;
  const sp = space ? spaceOf(space) : null;
  if (key === "youtube" || key === "instagram") return (
    <span className={`pbadge brand ${key === "youtube" ? "yt" : "ig"}`} title={sp ? `${sp.networkLabel} ${sp.label}` : key === "youtube" ? "YouTube" : "Instagram"} style={{ width: size, height: size }}>
      {key === "youtube" ? <YtMark size={size} /> : <IgMark size={Math.round(size * 0.92)} />}
    </span>
  );
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
