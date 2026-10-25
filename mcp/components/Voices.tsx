"use client";
import {
  ArrowCounterClockwise, ArrowRight, ArrowsClockwise, CheckCircle, Lightbulb, MagnifyingGlass, Microphone, Shuffle, Stop, TrashSimple, UploadSimple, WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, uploadFile, type Job, type MyVoice } from "./api";
import { Info } from "./Info";
import { VoiceGlyph } from "./art";
import { useDialog } from "./Dialog";
import { GuideButton } from "./GuideDrawer";
import { describeVoice as describe, KOKORO_LANG, KOKORO_VOICES, LANGUAGES, ORPHEUS_VOICES } from "./guides";
import JobProgress from "./JobProgress";
import { useResumeJob } from "./jobs";
import LineRow from "./LineRow";
import Player from "./Player";
import { SampleButton, useSamples } from "./Sample";
import { useStatus } from "./Shell";
import { Empty, PageHeader } from "./ui";
import { PauseButton, SavedTakes, startRecording, VoiceOrb, VoiceSeed, type Recording } from "./Recorder";

const READS = [
  "Okay, so here's something wild. Your phone figures out exactly where you are by listening to clocks in space. Twenty thousand kilometres up, a few billionths of a second, and some very clever math. Let me show you how it works.",
  "Alright, let's break this down. Every time you hit send, your message gets chopped into tiny packets, races across the planet, and gets stitched back together in under a second. Sounds simple, right? It really isn't.",
  "Here's the thing nobody tells you about batteries. They don't actually store electricity. They store chemistry, and the whole trick is getting that chemistry to move exactly when you want it to. So, how does that work?",
];
const TIPS = [
  ["Quiet room", "Soft furnishings, no music, fans or TV. The clone copies the room too."],
  ["15-20 cm away", "A hand's width from the mic, slightly to the side so p and b don't pop."],
  ["Read like the video", "Energy, pace and attitude carry over. Excited in, excited out."],
  ["15-20 seconds", "Read the whole card. Longer takes keep the first 20 s (or up to 60 s: pick it under the record button)."],
  ["Bad mic? Fine.", "The studio enhancer removes noise and echo and restores detail before cloning (Settings)."],
];
const ENGINES = [
  { id: "orpheus", name: "Orpheus", note: "Most human · English" },
  { id: "kokoro", name: "Kokoro", note: "Instant · 9 languages" },
  { id: "chatterbox", name: "Chatterbox", note: "Emotion · 23 languages" },
  { id: "qwen", name: "Qwen", note: "Cloner · presets" },
] as const;
const VOICES: Record<string, string[]> = { orpheus: Object.keys(ORPHEUS_VOICES), kokoro: KOKORO_VOICES, chatterbox: ["female", "male"], qwen: ["female", "male"] };

type Phase = "idle" | "asking" | "recording" | "review" | "saving";

/** Live input meter drawn from an AnalyserNode. */
function useLevel(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream) return;
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0;
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      setLevel((l) => Math.max(peak, l * 0.9));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => { cancelAnimationFrame(raf); ctx.close(); };
  }, [stream]);
  return level;
}

function Recorder({ onSaved }: { onSaved: (v: MyVoice) => void }) {
  const { status } = useStatus();
  const [phase, setPhase] = useState<Phase>("idle");
  const [read, setRead] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [secs, setSecs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [take, setTake] = useState<{ blob: Blob; url: string; name: string } | null>(null);
  const [label, setLabel] = useState("");
  const [cap, setCap] = useState(20); // seconds of the take the clone engines get
  const [job, setJob] = useState<Job | null>(null);
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const rec = useRef<Recording | null>(null);
  const forget = useRef<(() => void) | null>(null); // drops the take from this device once it's saved as a voice
  const [kept, setKept] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const level = useLevel(stream);
  const peakHold = useRef(0);
  peakHold.current = Math.max(peakHold.current * 0.995, level);

  useEffect(() => () => { stream?.getTracks().forEach((t) => t.stop()); if (timer.current) clearTimeout(timer.current); }, [stream]);
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setSecs(rec.current?.elapsed() ?? 0), 100);
    return () => clearInterval(t);
  }, [phase]);

  async function start() {
    setErr(""); setPhase("asking");
    try {
      // raw input: browser noise suppression / AGC leave artefacts the cloner would copy; the worker cleans instead.
      // Saved to this device every second, so a refresh mid-take doesn't lose it (SavedTakes offers it back).
      const r = await startRecording("voices", READS[read].slice(0, 24) + "…");
      rec.current = r;
      setStream(r.stream);
      setSecs(0);
      setPaused(false);
      setPhase("recording");
    } catch (e) {
      setPhase("idle");
      setErr((e as Error).name === "NotAllowedError" ? "Microphone access was blocked. Allow it in the address bar and try again." : (e as Error).message);
    }
  }

  async function stop() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    const f = await r.stop();
    setStream(null);
    forget.current = r.forget;
    setKept(r.take.id);
    setTake({ blob: f, url: URL.createObjectURL(f), name: f.name });
    setPhase("review");
  }
  useEffect(() => { if (phase === "recording" && secs >= 45) stop(); }, [phase, secs]);
  useEffect(() => () => { rec.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  const slug = (label || "my-voice").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "my-voice";

  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (j.myvoice) { onSaved(j.myvoice); return; }
      if (j.status === "error" || j.status === "cancelled") return;
      timer.current = setTimeout(() => poll(id), 1500);
    } catch (e) { setErr((e as Error).message); timer.current = setTimeout(() => poll(id), 4000); }
  }

  async function save() {
    if (!take) return;
    setErr(""); setPhase("saving"); setJob(null);
    try {
      setUpFrac(0);
      const key = await uploadFile(take.blob, take.name, setUpFrac);
      setUpFrac(null);
      const j = await api<Job>("myvoices", { body: { name: slug, label: label || "My voice", key, max_seconds: cap } });
      forget.current?.(); forget.current = null; setKept(null);
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 1000);
    } catch (e) { setUpFrac(null); setErr((e as Error).message); setPhase("review"); }
  }

  useResumeJob<Job>(["reference"], (j) => { setPhase("saving"); setJob(j); timer.current = setTimeout(() => poll(j.id), 300); });
  const reset = () => {
    if (phase === "review") { forget.current?.(); forget.current = null; } // a retake replaces this take
    setKept(null); setTake(null); setJob(null); setPhase("idle"); setErr("");
  };
  const segs = 28, lit = Math.round(Math.min(1, level * 1.4) * segs);
  const progress = Math.min(1, secs / 20);

  return (
    <div className="card recorder">
      <div className="rec-main">
        {phase === "idle" || phase === "asking" ? (
          <div className="rec-idle">
            <VoiceSeed onClick={start} disabled={phase === "asking"} label="Start recording" />
            <b>{phase === "asking" ? "Allow the microphone…" : "Record your voice"}</b>
            <span className="dim small">Read the card on the right, about 20 seconds.{" "}
              <button className="linkish" onClick={() => fileIn.current?.click()}>Upload a file instead</button></span>
            <label className="row tiny dim" style={{ gap: 6 }}>Keep up to
              <select aria-label="Keep up to" value={cap} onChange={(e) => setCap(Number(e.target.value))} style={{ width: "auto" }}>
                {[20, 30, 45, 60].map((v) => <option key={v} value={v}>{v} s{v === 20 ? " (best for cloning)" : ""}</option>)}</select></label>
            <input ref={fileIn} type="file" accept="audio/*,video/*" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) { forget.current = null; setTake({ blob: f, url: URL.createObjectURL(f), name: f.name }); setLabel(f.name.replace(/\.[^.]+$/, "")); setPhase("review"); }
            }} />
            <div style={{ width: "100%", maxWidth: 380, marginTop: 10 }}>
              <SavedTakes scope="voices" live={kept} onUse={(f, t) => {
                forget.current = () => import("./takes").then((m) => m.dropTake(t.id)); setKept(t.id);
                setTake({ blob: f, url: URL.createObjectURL(f), name: f.name }); setPhase("review");
              }} />
            </div>
          </div>
        ) : phase === "recording" ? (
          <div className="rec-live">
            <div className="rec-clock"><span className={`recdot ${paused ? "held" : ""}`}><i />{paused ? "PAUSED" : "REC"}</span><span className="num">{secs.toFixed(1)}<small>s</small></span></div>
            <VoiceOrb stream={stream} size={232} target={20} secs={secs} paused={paused}>
              <button className="rec-btn on" onClick={stop} aria-label="Stop recording"><Stop size={26} weight="fill" /></button>
            </VoiceOrb>
            {rec.current && <div style={{ alignSelf: "center" }}><PauseButton rec={rec.current} paused={paused} onChange={setPaused} /></div>}
            <div className="dim small">{paused ? "Paused. Nothing is recorded until you resume; stop when you're done." : level > 0.95 ? "Too loud: back off a little" : level < 0.05 && secs > 1.5 ? "Very quiet: come closer" : secs < 10 ? "Keep going…" : secs < 20 ? "Good. Finish the card." : "Perfect. Stop whenever you like."}</div>
          </div>
        ) : (
          <div className="rec-review">
            {take && <Player src={take.url} />}
            <div className="field" style={{ margin: "14px 0 0" }}>
              <label className="f" htmlFor="rec-label">Name this voice</label>
              <input id="rec-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sparsh, energetic" disabled={phase === "saving"} />
              <div className="dim tiny mono" style={{ marginTop: 4 }}>id: {slug}</div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="ghost" onClick={reset} disabled={phase === "saving" && !job?.myvoice && job?.status !== "error"}><ArrowCounterClockwise size={15} />Retake</button>
              <button className="sig" onClick={save} disabled={phase === "saving" || !status?.online}><CheckCircle size={16} weight="bold" />Save voice</button>
            </div>
            {!status?.online && <div className="dim tiny" style={{ marginTop: 6 }}>Saving needs the GPU worker (it cleans the audio and transcribes it).</div>}
          </div>
        )}
        {err && <p className="err" style={{ marginTop: 10 }}>{err}</p>}
        {phase === "saving" && (job || upFrac !== null) && (
          <div style={{ marginTop: 14 }}>
            <JobProgress job={job} kind="reference" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} />
            {job?.myvoice && <button className="ghost sm" style={{ marginTop: 10 }} onClick={reset}><Microphone size={14} />Record another</button>}
          </div>
        )}
      </div>

      <div className="rec-side">
        <div className="row between">
          <b className="small">Read this out loud</b>
          <button className="quiet xs" onClick={() => setRead((read + 1) % READS.length)}><Shuffle size={13} />Another</button>
        </div>
        <p className="read-card">{READS[read]}</p>
        <details className="tips-more">
          <summary><Lightbulb size={14} weight="duotone" /> Recording tips</summary>
          <div className="tips">
            {TIPS.map(([h, b]) => (
              <div key={h} className="tip-row"><div><b>{h}</b><span className="dim small">{b}</span></div></div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

const PLATFORMS = [["youtube", "YouTube"], ["shorts", "Shorts"], ["reels", "Reels"], ["tiktok", "TikTok"], ["podcast", "Podcast"], ["raw", "Raw"]] as const;

/** Speech-to-speech: upload any take of yourself (voice memo, screen recording, video) and get it back in a recorded
 *  voice with studio clarity; timing and emotion stay yours, so it drops straight back onto the edit. */
function Revoice({ mine }: { mine: MyVoice[] }) {
  const { status } = useStatus();
  const [file, setFile] = useState<File | null>(null);
  const [voice, setVoice] = useState("");
  const [platform, setPlatform] = useState("youtube");
  const [subtitles, setSubtitles] = useState(true);
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (!voice && mine.length) setVoice(mine[0].name); }, [mine, voice]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

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
    if (!file) return;
    setErr(""); setJob(null); setAudio(null);
    try {
      setUpFrac(0);
      const key = await uploadFile(file, file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "performance.wav", setUpFrac);
      setUpFrac(null);
      const j = await api<Job>("jobs", { body: { kind: "revoice", source_key: key, voice: voice || "female", platform, subtitles,
        label: `Re-voice · ${file.name.slice(0, 50)}` } });
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 800);
    } catch (e) {
      setUpFrac(null);
      setErr((e as Error).message);
    }
  }

  useResumeJob<Job>(["revoice"], (j) => { setJob(j); timer.current = setTimeout(() => poll(j.id), 300); });
  const busy = upFrac !== null || (!!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library)));
  const voices = [...mine.map((m) => [m.name, m.label] as const), ["female", "female preset"] as const, ["male", "male preset"] as const];
  return (
    <div className="card">
      <div className="card-head"><div><h2><ArrowsClockwise size={18} /> Re-voice a take</h2><p className="sub">A rough take of yourself in, your clean voice out, same timing.</p></div><Info label="Re-voice">Record yourself anywhere (a phone memo, a screen recording, a rough take) and get it back in your clean voice. Timing, emphasis and emotion stay, so it lines up with the video frame for frame. Up to 15 minutes.</Info></div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
        <div className="field" style={{ margin: 0 }}>
          <span className="f" style={{ display: "block", font: "500 13px var(--sans)", color: "var(--ink2)", marginBottom: 6 }}>Performance (audio or video)</span>
          <label className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start", overflow: "hidden" }}>
            <UploadSimple size={14} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? file.name : "Choose a file"}</span>
            <input type="file" accept="audio/*,video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="f" htmlFor="rv-voice">Speak it as</label>
          <select id="rv-voice" value={voice} onChange={(e) => setVoice(e.target.value)}>{voices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="f" htmlFor="rv-platform">Publish for</label>
          <select id="rv-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>{PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
      </div>
      <div className="row between" style={{ marginTop: 12 }}>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} />Subtitles + voice match score</label>
        <button className="sig" onClick={go} disabled={!file || busy || !status?.online}><ArrowsClockwise size={16} weight="bold" />Re-voice</button>
      </div>
      {!status?.online && <div className="dim tiny" style={{ marginTop: 6 }}>Needs the GPU worker online.</div>}
      {err && <p className="err" style={{ marginTop: 10 }}>{err}</p>}
      {(job || upFrac !== null) && (
        <div style={{ marginTop: 14 }}>
          <JobProgress job={job} kind="tts" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} onCancel={job ? () => api(`jobs/${job.id}/cancel`, { body: {} }) : undefined} />
        </div>
      )}
      {job?.library && job.results[0] && (
        <div style={{ marginTop: 12 }}>
          <LineRow jobId={job.id} line={job.results[0]} audio={audio ?? job.results[0].url} slug={`revoice-${job.voice}`} />
        </div>
      )}
    </div>
  );
}

type Learnt = { jobs: number; usual_similarity?: number | null; best_temperature?: number | null };

/** What the review has learned about this voice on Qwen (tech delivery): its usual voice match and best temperature. */
function Learned({ voice }: { voice: string }) {
  const [p, setP] = useState<Learnt | null>(null);
  useEffect(() => { api<Learnt>(`profile/qwen/${voice}`).then(setP).catch(() => {}); }, [voice]);
  if (!p || !p.jobs) return null;
  return (
    <div className="tiny dim" style={{ marginTop: 8 }}>
      Learned from {p.jobs} voiceover{p.jobs > 1 ? "s" : ""}
      {p.usual_similarity != null && <> · usually {Math.round(p.usual_similarity * 100)}% like you</>}
      {p.best_temperature != null && <> · best temperature {p.best_temperature}</>}
    </div>
  );
}

export default function Voices() {
  const samples = useSamples();
  const { confirm, toast } = useDialog();
  const [mine, setMine] = useState<MyVoice[] | null>(null);
  const [engine, setEngine] = useState<string>("orpheus");
  const [lang, setLang] = useState("en");
  const [tab, setTab] = useState<"mine" | "library">("mine");
  const [recording, setRecording] = useState(false);
  const [q, setQ] = useState("");

  const load = () => api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => setMine([]));
  useEffect(() => {
    load();
    const p = new URLSearchParams(location.search);
    if (p.get("record")) setRecording(true);
    if (location.hash === "#revoice") setTimeout(() => document.getElementById("revoice")?.scrollIntoView({ behavior: "smooth" }), 300);
  }, []);
  useEffect(() => { if (mine && !mine.length) setTab((t) => (t === "mine" && !recording ? "library" : t)); }, [mine, recording]);

  const list = useMemo(() => (engine === "kokoro" ? VOICES.kokoro.filter((v) => KOKORO_LANG[v[0]] === lang) : VOICES[engine]).filter((v) => !q || `${v} ${describe(engine, v)}`.toLowerCase().includes(q.toLowerCase())), [engine, lang, q]);
  const have = samples?.voices[engine] ?? {};
  const missing = list.filter((v) => !have[v]).length;
  const shownMine = (mine ?? []).filter((v) => !q || `${v.label} ${v.name} ${v.transcript}`.toLowerCase().includes(q.toLowerCase()));

  async function remove(v: MyVoice) {
    if (!(await confirm({ title: `Delete “${v.label}”?`, body: "The recording and its transcript are removed from storage. Takes you already made with it stay in Files.", confirm: "Delete voice", danger: true }))) return;
    await api(`myvoices/${v.name}`, { method: "DELETE" }).then(() => { toast("Voice deleted", "ok"); load(); }).catch((e) => toast((e as Error).message, "bad"));
  }

  return (
    <>
      <PageHeader title="Voices" sub="Audition the built-in voices, or clone your own in 20 seconds."
        actions={<><GuideButton engine="qwen" label="Recording guide" /><button onClick={() => setRecording(!recording)} aria-expanded={recording}><Microphone size={15} weight="bold" />{recording ? "Close recorder" : "Clone your voice"}</button></>} />

      {recording && (
        <section className="section" style={{ marginTop: 0, marginBottom: 28 }} aria-label="Clone your voice">
          <Recorder onSaved={(v) => { toast(`“${v.label}” is ready to use`, "ok"); load(); setTab("mine"); }} />
        </section>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "mine"} className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")}>My voices<span className="count">{mine?.length ?? ""}</span></button>
        <button role="tab" aria-selected={tab === "library"} className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>Built-in voices<span className="count">{Object.values(VOICES).reduce((n, v) => n + v.length, 0)}</span></button>
      </div>
      <div className="vlib-tools">
        <div className="searchbox" style={{ maxWidth: 320 }}><MagnifyingGlass size={15} className="ic" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === "mine" ? "Search your voices" : "Search voices"} aria-label="Search voices" /></div>
        {tab === "library" && (
          <div className="seg" role="radiogroup" aria-label="Engine">
            {ENGINES.map((e) => <button key={e.id} role="radio" aria-checked={engine === e.id} className={engine === e.id ? "on" : ""} onClick={() => setEngine(e.id)}>{e.name}<span className="faint tiny" style={{ marginLeft: 6 }}>{VOICES[e.id].length}</span></button>)}
          </div>
        )}
      </div>

      {tab === "mine" ? (
        mine === null ? <div className="skel" style={{ height: 160 }} /> : !mine.length ? (
          <Empty icon={<Microphone size={22} />} title="No voices of your own yet" action={<button className="sm" onClick={() => setRecording(true)}><Microphone size={14} weight="bold" />Clone your voice</button>}>
            Read a short card out loud and your voice is ready for any script. For the most natural result, train a <Link className="linkish u" href="/model">voice model</Link> later.
          </Empty>
        ) : (
          <div className="card" style={{ padding: "4px 18px" }}>
            {shownMine.map((v) => (
              <div key={v.name} className="vrow reveal">
                <VoiceGlyph name={v.name} size={48} />
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}><b style={{ fontSize: 15 }}>{v.label}</b><span className="mono faint tiny">{v.name}</span><span className="tiny faint">{v.duration.toFixed(1)} s · {ago(v.created)}</span>
                    {v.enhanced && <span className="pill ok" title="Cleaned by the studio enhancer: noise and echo removed, detail restored">Studio-enhanced</span>}</div>
                  <p className="quote clamp2">“{v.transcript}”</p>
                  {v.url && <Player src={v.url} compact />}
                  <Learned voice={v.name} />
                  {v.warnings?.map((w) => <div key={w} className="tiny" style={{ color: "var(--warn)", marginTop: 6 }}><WarningCircle size={12} /> {w}</div>)}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Link className="btn ghost sm" href={`/voiceover?engine=chatterbox&voice=${v.name}`} title="Use with Chatterbox (emotion, 23 languages)">Chatterbox</Link>
                  <Link className="btn sm" href={`/voiceover?engine=qwen&voice=${v.name}`}>Use<ArrowRight size={13} /></Link>
                  <button className="icon-btn danger-h" onClick={() => remove(v)} aria-label={`Delete ${v.label}`}><TrashSimple size={16} /></button>
                </div>
              </div>
            ))}
            {!shownMine.length && <p className="small dim" style={{ padding: "16px 0" }}>No voice matches “{q}”.</p>}
          </div>
        )
      ) : (
        <>
          {engine === "kokoro" && (
            <div className="chips" style={{ marginBottom: 14 }} role="radiogroup" aria-label="Language">
              {LANGUAGES.filter((l) => l.engines.includes("kokoro")).map((l) => <button key={l.code} role="radio" aria-checked={lang === l.code} className={`chip ${lang === l.code ? "on" : ""}`} onClick={() => setLang(l.code)}>{l.name}</button>)}
            </div>
          )}
          {samples && missing > 0 && <p className="small dim" style={{ margin: "0 0 12px" }}>{missing} of these {missing === 1 ? "voice has" : "voices have"} no sample yet.</p>}
          <div className="vgrid">
            {list.map((v) => (
              <div key={v} className="vcard">
                <VoiceGlyph name={engine === "qwen" || engine === "chatterbox" ? (v === "male" ? "dan" : "tara") : v} size={44} />
                <div className="vc-name"><b>{v}</b><span>{ENGINES.find((e) => e.id === engine)?.name} · {describe(engine, v)}{have[v] ? ` · ${have[v].duration.toFixed(1)} s` : ""}</span></div>
                <div className="vc-act">
                  {have[v]?.url && <SampleButton id={`${engine}/${v}`} url={have[v].url} size={32} label={v} />}
                  <Link className="btn ghost sm" href={`/voiceover?engine=${engine}&voice=${v}`} aria-label={`Use ${v} in a voiceover`}>Use</Link>
                </div>
              </div>
            ))}
          </div>
          {samples?.text && Object.keys(samples.text).length > 0 && <p className="tiny faint" style={{ marginTop: 12 }}>Every voice reads the same line: “{samples.text[`${engine}/${list[0]}`] ?? Object.values(samples.text)[0]}”</p>}
        </>
      )}

      {mine && <section className="section" id="revoice"><Revoice mine={mine} /></section>}
    </>
  );
}
