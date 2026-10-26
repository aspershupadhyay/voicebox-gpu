"use client";
// Voiceover: write on a clean canvas, pick the voice and settings in the panel on the right, press Generate.
// Below the script, the latest run as one take: the whole voiceover (the lines are voiced, checked and
// mastered one by one on the worker, then joined), playing by itself while it is still being made.
// Every take lands in Files with word-timed subtitles. From a post (?post=) the script loads and the result is attached
// back to the post; from Voices (?engine=&voice=) the voice is preselected.
import { ArrowSquareOut, CaretDown, CaretUp, ClosedCaptioning, DownloadSimple, Microphone, Pause, Play, Plus, Power, SlidersHorizontal, Sparkle, WarningCircle, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useResumeJob } from "./jobs";
import { ago, api, fileUrl, fmtS, rangeFill, type Job, type MyVoice } from "./api";
import { decode, joinWav } from "./audio";
import { Info } from "./Info";
import { VoiceGlyph } from "./art";
import { GuideButton } from "./GuideDrawer";
import { describeVoice, KOKORO_LANG, KOKORO_VOICES, LANGUAGES, ORPHEUS_VOICES, QWEN_LANG } from "./guides";
import JobProgress from "./JobProgress";
import Player, { peaksFor } from "./Player";
import { Select, useDismiss } from "./pop";
import { SampleButton, useSamples } from "./Sample";
import { useStatus } from "./Shell";
import { aw, logActivity } from "./aw";
import { Notice, PopMenu } from "./ui";
import { AW, type Post } from "@/lib/workspace";

type Param = { type: "number" | "integer" | "string" | "boolean"; default: number | string | boolean; min?: number; max?: number; about?: string };
type Engine = { kind: string; about: string; voices: string[]; presets: Record<string, string>; params: Record<string, Param>; state: string; seconds_per_char?: number };
type Style = { label: string; about: string; params: Record<string, Record<string, number>>; post: { tempo?: number }; post_by_engine?: Record<string, { tempo?: number }>; voices: Record<string, string[]> };
type Platform = { label: string; about: string; lufs: number | null; tp: number | null; captions: string };
type Catalogue = { engines: Record<string, Engine>; references: string[]; styles?: Record<string, Style>; default_style?: string; platforms?: Record<string, Platform>; max_takes?: number };
type ParsedLine = { id: string; text: string; window?: number; start?: number; params?: Record<string, number> };
type Hist = { id: string; kind?: string; engine: string; voice: string; label?: string; created: number; results: { text?: string; duration: number; audio?: string | null }[] };

const TTS = ["qwen", "myvoice", "orpheus", "chatterbox", "kokoro"] as const;
const NAME: Record<string, string> = { myvoice: "Your voice model", orpheus: "Orpheus", qwen: "Qwen3-TTS", chatterbox: "Chatterbox", kokoro: "Kokoro" };
const BLURB: Record<string, string> = { myvoice: "Your trained voice", orpheus: "Most human · English", qwen: "Best cloning · 10 languages", chatterbox: "Emotion · 23 languages", kokoro: "Instant drafts · CPU" };
const CLONERS = ["qwen", "chatterbox"];
const STYLE_ORDER = ["tech", "hype", "narrator", "neutral"];
const STYLE_FALLBACK: Record<string, string> = { tech: "Tech", hype: "Hype", narrator: "Narrator", neutral: "Neutral" };
const TAGS = ["<laugh>", "<chuckle>", "<sigh>", "<gasp>", "<groan>", "<yawn>", "<sniffle>", "<cough>"];
const MARKS = ["[pause]", "[pause 1.2]", "[beat]", "[breath]"];
const PLATFORM_ORDER = ["youtube", "shorts", "reels", "tiktok", "podcast", "raw"];
const PLATFORM_FALLBACK: Record<string, string> = { youtube: "YouTube", shorts: "YouTube Shorts", reels: "Instagram Reels", tiktok: "TikTok", podcast: "Podcast", raw: "Raw (no mastering)" };
const POST_PLATFORM: Record<string, string> = { youtube: "youtube", shorts: "shorts", reels: "reels", instagram: "reels", tiktok: "tiktok", podcast: "podcast" };
const LOAD_S: Record<string, number> = { orpheus: 120, chatterbox: 45, kokoro: 5, whisper: 40, qwen: 60 };
const RATE: Record<string, number> = { orpheus: 0.03, chatterbox: 0.06, kokoro: 0.004, whisper: 0.06, qwen: 0.05 };
const SAMPLE = `This little dot knows exactly where you are.
But... how?
It's listening to clocks in space. About thirty satellites, high above.`;

/** "word = how to say it", one per line. */
function parsePronounce(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of src.split("\n")) {
    const i = l.indexOf("=");
    if (i > 0 && l.slice(0, i).trim() && l.slice(i + 1).trim()) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

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

/** Recent voiceovers, newest first: the History tab. */
function History({ refreshKey }: { refreshKey: string | null }) {
  const [items, setItems] = useState<Hist[] | null>(null);
  useEffect(() => { api<{ jobs: Hist[] }>("library").then((r) => setItems(r.jobs.filter((j) => !j.kind || j.kind === "tts"))).catch(() => setItems([])); }, [refreshKey]);
  if (items === null) return <div className="skel" style={{ height: 200 }} />;
  if (!items.length) return <p className="small dim">Nothing yet. Your takes show up here, newest first.</p>;
  return (
    <div>
      {items.slice(0, 40).map((j) => {
        const text = (j.results[0]?.text ?? "").replace(/<[^>]+>/g, "");
        return (
          <div key={j.id} className="hist-row">
            <Link href={`/files#${j.id}`} style={{ minWidth: 0 }}>
              <b className="ellipsis" style={{ display: "block" }}>{j.label || `“${text.slice(0, 48)}${text.length > 48 ? "…" : ""}”`}</b>
              <span>{NAME[j.engine] ?? j.engine} · {j.voice} · {fmtS(j.results.reduce((a, r) => a + r.duration, 0))} · {ago(j.created)}</span>
            </Link>
            {j.results[0]?.audio ? <SampleButton id={`hist/${j.id}`} url={j.results[0].audio ?? undefined} size={30} label={j.label || "take"} /> : <span />}
          </div>
        );
      })}
      <Link href="/files" className="btn ghost sm block" style={{ marginTop: 12 }}>All files</Link>
    </div>
  );
}

type Gen = { job: string; ids: string[]; engine: string; voice: string; label?: string; subs?: boolean; at: number }; // a finished voiceover
const GENS_KEY = "vb-gens"; // the latest one is shown

/** One finished voiceover as a single take: its lines joined in script order (in the browser, from the line files). */
function Generation({ g }: { g: Gen }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false, made: string | null = null;
    Promise.all(g.ids.map((id) => decode(fileUrl(g.job, `${id}.wav`)))).then((bufs) => {
      if (gone) return;
      made = URL.createObjectURL(joinWav(bufs, 0.35));
      setUrl(made);
    }).catch(() => !gone && setFailed(true));
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [g.job, g.ids]);
  const name = (g.label || `${g.engine}-${g.voice}`).replace(/[^A-Za-z0-9._-]/g, "_");
  return (
    <div className="vo-gen">
      <div className="vo-gen-play">{url ? <Player src={url} compact /> : <span className="small dim">{failed ? "Couldn't load this one. It's in Files." : "Loading…"}</span>}</div>
      <div className="vo-gen-acts">
        {g.subs && <a className="icon-btn" href={`/api/file/${g.job}/subtitles.srt?download&name=${name}.srt`} aria-label="Download subtitles (.srt)" title="Subtitles (.srt)"><ClosedCaptioning size={16} /></a>}
        <Link className="icon-btn" href={`/files#${g.job}`} aria-label="Open in Files" title="Open in Files"><ArrowSquareOut size={16} /></Link>
        {url && <a className="icon-btn" href={url} download={`${name}.wav`} aria-label="Download" title="Download WAV"><DownloadSimple size={16} /></a>}
      </div>
    </div>
  );
}

const BARS = 96;

/** The voiceover being made, playing while it is made: each line as soon as the worker has it, in order (it waits
 *  quietly at a line that isn't made yet). Starts by itself; pause or stop any time. Drawn as one waveform: each
 *  line's bars appear as it's made (dots until then), dark as it plays. */
function LiveGeneration({ job, sent, onActive, onCancel }: { job: Job; sent: { id: string; text: string }[]; onActive: (on: boolean) => void; onCancel: () => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(true); // auto-play: the first line plays as soon as it's made
  const [idx, setIdx] = useState(0);
  const [pos, setPos] = useState(0); // 0..1 through the line playing
  const [peaks, setPeaks] = useState<Record<string, number[]>>({});
  const urlOf = (id: string) => job.results.find((r) => r.id === id)?.url ?? job.live?.find((x) => x.id === id)?.url ?? null;
  // a resumed job knows only the lines it has made: the rest are placeholders of average length
  const order = useMemo(() => {
    const known = sent.length ? sent : [...job.results.map((r) => ({ id: r.id, text: r.text ?? "" })), ...(job.live ?? []).map((x) => ({ id: x.id, text: "" }))];
    const pad = Array.from({ length: Math.max(0, job.progress.total - known.length) }, (_, i) => ({ id: `?${i}`, text: "" }));
    return [...known, ...pad];
  }, [sent, job.results, job.live, job.progress.total]);
  const total = order.length;
  const cur = order[idx]?.id;
  const src = cur ? urlOf(cur) : null;
  const readyKey = order.map((l) => (urlOf(l.id) ? l.id : "")).join(",");
  useEffect(() => { // each line's own waveform, once it's made
    for (const l of order) {
      const u = urlOf(l.id);
      if (u && !peaks[l.id]) peaksFor(u).then((p) => p && setPeaks((cur) => (cur[l.id] ? cur : { ...cur, [l.id]: p })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey]);
  const start = (a: HTMLAudioElement, id: string, u: string) => { a.src = u; a.dataset.id = id; a.play().catch(() => setOn(false)); }; // blocked: press play
  useEffect(() => { onActive(on); }, [on, onActive]);
  useEffect(() => {
    const a = audio.current;
    if (!a || !on) return;
    if (idx >= total) { setOn(false); setIdx(0); setPos(0); a.removeAttribute("data-id"); return; }
    if (src && a.dataset.id !== cur) start(a, cur, src); // the next line just arrived, or the last one ended
  }, [on, idx, src, cur, total]);
  useEffect(() => () => audio.current?.pause(), []);
  function toggle() {
    const a = audio.current!;
    if (on) { a.pause(); setOn(false); return; }
    setOn(true);
    if (src && a.dataset.id === cur && a.src) a.play().catch(() => start(a, cur, src)); // resume, inside the click (Safari)
    else if (src) start(a, cur, src);
  }
  // BARS slots shared out by each line's length
  const weights = order.map((l) => Math.max(8, l.text.length || 60));
  const sum = weights.reduce((x, y) => x + y, 0);
  const bars: { h: number; made: boolean; played: boolean }[] = [];
  let acc = 0;
  order.forEach((l, li) => {
    const from = Math.round((acc / sum) * BARS), to = Math.max(from + 1, Math.round(((acc + weights[li]) / sum) * BARS));
    acc += weights[li];
    const p = peaks[l.id];
    for (let s = from; s < to && bars.length < BARS; s++) {
      const f = (s - from + 0.5) / (to - from);
      bars.push({ h: p ? p[Math.min(p.length - 1, Math.floor(f * p.length))] : 0, made: !!p, played: li < idx || (li === idx && f <= pos) });
    }
  });
  const making = ["queued", "running"].includes(job.status);
  return (
    <div className="vo-gen live">
      <div className="player compact">
        <button className={`pp ${on ? "on" : ""}`} onClick={toggle} aria-label={on ? "Pause" : "Play"}>
          {on ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
        </button>
        <div className="vo-bars" role="progressbar" aria-label="Voiceover so far" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress.fraction * 100)}>
          <svg viewBox={`0 0 ${BARS * 3} 40`} preserveAspectRatio="none" aria-hidden>
            {bars.map((b, i) => b.made
              ? <rect key={i} className={b.played ? "on" : ""} x={i * 3} y={20 - b.h * 19} width="1.9" height={Math.max(1, b.h * 38)} />
              : i % 2 ? null : <rect key={i} className="todo" x={i * 3 + 0.4} y={19.2} width="1.1" height="1.6" />)}
          </svg>
        </div>
      </div>
      {making && <div className="vo-gen-acts"><button className="icon-btn" onClick={() => { audio.current?.pause(); setOn(false); onCancel(); }} aria-label="Stop generating" title="Stop"><X size={16} /></button></div>}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audio} onEnded={() => { setIdx((i) => i + 1); setPos(0); }} onTimeUpdate={(e) => { const a = e.currentTarget; if (a.duration) setPos(a.currentTime / a.duration); }} preload="auto" hidden />
    </div>
  );
}

export default function Voiceover() {
  const { status } = useStatus();
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [catErr, setCatErr] = useState("");
  const [engine, setEngine] = useState<string>("orpheus");
  const [lang, setLang] = useState("en");
  const [voice, setVoice] = useState("tara");
  const [params, setParams] = useState<Record<string, number | string | boolean>>({});
  const [style, setStyle] = useState("tech");
  const [tempo, setTempo] = useState<number | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  const [post, setPost] = useState({ trim: true, sample_rate: 48000 });
  const [platform, setPlatform] = useState("youtube");
  const [nBest, setNBest] = useState(1);
  const [lexicon, setLexicon] = useState(true);
  const [pronounce, setPronounce] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [script, setScript] = useState(SAMPLE);
  const [label, setLabel] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [gens, setGens] = useState<Gen[]>([]); // finished voiceovers, newest first
  const [sent, setSent] = useState<{ id: string; text: string }[]>([]); // the lines the running job is voicing
  const [liveOn, setLiveOn] = useState(false); // listen live is playing: keep it on screen after the job ends
  const [err, setErr] = useState("");
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [mineLoaded, setMineLoaded] = useState(false);
  const [models, setModels] = useState<{ name: string; sample_url?: string | null }[] | null>(null); // trained voices, everyone's
  const [kvoices, setKvoices] = useState<{ voice: string; name: string; sample_url?: string | null }[]>([]); // your voices found in Kokoro
  const [qmodels, setQmodels] = useState<{ voice: string; name: string; sample_url?: string | null }[]>([]); // fine-tuned Qwen voices
  const [tab, setTab] = useState<"settings" | "history">("settings");
  const [pickOpen, setPickOpen] = useState(false);
  const pickBtn = useRef<HTMLButtonElement>(null);
  const pickList = useRef<HTMLDivElement>(null);
  useDismiss(pickOpen, () => setPickOpen(false), [pickBtn, pickList]);
  const samples = useSamples();
  const ta = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);
  const [forPost, setForPost] = useState<Post | null>(null);

  useEffect(() => {
    const s = JSON.parse(localStorage.getItem("vb-gen2") || "{}");
    if (s.engine) setEngine(s.engine); if (s.voice) setVoice(s.voice); if (s.script) setScript(s.script);
    if (s.params) setParams(s.params); if (s.style) setStyle(s.style); if (s.lang) setLang(s.lang); if (s.subtitles !== undefined) setSubtitles(s.subtitles);
    try { setGens((JSON.parse(localStorage.getItem(GENS_KEY) || "[]") as Gen[]).slice(0, 1)); } catch { /* none kept */ }
    if (s.platform) setPlatform(s.platform); if (s.takes) setNBest(s.takes); if (s.lexicon !== undefined) setLexicon(s.lexicon); if (s.pronounce) setPronounce(s.pronounce);
    // deep links from the Voices page: /voiceover?engine=qwen&voice=<name>
    const q = new URLSearchParams(location.search);
    if (q.get("engine") && (TTS as readonly string[]).includes(q.get("engine")!)) { setEngine(q.get("engine")!); setParams({}); }
    if (q.get("voice")) { setVoice(q.get("voice")!); if (/^[a-z]{2}_/.test(q.get("voice")!)) setLang(KOKORO_LANG[q.get("voice")![0]] ?? "en"); }
    api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {}).finally(() => setMineLoaded(true));
    api<{ models: { name: string; sample_url?: string | null }[] }>("models").then((r) => setModels(r.models)).catch(() => setModels([]));
    api<{ voices: { voice: string; name: string; sample_url?: string | null }[] }>("kvoices").then((r) => setKvoices(r.voices)).catch(() => {});
    api<{ models: { voice: string; name: string; sample_url?: string | null }[] }>("qmodels").then((r) => setQmodels(r.models)).catch(() => {});
    // from a post: /voiceover?post=<id> loads its script; the finished voiceover is attached back to the post
    const pid = q.get("post");
    if (pid) aw().tables.getRow<Post>({ databaseId: AW.db, tableId: "posts", rowId: pid }).then((p) => {
      setForPost(p);
      if (p.script?.trim()) setScript(p.script);
      setLabel(p.title);
      const plat = p.platforms.map((x) => POST_PLATFORM[x]).find(Boolean);
      if (plat) setPlatform(plat);
    }).catch(() => {});
    loaded.current = true;
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => { if (loaded.current) localStorage.setItem("vb-gen2", JSON.stringify({ engine, voice, script, params, style, lang, subtitles, platform, takes: nBest, lexicon, pronounce })); }, [engine, voice, script, params, style, lang, subtitles, platform, nBest, lexicon, pronounce]);
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
    // the built-in lists stand in until the worker's catalogue arrives, so the page reads the same with the GPU off
    const builtIn = eng?.voices ?? (engine === "orpheus" ? Object.keys(ORPHEUS_VOICES) : engine === "kokoro" ? KOKORO_VOICES : []);
    if (engine === "kokoro") return [...(lang === "en" ? kvoices.map((k) => k.voice) : []), ...builtIn.filter((v) => KOKORO_LANG[v[0]] === lang)];
    if (engine === "orpheus") return builtIn;
    if (engine === "myvoice") return models?.length ? models.map((m) => m.name) : ["me"];
    const base = ["female", "male", ...builtIn.filter((v) => !v.startsWith("<") && v !== "female" && v !== "male")];
    const tuned = engine === "qwen" ? qmodels.map((q) => q.voice) : [];
    return CLONERS.includes(engine) ? [...tuned, ...mine.map((m) => m.name), ...base.filter((b) => !mine.some((m) => m.name === b))] : base;
  }, [eng, engine, lang, mine, models, kvoices, qmodels]);
  const myVoice = (v: string) => mine.find((m) => m.name === v);

  useEffect(() => {
    if (!langs.some((l) => l.code === lang)) setLang("en");
    if (engine === "kokoro" && voices.length && !voices.includes(voice)) setVoice(voices[0]);
    if (engine === "orpheus" && !voices.includes(voice) && voices.length) setVoice(voice === "male" ? "dan" : "tara");
    // cloners: wait for your voices to load so a deep-linked recording isn't replaced by a preset
    if (CLONERS.includes(engine) && !voices.includes(voice) && mineLoaded) setVoice(mine[0]?.name ?? "female");
    if (engine === "myvoice" && models && !voices.includes(voice)) setVoice(voices[0]);
  }, [engine, lang, voices, voice, langs, mine, mineLoaded, models]);

  const rate = status?.rates?.[engine] ?? eng?.seconds_per_char ?? RATE[engine];
  const audioS = chars / 14.5;
  const ready = status?.engines?.[engine] === "ready";
  const subsReady = status?.engines?.whisper === "ready";
  const nTakes = engine === "kokoro" ? 1 : nBest;
  const whisperRate = status?.rates?.whisper ?? RATE.whisper;
  const listenRate = status?.rates?.listen ?? whisperRate; // the batched review (text only), learned on the worker
  const estS = rate * chars * nTakes + (ready ? 0 : LOAD_S[engine]) + (subtitles ? whisperRate * audioS + (subsReady ? 0 : LOAD_S.whisper) : 0)
    + (nTakes > 1 ? listenRate * audioS * nTakes + (subtitles || subsReady ? 0 : LOAD_S.whisper) : 0) + 4;
  const platforms: Record<string, Platform> = cat?.platforms ?? {};
  const plat = platforms[platform];
  const realName = (v: string) => (eng?.presets[v] && eng.presets[v] !== v ? eng.presets[v] : v);
  const voiceLabel = (v: string) => myVoice(v)?.label ?? kvoices.find((k) => k.voice === v)?.name ?? qmodels.find((q) => q.voice === v)?.name ?? v;
  const voiceDesc = (v: string) => (myVoice(v) ? "Your recording" : engine === "myvoice" ? "Trained model" : qmodels.some((q) => q.voice === v) ? "Fine-tuned on your voice" : kvoices.some((k) => k.voice === v) ? "Your voice in Kokoro" : describeVoice(engine, v));
  const offline = !!status && !status.online;

  function insertTag(tag: string) {
    const el = ta.current!;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const before = script.slice(0, a), after = script.slice(b);
    const pad = before && !/\s$/.test(before) ? " " : "";
    setScript(`${before}${pad}${tag} ${after}`);
    requestAnimationFrame(() => { el.focus(); const p = a + pad.length + tag.length + 1; el.setSelectionRange(p, p); });
  }

  /** A finished, archived job becomes the newest Generation. */
  function addGen(j: Job) {
    setGens((cur) => {
      if (cur.some((g) => g.job === j.id) || !j.results.length) return cur;
      const next = [{ job: j.id, ids: j.results.map((r) => r.id), engine: j.engine, voice: j.voice, label: j.label, subs: !!j.subs, at: Date.now() }, ...cur].slice(0, 1);
      try { localStorage.setItem(GENS_KEY, JSON.stringify(next)); } catch { /* storage off: this session only */ }
      return next;
    });
  }

  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (j.library) addGen(j);
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !j.library)) timer.current = setTimeout(() => poll(id), j.status === "running" ? 1000 : 1500);
    } catch (e) {
      setErr((e as Error).message);
      timer.current = setTimeout(() => poll(id), 4000);
    }
  }

  async function submit() {
    setErr(""); setJob(null);
    setSent(lines.map((l) => ({ id: l.id, text: l.text })));
    const p = { ...params };
    if (engine === "chatterbox") p.language = lang;
    if (engine === "qwen") p.language = QWEN_LANG[lang] ?? "English";
    try {
      const j = await api<Job>("jobs", {
        body: {
          engine, voice, style, lines, params: p, label: label || undefined, subtitles, language: lang,
          platform, takes: nTakes, lexicon, pronounce: parsePronounce(pronounce),
          post: { trim: post.trim, normalize_dbfs: -3, sample_rate: post.sample_rate || null, ...(tempo != null ? { tempo } : {}) },
        },
      });
      setJob(j);
      timer.current = setTimeout(() => poll(j.id), 800);
      if (forPost) {
        const jobs = [...(forPost.jobs ?? []).filter((x) => x !== j.id), j.id];
        aw().tables.updateRow<Post>({ databaseId: AW.db, tableId: "posts", rowId: forPost.$id, data: { jobs } }).then(setForPost).catch(() => {});
        logActivity(forPost.$id, "voiced", `${engine} · ${label || forPost.title}`);
      }

    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useResumeJob<Job>(["voice"], (j) => { setJob(j); setSent(j.results.map((r) => ({ id: r.id, text: r.text ?? "" }))); timer.current = setTimeout(() => poll(j.id), 300); });
  const running = !!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library));
  const blocked = !status ? "Connecting to the GPU…" : offline ? "Start the GPU to generate" : !lines.length ? "Write a line first" : running ? "Generating…" : "";

  return (
    <div className="tts">
      <div className="tts-main">
        <h1 className="sr-only">Voiceover</h1>
        <div className="tts-canvas">
          {offline && (
            <Notice icon={<WarningCircle size={18} weight="bold" />} tone="warn" action={<Link href="/gpu" className="btn sm"><Power size={14} weight="bold" />Start the GPU</Link>}>
              <b>The GPU is off.</b> Write and set up now; this page connects by itself once it&apos;s on.
            </Notice>
          )}
          {catErr && <p className="err" role="alert">{catErr}</p>}
          {forPost && (
            <Notice icon={<Microphone size={16} />} action={<Link className="btn ghost sm" href={`/posts?post=${forPost.$id}`}>Open post</Link>}>
              <b>{forPost.title}</b> · voiceovers you make here are attached to this post{forPost.jobs?.length ? ` (${forPost.jobs.length} so far)` : ""}.
            </Notice>
          )}

          <div className="tts-head">
            <button className="tts-voicechip" onClick={() => { setTab("settings"); setPickOpen(true); document.getElementById("vo-voice")?.scrollIntoView({ block: "nearest" }); }}>
              <VoiceGlyph name={CLONERS.includes(engine) && !myVoice(voice) ? (voice === "male" ? "dan" : "tara") : realName(voice)} size={22} active={running} />
              {voiceLabel(voice)} <span className="dim">· {NAME[engine]}</span>
            </button>
            <span className="grow" />
            <GuideButton engine={engine} />
          </div>

          {job && !running && ["error", "cancelled"].includes(job.status) && <JobProgress job={job} />}

          <label htmlFor="vo-script" className="sr-only">Script</label>
          <textarea id="vo-script" ref={ta} value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} className="tts-text"
            placeholder={lang === "hi" ? "यहाँ अपनी स्क्रिप्ट लिखें…" : "Start writing or paste your script."} />

          {job && (running || liveOn) && !["error", "cancelled"].includes(job.status)
            ? <LiveGeneration key={job.id} job={job} sent={sent} onActive={setLiveOn}
                onCancel={() => api(`jobs/${job.id}/cancel`, { body: {} })} />
            : gens[0] && <Generation key={gens[0].job} g={gens[0]} />}

          <div className="tts-foot tts-gen-bar">
            <span className="tts-status"><span className={`dot ${status?.online ? (ready ? "ok" : "off") : status ? "bad" : "off"}`} />
              {!status ? "Connecting" : offline ? "GPU off" : ready ? `${NAME[engine]} warm` : `${NAME[engine]} loads on first use`}</span>
            <PopMenu align="left" up width={300} trigger={({ toggle, ref, open }) => <button ref={ref} className="ghost sm" onClick={toggle} aria-expanded={open}><Plus size={14} weight="bold" />Insert</button>}>
              {(close) => (
                <div className="insert-pop">
                  <span className="pm-h">Pauses</span>
                  <div className="chips">{MARKS.map((t) => <button key={t} className="chip tag" onClick={() => { insertTag(t); close(); }}>{t}</button>)}</div>
                  {engine === "orpheus" && <><span className="pm-h">Sounds</span><div className="chips">{TAGS.map((t) => <button key={t} className="chip tag" onClick={() => { insertTag(t); close(); }}>{t}</button>)}</div></>}
                </div>
              )}
            </PopMenu>
            <span className="count">{chars.toLocaleString()} characters · ≈{fmtS(audioS)}{status?.online ? ` · ready in ≈${fmtS(estS)}` : ""}</span>
            {offline
              ? <Link href="/gpu" className="btn"><Power size={15} weight="bold" />Start the GPU</Link>
              : <button disabled={!!blocked} onClick={() => submit()} title={blocked || undefined}><Microphone size={16} weight="bold" />{running ? "Generating…" : gens.length ? "Generate again" : "Generate speech"}</button>}
          </div>
          {err && <p className="err" role="alert">{err}</p>}
        </div>
      </div>

      <aside className="tts-side" aria-label="Voice settings">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "settings"} className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>Settings</button>
          <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>
        </div>
        {tab === "history" ? <History refreshKey={job?.library ? job.id : null} /> : (
          <>
            <div className="set-row" id="vo-voice">
              <div className="sr-h">Voice <Link href="/voices" className="aside linkish u">Browse voices</Link></div>
              <button ref={pickBtn} className="picker-btn" onClick={() => setPickOpen(!pickOpen)} aria-expanded={pickOpen} aria-controls="vo-voices">
                <VoiceGlyph name={CLONERS.includes(engine) && !myVoice(voice) ? (voice === "male" ? "dan" : "tara") : realName(voice)} size={28} active={running} />
                <span className="ellipsis">{voiceLabel(voice)} <span className="pb-sub">· {voiceDesc(voice)}</span></span>
                {pickOpen ? <CaretUp size={14} className="pb-chev" /> : <CaretDown size={14} className="pb-chev" />}
              </button>
              {pickOpen && (
                <div ref={pickList} className="voice-list" id="vo-voices" role="listbox" aria-label={`${NAME[engine]} voices`} style={{ marginTop: 8 }}>
                  {[...voices.filter((v) => lively.includes(v)), ...voices.filter((v) => !lively.includes(v))].map((v) => {
                    const mv = myVoice(v);
                    const trained = engine === "myvoice" ? models?.find((m) => m.name === v) : undefined;
                    const kv = engine === "kokoro" ? kvoices.find((k) => k.voice === v) : engine === "qwen" ? qmodels.find((q) => q.voice === v) : undefined;
                    const sample = trained ? trained.sample_url ?? undefined : kv ? kv.sample_url ?? undefined : mv ? mv.url : samples?.voices[engine]?.[v]?.url;
                    return (
                      <div key={v} role="option" aria-selected={voice === v} className={`voice-opt ${voice === v ? "on" : ""}`} tabIndex={0}
                        onClick={() => setVoice(v)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setVoice(v); } }}>
                        <VoiceGlyph name={CLONERS.includes(engine) && !mv ? (v === "male" ? "dan" : "tara") : realName(v)} size={30} active={voice === v} />
                        <span className="vo-n"><b>{voiceLabel(v)}</b><span>{voiceDesc(v)}{lively.includes(v) ? " · liveliest for this delivery" : ""}</span></span>
                        {lively.includes(v) && <Sparkle size={13} weight="fill" className="star" aria-hidden />}
                        <SampleButton id={`gen/${engine}/${v}`} url={sample} size={28} label={voiceLabel(v)} />
                      </div>
                    );
                  })}
                  {!voices.length && <p className="small dim" style={{ padding: 8 }}>{engine === "kokoro" ? "No Kokoro voices for this language yet." : "No voices yet."}</p>}
                  {CLONERS.includes(engine) && <Link href="/voices/new" className="voice-opt"><span className="thumb" style={{ width: 30, height: 30, borderRadius: "50%" }}><Plus size={15} /></span><span className="vo-n"><b>Record your voice</b><span>20 seconds, ready to use</span></span></Link>}
                </div>
              )}
            </div>

            <div className="set-row">
              <div className="sr-h"><label htmlFor="vo-engine">Model</label><Info label="Model">{BLURB[engine]}. {engine === "orpheus" ? "English only; use Chatterbox for Hindi and 21 more languages." : engine === "kokoro" ? "Same take every time; great for timing drafts." : "Voice match is checked against the recording."}</Info></div>
              <Select id="vo-engine" value={engine} onChange={(v) => { setEngine(v); setParams({}); }} options={TTS.map((n) => ({ value: n, label: NAME[n], hint: BLURB[n] }))} />
            </div>

            <div className="set-row">
              <div className="sr-h">Delivery <Info label="Delivery">{styles[style]?.about ?? "How the read feels: energy, pace and emphasis."}</Info></div>
              <div className="seg full" role="radiogroup" aria-label="Delivery">
                {STYLE_ORDER.filter((k) => !cat || styles[k]).map((k) => (
                  <button key={k} role="radio" aria-checked={style === k} className={style === k ? "on" : ""} onClick={() => { setStyle(k); setParams({}); setTempo(null); }}>{styles[k]?.label.split(/[ /]/)[0] ?? STYLE_FALLBACK[k]}</button>
                ))}
              </div>
              <div className="set-line" style={{ marginTop: 14 }}><label htmlFor="vo-pace">Pace</label><span className="mono small">{effTempo.toFixed(2)}×</span></div>
              <div className="range-ends"><span>Slower</span><span>Faster</span></div>
              <input id="vo-pace" type="range" min={0.85} max={1.2} step={0.01} value={effTempo} style={rangeFill(effTempo, 0.85, 1.2)} onChange={(e) => setTempo(+e.target.value)} aria-describedby="vo-pace-hint" />
              <div id="vo-pace-hint" className="tiny faint">Pitch stays the same. Within ±8% sounds natural.</div>
            </div>

            <div className="set-row">
              <div className="sr-h"><label htmlFor="vo-platform">Publish for</label><Info label="Publish for">{plat ? `${plat.about}${plat.lufs != null ? " Broadcast voice chain: rumble cut, presence lift, de-ess, gentle compression." : ""}` : "Sets loudness mastering and the caption style for that platform."}</Info></div>
              <Select id="vo-platform" value={platform} onChange={setPlatform}
                options={PLATFORM_ORDER.filter((k) => !cat || platforms[k]).map((k) => ({ value: k, label: platforms[k]?.label ?? PLATFORM_FALLBACK[k], hint: platforms[k] ? (platforms[k].lufs != null ? `${platforms[k].lufs} LUFS` : "unmastered") : undefined }))} />
            </div>

            <div className="set-row">
              <div className="sr-h">Quality</div>
              <div className="set-line"><span>Best of <Info label="Best of">{engine === "kokoro" ? "Kokoro gives the same take every time." : "Each sentence is voiced N times; Whisper checks every word" + (CLONERS.includes(engine) ? " and how much it sounds like the voice" : "") + " and keeps the best. " + (engine === "orpheus" ? "Orpheus voices the takes together, so best of 4 takes about 1.5× as long as one." : "Each take is voiced on its own, so it takes up to N× as long: use it for the final render.")}</Info></span>
                <div className="seg" role="radiogroup" aria-label="Best of">
                  {Array.from({ length: cat?.max_takes ?? 4 }, (_, i) => i + 1).map((n) => (
                    <button key={n} role="radio" aria-checked={nTakes === n} className={nTakes === n ? "on" : ""} disabled={engine === "kokoro" && n > 1} onClick={() => setNBest(n)}>{n}×</button>
                  ))}
                </div></div>
              <div className="set-line"><span>Subtitles <Info label="Subtitles">Whisper large-v3 word timing. SRT, VTT and JSON, with a match score per line.</Info></span>
                <button role="switch" aria-checked={subtitles} className={`switch ${subtitles ? "on" : ""}`} onClick={() => setSubtitles(!subtitles)} aria-label="Subtitles" /></div>
              <div className="set-line"><span>Tech pronunciation <Info label="Tech pronunciation">SQL → sequel, GPU → G-P-U, 16GB → 16 gigabytes; markdown and links cleaned.</Info></span>
                <button role="switch" aria-checked={lexicon} className={`switch ${lexicon ? "on" : ""}`} onClick={() => setLexicon(!lexicon)} aria-label="Tech pronunciation" /></div>
            </div>

            <div className="set-row">
              <div className="sr-h"><label htmlFor="vo-label">Take name</label><span className="aside">Optional</span></div>
              <input id="vo-label" placeholder="e.g. GPS explainer, intro" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>

            <details className="set-row" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
              <summary className="sr-h" style={{ cursor: "pointer", marginBottom: 0 }}><span className="row" style={{ gap: 8 }}><SlidersHorizontal size={15} />Advanced{(Object.keys(params).length > 0 || tempo != null) ? <span className="pill">edited</span> : null}</span><CaretDown size={14} className="dim" /></summary>
              <div style={{ marginTop: 14 }}>
                <div className="field">
                  <label className="f" htmlFor="vo-lang">Language {engine === "orpheus" ? <Info label="Language">Orpheus speaks English only. Use Chatterbox for Hindi and 21 more languages.</Info> : engine === "qwen" ? <Info label="Language">Your voice can speak any of these, even ones you didn&apos;t record in. Hindi: use Chatterbox.</Info> : null}</label>
                  <Select id="vo-lang" value={lang} onChange={setLang} disabled={engine === "orpheus"} options={langs.map((l) => ({ value: l.code, label: l.name, hint: l.script }))} />
                  {lang !== "en" && <div className="hint">Write in {LANGUAGES.find((l) => l.code === lang)?.script ?? "the language's own spelling"}, not romanised text.</div>}
                </div>
                {eng && Object.entries(eng.params).filter(([k]) => !((engine === "chatterbox" || engine === "qwen") && k === "language") && !(engine === "kokoro" && k === "lang")).map(([k, p]) => {
                  const v = params[k] ?? styleParams[k] ?? p.default;
                  const id = `vo-p-${k}`;
                  if (p.type === "boolean") return (
                    <div className="field" key={k}>
                      <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={Boolean(v)} onChange={(e) => setParams({ ...params, [k]: e.target.checked })} />{k.replace(/_/g, " ")}{p.about && <Info label={k}>{p.about}</Info>}</label></div>
                  );
                  if (p.min === undefined) return (
                    <div className="field" key={k}><label className="f" htmlFor={id}>{k}{p.about && <Info label={k}>{p.about}</Info>}</label>
                      <input id={id} type={p.type === "string" ? "text" : "number"} value={String(v)} onChange={(e) => setParams({ ...params, [k]: p.type === "string" ? e.target.value : +e.target.value })} /></div>
                  );
                  return (
                    <div className="field" key={k}>
                      <div className="set-line"><label htmlFor={id}>{k.replace(/_/g, " ")}{p.about && <Info label={k}>{p.about}</Info>}</label><span className="mono small">{Number(v).toFixed(p.type === "integer" ? 0 : 2)}</span></div>
                      <input id={id} type="range" min={p.min} max={p.max} step={p.type === "integer" ? 1 : 0.05} value={Number(v)} style={rangeFill(Number(v), p.min, p.max)} onChange={(e) => setParams({ ...params, [k]: +e.target.value })} />
                    </div>
                  );
                })}
                <div className="field">
                  <label className="f" htmlFor="vo-pron">Your pronunciations <Info label="Your pronunciations">One per line: word = how to say it.</Info></label>
                  <textarea id="vo-pron" value={pronounce} onChange={(e) => setPronounce(e.target.value)} spellCheck={false} style={{ minHeight: 80 }} placeholder={"Kubernetes = koo-ber-net-eez"} />
                </div>
                <label className="row small" style={{ gap: 8, marginBottom: 12 }}><input type="checkbox" checked={post.trim} onChange={(e) => setPost({ ...post, trim: e.target.checked })} />Trim silence at the start and end</label>
                <div className="field">
                  <label className="f" htmlFor="vo-sr">Sample rate</label>
                  <Select id="vo-sr" value={post.sample_rate} onChange={(v) => setPost({ ...post, sample_rate: v })} options={[[48000, "48 kHz · video"], [44100, "44.1 kHz · music"], [24000, "24 kHz"], [0, "Engine native"]]} />
                </div>
                {(Object.keys(params).length > 0 || tempo != null) && <button className="ghost sm" onClick={() => { setParams({}); setTempo(null); }}>Reset to {styles[style]?.label ?? "the delivery's defaults"}</button>}
              </div>
            </details>
          </>
        )}
      </aside>
    </div>
  );
}
