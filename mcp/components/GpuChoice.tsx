"use client";
// The GPUs, simply. GpuOverview: Colab, Kaggle, Modal and Cerebrium side by side, each with its state and one button (start /
// stop, wake / stop), then which goes first and the fallback switch. CloudPanel: one cloud GPU's tab (Modal or
// Cerebrium): set it up, its address and monthly cap, heavy jobs, wake and stop. Server side: lib/gpus.ts
// (lib/worker.ts routes every call through it); the MCP's `gpu` tool, action backend, does the same.
import { Lightning, Play, Power, Stop } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api, type CloudGpu, type Gpus, type KaggleGpu } from "./api";
import { useDialog } from "./Dialog";
import { useStatus } from "./Shell";
import { Field, Toggle } from "./ui";

type Cloud = "modal" | "cerebrium";
type Answer = Gpus & { modal_url: string; cerebrium_url: string };
type Colab = { connected: boolean; runtimes?: { endpoint: string; accelerator: string }[] | { error: string }; config?: { voice_gpu: string } };
const NAME: Record<Cloud | "colab" | "kaggle", string> = { colab: "Colab", kaggle: "Kaggle", modal: "Modal", cerebrium: "Cerebrium" };
const PLACEHOLDER: Record<Cloud, string> = { modal: "https://you--voicebox-worker-gateway.us-east.modal.run", cerebrium: "https://api.cerebrium.ai/v4/p-xxxxxxxx/voicebox-worker" };
const SIGNUP: Record<Cloud, string> = { modal: "modal.com", cerebrium: "cerebrium.ai" };

/** The GPU choice, kept fresh (every 30 s, every 5 s while a setup waits to connect). */
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

/** A cloud GPU's two actions, shared by the overview and its own tab. */
function useCloudActions(cloud: Cloud, load: () => void, refresh: () => void, toast: (m: string, t?: "ok" | "bad") => void, setErr: (e: string) => void) {
  const [busy, setBusy] = useState<"" | "wake" | "stop">("");
  async function wake() {
    setErr(""); setBusy("wake");
    try {
      const r = await api<{ gpu: string | null; gpu_gb: number | null; woke_in_s: number; was_awake: boolean }>(`gpus/${cloud}-test`, { body: {} });
      toast(`${NAME[cloud]} is on: ${gpuName(r.gpu) ?? "GPU"}${r.gpu_gb ? ` · ${r.gpu_gb} GB` : ""}${r.was_awake ? "" : ` (woke in ${r.woke_in_s} s)`}`, "ok");
    } catch (e) { setErr((e as Error).message); }
    setBusy(""); load(); refresh();
  }
  async function stop() {
    setErr(""); setBusy("stop");
    try { await api(`gpus/${cloud}-stop`, { body: {} }); toast(`${NAME[cloud]} is shutting down (within a minute)`, "ok"); }
    catch (e) { setErr((e as Error).message); }
    setBusy(""); load(); refresh();
  }
  return { busy, wake, stop };
}

const pillFor = (m: CloudGpu) => (!m.configured ? ["Not set up", ""] : m.over_cap ? ["Monthly cap reached", "bad"] : m.awake ? ["On", "ok"] : ["Asleep", "blue"]);

function CloudCard({ cloud, m, serving, open, load, refresh, toast, setErr }: { cloud: Cloud; m: CloudGpu; serving: boolean; open: (t: Cloud) => void;
  load: () => void; refresh: () => void; toast: (m: string, t?: "ok" | "bad") => void; setErr: (e: string) => void }) {
  const a = useCloudActions(cloud, load, refresh, toast, setErr);
  const [label, tone] = pillFor(m);
  return (
    <section className="card" aria-label={NAME[cloud]}>
      <div className="row between" style={{ gap: 8 }}>
        <h2 style={{ margin: 0 }}>{NAME[cloud]}</h2>
        <span className={`pill ${tone}`}>{label}</span>
      </div>
      <p className="dim small" style={{ margin: "6px 0 14px" }}>
        {!m.configured ? "On demand: wakes for a job, sleeps after." : m.awake ? `${gpuName(m.gpu) ?? "GPU"}${serving ? " · taking the work" : ""} · ${m.used_h} of ${m.cap_h} h this month`
          : `Wakes for the next job · ${m.used_h} of ${m.cap_h} h this month`}</p>
      {!m.configured ? <button className="sm" onClick={() => open(cloud)}><Lightning size={13} weight="fill" /> Set up {NAME[cloud]}</button>
        : m.awake ? <button className="ghost sm" disabled={!!a.busy} onClick={a.stop}><Stop size={13} weight="fill" /> {a.busy === "stop" ? "Stopping…" : "Stop"}</button>
        : <button className="ghost sm" disabled={!!a.busy || m.over_cap} onClick={a.wake}><Power size={13} /> {a.busy === "wake" ? "Waking… about a minute" : "Wake"}</button>}
    </section>
  );
}

/** Kaggle: free, about 30 h a week. The app starts it when work needs a GPU and it stops itself when idle. */
function KaggleCard({ k, serving, load, refresh, toast, setErr }: { k: KaggleGpu; serving: boolean; load: () => void; refresh: () => void;
  toast: (m: string, t?: "ok" | "bad") => void; setErr: (e: string) => void }) {
  const [busy, setBusy] = useState<"" | "start" | "stop">("");
  const [label, tone] = !k.configured ? ["Not set up", ""] : k.online ? ["On", "ok"] : k.starting ? ["Starting", "warn"] : k.over_cap ? ["Week's hours used", "bad"] : ["Off", "blue"];
  async function act(what: "start" | "stop") {
    setErr(""); setBusy(what);
    try {
      const r = await api<{ started?: boolean; why?: string }>(`gpus/kaggle-${what}`, { body: {} });
      toast(what === "stop" ? "Kaggle is stopping (within a minute)" : r.started ? "Kaggle is starting: on in 3-6 minutes" : r.why ?? "Kaggle is on", "ok");
    } catch (e) { setErr((e as Error).message); }
    setBusy(""); load(); refresh();
  }
  return (
    <section className="card" aria-label="Kaggle">
      <div className="row between" style={{ gap: 8 }}>
        <h2 style={{ margin: 0 }}>Kaggle</h2>
        <span className={`pill ${tone}`}>{label}</span>
      </div>
      <p className="dim small" style={{ margin: "6px 0 14px" }}>
        {!k.configured ? "Free, about 30 h a week. Add its key on the Worker (KAGGLE_USERNAME, KAGGLE_API_TOKEN)."
          : `${k.online ? `${gpuName(k.gpu) ?? "GPU"}${serving ? " · taking the work" : ""} · ` : "Starts for work · "}${k.used_h_this_week} of ${k.cap_h} h this week · stops after ${k.idle_stop_min} idle min`}</p>
      {k.configured && (k.online || k.starting
        ? <button className="ghost sm" disabled={!!busy || !k.online} onClick={() => act("stop")}><Stop size={13} weight="fill" /> {busy === "stop" ? "Stopping…" : k.starting ? "Starting…" : "Stop"}</button>
        : <button className="sm" disabled={!!busy || k.over_cap} onClick={() => act("start")}><Play size={13} weight="fill" /> {busy === "start" ? "Starting…" : "Start"}</button>)}
    </section>
  );
}

export function GpuOverview({ open }: { open: (tab: "colab" | Cloud) => void }) {
  const { g, err, setErr, load, save, toast, refresh } = useGpus();
  const { confirm } = useDialog();
  const { status } = useStatus();
  const [c, setC] = useState<Colab | null>(null);
  const [cBusy, setCBusy] = useState(false);
  const loadColab = useCallback(() => { api<Colab>("colab").then(setC).catch(() => setC(null)); }, []);
  useEffect(() => { loadColab(); const t = setInterval(loadColab, 30_000); return () => clearInterval(t); }, [loadColab]);
  if (!g) return <div className="card"><p className="dim small" style={{ margin: 0 }}>{err || "Loading…"}</p></div>;

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
  const serving = status?.online && !status.asleep ? status.backend : null;
  const choices: ("colab" | "kaggle" | Cloud)[] = ["colab", "kaggle", "modal", "cerebrium"];

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", marginBottom: 16 }}>
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
        {g.kaggle && <KaggleCard k={g.kaggle} serving={serving === "kaggle"} load={load} refresh={refresh} toast={toast} setErr={setErr} />}
        {(["modal", "cerebrium"] as Cloud[]).map((k) => (
          <CloudCard key={k} cloud={k} m={g[k]} serving={serving === k} open={open} load={load} refresh={refresh} toast={toast} setErr={setErr} />
        ))}
      </div>

      <div className="card">
        <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
          <div><b className="small">Goes first</b><div className="tiny dim">New jobs go to this GPU</div></div>
          <div className="seg" role="group" aria-label="GPU that goes first">
            {choices.map((k) => {
              const off = k === "kaggle" ? !g.kaggle?.configured : k !== "colab" && !g[k].configured;
              return <button key={k} className={g.prefer === k ? "on" : ""} aria-pressed={g.prefer === k} disabled={off} title={off ? `Set up ${NAME[k]} first` : undefined}
                onClick={() => save({ prefer: k }, `${NAME[k]} goes first`)}>{NAME[k]}</button>;
            })}
          </div>
        </div>
        <Toggle on={g.fallback} set={(v) => save({ fallback: v })} title={`Use the others when ${NAME[g.prefer]} is off`}
          about="In order: Colab, Kaggle, Modal, Cerebrium: the free ones first. A job is never sent twice." />
      </div>
      {err && <p className="err small">{err}</p>}
    </>
  );
}

export function CloudPanel({ cloud }: { cloud: Cloud }) {
  const [setup, setSetup] = useState<{ commands: string[]; at: number } | null>(null);
  const { g, err, setErr, load, save, toast, refresh } = useGpus(!!setup);
  const [url, setUrl] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const a = useCloudActions(cloud, load, refresh, toast, setErr);
  const n = NAME[cloud];
  // the setup's last command connects the address: once it does, the commands have done their job
  useEffect(() => { if (setup && (g?.[cloud].connected_at ?? 0) > setup.at - 60_000) { setSetup(null); toast(`${n} is connected`, "ok"); } }, [setup, g, cloud, n, toast]);
  if (!g) return <div className="card"><p className="dim small" style={{ margin: 0 }}>{err || "Loading…"}</p></div>;
  const m = g[cloud];
  const saved = g[`${cloud}_url`];
  const urlV = url ?? saved, capV = cap ?? String(m.cap_h);

  async function makeSetup() {
    setErr(""); setMaking(true);
    try { setSetup({ commands: (await api<{ commands: string[] }>(`gpus/${cloud}-setup`, { body: {} })).commands, at: Date.now() }); }
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
            <div className="tiny dim">{m.configured ? `${m.used_h} of ${m.cap_h} h used this month · sleeps ${cloud === "cerebrium" ? 5 : 10} min after the last job` : `A free ${SIGNUP[cloud]} account and four commands in a terminal`}</div></div>
          <div className="row" style={{ gap: 8 }}>
            {m.configured && (m.awake
              ? <button className="ghost sm" disabled={!!a.busy} onClick={a.stop}><Stop size={13} weight="fill" /> {a.busy === "stop" ? "Stopping…" : "Stop now"}</button>
              : <button className="ghost sm" disabled={!!a.busy || m.over_cap} onClick={a.wake}><Power size={13} /> {a.busy === "wake" ? "Waking… about a minute" : "Wake"}</button>)}
            {!setup && <button className={m.configured ? "ghost sm" : "sm"} onClick={makeSetup} disabled={making}>{making ? "Making…" : m.configured ? "Set up again" : `Set up ${n}`}</button>}
          </div>
        </div>
        {setup && (
          <div className="stack" style={{ gap: 8, marginTop: 14 }}>
            <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="small">Paste in a terminal (Mac or Linux; on Windows, WSL)</span>
              <div className="row" style={{ gap: 6 }}><button className="sm" onClick={copy}>Copy</button><button className="ghost sm" onClick={() => setSetup(null)}>Close</button></div>
            </div>
            <pre className="card inset mono" aria-label={`${n} setup commands`} style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{setup.commands.join("\n")}</pre>
            <span className="tiny dim">The first line signs you in to {SIGNUP[cloud]}. The last one deploys and connects {n} here by itself. The commands hold the
              studio&apos;s cloud key: don&apos;t share them.</span>
          </div>
        )}
      </div>

      <DeployCard cloud={cloud} />

      <div className="card">
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {m.url_from !== "env" && (
            <Field label="Address" style={{ flex: "1 1 260px", margin: 0 }} hint="Filled in by the setup">
              <input value={urlV} onChange={(e) => setUrl(e.target.value)} placeholder={PLACEHOLDER[cloud]} spellCheck={false} />
            </Field>
          )}
          <Field label="Hours a month" style={{ flex: "0 1 140px", margin: 0 }} hint={`0 turns ${n} off`}>
            <input type="number" min={0} max={500} value={capV} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <button className="sm" disabled={(m.url_from === "env" || urlV === saved) && Number(capV) === m.cap_h}
            onClick={async () => { await save({ ...(m.url_from !== "env" ? { [`${cloud}_url`]: urlV } : {}), [`${cloud}_cap_h`]: Number(capV) || 0 }, "Saved"); setUrl(null); setCap(null); }}>Save</button>
        </div>
        <Toggle on={g.modal_heavy} set={(v) => save({ modal_heavy: v })} title="Training and video on cloud GPUs too"
          about="Off: they stay on Colab (they take hours of GPU). Applies to Modal and Cerebrium." />
      </div>
      {err && <p className="err small" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

/** Modal's tab (kept for imports elsewhere). */
export const ModalPanel = () => <CloudPanel cloud="modal" />;

type DeployRow = { id: string; cloud: Cloud; by: string; at: number; status: "starting" | "running" | "done" | "failed"; finished?: number; note?: string; url?: string | null; run_url?: string | null };
type Deploys = { tokens: Record<Cloud, { saved: boolean; last4?: string; project?: string; at?: number }>; deploys: DeployRow[] };
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

/** Deploy a cloud GPU from here (lib/clouddeploy.ts): its tokens once, then one button; GitHub runs the deploy. */
export function DeployCard({ cloud }: { cloud: Cloud }) {
  const { toast } = useDialog();
  const [d, setD] = useState<Deploys | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(() => { api<Deploys>("gpus/deploys").then(setD).catch((e) => setErr((e as Error).message)); }, []);
  const last = d?.deploys.find((x) => x.cloud === cloud);
  const live = !!last && (last.status === "starting" || last.status === "running");
  useEffect(() => { load(); const t = setInterval(load, live ? 5000 : 30_000); return () => clearInterval(t); }, [load, live]);
  if (!d) return <div className="card"><p className="dim small" style={{ margin: 0 }}>{err || "Loading…"}</p></div>;
  const tok = d.tokens[cloud];
  const n = NAME[cloud];
  const fields: [string, string, string][] = cloud === "modal"
    ? [["token_id", "Token id", "ak-…"], ["token_secret", "Token secret", "as-…"]]
    : [["project", "Project id", "p-xxxxxxxx"], ["token", "Service account key", "eyJ…"]];
  const where = cloud === "modal" ? "modal.com → Settings → API Tokens → New token" : "dashboard.cerebrium.ai → API Keys → Create Service Account (the project id is at the top left)";

  async function saveTokens() {
    setErr(""); setBusy("save");
    try { await api(`gpus/${cloud}-tokens`, { body: f }); setF({}); setEditing(false); toast(`${n}'s tokens saved`, "ok"); load(); }
    catch (e) { setErr((e as Error).message); }
    setBusy("");
  }
  async function deploy() {
    setErr(""); setBusy("deploy");
    try { await api(`gpus/${cloud}-deploy`, { body: {} }); toast(`Deploying ${n}: GitHub runs it, a few minutes`, "ok"); load(); }
    catch (e) { setErr((e as Error).message); }
    setBusy("");
  }
  const state = !last ? null : last.status === "done" ? ["Deployed", "ok"] : last.status === "failed" ? ["Failed", "bad"] : last.status === "running" ? ["Deploying…", "warn"] : ["Starting…", "warn"];

  return (
    <div className="card">
      <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
        <div><b className="small">Deploy from the website</b>
          <div className="tiny dim">{tok.saved ? `Tokens saved (…${tok.last4}${tok.project ? ` · ${tok.project}` : ""}). Deploy rebuilds ${n} with the newest code and connects it.` : `Paste ${n}'s tokens once and deploys are one button, no terminal.`}</div></div>
        <div className="row" style={{ gap: 8 }}>
          {tok.saved && !editing && <button className="ghost sm" onClick={() => setEditing(true)}>Change tokens</button>}
          {tok.saved && <button className="sm" disabled={!!busy || live} onClick={deploy}>{live ? "Deploying…" : busy === "deploy" ? "Starting…" : "Deploy"}</button>}
        </div>
      </div>
      {(!tok.saved || editing) && (
        <div className="stack" style={{ gap: 10, marginTop: 12 }}>
          <span className="tiny dim">From {where}. Kept encrypted here and only handed to the deploy run; never shown again.</span>
          <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            {fields.map(([k, label, ph]) => (
              <Field key={k} label={label} style={{ flex: "1 1 200px", margin: 0 }}>
                <input type={k === "project" || k === "token_id" ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={ph} value={f[k] ?? ""}
                  onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} />
              </Field>
            ))}
            <button className="sm" disabled={!!busy || fields.some(([k]) => !(f[k] ?? "").trim())} onClick={saveTokens}>{busy === "save" ? "Saving…" : "Save"}</button>
            {editing && <button className="ghost sm" onClick={() => { setEditing(false); setF({}); }}>Cancel</button>}
          </div>
        </div>
      )}
      {last && state && (
        <div className="row between small" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <span><span className={`pill ${state[1]}`}>{state[0]}</span> <span className="dim">{ago(last.finished ?? last.at)} · {last.by}{last.status === "failed" && last.note ? ` · ${last.note}` : ""}</span></span>
          {last.run_url && <a className="small" href={last.run_url} target="_blank" rel="noopener noreferrer">See the run on GitHub</a>}
        </div>
      )}
      {err && <p className="err small" style={{ marginBottom: 0 }}>{err}</p>}
    </div>
  );
}
