"use client";
import { MagicWand, UploadSimple, Waveform, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, rangeFill, uploadFile, type Cleanup, type Job } from "./api";
import { Info } from "./Info";
import JobProgress from "./JobProgress";
import { useResumeJob } from "./jobs";
import LineRow from "./LineRow";
import Recorder, { FilePreview } from "./Recorder";
import { useStatus } from "./Shell";

type Settings = { engine: string; voice: string; style: string; platform: string; takes: number; visuals: string; visual_style: string; captions_look: string; transition: string; music_lufs: number };

const PLATFORMS = [["youtube", "YouTube"], ["shorts", "Shorts"], ["reels", "Reels"], ["tiktok", "TikTok"], ["podcast", "Podcast"]] as const;

function usePoll() {
  const [job, setJob] = useState<Job | null>(null);
  const [lib, setLib] = useState<{ video_url?: string; poster_url?: string | null; results: { id: string; audio?: string | null }[] } | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (j.library) api(`library/${id}`).then(setLib).catch(() => {});
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !j.library)) timer.current = setTimeout(() => poll(id), 2000);
    } catch (e) {
      setErr((e as Error).message);
      timer.current = setTimeout(() => poll(id), 5000);
    }
  }
  const start = (j: Job) => { setLib(null); setErr(""); setJob(j); timer.current = setTimeout(() => poll(j.id), 1000); };
  const busy = !!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library));
  return { job, lib, err, setErr, start, busy };
}

const STEP_NAME: Record<string, string> = { denoise: "Noise removal (DeepFilterNet)", restore: "Restoration (Resemble Enhance)" };
const fmt = {
  snr_db: (v: number | null) => (v == null ? "—" : `${Math.round(v)} dB`),
  bandwidth_hz: (v: number | null) => (v == null ? "—" : `${(v / 1000).toFixed(1)} kHz`),
  reverb_s: (v: number | null) => (v == null ? "—" : `${v.toFixed(2)} s`),
};

/** What the clean-up measured, what it ran and why: before and after, side by side. */
function CleanupReport({ c }: { c: Cleanup }) {
  return (
    <div className="report">
      <div className="small"><b>{c.steps.length ? c.steps.map((x) => STEP_NAME[x] ?? x).join(" → ") : "Already clean: mastering only"}</b>
        <span className="dim"> · {c.why}{c.identity != null ? ` · still sounds like you (${Math.round(c.identity * 100)}%)` : ""}</span></div>
      <table className="table" style={{ marginTop: 8 }}>
        <thead><tr><th /><th>Before</th><th>After</th></tr></thead>
        <tbody>
          <tr><td className="dim small">Voice above noise</td><td className="mono small">{fmt.snr_db(c.before.snr_db)}</td><td className="mono small">{fmt.snr_db(c.after.snr_db)}</td></tr>
          <tr><td className="dim small">Bandwidth</td><td className="mono small">{fmt.bandwidth_hz(c.before.bandwidth_hz)}</td><td className="mono small">{fmt.bandwidth_hz(c.after.bandwidth_hz)}</td></tr>
          <tr><td className="dim small">Room echo</td><td className="mono small">{fmt.reverb_s(c.before.reverb_s)}</td><td className="mono small">{fmt.reverb_s(c.after.reverb_s)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function CleanUp({ settings }: { settings: Settings | null }) {
  const { status } = useStatus();
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<"upload" | "record">("upload");
  const forget = useRef<(() => void) | null>(null); // drops a recorded take from this device once it's been sent
  const [mode, setMode] = useState("auto");
  const [strength, setStrength] = useState(0.6);
  const [platform, setPlatform] = useState("youtube");
  const [subtitles, setSubtitles] = useState(false);
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const { job, lib, err, setErr, start, busy } = usePoll();
  useEffect(() => { if (settings) setPlatform(settings.platform); }, [settings]);

  async function go() {
    if (!file) return;
    setErr("");
    try {
      setUpFrac(0);
      const key = await uploadFile(file, file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "recording.wav", setUpFrac);
      setUpFrac(null);
      const sent = forget.current;
      start(await api<Job>("jobs", { body: { kind: "clean", source_key: key, platform, subtitles, cleanup: mode, params: { strength }, label: `Clean-up · ${file.name.slice(0, 50)}` } }));
      sent?.();
    } catch (e) {
      setUpFrac(null);
      setErr((e as Error).message);
    }
  }
  useResumeJob<Job>(["clean"], start);
  const r = job?.results[0];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between">
        <div className="seg">
          <button className={src === "upload" ? "on" : ""} onClick={() => { setSrc("upload"); setFile(null); }}>Upload</button>
          <button className={src === "record" ? "on" : ""} onClick={() => { setSrc("record"); setFile(null); }}>Record</button>
        </div>
        <Info>It measures the noise, the room echo and how much of the voice the mic captured, runs only what the recording needs, and checks it still sounds like you. Same length as the original, so it drops back onto your edit.</Info>
      </div>
      {src === "upload" && !file && (
        <label className="bigdrop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}>
          <UploadSimple size={26} />
          <b>Drop a recording here</b>
          <span>or click to choose · audio or video · laptop mic, phone, noisy room</span>
          <input type="file" accept="audio/*,video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      )}
      <div className="optrow">
        <label className="f">Mode <Info>Auto measures each recording. Denoise only keeps your exact tone. Restore rebuilds a thin or echoey voice.</Info></label>
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="auto">Auto</option><option value="denoise">Denoise only</option><option value="enhance">Restore</option>
        </select>
        <label className="f">Publish for</label>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {[...PLATFORMS.map(([p, l]) => [p, l] as const), ["raw", "Raw (no mastering)"] as const].map(([p, l]) => <option key={p} value={p}>{l}</option>)}
        </select>
      </div>
      {src === "record" && <div style={{ marginTop: 12 }}><Recorder scope="clean-up" onReady={(f, fg) => { setFile(f); forget.current = fg ?? null; }} target={60} hint="Record, listen back, then press Clean it up. It's saved on this device as you go." /></div>}
      {src === "upload" && file && <div style={{ marginTop: 12 }}><FilePreview file={file} onRemove={() => setFile(null)} /></div>}
      {mode === "enhance" && (
        <div className="field" style={{ margin: "12px 0 0" }}>
          <div className="row between"><label className="f" style={{ margin: 0 }}>Clean-up strength <Info>Higher for noisy rooms and echo; lower keeps more of the original character.</Info></label><span className="mono small">{strength.toFixed(2)}</span></div>
          <input type="range" min={0.1} max={1} step={0.05} value={strength} style={rangeFill(strength, 0.1, 1)} onChange={(e) => setStrength(+e.target.value)} />
        </div>
      )}
      <div className="row between" style={{ marginTop: 12 }}>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} />Also make subtitles</label>
        <button className="sig" onClick={go} disabled={!file || busy || upFrac !== null || !status?.online}><MagicWand size={16} weight="bold" />Clean it up</button>
      </div>
      {err && <p className="err" style={{ marginTop: 10 }}>{err}</p>}
      {(job || upFrac !== null) && <div style={{ marginTop: 14 }}><JobProgress job={job} kind="tts" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} onCancel={job ? () => api(`jobs/${job.id}/cancel`, { body: {} }) : undefined} /></div>}
      {job?.library && r && (
        <div style={{ marginTop: 12 }}>
          {r.enhanced === false && <div className="tiny" style={{ color: "var(--warn)", marginBottom: 6 }}><WarningCircle size={12} /> The studio model couldn&apos;t run, so the standard clean-up was used (see the warnings above).</div>}
          {r.cleanup && <CleanupReport c={r.cleanup} />}
          <LineRow jobId={job.id} line={r} audio={lib?.results[0]?.audio ?? r.url} slug="clean" />
        </div>
      )}
    </div>
  );
}

export default function Studio() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    api<Settings>("settings").then(setSettings).catch(() => setSettings(null));
  }, []);
  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Clean-up</div>
          <h1>Studio <em>sound.</em></h1>
          <p className="sub">A rough recording in, studio sound out. <Info>Noise and room echo out, detail back, mastered for the platform, same length so it stays in sync.</Info></p>
        </div>
        <Link className="btn ghost sm" href="/settings">Defaults</Link>
      </div>
      <CleanUp settings={settings} />
      <div style={{ height: 30 }} />
    </>
  );
}
