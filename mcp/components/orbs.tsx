"use client";
// The Writing room's art (after the owner's "It's okay to be okay" poster, in matte black): each tool is a marbled orb
// (pixels, flat colours, no gradient) inside concentric rings, its name curving over the top, a chip with its number
// under it, and a thread from every chip down into one pixel hand. More rings = further along. Decoration is hidden
// from screen readers; each orb is a link with its own label.
import Link from "next/link";
import { useMemo } from "react";

export type Tone = "ginger" | "blue" | "violet" | "warn" | "chart";
export type OrbSpec = { id: string; href: string; tone: Tone; name: string; curve: string; chip: string; about: string; value: number; seed: number };

/** A deterministic marble: a pixel field of four shades of the orb's colour, swirled by two sine waves. */
function marble(seed: number, n: number) {
  const cells: [number, number, number][] = [];
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if ((x - c) ** 2 + (y - c) ** 2 > (c + 0.5) ** 2) continue;
    const v = Math.sin(x * 0.75 + seed + 2.4 * Math.sin(y * 0.5 + seed * 1.7)) + 0.7 * Math.sin(y * 0.9 - x * 0.35 + seed * 2.3);
    cells.push([x, y, v > 1.05 ? 3 : v > 0.45 ? 2 : v < -0.9 ? 0 : 1]);
  }
  return cells;
}
const SHADE = [
  (t: Tone) => `color-mix(in srgb, var(--${t}) 62%, var(--bg))`,
  (t: Tone) => `var(--${t})`,
  (t: Tone) => `color-mix(in srgb, var(--${t}) 50%, var(--ink))`,
  () => "var(--ink)",
];

/** The orb's core: a pixel marble clipped to a circle. */
export function Marble({ tone, seed, r, cx = 0, cy = 0, n = 14 }: { tone: Tone; seed: number; r: number; cx?: number; cy?: number; n?: number }) {
  const cells = useMemo(() => marble(seed, n), [seed, n]);
  const s = (r * 2) / n;
  return (
    <g className="wr-core" shapeRendering="crispEdges" aria-hidden>
      {cells.map(([x, y, k], i) => <rect key={i} x={cx - r + x * s} y={cy - r + y * s} width={s + 0.4} height={s + 0.4} style={{ fill: SHADE[k](tone) }} />)}
    </g>
  );
}

const ringsFor = (v: number) => 3 + Math.round((Math.max(0, Math.min(100, v)) / 100) * 6);

/** Rings around a centre: the count shows how far along the tool is (3 to 9). */
export function Rings({ cx, cy, r0, gap, n }: { cx: number; cy: number; r0: number; gap: number; n: number }) {
  return <g className="wr-rings" aria-hidden>{Array.from({ length: n }, (_, i) => <circle key={i} cx={cx} cy={cy} r={r0 + i * gap} style={{ transitionDelay: `${i * 30}ms` }} />)}</g>;
}

/* ───────────── the constellation (the hub) */

const W = 1000, H = 830;
const HAND = { x: 588, y: 690 };
const SPOTS = [
  { x: 262, y: 168 }, { x: 760, y: 150 }, { x: 508, y: 372 }, { x: 186, y: 506 }, { x: 822, y: 492 },
];

/** A pixel fist holding every thread (greyscale, like the poster's photo hand). */
const FIST = [
  ".......kkkk.......",
  ".....kkoooodk.....",
  "....kooooooodk....",
  "...koooooooooddk..",
  "...kmmmmmmmoooodk.",
  "..koooooodkmooodk.",
  "..kmmmmmmmkmoodk..",
  "..koooooodkmoodk..",
  "..kmmmmmmmkmodk...",
  "..koooooodkmodk...",
  "..kmmmmmmmkmodk...",
  "...koooodkmmodk...",
  "...kkmmmmmmmdk....",
  "....kdmmmmmddk....",
  "....kdmmoommdk....",
  "....kdmmoommdk....",
  "...kdmmooommdk....",
  "...kdmmooommdk....",
  "...kdmoooommdk....",
  "..kdmmoooommdk....",
]
const FIST_FILL: Record<string, string> = { o: "var(--ink2)", m: "var(--dim)", d: "var(--mute)", k: "var(--line3)" };

function Hand() {
  const px = 7, x0 = HAND.x - 9 * px, y0 = HAND.y - 2;
  return (
    <g className="wr-hand" shapeRendering="crispEdges" aria-hidden>
      {FIST.flatMap((row, y) => [...row].map((ch, x) => (FIST_FILL[ch] ? <rect key={`${x}-${y}`} x={x0 + x * px} y={y0 + y * px} width={px} height={px} style={{ fill: FIST_FILL[ch] }} /> : null)))}
    </g>
  );
}

/** Where a curved label sits: an arc over the top of the rings, read left to right. */
const arc = (cx: number, cy: number, r: number) => `M ${cx - r * Math.cos(0.42)} ${cy - r * Math.sin(0.42) * -1} A ${r} ${r} 0 1 1 ${cx + r * Math.cos(0.42)} ${cy + r * Math.sin(0.42)}`;

export function Constellation({ orbs }: { orbs: OrbSpec[] }) {
  return (
    <div className="wr-sky">
      <svg viewBox={`0 0 ${W} ${H}`} className="wr-svg" role="group" aria-label="The Writing room's tools">
        <defs>
          {orbs.map((o, i) => { const p = SPOTS[i]; const n = ringsFor(o.value); return <path key={o.id} id={`wr-arc-${o.id}`} d={arc(p.x, p.y, 56 + (n - 1) * 7 + 14)} />; })}
        </defs>
        {/* threads: from each chip down into the hand */}
        <g className="wr-threads" aria-hidden>
          {orbs.map((o, i) => {
            const p = SPOTS[i], n = ringsFor(o.value), y = p.y + 56 + (n - 1) * 7 + 44;
            const bend = (HAND.x - p.x) * 0.15;
            return <path key={o.id} pathLength={1} style={{ animationDelay: `${0.25 + i * 0.12}s` }}
              d={`M ${p.x} ${y} C ${p.x + bend} ${y + 150}, ${HAND.x - (HAND.x - p.x) * 0.55} ${HAND.y - 110 + i * 6}, ${HAND.x + (i - 2) * 3} ${HAND.y + 4}`} />;
          })}
        </g>
        <Hand />
        {orbs.map((o, i) => {
          const p = SPOTS[i], n = ringsFor(o.value), outer = 56 + (n - 1) * 7;
          return (
            <Link key={o.id} href={o.href} className={`wr-orb t-${o.tone}`} aria-label={`${o.name}: ${o.chip}. ${o.about}`} style={{ animationDelay: `${i * 0.08}s` }}>
              <circle cx={p.x} cy={p.y} r={outer + 30} className="wr-hit" />
              <Rings cx={p.x} cy={p.y} r0={56} gap={7} n={n} />
              <g className="wr-spin" style={{ transformOrigin: `${p.x}px ${p.y}px` }}><Marble tone={o.tone} seed={o.seed} r={46} cx={p.x} cy={p.y} /></g>
              <text className="wr-curve" aria-hidden><textPath href={`#wr-arc-${o.id}`} startOffset="50%" textAnchor="middle">{o.curve}</textPath></text>
              <g className="wr-chip" aria-hidden>
                <rect x={p.x - 44} y={outer + p.y + 12} width={88} height={30} rx={3} />
                <path d={`M ${p.x - 6} ${outer + p.y + 42} L ${p.x} ${outer + p.y + 49} L ${p.x + 6} ${outer + p.y + 42} Z`} />
                <text x={p.x} y={outer + p.y + 32} textAnchor="middle">{o.chip}</text>
              </g>
            </Link>
          );
        })}
        {/* the key, like the poster's little gauge: more rings, further along */}
        <g className="wr-key" aria-hidden transform="translate(930 800)">
          {[0, 1, 2, 3, 4, 5].map((i) => <path key={i} d={`M ${-(18 + i * 7)} 0 A ${18 + i * 7} ${18 + i * 7} 0 0 1 0 ${-(18 + i * 7)}`} />)}
          <text x={6} y={-54}>100</text><text x={6} y={-30}>50</text><text x={6} y={4}>0</text>
          <text x={-74} y={22} className="wr-key-t">more rings, further along</text>
        </g>
      </svg>
      <ul className="wr-list" aria-label="The Writing room's tools">
        {orbs.map((o) => (
          <li key={o.id}>
            <Link href={o.href} className={`wr-li t-${o.tone}`}>
              <svg viewBox="-40 -40 80 80" width={64} height={64} aria-hidden><Rings cx={0} cy={0} r0={23} gap={4} n={Math.min(5, ringsFor(o.value))} /><Marble tone={o.tone} seed={o.seed} r={19} n={10} /></svg>
              <span className="wr-li-t"><b>{o.name}</b><span className="small dim">{o.about}</span></span>
              <span className="wr-li-chip mono">{o.chip}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Inside a tool: the five orbs shrunk into a row of tabs, the open one lit. */
export function OrbRail({ orbs, on }: { orbs: OrbSpec[]; on: string }) {
  return (
    <nav className="wr-rail" aria-label="Writing room tools">
      {orbs.map((o) => (
        <Link key={o.id} href={o.href} scroll={false} className={`wr-rt t-${o.tone} ${o.id === on ? "on" : ""}`} aria-current={o.id === on ? "page" : undefined}>
          <svg viewBox="-30 -30 60 60" width={40} height={40} aria-hidden><Rings cx={0} cy={0} r0={17} gap={4} n={3} /><Marble tone={o.tone} seed={o.seed} r={13} n={8} /></svg>
          <span>{o.name}</span>
          {o.id === on && <span className="wr-rt-chip mono">{o.chip}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** A score as rings filling in: the tool views' big number (0 to 100). */
export function RingScore({ value, label, tone, sub }: { value: number; label: string; tone: Tone; sub?: string }) {
  const n = 9, lit = Math.round((Math.max(0, Math.min(100, value)) / 100) * n);
  return (
    <figure className={`wr-score t-${tone}`} aria-label={`${label}: ${value} out of 100${sub ? `, ${sub}` : ""}`}>
      <svg viewBox="-80 -80 160 160" aria-hidden>
        {Array.from({ length: n }, (_, i) => <circle key={i} r={34 + i * 5} className={i < lit ? "lit" : ""} style={{ transitionDelay: `${i * 40}ms` }} />)}
        <Marble tone={tone} seed={value / 7 + 1} r={28} n={10} />
      </svg>
      <figcaption><b className="mono">{value}</b><span>{label}</span>{sub && <span className="tiny dim">{sub}</span>}</figcaption>
    </figure>
  );
}
