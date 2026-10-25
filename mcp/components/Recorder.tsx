"use client";
// Record in the browser, listen back, then keep or retake: used wherever a page takes a recording (Voices, Your model,
// Clean-up, Subtitles). Raw capture (no echo cancellation, noise suppression or auto gain), so the worker gets the real
// voice to work on. Every second of a take is saved to this browser as it's recorded (takes.ts), so a refresh or a crash
// never loses it: SavedTakes offers it back.
import { ArrowCounterClockwise, Microphone, Pause, Play, Stop, TrashSimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { fmtS } from "./api";
import Player from "./Player";
import { addChunk, dropTake, finishTake, newTake, takeFile, useTakes, type Take } from "./takes";

export type Recording = Awaited<ReturnType<typeof startRecording>>;

/** Start the mic. scope names where the take is offered back after a refresh (e.g. "voices", "dataset:asper"). */
export async function startRecording(scope = "recording", note?: string) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
  const take = await newTake(scope, r.mimeType || mime || "audio/webm", note);
  const chunks: Blob[] = [];
  const t0 = performance.now();
  let held = 0, pausedAt = 0; // time spent paused doesn't count toward the take's length
  const elapsed = () => ((pausedAt || performance.now()) - t0 - held) / 1000;
  let seq = 0;
  r.ondataavailable = (e) => {
    if (!e.data.size) return;
    chunks.push(e.data);
    addChunk(take, seq++, e.data, elapsed());
  };
  r.start(1000);
  return {
    r, stream, take,
    /** Seconds recorded so far, not counting pauses. */
    elapsed,
    get paused() { return r.state === "paused"; },
    /** Hold the take: nothing is recorded (or sent) until resume(). The mic stays open so resuming is instant. */
    pause() { if (r.state === "recording") { r.requestData(); r.pause(); pausedAt = performance.now(); } },
    resume() { if (r.state === "paused") { held += performance.now() - pausedAt; pausedAt = 0; r.resume(); } },
    /** Stop and get the file. The take stays saved until forget() (call it once the file has been sent). */
    async stop() {
      const stopped = new Promise((ok) => (r.onstop = ok));
      if (r.state !== "inactive") r.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      await finishTake(take, elapsed());
      const type = r.mimeType || "audio/webm";
      return new File(chunks, `${scope.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.${type.includes("mp4") ? "m4a" : "webm"}`, { type });
    },
    forget: () => dropTake(take.id),
  };
}

/** An orb that breathes with your voice: its size follows the loudness, a ring of bars follows the spectrum, and an
 *  arc fills toward the target length. Drawn on a canvas from an AnalyserNode; children sit in the middle. */
export function VoiceOrb({ stream, size = 220, target, secs = 0, paused = false, children }: { stream: MediaStream | null; size?: number; target?: number; secs?: number; paused?: boolean; children?: React.ReactNode }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const prog = useRef(0);
  const hold = useRef(paused);
  prog.current = target ? Math.min(1, secs / target) : -1;
  hold.current = paused;
  useEffect(() => {
    const c = cv.current;
    if (!c || !stream) return;
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    an.smoothingTimeConstant = 0.78;
    ctx.createMediaStreamSource(stream).connect(an);
    const freq = new Uint8Array(an.frequencyBinCount);
    const wave = new Float32Array(an.fftSize);
    const g = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr; c.height = size * dpr;
    g.scale(dpr, dpr);
    const css = getComputedStyle(c);
    const sig = css.getPropertyValue("--signal").trim() || "#ff6a3d";
    const line = css.getPropertyValue("--line2").trim() || "rgba(128,128,128,.25)";
    let lvl = 0, raf = 0;
    const draw = () => {
      an.getByteFrequencyData(freq);
      an.getFloatTimeDomainData(wave);
      let rms = 0;
      for (const x of wave) rms += x * x;
      if (hold.current) { rms = 0; freq.fill(0); } // paused: the orb rests (the mic is open but nothing is kept)
      lvl = Math.max(Math.sqrt(rms / wave.length) * 3.2, lvl * 0.9);
      const cx = size / 2, base = size * 0.24, r = base * (1 + Math.min(0.45, lvl * 0.6));
      g.clearRect(0, 0, size, size);
      // glow
      const glow = g.createRadialGradient(cx, cx, r * 0.4, cx, cx, r * 1.9);
      glow.addColorStop(0, `${sig}55`); glow.addColorStop(1, `${sig}00`);
      g.fillStyle = glow; g.beginPath(); g.arc(cx, cx, r * 1.9, 0, Math.PI * 2); g.fill();
      // spectrum ring
      const bars = 72;
      g.lineCap = "round"; g.lineWidth = 2.2; g.strokeStyle = sig;
      for (let i = 0; i < bars; i++) {
        const v = freq[Math.floor((i < bars / 2 ? i : bars - i) * (freq.length * 0.55) / (bars / 2))] / 255;
        const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
        const r0 = r * 1.18, r1 = r0 + 4 + v * size * 0.13;
        g.globalAlpha = 0.25 + v * 0.75;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1); g.stroke();
      }
      g.globalAlpha = 1;
      // target ring
      if (prog.current >= 0) {
        const rr = size * 0.47;
        g.lineWidth = 3; g.strokeStyle = line; g.beginPath(); g.arc(cx, cx, rr, 0, Math.PI * 2); g.stroke();
        if (prog.current > 0) { g.strokeStyle = sig; g.beginPath(); g.arc(cx, cx, rr, -Math.PI / 2, -Math.PI / 2 + prog.current * Math.PI * 2); g.stroke(); }
      }
      // core
      g.globalAlpha = hold.current ? 0.35 : 1;
      g.fillStyle = sig; g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); ctx.close(); };
  }, [stream, size]);
  return (
    <div className="orb" style={{ width: size, height: size }}>
      <canvas ref={cv} style={{ width: size, height: size }} />
      <div className="orb-mid">{children}</div>
    </div>
  );
}

/** The start button, drawn as a voiceprint at rest: four strands (one per palette colour) wind around a circle as a
 *  slow polar waveform, interfering like the harmonics of a held note. Hover or focus wakes them up (they swell and
 *  speed up), as if the button were already listening. Static under prefers-reduced-motion. */
export function VoiceSeed({ onClick, disabled, size = 184, label = "Start recording" }: { onClick: () => void; disabled?: boolean; size?: number; label?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const wake = useRef(0);
  const [hot, setHot] = useState(false);
  const hotRef = useRef(hot);
  hotRef.current = hot && !disabled;
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr; c.height = size * dpr;
    g.scale(dpr, dpr);
    const css = getComputedStyle(c);
    const tone = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const strands = [
      { col: tone("--accent", "#1f7a57"), k: 3, sp: 0.55, ph: 0 },
      { col: tone("--ink2", "#3b3b38"), k: 5, sp: -0.4, ph: 1.7 },
      { col: tone("--dim", "#6e6e69"), k: 7, sp: 0.3, ph: 3.1 },
      { col: tone("--faint", "#a3a39d"), k: 4, sp: -0.65, ph: 4.4 },
    ];
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, t = 0, last = performance.now();
    const cx = size / 2, R = size * 0.31;
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      wake.current += ((hotRef.current ? 1 : 0) - wake.current) * Math.min(1, dt * 5);
      const w = wake.current;
      t += dt * (1 + 1.6 * w);
      g.clearRect(0, 0, size, size);
      // a soft well the strands sit in
      const well = g.createRadialGradient(cx, cx, R * 0.2, cx, cx, R * 1.6);
      well.addColorStop(0, `${strands[0].col}${w > 0.5 ? "30" : "1c"}`); well.addColorStop(1, `${strands[0].col}00`);
      g.fillStyle = well; g.beginPath(); g.arc(cx, cx, R * 1.6, 0, Math.PI * 2); g.fill();
      // a slow dotted orbit: the "press me" cue, it tightens as the strands wake
      g.save(); g.translate(cx, cx); g.rotate(t * 0.15);
      g.setLineDash([1.5, 7]); g.lineCap = "round"; g.lineWidth = 1.5; g.strokeStyle = tone("--faint", "#5c5c58");
      g.beginPath(); g.arc(0, 0, size * (0.47 - 0.03 * w), 0, Math.PI * 2); g.stroke();
      g.restore(); g.setLineDash([]);
      g.lineWidth = 1.9 + w * 0.6; g.lineJoin = "round";
      for (const st of strands) {
        const amp = R * (0.11 + 0.12 * w);
        g.strokeStyle = st.col; g.globalAlpha = 0.78;
        g.beginPath();
        for (let i = 0; i <= 240; i++) {
          const a = (i / 240) * Math.PI * 2;
          const r = R + amp * Math.sin(st.k * a + st.ph + t * st.sp * 2) + amp * 0.45 * Math.sin((st.k + 2) * a - t * 1.3 + st.ph);
          const x = cx + Math.cos(a) * r, y = cx + Math.sin(a) * r;
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.closePath(); g.stroke();
      }
      g.globalAlpha = 1;
      // the seed: a small core that breathes, and grows when the strands wake
      const core = size * (0.05 + 0.02 * Math.sin(t * 2) * (1 - w) + 0.03 * w);
      g.fillStyle = tone("--ink", "#fff"); g.beginPath(); g.arc(cx, cx, core, 0, Math.PI * 2); g.fill();
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);
  return (
    <button className="voice-seed" style={{ width: size, height: size }} onClick={onClick} disabled={disabled} aria-label={label}
      onPointerEnter={() => setHot(true)} onPointerLeave={() => setHot(false)} onFocus={() => setHot(true)} onBlur={() => setHot(false)}>
      <canvas ref={cv} style={{ width: size, height: size }} />
    </button>
  );
}

/** Takes recorded on this page that were never sent (a refresh, a closed tab): play, use, or delete each. */
export function SavedTakes({ scope, live, onUse, useLabel = "Use this" }: { scope: string; live?: string | null; onUse: (f: File, take: Take) => void; useLabel?: string }) {
  const takes = useTakes(scope, live);
  const [open, setOpen] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!takes.length) return null;
  async function play(t: Take) {
    if (open === t.id) { setOpen(null); return; }
    const f = await takeFile(t);
    if (!f) return;
    if (url) URL.revokeObjectURL(url);
    setUrl(URL.createObjectURL(f));
    setOpen(t.id);
  }
  return (
    <div className="saved-takes">
      <div className="tiny dim">Saved on this device · not sent yet</div>
      {takes.map((t) => (
        <div key={t.id} className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <button className="icon-btn" title="Listen" onClick={() => play(t)}><Play size={13} weight="fill" /></button>
            <span className="small" style={{ flex: 1, minWidth: 0 }}>{fmtS(t.secs)} · {new Date(t.created).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}{!t.done ? " · cut short" : ""}{t.note ? ` · ${t.note}` : ""}</span>
            <button className="ghost xs" onClick={async () => { const f = await takeFile(t); if (f) onUse(f, t); }}>{useLabel}</button>
            <button className="icon-btn danger-h" title="Delete" onClick={() => dropTake(t.id)}><TrashSimple size={13} /></button>
          </div>
          {open === t.id && url && <Player src={url} compact autoPlay />}
        </div>
      ))}
    </div>
  );
}

/** A file you picked or recorded, playable before it goes anywhere. */
export function FilePreview({ file, onRemove }: { file: File; onRemove?: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);
  const video = file.type.startsWith("video/");
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row between tiny"><span className="dim" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
        {onRemove && <button className="quiet xs" onClick={onRemove}>Remove</button>}</div>
      {url && (video ? <video src={url} controls style={{ width: "100%", maxHeight: 220, borderRadius: 10 }} /> : <Player src={url} compact />)}
    </div>
  );
}

/** Pause / resume a running take. Nothing is sent anywhere until the take is stopped and kept. */
export function PauseButton({ rec, paused, onChange, className = "ghost sm" }: { rec: Recording; paused: boolean; onChange: (p: boolean) => void; className?: string }) {
  return paused
    ? <button className={className} onClick={() => { rec.resume(); onChange(false); }}><Microphone size={14} weight="fill" /> Resume</button>
    : <button className={className} onClick={() => { rec.pause(); onChange(true); }}><Pause size={14} weight="fill" /> Pause</button>;
}

/** Record → listen → keep it (onReady) or retake. The kept take is deleted from this device by calling the
 *  returned forget once it's been sent (onReady gets it). */
export default function Recorder({ onReady, scope = "recording", disabled, hint, target }: {
  onReady: (f: File | null, forget?: () => void) => void; scope?: string; disabled?: boolean; hint?: string; target?: number;
}) {
  const [rec, setRec] = useState<Recording | null>(null);
  const [paused, setPaused] = useState(false);
  const [secs, setSecs] = useState(0);
  const [take, setTake] = useState<File | null>(null);
  const [kept, setKept] = useState<string | null>(null); // the saved take shown above, so it isn't listed twice
  const [err, setErr] = useState("");
  const live = useRef(rec);
  live.current = rec;
  useEffect(() => () => { live.current?.stream.getTracks().forEach((t) => t.stop()); }, []);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setSecs(rec.elapsed()), 200);
    return () => clearInterval(t);
  }, [rec]);

  async function begin() {
    setErr("");
    try {
      const r = await startRecording(scope);
      setTake(null); onReady(null); setSecs(0); setPaused(false); setRec(r);
    } catch (e) {
      setErr((e as Error).name === "NotAllowedError" ? "Allow the microphone for this site, then try again." : (e as Error).message);
    }
  }
  async function finish() {
    if (!rec) return;
    const f = await rec.stop();
    const forget = rec.forget;
    setKept(rec.take.id);
    setRec(null);
    setTake(f);
    onReady(f, forget);
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      {rec ? (
        <div className="rec-inline">
          <VoiceOrb stream={rec.stream} size={150} target={target} secs={secs} paused={paused}>
            <button className="rec-btn on sm" onClick={finish} aria-label="Stop recording"><Stop size={20} weight="fill" /></button>
          </VoiceOrb>
          <div className="stack" style={{ gap: 8 }}>
            <span className="mono">{fmtS(secs)}{paused ? " · paused" : ""}</span>
            <PauseButton rec={rec} paused={paused} onChange={setPaused} />
          </div>
        </div>
      ) : take ? (
        <>
          <FilePreview file={take} />
          <button className="ghost sm" style={{ alignSelf: "flex-start" }} onClick={begin} disabled={disabled}><ArrowCounterClockwise size={14} /> Record again</button>
        </>
      ) : (
        <button className="ghost sm" style={{ alignSelf: "flex-start" }} onClick={begin} disabled={disabled}><Microphone size={14} weight="fill" /> Start recording</button>
      )}
      {hint && !rec && !take && <span className="tiny dim">{hint}</span>}
      {err && <span className="err tiny">{err}</span>}
      {!rec && <SavedTakes scope={scope} live={kept} onUse={(f, t) => { setTake(f); setKept(t.id); onReady(f, () => dropTake(t.id)); }} />}
    </div>
  );
}
