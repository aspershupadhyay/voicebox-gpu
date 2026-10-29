"use client";
// Radar's scope (Grow → Radar → Sweep), drawn like a field instrument: corner brackets, a dot-matrix core that turns in
// the middle, a beam that sweeps the rings and pings each topic as it passes, and mono readouts of real numbers only
// (sources answered, signals read, each topic's heat, fit and confidence). The angle says where a topic's signals came
// from (search, news, builders, social, video), the distance from the middle how good a bet it is (rings at the verdict
// lines: Go now 72, Strong 58, Maybe 44). Labels are laid out so they never sit on each other, a blip or the core: the
// ones that can't fit stay off (the list under the scope has every topic). The core, the beam and the pings are one
// canvas that only runs while it's on screen; with reduced motion it's drawn once.
import { useEffect, useMemo, useRef, useState } from "react";
import { SECTORS, type Blip, type Sector } from "@/lib/radar";

const R = 160, PAD = 34, RMIN = R * 0.29, RMAX = R * 0.95, CORE = R * 0.22, PERIOD = 7000;
const VB = R + PAD;
/** radius for a score: the closer to the middle, the better the bet */
const rOf = (score: number) => RMIN + ((100 - Math.max(0, Math.min(100, score))) / 100) * (RMAX - RMIN);
const SECTOR_A: Record<Sector, number> = Object.fromEntries(SECTORS.map((s, i) => [s.id, -90 + i * 72 + 36])) as Record<Sector, number>;
export const toneOf = (v: string) => (v === "Go now" ? "ok" : v === "Strong" ? "blue" : v === "Maybe" ? "warn" : "grey");
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type P = { b: Blip; x: number; y: number; s: number; a: number };
type Box = { x: number; y: number; w: number; h: number };
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const onCore = (b: Box) => { const nx = Math.max(b.x, Math.min(0, b.x + b.w)), ny = Math.max(b.y, Math.min(0, b.y + b.h)); return Math.hypot(nx, ny) < CORE + 4; };

/** Each topic in its sector at its score's distance, then pushed apart until no two squares touch. */
function place(blips: Blip[]): P[] {
  const ps = blips.map((b) => {
    const h = hash(b.topic);
    const a = ((SECTOR_A[b.sector ?? "news"] ?? 0) + ((h % 1000) / 1000 - 0.5) * 56) * (Math.PI / 180);
    const r = rOf(b.score);
    return { b, x: Math.cos(a) * r, y: Math.sin(a) * r, s: 6 + Math.min(100, b.heat) / 20, a: 0 };
  });
  for (let it = 0; it < 60; it++) {
    let moved = false;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const p = ps[i], q = ps[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 0.01, need = (p.s + q.s) / 2 + 7;
      if (d >= need) continue;
      const k = (need - d) / 2 / d;
      p.x -= dx * k; p.y -= dy * k; q.x += dx * k; q.y += dy * k; moved = true;
    }
    for (const p of ps) { const d = Math.hypot(p.x, p.y) || 1, c = Math.max(RMIN, Math.min(RMAX, d)); p.x *= c / d; p.y *= c / d; }
    if (!moved) break;
  }
  for (const p of ps) p.a = Math.atan2(p.y, p.x);
  return ps;
}

/** Labels for the selected topic, the hovered one and the best others, each where it touches nothing. */
function labels(ps: P[], on: string | null, hover: string | null, max = 7) {
  const order = [...ps].sort((a, b) => (a.b.topic === on ? -2 : a.b.topic === hover ? -1 : 0) - (b.b.topic === on ? -2 : b.b.topic === hover ? -1 : 0) || b.b.score - a.b.score);
  const squares: (Box & { t: string })[] = ps.map((p) => ({ t: p.b.topic, x: p.x - p.s / 2 - 2, y: p.y - p.s / 2 - 2, w: p.s + 4, h: p.s + 4 }));
  const ringTags: Box[] = [72, 58, 44].map((v) => ({ x: 2, y: -rOf(v) - 11, w: 46, h: 12 }));
  const out: (Box & { p: P; text: string })[] = [];
  for (const p of order) {
    const special = p.b.topic === on || p.b.topic === hover;
    if (!special && out.length >= max) continue;
    const text = clip(p.b.topic, special ? 30 : 22);
    const w = text.length * 5.6 + 10, h = 15, g = p.s / 2 + 4;
    const tries: [number, number][] = p.x >= 0
      ? [[g, -h / 2], [-g - w, -h / 2], [-w / 2, -g - h], [-w / 2, g], [g - 2, -g - h + 2], [g - 2, g - 2]]
      : [[-g - w, -h / 2], [g, -h / 2], [-w / 2, -g - h], [-w / 2, g], [-g - w + 2, -g - h + 2], [-g - w + 2, g - 2]];
    const box = tries.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy, w, h })).find((bx) =>
      bx.x >= -VB && bx.x + bx.w <= VB && bx.y >= -VB && bx.y + bx.h <= VB && !onCore(bx)
      && !squares.some((sq) => sq.t !== p.b.topic && hit(bx, sq)) && !out.some((o) => hit(bx, o)) && !ringTags.some((r) => hit(bx, r)));
    if (box) out.push({ ...box, p, text });
  }
  return out;
}

type Ink = { ink: string; live: string; ok: string; blue: string; warn: string; grey: string };
const TONE_KEY: Record<string, keyof Ink> = { ok: "ok", blue: "blue", warn: "warn", grey: "grey" };

/** Points of the turning core: a dot sphere with four lattice arms that fold as it turns. */
function corePoints() {
  const pts: [number, number, number, number][] = [];
  const n = 260, rs = CORE * 0.52;
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    pts.push([Math.cos(th) * r * rs, y * rs, Math.sin(th) * r * rs, 0]);
  }
  for (let arm = 0; arm < 4; arm++) for (let u = 0; u < 7; u++) for (let v = 0; v < 4; v++) {
    const along = rs * 0.9 + u * (CORE * 0.11), across = (v - 1.5) * (CORE * 0.12);
    pts.push([along, across, 0, arm + 1]);
  }
  return pts;
}

function useInk(ref: React.RefObject<HTMLElement | null>) {
  const [ink, setInk] = useState<Ink | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const cs = getComputedStyle(ref.current), g = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
    setInk({ ink: g("--ink", "#f2f2f0"), live: g("--live", "#4ade80"), ok: g("--ok", "#7fd6a1"), blue: g("--blue", "#93b4f6"), warn: g("--warn", "#e9b765"), grey: g("--grey", "#bdbdb6") });
  }, [ref]);
  return ink;
}

export function RadarScope({ blips, on, pick, status }: { blips: Blip[]; on: string | null; pick: (t: string) => void; status: string[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const ps = useMemo(() => place(blips), [blips]);
  const ls = useMemo(() => labels(ps, on, hover), [ps, on, hover]);
  const ink = useInk(wrap);
  const live = useRef({ ps, on });
  live.current = { ps, on };
  const counts = useMemo(() => Object.fromEntries(SECTORS.map((s) => [s.id, blips.filter((b) => (b.sector ?? "news") === s.id).length])), [blips]);

  // the canvas: core, beam and pings, only while visible
  useEffect(() => {
    const c = cv.current;
    if (!c || !ink) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const pts = corePoints();
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, seen = true, t0 = performance.now();
    const size = () => {
      const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
      c.width = Math.round(r.width * d); c.height = Math.round(r.height * d);
    };
    size();
    const ro = new ResizeObserver(size); ro.observe(c);
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; if (seen && !still) { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); } }, { threshold: 0.05 });
    io.observe(c);
    const alpha = (hex: string, a: number) => { ctx.globalAlpha = a; ctx.fillStyle = hex; ctx.strokeStyle = hex; };
    function frame(now: number) {
      const t = now - t0, k = c!.width / (2 * VB);
      ctx!.setTransform(k, 0, 0, k, c!.width / 2, c!.height / 2);
      ctx!.clearRect(-VB, -VB, 2 * VB, 2 * VB);
      // the beam: one bright line and a fading trail of thin ones (flat strokes, no gradient)
      const beam = ((t % PERIOD) / PERIOD) * Math.PI * 2;
      ctx!.lineWidth = 1;
      for (let i = 0; i < 26; i++) {
        const a = beam - i * 0.028;
        alpha(ink!.live, i === 0 ? 0.95 : 0.34 * (1 - i / 26));
        ctx!.beginPath(); ctx!.moveTo(Math.cos(a) * CORE, Math.sin(a) * CORE); ctx!.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx!.stroke();
      }
      // pings: a ring opens on each topic as the beam passes over it
      for (const p of live.current.ps) {
        let since = beam - (p.a < 0 ? p.a + Math.PI * 2 : p.a);
        if (since < 0) since += Math.PI * 2;
        const f = since / (Math.PI * 2);
        if (f > 0.22) continue;
        const e = f / 0.22;
        alpha(ink![TONE_KEY[toneOf(p.b.verdict)]], (1 - e) * 0.8);
        ctx!.lineWidth = 1;
        ctx!.beginPath(); ctx!.arc(p.x, p.y, p.s / 2 + 2 + e * 14, 0, Math.PI * 2); ctx!.stroke();
      }
      // the core: a dot sphere and four arms, turning and folding
      const yaw = t / 5200, pitch = 0.55 + Math.sin(t / 4100) * 0.35, fold = Math.sin(t / 2600) * 0.9;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (const [x0, y0, z0, arm] of pts) {
        let x = x0, y = y0, z = z0;
        if (arm) {
          // each arm leaves the sphere at its own quarter turn, tipped by the fold
          const q = (arm - 1) * (Math.PI / 2), cf = Math.cos(fold * (arm % 2 ? 1 : -1)), sf = Math.sin(fold * (arm % 2 ? 1 : -1));
          const yz = y * cf - z * sf, zz = y * sf + z * cf;
          const ax = x * Math.cos(q) - yz * Math.sin(q), ay = x * Math.sin(q) + yz * Math.cos(q);
          x = ax; y = ay; z = zz;
        }
        const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
        const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
        const depth = (z2 / (CORE * 0.9) + 1) / 2;
        alpha(ink!.ink, 0.18 + depth * 0.62);
        const d = arm ? 1.1 : 0.9 + depth * 0.7;
        ctx!.fillRect(x1 - d / 2, y2 - d / 2, d, d);
      }
      ctx!.globalAlpha = 1;
      if (!still && seen && document.visibilityState === "visible") raf = requestAnimationFrame(frame);
    }
    const vis = () => { if (document.visibilityState === "visible" && seen && !still) { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); } };
    document.addEventListener("visibilitychange", vis);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); document.removeEventListener("visibilitychange", vis); };
  }, [ink]);

  // the status line in the top corner turns through the real numbers
  const [line, setLine] = useState(0);
  useEffect(() => { if (status.length < 2) return; const t = setInterval(() => setLine((x) => (x + 1) % status.length), 2800); return () => clearInterval(t); }, [status.length]);

  return (
    <div className="rd-hud" ref={wrap}>
      <span className="rd-hud-c tl" aria-hidden /><span className="rd-hud-c tr" aria-hidden /><span className="rd-hud-c bl" aria-hidden /><span className="rd-hud-c br" aria-hidden />
      <div className="rd-hud-tag mono" aria-hidden><span>LANE</span><span>SCAN</span></div>
      <div className="rd-hud-ind" aria-hidden><i /></div>
      <div className="rd-hud-status mono" aria-live="off" key={line}>{status[line] ?? ""}</div>
      <div className="rd-scope">
        <canvas ref={cv} className="rd-cv" aria-hidden />
        <svg viewBox={`${-VB} ${-VB} ${2 * VB} ${2 * VB}`} role="group" aria-label="Topics on the radar: nearer the middle is a better bet">
          <circle r={R} className="rd-ring outer" />
          {[72, 58, 44].map((v) => <circle key={v} r={rOf(v)} className={`rd-ring v${v}`} />)}
          <circle r={CORE} className="rd-ring core" />
          {SECTORS.map((s, i) => { const a = ((-90 + i * 72) * Math.PI) / 180; return <line key={s.id} x1={Math.cos(a) * CORE} y1={Math.sin(a) * CORE} x2={Math.cos(a) * R} y2={Math.sin(a) * R} className="rd-axis" />; })}
          {SECTORS.map((s) => {
            const a = (SECTOR_A[s.id] * Math.PI) / 180, x = Math.cos(a) * (R + 14), y = Math.sin(a) * (R + 14);
            return <text key={s.id} x={x} y={y + 3} textAnchor={Math.abs(x) < 20 ? "middle" : x > 0 ? "start" : "end"} className="rd-sec mono">{s.name.toUpperCase()} {String(counts[s.id] ?? 0).padStart(2, "0")}</text>;
          })}
          {([[72, "GO NOW"], [58, "STRONG"], [44, "MAYBE"]] as const).map(([v, t]) => <text key={v} x={4} y={-rOf(v) - 3} className={`rd-ring-l mono v${v}`}>{t}</text>)}
          {ps.map((p) => {
            const sel = on === p.b.topic;
            return (
              <g key={p.b.topic} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} className={`rd-blip t-${toneOf(p.b.verdict)} ${sel ? "on" : ""}`} tabIndex={0} role="button"
                aria-label={`${p.b.topic}: ${p.b.verdict}, score ${p.b.score}, heat ${p.b.heat}, fit ${p.b.fit}`} aria-pressed={sel}
                onClick={() => pick(p.b.topic)} onMouseEnter={() => setHover(p.b.topic)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(p.b.topic)} onBlur={() => setHover(null)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(p.b.topic); } }}>
                <rect className="rd-hitbox" x={-11} y={-11} width={22} height={22} />
                <rect className="rd-sq" x={-p.s / 2} y={-p.s / 2} width={p.s} height={p.s} />
                {sel && <rect className="rd-sel" x={-p.s / 2 - 4} y={-p.s / 2 - 4} width={p.s + 8} height={p.s + 8} />}
              </g>
            );
          })}
          {ls.map((l) => (
            <g key={l.p.b.topic} className={`rd-lab ${l.p.b.topic === on ? "on" : ""}`} aria-hidden>
              <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={3} />
              <text x={l.x + 5} y={l.y + 10.5}>{l.text}</text>
            </g>
          ))}
        </svg>
      </div>
      <ol className="rd-readout mono" aria-label="Best topics, as numbers">
        {[...blips].sort((a, b) => b.score - a.score).slice(0, 5).map((b, i) => (
          <li key={b.topic} className={b.topic === on ? "on" : ""} style={{ animationDelay: `${i * 70}ms` }}>
            <button type="button" onClick={() => pick(b.topic)}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <span>H{String(b.heat).padStart(3, "0")}</span><span>F{String(b.fit).padStart(3, "0")}</span>
              <span className="hide-sm">C:{(b.conf ?? "medium")[0].toUpperCase()}</span><span className="hide-sm">S{String(b.sources.length).padStart(2, "0")}</span>
              <span className="ellipsis">{b.topic}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
