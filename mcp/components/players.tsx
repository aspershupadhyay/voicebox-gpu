"use client";
// The big players for the file viewer and the Library: a video player with its own controls (they fade while it plays;
// buffered ranges on the scrubber, a time bubble, speed, picture-in-picture, fullscreen, double-tap to skip on phones,
// and it picks up where you left off) and an audio stage drawn as the file's real waveform. Video streams: the browser
// asks storage for byte ranges, so it starts after the first few seconds arrive and seeks without downloading the rest.
import {
  ArrowClockwise, ArrowCounterClockwise, CornersIn, CornersOut, Gauge, Pause, PictureInPicture, Play, Repeat, SpeakerHigh, SpeakerLow, SpeakerSlash,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { peaksFor } from "./Player";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const clock = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const pref = { get: (k: string, d: number) => { try { const v = Number(localStorage.getItem(k)); return localStorage.getItem(k) == null || !isFinite(v) ? d : v; } catch { return d; } },
  set: (k: string, v: number) => { try { localStorage.setItem(k, String(v)); } catch {} } };
/** Keys a player shouldn't take: typing in a field, or Space/Enter on a focused button or link. */
const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return (t as HTMLInputElement).type !== "range" || e.key.startsWith("Arrow");
  return (e.key === " " || e.key === "Enter") && !!t.closest("button, a");
};

/** Scrubber: played, buffered and a hover bubble; drag with mouse, finger or pen, arrow keys when focused. */
function Scrub({ t, dur, buffered, onSeek, label }: { t: number; dur: number; buffered: [number, number][]; onSeek: (s: number, final: boolean) => void; label: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const at = (x: number) => { const r = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)) * (dur || 0); };
  const shown = drag ?? t;
  const pct = (s: number) => `${dur ? (s / dur) * 100 : 0}%`;
  return (
    <div className="vp-scrub" ref={bar} role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(shown)} aria-valuetext={`${clock(shown)} of ${clock(dur)}`}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); const s = at(e.clientX); setDrag(s); onSeek(s, false); }}
      onPointerMove={(e) => { const s = at(e.clientX); setHover(s); if (drag !== null) { setDrag(s); onSeek(s, false); } }}
      onPointerUp={(e) => { if (drag !== null) { onSeek(at(e.clientX), true); setDrag(null); } }}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); onSeek(Math.max(0, Math.min(dur, t + (e.key === "ArrowLeft" ? -5 : 5))), true); }
        if (e.key === "Home") { e.preventDefault(); onSeek(0, true); }
        if (e.key === "End") { e.preventDefault(); onSeek(dur, true); }
      }}>
      <div className="vp-track">
        {buffered.map(([a, b], i) => <i key={i} className="vp-buf" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} />)}
        {hover !== null && <i className="vp-hov" style={{ width: pct(hover) }} />}
        <i className="vp-played" style={{ width: pct(shown) }} />
        <i className="vp-knob" style={{ left: pct(shown) }} />
      </div>
      {(hover !== null || drag !== null) && <span className="vp-bubble" style={{ left: pct(drag ?? hover ?? 0) }}>{clock(drag ?? hover ?? 0)}</span>}
    </div>
  );
}

function SpeedMenu({ rate, set, up = true }: { rate: number; set: (r: number) => void; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close, true);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", close, true); };
  }, [open]);
  return (
    <div className="vp-speed" ref={box}>
      <button className="vp-btn" onClick={() => setOpen((o) => !o)} aria-label={`Speed ${rate}×`} aria-expanded={open} aria-haspopup="menu" title="Speed">
        {rate === 1 ? <Gauge size={20} /> : <b className="vp-rate">{rate}×</b>}
      </button>
      {open && (
        <div className={`vp-menu ${up ? "up" : ""}`} role="menu">
          {SPEEDS.map((s) => <button key={s} role="menuitemradio" aria-checked={s === rate} className={s === rate ? "on" : ""} onClick={() => { set(s); setOpen(false); }}>{s === 1 ? "Normal" : `${s}×`}</button>)}
        </div>
      )}
    </div>
  );
}

function Volume({ el, vol, muted }: { el: () => HTMLMediaElement | null; vol: number; muted: boolean }) {
  const Ic = muted || vol === 0 ? SpeakerSlash : vol < 0.5 ? SpeakerLow : SpeakerHigh;
  return (
    <div className="vp-vol">
      <button className="vp-btn" onClick={() => { const v = el(); if (v) v.muted = !v.muted; }} aria-label={muted ? "Unmute (M)" : "Mute (M)"} title={muted ? "Unmute (M)" : "Mute (M)"}><Ic size={20} /></button>
      <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : vol} aria-label="Volume" style={{ ["--v" as string]: `${(muted ? 0 : vol) * 100}%` }}
        onChange={(e) => { const v = el(); if (v) { v.volume = Number(e.target.value); v.muted = Number(e.target.value) === 0; } }} />
    </div>
  );
}

/** Media state every player needs, read from the element's own events. */
function useMedia(ref: React.RefObject<HTMLMediaElement | null>) {
  const [s, setS] = useState({ t: 0, dur: 0, playing: false, waiting: false, vol: 1, muted: false, rate: 1, buffered: [] as [number, number][], ended: false });
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const s0 = { waiting: false };
    const read = () => {
      const b: [number, number][] = [];
      for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i), v.buffered.end(i)]);
      setS({ t: v.currentTime, dur: isFinite(v.duration) ? v.duration : 0, playing: !v.paused, waiting: s0.waiting, vol: v.volume, muted: v.muted, rate: v.playbackRate, buffered: b, ended: v.ended });
    };
    const wait = () => { s0.waiting = true; read(); };
    const go = () => { s0.waiting = false; read(); };
    const evs = ["timeupdate", "durationchange", "loadedmetadata", "play", "pause", "volumechange", "ratechange", "progress", "ended", "seeked"];
    evs.forEach((e) => v.addEventListener(e, read));
    v.addEventListener("waiting", wait); v.addEventListener("stalled", wait); v.addEventListener("seeking", wait);
    v.addEventListener("playing", go); v.addEventListener("canplay", go); v.addEventListener("seeked", go);
    read();
    return () => {
      evs.forEach((e) => v.removeEventListener(e, read));
      v.removeEventListener("waiting", wait); v.removeEventListener("stalled", wait); v.removeEventListener("seeking", wait);
      v.removeEventListener("playing", go); v.removeEventListener("canplay", go); v.removeEventListener("seeked", go);
    };
  }, [ref]);
  return s;
}

/** The video player. `resumeKey` remembers where you stopped (on this device). */
/** `globalKeys`: the shortcuts work anywhere on the page (the full-screen viewer); otherwise only once you've clicked into
 *  this player or while the pointer is over it, so two players on a page never both answer. */
export function VideoPlayer({ src, poster, title, autoPlay = true, resumeKey, onEnded, className, globalKeys = false, ratio }: {
  src: string; poster?: string | null; title?: string; autoPlay?: boolean; resumeKey?: string; onEnded?: () => void; className?: string; globalKeys?: boolean;
  /** width / height when it's known up front (the Library has it); otherwise the file's own, once its header arrives */
  ratio?: number | null;
}) {
  const v = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const s = useMedia(v);
  const [shown, setShown] = useState(true);
  const [full, setFull] = useState(false);
  const [flash, setFlash] = useState<{ k: number; icon: "play" | "pause" | "back" | "fwd"; side?: "l" | "r" } | null>(null);
  const [resumed, setResumed] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  // the player takes the video's own shape (vertical Shorts stay tall, squares square), never a forced 16:9
  const [ar, setAr] = useState<number | null>(ratio && isFinite(ratio) ? ratio : null);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const taps = useRef<{ t: number; x: number } | null>(null);
  const over = useRef(false);
  const rk = resumeKey ? `vb-resume:${resumeKey}` : null;

  const poke = useCallback(() => {
    setShown(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => { if (v.current && !v.current.paused) setShown(false); }, 2600);
  }, []);
  const toggle = useCallback(() => {
    const el = v.current;
    if (!el) return;
    if (el.paused || el.ended) { el.play().catch(() => null); setFlash({ k: Date.now(), icon: "play" }); }
    else { el.pause(); setFlash({ k: Date.now(), icon: "pause" }); }
    poke();
  }, [poke]);
  const skip = useCallback((d: number) => {
    const el = v.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min((el.duration || 0) - 0.05, el.currentTime + d));
    setFlash({ k: Date.now(), icon: d < 0 ? "back" : "fwd", side: d < 0 ? "l" : "r" });
    poke();
  }, [poke]);
  const fullscreen = useCallback(() => {
    const w = wrap.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    const ve = v.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => null); return; }
    if (w?.requestFullscreen) w.requestFullscreen().catch(() => ve?.webkitEnterFullscreen?.());
    else if (w?.webkitRequestFullscreen) w.webkitRequestFullscreen();
    else ve?.webkitEnterFullscreen?.(); // iPhone: the system player
  }, []);

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // remembered volume and speed; where you left off
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    el.volume = pref.get("vb-vol", 1);
    el.muted = pref.get("vb-muted", 0) === 1;
    el.playbackRate = pref.get("vb-rate", 1);
    const onMeta = () => {
      if (el.videoWidth && el.videoHeight) setAr(el.videoWidth / el.videoHeight);
      const at = rk ? pref.get(rk, 0) : 0;
      if (at > 20 && at < el.duration - 15) { el.currentTime = at; setResumed(at); setTimeout(() => setResumed(null), 5000); }
    };
    if (el.readyState >= 1) onMeta(); // already known (cached)
    else el.addEventListener("loadedmetadata", onMeta, { once: true });
    return () => el.removeEventListener("loadedmetadata", onMeta);
  }, [rk]);
  useEffect(() => { pref.set("vb-vol", s.vol); pref.set("vb-muted", s.muted ? 1 : 0); }, [s.vol, s.muted]);
  useEffect(() => { pref.set("vb-rate", s.rate); }, [s.rate]);
  // where you are, every few seconds, on pause and when the player closes; finishing (or nearly) forgets it
  const saved = useRef(0);
  useEffect(() => {
    if (!rk || !s.dur) return;
    if (s.ended || s.t > s.dur - 15) { try { localStorage.removeItem(rk); } catch {} saved.current = 0; return; }
    if (s.t > 20 && (Math.abs(s.t - saved.current) >= 4 || !s.playing)) { pref.set(rk, Math.floor(s.t)); saved.current = s.t; }
  }, [rk, s.t, s.dur, s.ended, s.playing]);
  useEffect(() => () => {
    const el = v.current;
    if (rk && el && el.duration && el.currentTime > 20 && el.currentTime < el.duration - 15) pref.set(rk, Math.floor(el.currentTime));
  }, [rk]);
  useEffect(() => { if (!s.playing) { setShown(true); clearTimeout(idle.current); } else poke(); }, [s.playing, poke]);
  useEffect(() => { if (s.ended) onEnded?.(); }, [s.ended, onEnded]);

  // keys, while this player is on screen and you're not typing
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!globalKeys && !over.current && !wrap.current?.contains(document.activeElement) && document.fullscreenElement !== wrap.current) return;
      const el = v.current;
      if (!el) return;
      const key = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        " ": toggle, k: toggle, j: () => skip(-10), l: () => skip(10), arrowleft: () => skip(-5), arrowright: () => skip(5),
        arrowup: () => { el.volume = Math.min(1, el.volume + 0.1); el.muted = false; poke(); }, arrowdown: () => { el.volume = Math.max(0, el.volume - 0.1); poke(); },
        m: () => { el.muted = !el.muted; poke(); }, f: fullscreen,
        ",": () => { if (el.paused) el.currentTime = Math.max(0, el.currentTime - 1 / 30); }, ".": () => { if (el.paused) el.currentTime += 1 / 30; },
        "<": () => { el.playbackRate = SPEEDS[Math.max(0, SPEEDS.indexOf(el.playbackRate) - 1)] ?? 1; poke(); },
        ">": () => { el.playbackRate = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(el.playbackRate) + 1)] ?? 1; poke(); },
      };
      if (/^[0-9]$/.test(key) && el.duration) { e.preventDefault(); el.currentTime = (Number(key) / 10) * el.duration; poke(); return; }
      if (act[key] && !(e.shiftKey && key.startsWith("arrow"))) { e.preventDefault(); e.stopPropagation(); act[key](); }
    };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, [toggle, skip, fullscreen, poke, globalKeys]);

  const pip = async () => {
    const el = v.current as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await el.requestPictureInPicture?.(); } catch { /* not allowed here */ }
  };

  // touch: tap shows the controls, double-tap a side skips 10 s
  const onTouch = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch" || (e.target as HTMLElement).closest(".vp-bar, .vp-center")) return;
    const now = Date.now(), r = wrap.current!.getBoundingClientRect(), x = e.clientX - r.left;
    if (taps.current && now - taps.current.t < 300) { skip(x < r.width / 2 ? -10 : 10); taps.current = null; return; }
    taps.current = { t: now, x };
    setTimeout(() => { if (taps.current?.t === now) { taps.current = null; if (shown && s.playing) setShown(false); else poke(); } }, 300);
  };

  const pipOk = typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled;
  return (
    <div ref={wrap} tabIndex={-1} className={`vp ${shown ? "show" : "idle"} ${full ? "full" : ""} ${ar && ar < 0.9 ? "tall" : ""} ${className ?? ""}`}
      style={{ ["--ar" as string]: String(ar ?? 16 / 9) }} onPointerMove={(e) => e.pointerType !== "touch" && poke()}
      onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("button, input, [role=slider]")) wrap.current?.focus({ preventScroll: true }); onTouch(e); }}
      onMouseEnter={() => { over.current = true; }} onMouseLeave={() => { over.current = false; if (s.playing) setShown(false); }}>
      <video ref={v} src={src} poster={poster ?? undefined} autoPlay={autoPlay} playsInline preload="metadata" aria-label={title}
        onClick={(e) => { if ((e.nativeEvent as PointerEvent).pointerType !== "touch") toggle(); }} onDoubleClick={fullscreen}
        onError={() => setFailed(true)} onPlaying={() => { if (v.current) v.current.preload = "auto"; /* keep buffering ahead once it plays */ }} />
      {s.waiting && !failed && <span className="vp-spin" aria-label="Loading" />}
      {failed && <div className="vp-fail">This video can't play here. Download it to watch.</div>}
      {flash && <span key={flash.k} className={`vp-flash ${flash.side ?? ""}`} aria-hidden>
        {flash.icon === "play" ? <Play size={30} weight="fill" /> : flash.icon === "pause" ? <Pause size={30} weight="fill" /> : flash.icon === "back" ? <><ArrowCounterClockwise size={26} weight="bold" /><b>10</b></> : <><ArrowClockwise size={26} weight="bold" /><b>10</b></>}
      </span>}
      {!s.playing && !s.waiting && !failed && <button className="vp-center" onClick={toggle} aria-label="Play"><Play size={34} weight="fill" /></button>}
      {resumed !== null && <button className="vp-resumed" onClick={() => { if (v.current) v.current.currentTime = 0; setResumed(null); }}>Resumed at {clock(resumed)} · <b>Start over</b></button>}
      <div className="vp-bar" onPointerDown={(e) => e.stopPropagation()}>
        {title && full && <div className="vp-title">{title}</div>}
        <Scrub t={s.t} dur={s.dur} buffered={s.buffered} label="Seek" onSeek={(t) => { if (v.current) v.current.currentTime = t; poke(); }} />
        <div className="vp-row">
          <button className="vp-btn" onClick={toggle} aria-label={s.playing ? "Pause (K)" : "Play (K)"} title={s.playing ? "Pause (K)" : "Play (K)"}>{s.playing ? <Pause size={22} weight="fill" /> : <Play size={22} weight="fill" />}</button>
          <button className="vp-btn" onClick={() => skip(-10)} aria-label="Back 10 seconds (J)" title="Back 10 s (J)"><ArrowCounterClockwise size={20} /></button>
          <button className="vp-btn" onClick={() => skip(10)} aria-label="Forward 10 seconds (L)" title="Forward 10 s (L)"><ArrowClockwise size={20} /></button>
          <Volume el={() => v.current} vol={s.vol} muted={s.muted} />
          <span className="vp-time mono">{clock(s.t)} <span>/ {clock(s.dur)}</span></span>
          <span className="grow" />
          <SpeedMenu rate={s.rate} set={(r) => { if (v.current) v.current.playbackRate = r; }} />
          {pipOk && <button className="vp-btn hide-sm" onClick={pip} aria-label="Picture in picture" title="Picture in picture"><PictureInPicture size={20} /></button>}
          <button className="vp-btn" onClick={fullscreen} aria-label={full ? "Exit full screen (F)" : "Full screen (F)"} title={full ? "Exit full screen (F)" : "Full screen (F)"}>{full ? <CornersIn size={20} /> : <CornersOut size={20} />}</button>
        </div>
      </div>
    </div>
  );
}

/** The audio stage: cover or a big disc, the waveform you can scrub, and the same transport as the video. */
export function AudioStage({ src, title, sub, size, cover, autoPlay = true }: { src: string; title: string; sub?: string; size?: number | null; cover?: string | null; autoPlay?: boolean }) {
  const a = useRef<HTMLAudioElement>(null);
  const s = useMedia(a);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [loop, setLoop] = useState(false);
  useEffect(() => {
    let live = true;
    if (!size || size < 80e6) peaksFor(src).then((p) => live && setPeaks(p));
    return () => { live = false; };
  }, [src, size]);
  useEffect(() => {
    const el = a.current;
    if (!el) return;
    el.volume = pref.get("vb-vol", 1);
    el.playbackRate = pref.get("vb-rate", 1);
  }, []);
  const toggle = useCallback(() => { const el = a.current; if (!el) return; if (el.paused) el.play().catch(() => null); else el.pause(); }, []);
  const skip = useCallback((d: number) => { const el = a.current; if (el) el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + d)); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const act: Record<string, () => void> = { " ": toggle, k: toggle, j: () => skip(-10), l: () => skip(10), arrowleft: () => skip(-5), arrowright: () => skip(5),
        m: () => { if (a.current) a.current.muted = !a.current.muted; } };
      if (act[key] && !(e.shiftKey && key.startsWith("arrow"))) { e.preventDefault(); e.stopPropagation(); act[key](); }
    };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, [toggle, skip]);
  useEffect(() => { pref.set("vb-rate", s.rate); }, [s.rate]);
  const frac = s.dur ? s.t / s.dur : 0;
  const seekAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (a.current && s.dur) a.current.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * s.dur;
  };
  return (
    <div className={`as ${s.playing ? "on" : ""}`}>
      <audio ref={a} src={src} autoPlay={autoPlay} preload="metadata" loop={loop} />
      <div className="as-art">{cover ? <img src={cover} alt="" /> : <span className="as-disc" aria-hidden><i /></span>}</div>
      <div className="as-name"><b>{title}</b>{sub && <span>{sub}</span>}</div>
      <div className="as-wave" role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(s.dur)} aria-valuenow={Math.round(s.t)} aria-valuetext={`${clock(s.t)} of ${clock(s.dur)}`}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekAt(e); }} onPointerMove={(e) => { if (e.buttons) seekAt(e); }}>
        {(peaks ?? Array.from({ length: 96 }, (_, i) => 0.25 + 0.2 * Math.abs(Math.sin(i * 0.7)))).map((p, i, all) => (
          <i key={i} className={i / all.length < frac ? "on" : ""} style={{ height: `${Math.round(p * 100)}%`, opacity: peaks ? 1 : 0.35 }} />
        ))}
      </div>
      <div className="as-times mono"><span>{clock(s.t)}</span><span>{clock(s.dur)}</span></div>
      <div className="as-ctl">
        <button className={`vp-btn ${loop ? "on" : ""}`} onClick={() => setLoop((l) => !l)} aria-label="Repeat" aria-pressed={loop} title="Repeat"><Repeat size={20} /></button>
        <button className="vp-btn" onClick={() => skip(-10)} aria-label="Back 10 seconds" title="Back 10 s (J)"><ArrowCounterClockwise size={22} /></button>
        <button className="as-play" onClick={toggle} aria-label={s.playing ? "Pause" : "Play"}>{s.waiting && s.playing ? <span className="vp-spin sm" /> : s.playing ? <Pause size={26} weight="fill" /> : <Play size={26} weight="fill" />}</button>
        <button className="vp-btn" onClick={() => skip(10)} aria-label="Forward 10 seconds" title="Forward 10 s (L)"><ArrowClockwise size={22} /></button>
        <SpeedMenu rate={s.rate} set={(r) => { if (a.current) a.current.playbackRate = r; }} />
      </div>
      <Volume el={() => a.current} vol={s.vol} muted={s.muted} />
    </div>
  );
}
