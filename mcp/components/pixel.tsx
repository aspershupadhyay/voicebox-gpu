"use client";
// Pixel accents (the owner's call: calm, cozy, a little playful). All drawn as SVG squares with crisp edges, coloured
// from the theme tokens, and animated gently in CSS (slow twinkles, rising steam, a breathing lamp), which stops for
// anyone who prefers reduced motion.
//   PixelAvatar  your profile picture: one of five pixel characters (Nova, Byte, Miso, Boo, Fen), picked in Settings.
//   PixelScene   a night desk: stars and a moon, a lamp, a laptop with a blinking cursor, a steaming mug, a plant.
//   PageScene    a small calm scene for each page (a mic and its ripples on Voices, a sleeping cat on Files…).
//   PixelLoader  three dots rising in turn, for a small wait.
import { useMemo } from "react";

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

// The five characters you can be (Settings → Profile): 12×12 sprites, one letter per pixel, each letter a colour class.
// Eyes ("K"/"e") blink now and then.
export const CHARACTERS = {
  nova: { name: "Nova", about: "an astronaut", tone: "violet", rows: ["....wwww....", "..wwwwwwww..", ".wwvvvvvvww.", ".wvVVvvvvvw.", "wwvVvvvvvvww", "wwvvvvvvvvww", "wwvvvvvvvvww", ".wwvvvvvvww.", ".wwwwwwwwww.", "..wdwwwwdw..", ".wwwwrrwwww.", ".ww......ww."] },
  byte: { name: "Byte", about: "a little robot", tone: "ok", rows: [".....yy.....", ".....dd.....", "..gggggggg..", ".gggggggggg.", ".ggeeggeegg.", ".ggeeggeegg.", ".gggggggggg.", ".ggmmmmmmgg.", ".gggggggggg.", "..gggggggg..", ".dd.dddd.dd.", ".dd......dd."] },
  miso: { name: "Miso", about: "a ginger cat", tone: "warn", rows: [".o........o.", ".oo......oo.", ".opo....opo.", ".oooooooooo.", "oooooooooooo", "ooKKooooKKoo", "ooKKooooKKoo", "oooooppooooo", "occoooooocco", ".oooommoooo.", "..oooooooo..", "...oooooo..."] },
  boo: { name: "Boo", about: "a friendly ghost", tone: "blue", rows: ["....bbbb....", "..bbbbbbbb..", ".bbbbbbbbbb.", ".bbKbbbbKbb.", ".bbKbbbbKbb.", ".bbbbbbbbbb.", ".bpbbbbbbpb.", ".bbbbmmbbbb.", ".bbbbbbbbbb.", ".bbbbbbbbbb.", ".bb.bb.bb.b.", ".b...b...b.."] },
  fox: { name: "Fen", about: "a fox", tone: "ig", rows: ["o..........o", "oo........oo", "owo......owo", "oowoooooowoo", "oooooooooooo", "ooKKooooKKoo", "ooKKooooKKoo", "wwoooooooooww".slice(0, 12), ".wwwoooowww.", "..wwwnnwww..", "...wwwwww...", "....wwww...."] },
} as const;
export type Character = keyof typeof CHARACTERS;
export const CHARACTER_IDS = Object.keys(CHARACTERS) as Character[];
/** Without a pick, the same name always gets the same character. */
export const characterFor = (name: string, pick?: string | null): Character =>
  pick && pick in CHARACTERS ? (pick as Character) : CHARACTER_IDS[hash(name || "?") % CHARACTER_IDS.length];

const spriteCache = new Map<Character, { x: number; y: number; w: number; k: string }[]>();
const spriteOf = (c: Character) => {
  let out = spriteCache.get(c);
  if (!out) {
    out = [];
    CHARACTERS[c].rows.forEach((r, y) => { // runs of one letter become one rect
      for (let x = 0; x < r.length;) {
        const k = r[x]; let w = 1;
        while (k !== "." && r[x + w] === k) w++;
        if (k !== "." && k !== " ") out!.push({ x, y, w, k });
        x += w;
      }
    });
    spriteCache.set(c, out);
  }
  return out;
};

/** Your character as a profile picture: the one you picked in Settings, or one chosen from your name. */
export function PixelAvatar({ name, char, size = 64, className }: { name: string; char?: string | null; size?: number; className?: string }) {
  const c = characterFor(name, char);
  return (
    <span className={`px-av ch-${c} t-${CHARACTERS[c].tone} ${className ?? ""}`} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="-1 -1 14 14" width={size} height={size} shapeRendering="crispEdges">
        {spriteOf(c).map((p, i) => <rect key={i} x={p.x} y={p.y} width={p.w + 0.04} height="1.04" className={`cp-${p.k}`} />)}
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

/** Three dots rising in turn, for a small wait (shows only if the wait lasts long enough to notice). */
export function PixelLoader({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <span className={`px-load ${className ?? ""}`} role="status" aria-label={label}>
      <i /><i /><i />
    </span>
  );
}

// ───────────── a calm scene for each page, 48×16 pixels: [x, y, w, h, classes, animation delay in s]
const sky = (pts: [number, number][]): R[] => pts.map(([x, y], i) => [x, y, 1, 1, "k-star", i * 0.6]);
const ground: R = [1, 15, 46, 1, "k-D"];
const steam = (x: number, y: number): R[] => [[x, y, 1, 1, "k-steam", 0], [x + 1, y - 1, 1, 1, "k-steam", 0.9], [x, y - 2, 1, 1, "k-steam", 1.8]];
const sparkle = (x: number, y: number, d: number, cls = "k-spark"): R[] => [[x, y - 1, 1, 3, cls, d], [x - 1, y, 3, 1, cls, d]];
const run = (x0: number, x1: number, y: number, cls: string, step = 0.07): R[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y, 1, 1, cls, i * step]);
/** A pair of ")" "(" arcs `dx` either side of a centre, `h` tall, pulsing out in turn. */
const ring = (cx: number, cy: number, dx: number, h: number, d: number, cls = "k-ring"): R[] => {
  const top = cy - (h >> 1);
  return [-1, 1].flatMap((s): R[] => [[cx + s * dx, top, 1, h, cls, d], [cx + s * (dx - 1), top - 1, 1, 1, cls, d], [cx + s * (dx - 1), top + h, 1, 1, cls, d]]);
};

const SCENES: Record<string, { label: string; rects: R[] }> = {
  voices: {
    label: "A studio microphone sending out soft ripples",
    rects: [
      ...sky([[3, 1], [10, 3], [40, 1], [45, 5], [33, 2], [6, 6]]),
      ...ring(21, 5, 5, 3, 0), ...ring(21, 5, 7, 5, 0.35), ...ring(21, 5, 9, 7, 0.7),
      [20, 1, 3, 1, "k-ink2"], [19, 2, 5, 6, "k-ink2"], [20, 8, 3, 1, "k-ink2"], [20, 3, 3, 1, "k-d"], [20, 5, 3, 1, "k-d"], [19, 2, 1, 2, "k-ink"],
      [18, 6, 1, 3, "k-d"], [24, 6, 1, 3, "k-d"], [18, 9, 7, 1, "k-d"], [21, 10, 1, 4, "k-d"], [18, 14, 7, 1, "k-d"],
      [4, 12, 4, 3, "k-pot"], [5, 10, 1, 2, "k-g"], [6, 9, 1, 3, "k-gd"], [4, 10, 1, 1, "k-g"], [7, 10, 1, 1, "k-g"],
      [37, 9, 6, 6, "k-f"], [38, 10, 4, 3, "k-d"], [39, 11, 2, 1, "k-mute k-glow"], [39, 13, 2, 1, "k-d"],
      ground,
    ],
  },
  posts: {
    label: "A corkboard of sticky notes, a paper plane drifting past",
    rects: [
      ...sky([[3, 2], [44, 1], [38, 9], [5, 8]]),
      [8, 1, 26, 12, "k-wood"], [9, 2, 24, 10, "k-cork"],
      [11, 3, 5, 5, "k-y"], [12, 5, 3, 1, "k-yd"], [12, 6, 2, 1, "k-yd"], [13, 3, 1, 1, "k-r"],
      [18, 5, 5, 5, "k-v k-bob"], [19, 7, 3, 1, "k-vd k-bob"], [19, 8, 2, 1, "k-vd k-bob"], [20, 5, 1, 1, "k-r k-bob"],
      [25, 3, 6, 4, "k-g"], [26, 5, 4, 1, "k-gd"], [27, 3, 1, 1, "k-r"],
      [11, 9, 4, 2, "k-b"], [12, 9, 1, 1, "k-r"], [25, 8, 5, 3, "k-ink2"], [26, 9, 3, 1, "k-d"],
      [10, 13, 1, 2, "k-wood"], [31, 13, 1, 2, "k-wood"],
      [38, 4, 4, 1, "k-ink k-fly"], [39, 5, 3, 1, "k-ink2 k-fly"], [40, 6, 1, 1, "k-ink2 k-fly"],
      [35, 6, 1, 1, "k-star", 0.3], [37, 7, 1, 1, "k-star", 0.9],
      ground,
    ],
  },
  files: {
    label: "A filing cabinet with a ginger cat asleep on top, folders floating by",
    rects: [
      ...sky([[2, 2], [9, 5], [31, 1], [44, 3], [40, 7]]),
      [4, 6, 6, 4, "k-box2"], [6, 6, 2, 4, "k-yd"], [3, 10, 8, 5, "k-box"], [6, 10, 2, 5, "k-yd"],
      [14, 6, 12, 9, "k-d"], [15, 7, 10, 2, "k-f"], [15, 10, 10, 2, "k-f"], [15, 13, 10, 1, "k-f"],
      [19, 8, 2, 1, "k-ink2"], [19, 11, 2, 1, "k-ink2"], [16, 7, 2, 1, "k-y"], [16, 10, 2, 1, "k-b"],
      [17, 4, 6, 2, "k-cat k-glow"], [22, 3, 3, 2, "k-cat"], [22, 2, 1, 1, "k-cat"], [24, 2, 1, 1, "k-cat"], [23, 4, 1, 1, "k-d"], [16, 5, 1, 1, "k-cat k-blink"],
      [26, 2, 1, 1, "k-steam", 0], [27, 1, 1, 1, "k-steam", 0.9], [28, 0, 1, 1, "k-steam", 1.8],
      [33, 8, 3, 1, "k-v k-bob"], [33, 9, 6, 4, "k-v k-bob"], [34, 7, 4, 2, "k-ink2 k-bob"], [34, 10, 4, 1, "k-vd k-bob"],
      [40, 10, 2, 1, "k-b k-bob2"], [40, 11, 5, 4, "k-b k-bob2"], [41, 12, 3, 1, "k-bd k-bob2"],
      ...sparkle(37, 4, 0.4), ...sparkle(45, 7, 1.4),
      ground,
    ],
  },
  voiceover: {
    label: "An on-air sign glowing over a mixer, headphones and a warm mug",
    rects: [
      ...sky([[24, 1], [30, 4], [44, 2], [2, 9]]),
      [4, 1, 15, 7, "k-rglow k-glow"], [5, 2, 13, 5, "k-rd"], [7, 3, 2, 3, "k-r k-blink"], [11, 3, 5, 1, "k-ink"], [11, 5, 4, 1, "k-ink2"],
      [4, 9, 16, 6, "k-f"], ...[6, 8, 10, 12, 14, 16, 18].map((x, i): R => [x, 10, 1, 4, "k-g k-eq", i * 0.18]),
      [24, 3, 12, 1, "k-d"], [35, 3, 1, 3, "k-d"], [33, 6, 5, 3, "k-ink2"], [34, 7, 3, 1, "k-d"], [31, 5, 1, 5, "k-mute"],
      [26, 11, 4, 4, "k-ink2"], [30, 12, 1, 2, "k-ink2"], [27, 12, 2, 1, "k-r"], ...steam(27, 9),
      [38, 9, 6, 1, "k-ink2"], [37, 10, 1, 2, "k-ink2"], [44, 10, 1, 2, "k-ink2"], [36, 12, 3, 3, "k-v"], [43, 12, 3, 3, "k-v"],
      ground,
    ],
  },
  cleanup: {
    label: "A broom sweeping, dust puffing up and a few sparkles",
    rects: [
      ...sky([[3, 2], [14, 1], [26, 3], [46, 2]]),
      ...[[30, 1], [29, 2], [28, 3], [27, 4], [26, 5], [25, 6], [24, 7], [23, 8]].map(([x, y]): R => [x, y, 1, 1, "k-wood k-sweep"]),
      [18, 9, 6, 2, "k-y k-sweep"], [17, 11, 7, 3, "k-y k-sweep"], [18, 11, 1, 3, "k-yd k-sweep"], [20, 11, 1, 3, "k-yd k-sweep"], [22, 11, 1, 3, "k-yd k-sweep"], [17, 14, 7, 1, "k-yd k-sweep"],
      [12, 13, 2, 1, "k-steam", 0], [10, 12, 1, 1, "k-steam", 0.7], [8, 13, 1, 1, "k-steam", 1.4], [11, 10, 1, 1, "k-steam", 2.1],
      ...sparkle(37, 4, 0), ...sparkle(43, 8, 0.8), ...sparkle(7, 4, 1.5), [33, 9, 1, 1, "k-spark", 1.1],
      [39, 10, 7, 1, "k-bd"], [40, 11, 5, 4, "k-b"], [41, 12, 3, 1, "k-bd"], [41, 9, 1, 1, "k-steam", 0.4], [43, 8, 1, 1, "k-steam", 1.3],
      ground,
    ],
  },
  subtitles: {
    label: "A little cinema screen, its subtitles typing out, and popcorn",
    rects: [
      [3, 0, 3, 14, "k-rd"], [36, 0, 3, 14, "k-rd"], [4, 0, 1, 14, "k-rglow"], [37, 0, 1, 14, "k-rglow"],
      [6, 1, 30, 11, "k-d"], [7, 2, 28, 9, "k-screen"], [29, 3, 3, 3, "k-moon"], ...sky([[10, 3], [15, 5], [22, 3], [26, 6]]),
      [10, 7, 22, 4, "k-side"], ...run(11, 30, 8, "k-ink k-type", 0.09), ...run(13, 27, 9, "k-ink2 k-type2", 0.09),
      [8, 13, 4, 2, "k-D"], [14, 13, 4, 2, "k-D"], [20, 13, 4, 2, "k-D"], [26, 13, 4, 2, "k-D"],
      [41, 10, 4, 5, "k-r"], [42, 10, 1, 5, "k-ink2"], [44, 10, 1, 5, "k-ink2"],
      [41, 9, 1, 1, "k-ink k-hop", 0], [42, 8, 1, 1, "k-ink2 k-hop", 0.3], [43, 9, 1, 1, "k-yl k-hop", 0.6], [44, 8, 1, 1, "k-ink k-hop", 0.9], [40, 9, 1, 1, "k-yl k-hop", 1.2],
      ground,
    ],
  },
  images: {
    label: "An easel with a painting of hills under a warm sun, a palette and brush",
    rects: [
      ...sky([[3, 2], [8, 6], [33, 1], [45, 3], [40, 6]]),
      [19, 0, 1, 2, "k-wood"], [11, 2, 16, 10, "k-ink2"], [12, 3, 14, 8, "k-skyb"],
      [21, 4, 3, 3, "k-y k-glow"], [20, 5, 1, 1, "k-yl k-glow"], [24, 5, 1, 1, "k-yl k-glow"],
      [12, 8, 14, 3, "k-gd"], [13, 7, 5, 1, "k-g"], [14, 6, 3, 1, "k-g"], [15, 5, 1, 1, "k-g"], [20, 8, 6, 1, "k-g"], [22, 7, 3, 1, "k-g"],
      [10, 12, 18, 1, "k-wood"], [12, 13, 1, 2, "k-wood"], [25, 13, 1, 2, "k-wood"],
      [35, 11, 7, 1, "k-wood2"], [34, 12, 9, 2, "k-wood2"], [35, 14, 7, 1, "k-wood2"],
      [36, 12, 1, 1, "k-r"], [38, 12, 1, 1, "k-b"], [40, 12, 1, 1, "k-g"], [37, 13, 1, 1, "k-y"], [39, 13, 1, 1, "k-v"],
      [44, 5, 1, 1, "k-wood k-bob"], [43, 6, 1, 1, "k-wood k-bob"], [42, 7, 1, 1, "k-wood k-bob"], [41, 8, 1, 1, "k-wood k-bob"], [40, 9, 1, 1, "k-r k-bob"],
      ...sparkle(30, 4, 0.6),
      ground,
    ],
  },
  grow: {
    label: "Bars growing like plants under a rising sun, hills behind",
    rects: [
      ...sky([[3, 1], [12, 3], [26, 1], [46, 6]]),
      [38, 2, 4, 4, "k-y k-glow"], [37, 3, 1, 2, "k-yl k-glow"], [42, 3, 1, 2, "k-yl k-glow"], [39, 1, 2, 1, "k-yl k-glow"],
      [30, 12, 16, 3, "k-gd"], [33, 11, 10, 1, "k-gd"], [36, 10, 4, 1, "k-gd"], [44, 9, 1, 3, "k-wood"], [43, 7, 3, 2, "k-g"],
      ...([[6, 3], [10, 5], [14, 4], [18, 7], [22, 9]] as const).map(([x, h], i): R => [x, 14 - h + 1, 3, h, "k-g k-eq2", i * 0.25]),
      [23, 4, 1, 1, "k-g k-bob"], [22, 3, 1, 1, "k-gd k-bob"], [24, 3, 1, 1, "k-gd k-bob"],
      [4, 14, 22, 1, "k-D"],
      ground,
    ],
  },
  live: {
    label: "A radio tower sending signals over a sleeping town, its beacon blinking",
    rects: [
      ...sky([[3, 1], [10, 2], [36, 1], [44, 4], [32, 6]]),
      ...ring(23, 3, 2, 1, 0, "k-ringg"), ...ring(23, 3, 4, 3, 0.35, "k-ringg"), ...ring(23, 3, 6, 5, 0.7, "k-ringg"),
      [23, 3, 1, 1, "k-live k-blink"],
      [22, 5, 1, 3, "k-ink2"], [21, 8, 1, 3, "k-ink2"], [20, 11, 1, 3, "k-ink2"], [19, 14, 1, 1, "k-ink2"],
      [24, 5, 1, 3, "k-ink2"], [25, 8, 1, 3, "k-ink2"], [26, 11, 1, 3, "k-ink2"], [27, 14, 1, 1, "k-ink2"],
      [23, 4, 1, 5, "k-d"], [22, 8, 3, 1, "k-d"], [21, 11, 5, 1, "k-d"],
      [4, 10, 7, 5, "k-f"], [5, 9, 5, 1, "k-d"], [6, 8, 3, 1, "k-d"], [6, 11, 2, 2, "k-y k-glow"],
      [34, 9, 9, 6, "k-f"], [35, 8, 7, 1, "k-d"], [36, 7, 5, 1, "k-d"], [36, 10, 2, 2, "k-y k-blink2"], [39, 10, 2, 2, "k-y k-glow"], [37, 13, 2, 2, "k-d"],
      ground,
    ],
  },
  content: {
    label: "A bookshelf of colourful books beside a glowing floor lamp",
    rects: [
      ...sky([[3, 2], [44, 1], [47, 7]]),
      [10, 2, 24, 13, "k-wood"], [11, 3, 22, 11, "k-side"], [11, 8, 22, 1, "k-wood"],
      [12, 4, 2, 4, "k-r"], [14, 3, 2, 5, "k-b"], [16, 4, 1, 4, "k-y"], [17, 3, 2, 5, "k-g"], [19, 4, 2, 4, "k-v k-bob"], [21, 3, 2, 5, "k-ink2"], [23, 5, 4, 1, "k-bd"], [23, 6, 4, 2, "k-y"],
      [28, 5, 3, 3, "k-pot"], [28, 4, 1, 1, "k-g"], [29, 3, 1, 2, "k-g"], [30, 4, 1, 1, "k-g"],
      [12, 9, 2, 5, "k-v"], [14, 10, 2, 4, "k-y"], [16, 9, 2, 5, "k-b"], [18, 9, 1, 5, "k-r"], [20, 12, 6, 2, "k-f"], [20, 11, 5, 1, "k-gd"], [29, 10, 3, 3, "k-b"], [30, 13, 1, 1, "k-wood"],
      [38, 5, 9, 4, "k-yglow k-glow"], [40, 3, 5, 2, "k-y"], [42, 5, 1, 10, "k-d"], [40, 14, 5, 1, "k-d"],
      ground,
    ],
  },
  audience: {
    label: "A small crowd hopping, hearts floating up",
    rects: [
      ...sky([[2, 2], [16, 1], [28, 3], [45, 1]]),
      ...([[5, "k-v"], [12, "k-b"], [19, "k-y"], [26, "k-g"], [33, "k-r"], [40, "k-p"]] as const).flatMap(([x, c], i): R[] => [
        [x, 8, 2, 2, "k-ink2 k-hop", i * 0.2], [x - 1, 10, 4, 4, `${c} k-hop`, i * 0.2], [x - 1, 14, 1, 1, "k-d k-hop", i * 0.2], [x + 2, 14, 1, 1, "k-d k-hop", i * 0.2],
      ]),
      [13, 4, 1, 1, "k-r k-float", 0], [15, 4, 1, 1, "k-r k-float", 0], [13, 5, 3, 1, "k-r k-float", 0], [14, 6, 1, 1, "k-r k-float", 0],
      [34, 3, 1, 1, "k-p k-float", 1.6], [36, 3, 1, 1, "k-p k-float", 1.6], [34, 4, 3, 1, "k-p k-float", 1.6], [35, 5, 1, 1, "k-p k-float", 1.6],
      ground,
    ],
  },
  when: {
    label: "A night window with a moon, and a wall clock ticking",
    rects: [
      [6, 1, 16, 12, "k-wood"], [7, 2, 14, 10, "k-screen"], [9, 3, 3, 3, "k-moon"], [10, 4, 1, 1, "k-screen"],
      [16, 4, 1, 1, "k-star", 0], [18, 9, 1, 1, "k-star", 0.8], [9, 9, 1, 1, "k-star", 1.6], [17, 3, 1, 1, "k-star", 2.2],
      [14, 2, 1, 10, "k-wood"], [7, 7, 14, 1, "k-wood"], [5, 13, 18, 1, "k-wood2"],
      [31, 1, 7, 1, "k-ink2"], [30, 2, 9, 7, "k-ink2"], [31, 9, 7, 1, "k-ink2"], [34, 5, 1, 1, "k-d"], [34, 3, 1, 2, "k-d"],
      [35, 5, 2, 1, "k-r k-tick"], [34, 6, 1, 2, "k-r k-tick2"],
      [34, 10, 1, 3, "k-d k-swing"], [33, 13, 3, 1, "k-y k-swing"],
      [41, 12, 3, 3, "k-pot"], [42, 10, 1, 2, "k-g"], [41, 9, 1, 2, "k-gd"], [43, 9, 1, 2, "k-g"],
      ground,
    ],
  },
  competitors: {
    label: "A podium with a gold trophy on top, confetti falling",
    rects: [
      ...sky([[3, 1], [44, 2], [30, 1]]),
      [8, 10, 8, 5, "k-d"], [16, 7, 8, 8, "k-ink2"], [24, 11, 8, 4, "k-d"], [19, 9, 2, 3, "k-d"], [11, 11, 2, 2, "k-mute"], [27, 12, 2, 2, "k-wood2"],
      [18, 2, 4, 3, "k-y"], [19, 5, 2, 1, "k-y"], [18, 6, 4, 1, "k-yd"], [17, 2, 1, 2, "k-y"], [22, 2, 1, 2, "k-y"], [19, 3, 1, 1, "k-ink k-glow"],
      ...sparkle(15, 3, 0.3), ...sparkle(25, 5, 1.2),
      ...([[6, "k-v"], [11, "k-b"], [29, "k-r"], [35, "k-g"], [40, "k-y"], [44, "k-p"], [3, "k-g"]] as const).map(([x, c], i): R => [x, 0, 1, 1, `${c} k-fall`, i * 0.55]),
      ground,
    ],
  },
  youtube: {
    label: "A retro TV playing, its antenna up",
    rects: [
      ...sky([[3, 2], [9, 6], [38, 1], [45, 5]]),
      [17, 1, 1, 1, "k-d"], [18, 2, 1, 1, "k-d"], [25, 1, 1, 1, "k-d"], [24, 2, 1, 1, "k-d"], [19, 3, 5, 1, "k-d"],
      [12, 4, 20, 11, "k-wood"], [14, 6, 14, 7, "k-P"], [20, 7, 1, 5, "k-ink"], [21, 8, 1, 3, "k-ink"], [22, 9, 1, 1, "k-ink"],
      [14, 6, 14, 1, "k-scan"], [29, 7, 2, 1, "k-ink2"], [29, 10, 2, 1, "k-ink2"],
      [36, 11, 4, 4, "k-ink2"], [40, 12, 1, 2, "k-ink2"], [37, 12, 2, 1, "k-P"], ...steam(37, 9),
      ground,
    ],
  },
  instagram: {
    label: "An instant camera flashing, a photo drifting out",
    rects: [
      ...sky([[3, 2], [8, 7], [42, 1], [46, 6]]),
      [13, 5, 18, 9, "k-ink2"], [14, 4, 5, 1, "k-ink2"], [13, 8, 18, 1, "k-p"], [19, 6, 7, 7, "k-d"], [20, 7, 5, 5, "k-f"], [21, 8, 3, 3, "k-p"], [22, 9, 1, 1, "k-ink"],
      [27, 6, 2, 1, "k-y k-flash"], [25, 2, 6, 3, "k-yglow k-flash"],
      [35, 6, 6, 7, "k-ink k-drift"], [36, 7, 4, 4, "k-skyb k-drift"], [37, 9, 2, 2, "k-p k-drift"],
      ground,
    ],
  },
};

const SCENE_OF: [RegExp, string][] = [
  [/^\/voices/, "voices"], [/^\/posts/, "posts"], [/^\/files/, "files"], [/^\/voiceover/, "voiceover"], [/^\/clean-up/, "cleanup"],
  [/^\/subtitles/, "subtitles"], [/^\/images/, "images"], [/^\/analytics\/live/, "live"], [/^\/analytics\/content/, "content"],
  [/^\/analytics\/audience/, "audience"], [/^\/analytics\/when-to-post/, "when"], [/^\/analytics\/competitors/, "competitors"],
  [/^\/analytics\/youtube/, "youtube"], [/^\/analytics\/instagram/, "instagram"], [/^\/analytics/, "grow"],
];
export const sceneFor = (path: string) => SCENE_OF.find(([re]) => re.test(path))?.[1];

/** The page's own small scene (decoration: hidden from screen readers unless given a label). */
export function PageScene({ name, className }: { name: string; className?: string }) {
  const s = SCENES[name];
  if (!s) return null;
  return (
    <svg className={`px-scene px-page ${className ?? ""}`} viewBox="0 0 48 16" preserveAspectRatio="xMidYMax meet" shapeRendering="crispEdges" aria-hidden>
      <title>{s.label}</title>
      {s.rects.map(([x, y, w, h, c, d], i) => <rect key={i} x={x} y={y} width={w} height={h} className={c} style={d ? { animationDelay: `${d}s` } : undefined} />)}
    </svg>
  );
}
