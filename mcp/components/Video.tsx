"use client";
import {
  ArrowSquareOut, ArrowsClockwise, Barbell, CaretDown, DiceFive, DownloadSimple, FilmSlate, Feather, ImageSquare, Lightning, PersonSimpleRun,
  Prohibit, Sparkle, SpeakerHigh, SpeakerSlash, UploadSimple, VideoCamera, WarningCircle, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, fmtS, rangeFill, uploadFile, type Gen, type Job } from "./api";
import { ClapperArt, EngineArt } from "./art";
import { GuideButton } from "./GuideDrawer";
import JobProgress from "./JobProgress";
import FetchBar from "./FetchBar";
import { PendingCard } from "./GenCard";
import { useStatus } from "./Shell";

type Spec = { about: string; sizes: Record<string, [number, number]>; qualities: Record<string, { steps: number; guidance: number; about: string; sizes?: Record<string, [number, number]> }>; max_seconds: number; fps: number; disk_gb: number; downloaded?: boolean; image_only?: boolean; adult?: boolean; min_gpu_gb?: number };
type LibVideo = { id: string; kind?: string; label?: string; created: number; engine: string; gen?: Gen; video?: { width: number; height: number; duration: number; has_audio?: boolean; size: number }; video_url?: string; poster_url?: string | null;
  images?: { file: string; width: number; height: number; url?: string; thumb_url?: string }[] };
/** A pickable still: a clip's poster ("<id>") or one generated image ("<id>:<index>"). */
type Frame = { id: string; url: string; label: string };

// Mirrors worker/config.py so the page is usable (and estimates work) before the worker reports in.
const SPECS: Record<string, Spec> = {
  wan: { about: "Sharp 720p, strong motion, best prompt following. Silent, up to 5 s.", sizes: { "16:9": [1280, 704], "9:16": [704, 1280], "1:1": [960, 960] },
    qualities: { draft: { steps: 4, guidance: 1, about: "Turbo + tiny decoder · quickest preview, a little softer" }, fast: { steps: 4, guidance: 1, about: "Turbo · 4 steps" }, full: { steps: 30, guidance: 5, about: "Original · 30 steps, ~10× slower" } }, max_seconds: 5, fps: 24, disk_gb: 23 },
  wan14: { about: "Full-size Wan (2 × 14B experts, Lightning 4-step). Steadiest faces, hands and motion. Animates a start frame; A100 only.", sizes: { "16:9": [832, 480], "9:16": [480, 832], "1:1": [640, 640] },
    qualities: { draft: { steps: 4, guidance: 1, about: "Lightning + tiny decoder · quickest preview" }, fast: { steps: 4, guidance: 1, about: "Lightning · 4 steps" } }, max_seconds: 5, fps: 16, disk_gb: 69, image_only: true, adult: true, min_gpu_gb: 38 },
  ltx: { about: "Picture and matching sound in one pass. Up to 10 s. Full renders twice the resolution in two stages.", sizes: { "16:9": [960, 544], "9:16": [544, 960], "1:1": [768, 768] },
    qualities: { draft: { steps: 8, guidance: 1, about: "One pass at about half size · quickest preview", sizes: { "16:9": [640, 352], "9:16": [352, 640], "1:1": [512, 512] } }, fast: { steps: 8, guidance: 1, about: "Distilled · 8 steps" }, full: { steps: 11, guidance: 1, about: "Two-stage · 2× resolution (text-to-video)" } }, max_seconds: 10, fps: 24, disk_gb: 71 },
};
const ANIMATE: Spec = { about: "Wan 2.2 Animate 14B: the character in your image performs the motion of a driving video (an exercise, a dance, a gesture). A100 only.",
  sizes: { "9:16": [480, 832], "16:9": [832, 480], "1:1": [640, 640] }, qualities: { fast: { steps: 20, guidance: 1, about: "20 steps" } }, max_seconds: 10, fps: 16, disk_gb: 85, min_gpu_gb: 38 };
const NAMES: Record<string, string> = { wan: "Wan 2.2", wan14: "Wan 14B", ltx: "LTX-2.5", animate: "Wan Animate" };
const Q_ICON: Record<string, typeof Lightning> = { draft: Feather, fast: Lightning, full: Sparkle };
const Q_NAME: Record<string, string> = { draft: "Draft", fast: "Fast", full: "Full" };
const PRIOR: Record<string, number> = { wan: 0.3, wan14: 1.2, ltx: 0.35, animate: 1.5 };
const LOAD_S: Record<string, number> = { wan: 150, wan14: 240, ltx: 300, animate: 300 };
const MODELS = ["wan", "wan14", "ltx"] as const;
const TAGS: Record<string, string> = { wan: "720p · silent · ≤5 s", wan14: "best Wan · from image", ltx: "with sound · ≤10 s" };
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
  const [tab, setTab] = useState<"realistic" | "animate">("realistic");
  const [specs, setSpecs] = useState(SPECS);
  const [anim, setAnim] = useState(ANIMATE);
  const [charMode, setCharMode] = useState<"upload" | "library">("upload");
  const [charFile, setCharFile] = useState<{ file: File; url: string } | null>(null);
  const [charLib, setCharLib] = useState<string | null>(null);
  const [motionMode, setMotionMode] = useState<"upload" | "library">("upload");
  const [motionFile, setMotionFile] = useState<{ file: File; url: string } | null>(null);
  const [motionLib, setMotionLib] = useState<string | null>(null);
  const [retarget, setRetarget] = useState(true);
  const [animPrompt, setAnimPrompt] = useState("");
  const [model, setModel] = useState("wan");
  const [prompt, setPrompt] = useState(STARTER);
  const [negative, setNegative] = useState("");
  const [showNeg, setShowNeg] = useState(false);
  const [aspect, setAspect] = useState("9:16");
  const [seconds, setSeconds] = useState(5);
  const [quality, setQuality] = useState("fast");
  const [seed, setSeed] = useState(7);
  const [audio, setAudio] = useState(true);
  const [adult, setAdult] = useState(false);
  const [frameMode, setFrameMode] = useState<"none" | "upload" | "library">("none");
  const [file, setFile] = useState<{ file: File; url: string } | null>(null);
  const [fromLib, setFromLib] = useState<string | null>(null);
  const [history, setHistory] = useState<LibVideo[]>([]);
  const libFrames = useMemo<Frame[]>(() => history.flatMap((v) => v.kind === "image"
    ? (v.images ?? []).map((im, i) => ({ id: `${v.id}:${i}`, url: im.thumb_url ?? im.url ?? "", label: v.label ?? "" }))
    : v.poster_url ? [{ id: v.id, url: v.poster_url, label: v.label ?? "" }] : []), [history]);
  const clips = useMemo(() => history.filter((v) => v.kind !== "image" && v.video_url), [history]);
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
    const qs = new URLSearchParams(location.search);
    const from = qs.get("from"); // "Open in Video" from the Library
    if (from) api<LibVideo>(`library/${from}`).then(reuse).catch(() => {});
    const frame = qs.get("frame"), character = qs.get("character"); // from the Image page
    if (frame) { setFrameMode("library"); setFromLib(frame); }
    if (qs.get("tab") === "animate") setTab("animate");
    if (character) { setTab("animate"); setCharMode("library"); setCharLib(character); }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => { if (loaded.current) localStorage.setItem("vb-video", JSON.stringify({ model, prompt, aspect, seconds, quality, audio })); }, [model, prompt, aspect, seconds, quality, audio]);
  useEffect(() => {
    if (!status?.online) return;
    // live sizes / qualities / download state from the worker; keep this page's own short descriptions
    api<{ engines: Record<string, Spec> }>("voices").then((c) => {
      setSpecs((cur) => Object.fromEntries(MODELS.map((m) => [m, { ...cur[m], ...c.engines[m], about: cur[m].about }])));
      if (c.engines.animate) setAnim((cur) => ({ ...cur, ...c.engines.animate, about: cur.about }));
    }).catch(() => {});
  }, [status?.online]);

  const spec = specs[model];
  useEffect(() => {
    if (!spec.qualities[quality]) setQuality("fast");
    if (seconds > spec.max_seconds) setSeconds(spec.max_seconds);
    if (!spec.sizes[aspect]) setAspect("9:16");
    if (spec.image_only && frameMode === "none") setFrameMode(libFrames.length ? "library" : "upload");
  }, [model, spec, quality, seconds, aspect, frameMode]);

  function refreshHistory() {
    api<{ jobs: LibVideo[] }>("library").then((r) => setHistory(r.jobs.filter((j) => j.kind === "video" || j.kind === "image"))).catch(() => {});
  }

  const q = spec.qualities[quality] ?? spec.qualities.fast;
  const sizes = q.sizes ?? spec.sizes;
  const [w, h] = sizes[aspect] ?? sizes["9:16"];
  const step = model === "ltx" ? 8 : 4;
  const frames = Math.max(1, Math.round((seconds * spec.fps) / step)) * step + 1;
  const units = q.steps * frames * (w * h) / 1e6 * (q.guidance > 1 ? 2 : 1);
  const state = status?.engines?.[model];
  const downloaded = spec.downloaded ?? !!status?.disk?.weights_gb?.[model];
  const fetchS = downloaded ? 0 : ((spec.disk_gb + (quality === "full" && model === "wan" ? 20 : 0)) * 1000) / MB_PER_S;
  const estS = (status?.rates?.[model] ?? PRIOR[model]) * units + 25 + (state === "ready" ? 0 : LOAD_S[model] + fetchS);
  const voiceLoaded = Object.entries(status?.engines ?? {}).filter(([n, s]) => s === "ready" && !(MODELS as readonly string[]).includes(n)).map(([n]) => n);
  const running = !!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library)) || upFrac !== null;
  const recent = useMemo(() => history.filter((v) => v.kind === "video" && v.gen && v.gen.model !== "story" && v.poster_url), [history]);
  const [aw, ah] = anim.sizes[aspect] ?? anim.sizes["9:16"];
  const aFrames = Math.max(1, Math.round((Math.min(seconds, anim.max_seconds) * anim.fps) / 4)) * 4 + 1;
  const aState = status?.engines?.animate;
  const aDownloaded = anim.downloaded ?? !!status?.disk?.weights_gb?.animate;
  const aEst = (status?.rates?.animate ?? PRIOR.animate) * 20 * aFrames * (aw * ah) / 1e6 + 40 + (aState === "ready" ? 0 : LOAD_S.animate + (aDownloaded ? 0 : anim.disk_gb * 1000 / MB_PER_S));
  const animSmall = !!status?.gpu?.total_gb && status.gpu.total_gb < (anim.min_gpu_gb ?? 0);
  const animReady = (charMode === "upload" ? !!charFile : !!charLib) && (motionMode === "upload" ? !!motionFile : !!motionLib);
  const pendingWH: [number, number] = job?.gen?.width && job.gen.height ? [job.gen.width, job.gen.height] : tab === "animate" ? [aw, ah] : [w, h];

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
      const body: Record<string, unknown> = { kind: "video", model, prompt, negative: negative || undefined, aspect, seconds, quality, seed, audio: model === "ltx" ? audio : undefined, adult: spec.adult ? adult : undefined };
      if (frameMode === "upload" && file) {
        setUpFrac(0);
        body.image_key = await uploadFile(file.file, file.file.name, setUpFrac);
        setUpFrac(null);
      } else if (frameMode === "library" && fromLib) {
        const [id, i] = fromLib.split(":");
        body.image_from = id;
        if (i !== undefined) body.image_index = +i;
      }
      const j = await api<Job>("jobs", { body });
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 1200);
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (e) { setUpFrac(null); setErr((e as Error).message); }
  }

  async function submitAnimate() {
    setErr(""); setJob(null); setLib(null);
    try {
      const body: Record<string, unknown> = { kind: "animate", model: "animate", prompt: animPrompt || undefined, aspect, seconds: Math.min(seconds, anim.max_seconds), seed, retarget };
      const ups = [charMode === "upload" ? charFile?.file : null, motionMode === "upload" ? motionFile?.file : null].filter(Boolean) as File[];
      const total = ups.reduce((a, f) => a + f.size, 0) || 1;
      let doneBytes = 0;
      if (ups.length) setUpFrac(0);
      const up = async (f: File) => { const k = await uploadFile(f, f.name, (x) => setUpFrac((doneBytes + x * f.size) / total)); doneBytes += f.size; return k; };
      if (charMode === "upload" && charFile) body.image_key = await up(charFile.file); else body.image_from = charLib;
      if (motionMode === "upload" && motionFile) body.video_key = await up(motionFile.file); else body.video_from = motionLib;
      setUpFrac(null);
      const j = await api<Job>("jobs", { body });
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 1200);
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (e) { setUpFrac(null); setErr((e as Error).message); }
  }

  function reuse(v: LibVideo) {
    if (!v.gen || v.gen.model === "story") return; // script videos are remade from the Studio page
    if (v.gen.model !== "animate") setModel(v.gen.model);
    if (v.gen.model === "animate") setAnimPrompt(v.gen.prompt); else setPrompt(v.gen.prompt); setSeed(v.gen.seed); setNegative(v.gen.negative ?? "");
    const a = Object.entries(specs[v.gen.model]?.sizes ?? {}).find(([, [ww, hh]]) => ww === v.video?.width && hh === v.video?.height)?.[0];
    if (a) setAspect(a);
    if (v.gen.model === "animate") setTab("animate"); else setTab("realistic");
    setSeconds(Math.round(v.gen.seconds ?? v.video?.duration ?? 5)); setLib(v); setJob(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const addChip = (c: string) => setPrompt((p) => (p.trim() ? `${p.trim().replace(/[.,]$/, "")}, ${c}` : c));
  const frameReady = (frameMode === "none" && !spec.image_only) || (frameMode === "upload" && !!file) || (frameMode === "library" && !!fromLib);
  const shown = lib ?? null;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Direct</div>
          <h1>Describe it, <em>watch it.</em></h1>
          <p className="sub">{tab === "realistic" ? "Text or a start frame in, a clip out. Draft for a quick look, Fast for the keeper, Full when it has to be perfect."
            : "One image of a character + a video of someone moving = your character doing that move. Built for exercise demos, dances and gestures."}</p>
        </div>
        <GuideButton engine={tab === "animate" ? "animate" : model} label="Prompting guide" />
      </div>
      <div className="tabs-big">
        <button className={tab === "realistic" ? "on" : ""} onClick={() => setTab("realistic")}><VideoCamera size={17} weight="duotone" />Realistic</button>
        <button className={tab === "animate" ? "on" : ""} onClick={() => setTab("animate")}><PersonSimpleRun size={17} weight="duotone" />Animate</button>
      </div>
      {!status?.online && status && <div className="banner"><WarningCircle size={20} weight="duotone" color="var(--signal2)" /><div><b>The GPU worker is offline.</b> <span className="dim">Run the Colab notebook; this page reconnects by itself.</span></div></div>}

      {tab === "realistic" && <>
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
            <div className="card-head"><h2>Start frame</h2><span className="dim tiny">{spec.image_only ? "required for " + NAMES[model] : "optional"} · the image becomes frame one</span></div>
            <div className="seg" style={{ marginBottom: 14 }}>
              <button className={frameMode === "none" ? "on" : ""} onClick={() => setFrameMode("none")} disabled={spec.image_only} title={spec.image_only ? `${NAMES[model]} only animates a start frame` : undefined}>From text</button>
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
                {libFrames.slice(0, 24).map((v) => (
                  <button key={v.id} className={`pick frame-pick ${fromLib === v.id ? "on" : ""}`} onClick={() => setFromLib(v.id)} title={v.label}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={v.url} alt="" />
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
            <div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
              {MODELS.map((n) => {
                const small = !!specs[n].min_gpu_gb && !!status?.gpu?.total_gb && status.gpu.total_gb < specs[n].min_gpu_gb!;
                return (
                <button key={n} className={`pick engine-tile ${model === n ? "on" : ""}`} onClick={() => setModel(n)} disabled={small}
                  title={small ? `Needs a ${specs[n].min_gpu_gb} GB+ GPU (A100); this runtime has ${status?.gpu?.total_gb} GB` : undefined}>
                  <span className="art"><EngineArt engine={n} live={model === n} /></span>
                  <span className="row between" style={{ marginTop: 10 }}>
                    <span style={{ font: "400 21px var(--display)" }}>{NAMES[n]}</span>
                    <span className={`dot ${status?.engines?.[n] === "ready" ? "ok" : ["loading", "installing"].includes(status?.engines?.[n] ?? "") ? "warn" : "off"}`} title={status?.engines?.[n] ?? ""} />
                  </span>
                  <span className="t2" style={{ display: "block" }}>{small ? "needs an A100" : TAGS[n]}</span>
                </button>
                );
              })}
            </div>
            <p className="dim small" style={{ margin: "14px 0 0" }}>{spec.about}</p>
            {!downloaded && <p className="tiny" style={{ margin: "8px 0 0", color: "var(--sand)" }}><DownloadSimple size={12} weight="bold" /> First use downloads ~{spec.disk_gb + (quality === "full" && model === "wan" ? 20 : 0)} GB of weights onto the Colab disk (once per runtime).</p>}
            {status?.fetch?.[model] && <FetchBar f={status.fetch[model]} name={model} compact />}
          </div>

          <div className="card">
            <div className="card-head"><h2>Frame</h2><span className="dim tiny">{spec.fps} fps</span></div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              {Object.entries(sizes).map(([a, [ww, hh]]) => <Aspect key={a} a={a} w={ww} h={hh} on={aspect === a} onPick={() => setAspect(a)} />)}
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
                      {(() => { const I = Q_ICON[k] ?? Sparkle; return <I size={13} weight="fill" />; })()}{Q_NAME[k] ?? k}
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
              {spec.adult && <button className={`ghost ${adult ? "" : "dim"}`} onClick={() => setAdult(!adult)} title="Opt-in community NSFW LoRA (lopi999). Adults only; never real people.">{adult ? <Sparkle size={16} weight="fill" /> : <Prohibit size={16} />}{adult ? "Adult on" : "Adult off"}</button>}
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
          <div><div className="label">Model</div><b>{NAMES[model]}{quality === "full" ? " · full" : ""}{spec.adult && adult ? " · adult" : ""}</b></div>
          <div><div className="label">Clip</div><b>{aspect} · {((frames - 1) / spec.fps).toFixed(1)} s{frameMode !== "none" ? " · from image" : ""}</b></div>
          <div title={state !== "ready" ? "includes loading the model" : undefined}><div className="label">Ready in</div><b>≈{fmtS(estS)}</b></div>
        </div>
        <button className="sig lg" disabled={!status?.online || running || prompt.trim().length < 3 || !frameReady} onClick={submit}><FilmSlate size={17} weight="bold" />Render</button>
      </div>
      </>}

      {tab === "animate" && <>
      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>Character</h2><span className="dim tiny">one clear, full-body image works best</span></div>
            <div className="seg" style={{ marginBottom: 14 }}>
              <button className={charMode === "upload" ? "on" : ""} onClick={() => setCharMode("upload")}>Upload image</button>
              <button className={charMode === "library" ? "on" : ""} onClick={() => setCharMode("library")} disabled={!libFrames.length}>From library</button>
            </div>
            {charMode === "upload" ? (charFile ? (
              <div className="frame-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={charFile.url} alt="Character" style={{ aspectRatio: `${aw} / ${ah}` }} />
                <div className="stack" style={{ gap: 6 }}>
                  <b className="small">{charFile.file.name}</b>
                  <span className="dim tiny">Head to toe, facing the camera, plain pose. Their look, outfit and body come from this image.</span>
                  <button className="quiet xs" onClick={() => setCharFile(null)} style={{ alignSelf: "flex-start" }}><X size={13} />Remove</button>
                </div>
              </div>
            ) : (
              <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) setCharFile({ file: f, url: URL.createObjectURL(f) }); }}>
                <ImageSquare size={30} weight="duotone" color="var(--glacier)" />
                <b>Drop the character image</b><span className="dim small">a person, mascot or 3D figure · JPG, PNG or WebP</span>
                <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setCharFile({ file: f, url: URL.createObjectURL(f) }); }} />
              </label>
            )) : (
              <div className="frame-grid">
                {libFrames.slice(0, 24).map((v) => (
                  <button key={v.id} className={`pick frame-pick ${charLib === v.id ? "on" : ""}`} onClick={() => setCharLib(v.id)} title={v.label}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={v.url} alt="" /><span className="tiny">{v.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><h2>Motion</h2><span className="dim tiny">a video of one person doing the move</span></div>
            <div className="seg" style={{ marginBottom: 14 }}>
              <button className={motionMode === "upload" ? "on" : ""} onClick={() => setMotionMode("upload")}>Upload video</button>
              <button className={motionMode === "library" ? "on" : ""} onClick={() => setMotionMode("library")} disabled={!clips.length}>From library</button>
            </div>
            {motionMode === "upload" ? (motionFile ? (
              <div className="frame-preview">
                <video src={motionFile.url} muted loop autoPlay playsInline style={{ width: 140, borderRadius: 10 }} />
                <div className="stack" style={{ gap: 6 }}>
                  <b className="small">{motionFile.file.name}</b>
                  <span className="dim tiny">The first {Math.min(seconds, anim.max_seconds)} s are used. Whole body in frame, steady camera, one person.</span>
                  <button className="quiet xs" onClick={() => setMotionFile(null)} style={{ alignSelf: "flex-start" }}><X size={13} />Remove</button>
                </div>
              </div>
            ) : (
              <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("video/")) setMotionFile({ file: f, url: URL.createObjectURL(f) }); }}>
                <Barbell size={30} weight="duotone" color="var(--signal2)" />
                <b>Drop the motion video</b><span className="dim small">squats, push-ups, a dance… MP4, MOV or WebM</span>
                <input type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setMotionFile({ file: f, url: URL.createObjectURL(f) }); }} />
              </label>
            )) : (
              <div className="frame-grid">
                {clips.slice(0, 24).map((v) => (
                  <button key={v.id} className={`pick frame-pick ${motionLib === v.id ? "on" : ""}`} onClick={() => setMotionLib(v.id)} title={v.label}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={v.poster_url ?? ""} alt="" /><span className="tiny">{v.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>Wan Animate</h2>
              <span className={`dot ${aState === "ready" ? "ok" : ["loading", "installing"].includes(aState ?? "") ? "warn" : "off"}`} title={aState ?? "not loaded"} /></div>
            <p className="dim small" style={{ margin: 0 }}>{anim.about}</p>
            {animSmall && <p className="tiny" style={{ margin: "8px 0 0", color: "var(--signal2)" }}>Needs a {anim.min_gpu_gb} GB+ GPU; this runtime has {status?.gpu?.total_gb} GB.</p>}
            {!aDownloaded && <p className="tiny" style={{ margin: "8px 0 0", color: "var(--sand)" }}><DownloadSimple size={12} weight="bold" /> First use downloads ~{anim.disk_gb} GB (once per runtime); a progress bar shows it landing.</p>}
            {status?.fetch?.animate && <FetchBar f={status.fetch.animate} name="animate" compact />}
          </div>
          <div className="card">
            <div className="card-head"><h2>Output</h2><span className="dim tiny">{anim.fps} fps</span></div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              {Object.entries(anim.sizes).map(([a, [ww, hh]]) => <Aspect key={a} a={a} w={ww} h={hh} on={aspect === a} onPick={() => setAspect(a)} />)}
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 4 }}><label className="f" style={{ margin: 0 }}>Length</label><span className="mono small">{((aFrames - 1) / anim.fps).toFixed(1)} s</span></div>
              <input type="range" min={1} max={anim.max_seconds} step={0.5} value={Math.min(seconds, anim.max_seconds)} style={rangeFill(Math.min(seconds, anim.max_seconds), 1, anim.max_seconds)} onChange={(e) => setSeconds(+e.target.value)} />
            </div>
            <div className="field">
              <label className="f">Prompt <span className="dim tiny">(optional)</span></label>
              <input value={animPrompt} onChange={(e) => setAnimPrompt(e.target.value)} placeholder="e.g. a fitness coach in a bright studio gym" />
            </div>
            <div className="row" style={{ gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <button className={`ghost ${retarget ? "" : "dim"}`} onClick={() => setRetarget(!retarget)} title="Scale the motion to the character's body (limb lengths, height). Turn off if the character already matches the mover.">
                <PersonSimpleRun size={16} />{retarget ? "Match body: on" : "Match body: off"}
              </button>
              <div className="field" style={{ flex: 1, margin: 0, minWidth: 120 }}><label className="f">Seed</label><input type="number" value={seed} onChange={(e) => setSeed(+e.target.value)} /></div>
              <button className="ghost" onClick={() => setSeed(Math.floor(Math.random() * 1e6))}><DiceFive size={16} />Roll</button>
            </div>
          </div>
        </div>
      </div>

      <div className="sticky">
        <span className="thumb" style={{ color: "var(--signal)" }}><PersonSimpleRun size={20} weight="duotone" /></span>
        <div className="sum">
          <div><div className="label">Model</div><b>Wan Animate 14B</b></div>
          <div><div className="label">Clip</div><b>{aspect} · {((aFrames - 1) / anim.fps).toFixed(1)} s</b></div>
          <div title={aState !== "ready" ? "includes loading the model" : undefined}><div className="label">Ready in</div><b>≈{fmtS(aEst)}</b></div>
        </div>
        <button className="sig lg" disabled={!status?.online || running || !animReady || animSmall} onClick={submitAnimate}><PersonSimpleRun size={17} weight="bold" />Animate</button>
      </div>
      </>}
      {err && <p className="err">{err}</p>}

      {(job || upFrac !== null) && <div style={{ marginTop: 18 }}><JobProgress job={job} kind="video" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} onCancel={() => job && api(`jobs/${job.id}/cancel`, { body: {} })} /></div>}

      {running && !shown && (
        <div className="card reveal video-result">
          <div className="video-stage" style={{ aspectRatio: `${pendingWH[0]} / ${pendingWH[1]}`, background: "transparent" }}>
            <PendingCard job={job} w={pendingWH[0]} h={pendingWH[1]} />
          </div>
          <div className="stack" style={{ gap: 10, minWidth: 0 }}>
            <div className="eyebrow" style={{ margin: 0 }}>{NAMES[job?.gen?.model ?? (tab === "animate" ? "animate" : model)]} · generating</div>
            <p className="quote-title" style={{ margin: 0 }}>“{job?.gen?.prompt || (tab === "animate" ? animPrompt || "your character, this motion" : prompt)}”</p>
            <span className="dim small">Keep this tab open or come back later: it lands in the Library either way.</span>
          </div>
        </div>
      )}

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
