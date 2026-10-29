"use client";
// Create → Download: paste a link (Instagram, YouTube, TikTok, X, Pinterest, Cosmos, any page or file) and the photo
// or video lands in Files, in the folder picked here. Pasting a link into the empty bar (or anywhere on the page) starts
// it at once; several links, one per line, go together. Each row shows where it's at, live, and opens in Files when
// it's in. Instagram, YouTube and TikTok go through the GPU worker's yt-dlp; sign-in cookies for posts behind a login
// live under Sign-ins. The server side is lib/downloads.ts; styles under "download" in app/globals.css.
import {
  ArrowClockwise, ArrowSquareOut, CheckCircle, CloudArrowDown, FacebookLogo, FolderSimple, Globe, InstagramLogo, Key, LinkSimple, PinterestLogo, Planet,
  RedditLogo, ThreadsLogo, TiktokLogo, Warning, X, XLogo, YoutubeLogo, type Icon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { Select } from "./pop";
import { PageHeader } from "./ui";

type Source = "instagram" | "youtube" | "tiktok" | "x" | "pinterest" | "cosmos" | "facebook" | "threads" | "reddit" | "vimeo" | "web";
type Item = { media: string; name: string; kind: string; size: number; preview: string | null };
type Dl = { id: string; url: string; source: Source; status: "fetching" | "waiting" | "worker" | "saving" | "done" | "error"; via: string | null; title: string | null; author: string | null;
  thumb: string | null; folder: string | null; by: string; at: number; items: Item[]; error: string | null; pct: number | null; stage: string | null };
type Res = { list: Dl[]; cookies: { set: boolean }; worker: boolean };
type Folder = { id: string; name: string; parent: string | null; system?: boolean };

const SRC: Record<Source, { name: string; Icon: Icon; worker?: boolean }> = {
  instagram: { name: "Instagram", Icon: InstagramLogo, worker: true }, youtube: { name: "YouTube", Icon: YoutubeLogo, worker: true },
  tiktok: { name: "TikTok", Icon: TiktokLogo, worker: true }, x: { name: "X", Icon: XLogo }, pinterest: { name: "Pinterest", Icon: PinterestLogo },
  cosmos: { name: "Cosmos", Icon: Planet }, facebook: { name: "Facebook", Icon: FacebookLogo, worker: true }, threads: { name: "Threads", Icon: ThreadsLogo, worker: true },
  reddit: { name: "Reddit", Icon: RedditLogo, worker: true }, vimeo: { name: "Vimeo", Icon: Globe, worker: true }, web: { name: "Any page", Icon: Globe },
};
const SHOWN: Source[] = ["instagram", "youtube", "tiktok", "x", "pinterest", "cosmos", "web"];

/** The same rules as lib/downloads.ts sourceOf, for the live hint while typing. */
function sourceOf(url: string): Source | null {
  let h: string;
  try { h = new URL(url).hostname.replace(/^(www|m|mobile)\./, "").toLowerCase(); } catch { return null; }
  if (/(^|\.)instagram\.com$|^instagr\.am$/.test(h)) return "instagram";
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return "youtube";
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  if (/^(x|twitter|fxtwitter|vxtwitter|fixupx)\.com$/.test(h)) return "x";
  if (/(^|\.)pinterest\.[a-z.]+$|^pin\.it$/.test(h)) return "pinterest";
  if (/(^|\.)cosmos\.so$/.test(h)) return "cosmos";
  if (/(^|\.)facebook\.com$|^fb\.watch$/.test(h)) return "facebook";
  if (/(^|\.)threads\.(net|com)$/.test(h)) return "threads";
  if (/(^|\.)reddit\.com$|^redd\.it$/.test(h)) return "reddit";
  if (/(^|\.)vimeo\.com$/.test(h)) return "vimeo";
  return "web";
}
const linksIn = (text: string) => [...new Set(text.split(/\s+/).map((x) => x.trim().replace(/[),.;]+$/, "")).filter((x) => /^https?:\/\/\S+\.\S+/i.test(x)))].slice(0, 20);
const active = (d: Dl) => d.status !== "done" && d.status !== "error";
const ago = (t: number) => { const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
const short = (url: string) => { try { const u = new URL(url); return `${u.hostname.replace(/^www\./, "")}${u.pathname.length > 1 ? u.pathname.slice(0, 40) : ""}`; } catch { return url; } };

function Row({ d, folderName, onRetry, onForget }: { d: Dl; folderName: string; onRetry: () => void; onForget: () => void }) {
  const s = SRC[d.source] ?? SRC.web;
  const on = active(d);
  const first = d.items[0];
  const pic = first?.preview ?? (d.thumb && /^https:/.test(d.thumb) ? d.thumb : null);
  const href = d.items.length === 1 ? `/files?file=${encodeURIComponent(`m:${d.items[0].media}`)}` : d.folder ? `/files?folder=${d.folder}` : "/files";
  return (
    <li className={`dl-row ${d.status}`}>
      <span className={`dl-thumb ${on ? "busy" : ""}`}>
        {pic ? <img src={pic} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : null}
        <s.Icon size={20} weight="duotone" className="dl-glyph" aria-hidden />
        {d.items.length > 1 && <b className="dl-n mono">{d.items.length}</b>}
        {on && <i className="dl-scan" aria-hidden />}
      </span>
      <span className="dl-main">
        <span className="dl-title ellipsis">{d.title || short(d.url)}</span>
        <span className="dl-meta tiny">
          <span className="dl-src"><s.Icon size={12} weight="bold" aria-hidden />{s.name}</span>
          {d.author && <span className="ellipsis">@{d.author.replace(/^@/, "")}</span>}
          <span className="ellipsis"><FolderSimple size={12} aria-hidden /> {folderName}</span>
          <span>{ago(d.at)}</span>
        </span>
        {on ? (
          <span className="dl-prog" role="progressbar" aria-label={d.stage ?? "Working"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((d.pct ?? 0) * 100)}>
            <span className="dl-meter"><i style={{ width: `${Math.max(4, (d.pct ?? 0) * 100)}%` }} /></span>
            <span className="tiny dim ellipsis">{d.stage ?? "Working"}</span>
          </span>
        ) : d.status === "error" ? (
          <span className="dl-err tiny"><Warning size={13} weight="bold" aria-hidden />{d.error}</span>
        ) : (
          <span className="dl-ok tiny"><CheckCircle size={13} weight="fill" aria-hidden />{d.items.length > 1 ? `${d.items.length} files` : first?.kind === "video" ? "Video" : first?.kind === "image" ? "Photo" : "File"} in Files{first?.size ? ` · ${(d.items.reduce((a, x) => a + x.size, 0) / 1e6).toFixed(1)} MB` : ""}</span>
        )}
      </span>
      <span className="dl-acts">
        {d.status === "done" && <Link href={href} className="btn ghost sm"><ArrowSquareOut size={14} />Open</Link>}
        {d.status === "error" && <button type="button" className="ghost sm" onClick={onRetry}><ArrowClockwise size={14} />Retry</button>}
        <a className="icon-btn sm" href={d.url} target="_blank" rel="noreferrer noopener" aria-label="Open the original" title="Open the original"><LinkSimple size={15} /></a>
        {!on && <button type="button" className="icon-btn sm" onClick={onForget} aria-label="Remove from the list (the files stay)" title="Remove from the list (the files stay)"><X size={15} /></button>}
      </span>
    </li>
  );
}

function SignIns({ set, onSaved }: { set: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useDialog();
  const save = async (value: string | null) => {
    setBusy(true);
    try { await api("downloads/cookies", { body: { text: value } }); setText(""); setOpen(false); onSaved(); toast(value ? "Sign-ins saved" : "Sign-ins removed", "ok"); }
    catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <section className="dl-signin">
      <button type="button" className="dl-si-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Key size={16} weight="duotone" aria-hidden /><b>Sign-ins</b><span className={`pill ${set ? "ok" : ""}`}>{set ? "Added" : "None"}</span>
        <span className="tiny dim grow">For YouTube's bot check and Instagram posts that need you logged in</span>
      </button>
      {open && (
        <div className="dl-si-body">
          <p className="small dim">Export your cookies from a browser where you're signed in (an extension such as “Get cookies.txt LOCALLY”) and paste the file here. It's kept privately in your storage, only ever sent to your own GPU worker, and never shown again.</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="# Netscape HTTP Cookie File…" aria-label="cookies.txt" spellCheck={false} />
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            {set && <button type="button" className="ghost sm" onClick={() => save(null)} disabled={busy}>Remove</button>}
            <button type="button" className="sm" onClick={() => save(text)} disabled={busy || !text.trim()}>Save sign-ins</button>
          </div>
        </div>
      )}
    </section>
  );
}

export default function Download() {
  const { toast } = useDialog();
  const [data, setData] = useState<Res | null>(null);
  const [text, setText] = useState("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState("Downloads");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const links = linksIn(text);

  const load = useCallback(() => api<Res>("downloads").then(setData).catch(() => null), []);
  useEffect(() => {
    load();
    api<{ folders: Folder[] }>("files").then((t) => setFolders((t.folders ?? []).filter((f) => !f.system))).catch(() => null);
    try { const f = localStorage.getItem("vb-dl-folder"); if (f) setFolder(f); } catch { /* private window */ }
    box.current?.focus();
  }, [load]);
  // live while something is moving, calm otherwise
  const busy = !!data?.list.some(active);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, busy ? 1500 : 15000);
    return () => clearInterval(t);
  }, [busy, load]);

  const start = useCallback(async (urls: string[]) => {
    if (!urls.length || sending) return;
    setSending(true);
    try {
      const r = await api<{ list: Dl[] }>("downloads", { body: { urls, folder } });
      setData((d) => (d ? { ...d, list: [...r.list, ...d.list.filter((x) => !r.list.some((y) => y.id === x.id))] } : d));
      setText("");
      setTimeout(load, 700);
    } catch (e) { toast((e as Error).message, "bad"); } finally { setSending(false); box.current?.focus(); }
  }, [folder, load, sending, toast]);

  // a link pasted into the empty bar, or anywhere on the page, starts straight away
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      const inBar = t === box.current;
      if (!inBar && t?.closest?.("input, textarea, [contenteditable=true]")) return;
      if (inBar && text.trim()) return; // adding to what's typed: just paste
      const got = linksIn(e.clipboardData?.getData("text/plain") ?? "");
      if (!got.length) return;
      e.preventDefault();
      start(got);
    };
    addEventListener("paste", onPaste);
    return () => removeEventListener("paste", onPaste);
  }, [start, text]);

  const folderName = useMemo(() => { const m = new Map(folders.map((f) => [f.id, f.name])); return (id: string | null) => (id ? m.get(id) ?? "Downloads" : "Files"); }, [folders]);
  const pick = (v: string) => { setFolder(v); try { localStorage.setItem("vb-dl-folder", v); } catch { /* private window */ } };
  const opts = useMemo(() => {
    const names = [...new Set(["Downloads", ...folders.map((f) => f.name)])];
    return names.map((n) => [n, n] as const);
  }, [folders]);
  const hint = links.map(sourceOf).filter(Boolean) as Source[];
  const needsWorker = hint.some((h) => SRC[h].worker);
  const list = data?.list ?? [];

  return (
    <div className="dl">
      <PageHeader title="Download" sub="Paste a link from Instagram, YouTube, TikTok, X, Pinterest, Cosmos or any page. The photo or video lands in Files, ready to post." />

      <form className={`dl-bar ${links.length ? "has" : ""} ${sending ? "sending" : ""}`} onSubmit={(e) => { e.preventDefault(); start(links); }}>
        <span className="dl-br tl" /><span className="dl-br tr" /><span className="dl-br bl" /><span className="dl-br br" />
        <div className="dl-in">
          <CloudArrowDown size={22} weight="duotone" className="dl-in-ic" aria-hidden />
          <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={1} aria-label="Links to download"
            placeholder="Paste a link… (several, one per line)" spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(links); } }} />
        </div>
        <div className="dl-under">
          <div className="dl-found" aria-live="polite">
            {links.length ? hint.map((h, i) => { const S = SRC[h]; return <span key={i} className="dl-chip" style={{ animationDelay: `${i * 40}ms` }}><S.Icon size={13} weight="bold" aria-hidden />{S.name}</span>; })
              : <span className="tiny dim">Press Enter, or just paste: it starts on its own.</span>}
            {needsWorker && <span className={`tiny ${data?.worker ? "dim" : "warn-t"}`}>{data?.worker ? "· through the GPU worker" : "· needs the GPU worker: it waits until it's on"}</span>}
          </div>
          <div className="dl-go">
            <Select size="sm" label="Save to" value={folder} onChange={pick} options={opts} className="dl-folder" />
            <button type="submit" disabled={!links.length || sending} aria-busy={sending}>{sending ? <span className="vp-spin sm" /> : <CloudArrowDown size={16} weight="bold" />}Download{links.length > 1 ? ` ${links.length}` : ""}</button>
          </div>
        </div>
      </form>

      <ul className="dl-sources" aria-label="Where it downloads from">
        {SHOWN.map((k, i) => { const S = SRC[k]; return (
          <li key={k} style={{ animationDelay: `${i * 45}ms` }} title={S.worker ? `${S.name}: through the GPU worker (${data?.worker ? "on" : "off"})` : `${S.name}: straight from the server`}>
            <S.Icon size={15} weight="duotone" aria-hidden />{S.name}{S.worker && <i className={`dl-w ${data?.worker ? "on" : ""}`} aria-label={data?.worker ? "worker on" : "worker off"} />}
          </li>
        ); })}
      </ul>

      <section className="dl-list-wrap" aria-label="Downloads">
        <div className="dl-list-head"><b>Recent</b><span className="tiny dim">{list.length ? `${list.filter((d) => d.status === "done").length} in Files${busy ? ` · ${list.filter(active).length} working` : ""}` : ""}</span></div>
        {!data ? (
          <ul className="dl-list">{[0, 1, 2].map((i) => <li key={i} className="dl-row skel"><span className="dl-thumb" /><span className="dl-main"><span className="dl-sk" /><span className="dl-sk s" /></span></li>)}</ul>
        ) : list.length ? (
          <ul className="dl-list">
            {list.map((d) => (
              <Row key={d.id} d={d} folderName={folderName(d.folder)}
                onRetry={() => api(`downloads/${d.id}/retry`, { body: {} }).then(load).catch((e) => toast((e as Error).message, "bad"))}
                onForget={() => { setData((x) => (x ? { ...x, list: x.list.filter((y) => y.id !== d.id) } : x)); api(`downloads/${d.id}`, { method: "DELETE" }).catch(() => load()); }} />
            ))}
          </ul>
        ) : (
          <div className="dl-empty"><span className="dl-empty-px" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 80}ms` }} />)}</span><b>Nothing downloaded yet</b><span className="small dim">Copy a link from any app and paste it here. Claude can do it too: “download this reel into Case 026”.</span></div>
        )}
      </section>

      <SignIns set={!!data?.cookies.set} onSaved={load} />
    </div>
  );
}
