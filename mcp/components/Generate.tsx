"use client";
import { ArrowSquareOut, CaretDown, ClosedCaptioning, DownloadSimple, Eye, Flask, Microphone, Plus, SlidersHorizontal, Sparkle, Trophy, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtS, pct, rangeFill, simClass, type Job, type MyVoice } from "./api";
import { EngineArt, StyleGlyph, VoiceGlyph } from "./art";
import { GuideButton } from "./GuideDrawer";
import { GUIDES, KOKORO_LANG, LANGUAGES, QWEN_LANG } from "./guides";
import JobProgress from "./JobProgress";
import LineRow from "./LineRow";
import { SampleButton, useSamples } from "./Sample";
import { useStatus } from "./Shell";
import { aw, logActivity } from "./aw";
import { AW, type Post } from "@/lib/workspace";

type Param = { type: "number" | "integer" | "string" | "boolean"; default: number | string | boolean; min?: number; max?: number; about?: string };
type Engine = { kind: string; about: string; voices: string[]; presets: Record<string, string>; params: Record<string, Param>; state: string; seconds_per_char?: number };
type Style = { label: string; about: string; params: Record<string, Record<string, number>>; post: { tempo?: number }; post_by_engine?: Record<string, { tempo?: number }>; voices: Record<string, string[]> };
type Platform = { label: string; about: string; lufs: number | null; tp: number | null; captions: string };
type Catalogue = { engines: Record<string, Engine>; references: string[]; styles?: Record<string, Style>; default_style?: string; platforms?: Record<string, Platform>; max_takes?: number };
type ParsedLine = { id: string; text: string; window?: number; start?: number; params?: Record<string, number> };

const TTS = ["qwen", "myvoice", "orpheus", "chatterbox", "kokoro"] as const;
const BLURB: Record<string, string> = { myvoice: "Your trained model", orpheus: "Most human · English", qwen: "Your voice · best cloning", chatterbox: "Emotion · cloning · 23 langs", kokoro: "Instant drafts · CPU" };
const CLONERS = ["qwen", "chatterbox"];
const STYLE_ORDER = ["tech", "hype", "narrator", "neutral"];
const TAGS = ["<laugh>", "<chuckle>", "<sigh>", "<gasp>", "<groan>", "<yawn>", "<sniffle>", "<cough>"];
const MARKS = ["[pause]", "[pause 1.2]", "[beat]", "[breath]"];
const PLATFORM_ORDER = ["youtube", "shorts", "reels", "tiktok", "podcast", "raw"];
const POST_PLATFORM: Record<string, string> = { youtube: "youtube", shorts: "shorts", reels: "reels", instagram: "reels", tiktok: "tiktok", podcast: "podcast" };
const PLATFORM_ICON: Record<string, string> = { youtube: "▶", shorts: "▮", reels: "◎", tiktok: "♪", podcast: "◉", raw: "∿" };

/** "word = how to say it", one per line. */
function parsePronounce(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of src.split("\n")) {
    const i = l.indexOf("=");
    if (i > 0 && l.slice(0, i).trim() && l.slice(i + 1).trim()) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}
const LOAD_S: Record<string, number> = { orpheus: 120, chatterbox: 45, kokoro: 5, whisper: 40, qwen: 60 };
const RATE: Record<string, number> = { orpheus: 0.03, chatterbox: 0.06, kokoro: 0.004, whisper: 0.06, qwen: 0.05 };
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
  const [params, setParams] = useState<Record<string, number | string | boolean>>({});
  const [style, setStyle] = useState("tech");
  const [tempo, setTempo] = useState<number | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  const [post, setPost] = useState({ trim: true, sample_rate: 48000 });
  const [platform, setPlatform] = useState("youtube");
  const [takes, setTakes] = useState(1);
  const [lexicon, setLexicon] = useState(true);
  const [pronounce, setPronounce] = useState("");
  const [showLex, setShowLex] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [script, setScript] = useState(SAMPLE);
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [lib, setLib] = useState<{ results: { id: string; audio: string }[] } | null>(null);
  const [err, setErr] = useState("");
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [mineLoaded, setMineLoaded] = useState(false);
  const samples = useSamples();
  const ta = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);
  const [forPost, setForPost] = useState<Post | null>(null);

  useEffect(() => {
    const s = JSON.parse(localStorage.getItem("vb-gen2") || "{}");
    if (s.engine) setEngine(s.engine); if (s.voice) setVoice(s.voice); if (s.script) setScript(s.script);
    if (s.params) setParams(s.params); if (s.style) setStyle(s.style); if (s.lang) setLang(s.lang); if (s.subtitles !== undefined) setSubtitles(s.subtitles);
    if (s.platform) setPlatform(s.platform); if (s.takes) setTakes(s.takes); if (s.lexicon !== undefined) setLexicon(s.lexicon); if (s.pronounce) setPronounce(s.pronounce);
    // deep links from the Voices page: /generate?engine=qwen&voice=<name>
    const q = new URLSearchParams(location.search);
    if (q.get("engine") && (TTS as readonly string[]).includes(q.get("engine")!)) { setEngine(q.get("engine")!); setParams({}); }
    if (q.get("voice")) { setVoice(q.get("voice")!); if (/^[a-z]{2}_/.test(q.get("voice")!)) setLang(KOKORO_LANG[q.get("voice")![0]] ?? "en"); }
    api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {}).finally(() => setMineLoaded(true));
    // from a workspace post: /generate?post=<id> loads its script; the finished voiceover is attached back to the post
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
  useEffect(() => { if (loaded.current) localStorage.setItem("vb-gen2", JSON.stringify({ engine, voice, script, params, style, lang, subtitles, platform, takes, lexicon, pronounce })); }, [engine, voice, script, params, style, lang, subtitles, platform, takes, lexicon, pronounce]);
  useEffect(() => { if (status?.online && !cat) api<Catalogue>("voices").then(setCat).catch((e) => setCatErr(e.message)); }, [status?.online, cat]);

  const eng = cat?.engines[engine];
  const styles: Record<string, Style> = cat?.styles ?? {};
  const styleParams: Record<string, number> = styles[style]?.params?.[engine] ?? {};
  const effTempo = tempo ?? styles[style]?.post_by_engine?.[engine]?.tempo ?? styles[style]?.post?.tempo ?? 1;
  const lines = useMemo(() => parse(script), [script]);
  const [spoken, setSpoken] = useState<string[]>([]);
  useEffect(() => {  // what the voice will actually read (tech terms, your dictionary, [pause] markers): worker dry run, no GPU
    if (!preview || !status?.online || !lines.length) return;
    const t = setTimeout(() => {
      api<{ lines: { parts: { spoken: string; pause_after: number | null }[] }[] }>("speakable", { body: { lines: lines.slice(0, 200).map((l) => l.text), lexicon, pronounce: parsePronounce(pronounce) } })
        .then((r) => setSpoken(r.lines.map((l) => l.parts.map((p) => p.spoken + (p.pause_after ? ` ⏸${p.pause_after}s` : "")).join(" "))))
        .catch(() => setSpoken([]));
    }, 500);
    return () => clearTimeout(t);
  }, [preview, status?.online, lines, lexicon, pronounce]);
  const lively = styles[style]?.voices?.[engine] ?? [];
  const chars = lines.reduce((s, l) => s + l.text.length, 0);
  const langs = LANGUAGES.filter((l) => l.engines.includes(engine));
  const voices = useMemo(() => {
    if (engine === "kokoro") return (eng?.voices ?? []).filter((v) => KOKORO_LANG[v[0]] === lang);
    if (engine === "orpheus") return eng?.voices ?? [];
    const base = ["female", "male", ...(eng?.voices ?? []).filter((v) => !v.startsWith("<") && v !== "female" && v !== "male")];
    return CLONERS.includes(engine) ? [...mine.map((m) => m.name), ...base.filter((b) => !mine.some((m) => m.name === b))] : base;
  }, [eng, engine, lang, mine]);
  const myVoice = (v: string) => mine.find((m) => m.name === v);

  useEffect(() => {
    if (!langs.some((l) => l.code === lang)) setLang("en");
    if (engine === "kokoro" && voices.length && !voices.includes(voice)) setVoice(voices[0]);
    if (engine === "orpheus" && !voices.includes(voice) && voices.length) setVoice(voice === "male" ? "dan" : "tara");
    // cloners: wait for your voices to load so a deep-linked recording isn't replaced by a preset
    if (CLONERS.includes(engine) && !voices.includes(voice) && mineLoaded) setVoice(mine[0]?.name ?? "female");
  }, [engine, lang, voices, voice, langs, mine, mineLoaded]);

  const rate = status?.rates?.[engine] ?? eng?.seconds_per_char ?? RATE[engine];
  const audioS = chars / 14.5;
  const ready = status?.engines?.[engine] === "ready";
  const subsReady = status?.engines?.whisper === "ready";
  const nTakes = engine === "kokoro" ? 1 : takes;
  const whisperRate = status?.rates?.whisper ?? RATE.whisper;
  const estS = rate * chars * nTakes + (ready ? 0 : LOAD_S[engine]) + (subtitles ? whisperRate * audioS + (subsReady ? 0 : LOAD_S.whisper) : 0)
    + (nTakes > 1 ? whisperRate * audioS * nTakes + (subtitles || subsReady ? 0 : LOAD_S.whisper) : 0) + 4;
  const platforms: Record<string, Platform> = cat?.platforms ?? {};
  const plat = platforms[platform];

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
    if (engine === "qwen") p.language = QWEN_LANG[lang] ?? "English";
    try {
      const j = await api<Job>("jobs", {
        body: {
          engine, voice, style, lines: only ?? lines, params: p, label: label || undefined, subtitles, language: lang,
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
          <div className="eyebrow">Voiceover</div>
          <h1>Write it, <em>hear it.</em></h1>
          <p className="sub">Script on the left, the voice on the right. Every take lands in the Library with word-timed subtitles.</p>
        </div>
        <GuideButton engine={engine} />
      </div>
      {!status?.online && status && <div className="banner"><WarningCircle size={20} weight="duotone" color="var(--signal2)" /><div><b>The GPU worker is offline.</b> <span className="dim">Run the Colab notebook; this page reconnects by itself.</span></div></div>}
      {catErr && <p className="err">{catErr}</p>}
      {forPost && <div className="note-strip"><Link href={`/workspace?post=${forPost.$id}`}><b>{forPost.title}</b></Link><span className="dim">Voiceovers you make here are attached to this post{forPost.jobs?.length ? ` · ${forPost.jobs.length} so far` : ""}.</span></div>}

      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h2>Script</h2>
              <span className="dim tiny">one line per row · <span className="mono">id | text | seconds</span> · or paste a timeline TSV</span>
            </div>
            <div className="chips" style={{ marginBottom: 12 }}>
              <span className="label" style={{ alignSelf: "center", marginRight: 4 }}>Insert</span>
              {MARKS.map((t) => <button key={t} className="chip tag" title="Real silence, in seconds" onClick={() => insertTag(t)}>{t}</button>)}
              {engine === "orpheus" && TAGS.map((t) => <button key={t} className="chip tag" onClick={() => insertTag(t)}>{t}</button>)}
            </div>
            <textarea ref={ta} value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false}
              placeholder={lang === "hi" ? "यहाँ अपनी स्क्रिप्ट लिखें, हर पंक्ति एक लाइन…" : "Write your script here, one line per row…"} />
            <div className="row between" style={{ marginTop: 10 }}>
              <span className="dim small mono">{lines.length} line{lines.length === 1 ? "" : "s"} · {chars.toLocaleString()} chars · ≈ {fmtS(audioS)} of speech</span>
              {lines.length > 0 && <button className="quiet xs" onClick={() => setPreview(!preview)}><Eye size={14} />{preview ? "Hide" : "Preview"} lines</button>}
            </div>
            {preview && (
              <table className="table small" style={{ marginTop: 8 }}><tbody>
                {lines.map((l, i) => (
                  <tr key={l.id}><td className="mono dim" style={{ width: 50 }}>{l.id}</td><td>{l.text}
                    {spoken[i] && spoken[i].replace(/ ⏸[\d.]+s/g, "") !== l.text && <div className="dim tiny">reads: {spoken[i]}</div>}</td>
                    <td className="mono dim" style={{ whiteSpace: "nowrap" }}>≈{(l.text.length / 14.5).toFixed(1)}s{l.window ? ` / ${l.window}s` : ""}</td></tr>
                ))}
              </tbody></table>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>Engine</h2></div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              {TTS.map((n) => (
                <button key={n} className={`pick engine-tile ${engine === n ? "on" : ""}`} onClick={() => { setEngine(n); setParams({}); }}>
                  <span className="art"><EngineArt engine={n} live={engine === n} /></span>
                  <span className="row between" style={{ marginTop: 10 }}><span className="t1" style={{ font: "600 17px var(--display)", letterSpacing: "-.02em" }}>{n === "myvoice" ? "Your model" : n[0].toUpperCase() + n.slice(1)}</span>
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
            <div className="card-head"><h2>Publish for</h2><span className="dim tiny">mastering + captions</span></div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              {PLATFORM_ORDER.filter((k) => !cat || platforms[k]).map((k) => (
                <button key={k} className={`pick ${platform === k ? "on" : ""}`} title={platforms[k]?.about} onClick={() => setPlatform(k)} style={{ padding: "10px 8px" }}>
                  <div className="t1" style={{ fontSize: 14 }}><span aria-hidden style={{ marginRight: 6, opacity: 0.7 }}>{PLATFORM_ICON[k]}</span>{platforms[k]?.label ?? k}</div>
                  <div className="dim tiny mono">{platforms[k] ? (platforms[k].lufs != null ? `${platforms[k].lufs} LUFS` : "unmastered") : ""}</div>
                </button>
              ))}
            </div>
            {plat && <p className="dim small" style={{ margin: "12px 0 0" }}>{plat.about}{plat.lufs != null ? " Broadcast voice chain: rumble cut, presence lift, de-ess, gentle compression." : ""}</p>}
            <div className="field" style={{ margin: "16px 0 0" }}>
              <div className="row between" style={{ marginBottom: 6 }}><label className="f" style={{ margin: 0 }}><Trophy size={13} weight="duotone" /> Best of</label>
                <span className="dim tiny">{nTakes > 1 ? `${nTakes} takes per sentence, the best one wins` : "one take"}</span></div>
              <div className="seg">
                {Array.from({ length: cat?.max_takes ?? 4 }, (_, i) => i + 1).map((n) => (
                  <button key={n} className={nTakes === n ? "on" : ""} disabled={engine === "kokoro" && n > 1} onClick={() => setTakes(n)}>{n}×</button>
                ))}
              </div>
              <div className="dim tiny" style={{ marginTop: 5 }}>{engine === "kokoro" ? "Kokoro gives the same take every time." : "Whisper checks every word of every take" + (CLONERS.includes(engine) ? " and how much it sounds like the voice" : "") + ". Takes N× longer; use it for the final render."}</div>
            </div>
            <div className="row between" style={{ marginTop: 14 }}>
              <div style={{ minWidth: 0 }}><b className="small">Tech pronunciation</b><div className="dim tiny">SQL → sequel, GPU → G-P-U, 16GB → 16 gigabytes, markdown and links cleaned</div></div>
              <button className={`switch ${lexicon ? "on" : ""}`} onClick={() => setLexicon(!lexicon)} aria-label="Tech pronunciation" />
            </div>
            <button className="quiet xs" style={{ marginTop: 8 }} onClick={() => setShowLex(!showLex)}><CaretDown size={12} style={{ transform: showLex ? "rotate(180deg)" : "none", transition: "transform .2s" }} />Your pronunciations{Object.keys(parsePronounce(pronounce)).length ? ` (${Object.keys(parsePronounce(pronounce)).length})` : ""}</button>
            {showLex && (
              <textarea value={pronounce} onChange={(e) => setPronounce(e.target.value)} spellCheck={false} style={{ minHeight: 90, marginTop: 8 }}
                placeholder={"One per line: word = how to say it\nKubernetes = koo-ber-net-eez\nYourBrand = your brand"} />
            )}
          </div>

          <div className="card">
            <div className="card-head"><h2>Voice</h2></div>
            <div className="field">
              <label className="f">Language</label>
              <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={engine === "orpheus"}>
                {langs.map((l) => <option key={l.code} value={l.code}>{l.name}{l.script ? ` · ${l.script}` : ""}</option>)}
              </select>
              {engine === "orpheus" && <div className="dim tiny" style={{ marginTop: 5 }}>Orpheus speaks English only. Use Chatterbox for Hindi and 21 more languages.</div>}
              {engine === "qwen" && <div className="dim tiny" style={{ marginTop: 5 }}>Your voice can speak any of these, even ones you didn't record in. Hindi: use Chatterbox.</div>}
              {lang !== "en" && <div className="dim tiny" style={{ marginTop: 5 }}>Write in {LANGUAGES.find((l) => l.code === lang)?.script ?? "the language's own spelling"}, not romanised text.</div>}
            </div>
            <div className="field">
              <div className="row between" style={{ marginBottom: 8 }}><label className="f" style={{ margin: 0 }}>Voice</label>
                {lively.length > 0 && <span className="tiny dim"><Sparkle size={12} weight="fill" color="var(--sand)" /> liveliest for {styles[style]?.label.toLowerCase()}</span>}</div>
              <div className="voices">
                {[...voices.filter((v) => lively.includes(v)), ...voices.filter((v) => !lively.includes(v))].map((v) => {
                  const real = eng?.presets[v] && eng.presets[v] !== v ? eng.presets[v] : v;
                  const mv = myVoice(v);
                  const sample = mv ? mv.url : samples?.voices[engine]?.[v]?.url;
                  return (
                    <button key={v} className={`pick voice-pick ${voice === v ? "on" : ""} ${mv ? "mine" : ""}`} onClick={() => setVoice(v)}>
                      {lively.includes(v) && <Sparkle size={12} weight="fill" className="star" />}
                      <span className="vplay"><SampleButton id={`gen/${engine}/${v}`} url={sample} size={24} label={mv?.label ?? v} /></span>
                      <VoiceGlyph name={CLONERS.includes(engine) && !mv ? (v === "male" ? "dan" : "tara") : real} size={46} active={voice === v} />
                      <span className="vn">{mv?.label ?? v}</span>
                      <span className="vs">{mv ? "your voice" : real !== v ? real : engine === "kokoro" ? KOKORO_LANG[v[0]] ?? "" : engine}</span>
                    </button>
                  );
                })}
                {CLONERS.includes(engine) && (
                  <Link href="/voices" className="pick voice-pick add-voice">
                    <span className="plus"><Plus size={20} weight="bold" /></span>
                    <span className="vn">{mine.length ? "Record another" : "Record yours"}</span>
                    <span className="vs">20 seconds</span>
                  </Link>
                )}
              </div>
              {engine === "qwen" && !mine.length && <div className="dim tiny" style={{ marginTop: 8 }}>Qwen shines with a recording of you. Until then it clones the female/male presets.</div>}
              {!voices.length && <span className="dim small">No {engine} voices for this language.</span>}
            </div>
            {eng && Object.entries(eng.params).filter(([k]) => !((engine === "chatterbox" || engine === "qwen") && k === "language") && !(engine === "kokoro" && k === "lang")).map(([k, p]) => {
              const v = params[k] ?? styleParams[k] ?? p.default;
              if (p.type === "boolean") return (
                <div className="field" key={k}>
                  <label className="row small" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={Boolean(v)} onChange={(e) => setParams({ ...params, [k]: e.target.checked })} />{k.replace(/_/g, " ")}</label>
                  {p.about && <div className="dim tiny" style={{ marginTop: 4 }}>{p.about}</div>}</div>
              );
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
          <div><div className="label">Voice</div><b><span style={{ textTransform: "capitalize" }}>{engine}</span> · {myVoice(voice)?.label ?? voice}</b></div>
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
                <h2 style={{ margin: 0 }}>Takes{job.match != null ? <span className={`pill ${job.match >= 0.95 ? "ok" : "warn"}`}>script match {pct(job.match)}</span> : null}
                  {job.similarity != null ? <span className={`pill ${simClass(job.similarity)}`} title="Speaker match vs the recording (0.86+ = same speaker)">voice match {pct(job.similarity)}</span> : null}
                  {job.platform && platforms[job.platform] ? <span className="pill">{platforms[job.platform].label}</span> : null}</h2>
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
