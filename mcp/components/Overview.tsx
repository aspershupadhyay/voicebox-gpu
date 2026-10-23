"use client";
import { ArrowRight, Broom, ClosedCaptioning, FilmSlate, FilmStrip, Fire, Kanban, Microphone, Power, Terminal, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, api, fmtS, pct, type Job } from "./api";
import { CassetteArt, EngineArt, LedMeter, VoiceGlyph } from "./art";
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
      <div className="card hero reveal">
        <div className="hl">
          <svg className="ripples" viewBox="-100 -100 200 200" aria-hidden>
            {[30, 50, 70, 90].map((r, i) => <circle key={r} r={r} fill="none" stroke={i === 0 ? "var(--signal)" : "var(--line2)"} strokeOpacity={i === 0 ? 0.5 : 1} />)}
          </svg>
          <div className="eyebrow">Studio overview</div>
          <h1>{hello}<em>.</em></h1>
          <p className="sub">{sentence}</p>
          <div className="row" style={{ marginTop: 22 }}>
            <Link href="/generate" className="btn sig"><Microphone size={16} weight="bold" />New voiceover</Link>
            <Link href="/workspace" className="btn ghost"><Kanban size={16} />Open the board</Link>
            <Link href="/subtitles" className="btn ghost"><ClosedCaptioning size={16} />Subtitle a file</Link>
          </div>
        </div>
        <div className="hr">
          <div>
            <div className="row between" style={{ marginBottom: 10 }}><span className="label">GPU memory</span><span className="mono small">{st?.gpu ? `${st.gpu.used_gb} / ${st.gpu.total_gb} GB` : "—"}</span></div>
            <LedMeter value={vram} segments={28} label="GPU memory" />
            <div className="row between tiny dim" style={{ marginTop: 8 }}><span>{st?.gpu?.name ?? "No GPU"}</span><span>{Math.round(vram * 100)}%</span></div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div><div className="label">Uptime</div><div className="mono" style={{ fontSize: 18, marginTop: 4 }}>{st?.online ? fmtUptime(st.uptime_s) : "—"}</div></div>
            <div><div className="label">Worker</div><div className="mono" style={{ fontSize: 18, marginTop: 4 }}>v{st?.version ?? "—"}</div></div>
          </div>
        </div>
        <div className="readouts" style={{ gridColumn: "1 / -1" }}>
          <div><div className="label">In the booth</div><div className="num" style={{ marginTop: 8 }}>{st?.online ? active.length : "—"}<small>{active.length ? `${active.filter((j) => j.status === "running").length} running` : "idle"}</small></div></div>
          <div><div className="label">Library</div><div className="num" style={{ marginTop: 8 }}>{lib?.length ?? "…"}<small>items</small></div></div>
          <div><div className="label">Voice recorded</div><div className="num" style={{ marginTop: 8 }}>{fmtS(audio)}</div></div>
        </div>
      </div>

      {active.length > 0 && (
        <div className="card reveal" style={{ marginBottom: 18 }}>
          <div className="card-head"><h2><span className="dot warn" />In the booth</h2></div>
          {active.map((j) => (
            <div key={j.id} style={{ marginBottom: 14 }}>
              <div className="row between small"><b>{j.label || `${j.engine} · ${j.voice}`}</b><span className="dim mono tiny">{j.progress.stage} · {j.progress.done}/{j.progress.total} · ~{fmtS(j.progress.eta_s)} left</span></div>
              <div className="bar thin live" style={{ marginTop: 8 }}><i style={{ width: `${Math.max(3, j.progress.fraction * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      )}

      {(["voice", "visual"] as const).map((group) => (
        <section key={group}>
          <div className="row between" style={{ margin: "30px 0 14px" }}>
            <h2 style={{ margin: 0 }} className="row">{group === "voice" ? "Voice engines" : "Image engines"}
              {st?.mode === group && <span className="pill ok" style={{ marginLeft: 10 }}>on the GPU</span>}</h2>
            <span className="dim small">{group === "voice"
              ? "Load on first use, swap out when memory runs short, unload after " + (st?.idle_min ?? 10) + " idle minutes."
              : "Only one group holds the GPU: rendering video unloads the voice engines, and the reverse."}</span>
          </div>
          <div className="modules">
            {Object.keys(ENGINES).filter((n) => ENGINES[n].group === group).map((name) => {
              const s = st?.engines?.[name];
              const loading = s === "loading" || s === "installing";
              const disk = st?.disk?.weights_gb?.[name];
              return (
                <div key={name} className={`card module ${s === "ready" ? "ready" : ""}`}>
                  <div className="art"><EngineArt engine={name} live={s === "ready" || loading} /></div>
                  <div className="body">
                    <div className="row between">
                      <span className="name">{MODEL_NAMES[name] ?? name}</span>
                      <span className={`pill ${s === "ready" ? "ok" : loading ? "warn" : s === "error" ? "bad" : ""}`}>{s === "ready" ? "warm" : s ?? "—"}</span>
                    </div>
                    <div className="dim small">{ENGINES[name].role}</div>
                    <div className="spec">
                      <div><span>{group === "voice" ? "speaks" : "makes"}</span><b>{ENGINES[name].lang}</b></div>
                      <div><span>memory</span><b>{ENGINES[name].mem}</b></div>
                      <div><span>on disk</span><b>{disk ? `${disk} GB` : "not yet"}</b></div>
                      <div><span>speed here</span><b>{speed(name, st?.rates?.[name])}</b></div>
                    </div>
                    {st?.fetch?.[name] && <FetchBar f={st.fetch[name]} name={name} compact />}
                    {st?.engine_errors?.[name] && <div className="err tiny">{st.engine_errors[name].slice(0, 140)}</div>}
                    <div className="foot">
                      {s === "ready"
                        ? <button className="ghost sm" disabled={busy === name} onClick={() => engine(name, "unload")}><Power size={14} />Unload</button>
                        : <button className="ghost sm" disabled={!st?.online || busy === name || loading} onClick={() => engine(name, "load")}><Fire size={14} weight="duotone" />{loading ? "Loading…" : "Warm up"}</button>}
                      <button className="quiet sm" disabled={!st?.online} onClick={() => showLogs(name)}><Terminal size={14} />Logs</button>
                      {disk ? <button className="quiet sm" disabled={!st?.online || s === "ready" || loading} title="Delete the downloaded weights to free disk (downloads again on next use)" onClick={() => forget(name, disk)}><Broom size={14} />Free {Math.round(disk)} GB</button> : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <div className="card">
        <div className="card-head"><h2>Recent takes</h2><Link href="/library" className="btn quiet sm">Open library <ArrowRight size={14} /></Link></div>
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
      </div>

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
