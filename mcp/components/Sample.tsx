"use client";
// One shared <audio> for every audition button on the page: starting a sample stops the previous one.
import { Pause, Play } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type Samples } from "./api";

let audio: HTMLAudioElement | null = null;
let playing = "";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

let cache: Promise<Samples> | null = null;
/** Sample index with presigned URLs (fetched once per page load). */
export function useSamples() {
  const [s, setS] = useState<Samples | null>(null);
  useEffect(() => {
    cache ??= api<Samples>("samples").catch(() => ({ text: {}, voices: {} }));
    cache.then(setS);
  }, []);
  return s;
}

export function SampleButton({ url, id, size = 28, label }: { url?: string; id: string; size?: number; label?: string }) {
  const [, rerender] = useState(0);
  const [frac, setFrac] = useState(0);
  useEffect(() => {
    const f = () => rerender((x) => x + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  const on = playing === id;
  useEffect(() => {
    if (!on || !audio) return;
    let raf = 0;
    const tick = () => { setFrac(audio && audio.duration ? audio.currentTime / audio.duration : 0); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); setFrac(0); };
  }, [on]);
  if (!url) return <span className="sample-btn none" style={{ width: size, height: size }} title="No sample yet" />;
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (on) { audio?.pause(); playing = ""; emit(); return; }
    audio?.pause();
    audio = new Audio(url);
    playing = id;
    audio.onended = audio.onpause = () => { if (playing === id) { playing = ""; emit(); } };
    audio.play().catch(() => { playing = ""; emit(); });
    emit();
  };
  const r = size / 2 - 2, c = 2 * Math.PI * r;
  return (
    <span role="button" tabIndex={0} className={`sample-btn ${on ? "on" : ""}`} style={{ width: size, height: size }} onClick={toggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e as unknown as React.MouseEvent); } }}
      aria-label={`${on ? "Stop" : "Play"} ${label ?? "sample"}`} title={`${on ? "Stop" : "Hear"} ${label ?? "sample"}`}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden><circle cx={size / 2} cy={size / 2} r={r} className="ring" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} /></svg>
      {on ? <Pause size={size * 0.42} weight="fill" /> : <Play size={size * 0.42} weight="fill" />}
    </span>
  );
}
