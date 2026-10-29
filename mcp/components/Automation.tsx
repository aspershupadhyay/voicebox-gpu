"use client";
// Settings → Automation (docs/AUTOMATION.md): what models and automations may do on their own. The approvals inbox
// (risky actions wait here for a click), the kill switch, the day's Colab units cap, which actions ask first, and the
// call log of every MCP call with the model that made it. Acts at once; server side lib/auto/control.ts.
import { CheckCircle, GitBranch, Hand, Pause, Play, Plus, Robot, Stop, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { Info } from "./Info";
import { Select } from "./pop";
import { Field, Toggle } from "./ui";

type Approval = { id: string; action: string; summary: string; by: string; status: string; created: number; decided?: number; decided_by?: string; note?: string };
type Log = { t: number; tool: string; model: string; ok: boolean; ms: number; err?: string; job?: string; gate?: string; via?: string; args?: string };
type Data = {
  control: { paused: boolean; paused_at?: number; paused_by?: string; pause_reason?: string; cap_units: number; ask_first: string[]; repos: string[] };
  units: { spent: number | null; balance: number | null };
  approvals: Approval[]; log: Log[]; ask_first: Record<string, string>; github_key: boolean; platform: string;
};

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};
const TONE: Record<string, string> = { pending: "warn", approved: "ok", used: "ok", denied: "bad", expired: "grey" };

export default function Automation() {
  const { toast, confirm } = useDialog();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [cap, setCap] = useState("");
  const [repo, setRepo] = useState("");
  const load = useCallback(() => {
    api<Data>(`automation${model ? `?model=${encodeURIComponent(model)}` : ""}`).then((r) => { setD(r); setErr(null); setCap((c) => c || String(r.control.cap_units || "")); }).catch((e) => setErr((e as Error).message));
  }, [model]);
  useEffect(() => {
    load();
    // the inbox is live while the tab is open and visible: an approval waits on the owner
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function act(path: string, body: unknown, ok: string) {
    setBusy(true);
    try { await api(`automation/${path}`, { body }); toast(ok, "ok"); load(); } catch (e) { toast((e as Error).message, "bad"); }
    setBusy(false);
  }

  if (!d) return err ? <p className="err" role="alert">{err}</p> : <div className="skel" style={{ height: 320 }} />;
  const c = d.control;
  const pending = d.approvals.filter((a) => a.status === "pending");
  const decided = d.approvals.filter((a) => a.status !== "pending").slice(0, 8);
  const models = [...new Set(d.log.map((l) => l.model))];
  const over = c.cap_units > 0 && d.units.spent != null && d.units.spent >= c.cap_units;

  return (
    <div className="bento">
      <section className="card b-3">
        <div className="card-head"><div><h2><Hand size={17} /> Waiting for you {pending.length ? <span className="pill warn">{pending.length}</span> : null}</h2>
          <p className="sub">Risky actions a model asked to do. It waits until you decide.</p></div></div>
        <div className="stack" style={{ gap: 0 }}>
          {pending.map((a) => (
            <div key={a.id} className="sec-row au-ask">
              <WarningCircle size={18} color="var(--warn)" />
              <div style={{ minWidth: 0 }}>
                <div className="small" style={{ fontWeight: 600 }}>{d.ask_first[a.action] ?? a.action}</div>
                <div className="tiny dim au-wrap">{a.summary}</div>
                <div className="tiny dim">{a.by} · {ago(a.created)} · <span className="mono">{a.id}</span></div>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <button className="ghost sm" disabled={busy} onClick={() => act("deny", { id: a.id }, "Denied")} aria-label={`Deny ${a.id}`}><X size={13} />Deny</button>
                <button className="light sm" disabled={busy} onClick={() => act("approve", { id: a.id }, "Approved")} aria-label={`Approve ${a.id}`}><CheckCircle size={13} />Approve</button>
              </div>
            </div>
          ))}
          {!pending.length && <p className="tiny dim" style={{ margin: "4px 0 0" }}>Nothing waiting.</p>}
        </div>
        {decided.length > 0 && <details style={{ marginTop: 12 }}>
          <summary className="small">Decided lately</summary>
          {decided.map((a) => (
            <div key={a.id} className="sec-log au-dec">
              <span className={`pill ${TONE[a.status] ?? "grey"}`}>{a.status}</span>
              <span className="au-wrap small">{a.summary}</span>
              <span className="dim tiny">{a.decided_by ?? a.by}</span>
              <span className="dim tiny">{ago(a.decided ?? a.created)}</span>
            </div>
          ))}
        </details>}
      </section>

      <div className="b-3 stack" style={{ gap: 16 }}>
        <section className="card">
          <div className="card-head"><div><h2><Robot size={17} /> Models and automations</h2>
            <p className="sub">{c.paused ? `Stopped ${c.paused_at ? ago(c.paused_at) : ""} by ${c.paused_by ?? "someone"}: ${c.pause_reason ?? ""}` : "Running. Stop everything at once if something runs away."}</p></div>
            <span className={`pill ${c.paused ? "bad" : "ok"}`}>{c.paused ? "Stopped" : "Running"}</span></div>
          <div className="row" style={{ gap: 8 }}>
            {c.paused
              ? <button className="light" disabled={busy} onClick={() => act("resume", {}, "Running again")}><Play size={14} />Resume</button>
              : <button className="ghost danger-h" disabled={busy} onClick={async () => {
                if (await confirm({ title: "Stop everything?", body: "Every model and automation is paused, every queued and running job is cancelled and the GPU stops. Reading still works. You resume it here.", confirm: "Stop everything", danger: true }))
                  act("stop", {}, "Everything stopped");
              }}><Stop size={14} />Stop everything</button>}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><div><h2><Pause size={17} /> Daily units cap</h2>
            <p className="sub">Colab units models may spend a day (UTC). Past it, GPU work waits for you.</p></div>
            {over && <span className="pill bad">Over</span>}</div>
          <div className="au-meter" role="img" aria-label={`${d.units.spent ?? "unknown"} of ${c.cap_units || "no cap"} units spent today`}>
            <b className="mono">{d.units.spent ?? "?"}</b><span className="dim small"> {c.cap_units ? `of ${c.cap_units}` : "units"} spent today{d.units.balance != null ? ` · ${d.units.balance.toFixed(1)} left on the account` : " · connect Colab (GPU & engines) to count"}</span>
            {c.cap_units > 0 && d.units.spent != null && <span className="au-bar" aria-hidden><i style={{ width: `${Math.min(100, (d.units.spent / c.cap_units) * 100)}%` }} className={over ? "bad" : ""} /></span>}
          </div>
          <form className="row" style={{ gap: 8, marginTop: 12, alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); act("settings", { cap_units: Number(cap) || 0 }, Number(cap) ? `Cap set to ${Number(cap)} units a day` : "No cap"); }}>
            <Field label="Units a day" style={{ flex: 1, margin: 0 }}>
              <input type="number" min={0} max={500} step={0.5} inputMode="decimal" placeholder="No cap" value={cap} onChange={(e) => setCap(e.target.value)} />
            </Field>
            <button className="ghost" disabled={busy}>Save</button>
          </form>
        </section>
      </div>

      <section className="card b-3">
        <div className="card-head"><div><h2>Ask me first</h2><p className="sub">What waits for your click.</p></div>
          <Info label="Ask me first">Switched off, a model does it without asking. The units cap switched off here is a hard stop instead.</Info></div>
        {Object.entries(d.ask_first).map(([k, label]) => (
          <Toggle key={k} title={label} on={c.ask_first.includes(k)} set={(on) => act("settings", { ask_first: on ? [...c.ask_first, k] : c.ask_first.filter((x) => x !== k) }, on ? "Asks first" : "No longer asks")} />
        ))}
      </section>

      <section className="card b-3">
        <div className="card-head"><div><h2><GitBranch size={17} /> Repos</h2><p className="sub">Where models may branch, commit and open PRs. Never main.</p></div>
          <span className={`pill ${d.github_key ? "ok" : "warn"}`}>{d.github_key ? "Key set" : "No key yet"}</span></div>
        {!d.github_key && <p className="tiny dim" style={{ marginTop: 0 }}>Add GITHUB_AGENT_TOKEN on Vercel: a fine-grained key with contents and pull requests, for these repos only.</p>}
        <div className="stack" style={{ gap: 0 }}>
          {c.repos.map((r) => (
            <div key={r} className="sec-row">
              <GitBranch size={16} className="dim" />
              <div className="small au-wrap"><span className="mono">{r}</span>{r === d.platform ? <span className="dim"> · the studio itself: merges always wait for you</span> : null}</div>
              <button className="icon-btn danger-h" aria-label={`Remove ${r}`} title={`Remove ${r}`} disabled={busy}
                onClick={() => act("settings", { repos: c.repos.filter((x) => x !== r) }, `${r} removed`)}><X size={14} /></button>
            </div>
          ))}
          {!c.repos.length && <p className="tiny dim" style={{ margin: "4px 0 0" }}>None yet.</p>}
        </div>
        <form className="row" style={{ gap: 8, marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); if (repo.trim()) act("settings", { repos: [...c.repos, repo.trim()] }, `${repo.trim()} added`).then(() => setRepo("")); }}>
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" aria-label="Repo to allow" style={{ flex: 1, minWidth: 0 }} />
          <button className="ghost" disabled={busy || !repo.trim()}><Plus size={14} />Add</button>
        </form>
      </section>

      <section className="card b-6">
        <div className="card-head"><div><h2>Call log</h2><p className="sub">Every MCP call, with the model that made it. Last 2 days.</p></div>
          <Select size="sm" label="Model" style={{ width: 180, flex: "none" }} value={model} onChange={setModel} options={[["", "Every model"], ...models.map((m) => [m, m] as const)]} /></div>
        <div className="table-wrap au-log">
          <table className="table">
            <thead><tr><th>When</th><th>Model</th><th>Tool</th><th>Result</th><th className="au-num">Time</th></tr></thead>
            <tbody>
              {d.log.slice(0, 60).map((l, i) => (
                <tr key={`${l.t}-${i}`} title={l.args}>
                  <td className="dim small">{ago(l.t)}</td>
                  <td className="small">{l.model}{l.via ? <span className="dim"> · {l.via}</span> : null}</td>
                  <td className="mono small">{l.tool}</td>
                  <td className="small">{l.ok ? <span className="pill ok">ok</span> : <span className={`pill ${l.gate ? "warn" : "bad"}`} title={l.err}>{l.gate ? l.gate.toLowerCase() : "failed"}</span>}{l.job ? <span className="mono dim tiny"> {l.job}</span> : null}</td>
                  <td className="mono small au-num">{l.ms < 1000 ? `${l.ms} ms` : `${(l.ms / 1000).toFixed(1)} s`}</td>
                </tr>
              ))}
              {!d.log.length && <tr><td colSpan={5} className="dim small">No calls yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
