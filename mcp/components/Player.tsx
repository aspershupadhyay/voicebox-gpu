"use client";
import { Pause, Play } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { clock, type Word } from "./api";

let current: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
const PEAKS = new Map<string, Promise<number[] | null>>();
const BARS = 96;

/** Decode once per URL (cached), reduce to BARS peak heights 0..1. Null when the audio can't be fetched/decoded. */
function peaksFor(src: string): Promise<number[] | null> {
  const key = src.split("?")[0];
  if (!PEAKS.has(key)) {
    PEAKS.set(key, (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer();
        ctx ??= new AudioContext();
        const audio = await ctx.decodeAudioData(buf);
        const d = audio.getChannelData(0), step = Math.max(1, Math.floor(d.length / BARS));
        const out = Array.from({ length: BARS }, (_, i) => {
          let m = 0;
          for (let k = i * step, e = Math.min(d.length, k + step); k < e; k += 4) m = Math.max(m, Math.abs(d[k]));
          return m;
        });
        const top = Math.max(...out, 1e-4);
        return out.map((v) => Math.max(0.04, Math.sqrt(v / top)));
      } catch {
        return null;
      }
    })());
  }
  return PEAKS.get(key)!;
}

/** Audio player drawn as the real waveform (click/drag to scrub). With `words`, a karaoke transcript follows playback. */
const secs = (s: number, short: boolean) => (short ? `${s.toFixed(1)}s` : clock(s));

/** `scale` (0..1) draws the waveform proportionally to the longest clip in its group, so lengths compare at a glance. */
export default function Player({ src, words, duration, onEnded, autoPlay, playRef, compact, scale = 1 }: {
  src: string; words?: Word[] | null; duration?: number; onEnded?: () => void; autoPlay?: boolean;
  playRef?: (fn: () => void) => void; compact?: boolean; scale?: number;
}) {
  const a = useRef<HTMLAudioElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(duration ?? 0);
  const [on, setOn] = useState(false);
  const [peaks, setPeaks] = useState<number[] | null | undefined>(undefined);
  const [hover, setHover] = useState<number | null>(null);
  const raf = useRef(0);
  const clip = `wclip-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  // decode lazily, when the player scrolls into view
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { io.disconnect(); peaksFor(src).then(setPeaks); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [src]);

  useEffect(() => {
    const el = a.current!;
    const tick = () => { setT(el.currentTime); raf.current = requestAnimationFrame(tick); };
    const play = () => { if (current && current !== el) current.pause(); current = el; setOn(true); raf.current = requestAnimationFrame(tick); };
    const pause = () => { setOn(false); cancelAnimationFrame(raf.current); setT(el.currentTime); };
    const end = () => { pause(); setT(0); onEnded?.(); };
    const meta = () => isFinite(el.duration) && setDur(el.duration);
    el.addEventListener("play", play); el.addEventListener("pause", pause); el.addEventListener("ended", end); el.addEventListener("loadedmetadata", meta);
    return () => { el.removeEventListener("play", play); el.removeEventListener("pause", pause); el.removeEventListener("ended", end); el.removeEventListener("loadedmetadata", meta); cancelAnimationFrame(raf.current); };
  }, [onEnded]);
  useEffect(() => { if (autoPlay) a.current?.play().catch(() => {}); }, [autoPlay]);
  useEffect(() => { playRef?.(() => { if (a.current) { a.current.currentTime = 0; a.current.play().catch(() => {}); } }); }, [playRef]);

  const toggle = () => (a.current!.paused ? a.current!.play().catch(() => {}) : a.current!.pause());
  const frac = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const seekTo = (f: number) => { if (dur) { a.current!.currentTime = f * dur; if (a.current!.paused) setT(a.current!.currentTime); } };
  const p = dur ? Math.min(1, t / dur) : 0;
  const bars = peaks ?? Array.from({ length: BARS }, (_, i) => 0.12 + 0.06 * Math.sin(i * 0.7));

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className={`player ${compact ? "compact" : ""}`}>
        <audio ref={a} src={src} preload="none" />
        <button className={`pp ${on ? "on" : ""}`} onClick={toggle} aria-label={on ? "Pause" : "Play"}>
          {on ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
        </button>
        <div className="wave-lane"><div ref={box} className={`wave ${peaks === undefined ? "loading" : ""}`} style={{ width: `${Math.max(18, Math.min(1, scale) * 100)}%` }} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(t)} tabIndex={0}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekTo(frac(e)); }}
          onPointerMove={(e) => { setHover(frac(e)); if (e.buttons) seekTo(frac(e)); }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => { if (e.key === "ArrowRight") seekTo(Math.min(1, p + 0.05)); if (e.key === "ArrowLeft") seekTo(Math.max(0, p - 0.05)); if (e.key === " ") { e.preventDefault(); toggle(); } }}>
          <svg viewBox={`0 0 ${BARS * 3} 40`} preserveAspectRatio="none">
            <defs><clipPath id={clip}><rect width={p * BARS * 3} height="40" /></clipPath></defs>
            <g className="w-dim">{bars.map((v, i) => <rect key={i} x={i * 3} y={20 - v * 19} width="1.9" height={Math.max(1, v * 38)} />)}</g>
            <g className="w-on" clipPath={`url(#${clip})`}>{bars.map((v, i) => <rect key={i} x={i * 3} y={20 - v * 19} width="1.9" height={Math.max(1, v * 38)} />)}</g>
          </svg>
          {(on || t > 0) && <i className="head" style={{ left: `${p * 100}%` }} />}
          {hover != null && dur > 0 && <span className="tip" style={{ left: `${hover * 100}%` }}>{secs(hover * dur, dur < 60)}</span>}
        </div></div>
        <span className="t">{secs(t, dur < 60)}<b>/</b>{secs(dur, dur < 60)}</span>
      </div>
      {words && words.length > 0 && (
        <div className="words">
          {words.map((w, i) => (
            <span key={i} className={t >= w.s && t < w.e + 0.05 ? "cur" : t >= w.e ? "past" : ""}
              onClick={() => { a.current!.currentTime = w.s; a.current!.play().catch(() => {}); }}>{w.w}</span>
          )).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, " ", el] : [el]), [])}
        </div>
      )}
    </div>
  );
}
