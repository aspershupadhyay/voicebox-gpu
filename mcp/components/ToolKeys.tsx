"use client";
// Settings → Automation → Keys: the keys the tools use (GitHub for repo, Brave or Tavily for search), pasted here
// instead of on Vercel. Saved encrypted, never shown again (only the last 4 characters), never given to a model.
// Server side: lib/auto/secrets.ts.
import { Key, X } from "@phosphor-icons/react";
import { useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { Info } from "./Info";

export type KeyStatus = { from: "dashboard" | "vercel" | "unreadable" | "none"; last4?: string; at?: number; by?: string; note?: string };
const ROWS = [
  { name: "github", title: "GitHub key", hint: "A fine-grained key: Contents, Pull requests and Issues read and write, Checks and Actions read, for the repos above only.", placeholder: "github_pat_…" },
  { name: "search", title: "Search key", hint: "Optional. A Brave Search or Tavily key, for workflows and scripts that search with no chat model.", placeholder: "Brave key or tvly-…" },
] as const;

function where(s: KeyStatus) {
  if (s.from === "dashboard") return `Saved · ends …${s.last4}${s.note ? ` · ${s.note}` : ""}${s.by ? ` · by ${s.by}` : ""}`;
  if (s.from === "vercel") return "Set on Vercel";
  if (s.from === "unreadable") return "Saved before MCP_TOKEN changed: paste it again";
  return "Not set";
}

export default function ToolKeys({ keys, reload }: { keys: Record<string, KeyStatus>; reload: () => void }) {
  const { toast, confirm } = useDialog();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const save = async (name: string, value: string | null, ok: string) => {
    setBusy(name);
    try { await api("automation/secret", { body: { name, value } }); toast(ok, "ok"); setVals((v) => ({ ...v, [name]: "" })); reload(); }
    catch (e) { toast((e as Error).message, "bad"); }
    setBusy("");
  };
  return (
    <section className="card b-6">
      <div className="card-head"><div><h2><Key size={17} /> Keys</h2><p className="sub">The keys the tools use. Models use them through the MCP but never see them.</p></div>
        <Info label="Keys">Saved encrypted and never shown again, only the last 4 characters. A key saved here wins over the same key on Vercel. Remove it and the tool stops using it at once.</Info></div>
      <div className="stack" style={{ gap: 0 }}>
        {ROWS.map((r) => {
          const s = keys[r.name] ?? { from: "none" };
          const set = s.from === "dashboard" || s.from === "vercel";
          return (
            <div key={r.name} className="au-key">
              <div className="au-key-head">
                <div style={{ minWidth: 0 }}>
                  <div className="small" style={{ fontWeight: 600 }}>{r.title}</div>
                  <div className="tiny dim">{r.hint}</div>
                </div>
                <span className={`pill ${set ? "ok" : s.from === "unreadable" ? "bad" : "outline"}`}>{where(s)}</span>
              </div>
              <form className="row" style={{ gap: 8, flexWrap: "nowrap" }} onSubmit={(e) => { e.preventDefault(); if (vals[r.name]?.trim()) save(r.name, vals[r.name], `${r.title} saved`); }}>
                <input type="password" autoComplete="off" spellCheck={false} value={vals[r.name] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [r.name]: e.target.value }))}
                  placeholder={s.from === "dashboard" ? "Paste a new one to replace it" : r.placeholder} aria-label={r.title} style={{ flex: 1, minWidth: 0, fontFamily: "var(--mono)" }} />
                <button className="ghost" disabled={!!busy || !vals[r.name]?.trim()}>{busy === r.name ? "Checking…" : "Save"}</button>
                {s.from === "dashboard" && (
                  <button type="button" className="icon-btn danger-h" aria-label={`Remove the ${r.title}`} title={`Remove the ${r.title}`} disabled={!!busy} onClick={async () => {
                    if (await confirm({ title: `Remove the ${r.title}?`, body: "The tools stop using it at once.", confirm: "Remove", danger: true })) save(r.name, null, `${r.title} removed`);
                  }}><X size={14} /></button>
                )}
              </form>
            </div>
          );
        })}
      </div>
    </section>
  );
}
