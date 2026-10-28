"use client";
import {
  ArrowsClockwise, CheckCircle, DiceFive, DownloadSimple, FilmSlate, ImageSquare, Lightning, Plus, Prohibit, Sparkle,
  StackSimple, UserFocus, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, fmtS, uploadFile, type Gen, type GenImage, type Job } from "./api";
import FetchBar from "./FetchBar";
import { PendingCard } from "./GenCard";
import { GuideButton } from "./GuideDrawer";
import { useStatus } from "./Shell";
import { Select } from "./pop";
import { useReleaseBlobs } from "./blobs";
import { Empty, SideRow, ToolPage } from "./ui";

type Spec = { about: string; sizes: Record<string, [number, number]>; qualities: Record<string, { steps: number; about: string }>; disk_gb: number;
  max_count: number; edit?: boolean; max_refs?: number; transparent?: boolean; commercial?: boolean; license?: string; downloaded?: boolean };
type LibImages = { id: string; kind?: string; created: number; engine: string; label?: string; gen?: Gen; images?: GenImage[] };
type Ref = { id: string; url: string; file?: File; lib?: string };
type Pending = { job: Job | null; gen: { model: string; prompt: string; count: number; w: number; h: number; transparent: boolean }; key: string };

// Mirrors worker/config.py so the page works before the worker reports in.
const SPECS: Record<string, Spec> = {
  zimage: { about: "Photoreal and fast: 8 steps, about 2 s an image. Apache-2.0, so commercial use is fine.", disk_gb: 33, max_count: 4, commercial: true, license: "Apache-2.0",
    sizes: { "1:1": [1024, 1024], "4:3": [1152, 864], "3:4": [864, 1152], "3:2": [1248, 832], "2:3": [832, 1248], "16:9": [1344, 768], "9:16": [768, 1344] },
    qualities: { turbo: { steps: 8, about: "8 steps" } } },
  qwenimage: { about: "Native 2K, crisp text inside images, edits with up to 10 reference images, true transparent PNGs. Research license: not for commercial use.", disk_gb: 47,
    max_count: 4, edit: true, max_refs: 10, transparent: true, commercial: false, license: "Qwen Research (non-commercial)",
    sizes: { "1:1": [2048, 2048], "4:3": [2400, 1792], "3:4": [1792, 2400], "3:2": [2528, 1696], "2:3": [1696, 2528], "16:9": [2752, 1536], "9:16": [1536, 2752] },
    qualities: { turbo: { steps: 8, about: "Turbo · 8 steps" }, quality: { steps: 40, about: "Base model · 40 steps, finest detail" } } },
};
const NAMES: Record<string, string> = { zimage: "Z-Image Turbo", qwenimage: "Qwen-Image 2.1" };
const MODELS = ["zimage", "qwenimage"] as const;
const PRIOR: Record<string, number> = { zimage: 0.08, qwenimage: 0.1 };
const LOAD_S: Record<string, number> = { zimage: 40, qwenimage: 70 };
const MB_PER_S = 150;
const STARTER = "Editorial portrait of a sprinter crouched at the starting blocks at dawn, mist over the track, rim light on the shoulders, shot on 85mm, shallow depth of field, rich film colour.";

function AspectChip({ a, w, h, on, onPick }: { a: string; w: number; h: number; on: boolean; onPick: () => void }) {
  const s = 22 / Math.max(w, h);
  return <button className={`aspect-chip ${on ? "on" : ""}`} onClick={onPick}><i style={{ width: w * s, height: h * s }} />{a}</button>;
}

export default function Images() {
  const { status } = useStatus();
  const [specs, setSpecs] = useState(SPECS);
  const [model, setModel] = useState("zimage");
  const [prompt, setPrompt] = useState(STARTER);
  const [negative, setNegative] = useState("");
  const [showNeg, setShowNeg] = useState(false);
  const [aspect, setAspect] = useState("3:4");
  const [count, setCount] = useState(2);
  const [quality, setQuality] = useState("turbo");
  const [transparent, setTransparent] = useState(false);
  const [seed, setSeed] = useState(7);
  const [refs, setRefs] = useState<Ref[]>([]);
  useReleaseBlobs(refs.map((r) => r.url));
  const [pending, setPending] = useState<Pending[]>([]);
  const [history, setHistory] = useState<LibImages[]>([]);
  const [open, setOpen] = useState<{ item: LibImages; i: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [open]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const loaded = useRef(false);

  useEffect(() => {
    const s = JSON.parse(localStorage.getItem("vb-image") || "{}");
    if (s.model) setModel(s.model); if (s.prompt) setPrompt(s.prompt); if (s.aspect) setAspect(s.aspect);
    if (s.count) setCount(s.count); if (s.quality) setQuality(s.quality);
    // a brief from the Writing room (Thumbnails → Make it in Images) arrives as ?prompt=…&aspect=16:9
    const q = new URLSearchParams(location.search);
    if (q.get("prompt")) { setPrompt(q.get("prompt")!.slice(0, 2000)); window.history.replaceState(null, "", location.pathname); }
    if (q.get("aspect") && SPECS.zimage.sizes[q.get("aspect")!]) setAspect(q.get("aspect")!);
    loaded.current = true;
    refresh();
    const t = timers.current;
    return () => Object.values(t).forEach(clearTimeout);
  }, []);
  useEffect(() => { if (loaded.current) localStorage.setItem("vb-image", JSON.stringify({ model, prompt, aspect, count, quality })); }, [model, prompt, aspect, count, quality]);
  useEffect(() => {
    if (!status?.online) return;
    api<{ engines: Record<string, Spec> }>("voices").then((c) => setSpecs((cur) =>
      Object.fromEntries(MODELS.map((m) => [m, { ...cur[m], ...(c.engines[m] ?? {}), about: cur[m].about }])))).catch(() => {});
  }, [status?.online]);

  const spec = specs[model];
  useEffect(() => {
    if (!spec.qualities[quality]) setQuality("turbo");
    if (!spec.sizes[aspect]) setAspect("1:1");
    if (count > spec.max_count) setCount(spec.max_count);
    if (!spec.transparent) setTransparent(false);
  }, [model, spec, quality, aspect, count]);

  function refresh() {
    api<{ jobs: LibImages[] }>("library").then((r) => setHistory(r.jobs.filter((j) => j.kind === "image" && j.images?.length))).catch(() => {});
  }

  const q = spec.qualities[quality] ?? spec.qualities.turbo;
  const [w, h] = spec.sizes[aspect] ?? spec.sizes["1:1"];
  const state = status?.engines?.[model];
  const downloaded = spec.downloaded ?? !!status?.disk?.weights_gb?.[model];
  const fetchS = downloaded ? 0 : spec.disk_gb * 1000 / MB_PER_S;
  const estS = (status?.rates?.[model] ?? PRIOR[model]) * q.steps * count * (w * h) / 1e6 + 3 + (state === "ready" ? 0 : LOAD_S[model] + fetchS);
  const warming = status?.fetch?.[model];
  const maxRefs = spec.edit ? spec.max_refs ?? 0 : 0;

  async function poll(key: string, id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setPending((ps) => ps.map((p) => (p.key === key ? { ...p, job: j } : p)));
      if (j.library) {
        const item = await api<LibImages>(`library/${id}`);
        setHistory((hs) => [item, ...hs.filter((x) => x.id !== id)]);
        setPending((ps) => ps.filter((p) => p.key !== key));
        return;
      }
      if (["queued", "running"].includes(j.status) || j.status === "done") timers.current[key] = setTimeout(() => poll(key, id), 1500);
    } catch (e) { setErr((e as Error).message); timers.current[key] = setTimeout(() => poll(key, id), 4000); }
  }

  async function generate() {
    setErr(""); setBusy(true);
    const key = Math.random().toString(36).slice(2);
    const p: Pending = { job: null, key, gen: { model, prompt, count, w, h, transparent: transparent && !!spec.transparent } };
    setPending((ps) => [p, ...ps]);
    try {
      const use = refs.slice(0, maxRefs);
      const image_keys = await Promise.all(use.filter((r) => r.file).map((r) => uploadFile(r.file!, r.file!.name)));
      const image_from = use.filter((r) => r.lib).map((r) => r.lib!);
      const j = await api<Job>("jobs", { body: {
        kind: "image", model, prompt, negative: negative || undefined, aspect, quality, count, seed,
        transparent: p.gen.transparent || undefined, image_keys: image_keys.length ? image_keys : undefined, image_from: image_from.length ? image_from : undefined,
      } });
      setPending((ps) => ps.map((x) => (x.key === key ? { ...x, job: j } : x)));
      timers.current[key] = setTimeout(() => poll(key, j.id), 900);
      setSeed((s) => s + count); // next press gives new takes; same seed + prompt reproduces an image
    } catch (e) {
      setPending((ps) => ps.filter((x) => x.key !== key));
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  function addFiles(files: FileList | File[]) {
    const add = Array.from(files).filter((f) => f.type.startsWith("image/")).map((f) => ({ id: Math.random().toString(36).slice(2), url: URL.createObjectURL(f), file: f }));
    setRefs((r) => [...r, ...add].slice(0, maxRefs || 10));
  }
  function useAsRef(item: LibImages, i: number) {
    if (!SPECS.qwenimage) return;
    setModel("qwenimage");
    const im = item.images![i];
    setRefs((r) => [...r.filter((x) => x.lib !== `${item.id}:${i}`), { id: `${item.id}:${i}`, url: im.thumb_url ?? im.url!, lib: `${item.id}:${i}` }].slice(0, 10));
    setOpen(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function reuse(item: LibImages) {
    if (!item.gen) return;
    setModel(item.gen.model); setPrompt(item.gen.prompt); setSeed(item.gen.seed);
    if (item.gen.aspect) setAspect(item.gen.aspect);
    if (item.gen.quality) setQuality(item.gen.quality);
    setOpen(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const feed = useMemo(() => history.slice(0, 40), [history]);
  const cols = (n: number) => (n === 1 ? 1 : 2);
  const dl = (item: LibImages, i: number) => `/api/file/${item.id}/${item.images![i].file}?download&name=${encodeURIComponent(`${(item.label || item.id).slice(0, 40)}-${i + 1}`)}.png`;

  const offline = !!status && !status.online;
  return (
    <>
      <ToolPage title="Images" sub="Stills, thumbnails and video start frames from a prompt."
        actions={<GuideButton engine={model} label="Prompting guide" />}
        side={
          <>
            <SideRow label="Model" htmlFor="img-model" info={spec.about}>
              <Select id="img-model" value={model} onChange={setModel} options={MODELS.map((m) => ({ value: m, label: NAMES[m], hint: `${m === "zimage" ? "~2 s · 1K · photoreal" : "2K · text · edits · transparent"} · ${specs[m].commercial ? "commercial OK" : "non-commercial"}` }))} />
              {warming && <div style={{ marginTop: 10 }}><FetchBar f={warming} name={model} compact /></div>}
            </SideRow>
            <SideRow label="Aspect" aside={<span className="mono">{w}×{h}</span>}>
              <div className="aspect-row">{Object.entries(spec.sizes).map(([a, [ww, hh]]) => <AspectChip key={a} a={a} w={ww} h={hh} on={aspect === a} onPick={() => setAspect(a)} />)}</div>
            </SideRow>
            <div className="set-row">
              <div className="set-line"><span id="img-count">Images</span>
                <div className="seg" role="radiogroup" aria-labelledby="img-count">{[1, 2, 3, 4].slice(0, spec.max_count).map((n) => <button key={n} role="radio" aria-checked={count === n} className={count === n ? "on" : ""} onClick={() => setCount(n)}>{n}</button>)}</div></div>
              {Object.keys(spec.qualities).length > 1 && (
                <div className="set-line"><span id="img-q">Quality</span>
                  <div className="seg" role="radiogroup" aria-labelledby="img-q">
                    {Object.entries(spec.qualities).map(([k, v]) => <button key={k} role="radio" aria-checked={quality === k} className={quality === k ? "on" : ""} onClick={() => setQuality(k)} title={v.about}>{k === "turbo" ? "Turbo" : "Max"}</button>)}
                  </div></div>
              )}
              {spec.transparent && (
                <div className="set-line"><span>Transparent background</span>
                  <button role="switch" aria-checked={transparent} className={`switch ${transparent ? "on" : ""}`} onClick={() => setTransparent(!transparent)} aria-label="Transparent background" /></div>
              )}
            </div>
            <div className="set-row">
              <div className="set-line"><label htmlFor="img-seed">Seed</label>
                <span className="row" style={{ gap: 6 }}><input id="img-seed" type="number" value={seed} onChange={(e) => setSeed(+e.target.value)} style={{ width: 110, height: 32 }} />
                  <button className="icon-btn" onClick={() => setSeed(Math.floor(Math.random() * 1e6))} aria-label="New random seed"><DiceFive size={16} /></button></span></div>
              <div className="tiny dim" style={{ marginTop: 6 }}>The same seed and prompt reproduce an image.</div>
            </div>
            <div className="tool-go">
              {offline ? <Link href="/settings?tab=gpu" className="btn block">Start the GPU</Link>
                : <button className="block" disabled={busy || !status} onClick={() => (prompt.trim().length < 3 ? setErr("Write a prompt first.") : generate())}>
                  <Sparkle size={16} weight="fill" />Generate{count > 1 ? ` ${count}` : ""}<span className="est">≈{fmtS(estS)}</span></button>}
              {!downloaded && <span className="tiny dim"><DownloadSimple size={12} weight="bold" /> First use downloads ~{spec.disk_gb} GB onto the GPU machine, once per runtime.</span>}
            </div>
          </>
        }>
        <div className="tool-canvas">
          <div className="prompt-box">
            <textarea aria-label="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate(); }}
              placeholder={refs.length ? "Say what to change or combine: “put the person from image 1 in the jacket from image 2”…" : "Describe the image: subject, setting, light, lens, style…"} />
            {showNeg && <input aria-label="Avoid" value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="Avoid: blurry, extra fingers, watermark…" className="pb-neg" />}
            <div className="prompt-foot">
              <span className="dim tiny mono">{prompt.trim().split(/\s+/).filter(Boolean).length} words · ⌘↵ to generate</span>
              <span className="row" style={{ gap: 6 }}>
                {maxRefs > 0 && <label className="btn quiet xs"><Plus size={13} />Reference{refs.length ? ` ${refs.length}/${maxRefs}` : ""}<input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} /></label>}
                <button className="quiet xs" onClick={() => setShowNeg(!showNeg)} aria-pressed={showNeg}><Prohibit size={13} />Avoid</button>
              </span>
            </div>
          </div>
          {refs.length > 0 && (
            <div className="refs" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
              {refs.map((r, i) => (
                <div className="ref" key={r.id} title={`image ${i + 1}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.url} alt={`Reference ${i + 1}`} />
                  <button onClick={() => setRefs((x) => x.filter((y) => y.id !== r.id))} aria-label={`Remove reference ${i + 1}`}><X size={11} weight="bold" /></button>
                </div>
              ))}
            </div>
          )}
          {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
        <div className="feed">
          {pending.map((p) => (
            <div className="feed-group" key={p.key}>
              <div className="feed-head">
                <div style={{ minWidth: 0 }}>
                  <div className="p">{p.gen.prompt}</div>
                  <div className="feed-meta"><span className="badge sig">{NAMES[p.gen.model]}</span><span className="badge">{p.gen.w}×{p.gen.h}</span>{p.gen.transparent && <span className="badge">transparent</span>}</div>
                </div>
                {p.job && ["queued", "running"].includes(p.job.status) && <button className="ghost xs" onClick={() => api(`jobs/${p.job!.id}/cancel`, { body: {} })}><X size={12} />Cancel</button>}
                {p.job && ["error", "cancelled"].includes(p.job.status) && <button className="ghost xs" onClick={() => setPending((ps) => ps.filter((x) => x.key !== p.key))}><X size={12} />Dismiss</button>}
              </div>
              {p.job?.progress.fetch && <FetchBar f={p.job.progress.fetch} name={p.gen.model} compact />}
              <div className={`feed-grid ${p.gen.count === 1 ? "one" : ""}`} style={{ ["--cols" as string]: cols(p.gen.count), marginTop: p.job?.progress.fetch ? 10 : 0 }}>
                {Array.from({ length: p.gen.count }, (_, i) => <PendingCard key={i} job={p.job} w={p.gen.w} h={p.gen.h} label={p.gen.count > 1 ? `${i + 1}/${p.gen.count}` : undefined} />)}
              </div>
            </div>
          ))}

          {feed.map((item) => (
            <div className="feed-group" key={item.id}>
              <div className="feed-head">
                <div style={{ minWidth: 0 }}>
                  <div className="p">{item.gen?.prompt ?? item.label}</div>
                  <div className="feed-meta">
                    <span className="badge">{NAMES[item.gen?.model ?? item.engine] ?? item.engine}</span>
                    <span className="badge">{item.images![0].width}×{item.images![0].height}</span>
                    {item.gen?.refs ? <span className="badge">{item.gen.refs} ref{item.gen.refs > 1 ? "s" : ""}</span> : null}
                    <span className="dim tiny" style={{ alignSelf: "center" }}>{ago(item.created)}</span>
                  </div>
                </div>
                <button className="ghost xs" onClick={() => reuse(item)} title="Load this prompt and seed"><ArrowsClockwise size={12} />Reuse</button>
              </div>
              <div className={`feed-grid ${item.images!.length === 1 ? "one" : ""}`} style={{ ["--cols" as string]: cols(item.images!.length) }}>
                {item.images!.map((im, i) => (
                  <div key={im.file} className={`gen-card done ${im.transparent ? "checker" : ""}`} style={{ aspectRatio: `${im.width} / ${im.height}` }} onClick={() => setOpen({ item, i })}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={im.thumb_url ?? im.url} alt="" loading="lazy" />
                    <div className="tools" onClick={(e) => e.stopPropagation()}>
                      <a href={dl(item, i)} title="Download PNG"><DownloadSimple size={14} weight="bold" /></a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!pending.length && !feed.length && (
            <Empty icon={<ImageSquare size={20} />} title="Your images appear here">Write a prompt and press Generate.</Empty>
          )}
        </div>
        </div>
      </ToolPage>

      {open && (() => {
        const im = open.item.images![open.i];
        return (
          <div className="lightbox" onClick={() => setOpen(null)}>
            <div className="stage">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={im.url} alt="" onClick={(e) => e.stopPropagation()} className={im.transparent ? "gen-card checker" : undefined} />
            </div>
            <div className="bar2" onClick={(e) => e.stopPropagation()}>
              <a className="btn sm" href={dl(open.item, open.i)}><DownloadSimple size={14} weight="bold" />PNG · {im.width}×{im.height}</a>
              <button className="ghost sm" onClick={() => useAsRef(open.item, open.i)}><Plus size={14} />Use as reference</button>
              <button className="ghost sm" onClick={() => reuse(open.item)}><ArrowsClockwise size={14} />Reuse prompt</button>
              <button className="ghost sm" onClick={() => setOpen(null)}><X size={14} />Close</button>
            </div>
          </div>
        );
      })()}
    </>
  );
}
