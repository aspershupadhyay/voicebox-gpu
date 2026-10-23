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
import { FilePreview, SavedTakes, startRecording, VoiceOrb, type Recording } from "./Recorder";
import { useStatus } from "./Shell";

type Part = { job: string; clips: number; minutes: number; input_minutes: number; dropped: Record<string, number>; created: number;
  sources: { name: string; duration: number; clips: number }[] };
type Dataset = { name: string; parts: Part[]; clips: number; minutes: number };
type Model = { name: string; job: string; created: number; clips: number; minutes: number; epochs: number; loss: number;
  sample: { text: string; duration: number } | null; sample_url?: string | null; best_epoch?: number; flow_clips?: number };
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
  const [rec, setRec] = useState<(Recording & { t0: number }) | null>(null);
  const [secs, setSecs] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [take, setTake] = useState<File | null>(null); // a finished session, waiting for you to listen and keep it
  const [up, setUp] = useState<number | null>(null);
  const forget = useRef<(() => void)[]>([]); // drop the sent sessions from this device once the dataset job is queued
  const [kept, setKept] = useState<string | null>(null);
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
    // saved to this device every second: a refresh mid-session keeps it (offered back below the card)
    const r = await startRecording(`dataset:${name}`, `line ${i + 1}`);
    setSecs(0);
    setRec({ ...r, t0: performance.now() });
  }
  async function finish() {
    if (!rec) return;
    const f = await rec.stop();
    forget.current = [rec.forget];
    setKept(rec.take.id);
    setRec(null);
    setTake(f);
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
      setTake(null);
      start(await api<Job>("jobs", { body: { kind: "dataset", name, sources: keys, label: `Dataset · ${name}` } }));
      forget.current.forEach((f) => f()); forget.current = []; setKept(null);
    } catch (e) {
      setUp(null);
      toast((e as Error).message, "bad");
    }
  }
  const busy = !!job && ["queued", "running"].includes(job.status);
  useResumeJob<Polled>(["dataset"], (j) => { if ((j as Polled & { voice?: string }).voice === name) start(j); });

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
                <VoiceOrb stream={rec.stream} size={64} /><span className="mono">{fmtS(secs)}</span>
                <button onClick={finish}><Stop size={15} weight="fill" /> Stop</button>
              </div>
            ) : !take && <button onClick={begin} disabled={busy || up !== null || !status?.online}><Microphone size={15} weight="fill" /> Start a session</button>}
          </div>
          {!rec && !take && <div style={{ marginTop: 12 }}><SavedTakes scope={`dataset:${name}`} live={kept} useLabel="Review" onUse={(f, t) => {
            forget.current = [() => import("./takes").then((m) => m.dropTake(t.id))]; setKept(t.id); setTake(f);
          }} /></div>}
          {take && (
            <div className="stack" style={{ gap: 8, marginTop: 12, padding: 12, border: "1px solid var(--line)", borderRadius: 12 }}>
              <b className="small">Listen before it goes into {name}&apos;s dataset</b>
              <FilePreview file={take} />
              <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
                <button className="ghost sm" onClick={() => { forget.current.forEach((f) => f()); forget.current = []; setKept(null); setTake(null); }}>Discard</button>
                <button className="sm" onClick={() => send([take])} disabled={busy || up !== null || !status?.online}>Add to dataset <ArrowRight size={13} /></button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="dim small" style={{ marginTop: 0 }}>Long recordings of just you talking work great: raw voiceovers, podcast tracks, a video&apos;s audio. Up to 3 hours per batch.</p>
          <label className="drop slim" style={{ cursor: "pointer" }}>
            <UploadSimple size={18} /><span className="small">{files.length ? files.map((f) => f.name).join(", ") : "Choose audio or video files"}</span>
            <input type="file" hidden multiple accept="audio/*,video/*" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          </label>
          {files.length > 0 && (
            <div className="stack" style={{ gap: 10, marginTop: 10 }}>
              {files.map((f, k) => <FilePreview key={`${f.name}-${k}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== k))} />)}
            </div>
          )}
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

function Train({ name, minutes, onTrained }: { name: string; minutes: number; onTrained: () => void }) {
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

  async function train() {
    setErr("");
    if (model && !(await confirm({ title: `Train ${name} again?`, body: `It replaces ${name}'s model (other people's models stay). Voice and video jobs wait while the GPU trains (about 1-2 hours on a free T4).`, confirm: "Train" }))) return;
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
        Fine-tunes Orpheus 3B on every clip in <b>{name}</b>. The worker pauses other jobs while it trains, then the model is
        saved to your storage as <b>{name}</b> under <b>Your model</b> in Voiceover, for both of you. Keep the Colab tab open until it finishes.
      </p>
      {model && !busy && (
        <div className="stack" style={{ gap: 8, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="row between small"><b>Current model · {model.name}</b>
            <span className="dim">{model.minutes.toFixed(1)} min · {model.clips} clips · {model.best_epoch ? `best of ${model.epochs} epochs: ${model.best_epoch}` : `${model.epochs} epochs`} · loss {model.loss.toFixed(3)}{model.flow_clips ? " · flow" : ""} · {new Date(model.created).toLocaleDateString()}</span></div>
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

type Person = { name: string; minutes: number; clips: number };

export default function MyModel() {
  const { confirm } = useDialog();
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [name, setName] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [ds, setDs] = useState<Dataset | null>(null);
  const load = useCallback(() => { if (name) api<Dataset>(`datasets/${name}`).then(setDs).catch(() => setDs(null)); }, [name]);
  const loadModels = useCallback(() => { api<{ models: Model[] }>("models").then((r) => setModels(r.models)).catch(() => {}); }, []);
  useEffect(() => { api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {}); }, []);
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

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Your model</div>
          <h1>A voice model that is <em>only you.</em></h1>
          <p className="sub">Cloning copies 20 seconds of you. A trained model learns how you actually talk from 30-60 minutes of it: your pace, your emphasis, the way you land a joke. Collect, train for free, then let the numbers decide. Each of you gets your own: pick your name.</p>
        </div>
        <div className="field" style={{ margin: 0, minWidth: 180 }}><label className="f">Whose voice (dataset)</label>
          <input list="vb-people" value={name} placeholder="your name" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} />
          <datalist id="vb-people">{people.map((p) => <option key={p.name} value={p.name}>{p.minutes.toFixed(1)} min</option>)}</datalist></div>
      </div>
      {(people.length > 1 || models.length > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Everyone&apos;s voices</h2><span className="dim tiny">trained models are shared: use them in Voiceover under Your model</span></div>
          <div className="stack" style={{ gap: 8 }}>
            {[...new Set([...people.map((p) => p.name), ...models.map((m) => m.name)])].map((n) => {
              const m = models.find((x) => x.name === n);
              const p = people.find((x) => x.name === n);
              return (
                <div key={n} className="row between small" style={{ padding: "6px 0", borderTop: "1px solid var(--line)", gap: 12 }}>
                  <button className={`quiet xs ${n === name ? "on" : ""}`} onClick={() => setName(n)}><b>{n}</b></button>
                  <span className="dim">{p ? `${p.minutes.toFixed(1)} min collected` : ""}{m ? ` · trained ${new Date(m.created).toLocaleDateString()}` : " · not trained yet"}</span>
                  {m?.sample_url ? <span style={{ minWidth: 0, flex: "0 1 260px" }}><Player src={m.sample_url} compact /></span> : <span />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between"><b>{name || "…"} · {minutes.toFixed(1)} min collected</b><span className="dim small">{ds?.clips ?? 0} clips · {ds?.parts.length ?? 0} sessions</span></div>
        <div className="meter"><i style={{ width: `${Math.min(100, (minutes / 60) * 100)}%` }} />{MILESTONES.map(([m, l]) => <span key={m} style={{ left: `${(m / 60) * 100}%` }}><em>{m} min · {l}</em></span>)}</div>
        {ds && ds.parts.length > 0 && (
          <div className="stack" style={{ gap: 4, marginTop: 30 }}>
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
        )}
      </div>
      {name && (
        <div className="stack" style={{ gap: 16 }}>
          <Collect name={name} onAdded={refresh} />
          <Train name={name} minutes={minutes} onTrained={loadModels} />
          <Benchmark mine={mine} name={name} />
        </div>
      )}
      <div style={{ height: 30 }} />
    </>
  );
}
