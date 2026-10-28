"use client";
// Clean-up: a rough recording in, studio sound out, same length so it stays in sync with the edit. The recording on
// the canvas, the settings in the panel on the right.
import { MagicWand, Power, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, rangeFill, uploadFile, type Cleanup, type Job } from "./api";
import JobProgress from "./JobProgress";
import { useResumeJob } from "./jobs";
import LineRow from "./LineRow";
import { Select } from "./pop";
import Recorder, { FilePreview } from "./Recorder";
import { PLATFORMS, SourcePick } from "./Revoice";
import { useStatus } from "./Shell";
import { DropZone, Empty, SideRow, ToolPage } from "./ui";

function usePoll() {
  const [job, setJob] = useState<Job | null>(null);
  const [lib, setLib] = useState<{ results: { id: string; audio?: string | null }[] } | null>(null);
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

const MODES = [
  { value: "auto", label: "Auto", hint: "Measures the recording and runs only what it needs" },
  { value: "denoise", label: "Denoise only", hint: "Keeps your exact tone" },
  { value: "enhance", label: "Restore", hint: "Rebuilds a thin or echoey voice" },
];

export default function Studio() {
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
  useEffect(() => { api<{ platform: string }>("settings").then((s) => setPlatform(s.platform)).catch(() => {}); }, []);

  async function go() {
    if (!file) return setErr("Add a recording first: upload it or record it.");
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
  const offline = !!status && !status.online;
  const working = busy || upFrac !== null;

  return (
    <ToolPage title="Clean-up" sub="A rough recording in, studio sound out, same length so it stays in sync."
      side={
        <>
          <SideRow label="Mode" htmlFor="cu-mode" info="It measures the noise, the room echo and how much of the voice the mic captured, runs only what the recording needs, and checks it still sounds like you.">
            <Select id="cu-mode" value={mode} onChange={setMode} options={MODES} />
          </SideRow>
          {mode === "enhance" && (
            <div className="set-row">
              <div className="set-line"><label htmlFor="cu-strength">Strength</label><span className="mono small">{strength.toFixed(2)}</span></div>
              <div className="range-ends"><span>Keep character</span><span>Clean harder</span></div>
              <input id="cu-strength" type="range" min={0.1} max={1} step={0.05} value={strength} style={rangeFill(strength, 0.1, 1)} onChange={(e) => setStrength(+e.target.value)} />
            </div>
          )}
          <SideRow label="Publish for" htmlFor="cu-platform" info="Sets loudness mastering for that platform. Raw skips mastering.">
            <Select id="cu-platform" value={platform} onChange={setPlatform} options={PLATFORMS} />
          </SideRow>
          <div className="set-row"><div className="set-line"><span>Also make subtitles</span>
            <button role="switch" aria-checked={subtitles} className={`switch ${subtitles ? "on" : ""}`} onClick={() => setSubtitles(!subtitles)} aria-label="Also make subtitles" /></div></div>
          <div className="tool-go">
            {offline ? <Link href="/settings?tab=gpu" className="btn block"><Power size={15} weight="bold" />Start the GPU</Link>
              : <button className="block" onClick={go} disabled={working || !status}><MagicWand size={16} weight="bold" />{working ? "Cleaning…" : "Clean it up"}</button>}
            <span className="tiny dim">Same length as the original, so it drops back onto your edit.</span>
          </div>
        </>
      }>
      <div className="tool-canvas">
        <div className="row between"><SourcePick src={src} setSrc={(s) => { setSrc(s); setFile(null); }} /></div>
        {src === "upload" ? (file ? <FilePreview file={file} onRemove={() => setFile(null)} />
          : <DropZone icon={<UploadSimple size={22} />} title="Drop a recording here" hint="or click to choose · audio or video · laptop mic, phone, noisy room" accept="audio/*,video/*" onFiles={(f) => f[0] && setFile(f[0])} />)
          : <Recorder scope="clean-up" onReady={(f, fg) => { setFile(f); forget.current = fg ?? null; }} target={60} hint="Record, listen back, then press Clean it up. It's saved on this device as you go." />}
        {err && <p className="err" role="alert">{err}</p>}
        {(job || upFrac !== null) && <JobProgress job={job} kind="tts" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} onCancel={job ? () => api(`jobs/${job.id}/cancel`, { body: {} }) : undefined} />}
        {job?.library && r ? (
          <div className="stack" style={{ gap: 12 }}>
            {r.enhanced === false && <div className="tiny" style={{ color: "var(--warn)" }}><WarningCircle size={12} /> The studio model couldn&apos;t run, so the standard clean-up was used.</div>}
            {r.cleanup && <CleanupReport c={r.cleanup as Cleanup} />}
            <div className="lines-box"><LineRow jobId={job.id} line={r} audio={lib?.results[0]?.audio ?? r.url} slug="clean" /></div>
          </div>
        ) : !job && !file && <Empty icon={<MagicWand size={20} />} title="Your cleaned recording appears here">With a before and after: noise, bandwidth and room echo.</Empty>}
      </div>
    </ToolPage>
  );
}
