"use client";
// The voice-creation art: a flat disc with a waveform (one look per way of making a voice) and the dotted arc around
// it that runs from nothing to the best length of audio, with the minimum marked. The arc fills as samples come in.

export type OrbTone = "instant" | "pro" | "revoice";
const BARS = [0.28, 0.46, 0.7, 0.52, 0.9, 0.62, 1, 0.74, 0.5, 0.82, 0.58, 0.38, 0.24];

/** A flat disc with a waveform across it, one look per way of making a voice: light (instant), ink (professional),
 *  blue (re-voice). `level` (0-1, live mic loudness) makes the bars move; nothing loops on its own. */
export function Orb({ tone = "instant", size = 140, level = 0, live = false, dim = false, children }: {
  tone?: OrbTone; size?: number; level?: number; live?: boolean; dim?: boolean; children?: React.ReactNode;
}) {
  const bw = size * 0.035, gap = size * 0.028, w = BARS.length * bw + (BARS.length - 1) * gap;
  return (
    <div className={`orb-art ${tone} ${live ? "live" : ""} ${dim ? "dim" : ""}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {BARS.map((v, i) => {
          const amp = live ? 0.35 + Math.min(1, level * 1.6) * (0.65 + 0.35 * Math.sin(i * 1.7 + level * 9)) : 1;
          const h = Math.max(bw, size * 0.42 * v * amp);
          return <rect key={i} x={(size - w) / 2 + i * (bw + gap)} y={(size - h) / 2} width={bw} height={h} rx={bw / 2} />;
        })}
      </svg>
      {children && <div className="orb-art-mid">{children}</div>}
    </div>
  );
}

const fmtLen = (s: number) => (s >= 3600 ? `${+(s / 3600).toFixed(1)} hr${s >= 7200 ? "s" : ""}` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} sec`);

/** The dotted arc: from the left (nothing) over the top to the right (best). Dots up to `value` are ink; the minimum
 *  is a short tick. Labels under each end. Children (the orb) sit in the middle. */
export function Gauge({ min, best, value = 0, size = 200, children }: { min: number; best: number; value?: number; size?: number; children?: React.ReactNode }) {
  const n = 34, R = size / 2 - 6, cx = size / 2, cy = size / 2;
  const a0 = -205, a1 = 25; // degrees, 0 = right, -90 = top
  const at = (f: number) => { const t = ((a0 + (a1 - a0) * f) * Math.PI) / 180; return [Math.round((cx + R * Math.cos(t)) * 100) / 100, Math.round((cy + R * Math.sin(t)) * 100) / 100]; };
  const fill = Math.min(1, value / best);
  const [mx, my] = at(min / best);
  const ang = ((a0 + (a1 - a0) * (min / best)) * Math.PI) / 180;
  return (
    <div className="gauge" style={{ width: size }}>
      <div className="gauge-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          {Array.from({ length: n }, (_, i) => { const f = i / (n - 1); const [x, y] = at(f); return <circle key={i} cx={x} cy={y} r={f <= fill && value > 0 ? 1.9 : 1.4} className={f <= fill && value > 0 ? "on" : ""} />; })}
          <line x1={mx - Math.cos(ang) * 7} y1={my - Math.sin(ang) * 7} x2={mx + Math.cos(ang) * 5} y2={my + Math.sin(ang) * 5} className={`tick ${value >= min ? "met" : ""}`} />
        </svg>
        <div className="gauge-mid">{children}</div>
      </div>
      <div className="gauge-ends"><span><b>Min</b>{fmtLen(min)}</span><span><b>Best</b>{fmtLen(best)}</span></div>
    </div>
  );
}
