"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtS } from "./api";

type Param = { type: "number" | "integer" | "string"; default: number | string; min?: number; max?: number; about?: string };
type Engine = { about: string; voices: string[]; presets: Record<string, string>; params: Record<string, Param>; gpu_gb: number; state: string };
type Catalogue = { engines: Record<string, Engine>; references: string[]; preset_references: string[]; post_defaults: Record<string, unknown> };
type Line = { id: string; text: string; window?: number; params?: Record<string, number> };
type Result = { id: string; text: string; duration: number; window?: number | null; fits?: boolean | null; url?: string; seconds?: number };
type Job = { id: string; status: string; error?: string; progress: { done: number; total: number }; queue_position?: number; results: Result[]; library?: { id: string } | null };

const SAMPLE = `This little dot knows exactly where you are.
But how?
It's listening to clocks in space. About thirty satellites, high above.`;
const TAGS: Record<string, string> = {
  orpheus: "Inline emotion tags: <laugh> <chuckle> <sigh> <cough> <sniffle> <groan> <yawn> <gasp>",
  dia: "Non-verbals in brackets: (laughs) (sighs) (clears throat). Each line is spoken as [S1].",
  chatterbox: "Use the exaggeration slider for energy. Per-line: add a 5th TSV column.",
  kokoro: "Fast and flat. Great for timing drafts.",
};

/** Plain lines, "id | text | window", or the timeline TSV (id, start, window, text[, exaggeration]). */
function parse(src: string): Line[] {
  const out: Line[] = [];
  src.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !l.startsWith("#")).forEach((l, i) => {
    const tsv = l.split("\t");
    if (tsv.length >= 4 && !isNaN(+tsv[1]) && !isNaN(+tsv[2])) {
      const line: Line = { id: tsv[0].trim(), window: +tsv[2], text: tsv[3].trim() };
      if (tsv[4] && !isNaN(+tsv[4])) line.params = { exaggeration: +tsv[4] };
      return out.push(line);
    }
    const bar = l.split(" | ");
    if (bar.length >= 2) return out.push({ id: bar[0].trim(), text: bar[1].trim(), window: bar[2] ? +bar[2] : undefined });
    out.push({ id: String(i + 1).padStart(2, "0"), text: l.trim() });
  });
  return out;
}

export default function Generate() {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [offline, setOffline] = useState("");
  const [engine, setEngine] = useState("orpheus");
  const [voice, setVoice] = useState("female");
  const [params, setParams] = useState<Record<string, number | string>>({});
  const [post, setPost] = useState({ trim: true, normalize: true, sample_rate: 48000 });
  const [script, setScript] = useState(SAMPLE);
  const [label, setLabel] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState("");
  const [t0, setT0] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const saved = JSON.parse(localStorage.getItem("vb-gen") || "{}");
    if (saved.engine) setEngine(saved.engine);
    if (saved.voice) setVoice(saved.voice);
    if (saved.script) setScript(saved.script);
    if (saved.params) setParams(saved.params);
    api<Catalogue>("voices").then(setCat).catch((e) => setOffline(e.message));
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => { localStorage.setItem("vb-gen", JSON.stringify({ engine, voice, script, params })); }, [engine, voice, script, params]);

  const eng = cat?.engines[engine];
  const lines = useMemo(() => parse(script), [script]);
  const voices = useMemo(() => {
    if (!eng) return ["female", "male"];
    const base = ["female", "male", ...eng.voices.filter((v) => !v.startsWith("<") && v !== "female" && v !== "male")];
    return engine === "chatterbox" || engine === "dia" ? [...base, ...(cat?.references ?? []).filter((r) => !base.includes(r))] : base;
  }, [eng, engine, cat]);

  function pickEngine(name: string) {
    setEngine(name); setParams({});
    if (!["female", "male"].includes(voice)) setVoice("female");
  }

  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (["queued", "running"].includes(j.status)) timer.current = setTimeout(() => poll(id), 2000);
    } catch (e) {
      setErr((e as Error).message);
      timer.current = setTimeout(() => poll(id), 5000);
    }
  }

  async function submit(only?: Line[]) {
    setErr(""); setJob(null);
    const body = {
      engine, voice, lines: only ?? lines, params, label: label || undefined,
      post: { trim: post.trim, normalize_dbfs: post.normalize ? -3 : null, sample_rate: post.sample_rate || null },
    };
    try {
      const j = await api<Job>("jobs", { body });
      setJob(j); setT0(Date.now());
      timer.current = setTimeout(() => poll(j.id), 1500);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const running = job && ["queued", "running"].includes(job.status);
  const pct = job ? (job.progress.done / Math.max(job.progress.total, 1)) * 100 : 0;
  const elapsed = t0 ? (Date.now() - t0) / 1000 : 0;
  const total = job?.results.reduce((s, r) => s + r.duration, 0) ?? 0;

  return (
    <>
      <h1>Generate</h1>
      <p className="sub">Write or paste lines, pick a voice, and generate. Finished jobs are saved to the Library automatically.</p>
      {offline && <div className="card err" style={{ marginBottom: 16 }}>Worker offline: {offline}. Start the Colab notebook, then reload.</div>}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.5fr) minmax(280px, 1fr)", alignItems: "start" }}>
        <div className="card">
          <div className="row between" style={{ marginBottom: 8 }}>
            <label className="f" style={{ margin: 0 }}>Script · {lines.length} line{lines.length === 1 ? "" : "s"}</label>
            <span className="small dim">one line per row · or <span className="mono">id | text | seconds</span> · or timeline TSV</span>
          </div>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
          <p className="small dim" style={{ margin: "8px 0 14px" }}>{TAGS[engine]}</p>
          <div className="row">
            <input placeholder="Label (optional), e.g. gps-explainer v2" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <button className="ghost" disabled={!lines.length || !!running || !!offline} onClick={() => submit(lines.slice(0, 1))}>Test first line</button>
            <button className="sig" disabled={!lines.length || !!running || !!offline} onClick={() => submit()}>Generate {lines.length} line{lines.length === 1 ? "" : "s"}</button>
          </div>
          {err && <p className="err">{err}</p>}
        </div>

        <div className="card">
          <h2>Engine</h2>
          <div className="chips" style={{ marginBottom: 6 }}>
            {Object.keys(cat?.engines ?? { kokoro: 1, chatterbox: 1, orpheus: 1, dia: 1 }).map((n) => (
              <button key={n} className={`chip ${engine === n ? "on" : ""}`} onClick={() => pickEngine(n)}>{n}</button>
            ))}
          </div>
          <p className="small dim" style={{ marginTop: 6 }}>{eng?.about} {eng && <span className={`pill ${eng.state === "ready" ? "ok" : ""}`}>{eng.state}</span>}</p>

          <div className="field">
            <label className="f">Voice</label>
            <select value={voice} onChange={(e) => setVoice(e.target.value)}>
              {voices.map((v) => <option key={v} value={v}>{v}{eng?.presets[v] && eng.presets[v] !== v ? ` (${eng.presets[v]})` : ""}</option>)}
            </select>
          </div>

          {eng && Object.entries(eng.params).map(([k, p]) => {
            const v = params[k] ?? p.default;
            if (p.type === "string") return (
              <div className="field" key={k}>
                <label className="f">{k} <span className="dim">{p.about}</span></label>
                <input value={String(v)} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
              </div>
            );
            if (p.min === undefined) return (
              <div className="field" key={k}>
                <label className="f">{k}</label>
                <input type="number" value={Number(v)} onChange={(e) => setParams({ ...params, [k]: +e.target.value })} />
              </div>
            );
            const step = p.type === "integer" ? (p.max! - p.min! > 500 ? 50 : 1) : 0.05;
            return (
              <div className="field" key={k}>
                <div className="row between"><label className="f" style={{ margin: 0 }}>{k}</label><span className="mono small">{Number(v).toFixed(p.type === "integer" ? 0 : 2)}</span></div>
                <input type="range" min={p.min} max={p.max} step={step} value={Number(v)} onChange={(e) => setParams({ ...params, [k]: +e.target.value })} />
                {p.about && <div className="small dim">{p.about}</div>}
              </div>
            );
          })}
          {Object.keys(params).length > 0 && <button className="ghost tiny" onClick={() => setParams({})}>Reset to defaults</button>}

          <h2 style={{ marginTop: 18 }}>Output</h2>
          <div className="row small" style={{ gap: 16 }}>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={post.trim} onChange={(e) => setPost({ ...post, trim: e.target.checked })} />Trim silence</label>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={post.normalize} onChange={(e) => setPost({ ...post, normalize: e.target.checked })} />Normalize −3 dB</label>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <select value={post.sample_rate} onChange={(e) => setPost({ ...post, sample_rate: +e.target.value })}>
              <option value={48000}>48 kHz (video)</option><option value={44100}>44.1 kHz</option><option value={24000}>24 kHz</option><option value={0}>engine native</option>
            </select>
          </div>
        </div>
      </div>

      {job && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row between">
            <div className="row">
              <span className={`pill ${job.status === "done" ? "ok" : job.status === "error" ? "bad" : "blue"}`}>{job.status}{job.status === "queued" && job.queue_position ? ` #${job.queue_position}` : ""}</span>
              <span className="mono small dim">{job.id} · {job.progress.done}/{job.progress.total} · {fmtS(elapsed)}{total ? ` · ${fmtS(total)} audio` : ""}</span>
            </div>
            <div className="row">
              {running && <button className="ghost tiny" onClick={() => api(`jobs/${job.id}/cancel`, { body: {} })}>Cancel</button>}
              {job.library && <><Link className="btn tiny" href={`/library#${job.id}`}>Open in library</Link><a className="btn ghost tiny" href={`/api/zip/${job.id}`}>Download zip</a></>}
            </div>
          </div>
          <div className="bar" style={{ margin: "12px 0 4px" }}><i style={{ width: `${pct}%` }} /></div>
          {running && job.progress.done === 0 && <p className="small dim">The first job on an engine installs and loads it, which can take 1–5 minutes. After that, lines take seconds.</p>}
          {job.error && <p className="err">{job.error}</p>}
          {job.results.map((r) => (
            <div className="line" key={r.id}>
              <span className="mono small dim">{r.id}</span>
              <span className="t">{r.text}</span>
              <audio controls preload="none" src={job.library ? `/api/audio/${job.id}/${r.id}.wav` : r.url} />
              <span className="row acts" style={{ gap: 6 }}>
                <span className="mono small">{r.duration.toFixed(2)}s</span>
                {r.fits === false && <span className="pill bad">over {r.window}s</span>}
                {r.fits === true && <span className="pill ok">fits</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
