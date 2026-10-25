"use client";
// The Colab GPU from the app: connect once with Google, then Start / Stop, the live compute-unit balance, and
// phone reminders (hourly, low balance, idle auto-stop). Server side: lib/colab.ts.
import { ArrowSquareOut, Bell, Lightning, Play, Stop } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { useStatus } from "./Shell";

type Usage = { balance: number; rate: number; assignments: number; at: number };
type Config = { gpu: string; idle_stop_min: number; ntfy_topic: string | null; remind_hours: number; low_units: number;
  high_ram: boolean; voice_gpu: string; heavy_gpu: string; rates: Record<string, number> };
type Session = { endpoint: string; gpu: string; started: number; last_active?: number; stopped?: number; stop_reason?: string; usage?: Usage | null };
type ColabStatus = { connected: boolean; email?: string | null; usage?: Usage | { error: string }; runtimes?: { endpoint: string; accelerator: string; high_ram: boolean }[] | { error: string };
  session: Session | null; config: Config };
const GPUS = [["A100", "A100 · 40-80 GB · fastest training"], ["L4", "L4 · 24 GB · cheapest, voice is fine"], ["H100", "H100 · 80 GB"], ["T4", "T4 · 16 GB · no Qwen fine-tune"], ["G4", "G4"]] as const;
// as lib/colab.ts rateKey: L4 has one shape, the others are measured per standard / high-RAM machine
const rateKey = (gpu: string, hm: boolean) => `${gpu}${hm && gpu !== "L4" ? " high RAM" : ""}`;
const dur = (ms: number) => { const m = Math.round(ms / 60_000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

export default function GpuCard() {
  const { status, refresh } = useStatus();
  const { toast, confirm } = useDialog();
  const [c, setC] = useState<ColabStatus | null>(null);
  const [code, setCode] = useState("");
  const [authing, setAuthing] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(() => { api<ColabStatus>("colab").then(setC).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const usage = c?.usage && !("error" in c.usage) ? c.usage : null;
  const list = c?.runtimes && Array.isArray(c.runtimes) ? c.runtimes : [];
  const s = c?.session && !c.session.stopped ? c.session : null;

  async function act(name: string, fn: () => Promise<unknown>, ok?: string) {
    setErr(""); setBusy(name);
    try { await fn(); if (ok) toast(ok, "ok"); } catch (e) { setErr((e as Error).message); }
    setBusy(""); load(); refresh();
  }
  async function begin() {
    setErr("");
    try {
      const { url } = await api<{ url: string }>("colab/auth", { method: "POST", body: {} });
      window.open(url, "_blank", "noopener");
      setAuthing(true);
    } catch (e) { setErr((e as Error).message); }
  }
  const save = (patch: Partial<Config>) => act("config", () => api("colab/config", { body: patch }));
  const topic = () => `voicebox-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 8)}`;

  if (!c) return <div className="card"><div className="card-head"><h2>GPU</h2></div><p className="dim small" style={{ margin: 0 }}>{err || "Loading…"}</p></div>;

  if (!c.connected) return (
    <div className="card">
      <div className="card-head"><h2>GPU · connect Colab</h2><span className="dim tiny">start and stop the GPU from here, see your compute units</span></div>
      <p className="dim small" style={{ marginTop: 0 }}>Sign in once with the Google account that has your Colab plan. It uses the same sign-in as Google&apos;s official Colab CLI;
        the token is stored encrypted on this server and only used to start, stop and read your Colab runtimes and balance.</p>
      {!authing ? <button onClick={begin}><Lightning size={14} weight="fill" /> Connect Colab</button> : (
        <div className="stack" style={{ gap: 8 }}>
          <span className="small">A Google tab opened. Approve it, copy the code Google shows, and paste it here:</span>
          <div className="row" style={{ gap: 8 }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="4/0A…" style={{ flex: 1 }} autoFocus />
            <button disabled={!code.trim() || !!busy} onClick={() => act("connect", async () => { await api("colab/connect", { body: { code } }); setAuthing(false); setCode(""); }, "Colab connected")}>Connect</button>
          </div>
          <button className="ghost xs" style={{ alignSelf: "flex-start" }} onClick={begin}>Open the Google page again</button>
        </div>
      )}
      {err && <p className="err" style={{ margin: "8px 0 0" }}>{err}</p>}
    </div>
  );

  const left = usage && usage.rate > 0 ? usage.balance / usage.rate : null;
  const rate = (g: string) => { const r = c.config.rates?.[rateKey(g, c.config.high_ram)]; return r ? ` · ${r.toFixed(2)} units/h` : ""; };
  const startWith = (body: Record<string, unknown>) => act("start", () => api("colab/start", { body }), "GPU starting: the worker comes online in a few minutes");
  return (
    <div className="card">
      <div className="card-head"><h2>GPU</h2><span className="dim tiny">{c.email ?? "Colab connected"}</span></div>
      <div className="row" style={{ gap: 18, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div><div className="tiny dim">Compute units left</div><div style={{ fontSize: 28, fontWeight: 700 }}>{usage ? usage.balance.toFixed(1) : "—"}</div></div>
        <div><div className="tiny dim">Burning now</div><div className="mono">{usage ? `${usage.rate.toFixed(2)} / h` : "—"}</div></div>
        <div><div className="tiny dim">At this rate</div><div className="mono">{left != null ? `${left.toFixed(1)} h left` : usage ? "nothing running" : "—"}</div></div>
        {s && <div><div className="tiny dim">This session</div><div className="mono">{s.gpu} · {dur(Date.now() - s.started)}{s.last_active ? ` · idle ${dur(Date.now() - s.last_active)}` : ""}</div></div>}
      </div>
      {c.usage && "error" in c.usage && <p className="err small">{c.usage.error}</p>}

      <div className="stack" style={{ gap: 8, padding: "12px 0", borderTop: "1px solid var(--line)", marginTop: 12 }}>
        {list.length ? list.map((r) => (
          <div key={r.endpoint} className="row between small" style={{ gap: 8 }}>
            <span><span className={`dot ${status?.online ? "ok" : "warn"}`} style={{ marginRight: 6 }} /><b>{r.accelerator}</b> runtime{r.high_ram ? " · high RAM" : ""}
              {c.config.rates?.[rateKey(r.accelerator, r.high_ram)] ? <span className="dim"> · {c.config.rates[rateKey(r.accelerator, r.high_ram)].toFixed(2)} units/h</span> : null}
              <span className="dim"> · {status?.online ? "worker online" : "worker starting (3-8 min)…"}</span></span>
            <button className="ghost sm" disabled={!!busy} onClick={async () => { if (await confirm({ title: `Stop the ${r.accelerator} runtime?`, body: "Jobs on it stop and billing ends now. Models re-download on the next start.", confirm: "Stop", danger: true })) act("stop", () => api("colab/stop", { body: { endpoint: r.endpoint } }), "GPU stopped"); }}>
              <Stop size={13} weight="fill" /> Stop</button>
          </div>
        )) : (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button disabled={!!busy} onClick={() => startWith({ purpose: "voice" })} title="Voiceovers, subtitles, clean-up, practice takes: the voice engines are sized to fit a 24 GB card">
                <Play size={14} weight="fill" /> {busy === "start" ? "Starting…" : <>Start for voice · {c.config.voice_gpu}<span className="dim">{rate(c.config.voice_gpu)}</span></>}</button>
              <button className="ghost" disabled={!!busy} onClick={() => startWith({ purpose: "heavy" })} title="Training, RLHF polish, video: needs the big card">
                <Lightning size={14} weight="fill" /> Start for training &amp; video · {c.config.heavy_gpu}<span className="dim">{rate(c.config.heavy_gpu)}</span></button>
            </div>
            <div className="row tiny dim" style={{ gap: 6, flexWrap: "wrap" }}>or
              <select value={c.config.gpu} onChange={(e) => save({ gpu: e.target.value })} style={{ width: "auto" }}>
                {GPUS.map(([g, l]) => <option key={g} value={g}>{l}{rate(g)}</option>)}</select>
              <button className="ghost xs" disabled={!!busy} onClick={() => startWith({ gpu: c.config.gpu })}>Start this one</button>
              {c.config.high_ram ? "· high-RAM machine" : "· standard RAM"}
            </div>
            {c.session?.stopped && <span className="tiny dim">Last session: {c.session.gpu}, stopped {new Date(c.session.stopped).toLocaleString()}{c.session.stop_reason ? ` (${c.session.stop_reason})` : ""}.</span>}
          </div>
        )}
      </div>

      <details><summary className="small"><Bell size={13} /> Reminders and auto-stop</summary>
        <div className="stack" style={{ gap: 10, marginTop: 10 }}>
          <label className="row small" style={{ gap: 8 }}>Voice work on
            <select value={c.config.voice_gpu} onChange={(e) => save({ voice_gpu: e.target.value })} style={{ width: "auto" }}>
              {GPUS.map(([g]) => <option key={g} value={g}>{g}{rate(g)}</option>)}</select>
            training &amp; video on
            <select value={c.config.heavy_gpu} onChange={(e) => save({ heavy_gpu: e.target.value })} style={{ width: "auto" }}>
              {GPUS.map(([g]) => <option key={g} value={g}>{g}{rate(g)}</option>)}</select></label>
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={c.config.high_ram} onChange={(e) => save({ high_ram: e.target.checked })} style={{ width: "auto" }} />
            High-RAM machine <span className="tiny dim">(more RAM keeps more models warm for instant switching; the L4 comes in one size)</span></label>
          <label className="row small" style={{ gap: 8 }}>Remind me every
            <select value={c.config.remind_hours} onChange={(e) => save({ remind_hours: Number(e.target.value) })} style={{ width: "auto" }}>
              {[0, 1, 2, 3].map((h) => <option key={h} value={h}>{h ? `${h} h` : "never"}</option>)}</select> the GPU runs</label>
          <label className="row small" style={{ gap: 8 }}>Stop the GPU after
            <select value={c.config.idle_stop_min} onChange={(e) => save({ idle_stop_min: Number(e.target.value) })} style={{ width: "auto" }}>
              {[0, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m ? `${m} min` : "never"}</option>)}</select> with nothing to do <span className="tiny dim">(GPUs started here)</span></label>
          <label className="row small" style={{ gap: 8 }}>Warn me below
            <input type="number" value={c.config.low_units} min={0} style={{ width: 80 }} onChange={(e) => save({ low_units: Number(e.target.value) })} /> units</label>
          {c.config.ntfy_topic ? (
            <div className="stack" style={{ gap: 6 }}>
              <span className="small">Phone alerts: install <b>ntfy</b> (App Store / Play Store), tap + and subscribe to <code>{c.config.ntfy_topic}</code>.</span>
              <div className="row" style={{ gap: 8 }}>
                <a className="btn ghost sm" href={`https://ntfy.sh/${c.config.ntfy_topic}`} target="_blank" rel="noreferrer">Open in ntfy <ArrowSquareOut size={12} /></a>
                <button className="ghost sm" onClick={() => act("notify", () => api("colab/notify", { body: {} }), "Test sent: check your phone")}>Send a test</button>
                <button className="ghost sm" onClick={() => save({ ntfy_topic: null })}>Turn off</button>
              </div>
            </div>
          ) : <button className="ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => save({ ntfy_topic: topic() })}>Turn on phone alerts</button>}
          <button className="ghost xs" style={{ alignSelf: "flex-start" }} onClick={async () => { if (await confirm({ title: "Disconnect Colab?", body: "Start/Stop and the balance stop working here until you connect again. Running GPUs keep running.", confirm: "Disconnect", danger: true })) act("disconnect", () => api("colab/disconnect", { body: {} })); }}>Disconnect Colab</button>
        </div>
      </details>
      {err && <p className="err" style={{ margin: "8px 0 0" }}>{err}</p>}
    </div>
  );
}
