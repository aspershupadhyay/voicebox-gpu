"use client";
// Pixel accents (the owner's call: calm, cozy, a little playful). All drawn as SVG squares with crisp edges, coloured
// from the theme tokens, and animated gently in CSS (slow twinkles, rising steam, a breathing lamp), which stops for
// anyone who prefers reduced motion.
//   PixelAvatar  an 8×8 mirrored avatar from a name (the same name always draws the same face), a few pixels twinkling.
//   PixelScene   a night desk: stars and a moon, a lamp, a laptop with a blinking cursor, a steaming mug, a plant.
//   PixelIcon    small 9×9 pixel icons for Settings and the profile.
import { useMemo } from "react";

const TONES = ["violet", "blue", "ok", "warn", "brand", "ig"] as const;
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/** The same name always draws the same face: 8×8, mirrored left to right, one tone, a few pixels twinkling. */
export function PixelAvatar({ name, size = 64, className }: { name: string; size?: number; className?: string }) {
  const { cells, tone } = useMemo(() => {
    let h = hash(name || "?");
    const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
    const cells: { x: number; y: number; k: "a" | "b" | "tw" }[] = [];
    for (let y = 1; y < 7; y++) for (let x = 1; x < 4; x++) {
      const r = rnd();
      if (r < 0.52) {
        const k = r < 0.08 ? "tw" : r < 0.2 ? "b" : "a";
        cells.push({ x, y, k }, { x: 7 - x, y, k });
      }
    }
    return { cells, tone: TONES[hash(name) % TONES.length] };
  }, [name]);
  return (
    <span className={`px-av t-${tone} ${className ?? ""}`} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 8 8" width={size} height={size} shapeRendering="crispEdges">
        {cells.map((c, i) => <rect key={i} x={c.x} y={c.y} width="1" height="1" className={`px-${c.k}`} style={c.k === "tw" ? { animationDelay: `${(i % 5) * 0.7}s` } : undefined} />)}
      </svg>
    </span>
  );
}

type R = [x: number, y: number, w: number, h: number, cls: string, delay?: number];

/** A cozy night desk, 64×20 pixels, scaled to fit its box. */
export function PixelScene({ className, label = "A pixel-art desk at night: stars, a moon, a lamp, a laptop, a steaming mug and a plant" }: { className?: string; label?: string }) {
  const rects: R[] = [
    // stars, twinkling out of step
    ...([[4, 2], [11, 5], [19, 1], [27, 4], [36, 2], [44, 6], [50, 1], [8, 8], [39, 8], [61, 5], [23, 7]] as const).map(([x, y], i) => [x, y, 1, 1, "s-star", i * 0.45] as R),
    // a crescent moon
    [54, 2, 3, 1, "s-moon"], [53, 3, 2, 1, "s-moon"], [52, 4, 2, 2, "s-moon"], [53, 6, 2, 1, "s-moon"], [54, 7, 3, 1, "s-moon"],
    // the lamp: shade, glow, pole, base
    [10, 8, 7, 1, "s-shade"], [11, 9, 5, 1, "s-shade"],
    [11, 10, 5, 1, "s-glow"], [10, 11, 7, 1, "s-glow2"], [9, 12, 9, 2, "s-glow3"],
    [13, 10, 1, 6, "s-pole"], [11, 15, 5, 1, "s-pole"],
    // the laptop: screen, glow lines, a blinking cursor, the base
    [20, 10, 9, 5, "s-lid"], [21, 11, 7, 3, "s-screen"], [22, 12, 3, 1, "s-code"], [22, 11, 5, 1, "s-code2"], [25, 12, 1, 1, "s-cursor"],
    [18, 15, 13, 1, "s-base"],
    // the mug and its steam
    [35, 12, 4, 4, "s-mug"], [39, 13, 1, 2, "s-mug"], [36, 13, 2, 1, "s-mugband"],
    [36, 10, 1, 1, "s-steam", 0], [37, 9, 1, 1, "s-steam", 0.9], [36, 8, 1, 1, "s-steam", 1.8],
    // the plant: pot, then leaves that sway
    [46, 13, 5, 3, "s-pot"], [45, 13, 7, 1, "s-pot2"],
    // the desk
    [4, 16, 56, 1, "s-desk"], [6, 17, 1, 3, "s-leg"], [57, 17, 1, 3, "s-leg"],
  ];
  const leaves: R[] = [[48, 12, 1, 1, "s-leaf"], [47, 11, 1, 1, "s-leaf"], [48, 10, 1, 1, "s-leaf2"], [49, 11, 1, 1, "s-leaf"], [46, 10, 1, 1, "s-leaf2"], [50, 9, 1, 1, "s-leaf2"], [45, 9, 1, 1, "s-leaf"], [48, 9, 1, 1, "s-leaf"], [51, 10, 1, 1, "s-leaf"]];
  return (
    <svg className={`px-scene ${className ?? ""}`} viewBox="0 0 64 20" preserveAspectRatio="xMidYMax meet" shapeRendering="crispEdges" role="img" aria-label={label}>
      {rects.map(([x, y, w, h, c, d], i) => <rect key={i} x={x} y={y} width={w} height={h} className={c} style={d != null ? { animationDelay: `${d}s` } : undefined} />)}
      <g className="s-plant">{leaves.map(([x, y, w, h, c], i) => <rect key={i} x={x} y={y} width={w} height={h} className={c} />)}</g>
    </svg>
  );
}

// 9×9 bitmaps: "#" the colour, "+" its lighter shade
const ICONS: Record<string, string[]> = {
  user: ["...###...", "..#####..", "..#####..", "...###...", ".........", ".#######.", "#########", "#########", "........."],
  wave: [".........", "....#....", "..#.#....", "..#.#.#..", "#.#.#.#.#", "..#.#.#..", "..#.#....", "....#....", "........."],
  rocket: ["....#....", "...###...", "...#+#...", "...###...", "..#####..", "..#####..", ".##.#.##.", ".#..+..#.", "....+...."],
  chip: [".#.#.#.#.", "#########", ".#+++++#.", "##+###+##", ".#+#+#+#.", "##+###+##", ".#+++++#.", "#########", ".#.#.#.#."],
  shield: [".#######.", "#########", "###+#####", "##+++####", "###+#####", ".#######.", "..#####..", "...###...", "....#...."],
  code: [".........", "..#...#..", ".#....#..", "#....#...", "#....#..#", ".#..#..#.", "..#.#.#..", "...#.....", "........."],
  heart: [".........", ".##...##.", "####.####", "##+######", "#########", ".#######.", "..#####..", "...###...", "....#...."],
  star: ["....#....", "....#....", "...###...", "#########", ".#######.", "..#####..", "..##.##..", ".##...##.", "........."],
  chart: [".........", ".......#.", ".......#.", "....#..#.", "....#..#.", ".#..#..#.", ".#..#..#.", ".#..#..#.", "#########"],
  bolt: ["....###..", "...###...", "..###....", ".#######.", "....###..", "...###...", "..###....", ".##......", "........."],
};

/** A small pixel icon, in the current text colour (its lighter pixels a step dimmer). */
export function PixelIcon({ name, size = 18, className }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  const rows = ICONS[name] ?? ICONS.star;
  return (
    <svg className={`px-ic ${className ?? ""}`} width={size} height={size} viewBox="0 0 9 9" shapeRendering="crispEdges" aria-hidden>
      {rows.flatMap((r, y) => [...r].map((c, x) => (c === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" opacity={c === "+" ? 0.5 : 1} fill="currentColor" />)))}
    </svg>
  );
}
