"use client";
// Instant voice clone: read the script on the left (pick your mic, record, pause, stop), or upload files; every take or
// file becomes a sample on the right, where the arc fills toward the best length. No limit on how many samples: they
// are joined into one clip in the browser, the worker cleans it, transcribes it and keeps up to the first minute
// (20 s to a minute clones best). The saved voice works on Qwen3-TTS and Chatterbox.
import { ArrowLeft, CheckCircle, DotsThree, Lightbulb, Microphone, Pause, Power, Stop, TrashSimple, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, clock, fmtS, uploadFile, type Job, type MyVoice } from "./api";
import { decode, durationOf, joinWav, microphones } from "./audio";
import { useDialog } from "./Dialog";
import JobProgress from "./JobProgress";
import { useResumeJob } from "./jobs";
import { Gauge, Orb } from "./Orb";
import { Select } from "./pop";
import { SampleButton } from "./Sample";
import { SavedTakes, startRecording, type Recording } from "./Recorder";
import { useStatus } from "./Shell";
import { Notice, PageHeader, PopMenu } from "./ui";

const SCRIPTS = [
  { label: "GPS, explained", text: "Okay, so here's something wild. Your phone figures out exactly where you are by listening to clocks in space. Twenty thousand kilometres up, about thirty satellites are shouting the time, over and over. Your phone hears four of them, notices that each message arrived a tiny bit late, and works backwards. A few billionths of a second, turned into a few metres on a map. And here's the part nobody tells you: those clocks run fast, because gravity is weaker up there. Einstein predicted it, and engineers correct for it every single day. Without that fix, your map would drift by about ten kilometres a day. So the next time the little blue dot finds you in a strange city, remember, you're being located by relativity. Pretty cool, right?" },
  { label: "How the internet moves", text: "Alright, let's break this down. Every time you hit send, your message gets chopped into tiny packets. Each packet gets an address, like a postcard, and then they all race across the planet on different routes. Some go under the ocean through cables thinner than a garden hose. Some bounce through a dozen routers in a dozen cities. They arrive out of order, a few get lost, and your device quietly asks for the missing ones again. Then it stitches everything back together, in under a second, before you even notice. Sounds simple, right? It really isn't. It's one of the most impressive bits of engineering humans have ever built, and it happens billions of times a minute." },
  { label: "Why batteries work", text: "Here's the thing nobody tells you about batteries. They don't actually store electricity. They store chemistry. Inside, there are two materials that really want to swap electrons, and a wall between them that won't let the electrons through. The only way across is the long way round, out through your phone, through the screen and the speaker and the radio, and back in the other side. That trip is the electricity. When you charge it, you're pushing everything back uphill, ready to roll down again. So why do batteries get worse over time? Every trip leaves a little damage behind, like footprints in a hallway. Eventually there's less room to move, and the battery holds less. Now you know." },
];
const TIPS = "Quiet room, no fans or music · a hand's width from the mic · read it like the video: energy carries over.";
const MIN_S = 10, BEST_S = 60;

type Sample = { id: string; name: string; file: File; secs: number | null; url: string; recorded: boolean; forget?: () => void };

/** Loudness of a live stream, 0-1, for the disc. */
function useLevel(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream) { setLevel(0); return; }
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0, last = 0;
    const loop = (t: number) => {
      if (t - last > 50) { // ~20 fps is plenty for the disc
        an.getFloatTimeDomainData(buf);
        let rms = 0;
        for (const x of buf) rms += x * x;
        setLevel(Math.min(1, Math.sqrt(rms / buf.length) * 4));
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ctx.close(); };
  }, [stream]);
  return level;
}

const slugOf = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "my-voice";

export default function CloneVoice() {
  const { status } = useStatus();
  const { toast } = useDialog();
  const [script, setScript] = useState(0);
  const [mics, setMics] = useState<{ id: string; name: string }[]>([]);
  const [mic, setMic] = useState("default");
  const [rec, setRec] = useState<Recording | null>(null);
  const [asking, setAsking] = useState(false);
  const [secs, setSecs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [label, setLabel] = useState("");
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [phase, setPhase] = useState<"edit" | "saving" | "done">("edit");
  const [job, setJob] = useState<Job | null>(null);
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [tried, setTried] = useState(false);
  const [over, setOver] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const level = useLevel(paused ? null : rec?.stream ?? null);

  useEffect(() => {
    microphones().then((m) => { setMics(m); if (m.length && !m.some((x) => x.id === mic)) setMic(m[0].id); }).catch(() => {});
    api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {});
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setSecs(rec.elapsed()), 100);
    return () => { clearInterval(t); rec.stream.getTracks().forEach((x) => x.stop()); };
  }, [rec]);

  async function start() {
    setErr(""); setAsking(true);
    try {
      const r = await startRecording("voices", SCRIPTS[script].label, mic);
      setSecs(0); setPaused(false); setRec(r);
      microphones().then(setMics).catch(() => {}); // names are readable now the mic is allowed
    } catch (e) {
      setErr((e as Error).name === "NotAllowedError" ? "Microphone access was blocked. Allow it in the address bar, then press Record again." : (e as Error).message);
    } finally { setAsking(false); }
  }
  async function stop() {
    const r = rec;
    if (!r) return;
    const len = r.elapsed();
    const f = await r.stop();
    setRec(null); setPaused(false); setSecs(0);
    if (len < 1) { r.forget(); return; }
    setSamples((s) => [...s, { id: r.take.id, name: `Recording ${s.filter((x) => x.recorded).length + 1}`, file: f, secs: len, url: URL.createObjectURL(f), recorded: true, forget: r.forget }]);
  }
  async function addFiles(list: FileList | File[] | null) {
    const files = Array.from(list ?? []).filter((f) => /^(audio|video)\//.test(f.type) || /\.(wav|mp3|m4a|aac|flac|ogg|opus|webm|mp4|mov)$/i.test(f.name));
    for (const f of files) {
      const id = Math.random().toString(36).slice(2);
      setSamples((s) => [...s, { id, name: f.name, file: f, secs: null, url: URL.createObjectURL(f), recorded: false }]);
      durationOf(f).then((d) => setSamples((s) => s.map((x) => (x.id === id ? { ...x, secs: d ?? -1 } : x))));
      if (!label) setLabel(f.name.replace(/\.[^.]+$/, "").slice(0, 40));
    }
  }
  function remove(x: Sample) {
    URL.revokeObjectURL(x.url);
    x.forget?.();
    setSamples((s) => s.filter((y) => y.id !== x.id));
  }

  const total = samples.reduce((n, s) => n + Math.max(0, s.secs ?? 0), 0) + (rec ? secs : 0);
  const unreadable = samples.filter((s) => s.secs === -1);
  const offline = !!status && !status.online;
  const msg = total === 0 ? "Add at least 10 seconds of samples"
    : total < MIN_S ? `${fmtS(total)} so far · add at least 10 seconds`
    : total < 20 ? `${fmtS(total)} · enough to clone; 20 seconds to a minute sounds more like you`
    : total <= BEST_S ? `${fmtS(total)} · a great length`
    : `${fmtS(total)} · plenty; the clone listens to the first minute`;

  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (j.myvoice) { setPhase("done"); toast(`“${j.myvoice.label}” is ready to use`, "ok"); return; }
      if (j.status === "error" || j.status === "cancelled") { setPhase("edit"); return; }
      timer.current = setTimeout(() => poll(id), 1500);
    } catch (e) { setErr((e as Error).message); timer.current = setTimeout(() => poll(id), 4000); }
  }
  useResumeJob<Job>(["reference"], (j) => { setPhase("saving"); setJob(j); timer.current = setTimeout(() => poll(j.id), 300); });

  async function create() {
    setTried(true); setErr("");
    if (rec) await stop();
    if (!samples.length || total < MIN_S) return;
    if (unreadable.length && samples.length > 1) return setErr(`This browser can't read “${unreadable[0].name}”. Remove it, or convert it to WAV or MP3.`);
    setPhase("saving"); setJob(null);
    const name0 = slugOf(label || "My voice");
    let name = name0, k = 2;
    while (mine.some((m) => m.name === name)) name = `${name0}-${k++}`;
    try {
      const clip = samples.length === 1 ? samples[0].file : joinWav(await Promise.all(samples.map((s) => decode(s.file))));
      const ext = samples.length === 1 ? (samples[0].file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".webm") : ".wav";
      setUpFrac(0);
      const key = await uploadFile(clip, `${name}${ext}`, setUpFrac);
      setUpFrac(null);
      const j = await api<Job>("myvoices", { body: { name, label: label.trim() || "My voice", key, max_seconds: Math.round(Math.min(BEST_S, Math.max(20, total))) } });
      samples.forEach((s) => s.forget?.());
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 1000);
    } catch (e) { setUpFrac(null); setErr((e as Error).message); setPhase("edit"); }
  }
  function again() {
    samples.forEach((s) => URL.revokeObjectURL(s.url));
    setSamples([]); setLabel(""); setJob(null); setPhase("edit"); setTried(false); setErr("");
    api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {});
  }

  const made = job?.myvoice;
  return (
    <>
      <PageHeader title="Instant voice clone" sub="Read the script or upload recordings of your voice. 20 seconds to a minute works best."
        actions={<Link href="/voices" className="btn ghost"><ArrowLeft size={15} />Voices</Link>} />
      {offline && (
        <Notice icon={<WarningCircle size={18} weight="bold" />} tone="warn" action={<Link href="/settings?tab=gpu" className="btn sm"><Power size={14} weight="bold" />Start the GPU</Link>}>
          <b>The GPU is off.</b> Record your samples now; creating the voice needs the GPU.
        </Notice>
      )}

      <div className="clone">
        <section className="clone-script" aria-label="Script to read">
          <div className="cs-head">
            <b>Record yourself reading the script</b>
            <Select size="sm" label="Script" value={script} onChange={setScript} options={SCRIPTS.map((s, i) => [i, s.label] as const)} style={{ width: "auto" }} />
          </div>
          <div className="cs-text" tabIndex={0} aria-label="Script"><p>{SCRIPTS[script].text}</p></div>
          <div className="cs-bar">
            <Microphone size={16} className="dim" aria-hidden />
            <Select size="sm" label="Microphone" value={mic} onChange={setMic} disabled={!!rec}
              options={mics.length ? mics.map((m) => [m.id, m.name] as const) : [["default", "Default microphone"] as const]} className="cs-mic" />
            {rec ? (
              <>
                <button className="rec-pill on" onClick={stop} aria-label="Stop recording"><Stop size={15} weight="fill" /></button>
                <button className="icon-btn" onClick={() => { if (paused) rec.resume(); else rec.pause(); setPaused(!paused); }} aria-label={paused ? "Resume recording" : "Pause recording"}>
                  {paused ? <Microphone size={16} weight="fill" /> : <Pause size={16} weight="fill" />}</button>
              </>
            ) : (
              <button className="rec-pill" onClick={start} disabled={asking || phase !== "edit"}><span className="rec-dot" aria-hidden />{asking ? "Allow the mic…" : samples.some((s) => s.recorded) ? "Record more" : "Record"}</button>
            )}
            <span className="cs-time mono" aria-live="off">{rec ? `${paused ? "Paused · " : ""}${clock(secs)}` : "0:00"}</span>
            <PopMenu up trigger={({ toggle, ref, open }) => <button ref={ref} className="icon-btn" onClick={toggle} aria-expanded={open} aria-label="More ways to add samples"><DotsThree size={20} weight="bold" /></button>}>
              {(close) => (
                <>
                  <button className="pm-item" role="menuitem" onClick={() => { close(); fileIn.current?.click(); }}><UploadSimple size={15} className="ic" />Upload audio files</button>
                  <button className="pm-item" role="menuitem" onClick={() => { close(); setScript((script + 1) % SCRIPTS.length); }}><Lightbulb size={15} className="ic" />Another script</button>
                </>
              )}
            </PopMenu>
          </div>
          <p className="cs-tips"><Lightbulb size={13} aria-hidden /> {TIPS}</p>
        </section>

        <section className="clone-side" aria-label="Samples">
          <Gauge min={MIN_S} best={BEST_S} value={total} size={230}>
            <Orb tone="instant" size={150} level={level} live={!!rec && !paused} />
          </Gauge>
          <p className={`clone-msg ${tried && total < MIN_S ? "bad" : ""}`} role="status">{msg}</p>

          {samples.length > 0 && (
            <div className="samples">
              {samples.map((s) => (
                <div key={s.id} className="sample-row">
                  <SampleButton id={`clone/${s.id}`} url={s.url} size={30} label={s.name} />
                  <span className="sr-name ellipsis">{s.name}</span>
                  <span className="mono dim small">{s.secs == null ? "…" : s.secs < 0 ? "?" : fmtS(s.secs)}</span>
                  <button className="icon-btn sm danger-h" onClick={() => remove(s)} disabled={phase !== "edit"} aria-label={`Remove ${s.name}`}><TrashSimple size={15} /></button>
                </div>
              ))}
            </div>
          )}
          <label className={`clone-drop ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}>
            <UploadSimple size={16} aria-hidden /><span><b>Upload audio files</b> · drop them here or choose · as many as you like</span>
            <input ref={fileIn} type="file" accept="audio/*,video/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
          <SavedTakes scope="voices" live={rec?.take.id ?? null} useLabel="Add"
            onUse={(f, t) => setSamples((s) => s.some((x) => x.id === t.id) ? s : [...s, { id: t.id, name: `Saved take`, file: f, secs: t.secs, url: URL.createObjectURL(f), recorded: true, forget: () => import("./takes").then((m) => m.dropTake(t.id)) }])} />

          {made ? (
            <div className="clone-done">
              <CheckCircle size={22} weight="fill" className="ok-ic" aria-hidden />
              <div><b>“{made.label}” is ready</b><span className="dim small">Use it on Qwen3-TTS (10 languages) or Chatterbox (emotion, 23 languages).</span></div>
              <div className="row" style={{ gap: 8 }}>
                <button className="ghost sm" onClick={again}>Make another</button>
                <Link className="btn sm" href={`/voiceover?engine=qwen&voice=${made.name}`}>Use in Voiceover</Link>
              </div>
            </div>
          ) : (
            <div className="clone-save">
              <div className="field" style={{ margin: 0 }}>
                <label className="f" htmlFor="clone-name">Name</label>
                <input id="clone-name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sparsh, energetic" disabled={phase !== "edit"} maxLength={60} />
              </div>
              {offline
                ? <Link href="/settings?tab=gpu" className="btn block"><Power size={15} weight="bold" />Start the GPU to create</Link>
                : <button className="block" onClick={create} disabled={phase !== "edit" || !status}>{phase === "saving" ? "Creating…" : "Create voice"}</button>}
            </div>
          )}
          {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
          {phase === "saving" && (job || upFrac !== null) && <JobProgress job={job} kind="reference" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} />}
        </section>
      </div>
    </>
  );
}
