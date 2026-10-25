"use client";
// Voices: make a voice (instant clone, professional clone = your trained model, re-voice) and every voice you can use,
// yours and the built-in ones, with a sample to audition and a button to use it.
import { ArrowRight, MagnifyingGlass, Microphone, TrashSimple, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ago, api, type MyVoice } from "./api";
import { VoiceGlyph } from "./art";
import { useDialog } from "./Dialog";
import { describeVoice as describe, KOKORO_LANG, KOKORO_VOICES, LANGUAGES, ORPHEUS_VOICES } from "./guides";
import { Gauge, Orb } from "./Orb";
import Player from "./Player";
import { SampleButton, useSamples } from "./Sample";
import { Empty, PageHeader } from "./ui";

const ENGINES = [
  { id: "orpheus", name: "Orpheus", note: "Most human · English" },
  { id: "kokoro", name: "Kokoro", note: "Instant · 9 languages" },
  { id: "chatterbox", name: "Chatterbox", note: "Emotion · 23 languages" },
  { id: "qwen", name: "Qwen", note: "Cloner · presets" },
] as const;
const VOICES: Record<string, string[]> = { orpheus: Object.keys(ORPHEUS_VOICES), kokoro: KOKORO_VOICES, chatterbox: ["female", "male"], qwen: ["female", "male"] };

/** One way to make a voice: name, one line, the art, and its button. */
function MakeCard({ title, about, art, action }: { title: string; about: string; art: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="make-card">
      <div><h2>{title}</h2><p className="sub">{about}</p></div>
      <div className="mc-art">{art}</div>
      {action}
    </div>
  );
}

type Learnt = { jobs: number; usual_similarity?: number | null; best_temperature?: number | null };

/** What the review has learned about this voice on Qwen (tech delivery): its usual voice match and best temperature. */
function Learned({ voice }: { voice: string }) {
  const [p, setP] = useState<Learnt | null>(null);
  useEffect(() => { api<Learnt>(`profile/qwen/${voice}`).then(setP).catch(() => {}); }, [voice]);
  if (!p || !p.jobs) return null;
  return (
    <div className="tiny dim" style={{ marginTop: 8 }}>
      Learned from {p.jobs} voiceover{p.jobs > 1 ? "s" : ""}
      {p.usual_similarity != null && <> · usually {Math.round(p.usual_similarity * 100)}% like you</>}
      {p.best_temperature != null && <> · best temperature {p.best_temperature}</>}
    </div>
  );
}

export default function Voices() {
  const samples = useSamples();
  const { confirm, toast } = useDialog();
  const [mine, setMine] = useState<MyVoice[] | null>(null);
  const [trainMin, setTrainMin] = useState(0);
  const [engine, setEngine] = useState<string>("orpheus");
  const [lang, setLang] = useState("en");
  const [tab, setTab] = useState<"mine" | "library">("mine");
  const [q, setQ] = useState("");

  const load = () => api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => setMine([]));
  useEffect(() => {
    load();
    api<{ datasets: { minutes: number }[] }>("datasets").then((d) => setTrainMin(Math.max(0, ...d.datasets.map((x) => x.minutes)))).catch(() => {});
  }, []);
  useEffect(() => { if (mine && !mine.length) setTab("library"); }, [mine]);

  const list = useMemo(() => (engine === "kokoro" ? VOICES.kokoro.filter((v) => KOKORO_LANG[v[0]] === lang) : VOICES[engine]).filter((v) => !q || `${v} ${describe(engine, v)}`.toLowerCase().includes(q.toLowerCase())), [engine, lang, q]);
  const have = samples?.voices[engine] ?? {};
  const shownMine = (mine ?? []).filter((v) => !q || `${v.label} ${v.name} ${v.transcript}`.toLowerCase().includes(q.toLowerCase()));

  async function remove(v: MyVoice) {
    if (!(await confirm({ title: `Delete “${v.label}”?`, body: "The recording and its transcript are removed from storage. Takes you already made with it stay in Files.", confirm: "Delete voice", danger: true }))) return;
    await api(`myvoices/${v.name}`, { method: "DELETE" }).then(() => { toast("Voice deleted", "ok"); load(); }).catch((e) => toast((e as Error).message, "bad"));
  }

  return (
    <>
      <PageHeader title="Voices" sub="Make a voice of your own, or pick one of the built-in voices." />

      <section aria-label="Make a voice" className="make-grid">
        <MakeCard title="Instant voice clone" about="Clone your voice from as little as 10 seconds. Record yourself or upload files."
          art={<Gauge min={10} best={60} size={196}><Orb tone="instant" size={128} /></Gauge>}
          action={<Link href="/voices/new" className="btn block">Create new</Link>} />
        <MakeCard title="Professional voice clone" about="Train a model of your voice: the most natural result. Works best with 30+ minutes of you."
          art={<Gauge min={15 * 60} best={60 * 60} value={trainMin * 60} size={196}><Orb tone="pro" size={128} /></Gauge>}
          action={<Link href="/voices/professional" className="btn ghost block">{trainMin > 0 ? `Continue · ${trainMin.toFixed(0)} min recorded` : "Start training"}</Link>} />
        <MakeCard title="Re-voice a take" about="A rough take of yourself in, your clean voice out. Same timing, frame for frame."
          art={<div className="mc-revoice"><Orb tone="revoice" size={128} /><span className="mc-chips" aria-hidden><i>Phone memo</i><i>Screen recording</i><i>Noisy room</i><i>Rough take</i></span></div>}
          action={<Link href="/voices/revoice" className="btn ghost block">Create new</Link>} />
      </section>

      <div className="tabs" role="tablist" style={{ marginTop: 32 }}>
        <button role="tab" aria-selected={tab === "mine"} className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")}>My voices<span className="count">{mine?.length ?? ""}</span></button>
        <button role="tab" aria-selected={tab === "library"} className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>Built-in voices<span className="count">{Object.values(VOICES).reduce((n, v) => n + v.length, 0)}</span></button>
      </div>
      <div className="vlib-tools">
        <div className="searchbox" style={{ maxWidth: 320 }}><MagnifyingGlass size={15} className="ic" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === "mine" ? "Search your voices" : "Search voices"} aria-label="Search voices" /></div>
        {tab === "library" && (
          <div className="seg" role="radiogroup" aria-label="Engine">
            {ENGINES.map((e) => <button key={e.id} role="radio" aria-checked={engine === e.id} className={engine === e.id ? "on" : ""} onClick={() => setEngine(e.id)}>{e.name}<span className="faint tiny" style={{ marginLeft: 6 }}>{VOICES[e.id].length}</span></button>)}
          </div>
        )}
      </div>

      {tab === "mine" ? (
        mine === null ? <div className="skel" style={{ height: 160 }} /> : !mine.length ? (
          <Empty icon={<Microphone size={22} />} title="No voices of your own yet" action={<Link className="btn sm" href="/voices/new"><Microphone size={14} weight="bold" />Instant voice clone</Link>}>
            Read a short script out loud and your voice is ready for any voiceover.
          </Empty>
        ) : (
          <div className="lib-list">
            {shownMine.map((v) => (
              <div key={v.name} className="vrow reveal">
                <VoiceGlyph name={v.name} size={44} />
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}><b style={{ fontSize: 15 }}>{v.label}</b><span className="tiny dim">{v.duration.toFixed(1)} s · {ago(v.created)}</span>
                    {v.enhanced && <span className="pill ok" title="Cleaned by the studio enhancer: noise and echo removed, detail restored">Studio-enhanced</span>}</div>
                  <p className="quote clamp2">“{v.transcript}”</p>
                  {v.url && <Player src={v.url} compact />}
                  <Learned voice={v.name} />
                  {v.warnings?.map((w) => <div key={w} className="tiny" style={{ color: "var(--warn)", marginTop: 6 }}><WarningCircle size={12} /> {w}</div>)}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Link className="btn ghost sm" href={`/voiceover?engine=chatterbox&voice=${v.name}`} title="Use with Chatterbox (emotion, 23 languages)">Chatterbox</Link>
                  <Link className="btn sm" href={`/voiceover?engine=qwen&voice=${v.name}`}>Use<ArrowRight size={13} /></Link>
                  <button className="icon-btn danger-h" onClick={() => remove(v)} aria-label={`Delete ${v.label}`}><TrashSimple size={16} /></button>
                </div>
              </div>
            ))}
            {!shownMine.length && <p className="small dim" style={{ padding: 16 }}>No voice matches “{q}”.</p>}
          </div>
        )
      ) : (
        <>
          {engine === "kokoro" && (
            <div className="chips" style={{ marginBottom: 14 }} role="radiogroup" aria-label="Language">
              {LANGUAGES.filter((l) => l.engines.includes("kokoro")).map((l) => <button key={l.code} role="radio" aria-checked={lang === l.code} className={`chip ${lang === l.code ? "on" : ""}`} onClick={() => setLang(l.code)}>{l.name}</button>)}
            </div>
          )}
          <div className="vgrid">
            {list.map((v) => (
              <div key={v} className="vcard">
                <VoiceGlyph name={engine === "qwen" || engine === "chatterbox" ? (v === "male" ? "dan" : "tara") : v} size={44} />
                <div className="vc-name"><b>{v}</b><span>{ENGINES.find((e) => e.id === engine)?.name} · {describe(engine, v)}{have[v] ? ` · ${have[v].duration.toFixed(1)} s` : ""}</span></div>
                <div className="vc-act">
                  {have[v]?.url && <SampleButton id={`${engine}/${v}`} url={have[v].url} size={32} label={v} />}
                  <Link className="btn ghost sm" href={`/voiceover?engine=${engine}&voice=${v}`} aria-label={`Use ${v} in a voiceover`}>Use</Link>
                </div>
              </div>
            ))}
          </div>
          {samples?.text && Object.keys(samples.text).length > 0 && <p className="tiny dim" style={{ marginTop: 12 }}>Every voice reads the same line: “{samples.text[`${engine}/${list[0]}`] ?? Object.values(samples.text)[0]}”</p>}
        </>
      )}
    </>
  );
}
