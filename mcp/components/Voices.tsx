"use client";
import {
  ArrowCounterClockwise, ArrowRight, ArrowsClockwise, CheckCircle, Lightbulb, Microphone, Shuffle, Stop, TrashSimple, UploadSimple, WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, uploadFile, type Job, type MyVoice } from "./api";
import { MicArt, VoiceGlyph } from "./art";
import { useDialog } from "./Dialog";
import { GuideButton } from "./GuideDrawer";
import { KOKORO_LANG, LANGUAGES } from "./guides";
import JobProgress from "./JobProgress";
import LineRow from "./LineRow";
import Player from "./Player";
import { SampleButton, useSamples } from "./Sample";
import { useStatus } from "./Shell";

const READS = [
  "Okay, so here's something wild. Your phone figures out exactly where you are by listening to clocks in space. Twenty thousand kilometres up, a few billionths of a second, and some very clever math. Let me show you how it works.",
  "Alright, let's break this down. Every time you hit send, your message gets chopped into tiny packets, races across the planet, and gets stitched back together in under a second. Sounds simple, right? It really isn't.",
  "Here's the thing nobody tells you about batteries. They don't actually store electricity. They store chemistry, and the whole trick is getting that chemistry to move exactly when you want it to. So, how does that work?",
];
const TIPS = [
  ["Quiet room", "Soft furnishings, no music, fans or TV. The clone copies the room too."],
  ["15-20 cm away", "A hand's width from the mic, slightly to the side so p and b don't pop."],
  ["Read like the video", "Energy, pace and attitude carry over. Excited in, excited out."],
  ["15-20 seconds", "Read the whole card. Longer takes are trimmed to the best ~20 s."],
  ["Bad mic? Fine.", "The studio enhancer removes noise and echo and restores detail before cloning (Settings)."],
];
const ENGINES = [
  { id: "orpheus", name: "Orpheus", note: "Most human · English" },
  { id: "kokoro", name: "Kokoro", note: "Instant · 9 languages" },
  { id: "chatterbox", name: "Chatterbox", note: "Emotion · 23 languages" },
  { id: "qwen", name: "Qwen", note: "Cloner · presets shown" },
] as const;
const ORPHEUS: Record<string, string> = { tara: "female", leah: "female", jess: "female", mia: "female", zoe: "female", leo: "male", dan: "male", zac: "male" };
const KOKORO_VOICES = ["af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "af_alloy", "af_nova", "af_sky", "af_jessica", "af_river", "am_fenrir", "am_michael", "am_puck", "am_echo", "am_eric", "am_liam", "am_onyx", "am_santa", "am_adam", "bf_emma", "bf_isabella", "bf_alice", "bf_lily", "bm_fable", "bm_george", "bm_lewis", "bm_daniel", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "ff_siwis", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune", "jm_kumo", "ef_dora", "em_alex", "pf_dora", "pm_alex", "zf_xiaobei", "zf_xiaoxiao", "zm_yunjian", "zm_yunxi"];
const VOICES: Record<string, string[]> = { orpheus: Object.keys(ORPHEUS), kokoro: KOKORO_VOICES, chatterbox: ["female", "male"], qwen: ["female", "male"] };
const ACCENT: Record<string, string> = { a: "American", b: "British" };

function describe(engine: string, v: string) {
  if (engine === "orpheus") return ORPHEUS[v];
  if (engine === "kokoro") {
    const lang = LANGUAGES.find((l) => l.code === KOKORO_LANG[v[0]])?.name ?? "";
    return `${v[1] === "f" ? "female" : "male"} · ${ACCENT[v[0]] ?? lang}`;
  }
  return `${v} preset`;
}

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
  const [take, setTake] = useState<{ blob: Blob; url: string; name: string } | null>(null);
  const [label, setLabel] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const rec = useRef<MediaRecorder | null>(null);
  const t0 = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const level = useLevel(stream);
  const peakHold = useRef(0);
  peakHold.current = Math.max(peakHold.current * 0.995, level);

  useEffect(() => () => { stream?.getTracks().forEach((t) => t.stop()); if (timer.current) clearTimeout(timer.current); }, [stream]);
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setSecs((performance.now() - t0.current) / 1000), 100);
    return () => clearInterval(t);
  }, [phase]);

  async function start() {
    setErr(""); setPhase("asking");
    try {
      // raw input: browser noise suppression / AGC leave artefacts the cloner would copy; the worker cleans instead
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      setStream(s);
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        s.getTracks().forEach((t) => t.stop());
        setStream(null);
        const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
        setTake({ blob, url: URL.createObjectURL(blob), name: `recording.${(r.mimeType || "audio/webm").includes("mp4") ? "m4a" : "webm"}` });
        setPhase("review");
      };
      rec.current = r;
      r.start(250);
      t0.current = performance.now();
      setSecs(0);
      setPhase("recording");
    } catch (e) {
      setPhase("idle");
      setErr((e as Error).name === "NotAllowedError" ? "Microphone access was blocked. Allow it in the address bar and try again." : (e as Error).message);
    }
  }

  const stop = () => rec.current?.state === "recording" && rec.current.stop();
  useEffect(() => { if (phase === "recording" && secs >= 45) stop(); }, [phase, secs]);

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
      const j = await api<Job>("myvoices", { body: { name: slug, label: label || "My voice", key } });
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 1000);
    } catch (e) { setUpFrac(null); setErr((e as Error).message); setPhase("review"); }
  }

  const reset = () => { setTake(null); setJob(null); setPhase("idle"); setErr(""); };
  const segs = 28, lit = Math.round(Math.min(1, level * 1.4) * segs);
  const progress = Math.min(1, secs / 20);

  return (
    <div className="card recorder">
      <div className="rec-main">
        {phase === "idle" || phase === "asking" ? (
          <div className="rec-idle">
            <MicArt />
            <button className="rec-btn" onClick={start} disabled={phase === "asking"} aria-label="Start recording"><Microphone size={28} weight="fill" /></button>
            <b>{phase === "asking" ? "Allow the microphone…" : "Record your voice"}</b>
            <span className="dim small">Read the card on the right, about 20 seconds.{" "}
              <button className="linkish" onClick={() => fileIn.current?.click()}>Upload a file instead</button></span>
            <input ref={fileIn} type="file" accept="audio/*,video/*" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) { setTake({ blob: f, url: URL.createObjectURL(f), name: f.name }); setLabel(f.name.replace(/\.[^.]+$/, "")); setPhase("review"); }
            }} />
          </div>
        ) : phase === "recording" ? (
          <div className="rec-live">
            <div className="rec-clock"><span className="recdot"><i />REC</span><span className="num">{secs.toFixed(1)}<small>s</small></span></div>
            <div className="led big" aria-label="Input level">
              {Array.from({ length: segs }, (_, i) => <i key={i} className={`${i / segs < 0.7 ? "g" : i / segs < 0.88 ? "a" : "r"} ${i < lit ? "on" : ""}`} />)}
            </div>
            <div className="dim tiny">{level > 0.95 ? "Too loud: back off a little" : level < 0.05 && secs > 1.5 ? "Very quiet: come closer" : secs < 10 ? "Keep going…" : secs < 20 ? "Good. Finish the card." : "Perfect. Stop whenever you like."}</div>
            <div className="bar thin live" style={{ width: "100%" }}><i style={{ width: `${progress * 100}%`, background: secs >= 10 ? "var(--ok)" : undefined }} /></div>
            <button className="rec-btn on" onClick={stop} aria-label="Stop recording"><Stop size={26} weight="fill" /></button>
          </div>
        ) : (
          <div className="rec-review">
            {take && <Player src={take.url} />}
            <div className="field" style={{ margin: "14px 0 0" }}>
              <label className="f">Name this voice</label>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sparsh, energetic" disabled={phase === "saving"} />
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
          <div className="label">Read this</div>
          <button className="quiet xs" onClick={() => setRead((read + 1) % READS.length)}><Shuffle size={13} />Another</button>
        </div>
        <p className="read-card">{READS[read]}</p>
        <div className="tips">
          {TIPS.map(([h, b]) => (
            <div key={h} className="tip-row"><Lightbulb size={15} weight="duotone" /><div><b>{h}</b><span className="dim small">{b}</span></div></div>
          ))}
        </div>
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

  const busy = upFrac !== null || (!!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library)));
  const voices = [...mine.map((m) => [m.name, m.label] as const), ["female", "female preset"] as const, ["male", "male preset"] as const];
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-head"><h2><ArrowsClockwise size={18} weight="duotone" /> Re-voice a take</h2><span className="dim tiny">your performance, studio voice</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>
        Record yourself anywhere (a phone voice memo, a screen recording, a rough take) and get it back in your clean recorded voice.
        Your timing, emphasis and emotion stay, so it lines up with the original video frame for frame. Up to 15 minutes.
      </p>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
        <div className="field" style={{ margin: 0 }}>
          <label className="f">Performance (audio or video)</label>
          <label className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start", overflow: "hidden" }}>
            <UploadSimple size={14} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? file.name : "Choose a file"}</span>
            <input type="file" accept="audio/*,video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="f">Speak it as</label>
          <select value={voice} onChange={(e) => setVoice(e.target.value)}>{voices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="f">Publish for</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>{PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
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
  if (!p || !p.jobs) return <div className="tiny faint" style={{ marginTop: 8 }}>Learning: every reviewed voiceover teaches this voice its best settings.</div>;
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

  const load = () => api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => setMine([]));
  useEffect(() => { load(); }, []);

  const list = useMemo(() => (engine === "kokoro" ? VOICES.kokoro.filter((v) => KOKORO_LANG[v[0]] === lang) : VOICES[engine]), [engine, lang]);
  const have = samples?.voices[engine] ?? {};
  const missing = list.filter((v) => !have[v]).length;

  async function remove(v: MyVoice) {
    if (!(await confirm({ title: `Delete “${v.label}”?`, body: "The recording and its transcript are removed from storage. Takes you already generated with it stay in the Library.", confirm: "Delete voice", danger: true }))) return;
    await api(`myvoices/${v.name}`, { method: "DELETE" }).then(() => { toast("Voice deleted", "ok"); load(); }).catch((e) => toast((e as Error).message, "bad"));
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Cast</div>
          <h1>Hear them <em>first.</em></h1>
          <p className="sub">Audition every voice before you write a word, or record your own and let Qwen read your scripts in it.</p>
        </div>
        <GuideButton engine="qwen" label="Recording guide" />
      </div>

      <h2 className="section-h">Your voice</h2>
      <Recorder onSaved={(v) => { toast(`“${v.label}” is ready to use`, "ok"); load(); }} />

      {mine && mine.length > 0 && (
        <div className="stack" style={{ gap: 10, marginTop: 14 }}>
          {mine.map((v) => (
            <div key={v.name} className="card myvoice reveal">
              <VoiceGlyph name={v.name} size={52} />
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 10 }}><b style={{ font: "600 19px var(--display)", letterSpacing: "-.02em" }}>{v.label}</b><span className="mono dim tiny">{v.name}</span><span className="dim tiny">{v.duration.toFixed(1)} s · {ago(v.created)}</span>
                  {v.enhanced && <span className="pill ok" title="Cleaned by the studio enhancer: noise and echo removed, detail restored">studio-enhanced</span>}</div>
                <p className="dim small clamp2" style={{ margin: "4px 0 10px" }}>“{v.transcript}”</p>
                {v.url && <Player src={v.url} compact />}
                <Learned voice={v.name} />
                {v.warnings?.map((w) => <div key={w} className="tiny" style={{ color: "var(--warn)", marginTop: 6 }}><WarningCircle size={12} /> {w}</div>)}
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <Link className="btn sm" href={`/generate?engine=qwen&voice=${v.name}`}>Use with Qwen<ArrowRight size={13} /></Link>
                <Link className="btn ghost sm" href={`/generate?engine=chatterbox&voice=${v.name}`}>Chatterbox</Link>
                <button className="icon-btn danger-h" onClick={() => remove(v)} aria-label="Delete voice" style={{ alignSelf: "flex-end" }}><TrashSimple size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {mine && <Revoice mine={mine} />}

      <div className="row between" style={{ marginTop: 34 }}>
        <h2 className="section-h" style={{ margin: 0 }}>Every voice, auditioned</h2>
        {samples && <span className="dim tiny">{Object.values(samples.voices).reduce((s, v) => s + Object.keys(v).length, 0)} samples · the same line for every voice</span>}
      </div>
      <div className="seg" style={{ margin: "14px 0 16px" }}>
        {ENGINES.map((e) => <button key={e.id} className={engine === e.id ? "on" : ""} onClick={() => setEngine(e.id)}>{e.name}<span className="dim tiny" style={{ marginLeft: 6 }}>{VOICES[e.id].length}</span></button>)}
      </div>
      {engine === "kokoro" && (
        <div className="chips" style={{ marginBottom: 14 }}>
          {LANGUAGES.filter((l) => l.engines.includes("kokoro")).map((l) => <button key={l.code} className={`chip ${lang === l.code ? "on" : ""}`} onClick={() => setLang(l.code)}>{l.name}</button>)}
        </div>
      )}
      {samples && missing > 0 && <p className="dim small" style={{ margin: "0 0 12px" }}><Microphone size={13} /> {missing} of these {missing === 1 ? "voice has" : "voices have"} no sample yet.</p>}
      <div className="audition">
        {list.map((v) => (
          <div key={v} className="aud-card">
            <VoiceGlyph name={engine === "qwen" || engine === "chatterbox" ? (v === "male" ? "dan" : "tara") : v} size={48} />
            <div style={{ minWidth: 0 }}>
              <b>{v}</b>
              <span className="dim tiny">{describe(engine, v)}{have[v] ? ` · ${have[v].duration.toFixed(1)} s` : ""}</span>
            </div>
            <SampleButton id={`${engine}/${v}`} url={have[v]?.url} size={34} label={v} />
            <Link className="aud-use" href={`/generate?engine=${engine}&voice=${v}`} title={`Write with ${v}`}><ArrowRight size={14} /></Link>
          </div>
        ))}
      </div>
      {samples?.text && Object.keys(samples.text).length > 0 && <p className="dim tiny" style={{ marginTop: 12 }}>Sample line: “{samples.text[`${engine}/${list[0]}`] ?? Object.values(samples.text)[0]}”</p>}
      <div style={{ height: 30 }} />
    </>
  );
}
