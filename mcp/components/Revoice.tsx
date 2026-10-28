"use client";
// Re-voice: speech to speech. Upload any take of yourself (voice memo, screen recording, video) and get it back in a
// recorded voice with studio clarity; timing and emotion stay yours, so it drops straight back onto the edit.
import { ArrowLeft, ArrowsClockwise, Power, UploadSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, uploadFile, type Job, type MyVoice } from "./api";
import JobProgress from "./JobProgress";
import { useResumeJob } from "./jobs";
import LineRow from "./LineRow";
import { Select } from "./pop";
import Recorder, { FilePreview } from "./Recorder";
import { useStatus } from "./Shell";
import { DropZone, Empty, SideRow, ToolPage } from "./ui";

export const PLATFORMS = [["youtube", "YouTube"], ["shorts", "YouTube Shorts"], ["reels", "Instagram Reels"], ["tiktok", "TikTok"], ["podcast", "Podcast"], ["raw", "Raw (no mastering)"]] as const;

/** Upload or record: the source switch every audio tool page starts with. */
export function SourcePick({ src, setSrc, extra }: { src: string; setSrc: (s: "upload" | "record") => void; extra?: React.ReactNode }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Source">
      <button role="radio" aria-checked={src === "upload"} className={src === "upload" ? "on" : ""} onClick={() => setSrc("upload")}>Upload</button>
      <button role="radio" aria-checked={src === "record"} className={src === "record" ? "on" : ""} onClick={() => setSrc("record")}>Record</button>
      {extra}
    </div>
  );
}

export default function Revoice() {
  const { status } = useStatus();
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [src, setSrc] = useState<"upload" | "record">("upload");
  const [file, setFile] = useState<File | null>(null);
  const forget = useRef<(() => void) | null>(null);
  const [voice, setVoice] = useState("");
  const [platform, setPlatform] = useState("youtube");
  const [subtitles, setSubtitles] = useState(true);
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    api<{ voices: MyVoice[] }>("myvoices").then((r) => { setMine(r.voices); if (r.voices[0]) setVoice((v) => v || r.voices[0].name); }).catch(() => {});
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (j.library) api<{ results: { id: string; audio: string }[] }>(`library/${id}`).then((l) => setAudio(l.results[0]?.audio ?? null)).catch(() => {});
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !j.library)) timer.current = setTimeout(() => poll(id), 1500);
    } catch (e) {
      setErr((e as Error).message);
      timer.current = setTimeout(() => poll(id), 4000);
    }
  }
  async function go() {
    if (!file) return setErr("Add a take first: upload it or record it.");
    setErr(""); setJob(null); setAudio(null);
    try {
      setUpFrac(0);
      const key = await uploadFile(file, file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "performance.wav", setUpFrac);
      setUpFrac(null);
      const j = await api<Job>("jobs", { body: { kind: "revoice", source_key: key, voice: voice || "female", platform, subtitles, label: `Re-voice · ${file.name.slice(0, 50)}` } });
      forget.current?.(); forget.current = null;
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 800);
    } catch (e) { setUpFrac(null); setErr((e as Error).message); }
  }
  useResumeJob<Job>(["revoice"], (j) => { setJob(j); timer.current = setTimeout(() => poll(j.id), 300); });
  const busy = upFrac !== null || (!!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library)));
  const offline = !!status && !status.online;
  const voices = [...mine.map((m) => [m.name, m.label] as const), ["female", "Female preset"] as const, ["male", "Male preset"] as const];

  return (
    <ToolPage title="Re-voice" sub="A rough take of yourself in, your clean voice out. Timing and emotion stay yours."
      actions={<Link href="/voices" className="btn ghost"><ArrowLeft size={15} />Voices</Link>}
      side={
        <>
          <SideRow label="Speak it as" htmlFor="rv-voice" aside={<Link href="/voices/new" className="linkish u">New voice</Link>}>
            <Select id="rv-voice" value={voice || "female"} onChange={setVoice} options={voices} />
          </SideRow>
          <SideRow label="Publish for" htmlFor="rv-platform" info="Sets loudness mastering and the caption style for that platform.">
            <Select id="rv-platform" value={platform} onChange={setPlatform} options={PLATFORMS} />
          </SideRow>
          <div className="set-row"><div className="set-line"><span>Subtitles and voice match</span>
            <button role="switch" aria-checked={subtitles} className={`switch ${subtitles ? "on" : ""}`} onClick={() => setSubtitles(!subtitles)} aria-label="Subtitles and voice match" /></div></div>
          <div className="tool-go">
            {offline ? <Link href="/settings?tab=gpu" className="btn block"><Power size={15} weight="bold" />Start the GPU</Link>
              : <button className="block" onClick={go} disabled={busy || !status}><ArrowsClockwise size={16} weight="bold" />{busy ? "Re-voicing…" : "Re-voice"}</button>}
            <span className="tiny dim">Up to 15 minutes. It lines up with your video frame for frame.</span>
          </div>
        </>
      }>
      <div className="tool-canvas">
        <div className="row between"><SourcePick src={src} setSrc={(s) => { setSrc(s); setFile(null); }} /></div>
        {src === "upload" ? (file ? <FilePreview file={file} onRemove={() => setFile(null)} />
          : <DropZone icon={<UploadSimple size={22} />} title="Drop your take here" hint="or click to choose · audio or video · a phone memo, a screen recording, a rough take" accept="audio/*,video/*" onFiles={(f) => f[0] && setFile(f[0])} />)
          : <Recorder scope="revoice" onReady={(f, fg) => { setFile(f); forget.current = fg ?? null; }} hint="Perform it the way you want it to sound. It's saved on this device as you go." />}
        {err && <p className="err" role="alert">{err}</p>}
        {(job || upFrac !== null) && <JobProgress job={job} kind="tts" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} onCancel={job ? () => api(`jobs/${job.id}/cancel`, { body: {} }) : undefined} />}
        {job?.library && job.results[0] ? (
          <div className="lines-box"><LineRow jobId={job.id} line={job.results[0]} audio={audio ?? job.results[0].url} slug={`revoice-${job.voice}`} /></div>
        ) : !job && !file && <Empty icon={<ArrowsClockwise size={20} />} title="Your re-voiced take appears here">Same length as the original, in your clean voice, mastered for where it&apos;s going.</Empty>}
      </div>
    </ToolPage>
  );
}
