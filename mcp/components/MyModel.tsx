"use client";
// Your own voice model, end to end: collect 30-60 minutes of you (read along or upload), train it on the GPU worker
// with one click, then benchmark it against your cloned voices. One dataset and one model per person: each of you picks
// your own name, and both models stay available to everyone (the myvoice engine, voice = the name).
import { ArrowRight, CaretLeft, CaretRight, Microphone, Stop, TrashSimple, UploadSimple } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { READ_ALONG } from "@/lib/readalong";
import { api, fmtS, pct, simClass, matchClass, uploadFile, type Job, type MyVoice } from "./api";
import { useDialog } from "./Dialog";
import JobProgress from "./JobProgress";
import { useResumeJob } from "./jobs";
import LineRow from "./LineRow";
import Player from "./Player";
import { FilePreview, PauseButton, SavedTakes, startRecording, VoiceOrb, type Recording } from "./Recorder";
import { useStatus } from "./Shell";

type Part = { job: string; clips: number; minutes: number; input_minutes: number; dropped: Record<string, number>; created: number;
  sources: { name: string; duration: number; clips: number }[]; auto_train?: { job?: string; skipped?: string } };
type Dataset = { name: string; parts: Part[]; clips: number; minutes: number };
type Model = { name: string; job: string; created: number; clips: number; minutes: number; epochs: number; loss: number;
  sample: { text: string; duration: number } | null; sample_url?: string | null; best_epoch?: number; flow_clips?: number;
  listening?: { epoch: number; match: number | null; similarity: number | null; score: number | null }[] };
type Bench = { target: string | null; candidates: { label: string; engine: string; voice: string; match?: number | null; similarity?: number | null; mos?: number | null; rtf?: number; score?: number | null; lines?: string[]; error?: string }[] };

const MILESTONES = [[15, "works"], [30, "good"], [60, "best"]] as const;
const TEST = `Okay, let's talk about why your app feels slow, even though the server is fast.
Here's the twist: the database was never the bottleneck. It was the network all along.
Honestly? I didn't believe it either, until I measured it.
Version three point two cut cold starts from nine hundred milliseconds to about eighty.
So, should you rewrite everything in Rust? Probably not. Should you profile first? Always.
Thanks for watching, and I'll see you in the next one.`;

type Polled = Job & { part?: Part; benchmark?: Bench; model?: Model | null; kvoice_saved?: unknown; myvoice?: MyVoice | null };

function usePoll(onDone?: (j: Polled) => void) {
  const [job, setJob] = useState<Polled | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const poll = useCallback(async (id: string) => {
    try {
      const j = await api<Polled>(`jobs/${id}`);
      setJob(j);
      // done on the worker isn't done until the result is stored: the dataset part, the trained model, or the library entry
      const kind = j.kind as string;
      const finished = j.status === "done" && (kind === "dataset" ? !!j.part : kind === "train" ? !!j.model : kind === "voicewalk" ? !!j.kvoice_saved
        : kind === "reference" ? !!j.myvoice : !!j.library);
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !finished)) timer.current = setTimeout(() => poll(id), 2000);
      else if (j.status === "done") done.current?.(j);
    } catch {
      timer.current = setTimeout(() => poll(id), 5000);
    }
  }, []);
  return { job, start: (j: Job) => { setJob(j); timer.current = setTimeout(() => poll(j.id), 1200); } };
}

/** Jobs for this person that were started anywhere (MCP, another device, auto-train): show them here, live. Checks the
 * worker's job list now and every 20 s while nothing is being followed; a finished dataset batch is stored on the way. */
function useWorkerJobs(kind: "dataset" | "train", name: string, following: boolean, start: (j: Polled) => void, onStored?: () => void) {
  const seen = useRef(new Set<string>());
  const fns = useRef({ start, onStored });
  fns.current = { start, onStored };
  useEffect(() => {
    if (following || !name) return;
    let live = true;
    const look = async () => {
      const r = await api<{ jobs: (Job & { voice?: string })[] }>("jobs").catch(() => null);
      if (!live || !r) return;
      const mine = r.jobs.filter((j) => (j.kind as string) === kind && j.voice === name);
      const busy = mine.find((j) => ["queued", "running"].includes(j.status));
      if (busy) { fns.current.start(await api<Polled>(`jobs/${busy.id}`)); return; }
      // done on the worker but maybe never stored (started elsewhere, nobody waited for it): store it now, quietly
      const fresh = mine.filter((j) => j.status === "done" && !seen.current.has(j.id));
      fresh.forEach((j) => seen.current.add(j.id));
      if (kind === "dataset" && fresh.length) {
        await Promise.all(fresh.map((j) => api(`jobs/${j.id}`).catch(() => null)));
        if (live) fns.current.onStored?.();
      }
    };
    look();
    const t = setInterval(look, 20_000);
    return () => { live = false; clearInterval(t); };
  }, [kind, name, following]);
}

type Pending = { file: File; forget?: () => void; take?: string };

function Collect({ name, open, onClose, onAdded }: { name: string; open: boolean; onClose: () => void; onAdded: (trainJob?: string) => void }) {
  const { status } = useStatus();
  const { toast } = useDialog();
  const [tab, setTab] = useState<"read" | "upload">("read");
  const [i, setI] = useState(0);
  const [rec, setRec] = useState<Recording | null>(null);
  const [paused, setPaused] = useState(false);
  const [secs, setSecs] = useState(0);
  // takes and files waiting for you to listen and keep them: nothing is sent until you press Add to dataset
  const [pending, setPending] = useState<Pending[]>([]);
  const [up, setUp] = useState<number | null>(null);
  const [err, setErr] = useState("");
  // train on everything collected as soon as a batch is stored (the server starts it, so the tab can close)
  const [auto, setAuto] = useState(true);
  useEffect(() => { try { setAuto(localStorage.getItem("vb-autotrain") !== "0"); } catch {} }, []);
  const sent = useRef<Pending[]>([]); // in the worker's hands: dropped from this device once they're in the dataset
  const { job, start } = usePoll((j) => {
    const p = j.part;
    const at = p?.auto_train;
    toast(`Added ${p?.clips ?? 0} clips (${p?.minutes ?? 0} min) to ${name}${at?.job ? ". Training started" : at?.skipped ? `. Not training yet: ${at.skipped}` : ""}`, "ok");
    sent.current.forEach((x) => x.forget?.()); sent.current = [];
    onAdded(at?.job);
  });
  useEffect(() => {
    // a failed batch: give the recordings back, so nothing has to be recorded again
    if (job && ["error", "cancelled"].includes(job.status) && sent.current.length) {
      const back = sent.current;
      sent.current = [];
      setPending((p) => [...back, ...p]);
    }
  }, [job]);

  useEffect(() => { try { setI(Number(localStorage.getItem(`vb-read-${name}`)) || 0); } catch {} }, [name]);
  useEffect(() => { try { localStorage.setItem(`vb-read-${name}`, String(i)); } catch {} }, [i, name]);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setSecs(rec.elapsed()), 250);
    return () => clearInterval(t);
  }, [rec]);
  useEffect(() => () => { rec?.stream.getTracks().forEach((t) => t.stop()); }, [rec]);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if ((e.key === " " || e.key === "ArrowRight") && !rec.paused) { e.preventDefault(); setI((x) => (x + 1) % READ_ALONG.length); }
      if (e.key.toLowerCase() === "p") { e.preventDefault(); if (rec.paused) { rec.resume(); setPaused(false); } else { rec.pause(); setPaused(true); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec]);

  async function begin() {
    setErr("");
    try {
      // saved to this device every second: a refresh mid-session keeps it (offered back below the card)
      const r = await startRecording(`dataset:${name}`, `line ${i + 1}`);
      setSecs(0); setPaused(false); setRec(r);
    } catch (e) {
      setErr((e as Error).name === "NotAllowedError" ? "Allow the microphone for this site, then try again." : (e as Error).message);
    }
  }
  async function finish() {
    if (!rec) return;
    const r = rec;
    setRec(null); setPaused(false);
    const f = await r.stop();
    if (r.elapsed() < 3) { r.forget(); toast("That take was under 3 seconds, so it wasn't kept", "bad"); return; }
    setPending((p) => [...p, { file: f, forget: r.forget, take: r.take.id }]);
  }
  function drop(k: number) {
    setPending((p) => { p[k]?.forget?.(); return p.filter((_, j) => j !== k); });
  }
  async function send() {
    const list = pending.slice(0, 20);
    if (!list.length) return;
    setErr("");
    try {
      const total = list.reduce((a, x) => a + x.file.size, 0) || 1;
      let done = 0;
      const keys: { key: string; name: string }[] = [];
      for (const x of list) {
        const f = x.file;
        keys.push({ key: await uploadFile(f, f.name.replace(/[^A-Za-z0-9._-]/g, "_"), (fr) => setUp((done + fr * f.size) / total)), name: f.name });
        done += f.size;
      }
      setUp(null);
      const j = await api<Job>("jobs", { body: { kind: "dataset", name, sources: keys, label: `Dataset · ${name}`, auto_train: auto } });
      sent.current = list;
      setPending((p) => p.slice(list.length));
      start(j);
    } catch (e) {
      setUp(null);
      setErr((e as Error).message);
    }
  }
  const busy = !!job && ["queued", "running"].includes(job.status);
  useResumeJob<Polled>(["dataset"], (j) => { if ((j as Polled & { voice?: string }).voice === name) start(j); });
  useWorkerJobs("dataset", name, busy, start, () => onAdded());
  // a voice that already has recordings doesn't need this card: it opens from "Add recordings" (and stays while working)
  if (!open && !busy && up === null && !pending.length && !rec && job?.status !== "error") return null;

  return (
    <div className="card">
      <div className="card-head"><h2>Add recordings</h2>
        <div className="row" style={{ gap: 8 }}>{open && <button className="ghost xs" onClick={onClose}>Close</button>}<div className="seg"><button className={tab === "read" ? "on" : ""} onClick={() => setTab("read")}>Read along</button><button className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>Upload</button></div></div>
      </div>
      {tab === "read" ? (
        <>
          <p className="dim small" style={{ marginTop: 0 }}>Record a session of 5-15 minutes at your natural YouTube pace. <kbd>space</kbd> moves to the next line,
            <kbd>P</kbd> pauses and resumes (take a sip of water, the take waits). Stop when you&apos;re done: you listen first, nothing is sent until you add it.</p>
          <div className={`read-card big ${rec && !paused ? "live" : ""}`}>{READ_ALONG[i]}</div>
          <div className="row between" style={{ flexWrap: "wrap", gap: 10 }}>
            <div className="row" style={{ gap: 4 }}>
              <button className="icon-btn" aria-label="Previous line" onClick={() => setI((x) => (x - 1 + READ_ALONG.length) % READ_ALONG.length)}><CaretLeft size={16} /></button>
              <span className="mono tiny dim">{i + 1} / {READ_ALONG.length}</span>
              <button className="icon-btn" aria-label="Next line" onClick={() => setI((x) => (x + 1) % READ_ALONG.length)}><CaretRight size={16} /></button>
            </div>
            {rec ? (
              <div className="row" style={{ gap: 10 }}>
                <VoiceOrb stream={rec.stream} size={64} paused={paused} /><span className="mono">{fmtS(secs)}{paused ? " · paused" : ""}</span>
                <PauseButton rec={rec} paused={paused} onChange={setPaused} />
                <button onClick={finish}><Stop size={15} weight="fill" /> Stop</button>
              </div>
            ) : <button onClick={begin} disabled={up !== null}><Microphone size={15} weight="fill" /> {pending.length ? "Record another session" : "Start a session"}</button>}
          </div>
          {!rec && <div style={{ marginTop: 12 }}><SavedTakes scope={`dataset:${name}`} live={pending.map((p) => p.take).filter(Boolean).join(",") || null} useLabel="Review" onUse={(f, t) => {
            if (pending.some((p) => p.take === t.id)) return;
            setPending((p) => [...p, { file: f, take: t.id, forget: () => import("./takes").then((m) => m.dropTake(t.id)) }]);
          }} /></div>}
        </>
      ) : (
        <>
          <p className="dim small" style={{ marginTop: 0 }}>Long recordings of just you talking work great: raw voiceovers, podcast tracks, a video&apos;s audio. Pick as many as you like
            (up to 20 per batch, 3 hours in all). With <b>Train automatically</b> on, the Orpheus model trains by itself once {name} has
            15+ minutes (you can close the tab; keep Colab running).</p>
          <label className="drop slim" style={{ cursor: "pointer" }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const fs = Array.from(e.dataTransfer.files).filter((f) => /^(audio|video)\//.test(f.type)); setPending((p) => [...p, ...fs.map((file) => ({ file }))]); }}>
            <UploadSimple size={18} /><span className="small">Choose or drop audio / video files</span>
            <input type="file" hidden multiple accept="audio/*,video/*" onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; setPending((p) => [...p, ...fs.map((file) => ({ file }))]); }} />
          </label>
        </>
      )}
      {pending.length > 0 && (
        <div className="stack" style={{ gap: 10, marginTop: 14, padding: 12, border: "1px solid var(--line)", borderRadius: 12 }}>
          <div className="row between"><b className="small">Ready for {name}&apos;s dataset · {pending.length} {pending.length === 1 ? "recording" : "recordings"}</b>
            <span className="tiny dim">listen, remove what you don&apos;t want</span></div>
          {pending.map((x, k) => <FilePreview key={`${x.file.name}-${k}`} file={x.file} onRemove={() => drop(k)} />)}
          {pending.length > 20 && <span className="tiny dim">The first 20 go in this batch; add the rest after.</span>}
          <div className="row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <label className="row small" style={{ gap: 8, marginRight: "auto" }} title={`Starts once ${name} has 15+ minutes; replaces ${name}'s current model`}>
              <input type="checkbox" style={{ width: "auto" }} checked={auto} onChange={(e) => { setAuto(e.target.checked); try { localStorage.setItem("vb-autotrain", e.target.checked ? "1" : "0"); } catch {} }} />
              Train automatically when added</label>
            <button className="ghost sm" onClick={() => setPending((p) => { p.forEach((x) => x.forget?.()); return []; })}>Discard all</button>
            <button className="sm" onClick={send} disabled={busy || up !== null || !status?.online || !!rec}
              title={!status?.online ? "Start the GPU worker first (your takes stay saved here)" : undefined}>
              Add {Math.min(20, pending.length)} to dataset <ArrowRight size={13} /></button>
          </div>
        </div>
      )}
      {err && <p className="err" style={{ margin: "10px 0 0" }}>{err}</p>}
      {!status?.online && status && <p className="tiny dim">The GPU worker is offline. You can still record and queue takes (they&apos;re saved on this device); start the Colab notebook to add them.</p>}
      {(job || up !== null) && <div style={{ marginTop: 14 }}><JobProgress job={job} kind="dataset" uploading={up !== null} uploadFrac={up ?? 0} /></div>}
      {job?.status === "error" && <DatasetError job={job} />}
      {job?.status === "done" && job.part && job.part.clips === 0 && <p className="err small">No clips were kept from that batch.</p>}
    </div>
  );
}

/** Why a dataset batch failed, in words, with what to do next. */
function DatasetError({ job }: { job: Polled }) {
  const e = job.error ?? "";
  const tip = /no usable clips/i.test(e) ? "Every clip was dropped by the quality checks. Record closer to the mic in a quiet room, read whole sentences, and keep pauses under a few seconds (use Pause for longer breaks)."
    : /3 hours/i.test(e) ? "Split the files over two batches."
    : /download|403|404|expired/i.test(e) ? "The upload link expired before the worker got to it. Add the recordings again."
    : /ffmpeg|Invalid data|moov/i.test(e) ? "One file couldn't be read as audio. Remove it (or export it as WAV/MP3) and add the rest."
    : "Your recordings are still saved on this device: fix the issue and add them again.";
  return <p className="err small" style={{ margin: "8px 0 0" }}>{e || "The batch failed."} {tip}</p>;
}

const TRAIN_STAGES: Record<string, string> = { queued: "Waiting for the GPU", installing: "Installing the training tools", preparing: "Starting",
  downloading: "Fetching your recordings", encoding: "Turning your clips into tokens", loading: "Loading Orpheus 3B",
  training: "Learning your voice", listening: "Listening to every epoch, keeping the best", saving: "Saving your model", testing: "Voicing a test line", done: "Done" };

function Train({ name, minutes, follow, head, onTrained }: { name: string; minutes: number; follow?: string; head: React.ReactNode; onTrained: () => void }) {
  const { status } = useStatus();
  const { confirm, toast } = useDialog();
  const [model, setModel] = useState<Model | null>(null);
  const [err, setErr] = useState("");
  const loadModel = useCallback(() => {
    setModel(null);
    api<{ model: Model | null }>(`model?name=${encodeURIComponent(name)}`).then((r) => setModel(r.model?.name === name ? r.model : null)).catch(() => {});
  }, [name]);
  useEffect(loadModel, [loadModel]);
  const { job, start } = usePoll((j) => { toast(`${name} is trained. Pick "${name}" under Your model in Voiceover.`, "ok"); if (j.model) { loadModel(); onTrained(); } });
  const busy = !!job && ["queued", "running"].includes(job.status);
  const p = job?.progress;
  useResumeJob<Polled>(["train"], (j) => { if ((j as Polled & { voice?: string }).voice === name) start(j); });
  useWorkerJobs("train", name, busy, start);
  // a train job the server started after an upload (auto-train): show its progress here
  useEffect(() => { if (follow) api<Polled>(`jobs/${follow}`).then(start).catch(() => {}); }, [follow]); // eslint-disable-line react-hooks/exhaustive-deps

  async function train() {
    setErr("");
    if (minutes < 15 && !(await confirm({ title: `Train on ${minutes.toFixed(1)} minutes?`, body: `It will train, but under 15 minutes the model sounds only roughly like ${name}. 30 minutes is good, 60 is best. Add more any time and train again.`, confirm: "Train anyway" }))) return;
    if (model && !(await confirm({ title: `Train ${name} again?`, body: `It replaces ${name}'s model (other people's models stay). Voice and video jobs wait while the GPU trains (about 1-2 hours on a free T4).`, confirm: "Train" }))) return;
    try {
      start(await api<Job>("jobs", { body: { kind: "train", name } }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="card">
      {head}
      <p className="dim small" style={{ marginTop: 0 }}>
        Learns <b>{name}</b> from every clip: pace, emphasis, how sentences flow. The most natural long English reads. About 1-2 h on the GPU
        (other jobs wait); then pick <b>{name}</b> under <b>Your model</b> in Voiceover. Keep Colab open until it finishes.
      </p>
      {model && !busy && (
        <div className="stack" style={{ gap: 8, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="row between small"><b>Current model · {model.name}</b>
            <span className="dim">{model.minutes.toFixed(1)} min · {model.clips} clips · {model.best_epoch ? `best of ${model.epochs} epochs: ${model.best_epoch}` : `${model.epochs} epochs`} · loss {model.loss.toFixed(3)}{model.flow_clips ? " · flow" : ""} · {new Date(model.created).toLocaleDateString()}</span></div>
          {model.sample_url && <><span className="dim tiny">“{model.sample?.text}”</span><Player src={model.sample_url} compact /></>}
          {!!model.listening?.length && (
            <div className="tiny dim">Picked by listening: {model.listening.map((e) => (
              <span key={e.epoch} style={{ marginRight: 10, color: e.epoch === model.best_epoch ? "var(--ink)" : undefined }}>
                epoch {e.epoch} · words {pct(e.match)} · like you {pct(e.similarity)}{e.epoch === model.best_epoch ? " ✓" : ""}</span>))}</div>
          )}
        </div>
      )}
      {job && (busy || job.status === "error" || job.status === "cancelled") && (
        <div className="stack" style={{ gap: 6, padding: "10px 0" }}>
          <div className="row between small">
            <b>{job.status === "error" ? "Training stopped" : job.status === "cancelled" ? "Cancelled" : TRAIN_STAGES[p?.stage ?? "queued"] ?? p?.stage}</b>
            {busy && p && <span className="dim">{p.detail}{p.eta_s ? ` · about ${fmtS(p.eta_s)} left` : ""}</span>}
          </div>
          {busy && <div className="bar live"><i style={{ width: `${Math.round((p?.fraction ?? 0) * 100)}%` }} /></div>}
          {job.error && <p className="err" style={{ margin: 0 }}>{job.error}</p>}
          {job.status === "error" && (job as Polled & { log?: string }).log && (
            <details><summary className="tiny dim">What the trainer said</summary>
              <pre className="mono tiny" style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }}>{(job as Polled & { log?: string }).log!.split("\n").slice(-25).join("\n")}</pre></details>
          )}
          {busy && <button className="ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => api(`jobs/${job.id}/cancel`, { method: "POST" }).catch(() => {})}>Cancel training</button>}
        </div>
      )}
      <div className="row between" style={{ marginTop: 12 }}>
        {/* why the button is off, in plain words: the usual reasons are too few minutes or the worker being offline */}
        {!busy && !status?.online ? <span className="small" style={{ color: "var(--warn)" }}>Start the Colab GPU worker to train.</span>
          : !busy && !minutes ? <span className="small" style={{ color: "var(--warn)" }}>Add recordings first.</span>
          : <span className="tiny dim">{minutes.toFixed(1)} minutes to learn from{minutes < 15 ? " · 15+ sounds right, 30 good, 60 best" : minutes < 30 ? " · 30 is good, 60 best" : ""}.</span>}
        <span className="row" style={{ gap: 6 }}>
          <button className="sm" onClick={train} disabled={busy || !minutes || !status?.online} title={!status?.online ? "Start the GPU worker first" : undefined}>
            {busy ? "Training…" : model ? "Train again" : "Train my voice"} <ArrowRight size={13} />
          </button>
        </span>
      </div>
      {err && <p className="err" style={{ margin: "8px 0 0" }}>{err}</p>}
    </div>
  );
}

function Benchmark({ mine, name }: { mine: MyVoice[]; name: string }) {
  const { status } = useStatus();
  const [voice, setVoice] = useState(mine[0]?.name ?? "");
  const [lines, setLines] = useState(TEST);
  const [picks, setPicks] = useState({ myvoice: true, qwen: true, chatterbox: true, orpheus: false });
  const { job, start } = usePoll();
  const [err, setErr] = useState("");
  useEffect(() => { if (!voice && mine[0]) setVoice(mine[0].name); }, [mine, voice]);

  async function run() {
    setErr("");
    const cands = [
      picks.myvoice && { engine: "myvoice", voice: name, label: `Your model · ${name}` },
      picks.qwen && voice && { engine: "qwen", voice, label: `Qwen clone · ${voice}` },
      picks.chatterbox && voice && { engine: "chatterbox", voice, label: `Chatterbox clone · ${voice}` },
      picks.orpheus && { engine: "orpheus", voice: "tara", label: "Orpheus preset (baseline)" },
    ].filter(Boolean);
    try {
      start(await api<Job>("jobs", { body: { kind: "benchmark", candidates: cands, target_voice: voice || undefined, style: "tech", platform: "youtube",
        lines: lines.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20), label: `Benchmark · ${voice || "voices"}` } }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useResumeJob<Polled>(["benchmark"], start);
  const b = job?.benchmark;
  const best = b?.candidates.find((c) => !c.error);

  return (
    <div className="card">
      <div className="card-head"><h2>Benchmark</h2><span className="dim tiny">same sentences, same scoring, every voice</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>Use sentences you never recorded. Voice match is measured against your real recording; naturalness is a predicted MOS (1-5); speed is seconds of compute per second of audio.</p>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 14 }}>
        <textarea className="doc short" value={lines} onChange={(e) => setLines(e.target.value)} style={{ minHeight: 170, marginTop: 0 }} />
        <div className="stack" style={{ gap: 10 }}>
          <div><label className="f">Your real voice (the target)</label>
            <select value={voice} onChange={(e) => setVoice(e.target.value)}>{mine.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}{!mine.length && <option value="">Make it with Qwen3-TTS + Chatterbox above</option>}</select></div>
          {([["myvoice", "Your trained model"], ["qwen", "Qwen clone"], ["chatterbox", "Chatterbox clone"], ["orpheus", "Orpheus preset"]] as const).map(([k, l]) => (
            <label key={k} className="row small" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={picks[k]} onChange={(e) => setPicks({ ...picks, [k]: e.target.checked })} />{l}</label>
          ))}
          <button onClick={run} disabled={!status?.online || (job ? ["queued", "running"].includes(job.status) : false)}>Run benchmark</button>
          {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
        </div>
      </div>
      {job && !b && <div style={{ marginTop: 14 }}><JobProgress job={job} kind="tts" /></div>}
      {b && (
        <div style={{ marginTop: 16 }}>
          <table className="table">
            <thead><tr><th>Voice</th><th>Script</th><th>Like you</th><th>Natural</th><th>Speed</th><th>Score</th></tr></thead>
            <tbody>{b.candidates.map((c) => (
              <tr key={c.label}>
                <td><b className="small">{c.label}</b>{c === best && <span className="pill ok" style={{ marginLeft: 8 }}>best</span>}{c.error && <div className="tiny dim">{c.error.slice(0, 120)}</div>}</td>
                <td><span className={`pill ${matchClass(c.match)}`}>{pct(c.match)}</span></td>
                <td><span className={`pill ${simClass(c.similarity)}`}>{pct(c.similarity)}</span></td>
                <td className="mono small">{c.mos != null ? c.mos.toFixed(2) : "—"}</td>
                <td className="mono small">{c.rtf != null ? `${c.rtf}×` : "—"}</td>
                <td className="mono small">{c.score != null ? c.score.toFixed(2) : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
          <h2 style={{ marginTop: 18 }}>Listen side by side</h2>
          {job.results.map((r) => <LineRow key={r.id} jobId={job.id} line={{ ...r, id: r.id }} audio={r.url} slug="benchmark" />)}
        </div>
      )}
    </div>
  );
}

type KVoice = { name: string; voice: string; job: string; created: number; target: string; similarity: number; match: number; start: number;
  closest: { voice: string; similarity: number }[]; mix?: { voice: string; weight: number }[]; sample_url?: string | null };

/** Your voice inside Kokoro: the clarity and speed of af_heart, as close to you as Kokoro's voice space allows. */
function KokoroVoice({ mine, name }: { mine: MyVoice[]; name: string }) {
  const { status } = useStatus();
  const { toast } = useDialog();
  const [target, setTarget] = useState("");
  const [have, setHave] = useState<KVoice | null>(null);
  const [rounds, setRounds] = useState(24);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<{ voices: KVoice[] }>("kvoices").then((r) => setHave(r.voices.find((v) => v.name === name) ?? null)).catch(() => {});
  }, [name]);
  useEffect(load, [load]);
  // the voice made from this dataset (Use it in every engine) first, else your first recorded voice
  useEffect(() => { if (!mine.some((m) => m.name === target) && mine[0]) setTarget((mine.find((m) => m.name === name) ?? mine[0]).name); }, [mine, target, name]);
  const { job, start } = usePoll((j) => { toast(`Found ${name}'s voice in Kokoro: use kv_${name} in Voiceover (Kokoro)`, "ok"); void j; load(); });
  useResumeJob<Polled>(["voicewalk"], (j) => { if ((j as Polled & { voice?: string }).voice === name) start(j); });
  const busy = !!job && ["queued", "running"].includes(job.status);

  async function run() {
    setErr("");
    try {
      start(await api<Job>("jobs", { body: { kind: "voicewalk", name, voice: target, rounds, label: `Your voice in Kokoro · ${name}` } }));
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>Find it in Kokoro</h2><span className="dim tiny">af_heart clarity · instant · runs on the CPU</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>
        Kokoro is the tiny engine behind af_heart: crisp, steady and instant. This searches Kokoro&apos;s voice space for the mix of its voices that
        sounds most like your recording (scored by the same voice match as the review), then checks it still speaks every word clearly.
        It&apos;s the closest Kokoro can get to you, not a clone; your trained model copies you more exactly. About 10-15 minutes.
      </p>
      {have && !busy && (
        <div className="stack" style={{ gap: 8, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="row between small" style={{ flexWrap: "wrap", gap: 8 }}><b>kv_{name}</b>
            <span className="dim">like you {pct(have.similarity)} (closest built-in {have.closest[0]?.voice} {pct(have.closest[0]?.similarity)}) · words {pct(have.match)} · {new Date(have.created).toLocaleDateString()}</span></div>
          {have.sample_url && <Player src={have.sample_url} compact />}
          {!!have.mix?.length && <span className="tiny dim">Mix: {have.mix.slice(0, 5).map((m) => `${m.voice} ${Math.round(m.weight * 100)}%`).join(" · ")}</span>}
        </div>
      )}
      <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0, flex: "1 1 200px" }}><label className="f">Match this recording of you</label>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>{mine.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}{!mine.length && <option value="">Make it with Qwen3-TTS + Chatterbox above</option>}</select></div>
        <div className="field" style={{ margin: 0, width: 150 }}><label className="f">Search</label>
          <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
            <option value={12}>Quick (12 rounds)</option><option value={24}>Normal (24)</option><option value={48}>Thorough (48)</option></select></div>
        <button onClick={run} disabled={busy || !target || !status?.online}>{have ? "Search again" : "Find my Kokoro voice"} <ArrowRight size={13} /></button>
      </div>
      {err && <p className="err" style={{ margin: "8px 0 0" }}>{err}</p>}
      {job && (busy || job.status === "error") && <div style={{ marginTop: 14 }}><JobProgress job={job} kind="tts" /></div>}
    </div>
  );
}

/** Any dataset as a cloning voice: ~15-20 s of its cleanest clips become a recorded voice named after it, so Qwen3-TTS,
 *  Chatterbox, Kokoro (step 5) and the benchmark can all use it, not just the trained Orpheus model. */
function EveryEngine({ name, minutes, mine, head, onMade }: { name: string; minutes: number; mine: MyVoice[]; head: React.ReactNode; onMade: () => void }) {
  const { status } = useStatus();
  const { toast } = useDialog();
  const [err, setErr] = useState("");
  const [cap, setCap] = useState(20);
  const have = mine.find((m) => m.name === name);
  const { job, start } = usePoll(() => { toast(`${name} is a voice now: pick it in Voiceover on Qwen3-TTS or Chatterbox`, "ok"); onMade(); });
  useResumeJob<Polled>(["reference"], (j) => { if ((j as Polled & { voice?: string }).voice === name) start(j); });
  const busy = !!job && ["queued", "running"].includes(job.status);

  async function make() {
    setErr("");
    try {
      start(await api<Job>("myvoices", { body: { name, dataset: name, label: name, max_seconds: cap } }));
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="card">
      {head}
      <p className="dim small" style={{ marginTop: 0 }}>
        Ready in about a minute: picks the cleanest stretch of <b>{name}</b>&apos;s clips and saves it as the voice <b>{name}</b>. Then choose it in
        Voiceover on Qwen3-TTS (best cloning, 10 languages) or Chatterbox (emotion, 23 languages, Hindi).
      </p>
      <label className="row small" style={{ gap: 8 }}>Sample length
        <select value={cap} onChange={(e) => setCap(Number(e.target.value))} style={{ width: "auto" }}>
          {[20, 30, 45, 60].map((v) => <option key={v} value={v}>{v} s{v === 20 ? " (best for cloning)" : ""}</option>)}</select>
        <span className="tiny dim">longer can catch more of the voice; Chatterbox listens to about the first 10 s</span></label>
      {have && !busy && (
        <div className="stack" style={{ gap: 6, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="row between small"><b>Voice · {have.name}</b><span className="dim">{have.duration.toFixed(1)} s · {new Date(have.created).toLocaleDateString()}</span></div>
          <span className="dim tiny">“{have.transcript}”</span>
          {have.url && <Player src={have.url} compact />}
        </div>
      )}
      {job && (busy || job.status === "error") && <div style={{ marginTop: 10 }}><JobProgress job={job} kind="tts" /></div>}
      <div className="row between" style={{ marginTop: 12 }}>
        <span className="tiny dim">{minutes > 0 ? `${minutes.toFixed(1)} minutes to pick from.` : "Collect first."}</span>
        <button className="sm" onClick={make} disabled={busy || minutes <= 0 || !status?.online} title={!status?.online ? "Start the GPU worker first" : undefined}>
          {busy ? "Making…" : have ? "Pick fresh clips" : `Make ${name} a voice`} <ArrowRight size={13} /></button>
      </div>
      {err && <p className="err" style={{ margin: "8px 0 0" }}>{err}</p>}
    </div>
  );
}

type Person = { name: string; minutes: number; clips: number };

export default function MyModel() {
  const { confirm } = useDialog();
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [name, setName] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [ds, setDs] = useState<Dataset | null>(null);
  const [follow, setFollow] = useState<string>();
  const [fresh, setFresh] = useState("");
  const load = useCallback(() => { if (name) api<Dataset>(`datasets/${name}`).then(setDs).catch(() => setDs(null)); }, [name]);
  const loadModels = useCallback(() => { api<{ models: Model[] }>("models").then((r) => setModels(r.models)).catch(() => {}); }, []);
  const loadMine = useCallback(() => { api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {}); }, []);
  useEffect(loadMine, [loadMine]);
  useEffect(loadModels, [loadModels]);
  useEffect(() => {
    // whose dataset to open: the one picked last on this device, else yours (from your sign-in name), else the first one
    Promise.all([api<{ datasets: Person[] }>("datasets").catch(() => ({ datasets: [] as Person[] })),
      fetch("/api/ws/me").then((r) => r.json()).catch(() => ({}))]).then(([d, me]) => {
      setPeople(d.datasets);
      let saved = "";
      try { saved = localStorage.getItem("vb-dataset") ?? ""; } catch {}
      const slug = String(me?.user?.name ?? "").toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9_-]/g, "") ?? "";
      setName(saved || (slug && d.datasets.some((x) => x.name === slug) ? slug : "") || d.datasets[0]?.name || slug || "me");
    });
  }, []);
  useEffect(() => { if (name) try { localStorage.setItem("vb-dataset", name); } catch {} }, [name]);
  useEffect(load, [load]);
  const minutes = ds?.minutes ?? 0;
  const refresh = () => { load(); api<{ datasets: Person[] }>("datasets").then((d) => setPeople(d.datasets)).catch(() => {}); };

  // the recordings card only shows when it's needed: a new (empty) voice, or after "Add recordings"; switching voices resets it
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [name]);
  const [make, setMake] = useState<"orpheus" | "clone">("orpheus");
  const voices = [...new Set([...people.map((p) => p.name), ...models.map((m) => m.name), ...(name ? [name] : [])])];
  const pickEngine = (
    <div className="card-head"><h2>Make the voice</h2>
      <div className="seg"><button className={make === "orpheus" ? "on" : ""} onClick={() => setMake("orpheus")}>Train Orpheus · 1-2 h</button>
        <button className={make === "clone" ? "on" : ""} onClick={() => setMake("clone")}>Qwen3-TTS + Chatterbox · 1 min</button></div>
    </div>
  );

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Your model</div>
          <h1>A voice that is <em>only you.</em></h1>
          <p className="sub">Pick a voice, add recordings of it, make the voice. That&apos;s it.</p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Voice</h2><span className="dim tiny">each voice has its own recordings and model; everyone can use every voice</span></div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {voices.map((n) => {
            const p = people.find((x) => x.name === n);
            const m = models.find((x) => x.name === n);
            return <button key={n} className={`quiet sm ${n === name ? "on" : ""}`} onClick={() => setName(n)}>
              <b>{n}</b>&nbsp;<span className="dim tiny">{(p?.minutes ?? 0).toFixed(1)} min{m ? " · trained" : ""}</span></button>;
          })}
          <span className="row" style={{ gap: 6 }}>
            <input value={fresh} placeholder="+ new voice name" style={{ width: 160 }}
              onChange={(e) => setFresh(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter" && fresh) { setName(fresh); setFresh(""); } }} />
            {fresh && <button className="sm" onClick={() => { setName(fresh); setFresh(""); }}>Add <ArrowRight size={13} /></button>}
          </span>
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="row between"><b>{name || "…"} · {minutes.toFixed(1)} min of clean clips</b>
            <span className="row" style={{ gap: 10 }}><span className="dim small">{ds?.clips ?? 0} clips · {ds?.parts.length ?? 0} sessions</span>
              {minutes > 0 && !adding && <button className="sm" onClick={() => setAdding(true)}><UploadSimple size={13} /> Add recordings</button>}</span></div>
          <div className="meter"><i style={{ width: `${Math.min(100, (minutes / 60) * 100)}%` }} />{MILESTONES.map(([m, l]) => <span key={m} style={{ left: `${(m / 60) * 100}%` }}><em>{m} min · {l}</em></span>)}</div>
          {ds && ds.parts.length > 0 && (
            <details style={{ marginTop: 30 }}><summary className="small dim">Sessions</summary>
              <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                {ds.parts.slice().reverse().map((p) => (
                  <div key={p.job} className="row between small" style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                    <span>{p.sources.map((s) => s.name).join(", ")}</span>
                    <span className="row" style={{ gap: 10 }}>
                      <span className="dim">{p.minutes.toFixed(1)} of {p.input_minutes.toFixed(1)} min kept{Object.keys(p.dropped).length ? ` · dropped ${Object.entries(p.dropped).map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}</span>
                      <button className="icon-btn danger-h" aria-label="Remove session" onClick={async () => { if (await confirm({ title: "Remove this session from the dataset?", confirm: "Remove", danger: true })) { await api(`datasets/${name}/${p.job}`, { method: "DELETE" }); refresh(); } }}><TrashSimple size={14} /></button>
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
      {name && (
        <div className="stack" style={{ gap: 16 }}>
          <Collect name={name} open={!minutes || adding} onClose={() => setAdding(false)} onAdded={(t) => { refresh(); if (t) setFollow(t); }} />
          {make === "orpheus"
            ? <Train name={name} minutes={minutes} follow={follow} head={pickEngine} onTrained={loadModels} />
            : <EveryEngine name={name} minutes={minutes} mine={mine} head={pickEngine} onMade={loadMine} />}
          <details className="card"><summary><b>More tools</b> <span className="dim small">· compare engines (Benchmark) · find the voice in Kokoro</span></summary>
            <div className="stack" style={{ gap: 16, marginTop: 14 }}>
              <Benchmark mine={mine} name={name} />
              <KokoroVoice mine={mine} name={name} />
            </div>
          </details>
        </div>
      )}
      <div style={{ height: 30 }} />
    </>
  );
}
