"use client";
import { ArrowSquareOut, CaretDown, ClosedCaptioning, DownloadSimple, Eye, Flask, Microphone, SlidersHorizontal, Sparkle, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtS, pct, rangeFill, type Job } from "./api";
import { EngineArt, StyleGlyph, VoiceGlyph } from "./art";
import { GuideButton } from "./GuideDrawer";
import { GUIDES, KOKORO_LANG, LANGUAGES } from "./guides";
import JobProgress from "./JobProgress";
import LineRow from "./LineRow";
import { useStatus } from "./Shell";

type Param = { type: "number" | "integer" | "string"; default: number | string; min?: number; max?: number; about?: string };
type Engine = { kind: string; about: string; voices: string[]; presets: Record<string, string>; params: Record<string, Param>; state: string; seconds_per_char?: number };
type Style = { label: string; about: string; params: Record<string, Record<string, number>>; post: { tempo?: number }; post_by_engine?: Record<string, { tempo?: number }>; voices: Record<string, string[]> };
type Catalogue = { engines: Record<string, Engine>; references: string[]; styles?: Record<string, Style>; default_style?: string };
type ParsedLine = { id: string; text: string; window?: number; start?: number; params?: Record<string, number> };

const TTS = ["orpheus", "chatterbox", "kokoro"] as const;
const BLURB: Record<string, string> = { orpheus: "Most human · English", chatterbox: "Emotion · cloning · 23 langs", kokoro: "Instant drafts · CPU" };
const STYLE_ORDER = ["tech", "hype", "narrator", "neutral"];
const TAGS = ["<laugh>", "<chuckle>", "<sigh>", "<gasp>", "<groan>", "<yawn>", "<sniffle>", "<cough>"];
const LOAD_S: Record<string, number> = { orpheus: 120, chatterbox: 45, kokoro: 5, whisper: 40 };
const RATE: Record<string, number> = { orpheus: 0.03, chatterbox: 0.06, kokoro: 0.004, whisper: 0.06 };
const SAMPLE = `This little dot knows exactly where you are.
But... how?
It's listening to clocks in space. About thirty satellites, high above.`;

function parse(src: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  src.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !l.startsWith("#")).forEach((l, i) => {
    const tsv = l.split("\t");
    if (tsv.length >= 4 && !isNaN(+tsv[1]) && !isNaN(+tsv[2])) {
      const line: ParsedLine = { id: tsv[0].trim(), start: +tsv[1], window: +tsv[2], text: tsv[3].trim() };
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
  const { status } = useStatus();
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [catErr, setCatErr] = useState("");
  const [engine, setEngine] = useState<string>("orpheus");
  const [lang, setLang] = useState("en");
  const [voice, setVoice] = useState("female");
  const [params, setParams] = useState<Record<string, number | string>>({});
  const [style, setStyle] = useState("tech");
  const [tempo, setTempo] = useState<number | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  const [post, setPost] = useState({ trim: true, normalize: true, sample_rate: 48000 });
  const [advanced, setAdvanced] = useState(false);
  const [script, setScript] = useState(SAMPLE);
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [lib, setLib] = useState<{ results: { id: string; audio: string }[] } | null>(null);
  const [err, setErr] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const s = JSON.parse(localStorage.getItem("vb-gen2") || "{}");
    if (s.engine) setEngine(s.engine); if (s.voice) setVoice(s.voice); if (s.script) setScript(s.script);
    if (s.params) setParams(s.params); if (s.style) setStyle(s.style); if (s.lang) setLang(s.lang); if (s.subtitles !== undefined) setSubtitles(s.subtitles);
    loaded.current = true;
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => { if (loaded.current) localStorage.setItem("vb-gen2", JSON.stringify({ engine, voice, script, params, style, lang, subtitles })); }, [engine, voice, script, params, style, lang, subtitles]);
  useEffect(() => { if (status?.online && !cat) api<Catalogue>("voices").then(setCat).catch((e) => setCatErr(e.message)); }, [status?.online, cat]);

  const eng = cat?.engines[engine];
  const styles: Record<string, Style> = cat?.styles ?? {};
  const styleParams: Record<string, number> = styles[style]?.params?.[engine] ?? {};
  const effTempo = tempo ?? styles[style]?.post_by_engine?.[engine]?.tempo ?? styles[style]?.post?.tempo ?? 1;
  const lines = useMemo(() => parse(script), [script]);
  const lively = styles[style]?.voices?.[engine] ?? [];
  const chars = lines.reduce((s, l) => s + l.text.length, 0);
  const langs = LANGUAGES.filter((l) => l.engines.includes(engine));
  const voices = useMemo(() => {
    if (engine === "kokoro") return (eng?.voices ?? []).filter((v) => KOKORO_LANG[v[0]] === lang);
    if (engine === "orpheus") return eng?.voices ?? [];
    const base = ["female", "male", ...(eng?.voices ?? []).filter((v) => !v.startsWith("<") && v !== "female" && v !== "male")];
    return engine === "chatterbox" ? [...base, ...(cat?.references ?? []).filter((r) => !base.includes(r))] : base;
  }, [eng, engine, lang, cat]);

  useEffect(() => {
    if (!langs.some((l) => l.code === lang)) setLang("en");
    if (engine === "kokoro" && voices.length && !voices.includes(voice)) setVoice(voices[0]);
    if (engine !== "kokoro" && !voices.includes(voice) && voices.length) setVoice(engine === "orpheus" ? (voice === "male" ? "dan" : "tara") : "female");
  }, [engine, lang, voices, voice, langs]);

  const rate = status?.rates?.[engine] ?? eng?.seconds_per_char ?? RATE[engine];
  const audioS = chars / 14.5;
  const ready = status?.engines?.[engine] === "ready";
  const subsReady = status?.engines?.whisper === "ready";
  const estS = rate * chars + (ready ? 0 : LOAD_S[engine]) + (subtitles ? (status?.rates?.whisper ?? RATE.whisper) * audioS + (subsReady ? 0 : LOAD_S.whisper) : 0) + 4;

  function insertTag(tag: string) {
    const el = ta.current!;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const before = script.slice(0, a), after = script.slice(b);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}${tag} ${after}`;
    setScript(next);
    requestAnimationFrame(() => { el.focus(); const p = a + pad.length + tag.length + 1; el.setSelectionRange(p, p); });
  }

  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (j.library) api(`library/${id}`).then(setLib).catch(() => {});
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !j.library)) timer.current = setTimeout(() => poll(id), 1500);
    } catch (e) {
      setErr((e as Error).message);
      timer.current = setTimeout(() => poll(id), 4000);
    }
  }

  async function submit(only?: ParsedLine[]) {
    setErr(""); setJob(null); setLib(null);
    const p = { ...params };
    if (engine === "chatterbox") p.language = lang;
    try {
      const j = await api<Job>("jobs", {
        body: {
          engine, voice, style, lines: only ?? lines, params: p, label: label || undefined, subtitles, language: lang,
          post: { trim: post.trim, normalize_dbfs: post.normalize ? -3 : null, sample_rate: post.sample_rate || null, ...(tempo != null ? { tempo } : {}) },
        },
      });
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 800);
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const running = !!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library));
  const libAudio = (id: string) => lib?.results.find((r) => r.id === id)?.audio;
  const slug = (label || `${engine}-${voice}`).replace(/[^A-Za-z0-9._-]/g, "_");

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Record</div>
          <h1>Write it, <em>hear it.</em></h1>
          <p className="sub">Script on the left, the voice on the right. Every take lands in the Library with word-timed subtitles.</p>
        </div>
        <GuideButton engine={engine} />
      </div>
      {!status?.online && status && <div className="banner"><WarningCircle size={20} weight="duotone" color="var(--signal2)" /><div><b>The GPU worker is offline.</b> <span className="dim">Run the Colab notebook; this page reconnects by itself.</span></div></div>}
      {catErr && <p className="err">{catErr}</p>}

      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h2>Script</h2>
              <span className="dim tiny">one line per row · <span className="mono">id | text | seconds</span> · or paste a timeline TSV</span>
            </div>
            {engine === "orpheus" && (
              <div className="chips" style={{ marginBottom: 12 }}>
                <span className="label" style={{ alignSelf: "center", marginRight: 4 }}>Insert</span>
                {TAGS.map((t) => <button key={t} className="chip tag" onClick={() => insertTag(t)}>{t}</button>)}
              </div>
            )}
            <textarea ref={ta} value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false}
              placeholder={lang === "hi" ? "यहाँ अपनी स्क्रिप्ट लिखें, हर पंक्ति एक लाइन…" : "Write your script here, one line per row…"} />
            <div className="row between" style={{ marginTop: 10 }}>
              <span className="dim small mono">{lines.length} line{lines.length === 1 ? "" : "s"} · {chars.toLocaleString()} chars · ≈ {fmtS(audioS)} of speech</span>
              {lines.length > 0 && <button className="quiet xs" onClick={() => setPreview(!preview)}><Eye size={14} />{preview ? "Hide" : "Preview"} lines</button>}
            </div>
            {preview && (
              <table className="table small" style={{ marginTop: 8 }}><tbody>
                {lines.map((l) => (
                  <tr key={l.id}><td className="mono dim" style={{ width: 50 }}>{l.id}</td><td>{l.text}</td>
                    <td className="mono dim" style={{ whiteSpace: "nowrap" }}>≈{(l.text.length / 14.5).toFixed(1)}s{l.window ? ` / ${l.window}s` : ""}</td></tr>
                ))}
              </tbody></table>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>Engine</h2></div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
              {TTS.map((n) => (
                <button key={n} className={`pick engine-tile ${engine === n ? "on" : ""}`} onClick={() => { setEngine(n); setParams({}); }}>
                  <span className="art"><EngineArt engine={n} live={engine === n} /></span>
                  <span className="row between" style={{ marginTop: 10 }}><span className="t1" style={{ textTransform: "capitalize", font: "400 21px var(--display)" }}>{n}</span>
                    <span className={`dot ${status?.engines?.[n] === "ready" ? "ok" : status?.engines?.[n] === "loading" || status?.engines?.[n] === "installing" ? "warn" : "off"}`} title={status?.engines?.[n] ?? ""} /></span>
                  <span className="t2" style={{ display: "block" }}>{BLURB[n]}</span>
                </button>
              ))}
            </div>
            <p className="dim small" style={{ margin: "14px 0 0" }}>{GUIDES[engine].tagline}</p>
          </div>
          <div className="card flat sub-toggle">
            <span className="thumb" style={{ color: "var(--glacier)" }}><ClosedCaptioning size={20} weight="duotone" /></span>
            <div style={{ minWidth: 0 }}><b>Subtitles</b><div className="dim small">Whisper large-v3 word timing · SRT, VTT and JSON · a match score per line</div></div>
            <GuideButton engine="whisper" label="How" />
            <button className={`switch ${subtitles ? "on" : ""}`} onClick={() => setSubtitles(!subtitles)} aria-label="Subtitles" />
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>Delivery</h2><span className="dim tiny">how the read feels</span></div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {STYLE_ORDER.filter((k) => styles[k]).map((k) => (
                <button key={k} className={`pick style-pick ${style === k ? "on" : ""}`} title={styles[k].about}
                  onClick={() => { setStyle(k); setParams({}); setTempo(null); }}>
                  <div className="t1">{styles[k].label}</div>
                  <StyleGlyph style={k} active={style === k} />
                </button>
              ))}
            </div>
            <p className="dim small" style={{ margin: "12px 0 0" }}>{styles[style]?.about}</p>
            <div className="field" style={{ margin: "16px 0 0" }}>
              <div className="row between" style={{ marginBottom: 4 }}><label className="f" style={{ margin: 0 }}>Pace</label><span className="mono small">{effTempo.toFixed(2)}×</span></div>
              <input type="range" min={0.85} max={1.2} step={0.01} value={effTempo} style={rangeFill(effTempo, 0.85, 1.2)} onChange={(e) => setTempo(+e.target.value)} />
              <div className="dim tiny" style={{ marginTop: 4 }}>Pitch-preserving, applied after the voice is generated. Stay within ±8% to keep it natural.</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Voice</h2></div>
            <div className="field">
              <label className="f">Language</label>
              <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={engine === "orpheus"}>
                {langs.map((l) => <option key={l.code} value={l.code}>{l.name}{l.script ? ` · ${l.script}` : ""}</option>)}
              </select>
              {engine === "orpheus" && <div className="dim tiny" style={{ marginTop: 5 }}>Orpheus speaks English only. Use Chatterbox for Hindi and 21 more languages.</div>}
              {lang !== "en" && <div className="dim tiny" style={{ marginTop: 5 }}>Write in {LANGUAGES.find((l) => l.code === lang)?.script ?? "the language's own spelling"}, not romanised text.</div>}
            </div>
            <div className="field">
              <div className="row between" style={{ marginBottom: 8 }}><label className="f" style={{ margin: 0 }}>Voice</label>
                {lively.length > 0 && <span className="tiny dim"><Sparkle size={12} weight="fill" color="var(--sand)" /> liveliest for {styles[style]?.label.toLowerCase()}</span>}</div>
              <div className="voices">
                {[...voices.filter((v) => lively.includes(v)), ...voices.filter((v) => !lively.includes(v))].map((v) => {
                  const real = eng?.presets[v] && eng.presets[v] !== v ? eng.presets[v] : v;
                  return (
                    <button key={v} className={`pick voice-pick ${voice === v ? "on" : ""}`} onClick={() => setVoice(v)}>
                      {lively.includes(v) && <Sparkle size={12} weight="fill" className="star" />}
                      <VoiceGlyph name={real} size={46} active={voice === v} />
                      <span className="vn">{v}</span>
                      <span className="vs">{real !== v ? real : engine === "kokoro" ? KOKORO_LANG[v[0]] ?? "" : engine}</span>
                    </button>
                  );
                })}
              </div>
              {!voices.length && <span className="dim small">No {engine} voices for this language.</span>}
            </div>
            {eng && Object.entries(eng.params).filter(([k]) => !(engine === "chatterbox" && k === "language") && !(engine === "kokoro" && k === "lang")).map(([k, p]) => {
              const v = params[k] ?? styleParams[k] ?? p.default;
              if (p.min === undefined) return (
                <div className="field" key={k}><label className="f">{k}</label>
                  <input type={p.type === "string" ? "text" : "number"} value={String(v)} onChange={(e) => setParams({ ...params, [k]: p.type === "string" ? e.target.value : +e.target.value })} />
                  {p.about && <div className="dim tiny" style={{ marginTop: 4 }}>{p.about}</div>}</div>
              );
              return (
                <div className="field" key={k}>
                  <div className="row between" style={{ marginBottom: 6 }}><label className="f" style={{ margin: 0 }}>{k.replace(/_/g, " ")}</label><span className="mono small">{Number(v).toFixed(p.type === "integer" ? 0 : 2)}</span></div>
                  <input type="range" min={p.min} max={p.max} step={p.type === "integer" ? 1 : 0.05} value={Number(v)} style={rangeFill(Number(v), p.min, p.max)} onChange={(e) => setParams({ ...params, [k]: +e.target.value })} />
                  {p.about && <div className="dim tiny" style={{ marginTop: 5 }}>{p.about}</div>}
                </div>
              );
            })}
            <div className="row between">
              <button className="quiet xs" onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={14} />Output options<CaretDown size={12} style={{ transform: advanced ? "rotate(180deg)" : "none", transition: "transform .2s" }} /></button>
              {(Object.keys(params).length > 0 || tempo != null) && <button className="quiet xs" onClick={() => { setParams({}); setTempo(null); }}>Reset to {styles[style]?.label ?? "style"}</button>}
            </div>
            {advanced && (
              <div style={{ marginTop: 12 }}>
                <label className="row small" style={{ gap: 8, marginBottom: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={post.trim} onChange={(e) => setPost({ ...post, trim: e.target.checked })} />Trim leading/trailing silence</label>
                <label className="row small" style={{ gap: 8, marginBottom: 10 }}><input type="checkbox" style={{ width: "auto" }} checked={post.normalize} onChange={(e) => setPost({ ...post, normalize: e.target.checked })} />Normalize peaks to −3 dB</label>
                <select value={post.sample_rate} onChange={(e) => setPost({ ...post, sample_rate: +e.target.value })}>
                  <option value={48000}>48 kHz · video</option><option value={44100}>44.1 kHz · music</option><option value={24000}>24 kHz</option><option value={0}>engine native</option>
                </select>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="sticky">
        <VoiceGlyph name={eng?.presets[voice] && eng.presets[voice] !== voice ? eng.presets[voice] : voice} size={40} active={running} />
        <input placeholder="Name this take (optional)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: "0 1 240px" }} />
        <div className="sum">
          <div><div className="label">Voice</div><b><span style={{ textTransform: "capitalize" }}>{engine}</span> · {voice}</b></div>
          <div><div className="label">Length</div><b>{lines.length} · ≈{fmtS(audioS)}</b></div>
          <div title={!ready ? "includes warm-up" : undefined}><div className="label">Ready in</div><b>≈{fmtS(estS)}</b></div>
        </div>
        <button className="ghost" disabled={!lines.length || running || !status?.online} onClick={() => submit(lines.slice(0, 1))}><Flask size={16} />Test line 1</button>
        <button className="sig lg" disabled={!lines.length || running || !status?.online} onClick={() => submit()}><Microphone size={17} weight="bold" />Generate</button>
      </div>
      {err && <p className="err">{err}</p>}

      {job && (
        <div className="stack" style={{ gap: 16, marginTop: 18 }}>
          <JobProgress job={job} onCancel={() => api(`jobs/${job.id}/cancel`, { body: {} })} />
          {job.results.length > 0 && (
            <div className="card reveal">
              <div className="row between" style={{ marginBottom: 6 }}>
                <h2 style={{ margin: 0 }}>Takes{job.match != null ? <span className={`pill ${job.match >= 0.95 ? "ok" : "warn"}`}>script match {pct(job.match)}</span> : null}</h2>
                {job.library && (
                  <div className="row">
                    <Link className="btn ghost sm" href={`/library#${job.id}`}><ArrowSquareOut size={14} />Library</Link>
                    {job.subs && <a className="btn ghost sm" href={`/api/file/${job.id}/subtitles.srt?download&name=${slug}.srt`}><ClosedCaptioning size={14} />.srt</a>}
                    <a className="btn sm" href={`/api/zip/${job.id}`}><DownloadSimple size={14} weight="bold" />Download all</a>
                  </div>
                )}
              </div>
              {job.results.map((r) => (
                <LineRow key={r.id} jobId={job.id} line={job.library ? r : { ...r, subs: false }} audio={libAudio(r.id) ?? r.url} slug={slug} scale={r.duration / Math.max(...job.results.map((x) => x.duration), 0.1)} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
