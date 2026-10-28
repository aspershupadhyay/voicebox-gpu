"use client";
// Share a carousel or folder with a private, expiring link (lib/shares.ts).
import { Check, CopySimple, LinkSimple, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { Select } from "./pop";
import { Toggle } from "./ui";

function useEsc(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
}

type ShareRow = { id: string; created: number; expires: number; views: number; downloads: boolean; by: string; state: "active" | "expired" | "revoked" };
const until = (t: number) => { const h = (t - Date.now()) / 3600_000; return h <= 0 ? "ended" : h < 48 ? `${Math.max(1, Math.round(h))} h left` : `${Math.round(h / 24)} days left`; };

export function ShareDialog({ kind, refId, name, onClose }: { kind: "carousel" | "folder"; refId: string; name: string; onClose: () => void }) {
  const { toast } = useDialog();
  const [days, setDays] = useState(7);
  const [downloads, setDownloads] = useState(true);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [copied, setCopied] = useState(false);
  useEsc(onClose);
  const load = () => api<{ shares: ShareRow[] }>(`files/shares?kind=${kind}&ref=${encodeURIComponent(refId)}`).then((r) => setRows(r.shares.filter((s) => s.state === "active"))).catch(() => setRows([]));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function make() {
    setBusy(true);
    try {
      const r = await api<{ url: string }>("files/shares", { body: { kind, ref: refId, days, downloads } });
      setMade(r.url); load();
      try { await navigator.clipboard.writeText(r.url); setCopied(true); } catch { /* the field is there to copy by hand */ }
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    try { await api(`files/shares/${id}/revoke`, { body: {} }); setRows((x) => x?.filter((r) => r.id !== id) ?? null); toast("Link turned off"); }
    catch (e) { toast((e as Error).message, "bad"); }
  }
  return (
    <>
      <div className="scrim-modal" onClick={onClose} />
      <div className="modal sh-dlg" role="dialog" aria-modal="true" aria-labelledby="sh-title">
        <div className="row between" style={{ flexWrap: "nowrap" }}><h3 id="sh-title" className="ellipsis">Share “{name}”</h3>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p className="small dim" style={{ margin: "4px 0 14px" }}>Anyone with the link sees this {kind === "carousel" ? "carousel" : "folder and what's in it"}, and nothing else. No account needed; it stops working when it runs out or you turn it off.</p>
        {made ? (
          <div className="sh-made">
            <input readOnly value={made} aria-label="The share link" onFocus={(e) => e.currentTarget.select()} />
            <button className="sm" onClick={async () => { try { await navigator.clipboard.writeText(made); setCopied(true); } catch { toast("Select the link and copy it", "bad"); } }}>
              {copied ? <><Check size={14} weight="bold" />Copied</> : <><CopySimple size={14} />Copy</>}
            </button>
          </div>
        ) : (
          <div className="sh-form">
            <label className="small">Works for <Select size="sm" label="How long the link works" value={days} onChange={(v) => setDays(Number(v))} options={[[1, "1 day"], [3, "3 days"], [7, "7 days"], [30, "30 days"]] as const} style={{ width: "auto" }} /></label>
            <Toggle on={downloads} set={setDownloads} title="Allow downloads" about="Off: they can look, not save the originals" />
            <button onClick={make} disabled={busy} aria-busy={busy}><LinkSimple size={15} weight="bold" />{busy ? "Making…" : "Make the link"}</button>
          </div>
        )}
        {made && <p className="tiny dim" style={{ marginTop: 8 }}>This is the only time the link shows. Lost it? Make another and turn this one off.</p>}
        {!!rows?.length && (
          <div className="sh-list">
            <b className="tiny dim">Links that work now</b>
            {rows.map((r) => (
              <div key={r.id} className="sh-row">
                <LinkSimple size={14} className="dim" />
                <span className="small ellipsis">Made by {r.by.split(" ")[0]} · {until(r.expires)} · {r.views} view{r.views === 1 ? "" : "s"}{r.downloads ? "" : " · no downloads"}</span>
                <button className="quiet xs" onClick={() => revoke(r.id)}>Turn off</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
