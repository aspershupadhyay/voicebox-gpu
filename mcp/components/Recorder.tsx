"use client";
// Record in the browser, listen back, then keep or retake: used wherever a page takes a recording (Clean-up, Your model).
// Raw capture (no echo cancellation, noise suppression or auto gain), so the worker gets the real voice to work on.
import { ArrowCounterClockwise, Microphone, Stop } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { fmtS } from "./api";
import Player from "./Player";

export async function startRecording() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
  const chunks: Blob[] = [];
  r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  r.start(1000);
  return {
    r,
    async stop(name = "recording") {
      const stopped = new Promise((ok) => (r.onstop = ok));
      r.stop();
      await stopped;
      s.getTracks().forEach((t) => t.stop());
      const type = r.mimeType || "audio/webm";
      return new File(chunks, `${name}-${Date.now()}.${type.includes("mp4") ? "m4a" : "webm"}`, { type });
    },
  };
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

/** Record → listen → keep it (onReady) or retake. */
export default function Recorder({ onReady, name = "recording", disabled, hint }: { onReady: (f: File | null) => void; name?: string; disabled?: boolean; hint?: string }) {
  const [rec, setRec] = useState<Awaited<ReturnType<typeof startRecording>> | null>(null);
  const [t0, setT0] = useState(0);
  const [secs, setSecs] = useState(0);
  const [take, setTake] = useState<File | null>(null);
  const [err, setErr] = useState("");
  const live = useRef(rec);
  live.current = rec;
  useEffect(() => () => { live.current?.r.stream.getTracks().forEach((t) => t.stop()); }, []);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setSecs((performance.now() - t0) / 1000), 250);
    return () => clearInterval(t);
  }, [rec, t0]);

  async function begin() {
    setErr("");
    try {
      const r = await startRecording();
      setTake(null); onReady(null); setSecs(0); setT0(performance.now()); setRec(r);
    } catch (e) {
      setErr((e as Error).name === "NotAllowedError" ? "Allow the microphone for this site, then try again." : (e as Error).message);
    }
  }
  async function finish() {
    if (!rec) return;
    const f = await rec.stop(name);
    setRec(null);
    setTake(f);
    onReady(f);
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {rec ? (
        <div className="row" style={{ gap: 12 }}>
          <span className="rec-live-dot" /><span className="mono">{fmtS(secs)}</span>
          <button className="sm" onClick={finish}><Stop size={14} weight="fill" /> Stop</button>
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
    </div>
  );
}
