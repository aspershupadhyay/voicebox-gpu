"use client";
import {
  ArrowSquareOut, ArrowsClockwise, CaretDown, DiceFive, DownloadSimple, FilmSlate, ImageSquare, Lightning, Prohibit, Sparkle,
  SpeakerHigh, SpeakerSlash, UploadSimple, WarningCircle, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, fmtS, rangeFill, uploadFile, type Gen, type Job } from "./api";
import { ClapperArt, EngineArt } from "./art";
import { GuideButton } from "./GuideDrawer";
import JobProgress from "./JobProgress";
import { useStatus } from "./Shell";

type Spec = { about: string; sizes: Record<string, [number, number]>; qualities: Record<string, { steps: number; guidance: number; about: string }>; max_seconds: number; fps: number; disk_gb: number; downloaded?: boolean };
type LibVideo = { id: string; kind?: string; label?: string; created: number; engine: string; gen?: Gen; video?: { width: number; height: number; duration: number; has_audio?: boolean; size: number }; video_url?: string; poster_url?: string | null };

// Mirrors worker/config.py so the page is usable (and estimates work) before the worker reports in.
const SPECS: Record<string, Spec> = {
  wan: { about: "Sharp 720p, strong motion, best prompt following. Silent, up to 5 s.", sizes: { "16:9": [1280, 704], "9:16": [704, 1280], "1:1": [960, 960] },
    qualities: { fast: { steps: 4, guidance: 1, about: "Turbo · 4 steps" }, full: { steps: 30, guidance: 5, about: "Original · 30 steps, ~10× slower" } }, max_seconds: 5, fps: 24, disk_gb: 23 },
  ltx: { about: "Picture and matching sound in one pass. Up to 10 s, softer detail.", sizes: { "16:9": [1024, 576], "9:16": [576, 1024], "1:1": [768, 768] },
    qualities: { fast: { steps: 8, guidance: 1, about: "Distilled · 8 steps" } }, max_seconds: 10, fps: 24, disk_gb: 48 },
};
const NAMES: Record<string, string> = { wan: "Wan 2.2", ltx: "LTX-2.3" };
const PRIOR: Record<string, number> = { wan: 0.3, ltx: 0.35 };
const LOAD_S: Record<string, number> = { wan: 150, ltx: 300 };
const MB_PER_S = 150; // typical Colab download speed from Hugging Face
const CHIPS = {
  Camera: ["slow dolly in", "orbit around the subject", "tracking shot", "aerial drone shot", "handheld, slight shake", "static tripod shot"],
  Look: ["cinematic lighting", "neon rim light", "soft studio light", "macro close-up", "isometric 3D render", "clean motion graphics"],
};
const STARTER = "Close-up of a glowing GPS chip on a dark circuit board, tiny signal rings pulsing outward in teal light. Slow dolly in, shallow depth of field, cinematic, high contrast, dust drifting in the air.";

function Aspect({ a, on, onPick, w, h }: { a: string; on: boolean; onPick: () => void; w: number; h: number }) {
  const s = 30 / Math.max(w, h);
  return (
    <button className={`pick aspect-pick ${on ? "on" : ""}`} onClick={onPick}>
      <span className="frame"><i style={{ width: w * s, height: h * s }} /></span>
      <b>{a}</b><span className="dim tiny mono">{w}×{h}</span>
    </button>
  );
}

export default function Video() {
  const { status } = useStatus();
  const [specs, setSpecs] = useState(SPECS);
  const [model, setModel] = useState("wan");
  const [prompt, setPrompt] = useState(STARTER);
  const [negative, setNegative] = useState("");
  const [showNeg, setShowNeg] = useState(false);
  const [aspect, setAspect] = useState("9:16");
  const [seconds, setSeconds] = useState(5);
  const [quality, setQuality] = useState("fast");
  const [seed, setSeed] = useState(7);
  const [audio, setAudio] = useState(true);
  const [frameMode, setFrameMode] = useState<"none" | "upload" | "library">("none");
  const [file, setFile] = useState<{ file: File; url: string } | null>(null);
  const [fromLib, setFromLib] = useState<string | null>(null);
  const [history, setHistory] = useState<LibVideo[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [lib, setLib] = useState<LibVideo | null>(null);
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const s = JSON.parse(localStorage.getItem("vb-video") || "{}");
    if (s.model) setModel(s.model); if (s.prompt) setPrompt(s.prompt); if (s.aspect) setAspect(s.aspect);
    if (s.seconds) setSeconds(s.seconds); if (s.quality) setQuality(s.quality); if (s.audio !== undefined) setAudio(s.audio);
    loaded.current = true;
    refreshHistory();
    const from = new URLSearchParams(location.search).get("from"); // "Open in Video" from the Library
    if (from) api<LibVideo>(`library/${from}`).then(reuse).catch(() => {});
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => { if (loaded.current) localStorage.setItem("vb-video", JSON.stringify({ model, prompt, aspect, seconds, quality, audio })); }, [model, prompt, aspect, seconds, quality, audio]);
  useEffect(() => {
    if (!status?.online) return;
    // live sizes / qualities / download state from the worker; keep this page's own short descriptions
    api<{ engines: Record<string, Spec> }>("voices").then((c) => setSpecs((cur) => ({ wan: { ...cur.wan, ...c.engines.wan, about: cur.wan.about }, ltx: { ...cur.ltx, ...c.engines.ltx, about: cur.ltx.about } }))).catch(() => {});
  }, [status?.online]);

  const spec = specs[model];
  useEffect(() => {
    if (!spec.qualities[quality]) setQuality("fast");
    if (seconds > spec.max_seconds) setSeconds(spec.max_seconds);
  }, [model, spec, quality, seconds]);

  function refreshHistory() {
    api<{ jobs: LibVideo[] }>("library").then((r) => setHistory(r.jobs.filter((j) => j.kind === "video"))).catch(() => {});
  }

  const q = spec.qualities[quality] ?? spec.qualities.fast;
  const [w, h] = spec.sizes[aspect];
  const step = model === "ltx" ? 8 : 4;
  const frames = Math.max(1, Math.round((seconds * spec.fps) / step)) * step + 1;
  const units = q.steps * frames * (w * h) / 1e6 * (q.guidance > 1 ? 2 : 1);
  const state = status?.engines?.[model];
  const downloaded = spec.downloaded ?? !!status?.disk?.weights_gb?.[model];
  const fetchS = downloaded ? 0 : ((spec.disk_gb + (quality === "full" ? 20 : 0)) * 1000) / MB_PER_S;
  const estS = (status?.rates?.[model] ?? PRIOR[model]) * units + 25 + (state === "ready" ? 0 : LOAD_S[model] + fetchS);
  const voiceLoaded = Object.entries(status?.engines ?? {}).filter(([n, s]) => s === "ready" && !["wan", "ltx"].includes(n)).map(([n]) => n);
  const running = !!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library)) || upFrac !== null;
  const recent = useMemo(() => history.filter((v) => v.gen && v.poster_url), [history]);
  const libFrames = useMemo(() => history.filter((v) => v.poster_url), [history]);

  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (j.library) { setLib(await api<LibVideo>(`library/${id}`)); refreshHistory(); }
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !j.library)) timer.current = setTimeout(() => poll(id), 2000);
    } catch (e) { setErr((e as Error).message); timer.current = setTimeout(() => poll(id), 5000); }
  }

  async function submit() {
    setErr(""); setJob(null); setLib(null);
    try {
      const body: Record<string, unknown> = { kind: "video", model, prompt, negative: negative || undefined, aspect, seconds, quality, seed, audio: model === "ltx" ? audio : undefined };
      if (frameMode === "upload" && file) {
        setUpFrac(0);
        body.image_key = await uploadFile(file.file, file.file.name, setUpFrac);
        setUpFrac(null);
      } else if (frameMode === "library" && fromLib) body.image_from = fromLib;
      const j = await api<Job>("jobs", { body });
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 1200);
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (e) { setUpFrac(null); setErr((e as Error).message); }
  }

  function reuse(v: LibVideo) {
    if (!v.gen) return;
    setModel(v.gen.model); setPrompt(v.gen.prompt); setSeed(v.gen.seed); setNegative(v.gen.negative ?? "");
    const a = Object.entries(specs[v.gen.model]?.sizes ?? {}).find(([, [ww, hh]]) => ww === v.video?.width && hh === v.video?.height)?.[0];
    if (a) setAspect(a);
    setSeconds(Math.round(v.gen.seconds)); setLib(v); setJob(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const addChip = (c: string) => setPrompt((p) => (p.trim() ? `${p.trim().replace(/[.,]$/, "")}, ${c}` : c));
  const frameReady = frameMode === "none" || (frameMode === "upload" && !!file) || (frameMode === "library" && !!fromLib);
  const shown = lib ?? null;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Direct</div>
          <h1>Describe it, <em>watch it.</em></h1>
          <p className="sub">Text or a start frame in, a 24 fps clip out. Two models, one GPU: starting a render unloads the voice engines and brings them back when you need them.</p>
        </div>
        <GuideButton engine={model} label="Prompting guide" />
      </div>
      {!status?.online && status && <div className="banner"><WarningCircle size={20} weight="duotone" color="var(--signal2)" /><div><b>The GPU worker is offline.</b> <span className="dim">Run the Colab notebook; this page reconnects by itself.</span></div></div>}

      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>Shot</h2><span className="dim tiny">subject · action · place · camera · light</span></div>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false} style={{ minHeight: 150 }}
              placeholder="Describe the shot as if you were telling a camera operator…" />
            <div className="row between" style={{ marginTop: 8 }}>
              <span className="dim small mono">{prompt.trim().split(/\s+/).filter(Boolean).length} words{model === "wan" ? " · 40-100 is the sweet spot" : ""}</span>
              <button className="quiet xs" onClick={() => setShowNeg(!showNeg)}><Prohibit size={13} />Avoid<CaretDown size={11} style={{ transform: showNeg ? "rotate(180deg)" : "none", transition: "transform .2s" }} /></button>
            </div>
            {showNeg && <input style={{ marginTop: 8 }} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="Things to keep out: blurry, text, watermark, extra fingers…" />}
            {Object.entries(CHIPS).map(([group, chips]) => (
              <div className="chips" key={group} style={{ marginTop: 12 }}>
                <span className="label" style={{ alignSelf: "center", marginRight: 4, minWidth: 52 }}>{group}</span>
                {chips.map((c) => <button key={c} className="chip" onClick={() => addChip(c)}>{c}</button>)}
              </div>
            ))}
            {model === "ltx" && <p className="dim tiny" style={{ margin: "12px 0 0" }}>LTX also writes the soundtrack from this prompt. Add a line like <span className="mono">Audio: soft server hum, quick keyboard clicks.</span></p>}
          </div>

          <div className="card">
            <div className="card-head"><h2>Start frame</h2><span className="dim tiny">optional · the image becomes frame one</span></div>
            <div className="seg" style={{ marginBottom: 14 }}>
              <button className={frameMode === "none" ? "on" : ""} onClick={() => setFrameMode("none")}>From text</button>
              <button className={frameMode === "upload" ? "on" : ""} onClick={() => setFrameMode("upload")}>Upload image</button>
              <button className={frameMode === "library" ? "on" : ""} onClick={() => setFrameMode("library")} disabled={!libFrames.length}>From library</button>
            </div>
            {frameMode === "none" && <p className="dim small" style={{ margin: 0 }}>The model invents the whole shot from your words. Add a start frame when the look has to match a screenshot, a product shot or a previous clip.</p>}
            {frameMode === "upload" && (
              file ? (
                <div className="frame-preview">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={file.url} alt="Start frame" style={{ aspectRatio: `${w} / ${h}` }} />
                  <div className="stack" style={{ gap: 6 }}>
                    <b className="small">{file.file.name}</b>
                    <span className="dim tiny">Centre-cropped to {aspect} ({w}×{h}). Describe the motion, not the look.</span>
                    <button className="quiet xs" onClick={() => setFile(null)} style={{ alignSelf: "flex-start" }}><X size={13} />Remove</button>
                  </div>
                </div>
              ) : (
                <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) setFile({ file: f, url: URL.createObjectURL(f) }); }}>
                  <ImageSquare size={30} weight="duotone" color="var(--glacier)" />
                  <b>Drop an image</b><span className="dim small">JPG, PNG or WebP · or click to choose</span>
                  <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile({ file: f, url: URL.createObjectURL(f) }); }} />
                </label>
              )
            )}
            {frameMode === "library" && (
              <div className="frame-grid">
                {libFrames.slice(0, 12).map((v) => (
                  <button key={v.id} className={`pick frame-pick ${fromLib === v.id ? "on" : ""}`} onClick={() => setFromLib(v.id)} title={v.label}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={v.poster_url!} alt="" />
                    <span className="tiny">{v.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>Model</h2></div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {(["wan", "ltx"] as const).map((n) => (
                <button key={n} className={`pick engine-tile ${model === n ? "on" : ""}`} onClick={() => setModel(n)}>
                  <span className="art"><EngineArt engine={n} live={model === n} /></span>
                  <span className="row between" style={{ marginTop: 10 }}>
                    <span style={{ font: "400 21px var(--display)" }}>{NAMES[n]}</span>
                    <span className={`dot ${status?.engines?.[n] === "ready" ? "ok" : ["loading", "installing"].includes(status?.engines?.[n] ?? "") ? "warn" : "off"}`} title={status?.engines?.[n] ?? ""} />
                  </span>
                  <span className="t2" style={{ display: "block" }}>{n === "wan" ? "720p · silent · ≤5 s" : "with sound · ≤10 s"}</span>
                </button>
              ))}
            </div>
            <p className="dim small" style={{ margin: "14px 0 0" }}>{spec.about}</p>
            {!downloaded && <p className="tiny" style={{ margin: "8px 0 0", color: "var(--sand)" }}><DownloadSimple size={12} weight="bold" /> First use downloads ~{spec.disk_gb + (quality === "full" ? 20 : 0)} GB of weights onto the Colab disk (once per runtime).</p>}
          </div>

          <div className="card">
            <div className="card-head"><h2>Frame</h2><span className="dim tiny">{spec.fps} fps</span></div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              {Object.entries(spec.sizes).map(([a, [ww, hh]]) => <Aspect key={a} a={a} w={ww} h={hh} on={aspect === a} onPick={() => setAspect(a)} />)}
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 4 }}><label className="f" style={{ margin: 0 }}>Length</label><span className="mono small">{((frames - 1) / spec.fps).toFixed(1)} s · {frames} frames</span></div>
              <input type="range" min={1} max={spec.max_seconds} step={0.5} value={seconds} style={rangeFill(seconds, 1, spec.max_seconds)} onChange={(e) => setSeconds(+e.target.value)} />
            </div>
            {Object.keys(spec.qualities).length > 1 && (
              <div className="field">
                <label className="f">Quality</label>
                <div className="seg">
                  {Object.entries(spec.qualities).map(([k, v]) => (
                    <button key={k} className={quality === k ? "on" : ""} onClick={() => setQuality(k)} title={v.about}>
                      {k === "fast" ? <Lightning size={13} weight="fill" /> : <Sparkle size={13} weight="fill" />}{k === "fast" ? "Fast" : "Full"}
                    </button>
                  ))}
                </div>
                <div className="dim tiny" style={{ marginTop: 5 }}>{q.about}</div>
              </div>
            )}
            <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
              <div className="field" style={{ flex: 1, margin: 0 }}>
                <label className="f">Seed</label>
                <input type="number" value={seed} onChange={(e) => setSeed(+e.target.value)} />
              </div>
              <button className="ghost" onClick={() => setSeed(Math.floor(Math.random() * 1e6))} title="New random seed"><DiceFive size={16} />Roll</button>
              {model === "ltx" && <button className={`ghost ${audio ? "" : "dim"}`} onClick={() => setAudio(!audio)} title="Generate the soundtrack">{audio ? <SpeakerHigh size={16} /> : <SpeakerSlash size={16} />}{audio ? "Sound on" : "Sound off"}</button>}
            </div>
            <div className="dim tiny" style={{ marginTop: 6 }}>Same seed + same prompt = the same clip. Roll for a different take.</div>
          </div>
          {voiceLoaded.length > 0 && (
            <div className="card flat mode-note">
              <ArrowsClockwise size={18} weight="duotone" color="var(--glacier)" />
              <div className="small">Rendering frees the GPU first: <b>{voiceLoaded.join(", ")}</b> will unload. They come back on their own the next time you generate a voice.</div>
            </div>
          )}
        </div>
      </div>

      <div className="sticky">
        <span className="thumb" style={{ color: "var(--signal)" }}><FilmSlate size={20} weight="duotone" /></span>
        <div className="sum">
          <div><div className="label">Model</div><b>{NAMES[model]}{quality === "full" ? " · full" : ""}</b></div>
          <div><div className="label">Clip</div><b>{aspect} · {((frames - 1) / spec.fps).toFixed(1)} s{frameMode !== "none" ? " · from image" : ""}</b></div>
          <div title={state !== "ready" ? "includes loading the model" : undefined}><div className="label">Ready in</div><b>≈{fmtS(estS)}</b></div>
        </div>
        <button className="sig lg" disabled={!status?.online || running || prompt.trim().length < 3 || !frameReady} onClick={submit}><FilmSlate size={17} weight="bold" />Render</button>
      </div>
      {err && <p className="err">{err}</p>}

      {(job || upFrac !== null) && <div style={{ marginTop: 18 }}><JobProgress job={job} kind="video" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} onCancel={() => job && api(`jobs/${job.id}/cancel`, { body: {} })} /></div>}

      {shown?.video_url && (
        <div className="card reveal video-result">
          <div className="video-stage" style={{ aspectRatio: `${shown.video?.width} / ${shown.video?.height}` }}>
            <video key={shown.video_url} src={shown.video_url} poster={shown.poster_url ?? undefined} controls autoPlay loop muted playsInline />
          </div>
          <div className="stack" style={{ gap: 12, minWidth: 0 }}>
            <div className="eyebrow" style={{ margin: 0 }}>{NAMES[shown.gen?.model ?? shown.engine] ?? shown.engine} · {ago(shown.created)}</div>
            <p className="quote-title" style={{ margin: 0 }}>“{shown.gen?.prompt ?? shown.label}”</p>
            <dl className="facts">
              <dt>Size</dt><dd>{shown.video?.width}×{shown.video?.height}</dd>
              <dt>Length</dt><dd>{shown.video?.duration?.toFixed(1)} s · {shown.gen?.fps} fps</dd>
              <dt>Seed</dt><dd>{shown.gen?.seed} · {shown.gen?.steps} steps</dd>
              <dt>Sound</dt><dd>{shown.video?.has_audio ? "yes (unmute to hear)" : "none"}</dd>
            </dl>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <a className="btn sm" href={`/api/file/${shown.id}/video.mp4?download&name=${encodeURIComponent((shown.label || shown.id).slice(0, 40))}.mp4`}><DownloadSimple size={14} weight="bold" />MP4</a>
              <button className="ghost sm" onClick={() => { reuse(shown); setSeed(Math.floor(Math.random() * 1e6)); }}><DiceFive size={14} />Another take</button>
              <button className="ghost sm" onClick={() => { setFrameMode("library"); setFromLib(shown.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}><UploadSimple size={14} />Continue from it</button>
              <Link className="btn ghost sm" href={`/library#${shown.id}`}><ArrowSquareOut size={14} />Library</Link>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head"><h2>Recent renders</h2><span className="dim tiny">click to load the shot</span></div>
        {recent.length ? (
          <div className="reel">
            {recent.slice(0, 12).map((v) => (
              <button key={v.id} className={`reel-item ${shown?.id === v.id ? "on" : ""}`} onClick={() => reuse(v)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.poster_url!} alt="" style={{ aspectRatio: `${v.video?.width} / ${v.video?.height}` }} />
                <span className="tiny row" style={{ gap: 5 }}>{NAMES[v.gen!.model]} · {v.video?.duration?.toFixed(0)}s{v.video?.has_audio && <SpeakerHigh size={11} weight="fill" />}</span>
                <span className="small clamp2">{v.gen!.prompt}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty"><ClapperArt /><b>Nothing rendered yet</b><span className="dim small">Your first clip will show up here and in the Library.</span></div>
        )}
      </div>
    </>
  );
}
