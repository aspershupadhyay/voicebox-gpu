"use client";
// Your own voice model, end to end: collect 30-60 minutes of you (read along or upload), train it on the GPU worker
// with one click, then benchmark it against your cloned voices.
import { ArrowRight, CaretLeft, CaretRight, Microphone, Stop, TrashSimple, UploadSimple } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { READ_ALONG } from "@/lib/readalong";
import { api, fmtS, pct, simClass, matchClass, uploadFile, type Job, type MyVoice } from "./api";
import { useDialog } from "./Dialog";
import JobProgress from "./JobProgress";
import LineRow from "./LineRow";
import Player from "./Player";
import { useStatus } from "./Shell";

type Part = { job: string; clips: number; minutes: number; input_minutes: number; dropped: Record<string, number>; created: number;
  sources: { name: string; duration: number; clips: number }[] };
type Dataset = { name: string; parts: Part[]; clips: number; minutes: number };
type Model = { name: string; job: string; created: number; clips: number; minutes: number; epochs: number; loss: number;
  sample: { text: string; duration: number } | null; sample_url?: string | null };
type Bench = { target: string | null; candidates: { label: string; engine: string; voice: string; match?: number | null; similarity?: number | null; mos?: number | null; rtf?: number; score?: number | null; lines?: string[]; error?: string }[] };

const MILESTONES = [[15, "works"], [30, "good"], [60, "best"]] as const;
const TEST = `Okay, let's talk about why your app feels slow, even though the server is fast.
Here's the twist: the database was never the bottleneck. It was the network all along.
Honestly? I didn't believe it either, until I measured it.
Version three point two cut cold starts from nine hundred milliseconds to about eighty.
So, should you rewrite everything in Rust? Probably not. Should you profile first? Always.
Thanks for watching, and I'll see you in the next one.`;

type Polled = Job & { part?: Part; benchmark?: Bench; model?: Model | null };

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
      const finished = j.status === "done" && (kind === "dataset" ? !!j.part : kind === "train" ? !!j.model : !!j.library);
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !finished)) timer.current = setTimeout(() => poll(id), 2000);
      else if (j.status === "done") done.current?.(j);
    } catch {
      timer.current = setTimeout(() => poll(id), 5000);
    }
  }, []);
  return { job, start: (j: Job) => { setJob(j); timer.current = setTimeout(() => poll(j.id), 1200); } };
}

function Collect({ name, onAdded }: { name: string; onAdded: () => void }) {
  const { status } = useStatus();
  const { toast } = useDialog();
  const [tab, setTab] = useState<"read" | "upload">("read");
  const [i, setI] = useState(0);
  const [rec, setRec] = useState<{ r: MediaRecorder; s: MediaStream; t0: number } | null>(null);
  const [secs, setSecs] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [up, setUp] = useState<number | null>(null);
  const chunks = useRef<Blob[]>([]);
  const { job, start } = usePoll((j) => { toast(`Added ${j.part?.clips ?? 0} clips (${j.part?.minutes ?? 0} min) to ${name}`, "ok"); onAdded(); });

  useEffect(() => { try { setI(Number(localStorage.getItem(`vb-read-${name}`)) || 0); } catch {} }, [name]);
  useEffect(() => { try { localStorage.setItem(`vb-read-${name}`, String(i)); } catch {} }, [i, name]);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setSecs((performance.now() - rec.t0) / 1000), 250);
    return () => clearInterval(t);
  }, [rec]);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === " " || e.key === "ArrowRight") { e.preventDefault(); setI((x) => (x + 1) % READ_ALONG.length); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec]);

  async function begin() {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.start(1000);
    setSecs(0);
    setRec({ r, s, t0: performance.now() });
  }
  async function finish() {
    if (!rec) return;
    const stopped = new Promise((ok) => (rec.r.onstop = ok));
    rec.r.stop();
    await stopped;
    rec.s.getTracks().forEach((t) => t.stop());
    const type = rec.r.mimeType || "audio/webm";
    setRec(null);
    await send([new File(chunks.current, `read-along-${Date.now()}.${type.includes("mp4") ? "m4a" : "webm"}`, { type })]);
  }
  async function send(list: File[]) {
    try {
      const keys: { key: string; name: string }[] = [];
      for (const [n, f] of list.entries()) {
        setUp(n / list.length);
        keys.push({ key: await uploadFile(f, f.name.replace(/[^A-Za-z0-9._-]/g, "_"), (x) => setUp((n + x) / list.length)), name: f.name });
      }
      setUp(null);
      setFiles([]);
      start(await api<Job>("jobs", { body: { kind: "dataset", name, sources: keys, label: `Dataset · ${name}` } }));
    } catch (e) {
      setUp(null);
      toast((e as Error).message, "bad");
    }
  }
  const busy = !!job && ["queued", "running"].includes(job.status);

  return (
    <div className="card">
      <div className="card-head"><h2>1 · Collect</h2>
        <div className="seg"><button className={tab === "read" ? "on" : ""} onClick={() => setTab("read")}>Read along</button><button className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>Upload</button></div>
      </div>
      {tab === "read" ? (
        <>
          <p className="dim small" style={{ marginTop: 0 }}>Record a session of 5-15 minutes, reading at your natural YouTube pace. Press <kbd>space</kbd> for the next line; pauses and
            retakes are fine (the worker cuts clean clips and drops the bad ones). Same mic and room every session.</p>
          <div className={`read-card big ${rec ? "live" : ""}`}>{READ_ALONG[i]}</div>
          <div className="row between">
            <div className="row" style={{ gap: 4 }}>
              <button className="icon-btn" aria-label="Previous line" onClick={() => setI((x) => (x - 1 + READ_ALONG.length) % READ_ALONG.length)}><CaretLeft size={16} /></button>
              <span className="mono tiny dim">{i + 1} / {READ_ALONG.length}</span>
              <button className="icon-btn" aria-label="Next line" onClick={() => setI((x) => (x + 1) % READ_ALONG.length)}><CaretRight size={16} /></button>
            </div>
            {rec ? (
              <div className="row" style={{ gap: 12 }}>
                <span className="rec-live-dot" /><span className="mono">{fmtS(secs)}</span>
                <button onClick={finish}><Stop size={15} weight="fill" /> Stop and add</button>
              </div>
            ) : <button onClick={begin} disabled={busy || up !== null || !status?.online}><Microphone size={15} weight="fill" /> Start a session</button>}
          </div>
        </>
      ) : (
        <>
          <p className="dim small" style={{ marginTop: 0 }}>Long recordings of just you talking work great: raw voiceovers, podcast tracks, a video&apos;s audio. Up to 3 hours per batch.</p>
          <label className="drop slim" style={{ cursor: "pointer" }}>
            <UploadSimple size={18} /><span className="small">{files.length ? files.map((f) => f.name).join(", ") : "Choose audio or video files"}</span>
            <input type="file" hidden multiple accept="audio/*,video/*" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          </label>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
            <button onClick={() => send(files)} disabled={!files.length || busy || up !== null || !status?.online}>Add to dataset <ArrowRight size={14} /></button>
          </div>
        </>
      )}
      {!status?.online && status && <p className="tiny dim">The GPU worker is offline; start the Colab notebook to process recordings.</p>}
      {(job || up !== null) && <div style={{ marginTop: 14 }}><JobProgress job={job} kind="reference" uploading={up !== null} uploadFrac={up ?? 0} /></div>}
    </div>
  );
}

const TRAIN_STAGES: Record<string, string> = { queued: "Waiting for the GPU", installing: "Installing the training tools", preparing: "Starting",
  downloading: "Fetching your recordings", encoding: "Turning your clips into tokens", loading: "Loading Orpheus 3B",
  training: "Learning your voice", saving: "Saving your model", testing: "Voicing a test line", done: "Done" };

function Train({ name, minutes }: { name: string; minutes: number }) {
  const { status } = useStatus();
  const { confirm, toast } = useDialog();
  const [model, setModel] = useState<Model | null>(null);
  const [err, setErr] = useState("");
  const loadModel = useCallback(() => { api<{ model: Model | null }>("model").then((r) => setModel(r.model)).catch(() => {}); }, []);
  useEffect(loadModel, [loadModel]);
  const { job, start } = usePoll((j) => { toast("Your voice is trained. It's the myvoice engine now.", "ok"); if (j.model) loadModel(); });
  const busy = !!job && ["queued", "running"].includes(job.status);
  const p = job?.progress;

  async function train() {
    setErr("");
    if (model && !(await confirm({ title: "Train a new model?", body: "It replaces the model the myvoice engine uses now. Voice and video jobs wait while the GPU trains (about 1-2 hours).", confirm: "Train" }))) return;
    try {
      start(await api<Job>("jobs", { body: { kind: "train", name } }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>2 · Train</h2><span className="dim tiny">on your GPU worker · about 1-2 h on a free T4</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>
        Fine-tunes Orpheus 3B on every clip in <b>{name}</b>. The worker pauses other jobs while it trains, then your model is
        saved to your storage and becomes the <b>myvoice</b> engine. Keep the Colab tab open until it finishes.
      </p>
      {model && !busy && (
        <div className="stack" style={{ gap: 8, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="row between small"><b>Current model · {model.name}</b>
            <span className="dim">{model.minutes.toFixed(1)} min · {model.clips} clips · {model.epochs} epochs · loss {model.loss.toFixed(3)} · {new Date(model.created).toLocaleDateString()}</span></div>
          {model.sample_url && <><span className="dim tiny">“{model.sample?.text}”</span><Player src={model.sample_url} compact /></>}
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
          {busy && <button className="ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => api(`jobs/${job.id}/cancel`, { method: "POST" }).catch(() => {})}>Cancel training</button>}
        </div>
      )}
      <div className="row between" style={{ marginTop: 12 }}>
        <span className="tiny dim">{minutes < 15 ? `Collect at least 15 minutes first (you have ${minutes.toFixed(1)}).` : `${minutes.toFixed(1)} minutes ready to train.`}</span>
        <span className="row" style={{ gap: 6 }}>
          <button className="sm" onClick={train} disabled={busy || minutes < 15 || !status?.online} title={!status?.online ? "Start the GPU worker first" : undefined}>
            {busy ? "Training…" : model ? "Train again" : "Train my voice"} <ArrowRight size={13} />
          </button>
        </span>
      </div>
      {err && <p className="err" style={{ margin: "8px 0 0" }}>{err}</p>}
    </div>
  );
}

function Benchmark({ mine }: { mine: MyVoice[] }) {
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
      picks.myvoice && { engine: "myvoice", voice: "me", label: "Your model" },
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
  const b = job?.benchmark;
  const best = b?.candidates.find((c) => !c.error);

  return (
    <div className="card">
      <div className="card-head"><h2>3 · Benchmark</h2><span className="dim tiny">same sentences, same scoring, every voice</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>Use sentences you never recorded. Voice match is measured against your real recording; naturalness is a predicted MOS (1-5); speed is seconds of compute per second of audio.</p>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 14 }}>
        <textarea className="doc short" value={lines} onChange={(e) => setLines(e.target.value)} style={{ minHeight: 170, marginTop: 0 }} />
        <div className="stack" style={{ gap: 10 }}>
          <div><label className="f">Your real voice (the target)</label>
            <select value={voice} onChange={(e) => setVoice(e.target.value)}>{mine.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}{!mine.length && <option value="">Record a voice on the Voices page</option>}</select></div>
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

export default function MyModel() {
  const { confirm } = useDialog();
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [name, setName] = useState("me");
  const [ds, setDs] = useState<Dataset | null>(null);
  const load = useCallback(() => { api<Dataset>(`datasets/${name}`).then(setDs).catch(() => setDs(null)); }, [name]);
  useEffect(() => { api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {}); }, []);
  useEffect(load, [load]);
  const minutes = ds?.minutes ?? 0;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Your model</div>
          <h1>A voice model that is <em>only you.</em></h1>
          <p className="sub">Cloning copies 20 seconds of you. A trained model learns how you actually talk from 30-60 minutes of it: your pace, your emphasis, the way you land a joke. Collect, train for free, then let the numbers decide.</p>
        </div>
        <div className="field" style={{ margin: 0, minWidth: 180 }}><label className="f">Dataset</label>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} /></div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between"><b>{minutes.toFixed(1)} min collected</b><span className="dim small">{ds?.clips ?? 0} clips · {ds?.parts.length ?? 0} sessions</span></div>
        <div className="meter"><i style={{ width: `${Math.min(100, (minutes / 60) * 100)}%` }} />{MILESTONES.map(([m, l]) => <span key={m} style={{ left: `${(m / 60) * 100}%` }}><em>{m} min · {l}</em></span>)}</div>
        {ds && ds.parts.length > 0 && (
          <div className="stack" style={{ gap: 4, marginTop: 30 }}>
            {ds.parts.slice().reverse().map((p) => (
              <div key={p.job} className="row between small" style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <span>{p.sources.map((s) => s.name).join(", ")}</span>
                <span className="row" style={{ gap: 10 }}>
                  <span className="dim">{p.minutes.toFixed(1)} of {p.input_minutes.toFixed(1)} min kept{Object.keys(p.dropped).length ? ` · dropped ${Object.entries(p.dropped).map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}</span>
                  <button className="icon-btn danger-h" aria-label="Remove session" onClick={async () => { if (await confirm({ title: "Remove this session from the dataset?", confirm: "Remove", danger: true })) { await api(`datasets/${name}/${p.job}`, { method: "DELETE" }); load(); } }}><TrashSimple size={14} /></button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <Collect name={name} onAdded={load} />
        <Train name={name} minutes={minutes} />
        <Benchmark mine={mine} />
      </div>
      <div style={{ height: 30 }} />
    </>
  );
}
