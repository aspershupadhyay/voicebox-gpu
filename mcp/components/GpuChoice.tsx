"use client";
// Which GPU takes the work: Colab or Modal first, the other as the fallback, Modal's address and its monthly cap.
// Server side: lib/gpus.ts (lib/worker.ts routes every call through it); the MCP's `gpu` tool, action backend, does the same.
import { useCallback, useEffect, useState } from "react";
import { api, type Gpus } from "./api";
import { Info } from "./Info";
import { useDialog } from "./Dialog";
import { useStatus } from "./Shell";
import { Field, Toggle } from "./ui";

type Answer = Gpus & { modal_url: string };

export default function GpuChoice() {
  const { refresh } = useStatus();
  const { toast } = useDialog();
  const [g, setG] = useState<Answer | null>(null);
  const [url, setUrl] = useState("");
  const [cap, setCap] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<Answer>("gpus").then((a) => { setG(a); setUrl((u) => u || a.modal_url); setCap((c) => c || String(a.modal.cap_h)); }).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  async function save(patch: Record<string, unknown>, ok?: string) {
    setErr("");
    try { setG(await api<Answer>("gpus", { body: patch })); if (ok) toast(ok, "ok"); refresh(); }
    catch (e) { setErr((e as Error).message); }
  }
  if (!g) return <div className="card"><div className="card-head"><h2>Which GPU</h2></div><p className="dim small" style={{ margin: 0 }}>{err || "Loading…"}</p></div>;

  const m = g.modal;
  const modalState = !m.configured ? ["Not set up", ""] : m.over_cap ? ["Cap reached", "bad"] : m.awake ? ["Awake", "ok"] : ["Asleep · wakes for a job", "blue"];
  const colabState = g.colab.online ? ["On", "ok"] : ["Off", ""];
  const other = g.prefer === "colab" ? "Modal" : "Colab";

  return (
    <div className="card">
      <div className="card-head"><h2>Which GPU <Info label="Which GPU">Two GPUs can take the studio&apos;s work. Colab runs while its runtime is on. Modal sleeps and wakes
        for a job in about a minute (longer the very first time, while it installs), bills by the second and goes back to sleep 10 minutes after the last job.</Info></h2>
        <div className="seg" role="group" aria-label="GPU that goes first">
          <button className={g.prefer === "colab" ? "on" : ""} aria-pressed={g.prefer === "colab"} onClick={() => save({ prefer: "colab" }, "Colab goes first")}>Colab first</button>
          <button className={g.prefer === "modal" ? "on" : ""} aria-pressed={g.prefer === "modal"} disabled={!m.configured} title={!m.configured ? "Add Modal's address below first" : undefined}
            onClick={() => save({ prefer: "modal" }, "Modal goes first")}>Modal first</button>
        </div>
      </div>

      <div className="erows" style={{ marginBottom: 12 }}>
        <div className="erow">
          <span className={`dot ${g.colab.online ? "ok" : "off"}`} aria-hidden />
          <div className="erow-name"><b>Colab</b><span>{g.colab.gpu?.replace("NVIDIA ", "") ?? "Started here or from the notebook"}</span></div>
          <span><span className={`pill ${colabState[1]}`}>{colabState[0]}</span></span>
        </div>
        <div className="erow">
          <span className={`dot ${m.awake ? "ok" : m.over_cap ? "bad" : m.configured ? "park" : "off"}`} aria-hidden />
          <div className="erow-name"><b>Modal</b><span>{m.configured ? `${m.used_h} of ${m.cap_h} h used this month${m.gpu ? ` · ${m.gpu.replace("NVIDIA ", "")}` : ""}` : "Free monthly credit, on demand"}</span></div>
          <span><span className={`pill ${modalState[1]}`}>{modalState[0]}</span></span>
        </div>
      </div>

      <Toggle on={g.fallback} set={(v) => save({ fallback: v }, v ? `${other} takes over when ${g.prefer === "colab" ? "Colab" : "Modal"} can't` : "No fallback")}
        title={`Fall back to ${other}`} about={`When ${g.prefer === "colab" ? "Colab" : "Modal"} is off or can't be reached, the job goes to ${other} instead. A job that may have arrived is never sent twice.`} />
      <Toggle on={g.modal_heavy} set={(v) => save({ modal_heavy: v })} title="Training and video on Modal too"
        about="Off: voice training, Orpheus drafts and video stay on Colab (they take hours of GPU). Voiceovers, subtitles, clean-up and images use either." />

      <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
        {m.url_from !== "env" && (
          <Field label="Modal address" style={{ flex: "1 1 260px", margin: 0 }} hint="Printed by modal deploy (modal_app/voicebox_modal.py)">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://you--voicebox-worker-gateway.modal.run" spellCheck={false} />
          </Field>
        )}
        <Field label="Modal hours a month" style={{ flex: "0 1 150px", margin: 0 }} hint="0 turns Modal off">
          <input type="number" min={0} max={500} value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <button className="sm" onClick={() => save({ ...(m.url_from !== "env" ? { modal_url: url } : {}), modal_cap_h: Number(cap) || 0 }, "Saved")}
          disabled={(m.url_from === "env" || url === g.modal_url) && Number(cap) === m.cap_h}>Save</button>
      </div>
      {err && <p className="err small" style={{ marginBottom: 0 }}>{err}</p>}
    </div>
  );
}
