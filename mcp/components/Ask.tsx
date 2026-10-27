"use client";
// Ask Voicebox: the assistant panel (⌘J, the Ask button in the top bar, or "Ask Voicebox" in ⌘K). It does the work
// itself through the same tools Claude gets over MCP (lib/mcptools.ts): Gemini answers as it works (each tool call
// shows as a step), Antigravity runs on the Colab worker and fills in as it goes. Deletes, settings and GPU spending
// wait for an Approve click here. Chats are shared by both creators (R2 workspace/ask/).
import {
  ArrowUp, Check, CircleNotch, ClockCounterClockwise, GearSix, HandPalm, Plus, Sparkle, Trash, Warning, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useDialog } from "./Dialog";
import { PopMenu } from "./ui";

type Brain = "gemini" | "antigravity";
type Step = { tool: string; ok?: boolean; note?: string; waiting?: boolean };
type Msg = { id: string; role: "user" | "assistant"; text: string; at: number; by?: string; brain?: Brain; steps?: Step[]; error?: boolean };
type Approval = { id: string; tool: string; label: string; at: number; status: "waiting" | "done" | "declined" | "failed"; result?: string; by?: string };
type Convo = { id: string; title: string; updated: number; msgs: Msg[]; approvals: Approval[]; running?: { brain: Brain; since: number } | null };
type Summary = { id: string; title: string; updated: number; by: string; waiting: number };
type Brains = { brain: "auto" | Brain; gemini: boolean; antigravity: { signed_in: boolean; email: string | null; worker: boolean } };
type Live = { steps: (Step & { busy?: boolean })[]; text: string };

const Ctx = createContext<{ open: (prefill?: string) => void }>({ open: () => {} });
export const useAsk = () => useContext(Ctx);
const KEEP = "vb-ask-chat";

const STEP: Record<string, string> = {
  list_files: "Looked through Files", get_file: "Opened a file", create_folder: "Made a folder", update_folder: "Changed a folder", move_files: "Moved files",
  rename_file: "Renamed a file", star_files: "Starred", delete_files: "Trash", delete_folder: "Trash", restore_files: "Restored from the trash", empty_trash: "Empty the trash",
  workspace_board: "Read the board", get_post: "Read a post", create_post: "Made a post", update_post: "Updated a post", delete_post: "Delete a post", comment_on_post: "Commented",
  content_calendar: "Checked the calendar", workspace_activity: "Checked what changed", workspace_members: "Checked who's in", workspace_media: "Looked at uploads",
  voice_lines: "Voiced lines", get_job: "Checked a job", list_jobs: "Checked jobs", worker_status: "Checked the GPU", list_voices: "Listed voices", my_voices: "Listed your voices",
  imagine: "Made an image", transcribe: "Made subtitles", clean_audio: "Cleaned audio", revoice: "Re-voiced", get_settings: "Read settings", update_settings: "Settings",
  add_media: "Added a file", upload_media: "Uploaded a file", list_library: "Looked through the library", preview_pronunciation: "Checked pronunciation", gpu: "GPU",
};
const stepName = (t: string) => STEP[t] ?? t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const SUGGEST = [
  "Tidy up my Files: sort everything into sensible folders",
  "What's due this week, and what's still missing?",
  "Write 3 Short ideas for this week and put them on the board",
  "Which voiceovers did we make today?",
];

/** **bold**, `code`, links and "- " lists; everything else plain text (never HTML). */
function Rich({ text }: { text: string }) {
  const inline = (s: string, k: string) => s.split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+|\/files\?[^\s)]+)/g).map((p, i) => {
    if (/^\*\*.+\*\*$/.test(p)) return <b key={`${k}${i}`}>{p.slice(2, -2)}</b>;
    if (/^`.+`$/.test(p)) return <code key={`${k}${i}`}>{p.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(p)) return <a key={`${k}${i}`} href={p} target="_blank" rel="noreferrer">{p.replace(/^https?:\/\//, "").slice(0, 48)}{p.length > 56 ? "…" : ""}</a>;
    if (/^\/files\?/.test(p)) return <Link key={`${k}${i}`} href={p}>Open in Files</Link>;
    return <Fragment key={`${k}${i}`}>{p}</Fragment>;
  });
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l, `li${blocks.length}-${i}`)}</li>)}</ul>); list = []; };
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (m) { list.push(m[1]); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line.replace(/^#+\s*/, ""), `p${blocks.length}`)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function Steps({ steps }: { steps: (Step & { busy?: boolean })[] }) {
  if (!steps.length) return null;
  return (
    <div className="ask-steps">
      {steps.map((s, i) => (
        <span key={i} className={`ask-step ${s.busy ? "busy" : s.waiting ? "wait" : s.ok === false ? "bad" : ""}`} title={s.note ?? s.tool}>
          {s.busy ? <CircleNotch size={12} className="spin" /> : s.waiting ? <HandPalm size={12} weight="fill" /> : s.ok === false ? <Warning size={12} weight="fill" /> : <Check size={12} weight="bold" />}
          {stepName(s.tool)}{s.waiting ? " · needs your OK" : ""}
        </span>
      ))}
    </div>
  );
}

function ApprovalCard({ a, onDecide, busy }: { a: Approval; onDecide: (approve: boolean) => void; busy: boolean }) {
  return (
    <div className={`ask-approve ${a.status}`}>
      <div className="aa-text">
        <b>{a.status === "waiting" ? "Needs your OK" : a.status === "done" ? "Approved" : a.status === "declined" ? "Declined" : "Didn't work"}</b>
        <span>{a.label}</span>
        {a.status !== "waiting" && a.by && <span className="tiny faint">by {a.by}</span>}
      </div>
      {a.status === "waiting" && (
        <div className="aa-btns">
          <button className="sm ghost" disabled={busy} onClick={() => onDecide(false)}>Decline</button>
          <button className="sm primary" disabled={busy} onClick={() => onDecide(true)}>{busy ? <CircleNotch size={14} className="spin" /> : <Check size={14} weight="bold" />}Approve</button>
        </div>
      )}
    </div>
  );
}

async function askApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`/api/ask${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"), headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined, cache: "no-store",
  });
  if (r.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d as T;
}
export { askApi };

function Panel({ onClose, prefill }: { onClose: () => void; prefill: string }) {
  const { toast } = useDialog();
  const [convo, setConvo] = useState<Convo | null>(null);
  const [chats, setChats] = useState<Summary[]>([]);
  const [brains, setBrains] = useState<Brains | null>(null);
  const [text, setText] = useState(prefill);
  const [live, setLive] = useState<Live | null>(null);
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const loadList = useCallback(() => askApi<{ chats: Summary[] } & Brains>("").then((r) => { setChats(r.chats); setBrains(r); }).catch(() => null), []);
  const openChat = useCallback(async (id: string | null) => {
    setLive(null);
    try { localStorage.setItem(KEEP, id ?? ""); } catch {}
    if (!id) { setConvo(null); return; }
    setConvo(await askApi<Convo>(`/c/${id}`).catch(() => null));
  }, []);

  useEffect(() => {
    loadList();
    let id = "";
    try { id = localStorage.getItem(KEEP) ?? ""; } catch {}
    if (id) openChat(id);
    setTimeout(() => { input.current?.focus(); const n = input.current?.value.length ?? 0; input.current?.setSelectionRange(n, n); }, 30);
  }, [loadList, openChat]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".popmenu")) onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  // a running Antigravity message (or one another person started) fills in while the panel is open
  useEffect(() => {
    if (!convo?.running || sending) return;
    const t = setInterval(async () => {
      const c = await askApi<Convo>(`/c/${convo.id}`).catch(() => null);
      if (c) setConvo(c);
      if (c && !c.running) { loadList(); dispatchEvent(new Event("vb-files-changed")); }
    }, 1500);
    return () => clearInterval(t);
  }, [convo?.id, convo?.running, sending, loadList]);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [convo?.msgs.length, convo?.approvals.length, live?.steps.length, live?.text]);

  const send = async (raw?: string) => {
    const t = (raw ?? text).trim();
    if (!t || sending) return;
    setSending(true);
    setText("");
    const optimistic: Msg = { id: `tmp${Date.now()}`, role: "user", text: t, at: Date.now() };
    setConvo((c) => (c ? { ...c, msgs: [...c.msgs, optimistic] } : { id: "", title: t, updated: Date.now(), msgs: [optimistic], approvals: [], running: null }));
    setLive({ steps: [], text: "" });
    try {
      const r = await fetch("/api/ask/c", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, id: convo?.id || undefined }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
      if ((r.headers.get("content-type") ?? "").includes("ndjson") && r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = JSON.parse(line) as { t: string; convo?: Convo; tool?: string; ok?: boolean; note?: string; text?: string; waiting?: boolean };
            if (ev.t === "convo" && ev.convo) { setConvo(ev.convo); try { localStorage.setItem(KEEP, ev.convo.id); } catch {} }
            if (ev.t === "step") setLive((l) => ({ text: l?.text ?? "", steps: [...(l?.steps ?? []), { tool: ev.tool!, busy: true }] }));
            if (ev.t === "result") {
              setLive((l) => { const steps = [...(l?.steps ?? [])]; const i = steps.map((s) => s.busy).lastIndexOf(true); if (i >= 0) steps[i] = { tool: steps[i].tool, ok: ev.ok, note: ev.note, waiting: ev.waiting }; return { text: l?.text ?? "", steps }; });
              if (ev.waiting && convo?.id) askApi<Convo>(`/c/${convo.id}`).then(setConvo).catch(() => null);
            }
            if (ev.t === "text") setLive((l) => ({ steps: l?.steps ?? [], text: ev.text ?? "" }));
            if (ev.t === "done" && ev.convo) { setConvo(ev.convo); setLive(null); }
          }
        }
        dispatchEvent(new Event("vb-files-changed"));
      } else {
        const c = (await r.json()) as Convo;
        setConvo(c);
        setLive(null);
        try { localStorage.setItem(KEEP, c.id); } catch {}
      }
    } catch (e) {
      toast((e as Error).message, "bad");
      setText(t);
      setConvo((c) => (c ? { ...c, msgs: c.msgs.filter((m) => m.id !== optimistic.id) } : c));
      setLive(null);
    } finally {
      setSending(false);
      loadList();
      setTimeout(() => input.current?.focus(), 0);
    }
  };

  const decide = async (a: Approval, approve: boolean) => {
    if (!convo) return;
    setDeciding(a.id);
    try { setConvo(await askApi<Convo>(`/c/${convo.id}/decide`, { body: { approval: a.id, approve } })); dispatchEvent(new Event("vb-files-changed")); loadList(); }
    catch (e) { toast((e as Error).message, "bad"); }
    finally { setDeciding(null); }
  };

  const setBrain = async (brain: Brains["brain"]) => {
    try { setBrains(await askApi<Brains>("/prefs", { body: { brain } })); } catch (e) { toast((e as Error).message, "bad"); }
  };

  const remove = async (id: string) => {
    await askApi(`/c/${id}`, { method: "DELETE" }).catch(() => null);
    if (convo?.id === id) openChat(null);
    loadList();
  };

  const waiting = convo?.approvals.filter((a) => a.status === "waiting") ?? [];
  // messages and settled approvals, in the order they happened
  const timeline = useMemo(() => [
    ...(convo?.msgs ?? []).map((m) => ({ at: m.at, m })),
    ...(convo?.approvals ?? []).filter((a) => a.status !== "waiting").map((a) => ({ at: a.at, a })),
  ].sort((x, y) => x.at - y.at), [convo?.msgs, convo?.approvals]);
  const brainLabel = !brains ? "…" : brains.brain === "auto"
    ? `Auto · ${brains.antigravity.signed_in && brains.antigravity.worker ? "Antigravity" : brains.gemini ? "Gemini" : "not set up"}`
    : brains.brain === "gemini" ? "Gemini" : "Antigravity";
  const ready = !!brains && (brains.gemini || brains.antigravity.signed_in);
  const working = sending || !!convo?.running;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="ask" ref={box} role="dialog" aria-modal="true" aria-labelledby="ask-title">
        <div className="ask-head">
          <span className="ask-mark" aria-hidden><Sparkle size={16} weight="fill" /></span>
          <div className="ask-ttl">
            <h2 id="ask-title">Ask Voicebox</h2>
            <PopMenu align="left" width={260} trigger={({ toggle, ref, open }) => (
              <button ref={ref} className="ask-brain" onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label={`Brain: ${brainLabel}. Change`}>{brainLabel}</button>
            )}>
              {(close) => (
                <>
                  {(["auto", "gemini", "antigravity"] as const).map((b) => (
                    <button key={b} className="pm-item" role="menuitemradio" aria-checked={brains?.brain === b} onClick={() => { setBrain(b); close(); }}>
                      <span className="ic">{brains?.brain === b ? <Check size={14} weight="bold" /> : null}</span>
                      <span className="pm-2">
                        <b>{b === "auto" ? "Auto" : b === "gemini" ? "Gemini (API key)" : "Antigravity (your Google plan)"}</b>
                        <span>{b === "auto" ? "Antigravity when the worker is on, else Gemini" : b === "gemini" ? (brains?.gemini ? "Ready" : "Needs GEMINI_API_KEY") : brains?.antigravity.signed_in ? (brains.antigravity.worker ? "Ready on the worker" : "Signed in · worker off") : "Not signed in"}</span>
                      </span>
                    </button>
                  ))}
                  <hr />
                  <Link className="pm-item" role="menuitem" href="/settings#ask" onClick={() => { close(); onClose(); }}><GearSix size={16} className="ic" />Set up in Settings</Link>
                </>
              )}
            </PopMenu>
          </div>
          <PopMenu width={300} trigger={({ toggle, ref, open }) => (
            <button ref={ref} className="icon-btn sm" onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label="Past chats"><ClockCounterClockwise size={17} /></button>
          )}>
            {(close) => (
              <>
                {!chats.length && <div className="pm-note">No chats yet.</div>}
                {chats.slice(0, 20).map((c) => (
                  <div key={c.id} className="ask-hist">
                    <button className="pm-item" role="menuitem" onClick={() => { openChat(c.id); close(); }}>
                      <span className="pm-2"><b className="ellipsis">{c.title}</b><span>{c.by} · {new Date(c.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{c.waiting ? ` · ${c.waiting} waiting` : ""}</span></span>
                    </button>
                    <button className="icon-btn sm" aria-label={`Delete chat “${c.title}”`} onClick={() => remove(c.id)}><Trash size={14} /></button>
                  </div>
                ))}
              </>
            )}
          </PopMenu>
          <button className="icon-btn sm" onClick={() => openChat(null)} aria-label="New chat" disabled={working}><Plus size={17} /></button>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>

        <div className="ask-body" ref={scroller} aria-live="polite">
          {!convo?.msgs.length && (
            <div className="ask-hello">
              <span className="ask-orb" aria-hidden><Sparkle size={26} weight="fill" /></span>
              <h3>What should I do?</h3>
              <p>I can sort files, plan and write posts, voice scripts, make images and subtitles. Deleting and anything that spends GPU time waits for your OK.</p>
              {brains && !ready && <p className="ask-warn"><Warning size={14} weight="fill" /> No brain set up yet: <Link href="/settings#ask" onClick={onClose}>Settings → Ask Voicebox</Link></p>}
              <div className="ask-sugs">
                {SUGGEST.map((s) => <button key={s} className="ask-sug" onClick={() => send(s)} disabled={!ready || sending}>{s}</button>)}
              </div>
            </div>
          )}
          {timeline.map((x) => ("a" in x ? <ApprovalCard key={x.a.id} a={x.a} busy={false} onDecide={() => {}} /> : (
            <div key={x.m.id} className={`ask-msg ${x.m.role} ${x.m.error ? "err" : ""}`}>
              {x.m.role === "user" && <span className="ask-by">{x.m.by ?? "You"}</span>}
              {x.m.role === "assistant" && <Steps steps={x.m.steps ?? []} />}
              {x.m.role === "assistant" && !x.m.text && convo?.running ? <div className="ask-typing"><i /><i /><i /></div> : <div className="ask-text"><Rich text={x.m.text} /></div>}
            </div>
          )))}
          {live && (
            <div className="ask-msg assistant">
              <Steps steps={live.steps} />
              {live.text ? <div className="ask-text"><Rich text={live.text} /></div> : <div className="ask-typing"><i /><i /><i /></div>}
            </div>
          )}
        </div>

        {!!waiting.length && (
          <div className="ask-waiting">
            {waiting.map((a) => <ApprovalCard key={a.id} a={a} busy={deciding === a.id} onDecide={(ok) => decide(a, ok)} />)}
          </div>
        )}

        <form className="ask-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <label htmlFor="ask-input" className="sr-only">Message Ask Voicebox</label>
          <textarea id="ask-input" ref={input} rows={1} value={text} placeholder={working ? "Working on it…" : "Ask me to do something…"} maxLength={20000}
            onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <button type="submit" className="ask-send primary" disabled={!text.trim() || working} aria-label="Send">{working ? <CircleNotch size={16} className="spin" /> : <ArrowUp size={16} weight="bold" />}</button>
        </form>
      </div>
    </>
  );
}

export function AskProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const ctx = useMemo(() => ({ open: (prefill?: string) => setOpen(prefill ?? "") }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setOpen((o) => (o === null ? "" : null)); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <Ctx.Provider value={ctx}>
      {children}
      {open !== null && <Panel prefill={open} onClose={() => setOpen(null)} />}
    </Ctx.Provider>
  );
}

/** The top bar's Ask button. */
export function AskButton() {
  const { open } = useAsk();
  return <button className="sm ask-btn" onClick={() => open()} aria-label="Ask Voicebox (⌘J)" title="Ask Voicebox (⌘J)"><Sparkle size={15} weight="fill" /><span className="hide-sm">Ask</span></button>;
}
