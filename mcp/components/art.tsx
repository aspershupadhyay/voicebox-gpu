"use client";
// Hand-drawn SVG art for voicebox: logo, engine illustrations, voice portraits, style glyphs, meters, empty states.
// Everything is drawn with currentColor + CSS variables so it follows the theme.
import { useId } from "react";

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** The mark: a box (the "box" in Voicebox) with five bars hanging from its lid, a waveform whose lower edge draws a V.
 *  The middle bar is the one live accent; on hover the bars talk. */
export function Logo({ size = 28 }: { size?: number }) {
  const bars = [15, 11, 6.5, 11, 15];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <rect width="32" height="32" rx="9" fill="var(--ink)" />
      <rect x="6" y="6.4" width="20" height="1.6" rx=".8" fill="var(--on-ink)" opacity=".38" />
      {bars.map((h, i) => (
        <rect key={i} className="logo-bar" style={{ animationDelay: `${i * 0.12}s` }} x={7.2 + i * 3.9} y="9.6" width="2.3" height={h} rx="1.15"
          fill={i === 2 ? "var(--accent)" : "var(--on-ink)"} />
      ))}
    </svg>
  );
}

/** Two decimals: the server and the browser disagree on the last float digits of trig results (hydration warnings). */
const q2 = (n: number) => Math.round(n * 100) / 100;

/** A voice's portrait: radial bars whose rhythm is seeded by the voice name (every voice has its own, the same
 *  everywhere), in graphite, around the voice's initial set in the serif. The live voice turns emerald and breathes. */
export function VoiceGlyph({ name, size = 40, active = false }: { name: string; size?: number; active?: boolean }) {
  const label = (name || "voice").replace(/^(ft_|kv_|[a-z]{2}_)/i, "");
  const h = hash(name || "voice"), r = rng(h);
  const n = 40, f1 = 2 + (h % 4), f2 = 5 + ((h >> 3) % 5), ph = r() * 6.28;
  const bars = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const v = 0.45 + 0.3 * Math.sin(a * f1 + ph) + 0.18 * Math.sin(a * f2) + r() * 0.12;
    return { a, v: Math.max(0.12, Math.min(1, v)) };
  });
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100" aria-hidden className={`vglyph ${active ? "on" : ""}`}>
      <circle r="49" fill="var(--raised)" stroke="var(--line2)" />
      <g className="vg-bars">
        {bars.map(({ a, v }, i) => {
          const r0 = 22, r1 = 22 + v * 23;
          return <line key={i} x1={q2(Math.cos(a) * r0)} y1={q2(Math.sin(a) * r0)} x2={q2(Math.cos(a) * r1)} y2={q2(Math.sin(a) * r1)}
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity={q2(0.25 + v * 0.75)} />;
        })}
      </g>
      <circle r="17" fill="var(--surface)" stroke="var(--line)" />
      <text y="7.5" textAnchor="middle" className="vg-initial">{label.charAt(0).toUpperCase()}</text>
    </svg>
  );
}

/** Engine illustrations. Orpheus = the mythic musician's lyre; Kokoro = "heart" (心); Chatterbox = speech + emotion dial;
 *  Qwen = your voice mirrored into its clone; Wan = a subject in motion over a timeline; LTX = film strip + its soundtrack; Whisper = captions. */
export function EngineArt({ engine, live = false }: { engine: string; live?: boolean }) {
  const cls = `eart ${live ? "live" : ""}`;
  if (engine === "myvoice") return <VoiceGlyph name="myvoice" size={64} active={live} />;
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
  if (engine === "qwen") return (
    // your voice, copied: the recorded waveform on the left is mirrored into the clone on the right
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <rect x="51" y="12" width="18" height="34" rx="9" className="ink" />
      <path d="M45 36a15 15 0 0 0 30 0M60 51v12M50 66h20" className="ink" />
      {[0.35, 0.7, 0.5, 0.9, 0.45].map((v, i) => <path key={`l${i}`} d={`M${16 + i * 6} ${38 - v * 13}V${38 + v * 13}`} className="bar dim-bar" style={{ animationDelay: `${i * 0.1}s` }} />)}
      {[0.45, 0.9, 0.5, 0.7, 0.35].map((v, i) => <path key={`r${i}`} d={`M${80 + i * 6} ${38 - v * 13}V${38 + v * 13}`} className="bar" style={{ animationDelay: `${(4 - i) * 0.1}s` }} />)}
      <circle cx="60" cy="24" r="2.6" className="accent-fill" />
    </svg>
  );
  if (engine === "wan" || engine === "wan14") return (
    // a frame with a subject in motion (ghosted trail) over a timeline with a playhead
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <rect x="16" y="10" width="88" height="52" rx="6" className="ink" />
      <path d="M16 50l22-16 16 10 18-18 32 26" className="ink dim-ink" />
      {[0, 1, 2].map((i) => <circle key={i} cx={46 + i * 13} cy={28 - i * 2} r={5} className="trail" style={{ opacity: 0.25 + i * 0.3, animationDelay: `${i * 0.12}s` }} />)}
      <path d="M16 72h88" className="ink dim-ink" />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => <path key={i} d={`M${16 + i * 11} 69v6`} className="ink dim-ink" />)}
      <path d="M66 66v12" className="accent-stroke playhead" />
    </svg>
  );
  if (engine === "zimage" || engine === "qwenimage") return (
    // a picture developing: frame, sun, hills, and a light sweeping across it
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <rect x="22" y="8" width="76" height="68" rx="6" className="ink" />
      <circle cx="74" cy="28" r="7" className="accent-fill" />
      <path d="M22 64l20-20 14 12 16-18 26 26" className="ink dim-ink" />
      {[0, 1, 2].map((i) => <rect key={i} x={30 + i * 22} y="70" width="14" height="3" rx="1.5" className="cap" style={{ animationDelay: `${i * 0.2}s` }} />)}
    </svg>
  );
  if (engine === "animate") return (
    // a stick figure copying a ghosted pose
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <g className="ink dim-ink"><circle cx="38" cy="18" r="6" /><path d="M38 24v22M38 30l-12 8M38 30l12-6M38 46l-10 18M38 46l10 18" /></g>
      <g className="ink"><circle cx="82" cy="18" r="6" /><path d="M82 24v22M82 30l-12 8M82 30l12-6M82 46l-10 18M82 46l10 18" /></g>
      {[0, 1, 2].map((i) => <circle key={i} cx={52 + i * 8} cy={40} r={2.2} className="trail" style={{ opacity: 0.3 + i * 0.3, animationDelay: `${i * 0.12}s` }} />)}
    </svg>
  );
  if (engine === "ltx") return (
    // picture and sound born together: a film strip above its own soundtrack
    <svg viewBox="0 0 120 84" className={cls} aria-hidden>
      <rect x="12" y="10" width="96" height="34" rx="4" className="ink" />
      {Array.from({ length: 10 }, (_, i) => <rect key={`p${i}`} x={16 + i * 9.4} y="12.5" width="4" height="3" rx="1" className="perf" />)}
      {Array.from({ length: 10 }, (_, i) => <rect key={`q${i}`} x={16 + i * 9.4} y="38.5" width="4" height="3" rx="1" className="perf" />)}
      {[0, 1, 2, 3].map((i) => <rect key={i} x={17 + i * 23} y="19" width="19" height="16" rx="2" className="cap" style={{ animationDelay: `${i * 0.18}s` }} />)}
      <path d="M12 62c5-9 8 9 13 0s8-12 13 0 8 10 13 0 8-14 13 0 8 8 13 0 8-10 13 0 8 6 10 0" className="trace base" />
      <path d="M12 62c5-9 8 9 13 0s8-12 13 0 8 10 13 0 8-14 13 0 8 8 13 0 8-10 13 0 8 6 10 0" className="trace comet" />
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
        const h = q2(Math.max(2, env(i) * 28));
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
        <g key={a}><path d={`M74 88l${q2(Math.cos((a * Math.PI) / 180) * 9)} ${q2(Math.sin((a * Math.PI) / 180) * 9)}`} className="ink spoke" />
          <path d={`M146 88l${q2(Math.cos((a * Math.PI) / 180) * 9)} ${q2(Math.sin((a * Math.PI) / 180) * 9)}`} className="ink spoke" /></g>
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
        return <rect key={i} x={q2(12 + i * 4.5)} y={q2(96 - v * 22)} width="2.4" height={q2(v * 22)} rx="1.2" className="wbar" />;
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
      {[46, 70, 94].map((rad, k) => <circle key={rad} r={rad} fill="none" stroke="var(--line2)" strokeDasharray={k === 1 ? "2 6" : undefined} />)}
      <g className="orb-spin">
        {Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2, v = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.31)) * (0.6 + r() * 0.4);
          return <line key={i} x1={q2(Math.cos(a) * 50)} y1={q2(Math.sin(a) * 50)} x2={q2(Math.cos(a) * (50 + v * 18))} y2={q2(Math.sin(a) * (50 + v * 18))}
            stroke={i % 9 === 0 ? "var(--signal)" : "var(--ink2)"} strokeOpacity={i % 9 === 0 ? 1 : 0.45} strokeWidth="2" strokeLinecap="round" />;
        })}
      </g>
      <circle cx="94" cy="0" r="3.5" fill="var(--signal)" className="orb-sat" />
    </svg>
  );
}

/** Empty video state: a clapperboard with a frame waiting to be shot. */
export function ClapperArt() {
  return (
    <svg viewBox="0 0 220 140" className="illus" aria-hidden>
      <rect x="44" y="52" width="132" height="72" rx="8" className="ink" />
      <path d="M44 52l6-24 130 0-6 24" className="ink" />
      {[0, 1, 2, 3, 4].map((i) => <path key={i} d={`M${62 + i * 24} 28l-8 24`} className="ink faint" />)}
      <path d="M84 74l34 14-34 14z" className="accent-fill float" />
      <path d="M150 74h12M150 84h8" className="ink faint" />
    </svg>
  );
}

/** Recorder idle state: a studio mic with sound rings. */
export function MicArt() {
  return (
    <svg viewBox="0 0 220 140" className="illus" aria-hidden>
      <rect x="92" y="22" width="36" height="62" rx="18" className="ink" />
      {[0, 1, 2, 3].map((i) => <path key={i} d={`M92 ${38 + i * 10}h36`} className="ink faint" />)}
      <path d="M80 66a30 30 0 0 0 60 0M110 96v20M92 118h36" className="ink" />
      <path d="M62 46a52 52 0 0 0 0 40M158 46a52 52 0 0 1 0 40" className="ink faint float" />
      <path d="M48 36a72 72 0 0 0 0 60M172 36a72 72 0 0 1 0 60" className="ink faint float" style={{ animationDelay: ".4s" }} />
      <circle cx="110" cy="40" r="4" className="accent-fill" />
    </svg>
  );
}
