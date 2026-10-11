"use client";
import { useEffect, useRef, useState } from "react";
import { clock, type Word } from "./api";

let current: HTMLAudioElement | null = null;

/** Custom audio player. With `words`, renders a karaoke transcript that follows playback (click a word to seek). */
export default function Player({ src, words, duration, onEnded, autoPlay, playRef }: {
  src: string; words?: Word[] | null; duration?: number; onEnded?: () => void; autoPlay?: boolean;
  playRef?: (fn: () => void) => void;
}) {
  const a = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(duration ?? 0);
  const [on, setOn] = useState(false);
  const raf = useRef(0);

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
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (dur) { a.current!.currentTime = ((e.clientX - r.left) / r.width) * dur; if (a.current!.paused) setT(a.current!.currentTime); }
  };
  const p = dur ? Math.min(100, (t / dur) * 100) : 0;

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="player">
        <audio ref={a} src={src} preload="none" />
        <button className={`pp ${on ? "on" : ""}`} onClick={toggle} aria-label={on ? "Pause" : "Play"}>
          {on ? <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="1" width="3" height="10" fill="currentColor" /><rect x="7" y="1" width="3" height="10" fill="currentColor" /></svg>
            : <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /></svg>}
        </button>
        <div className="track" onClick={seek}>
          <div className="rail" /><div className="fill" style={{ width: `${p}%` }} />{(on || t > 0) && <div className="knob" style={{ left: `${p}%` }} />}
        </div>
        <span className="t">{clock(t)} / {clock(dur)}</span>
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
