"use client";
// The page behind an upload link (app/u/[token], lib/auto/uplinks.ts): drop images or videos from a phone or a computer
// and they land in one folder of the studio (usually a model's project). It can't see or change anything else.
import { CheckCircle, CloudArrowUp, FolderSimple, WarningCircle } from "@phosphor-icons/react";
import { useRef, useState } from "react";

type Link = { folder: string; by: string; expires: number; max: number } | null;
type Row = { name: string; frac: number; state: "up" | "done" | "bad"; err?: string };

const left = (t: number) => { const h = Math.max(0, (t - Date.now()) / 3600_000); return h < 1 ? "less than an hour" : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`; };

export function UploadLink({ token, link }: { token: string; link: Link }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  if (!link) {
    return (
      <main className="sh sh-gone">
        <div className="sh-logo"><img src="/icon.svg" alt="" width={28} height={28} /><b>Voicebox</b></div>
        <h1>This link doesn&apos;t work any more</h1>
        <p className="dim">It ran out or was used up. Ask whoever sent it for a new one.</p>
      </main>
    );
  }
  const post = async (body: unknown) => {
    const r = await fetch(`/api/u/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  const set = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));
  async function send(files: FileList | File[]) {
    const list = [...files];
    const base = rows.length;
    setRows((rs) => [...rs, ...list.map((f) => ({ name: f.name, frac: 0, state: "up" as const }))]);
    await Promise.all(list.map(async (f, n) => {
      const i = base + n;
      try {
        const s = await post({ action: "start", name: f.name, size: f.size, type: f.type });
        await new Promise<void>((ok, bad) => {
          const x = new XMLHttpRequest();
          x.open("PUT", s.upload_url);
          if (f.type) x.setRequestHeader("Content-Type", f.type);
          x.upload.onprogress = (e) => e.lengthComputable && set(i, { frac: e.loaded / e.total });
          x.onload = () => (x.status < 300 ? ok() : bad(new Error(`storage said ${x.status}`)));
          x.onerror = () => bad(new Error("the upload dropped: try again"));
          x.send(f);
        });
        await post({ action: "complete", tickets: [s.ticket] });
        set(i, { frac: 1, state: "done" });
      } catch (e) { set(i, { state: "bad", err: (e as Error).message }); }
    }));
  }
  const done = rows.filter((r) => r.state === "done").length;
  return (
    <main className="sh ul">
      <header className="sh-head">
        <div className="sh-logo"><img src="/icon.svg" alt="" width={24} height={24} /><b>Voicebox</b></div>
        <div className="sh-title">
          <span className="tiny dim row" style={{ gap: 6 }}><FolderSimple size={13} weight="bold" />Send files · asked by {link.by}</span>
          <h1>{link.folder}</h1>
          <span className="tiny dim">Up to {link.max} files · this link works for {left(link.expires)}</span>
        </div>
      </header>
      <label className={`ul-drop ${over ? "on" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) send(e.dataTransfer.files); }}>
        <CloudArrowUp size={30} />
        <b>Drop photos or videos here</b>
        <span className="dim small">or tap to choose them</span>
        <input ref={pick} type="file" multiple accept="image/*,video/*,audio/*" aria-label="Choose files to send" onChange={(e) => { if (e.target.files?.length) send(e.target.files); e.target.value = ""; }} />
      </label>
      {rows.length > 0 && (
        <ol className="ul-list" aria-live="polite">
          {rows.map((r, i) => (
            <li key={i}>
              <span className="ellipsis small">{r.name}</span>
              {r.state === "done" ? <span className="pill ok"><CheckCircle size={12} weight="bold" />Sent</span>
                : r.state === "bad" ? <span className="pill bad" title={r.err}><WarningCircle size={12} weight="bold" />{r.err}</span>
                  : <span className="ul-bar" role="progressbar" aria-label={`${r.name} uploading`} aria-valuenow={Math.round(r.frac * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(r.frac * 100)}%` }} /></span>}
            </li>
          ))}
        </ol>
      )}
      {done > 0 && <p className="small dim" style={{ textAlign: "center" }}>{done} sent. You can close this page; the model sees them in the folder.</p>}
    </main>
  );
}
