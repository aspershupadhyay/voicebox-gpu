"use client";
// The Auto-DM inbox (/auto-dm?tab=inbox&c=<account>.<psid>): every Instagram conversation, the bot's messages and
// people's, in one place. Answer by hand (inside Instagram's 24-hour window), and the bot steps back for that person a
// while (Settings → Inbox); pause or hand back the bot, tag, note, mark done. Saved replies drop in with one tap. The list
// and the open thread refresh every few seconds while the tab is visible; both paint at once from the last copy.
import { ArrowLeft, Check, ChatCircleDots, Lightning, MagnifyingGlass, NotePencil, PaperPlaneRight, Pause, Play, Tag, Robot, User, CheckCircle, ArrowCounterClockwise } from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, peek } from "../api";
import { useDialog } from "../Dialog";
import { Select } from "../pop";
import { Empty } from "../ui";
import { Chips, ago, handleOf, useDebounced, type Overview } from "./shared";

type Person = {
  account: string; psid: string; username: string | null; name: string | null; avatar: string | null; tags: string[]; notes: string | null;
  bot_off_until: string | null; state: "open" | "done"; unread: number; last_in: string | null; last_out: string | null; last_text: string | null; last_dir: "in" | "out" | null; updated_at: string;
};
type Msg = { id: number; at: string; dir: "in" | "out"; text: string | null; by: string | null; kind: string | null };
type Ev = { id: number; at: string; kind: string; automation_name: string | null; status: string; clicked_at: string | null; note: string | null };
type List = { people: Person[]; counts: { open: number; unread: number; paused: number } };
type Thread = { messages: Msg[]; person: Person | null; events: Ev[]; more: boolean };
type View = "open" | "unread" | "paused" | "done" | "all";

const who = (p: Person) => (p.username ? `@${p.username}` : p.name || "Someone");
const off = (p: Person | null) => !!p?.bot_off_until && Date.parse(p.bot_off_until) > Date.now();
/** Hours left to answer (Instagram: 24 h after their last message). */
const windowLeft = (p: Person | null) => (p?.last_in ? 24 - (Date.now() - Date.parse(p.last_in)) / 3600e3 : -1);
const timeOf = (t: string) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayOf = (t: string) => new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** Poll while the page is visible. */
function useLive(fn: () => void, ms: number, deps: unknown[]) {
  useEffect(() => {
    fn();
    const t = setInterval(() => { if (document.visibilityState === "visible") fn(); }, ms);
    const v = () => document.visibilityState === "visible" && fn();
    document.addEventListener("visibilitychange", v);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", v); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function Avatar({ p, size = 34 }: { p: Person; size?: number }) {
  return <span className="ib-av" style={{ width: size, height: size }} aria-hidden>{p.avatar ? <img src={p.avatar} alt="" loading="lazy" /> : (p.username ?? p.name ?? "?").slice(0, 1).toUpperCase()}</span>;
}

function Row({ p, on, multi, d, open }: { p: Person; on: boolean; multi: boolean; d: Overview; open: () => void }) {
  return (
    <button type="button" className={`ib-row ${on ? "on" : ""} ${p.unread ? "unread" : ""}`} onClick={open} aria-current={on ? "true" : undefined}>
      <Avatar p={p} />
      <span className="ib-row-main">
        <span className="ib-row-top"><b className="ellipsis">{who(p)}</b><span className="tiny faint">{ago(p.updated_at)}</span></span>
        <span className="ib-row-text ellipsis">{p.last_dir === "out" && <span className="faint">You: </span>}{p.last_text ?? ""}</span>
        <span className="ib-row-tags">
          {off(p) && <span className="dm-tag warn">Bot paused</span>}
          {p.state === "done" && <span className="dm-tag">Done</span>}
          {multi && <span className="dm-tag">{handleOf(d.status.accounts.find((a) => a.id === p.account))}</span>}
          {p.tags.slice(0, 2).map((t) => <span key={t} className="dm-tag">#{t}</span>)}
        </span>
      </span>
      {p.unread > 0 && <span className="ib-dot" aria-label={`${p.unread} unread`}>{p.unread > 9 ? "9+" : p.unread}</span>}
    </button>
  );
}

function Composer({ p, d, sent }: { p: Person; d: Overview; sent: (p: Person) => void }) {
  const { toast } = useDialog();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [snips, setSnips] = useState(false);
  const left = windowLeft(p);
  const closed = left <= 0;
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    await api<{ person: Person }>("publish/autodm/reply", { body: { account: p.account, psid: p.psid, text: t } })
      .then((r) => { setText(""); sent(r.person); }).catch((e) => toast((e as Error).message, "bad"));
    setBusy(false);
  };
  const fill = (t: string) => t.replace(/\{username\}/g, p.username ?? "there").replace(/\{handle\}/g, d.status.accounts.find((a) => a.id === p.account)?.handle ?? "");
  return (
    <div className="ib-compose">
      {snips && d.settings.snippets.length > 0 && (
        <div className="ib-snips" role="listbox" aria-label="Saved replies">
          {d.settings.snippets.map((s) => <button key={s.id} type="button" role="option" aria-selected={false} className="dm-pill" onClick={() => { setText((x) => (x ? `${x} ${fill(s.text)}` : fill(s.text))); setSnips(false); }}>{s.name}</button>)}
        </div>
      )}
      <div className="ib-compose-row">
        <button type="button" className="icon-btn" aria-label="Saved replies" aria-expanded={snips} title={d.settings.snippets.length ? "Saved replies" : "Add saved replies in Settings → Inbox"} disabled={!d.settings.snippets.length} onClick={() => setSnips((x) => !x)}><Lightning size={16} /></button>
        <textarea aria-label="Reply" rows={1} value={text} disabled={closed} placeholder={closed ? "Instagram closes replies 24 h after their last message" : "Write a reply… (Enter sends, Shift+Enter for a new line)"}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="sm" aria-label="Send" disabled={closed || busy || !text.trim()} onClick={send}><PaperPlaneRight size={15} weight="fill" /></button>
      </div>
      <p className="tiny faint ib-compose-note">
        {closed ? "They need to message you again before you can answer." : `${Math.max(1, Math.floor(left))} h left to reply · answering pauses the bot for them for ${d.settings.takeover_min >= 60 ? `${Math.round(d.settings.takeover_min / 60)} h` : `${d.settings.takeover_min} min`}`}
      </p>
    </div>
  );
}

function Side({ p, t, set }: { p: Person; t: Thread | null; set: (patch: object, msg?: string) => void }) {
  const [notes, setNotes] = useState(p.notes ?? "");
  useEffect(() => setNotes(p.notes ?? ""), [p.psid, p.notes]);
  return (
    <aside className="ib-side" aria-label="About this person">
      <div className="ib-side-head"><Avatar p={p} size={48} /><div style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: "block" }}>{p.name || who(p)}</b>{p.username && <a className="tiny" href={`https://instagram.com/${p.username}`} target="_blank" rel="noreferrer">@{p.username}</a>}</div></div>
      <div className="ib-side-sec">
        <span className="tiny dim ib-h"><Robot size={13} />Bot</span>
        {off(p) ? <>
          <p className="small" style={{ margin: 0 }}>Paused for them{p.bot_off_until && Date.parse(p.bot_off_until) - Date.now() < 300 * 864e5 ? ` until ${timeOf(p.bot_off_until)}, ${dayOf(p.bot_off_until)}` : ""}.</p>
          <button className="ghost xs" onClick={() => set({ bot: "on" }, "The bot answers them again")}><Play size={13} />Hand back to the bot</button>
        </> : <>
          <p className="small" style={{ margin: 0 }}>Answering them.</p>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button className="ghost xs" onClick={() => set({ bot: 60 * 24 }, "Bot paused for a day")}><Pause size={13} />Pause 24 h</button>
            <button className="ghost xs" onClick={() => set({ bot: "off" }, "Bot paused for them")}><Pause size={13} />Pause</button>
          </div>
        </>}
      </div>
      <div className="ib-side-sec">
        <span className="tiny dim ib-h"><Tag size={13} />Tags</span>
        <Chips label="Tags" value={p.tags} set={(tags) => set({ tags })} placeholder="lead, vip…" />
      </div>
      <div className="ib-side-sec">
        <span className="tiny dim ib-h"><NotePencil size={13} />Notes</span>
        <textarea className="doc short" aria-label="Notes" value={notes} placeholder="Only your team sees this" onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (p.notes ?? "") && set({ notes }, "Note saved")} />
      </div>
      {t && t.events.length > 0 && (
        <div className="ib-side-sec">
          <span className="tiny dim ib-h"><Lightning size={13} />Automations</span>
          <ul className="ib-evs">
            {t.events.slice(0, 8).map((e) => (
              <li key={e.id}><span className="ellipsis">{e.automation_name ?? (e.kind === "ai" ? "AI answer" : e.kind)}</span>
                <span className={`pill ${e.status === "sent" ? "ok" : e.status === "failed" ? "bad" : ""}`}>{e.clicked_at ? "opened" : e.status}</span></li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function ThreadView({ p0, d, back, changed }: { p0: Person; d: Overview; back: () => void; changed: (p: Person) => void }) {
  const { toast } = useDialog();
  const path = `publish/autodm/thread/${p0.account}/${p0.psid}`;
  const [t, setT] = useState<Thread | null>(() => peek<Thread>(path) ?? null);
  const [info, setInfo] = useState(false);
  const p = t?.person ?? p0;
  const end = useRef<HTMLDivElement>(null);
  const last = useRef(0);
  const load = useCallback(() => api<Thread>(path).then(setT).catch(() => null), [path]);
  useLive(load, 4000, [path]);
  useEffect(() => { setT(peek<Thread>(path) ?? null); }, [path]);
  useEffect(() => {
    const n = t?.messages.at(-1)?.id ?? 0;
    if (n !== last.current) { last.current = n; end.current?.scrollIntoView({ block: "end" }); }
  }, [t]);
  // opening it marks it read
  useEffect(() => { if (p0.unread) api<{ person: Person }>("publish/autodm/person", { body: { account: p0.account, psid: p0.psid, read: true } }).then((r) => r.person && changed(r.person)).catch(() => null); }, [p0.psid]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: object, msg?: string) => api<{ person: Person }>("publish/autodm/person", { body: { account: p.account, psid: p.psid, ...patch } })
    .then((r) => { if (r.person) { changed(r.person); setT((x) => (x ? { ...x, person: r.person } : x)); } if (msg) toast(msg, "ok"); }).catch((e) => toast((e as Error).message, "bad"));
  let day = "";
  return (
    <div className="ib-thread-wrap">
      <section className="ib-thread" aria-label={`Conversation with ${who(p)}`}>
        <header className="ib-thread-head">
          <button className="icon-btn ib-back" aria-label="Back to conversations" onClick={back}><ArrowLeft size={16} /></button>
          <Avatar p={p} size={30} />
          <div style={{ minWidth: 0, flex: 1 }}><b className="ellipsis" style={{ display: "block" }}>{who(p)}</b><span className="tiny dim">{off(p) ? "Bot paused · you're answering" : "Bot answering"}{p.last_in ? ` · wrote ${ago(p.last_in)}` : ""}</span></div>
          {p.state === "done" ? <button className="ghost xs" onClick={() => set({ state: "open" }, "Reopened")}><ArrowCounterClockwise size={13} /><span className="dm-hide-s">Reopen</span></button>
            : <button className="ghost xs" onClick={() => set({ state: "done" }, "Marked done")}><CheckCircle size={13} /><span className="dm-hide-s">Done</span></button>}
          <button className={`icon-btn ib-info-btn ${info ? "on" : ""}`} aria-label="About this person" aria-pressed={info} onClick={() => setInfo((x) => !x)}><User size={16} /></button>
        </header>
        <div className="ib-msgs" role="log" aria-live="polite">
          {!t ? <div className="skel" style={{ height: 180 }} /> : !t.messages.length ? <p className="small dim" style={{ textAlign: "center" }}>No messages kept yet. New ones show here as they come in.</p> : t.messages.map((m) => {
            const dd = dayOf(m.at);
            const sep = dd !== day ? (day = dd) : null;
            return (
              <div key={m.id} className="ib-msg-wrap">
                {sep && <div className="ib-day tiny faint">{sep}</div>}
                <div className={`ib-msg ${m.dir}`}>
                  <div className={`dm-bub ${m.dir === "in" ? "" : "me"} ${m.by === "AI" ? "ai" : ""}`}>{m.text}</div>
                  <span className="tiny faint">{m.dir === "out" ? (m.by === "bot" ? "Bot · " : m.by === "AI" ? "AI · " : m.by ? `${m.by} · ` : "") : ""}{timeOf(m.at)}</span>
                </div>
              </div>
            );
          })}
          <div ref={end} />
        </div>
        <Composer p={p} d={d} sent={(np) => { changed(np); setT((x) => (x ? { ...x, person: np } : x)); load(); }} />
      </section>
      <div className={`ib-side-wrap ${info ? "show" : ""}`}><Side p={p} t={t} set={set} /></div>
    </div>
  );
}

export default function InboxTab({ d }: { d: Overview }) {
  const params = useSearchParams();
  const router = useRouter();
  const [view, setView] = useState<View>("open");
  const [acct, setAcct] = useState("");
  const [tag, setTag] = useState("");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const qs = new URLSearchParams({ view, ...(acct ? { account: acct } : {}), ...(tag ? { tag } : {}), ...(dq.trim() ? { q: dq.trim() } : {}) }).toString();
  const path = `publish/autodm/inbox?${qs}`;
  const [list, setList] = useState<List | null>(() => peek<List>(path) ?? null);
  const [tags, setTags] = useState<{ tag: string; n: number }[]>(() => peek<{ tags: { tag: string; n: number }[] }>("publish/autodm/tags")?.tags ?? []);
  const load = useCallback(() => api<List>(path).then(setList).catch(() => null), [path]);
  useEffect(() => { const c = peek<List>(path); if (c) setList(c); }, [path]);
  useLive(load, 6000, [path]);
  useEffect(() => { api<{ tags: { tag: string; n: number }[] }>("publish/autodm/tags").then((r) => setTags(r.tags)).catch(() => null); }, []);
  const sel = params.get("c");
  const [selAcc, selPsid] = (sel ?? "").split(".");
  const cur = useMemo(() => list?.people.find((p) => p.account === selAcc && p.psid === selPsid) ?? null, [list, selAcc, selPsid]);
  const [held, setHeld] = useState<Person | null>(null);
  useEffect(() => { if (cur) setHeld(cur); }, [cur]);
  const stub = selAcc && selPsid ? { account: selAcc, psid: selPsid, username: null, name: null, avatar: null, tags: [], notes: null, bot_off_until: null, state: "open", unread: 0, last_in: null, last_out: null, last_text: null, last_dir: null, updated_at: "" } as Person : null;
  const active = cur ?? (held && held.account === selAcc && held.psid === selPsid ? held : stub);
  const open = (p: Person) => { setHeld(p); router.replace(`/auto-dm?tab=inbox&c=${p.account}.${p.psid}`, { scroll: false }); };
  const back = () => router.replace("/auto-dm?tab=inbox", { scroll: false });
  const changed = (np: Person) => setList((l) => (l ? { ...l, people: l.people.map((x) => (x.account === np.account && x.psid === np.psid ? { ...x, ...np } : x)) } : l));
  const multi = d.status.accounts.length > 1;
  const views: [View, string, number | null][] = [["open", "Open", list?.counts.open ?? null], ["unread", "Unread", list?.counts.unread ?? null], ["paused", "Bot paused", list?.counts.paused ?? null], ["done", "Done", null], ["all", "All", null]];

  return (
    <div className={`ib ${sel ? "has-sel" : ""}`}>
      <div className="ib-list-pane">
        <div className="ib-tools">
          <label className="dm-search"><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search conversations" placeholder="Search people, messages, notes" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="ib-views" role="radiogroup" aria-label="Show">
            {views.map(([v, l, n]) => <button key={v} type="button" role="radio" aria-checked={view === v} className={`dm-pill ${view === v ? "on" : ""}`} onClick={() => setView(v)}>{l}{n ? <span className="mono tiny">{n}</span> : null}</button>)}
          </div>
          {(multi || tags.length > 0) && (
            <div className="ib-filters">
              {multi && <Select size="sm" label="Account" value={acct} onChange={setAcct} options={[["", "All accounts"], ...d.status.accounts.map((a) => [a.id, handleOf(a)] as [string, string])]} />}
              {tags.length > 0 && <Select size="sm" label="Tag" value={tag} onChange={setTag} options={[["", "Any tag"], ...tags.map((t) => [t.tag, `#${t.tag} · ${t.n}`] as [string, string])]} />}
            </div>
          )}
        </div>
        <div className="ib-list">
          {!list ? <div className="skel" style={{ height: 240, margin: 8 }} /> : !list.people.length ? (
            view === "open" && !q && !tag ? (
              <Empty icon={<ChatCircleDots size={22} />} title="No conversations yet">Every Instagram DM lands here: what people write, what the bot answered, and you can jump in. They start arriving as soon as someone messages you.</Empty>
            ) : <p className="small dim" style={{ padding: 16 }}>Nothing here.</p>
          ) : list.people.map((p) => <Row key={`${p.account}.${p.psid}`} p={p} d={d} multi={multi} on={p.account === selAcc && p.psid === selPsid} open={() => open(p)} />)}
        </div>
      </div>
      <div className="ib-main-pane">
        {active ? <ThreadView key={`${active.account}.${active.psid}`} p0={active} d={d} back={back} changed={changed} />
          : <div className="ib-none"><Check size={20} className="faint" /><p className="small dim">Pick a conversation.</p></div>}
      </div>
    </div>
  );
}
