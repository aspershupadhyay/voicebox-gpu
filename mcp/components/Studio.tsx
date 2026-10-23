"use client";
import { DownloadSimple, FilmSlate, ImageSquare, MagicWand, MusicNotes, Sparkle, UploadSimple, Waveform, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, fmtS, pct, rangeFill, simClass, uploadFile, type Job, type MyVoice } from "./api";
import JobProgress from "./JobProgress";
import LineRow from "./LineRow";
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

function CleanUp({ settings }: { settings: Settings | null }) {
  const { status } = useStatus();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState("enhance");
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
      start(await api<Job>("jobs", { body: { kind: "clean", source_key: key, platform, subtitles, params: { mode, strength }, label: `Clean-up · ${file.name.slice(0, 50)}` } }));
    } catch (e) {
      setUpFrac(null);
      setErr((e as Error).message);
    }
  }
  const r = job?.results[0];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2><Waveform size={18} weight="duotone" /> Studio clean-up</h2><span className="dim tiny">bad mic in, studio sound out</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>
        Upload any recording of yourself (laptop mic, phone, a noisy room, or a video). AI removes the noise and room echo, rebuilds the
        crisp detail a cheap mic loses, then masters it for your platform. The length stays the same, so it drops back onto your edit.
      </p>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
        <div className="field" style={{ margin: 0 }}><label className="f">Recording (audio or video)</label>
          <label className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start", overflow: "hidden" }}>
            <UploadSimple size={14} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? file.name : "Choose a file"}</span>
            <input type="file" accept="audio/*,video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label></div>
        <div className="field" style={{ margin: 0 }}><label className="f">Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="enhance">Studio: remove noise + restore detail</option><option value="denoise">Denoise only: keep my exact tone</option>
          </select></div>
        <div className="field" style={{ margin: 0 }}><label className="f">Publish for</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {[...PLATFORMS.map(([p, l]) => [p, l] as const), ["raw", "Raw (no mastering)"] as const].map(([p, l]) => <option key={p} value={p}>{l}</option>)}
          </select></div>
      </div>
      {mode === "enhance" && (
        <div className="field" style={{ margin: "12px 0 0" }}>
          <div className="row between"><label className="f" style={{ margin: 0 }}>Clean-up strength</label><span className="mono small">{strength.toFixed(2)}</span></div>
          <input type="range" min={0.1} max={1} step={0.05} value={strength} style={rangeFill(strength, 0.1, 1)} onChange={(e) => setStrength(+e.target.value)} />
          <div className="dim tiny">Higher for noisy rooms and echo; lower keeps more of the original character.</div>
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
          <h1>Bad mic in, <em>studio sound out.</em></h1>
          <p className="sub">Drop a voiceover you recorded yourself. Noise and room echo come out, detail comes back, and it's mastered for the platform, at exactly the same length so it stays in sync with your edit.</p>
        </div>
        <Link className="btn ghost sm" href="/settings">Defaults</Link>
      </div>
      <CleanUp settings={settings} />
      <div style={{ height: 30 }} />
    </>
  );
}
