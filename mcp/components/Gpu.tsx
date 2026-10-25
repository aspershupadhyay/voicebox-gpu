"use client";
// GPU & engines: start or stop the Colab GPU, what's on it right now, every engine (warm it up, unload it, read its
// logs, free its disk), then the machine, the worker and how each engine has been doing.
import { Broom, Cpu, Fire, Gauge, Power, Terminal, Timer, Waveform, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type Job } from "./api";
import { Info } from "./Info";
import { useDialog } from "./Dialog";
import FetchBar, { MODEL_NAMES } from "./FetchBar";
import GpuCard from "./GpuCard";
import Health from "./Health";
import { fmtUptime, useStatus } from "./Shell";
import { PageHeader, StatCard } from "./ui";

const ENGINES: Record<string, { role: string; lang: string; mem: string }> = {
  orpheus: { role: "The most human voice. Laughs, sighs, breath.", lang: "English", mem: "≈10 GB" },
  qwen: { role: "Your own voice, cloned from 20 seconds.", lang: "10 languages", mem: "≈6 GB" },
  chatterbox: { role: "Emotion dial and zero-shot voice cloning.", lang: "23 languages", mem: "≈4 GB" },
  kokoro: { role: "Instant drafts for timing, on the CPU.", lang: "9 languages", mem: "CPU" },
  whisper: { role: "Word-timed subtitles from any audio.", lang: "99 languages", mem: "≈4 GB" },
  zimage: { role: "Photoreal images in about 2 s. Commercial use OK.", lang: "1K images", mem: "≈22 GB" },
  qwenimage: { role: "2K images, sharp text, edits and transparent PNGs. Non-commercial.", lang: "2K images · edit", mem: "≈33 GB" },
};
const STATE: Record<string, [string, string]> = { ready: ["Warm", "ok"], parked: ["In RAM", "blue"], loading: ["Loading", "warn"], installing: ["Installing", "warn"], busy: ["Busy", "warn"], error: ["Error", "bad"], idle: ["Off", ""] };

export default function Gpu() {
  const { status: st, refresh } = useStatus();
  const { toast, confirm } = useDialog();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState("");
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  async function showLogs(name: string) {
    setLogs({ name, text: "Loading…" });
    const r = await api<{ text: string }>(`logs/${name}`).catch((e) => ({ text: String(e.message) }));
    setLogs({ name, text: r.text });
  }
  useEffect(() => {
    if (!st?.online) return;
    const load = () => api<{ jobs: Job[] }>("jobs").then((j) => setJobs(j.jobs)).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [st?.online]);
  useEffect(() => {
    if (!logs) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setLogs(null);
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [logs]);

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
  const active = jobs.filter((j) => ["queued", "running"].includes(j.status));
  const warm = Object.values(st?.engines ?? {}).filter((s) => s === "ready").length;
  const gpu = st?.gpu?.name?.replace("NVIDIA ", "");

  return (
    <>
      <PageHeader title="GPU & engines" sub={!st ? "Checking on the GPU…" : !st.online ? (st.reason === "heartbeat stale" ? "The Colab GPU stopped. Start it below." : "The GPU is off. Start it below; engines load on first use.") : `${gpu ?? "GPU"} is on with ${warm} engine${warm === 1 ? "" : "s"} warm.`} />

      <div className="stats-row">
        <StatCard icon={<Gauge size={17} weight="bold" />} value={st?.gpu ? <>{st.gpu.used_gb}<small>/ {st.gpu.total_gb} GB</small></> : "—"} label="GPU memory in use">
          <div className="meter-line"><i style={{ width: `${Math.round(vram * 100)}%` }} /></div>
        </StatCard>
        <StatCard icon={<Cpu size={17} weight="bold" />} value={st?.online ? gpu?.split("-")[0] ?? "GPU" : "Off"} label={st?.mode ? { voice: "Voice mode", visual: "Image mode", idle: "Idle · GPU free", mixed: "Switching" }[st.mode] ?? st.mode : "GPU"} />
        <StatCard icon={<Timer size={17} weight="bold" />} value={st?.online ? fmtUptime(st.uptime_s) : "—"} label="Up for" />
        <StatCard icon={<Waveform size={17} weight="bold" />} value={st?.online ? active.length : "—"} label={st?.queue ? `Jobs running · ${st.queue} queued` : "Jobs running"} />
      </div>

      <GpuCard />

      <section className="section">
        <div className="section-h"><h2>Engines <Info label="Engines">Engines load on first use and swap out when GPU memory runs short. Voice and image engines take turns on the GPU; a model that steps aside is parked in RAM and comes back in seconds.</Info></h2></div>
        <div className="erows">
          {Object.keys(ENGINES).map((name) => {
            const s = st?.engines?.[name];
            const loading = s === "loading" || s === "installing";
            const disk = st?.disk?.weights_gb?.[name];
            const [label, tone] = STATE[s ?? "idle"] ?? [s ?? "Off", ""];
            return (
              <div key={name} className="erow">
                <span className={`dot ${s === "ready" ? "ok" : s === "parked" ? "park" : loading ? "warn" : s === "error" ? "bad" : "off"}`} aria-hidden />
                <div className="erow-name">
                  <b>{MODEL_NAMES[name] ?? name}</b>
                  <span>{ENGINES[name].role}</span>
                  {st?.fetch?.[name] && <FetchBar f={st.fetch[name]} name={name} compact />}
                  {st?.engine_errors?.[name] && <span className="err tiny" style={{ margin: "4px 0 0" }}>{st.engine_errors[name].slice(0, 140)}</span>}
                </div>
                <span className="erow-meta">{ENGINES[name].lang}</span>
                <span className="erow-meta">{ENGINES[name].mem}</span>
                <span><span className={`pill ${tone}`}>{st?.online ? label : "Off"}</span></span>
                <span className="erow-act">
                  {s === "ready" || s === "parked"
                    ? <button className="ghost xs" disabled={busy === name} onClick={() => engine(name, "unload")}><Power size={13} />Unload</button>
                    : <button className="ghost xs" disabled={!st?.online || busy === name || loading} onClick={() => engine(name, "load")}><Fire size={13} />{loading ? "Loading…" : "Warm up"}</button>}
                  <button className="icon-btn sm" aria-label={`${MODEL_NAMES[name] ?? name} logs`} title="Logs" disabled={!st?.online} onClick={() => showLogs(name)}><Terminal size={15} /></button>
                  {disk ? <button className="icon-btn sm" aria-label={`Free ${Math.round(disk)} GB of disk used by ${name}`} title={`Free ${Math.round(disk)} GB of disk (downloads again on next use)`} disabled={!st?.online || s === "ready" || loading} onClick={() => forget(name, disk)}><Broom size={15} /></button> : null}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section">
        <div className="section-h"><h2>Machine &amp; worker</h2></div>
        <Health />
      </section>

      {logs && (
        <>
          <div className="scrim" onClick={() => setLogs(null)} />
          <aside className="drawer" role="dialog" aria-label={`${logs.name} logs`} style={{ width: "min(880px, calc(100vw - 16px))" }}>
            <div className="row between">
              <div><div className="label">Engine logs</div><h2 style={{ fontSize: 20, textTransform: "capitalize" }}>{logs.name}</h2></div>
              <div className="row" style={{ gap: 6 }}><button className="ghost sm" onClick={() => showLogs(logs.name)}>Refresh</button><button className="icon-btn" onClick={() => setLogs(null)} aria-label="Close logs"><X size={16} /></button></div>
            </div>
            <pre className="card inset mono" style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--ink2)", marginTop: 16 }}>{logs.text}</pre>
          </aside>
        </>
      )}
    </>
  );
}
