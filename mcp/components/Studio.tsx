"use client";
import { DownloadSimple, FilmSlate, ImageSquare, MagicWand, MusicNotes, Sparkle, UploadSimple, Waveform, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, fmtS, pct, rangeFill, simClass, uploadFile, type Job, type MyVoice } from "./api";
import JobProgress from "./JobProgress";
import LineRow from "./LineRow";
import { useStatus } from "./Shell";

type Settings = { engine: string; voice: string; style: string; platform: string; takes: number; visuals: string; visual_style: string; captions_look: string; transition: string; music_lufs: number };
type Scene = { text: string; visual?: string; image_url?: string };

const PLATFORMS = [["youtube", "YouTube", "16:9"], ["shorts", "Shorts", "9:16"], ["reels", "Reels", "9:16"], ["tiktok", "TikTok", "9:16"], ["podcast", "Podcast", "16:9"]] as const;
const LOOKS = [["tech", "Tech 3D"], ["neon", "Neon cinematic"], ["minimal", "Minimal flat"], ["photo", "Photo b-roll"], ["paper", "Paper cut"], ["blueprint", "Blueprint"]] as const;
const CAPS = [["auto", "Auto"], ["bold", "Bold pop"], ["clean", "Clean subtitles"], ["none", "None"]] as const;
const ENGINES = [["qwen", "Qwen · your voice"], ["orpheus", "Orpheus · most human"], ["chatterbox", "Chatterbox · emotion"], ["kokoro", "Kokoro · instant"]] as const;
const ORPHEUS = ["tara", "leah", "jess", "mia", "zoe", "leo", "dan", "zac"];
const KOKORO = ["af_heart", "af_bella", "am_fenrir", "am_michael", "am_puck", "bf_emma", "bm_george"];
const SAMPLE = `Your phone knows exactly where you are. || a glowing smartphone on a dark desk, a blue location pin floating above it
But how? [pause 0.4] It's listening to clocks in space. || GPS satellites orbiting a night-side Earth, thin light beams to the ground
Thirty satellites, each one shouting the time. || close-up of an atomic clock, glowing digits, macro detail
Your phone hears four of them, and does the math. || four beams converging on a city street from above
That's it. That's GPS. || the blue location pin glowing over a city at night, wide shot`;

function parse(src: string): Scene[] {
  return src.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const [text, visual, image] = l.split("||").map((x) => x.trim());
    return { text, visual: visual || undefined, image_url: image && /^https?:\/\//.test(image) ? image : undefined };
  });
}

function usePoll() {
  const [job, setJob] = useState<Job | null>(null);
  const [lib, setLib] = useState<{ video_url?: string; poster_url?: string | null; results: { id: string; audio?: string | null }[] } | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function poll(id: string) {
    try {
      const j = await api<Job>(`jobs/${id}`);
      setJob(j);
      if (j.library) api(`library/${id}`).then(setLib).catch(() => {});
      if (["queued", "running"].includes(j.status) || (j.status === "done" && !j.library)) timer.current = setTimeout(() => poll(id), 2000);
    } catch (e) {
      setErr((e as Error).message);
      timer.current = setTimeout(() => poll(id), 5000);
    }
  }
  const start = (j: Job) => { setLib(null); setErr(""); setJob(j); timer.current = setTimeout(() => poll(j.id), 1000); };
  const busy = !!job && (["queued", "running"].includes(job.status) || (job.status === "done" && !job.library));
  return { job, lib, err, setErr, start, busy };
}

/** Script -> a finished, captioned, mastered video: one voiced line and one shot per scene. */
function ScriptVideo({ mine, settings }: { mine: MyVoice[]; settings: Settings | null }) {
  const { status } = useStatus();
  const [script, setScript] = useState(SAMPLE);
  const [engine, setEngine] = useState("qwen");
  const [voice, setVoice] = useState("female");
  const [platform, setPlatform] = useState("shorts");
  const [visuals, setVisuals] = useState("images");
  const [look, setLook] = useState("tech");
  const [caps, setCaps] = useState("auto");
  const [transition, setTransition] = useState("fade");
  const [takes, setTakes] = useState(1);
  const [music, setMusic] = useState<File | null>(null);
  const [musicLufs, setMusicLufs] = useState(-28);
  const [label, setLabel] = useState("");
  const [shots, setShots] = useState<Record<number, File>>({});
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const loaded = useRef(false);
  const { job, lib, err, setErr, start, busy } = usePoll();

  useEffect(() => {
    if (!settings || loaded.current) return;
    loaded.current = true;
    setEngine(settings.engine); setVoice(settings.voice); setPlatform(settings.platform === "raw" ? "youtube" : settings.platform);
    setVisuals(settings.visuals); setLook(settings.visual_style); setCaps(settings.captions_look); setTransition(settings.transition);
    setTakes(settings.takes); setMusicLufs(settings.music_lufs);
    try { const s = JSON.parse(localStorage.getItem("vb-studio") || "{}"); if (s.script) setScript(s.script); } catch { /* private window */ }
  }, [settings]);
  useEffect(() => { if (loaded.current) try { localStorage.setItem("vb-studio", JSON.stringify({ script })); } catch { /* ignore */ } }, [script]);

  const scenes = useMemo(() => parse(script), [script]);
  const voices = useMemo(() => {
    if (engine === "orpheus") return ORPHEUS.map((v) => [v, v] as const);
    if (engine === "kokoro") return KOKORO.map((v) => [v, v] as const);
    return [...mine.map((m) => [m.name, `${m.label} (your voice)`] as const), ["female", "female preset"] as const, ["male", "male preset"] as const];
  }, [engine, mine]);
  useEffect(() => { if (!voices.some(([v]) => v === voice)) setVoice(voices[0]?.[0] ?? "female"); }, [voices, voice]);

  const chars = scenes.reduce((s, x) => s + x.text.length, 0);
  const speech = chars / 14.5 + scenes.length * 0.3 + 1;
  const aspect = PLATFORMS.find(([p]) => p === platform)?.[2] ?? "16:9";
  const perScene = visuals === "clips" ? 150 : 4;
  const estS = chars * 0.05 * takes + scenes.length * perScene + speech * 0.8 + 90;

  async function go() {
    setErr("");
    try {
      const body: Record<string, unknown> = { kind: "story", engine, voice, platform, visuals, visual_style: look, transition, takes,
        label: label || scenes[0]?.text.slice(0, 60), music_lufs: musicLufs, ...(caps !== "auto" ? { captions_look: caps } : {}) };
      const list: Record<string, unknown>[] = scenes.map((s) => ({ ...s }));
      const files = Object.entries(shots).filter(([i]) => +i < list.length);
      const total = files.length + (music ? 1 : 0);
      let done = 0;
      if (total) setUpFrac(0);
      for (const [i, f] of files) {
        list[+i].image_key = await uploadFile(f, f.name.replace(/[^A-Za-z0-9._-]/g, "_") || "shot.png", (x) => setUpFrac((done + x) / total));
        done++;
      }
      if (music) body.music_key = await uploadFile(music, music.name.replace(/[^A-Za-z0-9._-]/g, "_") || "music.mp3", (x) => setUpFrac((done + x) / total));
      setUpFrac(null);
      body.scenes = list;
      start(await api<Job>("jobs", { body }));
    } catch (e) {
      setUpFrac(null);
      setErr((e as Error).message);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h2><FilmSlate size={18} weight="duotone" /> Script → video</h2><span className="dim tiny">voice, pictures, captions, music, one click</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>
        One scene per line: <span className="mono">what you say || what we see</span>. Leave out the visual and one is imagined from the line.
        Add a third part with an image link to use your own picture. <span className="mono">[pause 0.5]</span> works here too.
      </p>
      <textarea value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} style={{ minHeight: 170 }} />
      <div className="dim small mono" style={{ margin: "8px 0 4px" }}>{scenes.length} scene{scenes.length === 1 ? "" : "s"} · ≈ {fmtS(speech)} video · {aspect}</div>
      {scenes.length > 0 && (
        <table className="table small" style={{ marginTop: 6 }}><tbody>
          {scenes.map((s, i) => (
            <tr key={i}>
              <td className="mono dim" style={{ width: 34 }}>{i + 1}</td>
              <td>{s.text}<div className="dim tiny">{s.image_url ? "your image (link)" : shots[i] ? `your image: ${shots[i].name}` : s.visual ? `shot: ${s.visual}` : "shot: imagined from the line"}</div></td>
              <td style={{ width: 40 }}>
                <label className="icon-btn" title="Use your own picture for this scene"><ImageSquare size={16} />
                  <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; setShots((x) => { const n = { ...x }; if (f) n[i] = f; else delete n[i]; return n; }); }} />
                </label>
              </td>
            </tr>
          ))}
        </tbody></table>
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 14 }}>
        <div className="field" style={{ margin: 0 }}><label className="f">Voice engine</label>
          <select value={engine} onChange={(e) => setEngine(e.target.value)}>{ENGINES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field" style={{ margin: 0 }}><label className="f">Voice</label>
          <select value={voice} onChange={(e) => setVoice(e.target.value)}>{voices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field" style={{ margin: 0 }}><label className="f">Captions</label>
          <select value={caps} onChange={(e) => setCaps(e.target.value)}>{CAPS.map(([v, l]) => <option key={v} value={v}>{l}{v === "auto" ? (aspect === "9:16" ? " (bold pop)" : " (clean)") : ""}</option>)}</select></div>
        <div className="field" style={{ margin: 0 }}><label className="f">Best of</label>
          <div className="seg">{[1, 2, 3].map((n) => <button key={n} className={takes === n ? "on" : ""} disabled={engine === "kokoro" && n > 1} onClick={() => setTakes(n)}>{n}×</button>)}</div></div>
      </div>

      <label className="f" style={{ marginTop: 14 }}>Publish for</label>
      <div className="chips">{PLATFORMS.map(([p, l, a]) => <button key={p} className={`chip ${platform === p ? "on" : ""}`} onClick={() => setPlatform(p)}>{l} <span className="dim tiny">{a}</span></button>)}</div>

      <label className="f" style={{ marginTop: 14 }}>Look</label>
      <div className="chips">{LOOKS.map(([v, l]) => <button key={v} className={`chip ${look === v ? "on" : ""}`} onClick={() => setLook(v)}>{l}</button>)}</div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 14 }}>
        <div>
          <label className="f">Pictures</label>
          <div className="seg">
            <button className={visuals === "images" ? "on" : ""} onClick={() => setVisuals("images")}>Stills + camera motion</button>
            <button className={visuals === "clips" ? "on" : ""} onClick={() => setVisuals("clips")}>Animated clips</button>
          </div>
          <div className="dim tiny" style={{ marginTop: 5 }}>{visuals === "images" ? "Seconds per scene. Smooth Ken Burns moves, cross-fades." : "Each still animated by Wan 2.2: a few minutes per scene."}</div>
        </div>
        <div>
          <label className="f">Transitions</label>
          <div className="seg">
            <button className={transition === "fade" ? "on" : ""} onClick={() => setTransition("fade")}>Cross-fade</button>
            <button className={transition === "cut" ? "on" : ""} onClick={() => setTransition("cut")}>Hard cut</button>
          </div>
        </div>
        <div>
          <label className="f"><MusicNotes size={13} /> Music bed (optional)</label>
          <label className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start", overflow: "hidden" }}>
            <UploadSimple size={14} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{music ? music.name : "Choose a track"}</span>
            <input type="file" accept="audio/*" hidden onChange={(e) => setMusic(e.target.files?.[0] ?? null)} />
          </label>
          {music && <>
            <input type="range" min={-40} max={-18} step={1} value={musicLufs} style={{ ...rangeFill(musicLufs, -40, -18), marginTop: 8 }} onChange={(e) => setMusicLufs(+e.target.value)} />
            <div className="dim tiny">Music level {musicLufs} LUFS · ducks under the voice automatically</div>
          </>}
        </div>
      </div>

      <div className="row between" style={{ marginTop: 16, gap: 10, flexWrap: "wrap" }}>
        <input placeholder="Name this video (optional)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: "1 1 220px" }} />
        <span className="dim small">Ready in ≈ {fmtS(estS)}</span>
        <button className="sig lg" disabled={!scenes.length || busy || upFrac !== null || !status?.online} onClick={go}><Sparkle size={17} weight="fill" />Make the video</button>
      </div>
      {!status?.online && <div className="dim tiny" style={{ marginTop: 6 }}>Needs the GPU worker online.</div>}
      {err && <p className="err" style={{ marginTop: 10 }}>{err}</p>}
      {(job || upFrac !== null) && (
        <div style={{ marginTop: 14 }}>
          <JobProgress job={job} kind="video" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} onCancel={job ? () => api(`jobs/${job.id}/cancel`, { body: {} }) : undefined} />
        </div>
      )}
      {job?.library && lib?.video_url && (
        <div className="video-wrap" style={{ marginTop: 14 }}>
          <video className="vplayer" src={lib.video_url} poster={lib.poster_url ?? undefined} controls playsInline
            style={{ aspectRatio: job.video ? `${job.video.width}/${job.video.height}` : undefined, maxHeight: 640 }} />
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <a className="btn sm" href={fileUrl(job.id, "video.mp4", `${(label || "video").replace(/[^A-Za-z0-9._-]/g, "_")}.mp4`)}><DownloadSimple size={14} weight="bold" />MP4</a>
              <a className="btn ghost sm" href={fileUrl(job.id, "voiceover.wav", "voiceover.wav")}>voiceover.wav</a>
              {job.subs && <a className="btn ghost sm" href={fileUrl(job.id, "subtitles.srt", "subtitles.srt")}>.srt</a>}
              <Link className="btn ghost sm" href={`/library#${job.id}`}>Library</Link>
            </div>
            {job.similarity != null && <span className={`pill ${simClass(job.similarity)}`}>voice match {pct(job.similarity)}</span>}
            {(job.scenes ?? []).map((s) => (
              <div key={s.id} className="small"><span className="mono dim">{fmtS(s.start)}</span> {s.text}{s.match != null && s.match < 0.9 ? <span className="pill warn" style={{ marginLeft: 6 }}>match {pct(s.match)}</span> : null}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Any recording -> studio quality: noise and room echo out, the detail a cheap mic loses restored, mastered. */
function CleanUp({ settings }: { settings: Settings | null }) {
  const { status } = useStatus();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState("enhance");
  const [strength, setStrength] = useState(0.6);
  const [platform, setPlatform] = useState("youtube");
  const [subtitles, setSubtitles] = useState(false);
  const [upFrac, setUpFrac] = useState<number | null>(null);
  const { job, lib, err, setErr, start, busy } = usePoll();
  useEffect(() => { if (settings) setPlatform(settings.platform); }, [settings]);

  async function go() {
    if (!file) return;
    setErr("");
    try {
      setUpFrac(0);
      const key = await uploadFile(file, file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "recording.wav", setUpFrac);
      setUpFrac(null);
      start(await api<Job>("jobs", { body: { kind: "clean", source_key: key, platform, subtitles, params: { mode, strength }, label: `Clean-up · ${file.name.slice(0, 50)}` } }));
    } catch (e) {
      setUpFrac(null);
      setErr((e as Error).message);
    }
  }
  const r = job?.results[0];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2><Waveform size={18} weight="duotone" /> Studio clean-up</h2><span className="dim tiny">bad mic in, studio sound out</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>
        Upload any recording of yourself (laptop mic, phone, a noisy room, or a video). AI removes the noise and room echo, rebuilds the
        crisp detail a cheap mic loses, then masters it for your platform. The length stays the same, so it drops back onto your edit.
      </p>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
        <div className="field" style={{ margin: 0 }}><label className="f">Recording (audio or video)</label>
          <label className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start", overflow: "hidden" }}>
            <UploadSimple size={14} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? file.name : "Choose a file"}</span>
            <input type="file" accept="audio/*,video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label></div>
        <div className="field" style={{ margin: 0 }}><label className="f">Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="enhance">Studio: remove noise + restore detail</option><option value="denoise">Denoise only: keep my exact tone</option>
          </select></div>
        <div className="field" style={{ margin: 0 }}><label className="f">Publish for</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {[...PLATFORMS.map(([p, l]) => [p, l] as const), ["raw", "Raw (no mastering)"] as const].map(([p, l]) => <option key={p} value={p}>{l}</option>)}
          </select></div>
      </div>
      {mode === "enhance" && (
        <div className="field" style={{ margin: "12px 0 0" }}>
          <div className="row between"><label className="f" style={{ margin: 0 }}>Clean-up strength</label><span className="mono small">{strength.toFixed(2)}</span></div>
          <input type="range" min={0.1} max={1} step={0.05} value={strength} style={rangeFill(strength, 0.1, 1)} onChange={(e) => setStrength(+e.target.value)} />
          <div className="dim tiny">Higher for noisy rooms and echo; lower keeps more of the original character.</div>
        </div>
      )}
      <div className="row between" style={{ marginTop: 12 }}>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} />Also make subtitles</label>
        <button className="sig" onClick={go} disabled={!file || busy || upFrac !== null || !status?.online}><MagicWand size={16} weight="bold" />Clean it up</button>
      </div>
      {err && <p className="err" style={{ marginTop: 10 }}>{err}</p>}
      {(job || upFrac !== null) && <div style={{ marginTop: 14 }}><JobProgress job={job} kind="tts" uploading={upFrac !== null} uploadFrac={upFrac ?? 0} onCancel={job ? () => api(`jobs/${job.id}/cancel`, { body: {} }) : undefined} /></div>}
      {job?.library && r && (
        <div style={{ marginTop: 12 }}>
          {r.enhanced === false && <div className="tiny" style={{ color: "var(--warn)", marginBottom: 6 }}><WarningCircle size={12} /> The studio model couldn&apos;t run, so the standard clean-up was used (see the warnings above).</div>}
          <LineRow jobId={job.id} line={r} audio={lib?.results[0]?.audio ?? r.url} slug="clean" />
        </div>
      )}
    </div>
  );
}

export default function Studio() {
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {});
    api<Settings>("settings").then(setSettings).catch(() => setSettings(null));
  }, []);
  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Studio</div>
          <h1>Script in, <em>video out.</em></h1>
          <p className="sub">Write the scenes; get back a voiced, captioned, mastered video for YouTube, Shorts, Reels or TikTok. Or rescue a recording from a bad mic.</p>
        </div>
        <Link className="btn ghost sm" href="/settings">Defaults</Link>
      </div>
      <ScriptVideo mine={mine} settings={settings} />
      <CleanUp settings={settings} />
      <div style={{ height: 30 }} />
    </>
  );
}
