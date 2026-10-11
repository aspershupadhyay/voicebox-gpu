"use client";
// Hand-drawn SVG art for voicebox: logo, engine illustrations, voice portraits, style glyphs, meters, empty states.
// Everything is drawn with currentColor + CSS variables so it follows the theme.

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** The mark: a rounded tile holding five bars shaped like a spoken syllable. */
export function Logo({ size = 28 }: { size?: number }) {
  const bars = [0.38, 0.72, 1, 0.6, 0.3];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <defs>
        <linearGradient id="lg-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff7350" /><stop offset="1" stopColor="#e2401d" /></linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#lg-tile)" />
      <rect x=".5" y=".5" width="31" height="31" rx="8.5" fill="none" stroke="#fff" strokeOpacity=".22" />
      {bars.map((b, i) => {
        const h = 4 + b * 15;
        return <rect key={i} className="logo-bar" style={{ animationDelay: `${i * 0.11}s` }} x={7 + i * 4} y={16 - h / 2} width="2.4" height={h} rx="1.2" fill="#fff" />;
      })}
    </svg>
  );
}

const TONES = ["var(--signal)", "var(--glacier)", "var(--sand)", "var(--ok)", "var(--rose)"];

/** A generative "sound portrait" per voice: radial bars whose rhythm is seeded by the voice name. */
export function VoiceGlyph({ name, size = 40, active = false }: { name: string; size?: number; active?: boolean }) {
  const h = hash(name), r = rng(h);
  const tone = TONES[h % TONES.length];
  const n = 36, f1 = 2 + (h % 4), f2 = 5 + ((h >> 3) % 5), ph = r() * 6.28;
  const bars = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const v = 0.45 + 0.3 * Math.sin(a * f1 + ph) + 0.18 * Math.sin(a * f2) + r() * 0.12;
    return { a, v: Math.max(0.15, Math.min(1, v)) };
  });
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100" aria-hidden className={`vglyph ${active ? "on" : ""}`} style={{ color: tone }}>
      <circle r="49" fill="var(--raised)" stroke="var(--line2)" />
      <circle r="13" fill="currentColor" opacity=".16" />
      <circle r="5" fill="currentColor" />
      {bars.map(({ a, v }, i) => {
        const r0 = 17, r1 = 17 + v * 26;
        return <line key={i} x1={Math.cos(a) * r0} y1={Math.sin(a) * r0} x2={Math.cos(a) * r1} y2={Math.sin(a) * r1}
          stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" opacity={0.35 + v * 0.65} />;
      })}
    </svg>
  );
}

/** Engine illustrations. Orpheus = the mythic musician's lyre; Kokoro = "heart" (心); Chatterbox = speech + emotion dial; Whisper = captions being written. */
export function EngineArt({ engine, live = false }: { engine: string; live?: boolean }) {
  const cls = `eart ${live ? "live" : ""}`;
  if (engine === "orpheus") return (
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <path d="M38 70c-12-6-18-20-14-34 3-10 10-15 16-15 5 0 8 4 6 9" className="ink" />
      <path d="M82 70c12-6 18-20 14-34-3-10-10-15-16-15-5 0-8 4-6 9" className="ink" />
      <path d="M33 24h54" className="ink" strokeWidth="3" />
      <path d="M40 70h40M44 76h32" className="ink" />
      {[46, 53, 60, 67, 74].map((x, i) => <path key={x} d={`M${x} 26 L${x} 69`} className="string" style={{ animationDelay: `${i * 0.09}s` }} />)}
      <circle cx="60" cy="24" r="3.4" className="accent-fill" />
    </svg>
  );
  if (engine === "kokoro") return (
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <path d="M60 74C38 60 22 47 22 31c0-10 8-18 18-18 8 0 14 5 20 12 6-7 12-12 20-12 10 0 18 8 18 18 0 16-16 29-38 43z" className="ink" />
      <path d="M14 44h22l5-10 7 22 7-30 7 26 5-8h39" className="trace base" />
      <path d="M14 44h22l5-10 7 22 7-30 7 26 5-8h39" className="trace comet" />
      <circle cx="98" cy="44" r="3" className="accent-fill" />
    </svg>
  );
  if (engine === "chatterbox") return (
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <path d="M20 18h46a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8H38l-10 9v-9h-8a8 8 0 0 1-8-8V26a8 8 0 0 1 8-8z" className="ink dim-ink" />
      <path d="M50 32h48a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8h-6v9l-10-9H50a8 8 0 0 1-8-8V40a8 8 0 0 1 8-8z" className="ink panel-fill" />
      {[0.4, 0.8, 1, 0.65, 0.9, 0.5, 0.3].map((v, i) => (
        <path key={i} d={`M${56 + i * 6.5} ${50 - v * 9} V${50 + v * 9}`} className="bar" style={{ animationDelay: `${i * 0.08}s` }} />
      ))}
      <circle cx="26" cy="68" r="9" className="ink" /><path d="M26 68l5-5" className="accent-stroke" />
    </svg>
  );
  return (
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <path d="M14 26c8-8 14-8 22 0s14 8 22 0 14-8 22 0 14 8 22 0" className="trace soft" />
      <rect x="20" y="44" width="62" height="8" rx="4" className="cap" />
      <rect x="20" y="58" width="44" height="8" rx="4" className="cap" style={{ animationDelay: ".25s" }} />
      <rect x="68" y="58" width="10" height="8" rx="4" className="accent-fill cursor" />
      <text x="88" y="51" className="ts">00:12</text>
    </svg>
  );
}

/** Delivery style glyph: a little bar waveform whose envelope shows the energy of the read. */
export function StyleGlyph({ style, active = false }: { style: string; active?: boolean }) {
  const n = 30;
  const env = (i: number) => {
    const x = i / (n - 1);
    if (style === "narrator") return 0.28 + 0.22 * Math.sin(x * Math.PI * 2.2) ** 2;
    if (style === "tech") return 0.3 + 0.55 * Math.abs(Math.sin(x * Math.PI * 5.5)) * (0.75 + 0.25 * Math.sin(i * 1.7));
    if (style === "hype") return 0.25 + 0.75 * Math.abs(Math.sin(x * Math.PI * 7)) ** 0.6 * (0.6 + 0.4 * Math.sin(i * 2.3) ** 2);
    return 0.12 + 0.04 * Math.sin(i);
  };
  return (
    <svg viewBox={`0 0 ${n * 4} 32`} className={`sglyph ${active ? "on" : ""}`} aria-hidden preserveAspectRatio="none">
      {Array.from({ length: n }, (_, i) => {
        const h = Math.max(2, env(i) * 28);
        return <rect key={i} x={i * 4 + 0.6} y={16 - h / 2} width="2.2" height={h} rx="1.1" style={{ animationDelay: `${(i % 7) * 0.07}s` }} />;
      })}
    </svg>
  );
}

/** Segmented hardware meter (VRAM, levels). */
export function LedMeter({ value, segments = 24, label }: { value: number; segments?: number; label?: string }) {
  const lit = Math.round(Math.max(0, Math.min(1, value)) * segments);
  return (
    <div className="led" role="meter" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      {Array.from({ length: segments }, (_, i) => {
        const zone = i / segments < 0.7 ? "g" : i / segments < 0.88 ? "a" : "r";
        return <i key={i} className={`${zone} ${i < lit ? "on" : ""}`} />;
      })}
    </div>
  );
}

/** Empty library: a cassette waiting for its first take. */
export function CassetteArt() {
  return (
    <svg viewBox="0 0 220 140" className="illus" aria-hidden>
      <rect x="20" y="20" width="180" height="104" rx="12" className="ink panel-fill" />
      <rect x="36" y="34" width="148" height="30" rx="5" className="ink" />
      <path d="M48 45h70M48 53h46" className="ink faint" />
      <circle cx="74" cy="88" r="15" className="ink" /><circle cx="146" cy="88" r="15" className="ink" />
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <g key={a}><path d={`M74 88l${Math.cos((a * Math.PI) / 180) * 9} ${Math.sin((a * Math.PI) / 180) * 9}`} className="ink spoke" />
          <path d={`M146 88l${Math.cos((a * Math.PI) / 180) * 9} ${Math.sin((a * Math.PI) / 180) * 9}`} className="ink spoke" /></g>
      ))}
      <path d="M89 88h42" className="ink faint" />
      <path d="M62 124l10-14h76l10 14" className="ink" />
      <circle cx="174" cy="49" r="4" className="accent-fill" />
    </svg>
  );
}

/** Drop zone: caption cards rising off a waveform. */
export function CaptionArt() {
  return (
    <svg viewBox="0 0 220 120" className="illus" aria-hidden>
      {Array.from({ length: 44 }, (_, i) => {
        const v = 0.25 + 0.75 * Math.abs(Math.sin(i * 0.55) * Math.sin(i * 0.17 + 1));
        return <rect key={i} x={12 + i * 4.5} y={96 - v * 22} width="2.4" height={v * 22} rx="1.2" className="wbar" />;
      })}
      <g className="float">
        <rect x="46" y="22" width="128" height="22" rx="6" className="ink panel-fill" />
        <path d="M58 33h62" className="ink" /><path d="M126 33h20" className="accent-stroke" />
      </g>
      <g className="float" style={{ animationDelay: ".6s" }}>
        <rect x="64" y="52" width="92" height="18" rx="6" className="ink panel-fill" />
        <path d="M74 61h50" className="ink faint" />
      </g>
    </svg>
  );
}

/** Big login orb: concentric sound rings around the mark. */
export function Orb() {
  const r = rng(7);
  const n = 72;
  return (
    <svg viewBox="-110 -110 220 220" className="orb" aria-hidden>
      <defs>
        <radialGradient id="orb-glow"><stop offset="0" stopColor="#ff5a36" stopOpacity=".35" /><stop offset="1" stopColor="#ff5a36" stopOpacity="0" /></radialGradient>
      </defs>
      <circle r="108" fill="url(#orb-glow)" />
      {[46, 70, 94].map((rad, k) => <circle key={rad} r={rad} fill="none" stroke="var(--line2)" strokeDasharray={k === 1 ? "2 6" : undefined} />)}
      <g className="orb-spin">
        {Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2, v = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.31)) * (0.6 + r() * 0.4);
          return <line key={i} x1={Math.cos(a) * 50} y1={Math.sin(a) * 50} x2={Math.cos(a) * (50 + v * 18)} y2={Math.sin(a) * (50 + v * 18)}
            stroke={i % 9 === 0 ? "var(--signal)" : "var(--ink2)"} strokeOpacity={i % 9 === 0 ? 1 : 0.45} strokeWidth="2" strokeLinecap="round" />;
        })}
      </g>
      <circle cx="94" cy="0" r="3.5" fill="var(--glacier)" className="orb-sat" />
    </svg>
  );
}
