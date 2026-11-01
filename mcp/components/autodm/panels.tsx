"use client";
// The Auto-DM page's other tabs: Activity (every comment, DM, story reply and button tap an automation answered, with
// why one failed), Contacts (everyone who triggered one, whether they follow, CSV export) and Settings (the master
// switch, per-account pauses, setup, defaults and a tester across every live automation).
import { ArrowsClockwise, ChatCircle, CheckCircle, Circle, Copy, DownloadSimple, Flask, Hourglass, MagnifyingGlass, PaperPlaneTilt, Prohibit, XCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useDialog } from "../Dialog";
import { Select } from "../pop";
import { Empty, Field, Toggle } from "../ui";
import { Seg, ago, handleOf, type Overview } from "./shared";

type Ev = { id: number; at: string; account: string; kind: "comment" | "dm" | "story"; automation: string | null; automation_name: string | null; from_name: string | null; text: string | null; status: string; replied: boolean; following: boolean | null; error: string | null; note: string | null };
type Contact = { account: string; from_id: string; from_name: string | null; times: number; got: number; last: string; following: boolean | null; automations: string[] | null };

const KIND = { comment: "Comment", dm: "DM", story: "Story reply" } as const;
const STATUS: Record<string, { label: string; tone: string; Ic: typeof CheckCircle }> = {
  sent: { label: "Sent", tone: "ok", Ic: CheckCircle }, gated: { label: "Waiting to follow", tone: "warn", Ic: Hourglass },
  failed: { label: "Failed", tone: "bad", Ic: XCircle }, skipped: { label: "Skipped", tone: "", Ic: Prohibit }, pending: { label: "Sending", tone: "blue", Ic: PaperPlaneTilt },
};
const acctOpts = (d: Overview) => [["", "All accounts"], ...d.status.accounts.map((a) => [a.id, `@${a.handle ?? a.name}`] as [string, string])] as [string, string][];

function useDebounced<T>(v: T, ms = 300) {
  const [x, setX] = useState(v);
  useEffect(() => { const t = setTimeout(() => setX(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return x;
}

export function Activity({ d }: { d: Overview }) {
  const [q, setQ] = useState("");
  const [automation, setAutomation] = useState("");
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<"" | "sent" | "gated" | "failed" | "skipped">("");
  const [rows, setRows] = useState<Ev[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const dq = useDebounced(q);
  const load = useCallback(async (before?: number) => {
    const p = new URLSearchParams(Object.entries({ q: dq, automation, account, status, before: before ? String(before) : "" }).filter(([, v]) => v));
    await api<{ events: Ev[] }>(`publish/autodm/activity?${p}`).then((r) => { setRows((x) => (before ? [...(x ?? []), ...r.events] : r.events)); setMore(r.events.length === 50); setErr(""); }).catch((e) => setErr((e as Error).message));
  }, [dq, automation, account, status]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="dm-list-wrap">
      <div className="dm-toolbar">
        <label className="dm-search"><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search activity" placeholder="Search names and comments" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <Seg label="Status" value={status} set={setStatus} options={[["", "All"], ["sent", "Sent"], ["gated", "Waiting"], ["failed", "Failed"], ["skipped", "Skipped"]]} />
        <Select size="sm" label="Automation" value={automation} onChange={setAutomation} options={[["", "Every automation"], ...d.settings.automations.map((a) => [a.id, a.name] as [string, string])]} />
        {d.status.accounts.length > 1 && <Select size="sm" label="Account" value={account} onChange={setAccount} options={acctOpts(d)} />}
        <button className="ghost xs" onClick={() => load()}><ArrowsClockwise size={13} />Refresh</button>
      </div>
      {err && <p className="err">{err}</p>}
      {!rows ? <div className="skel" style={{ height: 240 }} /> : !rows.length ? (
        <Empty icon={<ChatCircle size={22} />} title="Nothing yet">Every comment, DM and story reply an automation answers shows here, with what was sent and why anything failed.</Empty>
      ) : (
        <div className="q-list">
          {rows.map((e) => {
            const s = STATUS[e.status] ?? STATUS.skipped;
            const acc = d.status.accounts.find((a) => a.id === e.account);
            return (
              <div key={e.id} className="q-row dm-ev">
                <s.Ic size={18} weight="fill" className={s.tone ? `${s.tone}-t` : "faint"} aria-label={s.label} />
                <div className="q-main" style={{ cursor: "default" }}>
                  <b className="ellipsis">{e.from_name ? <a href={`https://instagram.com/${e.from_name}`} target="_blank" rel="noreferrer">@{e.from_name}</a> : "Someone"}<span className="tiny dim"> · {KIND[e.kind]}{d.status.accounts.length > 1 && acc ? ` on ${handleOf(acc)}` : ""} · {e.automation_name ?? "—"}</span></b>
                  {e.text && <span className="tiny dim ellipsis">&ldquo;{e.text}&rdquo;</span>}
                  {(e.error || e.note) && <span className={`tiny ${e.error ? "bad-t" : "faint"}`}>{e.error ?? e.note}</span>}
                </div>
                <span className="dm-ev-tags">
                  <span className={`pill ${s.tone}`}>{s.label}</span>
                  {e.replied && <span className="pill outline">Answered in public</span>}
                  {e.following === true && <span className="pill outline">Follows</span>}
                </span>
                <span className="q-when tiny mono dim">{ago(e.at)}</span>
              </div>
            );
          })}
        </div>
      )}
      {more && rows && <button className="ghost sm" style={{ alignSelf: "center" }} onClick={() => load(rows[rows.length - 1].id)}>Show older</button>}
    </div>
  );
}

export function Contacts({ d }: { d: Overview }) {
  const [q, setQ] = useState("");
  const [account, setAccount] = useState("");
  const [rows, setRows] = useState<Contact[] | null>(null);
  const [err, setErr] = useState("");
  const dq = useDebounced(q);
  useEffect(() => {
    const p = new URLSearchParams(Object.entries({ q: dq, account }).filter(([, v]) => v));
    api<{ contacts: Contact[] }>(`publish/autodm/contacts?${p}`).then((r) => { setRows(r.contacts); setErr(""); }).catch((e) => setErr((e as Error).message));
  }, [dq, account]);
  const csv = () => {
    if (!rows) return;
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const out = [["username", "account", "times", "got_dm", "follows", "last", "automations"].join(","),
      ...rows.map((r) => [r.from_name, handleOf(d.status.accounts.find((a) => a.id === r.account)), r.times, r.got, r.following == null ? "" : r.following ? "yes" : "no", r.last, (r.automations ?? []).join("; ")].map(cell).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([out], { type: "text/csv" }));
    a.download = `auto-dm-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="dm-list-wrap">
      <div className="dm-toolbar">
        <label className="dm-search"><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search contacts" placeholder="Search usernames" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        {d.status.accounts.length > 1 && <Select size="sm" label="Account" value={account} onChange={setAccount} options={acctOpts(d)} />}
        <button className="ghost xs" style={{ marginLeft: "auto" }} disabled={!rows?.length} onClick={csv}><DownloadSimple size={13} />Export CSV</button>
      </div>
      {err && <p className="err">{err}</p>}
      {!rows ? <div className="skel" style={{ height: 240 }} /> : !rows.length ? (
        <Empty icon={<ChatCircle size={22} />} title="No contacts yet">Everyone who comments a keyword or messages one shows here: how often, what they got, and whether they follow.</Empty>
      ) : (
        <div className="q-list">
          {rows.map((r) => (
            <div key={`${r.account}-${r.from_id}`} className="q-row">
              <span className="pv-av" aria-hidden>{(r.from_name ?? "?").slice(0, 1).toUpperCase()}</span>
              <div className="q-main" style={{ cursor: "default" }}>
                <b className="ellipsis">{r.from_name ? <a href={`https://instagram.com/${r.from_name}`} target="_blank" rel="noreferrer">@{r.from_name}</a> : "Someone (a DM)"}</b>
                <span className="tiny dim ellipsis">{r.times} time{r.times === 1 ? "" : "s"} · got {r.got} DM{r.got === 1 ? "" : "s"}{r.automations?.length ? ` · ${r.automations.join(", ")}` : ""}{d.status.accounts.length > 1 ? ` · ${handleOf(d.status.accounts.find((a) => a.id === r.account))}` : ""}</span>
              </div>
              {r.following != null && <span className={`pill ${r.following ? "ok" : "warn"}`}>{r.following ? "Follows" : "Not following"}</span>}
              <span className="q-when tiny mono dim">{ago(r.last)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Step({ ok, title, children }: { ok: boolean | null; title: string; children?: React.ReactNode }) {
  return (
    <li className="dm-step">
      {ok ? <CheckCircle size={18} weight="fill" className="ok-t" aria-label="Done" /> : <Circle size={18} className={ok === false ? "warn-t" : "faint"} aria-label={ok === false ? "To do" : "Check by hand"} />}
      <div style={{ minWidth: 0, flex: 1 }}><div className="tr-t">{title}</div>{children && <div className="tr-d">{children}</div>}</div>
    </li>
  );
}

function Tester({ d }: { d: Overview }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"comment" | "dm" | "story">("comment");
  const [account, setAccount] = useState(d.status.accounts[0]?.id ?? "");
  const [res, setRes] = useState<{ automation: { name: string } | null; keyword: string | null; steps: { to: string; text: string; button: string | null }[]; note: string } | null>(null);
  const run = () => text.trim() && api("publish/autodm/test", { body: { text, kind, account } }).then(setRes).catch((e) => setRes({ automation: null, keyword: null, steps: [], note: (e as Error).message }));
  return (
    <section className="card">
      <h2 className="row" style={{ gap: 7 }}><Flask size={17} />Try a comment</h2>
      <p className="small dim" style={{ marginTop: 4 }}>Against every live automation, the way Instagram would deliver it. Nothing is sent.</p>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Seg label="Kind" value={kind} set={setKind} options={[["comment", "Comment"], ["dm", "DM"], ["story", "Story reply"]]} />
        {d.status.accounts.length > 1 && <Select size="sm" label="Account" value={account} onChange={setAccount} options={d.status.accounts.map((a) => [a.id, `@${a.handle ?? a.name}`] as [string, string])} />}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <input aria-label="Text to try" placeholder="e.g. catch!" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} style={{ flex: 1, minWidth: 0 }} />
        <button className="sm" onClick={run} disabled={!text.trim()}>Try</button>
      </div>
      {res && (
        <div className="dm-preview" role="status">
          <b className="small">{res.automation ? `"${res.automation.name}" answers it` : res.note}</b>
          {res.steps.map((s, i) => (
            <div key={i} style={{ marginTop: 8 }}><span className="tiny faint">{s.to}</span><p className="small" style={{ whiteSpace: "pre-wrap", margin: "2px 0 0" }}>{s.text}</p>{s.button && <span className="pill outline" style={{ marginTop: 4 }}>{s.button}</span>}</div>
          ))}
          {res.automation && <p className="tiny faint" style={{ margin: "8px 0 0" }}>{res.note}</p>}
        </div>
      )}
    </section>
  );
}

export function DmSettingsTab({ d, reload }: { d: Overview; reload: () => void }) {
  const { toast } = useDialog();
  const s = d.settings, st = d.status;
  const [def, setDef] = useState({ ...s.defaults, public_replies: s.defaults.public_replies.join("\n") });
  const [busy, setBusy] = useState(false);
  const hook = typeof location === "undefined" ? "" : `${location.origin}/api/ig/webhook`;
  const post = (body: object, msg: string) => api("publish/autodm", { body }).then(() => { toast(msg, "ok"); reload(); }).catch((e) => toast((e as Error).message, "bad"));
  const subscribe = async (account?: string) => {
    setBusy(true);
    await api<{ results: { handle: string | null; ok: boolean; error?: string }[] }>("publish/autodm/subscribe", { body: { account } })
      .then((r) => r.results.forEach((x) => toast(x.ok ? `@${x.handle} is sending its comments and messages` : `@${x.handle}: ${x.error}`, x.ok ? "ok" : "bad"))).catch((e) => toast((e as Error).message, "bad"));
    setBusy(false); reload();
  };
  const changed = JSON.stringify({ ...s.defaults, public_replies: s.defaults.public_replies.join("\n") }) !== JSON.stringify(def);
  return (
    <div className="ap-cols">
      <div className="ap-main">
        <section className="card">
          <h2>Auto-DM</h2>
          <Toggle on={s.on} set={(v) => post({ on: v }, v ? "Auto-DM is on" : "Auto-DM is off: nothing is sent")} title="Send DMs automatically" about="The master switch. Off stops every automation on every account at once." />
          {st.accounts.map((a) => (
            <Toggle key={a.id} on={!s.paused.includes(a.id)} set={(v) => post({ paused: v ? s.paused.filter((x) => x !== a.id) : [...s.paused, a.id] }, v ? `Answering on ${handleOf(a)}` : `Paused on ${handleOf(a)}`)}
              title={`Answer on ${handleOf(a)}`} about={a.error ? a.error : "Off pauses every automation on this account only."} />
          ))}
        </section>

        <section className="card">
          <h2>Defaults</h2>
          <p className="small dim" style={{ marginTop: 4 }}>New automations start from these, and an empty follow-gate field uses them. {"{handle}"} is your @, {"{username}"} theirs.</p>
          <div className="dm-stack">
            <Field label="Public answers" hint="One per line, picked at random."><textarea className="doc short" value={def.public_replies} onChange={(e) => setDef({ ...def, public_replies: e.target.value })} /></Field>
            <Field label="Ask non-followers to follow"><textarea className="doc short" value={def.gate_message} onChange={(e) => setDef({ ...def, gate_message: e.target.value })} /></Field>
            <Field label="Follow button"><input value={def.gate_button} maxLength={20} onChange={(e) => setDef({ ...def, gate_button: e.target.value })} /></Field>
            <Field label="Tapped but not following yet"><textarea className="doc short" value={def.not_following} onChange={(e) => setDef({ ...def, not_following: e.target.value })} /></Field>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="sm" disabled={!changed} onClick={() => post({ defaults: { ...def, public_replies: def.public_replies.split("\n") } }, "Defaults saved")}>Save defaults</button>
            {changed && <button className="ghost sm" onClick={() => setDef({ ...s.defaults, public_replies: s.defaults.public_replies.join("\n") })}>Undo</button>}
          </div>
        </section>
        <Tester d={d} />
      </div>
      <aside className="ap-side">
        <section className="card">
          <h2>Set up</h2>
          <ol className="dm-steps">
            <Step ok={st.flag} title="Messaging permission in the Meta app">
              {st.flag ? "On: Instagram sign-in asks for messages." : <>Add <code>instagram_business_manage_messages</code> to the Meta app (App Review → Advanced Access, for anyone who isn&apos;t a tester), then set <code>INSTAGRAM_DM=1</code> on the Worker.</>}
            </Step>
            <Step ok={st.verify_token && st.app_secret && !!st.last_event} title="Webhook in the Meta app">
              <>Instagram → Webhooks: the callback URL below, verify token <code>INSTAGRAM_WEBHOOK_TOKEN</code>{st.verify_token ? " (set)" : " (not set yet)"}. Subscribe to <code>comments</code>, <code>messages</code> and <code>messaging_postbacks</code>.</>
              <div className="row" style={{ gap: 6, marginTop: 6 }}><code className="ellipsis" style={{ flex: 1 }}>{hook}</code><button className="ghost xs" onClick={() => navigator.clipboard.writeText(hook).then(() => toast("Copied", "ok"))}><Copy size={12} />Copy</button></div>
              <span className="tiny faint" style={{ display: "block", marginTop: 4 }}>{st.last_event ? `Last heard from Instagram ${ago(st.last_event)}` : "Nothing heard from Instagram yet"}</span>
            </Step>
            {st.accounts.length ? st.accounts.map((a) => (
              <Step key={a.id} ok={a.messages === true && !!a.subscribed} title={handleOf(a)}>
                {a.error && <span className="bad-t">{a.error} </span>}
                {a.messages === true ? "Messages allowed. " : <>Reconnect so Instagram asks for messages{a.messages === null ? " (connected before Auto-DM)" : ""}. </>}
                {a.subscribed ? `Subscribed ${ago(a.subscribed)}.` : "Not subscribed yet."}
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  {a.messages !== true && <a className="btn ghost xs" href="/api/publish/instagram/connect"><ArrowsClockwise size={13} />Reconnect</a>}
                  <button className="ghost xs" disabled={busy} onClick={() => subscribe(a.id)}><PaperPlaneTilt size={13} />{a.subscribed ? "Subscribe again" : "Subscribe"}</button>
                </div>
              </Step>
            )) : <Step ok={false} title="Connect Instagram">Posts → Autopilot → Connect (a Creator or Business account). Add as many accounts as you like.</Step>}
            <Step ok={null} title="On each phone">Instagram → Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages.</Step>
          </ol>
          <p className="tiny faint" style={{ margin: "10px 0 0" }}>Instagram&apos;s limits: one private reply per comment, within 7 days of it; after someone messages you or taps a button, 24 hours to answer.</p>
        </section>
      </aside>
    </div>
  );
}
