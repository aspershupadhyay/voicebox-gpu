"use client";
// Settings → Claude & API → Other models: how Gemini CLI (or any MCP client) connects, with the lean endpoint for
// cheaper models, its name for the call log (X-Model) and a role (X-Role). The key itself is never shown here.
import { Copy } from "@phosphor-icons/react";
import { useState } from "react";
import { useDialog } from "./Dialog";
import { Info } from "./Info";
import { Select } from "./pop";
import { Field, Toggle } from "./ui";

const ROLES = [["", "No role (every tool)"], ["researcher", "Researcher"], ["editor", "Editor"], ["publisher", "Publisher"], ["auditor", "Auditor"]] as const;

export default function OtherModels() {
  const { toast } = useDialog();
  const [lean, setLean] = useState(true);
  const [model, setModel] = useState("gemini");
  const [role, setRole] = useState<string>("");
  const origin = typeof window === "undefined" ? "" : location.origin;
  const url = `${origin}/api/mcp${lean ? "/lean" : ""}`;
  const headers: Record<string, string> = { Authorization: "Bearer <MCP_TOKEN>", "X-Model": model.trim() || "gemini", ...(role ? { "X-Role": role } : {}) };
  const json = JSON.stringify({ mcpServers: { voicebox: { httpUrl: url, headers } } }, null, 2);
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast("Copied", "ok")).catch(() => toast("Couldn't copy: select it and copy", "bad"));
  return (
    <section className="card">
      <div className="card-head"><div><h2>Other models</h2><p className="sub">Gemini CLI or any MCP client: the same tools, the same approvals and log.</p></div>
        <Info label="Other models">Put this in ~/.gemini/settings.json (Gemini CLI). Replace &lt;MCP_TOKEN&gt; with the MCP_TOKEN set on Vercel; never paste it into a chat. Every call shows in Settings → Automation → Call log under the model&apos;s name.</Info></div>
      <Toggle on={lean} set={setLean} title="Lean (for cheaper models)" about="Lists 6 tools instead of 84 and finds the rest on demand: about 1,700 tokens of tool definitions instead of 30,000 every session." />
      <div className="row" style={{ gap: 12, marginTop: 8, alignItems: "flex-end" }}>
        <Field label="Model name (for the log)" style={{ flex: 1, margin: 0 }}>
          <input value={model} onChange={(e) => setModel(e.target.value.replace(/[^\w .:/@+-]/g, "").slice(0, 60))} />
        </Field>
        <div className="field" style={{ flex: 1, margin: 0 }}>
          <label className="f" id="om-role">Role</label>
          <Select label="Role" value={role} onChange={setRole} options={ROLES} aria-describedby="om-role" />
        </div>
      </div>
      <pre className="uk-recipe" style={{ marginTop: 12 }}>{json}</pre>
      <button className="ghost sm" onClick={() => copy(json)}><Copy size={13} />Copy the settings</button>
    </section>
  );
}
