"use client";
// The two GPUs, simply. GpuOverview: Colab and Modal side by side, each with its state and one button (start / stop,
// wake / stop), then which goes first and the fallback switch. ModalPanel: setting Modal up, its address and monthly
// cap, heavy jobs, test and stop. Server side: lib/gpus.ts (lib/worker.ts routes every call through it); the MCP's
// `gpu` tool, action backend, does the same.
import { Lightning, Play, Power, Stop } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api, type Gpus } from "./api";
import { useDialog } from "./Dialog";
import { useStatus } from "./Shell";
import { Field, Toggle } from "./ui";

type Answer = Gpus & { modal_url: string };
type Colab = { connected: boolean; runtimes?: { endpoint: string; accelerator: string }[] | { error: string }; config?: { voice_gpu: string } };

/** The GPU choice, kept fresh (every 30 s, every 5 s while something is changing). */
function useGpus(fast = false) {
  const { refresh } = useStatus();
  const { toast } = useDialog();
  const [g, setG] = useState<Answer | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => { api<Answer>("gpus").then((a) => { setG(a); setErr(""); }).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); const t = setInterval(load, fast ? 5000 : 30_000); return () => clearInterval(t); }, [load, fast]);
  async function save(patch: Record<string, unknown>, ok?: string) {
    setErr("");
    try { setG(await api<Answer>("gpus", { body: patch })); if (ok) toast(ok, "ok"); refresh(); }
    catch (e) { setErr((e as Error).message); }
  }
  return { g, err, setErr, load, save, toast, refresh };
}

const gpuName = (s?: string | null) => s?.replace("NVIDIA ", "").replace("-SXM4", "") ?? null;

/** Modal's two actions, shared by the overview and its own tab. */
function useModalActions(load: () => void, refresh: () => void, toast: (m: string, t?: "ok" | "bad") => void, setErr: (e: string) => void) {
  const [busy, setBusy] = useState<"" | "wake" | "stop">("");
  async function wake() {
    setErr(""); setBusy("wake");
    try {
      const r = await api<{ gpu: string | null; gpu_gb: number | null; woke_in_s: number; was_awake: boolean }>("gpus/modal-test", { body: {} });
      toast(`Modal is on: ${gpuName(r.gpu) ?? "GPU"}${r.gpu_gb ? ` · ${r.gpu_gb} GB` : ""}${r.was_awake ? "" : ` (woke in ${r.woke_in_s} s)`}`, "ok");
    } catch (e) { setErr((e as Error).message); }
    setBusy(""); load(); refresh();
  }
  async function stop() {
    setErr(""); setBusy("stop");
    try { await api("gpus/modal-stop", { body: {} }); toast("Modal is shutting down (within a minute)", "ok"); }
    catch (e) { setErr((e as Error).message); }
    setBusy(""); load(); refresh();
  }
  return { busy, wake, stop };
}

export function GpuOverview({ open }: { open: (tab: "colab" | "modal") => void }) {
  const { g, err, setErr, load, save, toast, refresh } = useGpus();
  const { confirm } = useDialog();
  const { status } = useStatus();
  const [c, setC] = useState<Colab | null>(null);
  const [cBusy, setCBusy] = useState(false);
  const loadColab = useCallback(() => { api<Colab>("colab").then(setC).catch(() => setC(null)); }, []);
  useEffect(() => { loadColab(); const t = setInterval(loadColab, 30_000); return () => clearInterval(t); }, [loadColab]);
  const modal = useModalActions(load, refresh, toast, setErr);
  if (!g) return <div className="card"><p className="dim small" style={{ margin: 0 }}>{err || "Loading…"}</p></div>;

  const m = g.modal;
  const runtimes = c && Array.isArray(c.runtimes) ? c.runtimes : [];
  const colabOn = g.colab.online || runtimes.length > 0;
  async function colabStart() {
    setErr(""); setCBusy(true);
    try { const r = await api<{ gpu: string }>("colab/start", { body: { purpose: "voice" } }); toast(`${r.gpu} starting: on in about 2 minutes`, "ok"); }
    catch (e) { setErr((e as Error).message); }
    setCBusy(false); loadColab(); refresh();
  }
  async function colabStop() {
    const r = runtimes[0];
    if (!r || !(await confirm({ title: `Stop the ${r.accelerator}?`, body: "Jobs on it stop and billing ends now.", confirm: "Stop", danger: true }))) return;
    setErr(""); setCBusy(true);
    try { await api("colab/stop", { body: { endpoint: r.endpoint } }); toast("Colab stopped", "ok"); }
    catch (e) { setErr((e as Error).message); }
    setCBusy(false); loadColab(); refresh();
  }

  const colabPill = g.colab.online ? ["On", "ok"] : runtimes.length ? ["Starting", "warn"] : ["Off", ""];
  const modalPill = !m.configured ? ["Not set up", ""] : m.over_cap ? ["Monthly cap reached", "bad"] : m.awake ? ["On", "ok"] : ["Asleep", "blue"];
  const first = g.prefer === "colab" ? "Colab" : "Modal";
  const other = g.prefer === "colab" ? "Modal" : "Colab";
  const serving = status?.backend === "colab" && g.colab.online ? "colab" : status?.backend === "modal" ? "modal" : null;

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", marginBottom: 16 }}>
        <section className="card" aria-label="Colab">
          <div className="row between" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>Colab</h2>
            <span className={`pill ${colabPill[1]}`}>{colabPill[0]}</span>
          </div>
          <p className="dim small" style={{ margin: "6px 0 14px" }}>
            {g.colab.online ? `${gpuName(g.colab.gpu) ?? "GPU"}${serving === "colab" ? " · taking the work" : ""}` : "Cheapest by the hour. Runs while it's on."}</p>
          {!c?.connected ? <button className="ghost sm" onClick={() => open("colab")}>Connect Colab</button>
            : colabOn ? <button className="ghost sm" disabled={cBusy || !runtimes.length} onClick={colabStop}><Stop size={13} weight="fill" /> Stop</button>
            : <button className="sm" disabled={cBusy} onClick={colabStart}><Play size={13} weight="fill" /> {cBusy ? "Starting…" : `Start${c.config?.voice_gpu ? ` · ${c.config.voice_gpu}` : ""}`}</button>}
        </section>

        <section className="card" aria-label="Modal">
          <div className="row between" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>Modal</h2>
            <span className={`pill ${modalPill[1]}`}>{modalPill[0]}</span>
          </div>
          <p className="dim small" style={{ margin: "6px 0 14px" }}>
            {!m.configured ? "On demand: wakes for a job, sleeps after." : m.awake ? `${gpuName(m.gpu) ?? "GPU"}${serving === "modal" ? " · taking the work" : ""} · ${m.used_h} of ${m.cap_h} h this month`
              : `Wakes for the next job · ${m.used_h} of ${m.cap_h} h this month`}</p>
          {!m.configured ? <button className="sm" onClick={() => open("modal")}><Lightning size={13} weight="fill" /> Set up Modal</button>
            : m.awake ? <button className="ghost sm" disabled={!!modal.busy} onClick={modal.stop}><Stop size={13} weight="fill" /> {modal.busy === "stop" ? "Stopping…" : "Stop"}</button>
            : <button className="ghost sm" disabled={!!modal.busy || m.over_cap} onClick={modal.wake}><Power size={13} /> {modal.busy === "wake" ? "Waking… about a minute" : "Wake"}</button>}
        </section>
      </div>

      <div className="card">
        <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
          <div><b className="small">Goes first</b><div className="tiny dim">New jobs go to this GPU</div></div>
          <div className="seg" role="group" aria-label="GPU that goes first">
            <button className={g.prefer === "colab" ? "on" : ""} aria-pressed={g.prefer === "colab"} onClick={() => save({ prefer: "colab" }, "Colab goes first")}>Colab</button>
            <button className={g.prefer === "modal" ? "on" : ""} aria-pressed={g.prefer === "modal"} disabled={!m.configured} title={!m.configured ? "Set up Modal first" : undefined}
              onClick={() => save({ prefer: "modal" }, "Modal goes first")}>Modal</button>
          </div>
        </div>
        <Toggle on={g.fallback} set={(v) => save({ fallback: v })} title={`Use ${other} when ${first} is off`}
          about="A job is never sent twice." />
      </div>
      {err && <p className="err small">{err}</p>}
    </>
  );
}

export function ModalPanel() {
  const [setup, setSetup] = useState<{ commands: string[]; at: number } | null>(null);
  const { g, err, setErr, load, save, toast, refresh } = useGpus(!!setup);
  const [url, setUrl] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const modal = useModalActions(load, refresh, toast, setErr);
  // the setup's last command connects the address: once it does, the commands have done their job
  useEffect(() => { if (setup && (g?.modal.connected_at ?? 0) > setup.at - 60_000) { setSetup(null); toast("Modal is connected", "ok"); } }, [setup, g?.modal.connected_at, toast]);
  if (!g) return <div className="card"><p className="dim small" style={{ margin: 0 }}>{err || "Loading…"}</p></div>;
  const m = g.modal;
  const urlV = url ?? g.modal_url, capV = cap ?? String(m.cap_h);

  async function makeSetup() {
    setErr(""); setMaking(true);
    try { setSetup({ commands: (await api<{ commands: string[] }>("gpus/modal-setup", { body: {} })).commands, at: Date.now() }); }
    catch (e) { setErr((e as Error).message); }
    setMaking(false);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(setup!.commands.join("\n")); toast("Copied: paste it in a terminal", "ok"); }
    catch { toast("Couldn't copy: select the commands and copy them", "bad"); }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card">
        <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
          <div><b className="small">{m.configured ? (m.awake ? `On · ${gpuName(m.gpu) ?? "GPU"}` : m.over_cap ? "Monthly cap reached" : "Asleep: wakes for the next job") : "Not set up yet"}</b>
            <div className="tiny dim">{m.configured ? `${m.used_h} of ${m.cap_h} h used this month · sleeps 10 min after the last job` : "A free modal.com account and four commands in a terminal"}</div></div>
          <div className="row" style={{ gap: 8 }}>
            {m.configured && (m.awake
              ? <button className="ghost sm" disabled={!!modal.busy} onClick={modal.stop}><Stop size={13} weight="fill" /> {modal.busy === "stop" ? "Stopping…" : "Stop now"}</button>
              : <button className="ghost sm" disabled={!!modal.busy || m.over_cap} onClick={modal.wake}><Power size={13} /> {modal.busy === "wake" ? "Waking… about a minute" : "Wake"}</button>)}
            {!setup && <button className={m.configured ? "ghost sm" : "sm"} onClick={makeSetup} disabled={making}>{making ? "Making…" : m.configured ? "Set up again" : "Set up Modal"}</button>}
          </div>
        </div>
        {setup && (
          <div className="stack" style={{ gap: 8, marginTop: 14 }}>
            <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="small">Paste in a terminal (Mac or Linux; on Windows, WSL)</span>
              <div className="row" style={{ gap: 6 }}><button className="sm" onClick={copy}>Copy</button><button className="ghost sm" onClick={() => setSetup(null)}>Close</button></div>
            </div>
            <pre className="card inset mono" aria-label="Modal setup commands" style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{setup.commands.join("\n")}</pre>
            <span className="tiny dim">The last line connects Modal here by itself. The commands hold Modal&apos;s own key: don&apos;t share them. A new setup makes a new key.</span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {m.url_from !== "env" && (
            <Field label="Address" style={{ flex: "1 1 260px", margin: 0 }} hint="Filled in by the setup">
              <input value={urlV} onChange={(e) => setUrl(e.target.value)} placeholder="https://you--voicebox-worker-gateway.us-east.modal.run" spellCheck={false} />
            </Field>
          )}
          <Field label="Hours a month" style={{ flex: "0 1 140px", margin: 0 }} hint="0 turns Modal off">
            <input type="number" min={0} max={500} value={capV} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <button className="sm" disabled={(m.url_from === "env" || urlV === g.modal_url) && Number(capV) === m.cap_h}
            onClick={async () => { await save({ ...(m.url_from !== "env" ? { modal_url: urlV } : {}), modal_cap_h: Number(capV) || 0 }, "Saved"); setUrl(null); setCap(null); }}>Save</button>
        </div>
        <Toggle on={g.modal_heavy} set={(v) => save({ modal_heavy: v })} title="Training and video on Modal too"
          about="Off: they stay on Colab (they take hours of GPU)." />
      </div>
      {err && <p className="err small" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}
