"use client";
// Settings → Claude & API → Other models: a key for each model (Gemini CLI or any MCP client) and the settings to
// paste into it, with the lean endpoint for cheaper models. A key names the model in the call log and can be held to
// a role; it's shown once, then only its name (server side: lib/auto/keys.ts). Making or revoking one never touches
// MCP_TOKEN, so nobody is signed out.
import { Copy, Key, Plus, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { Info } from "./Info";
import { Select } from "./pop";
import { Field, Toggle } from "./ui";

const ROLES = [["", "No role (every tool)"], ["researcher", "Researcher"], ["editor", "Editor"], ["publisher", "Publisher"], ["auditor", "Auditor"]] as const;
type K = { id: string; name: string; role?: string; at: number; by: string; used: number | null };
const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export default function OtherModels() {
  const { toast, confirm } = useDialog();
  const [lean, setLean] = useState(true);
  const [model, setModel] = useState("gemini");
  const [role, setRole] = useState<string>("");
  const [keys, setKeys] = useState<K[]>([]);
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<{ keys: K[] }>("automation/keys").then((r) => setKeys(r.keys)).catch(() => {}); }, []);
  useEffect(load, [load]);
  const origin = typeof window === "undefined" ? "" : location.origin;
  const url = `${origin}/api/mcp${lean ? "/lean" : ""}`;
  const json = JSON.stringify({ mcpServers: { voicebox: { httpUrl: url, headers: { Authorization: `Bearer ${fresh?.key ?? "<the model's key>"}` } } } }, null, 2);
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast("Copied", "ok")).catch(() => toast("Couldn't copy: select it and copy", "bad"));
  const make = async () => {
    setBusy(true);
    try {
      const r = await api<{ key: string; name: string }>("automation/keys", { body: { name: model, role: role || undefined } });
      setFresh(r); load();
    } catch (e) { toast((e as Error).message, "bad"); }
    setBusy(false);
  };
  return (
    <section className="card">
      <div className="card-head"><div><h2>Other models</h2><p className="sub">Gemini CLI or any MCP client: the same tools, the same approvals and log.</p></div>
        <Info label="Other models">Make a key for the model, then paste the settings into it (for Gemini CLI: ~/.gemini/settings.json, then /mcp to check). Each key shows in Settings → Automation → Call log under its name; a key with a role can only use that role&apos;s tools. Revoke it here and it stops at once. It opens the MCP only, never this dashboard.</Info></div>
      <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
        <Field label="Model name (for the log)" style={{ flex: 1, minWidth: 160, margin: 0 }}>
          <input value={model} onChange={(e) => setModel(e.target.value.replace(/[^\w .:/@+-]/g, "").slice(0, 60))} />
        </Field>
        <div className="field" style={{ flex: 1, minWidth: 160, margin: 0 }}>
          <label className="f" id="om-role">Role</label>
          <Select label="Role" value={role} onChange={setRole} options={ROLES} aria-describedby="om-role" />
        </div>
        <button disabled={busy || !model.trim()} onClick={make}><Plus size={15} /> Make a key</button>
      </div>
      {fresh && (
        <div className="uk-fresh" style={{ marginTop: 12 }}>
          <p className="small" style={{ margin: 0 }}><b>Copy {fresh.name}&apos;s key now.</b> It isn&apos;t shown again; the settings below already have it.</p>
          <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <input readOnly aria-label={`New key for ${fresh.name}`} value={fresh.key} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "var(--mono)", fontSize: 12.5 }} />
            <button className="ghost" onClick={() => copy(fresh.key)}><Copy size={14} />Copy</button>
          </div>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Toggle on={lean} set={setLean} title="Lean (for cheaper models)" about="Lists 6 tools instead of 84 and finds the rest on demand: about 1,700 tokens of tool definitions instead of 30,000 every session." />
      </div>
      <pre className="uk-recipe" style={{ marginTop: 12 }}>{json}</pre>
      <button className="ghost sm" onClick={() => copy(json)}><Copy size={13} />Copy the settings</button>
      <div className="stack" style={{ gap: 0, marginTop: 14 }}>
        {keys.map((k) => (
          <div key={k.id} className="sec-row">
            <Key size={18} className="dim" />
            <div style={{ minWidth: 0 }}>
              <div className="small" style={{ fontWeight: 600 }}>{k.name}{k.role ? <span className="dim"> · {k.role}</span> : null}</div>
              <div className="tiny dim">Made {when(k.at)} by {k.by} · {k.used ? `last used ${when(k.used)}` : "not used yet"}</div>
            </div>
            <button className="icon-btn danger-h" title={`Revoke ${k.name}'s key`} aria-label={`Revoke ${k.name}'s key`} disabled={busy} onClick={async () => {
              if (!(await confirm({ title: `Revoke ${k.name}'s key?`, body: "That model loses the studio at once. Other keys and Claude keep working.", confirm: "Revoke", danger: true }))) return;
              setBusy(true);
              try { await api("automation/keys", { body: { revoke: k.id } }); toast("Key revoked", "ok"); load(); } catch (e) { toast((e as Error).message, "bad"); }
              setBusy(false);
            }}><X size={15} /></button>
          </div>
        ))}
        {!keys.length && <p className="tiny dim" style={{ margin: "4px 0 0" }}>No model keys yet.</p>}
      </div>
    </section>
  );
}
