"use client";
import { ArrowRight, Broom, ClosedCaptioning, FilmSlate, FilmStrip, Fire, Kanban, Microphone, Power, Terminal, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, api, fmtS, pct, type Job } from "./api";
import { CassetteArt, VoiceGlyph } from "./art";
import { Info } from "./Info";
import { useDialog } from "./Dialog";
import FetchBar, { MODEL_NAMES } from "./FetchBar";
import { fmtUptime, useStatus } from "./Shell";

type Lib = {
  id: string; kind?: string; engine: string; voice: string; label?: string; created: number; match?: number | null; subs?: unknown;
  results: { duration: number }[]; video?: { duration: number }; poster_url?: string | null;
};
const libSeconds = (j: Lib) => j.video?.duration ?? j.results.reduce((a, r) => a + r.duration, 0);

const ENGINES: Record<string, { role: string; lang: string; mem: string; group: "voice" | "visual" }> = {
  orpheus: { role: "The most human voice. Laughs, sighs, breath.", lang: "English", mem: "≈10 GB", group: "voice" },
  qwen: { role: "Your own voice, cloned from 20 seconds.", lang: "10 languages", mem: "≈6 GB", group: "voice" },
  chatterbox: { role: "Emotion dial and zero-shot voice cloning.", lang: "23 languages", mem: "≈4 GB", group: "voice" },
  kokoro: { role: "Instant drafts for timing, on the CPU.", lang: "9 languages", mem: "CPU", group: "voice" },
  whisper: { role: "Word-timed subtitles from any audio.", lang: "99 languages", mem: "≈4 GB", group: "voice" },
  zimage: { role: "Photoreal images in about 2 s. Commercial use OK.", lang: "1K images", mem: "≈22 GB", group: "visual" },
  qwenimage: { role: "2K images, sharp text, edits and transparent PNGs. Non-commercial.", lang: "2K images · edit", mem: "≈33 GB", group: "visual" },
};
const CLIP_UNITS: Record<string, number> = { wan: 4 * 121 * 0.9, ltx: 8 * 121 * 0.59, wan14: 4 * 81 * 0.4 }; // steps x frames x megapixels for a 5 s clip

function speed(name: string, rate?: number) {
  if (!rate) return "—";
  if (CLIP_UNITS[name]) return `≈${fmtS(rate * CLIP_UNITS[name] + 25)} per 5 s clip`;
  const rtf = name === "whisper" ? rate : rate * 14.5; // compute seconds per second of audio
  return rtf < 1 ? `${(1 / rtf).toFixed(1)}× realtime` : `${rtf.toFixed(1)}s / audio s`;
}
const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const greeting = (h: number) => (h < 5 ? "Late session" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Late session");

export default function Overview() {
  const { status: st, refresh } = useStatus();
  const { toast, confirm } = useDialog();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [lib, setLib] = useState<Lib[] | null>(null);
  const [busy, setBusy] = useState("");
  const [hello, setHello] = useState("Welcome back");
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  async function showLogs(name: string) {
    setLogs({ name, text: "Loading…" });
    const r = await api<{ text: string }>(`logs/${name}`).catch((e) => ({ text: String(e.message) }));
    setLogs({ name, text: r.text });
  }

  useEffect(() => { setHello(greeting(new Date().getHours())); api<{ jobs: Lib[] }>("library").then((l) => setLib(l.jobs)).catch(() => setLib([])); }, []);
  useEffect(() => {
    if (!st?.online) return;
    const load = () => api<{ jobs: Job[] }>("jobs").then((j) => setJobs(j.jobs)).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [st?.online]);

  async function engine(name: string, action: "load" | "unload") {
    setBusy(name);
    await api(`engines/${name}/${action}`, { body: {} }).catch((e) => toast(e.message, "bad"));
    await refresh();
    setBusy("");
  }

  async function forget(name: string, gb: number) {
    if (!(await confirm({ title: `Delete ${name}'s weights?`, body: `Frees ${gb} GB on the Colab disk. They download again the next time ${name} is used.`, confirm: `Free ${Math.round(gb)} GB`, danger: true }))) return;
    setBusy(name);
    await api(`engines/${name}/forget`, { body: {} }).then(() => toast(`Freed ${Math.round(gb)} GB`, "ok")).catch((e) => toast(e.message, "bad"));
    await refresh();
    setBusy("");
  }

  const vram = st?.gpu?.total_gb ? st.gpu.used_gb / st.gpu.total_gb : 0;
  const audio = (lib ?? []).filter((j) => j.kind !== "video").reduce((s, j) => s + libSeconds(j), 0);
  const active = jobs.filter((j) => ["queued", "running"].includes(j.status));
  const warm = Object.entries(st?.engines ?? {}).filter(([, s]) => s === "ready").map(([n]) => n);
  const gpu = st?.gpu?.name?.replace("NVIDIA ", "") ?? "GPU";
  const sentence = !st ? "Connecting to your studio…"
    : !st.online ? (st.reason === "heartbeat stale" ? "Your Colab GPU is asleep. Run the notebook and this page wakes up with it." : "Waiting for the Colab worker to check in.")
    : active.length ? `${active.length} take${active.length > 1 ? "s" : ""} in the booth right now.`
    : warm.length ? `Your ${gpu} is warm. ${listJoin(warm.map((w) => w[0].toUpperCase() + w.slice(1)))} ${warm.length > 1 ? "are" : "is"} loaded and ready to record.`
    : `Your ${gpu} is online. Engines load on first use.`;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Studio</div>
          <h1>{hello.split(" ").slice(0, -1).join(" ")} <em>{hello.split(" ").slice(-1)[0]}.</em></h1>
          <p className="sub">{sentence}</p>
        </div>
        <div className="row">
          <Link href="/subtitles" className="btn ghost"><ClosedCaptioning size={16} />Subtitle a file</Link>
          <Link href="/generate" className="btn sig"><Microphone size={16} weight="bold" />New voiceover</Link>
        </div>
      </div>

      <div className="strip">
        <div className="strip-cell wide">
          <span className="k">GPU memory</span>
          <span className="v">{st?.gpu ? <>{st.gpu.used_gb}<small> / {st.gpu.total_gb} GB</small></> : "—"}</span>
          <span className="meter"><i style={{ width: `${Math.round(vram * 100)}%` }} /></span>
        </div>
        <div className="strip-cell"><span className="k">GPU</span><span className="v">{st?.gpu?.name?.replace("NVIDIA ", "").split("-")[0] ?? "—"}</span></div>
        <div className="strip-cell"><span className="k">Up</span><span className="v">{st?.online ? fmtUptime(st.uptime_s) : "—"}</span></div>
        <div className="strip-cell"><span className="k">In the booth</span><span className="v">{st?.online ? active.length : "—"}</span></div>
        <div className="strip-cell"><span className="k">Library</span><span className="v">{lib?.length ?? "…"}</span></div>
        <div className="strip-cell"><span className="k">Recorded</span><span className="v">{fmtS(audio)}</span></div>
      </div>

      {active.length > 0 && (
        <section className="sec">
          <h2><span className="dot warn" />In the booth</h2>
          {active.map((j) => (
            <div key={j.id} style={{ marginBottom: 14 }}>
              <div className="row between small"><b>{j.label || `${j.engine} · ${j.voice}`}</b><span className="dim mono tiny">{j.progress.stage} · {j.progress.done}/{j.progress.total} · ~{fmtS(j.progress.eta_s)} left</span></div>
              <div className="bar thin live" style={{ marginTop: 8 }}><i style={{ width: `${Math.max(3, j.progress.fraction * 100)}%` }} /></div>
            </div>
          ))}
        </section>
      )}

      <section className="sec">
        <h2>Engines <Info>Engines load on first use and swap out when GPU memory runs short. Voice and image engines take turns on the GPU; a model that steps aside is parked in RAM and comes back in seconds.</Info></h2>
        <div className="erows">
          {Object.keys(ENGINES).map((name) => {
            const s = st?.engines?.[name];
            const loading = s === "loading" || s === "installing";
            const disk = st?.disk?.weights_gb?.[name];
            return (
              <div key={name} className="erow">
                <span className={`dot ${s === "ready" ? "ok" : s === "parked" ? "park" : loading ? "warn" : s === "error" ? "bad" : "off"}`} />
                <div className="erow-name">
                  <b>{MODEL_NAMES[name] ?? name}</b>
                  <span>{ENGINES[name].role}</span>
                  {st?.fetch?.[name] && <FetchBar f={st.fetch[name]} name={name} compact />}
                  {st?.engine_errors?.[name] && <span className="err tiny">{st.engine_errors[name].slice(0, 140)}</span>}
                </div>
                <span className="erow-meta mono">{ENGINES[name].lang}</span>
                <span className="erow-meta mono">{ENGINES[name].mem}</span>
                <span className="erow-state mono">{s === "ready" ? "warm" : s === "parked" ? "in RAM" : s ?? "—"}</span>
                <span className="erow-act">
                  {s === "ready" || s === "parked"
                    ? <button className="icon-btn" title="Unload" disabled={busy === name} onClick={() => engine(name, "unload")}><Power size={15} /></button>
                    : <button className="icon-btn" title={loading ? "Loading…" : "Warm up"} disabled={!st?.online || busy === name || loading} onClick={() => engine(name, "load")}><Fire size={15} weight="duotone" /></button>}
                  <button className="icon-btn" title="Logs" disabled={!st?.online} onClick={() => showLogs(name)}><Terminal size={15} /></button>
                  {disk ? <button className="icon-btn" title={`Free ${Math.round(disk)} GB of disk (downloads again on next use)`} disabled={!st?.online || s === "ready" || loading} onClick={() => forget(name, disk)}><Broom size={15} /></button> : null}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="sec">
        <div className="row between"><h2>Recent takes</h2><Link href="/library" className="btn quiet sm">Open library <ArrowRight size={14} /></Link></div>
        {lib === null && <div className="dim small">Loading…</div>}
        {lib?.length === 0 && (
          <div className="empty"><CassetteArt /><b>Nothing recorded yet</b><span>Your first take will show up here.</span><Link href="/generate" className="btn sig sm">Record a voiceover</Link></div>
        )}
        {(lib ?? []).slice(0, 6).map((j) => (
          <Link key={j.id} href={`/library#${j.id}`} className="list-row">
            {j.kind === "video"
              ? <span className="thumb">{j.poster_url ? <img src={j.poster_url} alt="" /> : <FilmStrip size={20} weight="duotone" />}</span>
              : j.kind === "transcribe" ? <span className="thumb" style={{ color: "var(--glacier)" }}><ClosedCaptioning size={20} weight="duotone" /></span>
              : <VoiceGlyph name={j.voice || j.engine} size={40} />}
            <div style={{ minWidth: 0 }}>
              <div className="t1">{j.label || <span className="quote-title">“{(j.results as { text?: string }[])[0]?.text?.replace(/<[^>]+>/g, "").slice(0, 60) ?? j.id}”</span>}</div>
              <div className="t2">{j.kind === "video" ? "Video" : j.kind === "transcribe" ? "Subtitles" : `${j.engine} · ${j.voice}`} · {ago(j.created)}</div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <span className="mono small dim">{fmtS(libSeconds(j))}</span>
              {j.match != null && <span className={`pill ${j.match >= 0.95 ? "ok" : "warn"}`}>{pct(j.match)}</span>}
            </div>
          </Link>
        ))}
      </section>

      {logs && (
        <>
          <div className="scrim" onClick={() => setLogs(null)} />
          <aside className="drawer" style={{ width: "min(880px, calc(100vw - 20px))" }}>
            <div className="row between">
              <div><div className="eyebrow">Engine logs</div><h3 style={{ font: "400 30px var(--display)", textTransform: "capitalize" }}>{logs.name}</h3></div>
              <div className="row"><button className="ghost sm" onClick={() => showLogs(logs.name)}>Refresh</button><button className="icon-btn" onClick={() => setLogs(null)} aria-label="Close"><X size={16} /></button></div>
            </div>
            <pre className="card inset mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--ink2)", marginTop: 18 }}>{logs.text}</pre>
          </aside>
        </>
      )}
    </>
  );
}
