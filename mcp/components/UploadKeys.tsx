"use client";
// Settings → Upload keys: keys that let an AI or a script save files into Files (and nothing else), for videos and
// other files too big for MCP. Each is shown once when made; revoke it any time. Server side: lib/inbox.ts.
import { Copy, Key, Plus, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { Info } from "./Info";

type K = { id: string; name: string; at: number; by: string; used: number | null };
const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export default function UploadKeys() {
  const { toast, confirm } = useDialog();
  const [keys, setKeys] = useState<K[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<{ keys: K[] }>("upload-keys").then((r) => setKeys(r.keys)).catch(() => {}); }, []);
  useEffect(load, [load]);
  const origin = typeof window === "undefined" ? "" : location.origin;
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast("Copied", "ok")).catch(() => toast("Couldn't copy: select it and copy", "bad"));
  const recipe = `1. curl -sS -X POST ${origin}/api/files/upload -H "Authorization: Bearer ${fresh ?? "<key>"}" -H "Content-Type: application/json" -d '{"name":"clip.mp4","folder":"Videos"}'
2. curl -sS -T clip.mp4 "<upload_url>"
3. curl -sS -X POST ${origin}/api/files/complete -H "Authorization: Bearer ${fresh ?? "<key>"}" -H "Content-Type: application/json" -d '{"ticket":"<ticket>"}'`;

  return (
    <div className="card">
      <div className="card-head"><h2><Key size={17} /> Upload keys</h2>
        <Info label="Upload keys">For an AI or a script that makes files (a rendered video, say): it saves them straight into Files, up to 2 GB, without going through MCP&apos;s size limit. A key can only add files. Claude over MCP doesn&apos;t need one: it uses the save_file tool.</Info></div>
      {fresh && (
        <div className="uk-fresh">
          <p className="small" style={{ margin: 0 }}><b>Copy this key now.</b> It isn&apos;t shown again.</p>
          <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <input readOnly aria-label="New upload key" value={fresh} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "var(--mono)", fontSize: 12.5 }} />
            <button className="ghost" onClick={() => copy(fresh)}><Copy size={14} />Copy</button>
          </div>
        </div>
      )}
      <div className="stack" style={{ gap: 0, marginTop: 8 }}>
        {keys.map((k) => (
          <div key={k.id} className="sec-row">
            <Key size={18} className="dim" />
            <div style={{ minWidth: 0 }}>
              <div className="small" style={{ fontWeight: 600 }}>{k.name}</div>
              <div className="tiny dim">Made {when(k.at)} by {k.by} · {k.used ? `last used ${when(k.used)}` : "not used yet"}</div>
            </div>
            <button className="icon-btn danger-h" title={`Revoke ${k.name}`} aria-label={`Revoke ${k.name}`} disabled={busy} onClick={async () => {
              if (!(await confirm({ title: `Revoke ${k.name}?`, body: "Anything using it can't save files any more.", confirm: "Revoke", danger: true }))) return;
              setBusy(true);
              try { await api("upload-keys/revoke", { body: { id: k.id } }); toast("Key revoked", "ok"); load(); } catch (e) { toast((e as Error).message, "bad"); }
              setBusy(false);
            }}><X size={15} /></button>
          </div>
        ))}
        {!keys.length && !fresh && <p className="tiny dim" style={{ margin: "4px 0 0" }}>No keys yet.</p>}
      </div>
      <form className="row" style={{ gap: 8, marginTop: 12 }} onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { const r = await api<{ key: string }>("upload-keys", { body: { name } }); setFresh(r.key); setName(""); load(); } catch (err) { toast((err as Error).message, "bad"); }
        setBusy(false);
      }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What it's for, e.g. Video renderer" aria-label="Key name" style={{ flex: 1, minWidth: 200 }} maxLength={60} />
        <button className="ghost" disabled={busy}><Plus size={15} /> New key</button>
      </form>
      <details style={{ marginTop: 14 }}>
        <summary className="small">How a script uses it</summary>
        <pre className="uk-recipe">{recipe}</pre>
        <button className="ghost sm" onClick={() => copy(recipe)}><Copy size={13} />Copy the steps</button>
      </details>
    </div>
  );
}
