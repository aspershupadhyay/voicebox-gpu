"use client";
// The Auto-DM page's middle tabs. Comments: rules that hide, delete or flag comments (as short sentences you can read
// at a glance), and the list to review what they caught. People: everyone who triggered an automation, and the emails
// collected, with CSV and block. Insights: the weekly note, five numbers against the period before, every day as
// striped bars, the best automations, A/B tests, and the full log.
import { ArrowsClockwise, ChatCircle, CheckCircle, DownloadSimple, EnvelopeSimple, Eye, EyeSlash, Flag, Hourglass, MagnifyingGlass, PaperPlaneTilt, PencilSimple, Plus, Prohibit, ShieldCheck, Sparkle, Trash, Trophy, XCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useDialog } from "../Dialog";
import { Select } from "../pop";
import { Empty, Field } from "../ui";
import { Chips, Seg, ago, compact, downloadCsv, handleOf, rate, useDebounced, type ModRule, type Overview, type Totals } from "./shared";

type Ev = { id: number; at: string; account: string; kind: "comment" | "dm" | "story" | "mention" | "ai" | "mod"; automation: string | null; automation_name: string | null; from_name: string | null; text: string | null; status: string; replied: boolean; following: boolean | null; error: string | null; note: string | null; clicked_at?: string | null; variant?: string | null };
type Contact = { account: string; from_id: string; from_name: string | null; times: number; got: number; clicked: number; last: string; following: boolean | null; automations: string[] | null; email: string | null };
type Lead = { id: number; at: string; account: string; from_name: string | null; email: string; automation_name: string | null };
type Insights = {
  days: number; now: Totals; prev: Totals; daily: { day: string; sent: number; clicked: number }[];
  top: { automation: string; name: string; sent: number; clicked: number }[];
  report: { at: number; from: string; to: string; text: string } | null;
  ab: { id: string; name: string; winner: "a" | "b" | null; min: number; a: { sent: number; clicked: number }; b: { sent: number; clicked: number } }[];
};

const acctOpts = (d: Overview) => [["", "All accounts"], ...d.status.accounts.map((a) => [a.id, handleOf(a)] as [string, string])] as [string, string][];
const post = (body: object) => api("publish/autodm", { body });
const igLink = (n: string | null, fallback = "Someone") => (n ? <a href={`https://instagram.com/${n}`} target="_blank" rel="noreferrer">@{n}</a> : fallback);

// ─────────────────────────────── Comments

const ACTION = { hide: ["Hide it", "warn"], delete: ["Delete it", "bad"], flag: ["Flag it for me", "blue"] } as const;
const PRESETS: { name: string; make: () => Partial<ModRule> }[] = [
  { name: "Hide links", make: () => ({ name: "Links", links: true, words: [], action: "hide" }) },
  { name: "Hide spam", make: () => ({ name: "Spam", words: ["dm me", "check my page", "promo", "crypto", "follow back", "giveaway winner"], match: "fuzzy", action: "hide" }) },
  { name: "Flag rude words", make: () => ({ name: "Rude", words: [], match: "fuzzy", action: "flag" }) },
];
const blankRule = (): ModRule => ({ id: "", name: "", on: true, accounts: [], words: [], match: "word", links: false, action: "hide" });

/** A rule as a sentence: "Hide comments with a link or 'promo', 'crypto' +3". */
function sentence(r: ModRule) {
  const w = r.words.slice(0, 3).map((x) => `“${x}”`).join(", ") + (r.words.length > 3 ? ` +${r.words.length - 3}` : "");
  const what = [r.links && "a link", w].filter(Boolean).join(" or ") || "…";
  return `${r.action === "delete" ? "Delete" : r.action === "flag" ? "Flag" : "Hide"} comments with ${what}${r.match === "fuzzy" && r.words.length ? " (typos too)" : ""}`;
}

function RuleEditor({ d, rule, onSave, onCancel, onDelete }: { d: Overview; rule: ModRule; onSave: (r: ModRule) => void; onCancel: () => void; onDelete?: () => void }) {
  const [r, setR] = useState(rule);
  const ok = r.links || r.words.length > 0;
  return (
    <div className="dm-rule-edit">
      <div className="dm-grid">
        <Field label="Name"><input value={r.name} maxLength={60} placeholder="e.g. Spam" onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
        <Field label="Then"><Select label="What to do" value={r.action} onChange={(v) => setR({ ...r, action: v })} options={Object.entries(ACTION).map(([k, [l]]) => [k as ModRule["action"], l])} /></Field>
      </div>
      <Field label="Words or phrases" hint="Type and press Enter."><Chips label="Words" value={r.words} set={(words) => setR({ ...r, words })} placeholder="promo, check my page…" max={100} /></Field>
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <Seg label="Matching" value={r.match} set={(match) => setR({ ...r, match })} options={[["word", "Exact words"], ["fuzzy", "Typos too"]]} />
        <button type="button" className={`dm-pill${r.links ? " on" : ""}`} aria-pressed={r.links} onClick={() => setR({ ...r, links: !r.links })}>Any link</button>
        {d.status.accounts.length > 1 && <Select size="sm" label="Account" value={r.accounts[0] ?? ""} onChange={(v) => setR({ ...r, accounts: v ? [v] : [] })} options={[["", "Every account"], ...d.status.accounts.map((a) => [a.id, handleOf(a)] as [string, string])]} />}
      </div>
      <p className="tiny dim" style={{ margin: 0 }}>{sentence(r)}.</p>
      <div className="row" style={{ gap: 8 }}>
        <button className="sm" disabled={!ok} onClick={() => onSave({ ...r, name: r.name.trim() || r.words[0] || (r.links ? "Links" : "Rule") })}>Save rule</button>
        <button className="ghost sm" onClick={onCancel}>Cancel</button>
        {onDelete && <button className="ghost sm bad-t" style={{ marginLeft: "auto" }} onClick={onDelete}><Trash size={14} />Delete</button>}
      </div>
    </div>
  );
}

const MOD_STATUS: Record<string, { label: string; tone: string }> = { flagged: { label: "Flagged", tone: "blue" }, hidden: { label: "Hidden", tone: "warn" }, deleted: { label: "Deleted", tone: "bad" }, dismissed: { label: "Left up", tone: "" }, failed: { label: "Couldn't act", tone: "bad" }, pending: { label: "Working", tone: "" } };

export function CommentsTab({ d, reload }: { d: Overview; reload: () => void }) {
  const { toast, confirm } = useDialog();
  const m = d.settings.moderation;
  const [editing, setEditing] = useState<ModRule | null>(null);
  const [status, setStatus] = useState<"" | "flagged" | "hidden" | "deleted">("flagged");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [rows, setRows] = useState<Ev[] | null>(null);
  const load = useCallback(() => {
    const p = new URLSearchParams(Object.entries({ status, q: dq }).filter(([, v]) => v));
    api<{ events: Ev[] }>(`publish/autodm/comments?${p}`).then((r) => setRows(r.events)).catch((e) => { setRows([]); toast((e as Error).message, "bad"); });
  }, [status, dq, toast]);
  useEffect(() => { load(); }, [load]);

  const save = (rules: ModRule[], on = m.on, msg = "Rules saved") => post({ moderation: { on, rules } }).then(() => { toast(msg, "ok"); setEditing(null); reload(); }).catch((e) => toast((e as Error).message, "bad"));
  const upsert = (r: ModRule) => save(r.id ? m.rules.map((x) => (x.id === r.id ? r : x)) : [...m.rules, r], m.on || m.rules.length === 0);
  const act = (e: Ev, action: "hide" | "unhide" | "delete" | "dismiss") => (async () => {
    if (action === "delete" && !(await confirm({ title: "Delete this comment?", body: "It's removed from Instagram for good.", confirm: "Delete", danger: true }))) return;
    await api("publish/autodm/comment", { body: { id: e.id, action } }).then(() => { toast(action === "unhide" ? "Shown again" : action === "dismiss" ? "Left up" : action === "hide" ? "Hidden" : "Deleted", "ok"); load(); }).catch((x) => toast((x as Error).message, "bad"));
  })();

  return (
    <div className="dm-two">
      <section className="card dm-rules">
        <div className="dm-sec-h">
          <div><h2>Comment rules</h2><p className="small dim">Checked on every new comment, before any automation answers it.</p></div>
          <button type="button" role="switch" aria-checked={m.on} aria-label="Comment rules on" className={`switch${m.on ? " on" : ""}`} onClick={() => save(m.rules, !m.on, !m.on ? "Comment rules are on" : "Comment rules are off")} />
        </div>
        {m.rules.length > 0 && (
          <ul className="dm-rule-list">
            {m.rules.map((r) => editing?.id === r.id ? (
              <li key={r.id}><RuleEditor d={d} rule={editing} onCancel={() => setEditing(null)} onSave={upsert} onDelete={() => save(m.rules.filter((x) => x.id !== r.id), m.on, "Rule deleted")} /></li>
            ) : (
              <li key={r.id} className={`dm-rule${r.on ? "" : " off"}`}>
                <span className={`dm-rule-dot ${ACTION[r.action][1]}`} aria-hidden />
                <div className="dm-rule-t"><b>{r.name}</b><span className="small dim">{sentence(r)}</span></div>
                <button type="button" className="icon-btn" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><PencilSimple size={15} /></button>
                <button type="button" role="switch" aria-checked={r.on} aria-label={`${r.name} on`} className={`switch${r.on ? " on" : ""}`} onClick={() => save(m.rules.map((x) => (x.id === r.id ? { ...x, on: !r.on } : x)), m.on, r.on ? "Rule paused" : "Rule on")} />
              </li>
            ))}
          </ul>
        )}
        {editing && !editing.id ? <RuleEditor d={d} rule={editing} onCancel={() => setEditing(null)} onSave={upsert} /> : (
          <div className="dm-pills" style={{ marginTop: m.rules.length ? 12 : 4 }}>
            <button type="button" className="dm-pill add" onClick={() => setEditing(blankRule())}><Plus size={13} />New rule</button>
            {PRESETS.filter((p) => !m.rules.some((r) => r.name === p.make().name)).map((p) => (
              <button key={p.name} type="button" className="dm-pill ghosted" onClick={() => setEditing({ ...blankRule(), ...p.make() })}>{p.name}</button>
            ))}
          </div>
        )}
      </section>

      <section className="dm-list-wrap">
        <div className="dm-toolbar">
          <Seg label="Show" value={status} set={setStatus} options={[["flagged", "To review"], ["hidden", "Hidden"], ["deleted", "Deleted"], ["", "All"]]} />
          <label className="dm-search"><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search comments" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        </div>
        {!rows ? <div className="skel" style={{ height: 200 }} /> : !rows.length ? (
          <Empty icon={<ShieldCheck size={22} />} title={status === "flagged" ? "Nothing to review" : "Nothing here"}>{m.rules.length ? "Comments your rules catch land here: show one again, or delete it." : "Add a rule and the comments it catches show up here."}</Empty>
        ) : (
          <div className="q-list">
            {rows.map((e) => {
              const s = MOD_STATUS[e.status] ?? MOD_STATUS.pending;
              return (
                <div key={e.id} className="q-row dm-ev">
                  <div className="q-main" style={{ cursor: "default" }}>
                    <b className="ellipsis">{igLink(e.from_name)}<span className="tiny dim"> · {e.automation_name ?? "rule"} · {ago(e.at)}</span></b>
                    {e.text && <span className="small ellipsis">&ldquo;{e.text}&rdquo;</span>}
                    {e.error && <span className="tiny bad-t">{e.error}</span>}
                  </div>
                  <span className="dm-ev-tags">
                    <span className={`pill ${s.tone}`}>{s.label}</span>
                    {e.status === "hidden" && <button className="ghost xs" onClick={() => act(e, "unhide")}><Eye size={13} />Show</button>}
                    {e.status === "flagged" && <><button className="ghost xs" onClick={() => act(e, "hide")}><EyeSlash size={13} />Hide</button><button className="ghost xs" onClick={() => act(e, "dismiss")}>Leave</button></>}
                    {(e.status === "flagged" || e.status === "hidden") && <button className="ghost xs" aria-label="Delete the comment" onClick={() => act(e, "delete")}><Trash size={13} /></button>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────── People

export function PeopleTab({ d, reload }: { d: Overview; reload: () => void }) {
  const { toast } = useDialog();
  const [view, setView] = useState<"all" | "emails">("all");
  const [q, setQ] = useState("");
  const [account, setAccount] = useState("");
  const [people, setPeople] = useState<Contact[] | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const dq = useDebounced(q);
  const blocked = useMemo(() => new Set(d.settings.safety.blocklist), [d.settings.safety.blocklist]);
  useEffect(() => {
    const p = new URLSearchParams(Object.entries({ q: dq, account }).filter(([, v]) => v));
    if (view === "all") api<{ contacts: Contact[] }>(`publish/autodm/contacts?${p}`).then((r) => setPeople(r.contacts)).catch((e) => { setPeople([]); toast((e as Error).message, "bad"); });
    else api<{ leads: Lead[] }>(`publish/autodm/leads?${p}`).then((r) => setLeads(r.leads)).catch((e) => { setLeads([]); toast((e as Error).message, "bad"); });
  }, [view, dq, account, toast]);
  const acct = (id: string) => handleOf(d.status.accounts.find((a) => a.id === id));
  const block = (name: string, on: boolean) => post(on ? { block: [name] } : { unblock: [name] }).then(() => { toast(on ? `@${name} won't get DMs` : `@${name} can get DMs again`, "ok"); reload(); }).catch((e) => toast((e as Error).message, "bad"));
  const csv = () => view === "all"
    ? people && downloadCsv("auto-dm-people", ["username", "account", "times", "got_dm", "opened", "follows", "email", "last", "automations"], people.map((r) => [r.from_name, acct(r.account), r.times, r.got, r.clicked, r.following == null ? "" : r.following ? "yes" : "no", r.email, r.last, (r.automations ?? []).join("; ")]))
    : leads && downloadCsv("auto-dm-emails", ["email", "username", "account", "automation", "at"], leads.map((l) => [l.email, l.from_name, acct(l.account), l.automation_name, l.at]));
  const rows = view === "all" ? people : leads;

  return (
    <div className="dm-list-wrap">
      <div className="dm-toolbar">
        <Seg label="Show" value={view} set={setView} options={[["all", "Everyone"], ["emails", `Emails${d.totals?.leads ? ` · ${compact(d.totals.leads)}` : ""}`]]} />
        <label className="dm-search"><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search people" placeholder={view === "all" ? "Search usernames" : "Search emails and usernames"} value={q} onChange={(e) => setQ(e.target.value)} /></label>
        {d.status.accounts.length > 1 && <Select size="sm" label="Account" value={account} onChange={setAccount} options={acctOpts(d)} />}
        <button className="ghost xs" disabled={!rows?.length} onClick={csv}><DownloadSimple size={13} />CSV</button>
      </div>
      {!rows ? <div className="skel" style={{ height: 240 }} /> : !rows.length ? (
        view === "all"
          ? <Empty icon={<ChatCircle size={22} />} title="No one yet">Everyone who comments a keyword or messages one shows here: how often, what they opened, whether they follow.</Empty>
          : <Empty icon={<EnvelopeSimple size={22} />} title="No emails yet">Turn on &ldquo;Ask for their email&rdquo; in an automation and the addresses people send land here, ready for your newsletter.</Empty>
      ) : view === "all" ? (
        <div className="q-list">
          {people!.map((r) => {
            const isBlocked = !!r.from_name && blocked.has(r.from_name.toLowerCase());
            return (
              <div key={`${r.account}-${r.from_id}`} className={`q-row dm-person${isBlocked ? " off" : ""}`}>
                <span className="pv-av" aria-hidden>{(r.from_name ?? "?").slice(0, 1).toUpperCase()}</span>
                <div className="q-main" style={{ cursor: "default" }}>
                  <b className="ellipsis">{igLink(r.from_name, "Someone (a DM)")}{d.status.accounts.length > 1 && <span className="tiny dim"> · {acct(r.account)}</span>}</b>
                  <span className="tiny dim ellipsis">{r.got} DM{r.got === 1 ? "" : "s"} · opened {r.clicked}{r.email ? ` · ${r.email}` : ""}{r.automations?.length ? ` · ${r.automations.join(", ")}` : ""}</span>
                </div>
                <span className="dm-ev-tags">
                  {isBlocked ? <span className="pill bad">Blocked</span> : r.following != null && <span className={`pill ${r.following ? "ok" : ""}`}>{r.following ? "Follows" : "Doesn't follow"}</span>}
                  {r.from_name && <button className="ghost xs" aria-label={isBlocked ? `Unblock @${r.from_name}` : `Block @${r.from_name}`} title={isBlocked ? "Unblock" : "Never DM them"} onClick={() => block(r.from_name!, !isBlocked)}>{isBlocked ? "Unblock" : <Prohibit size={13} />}</button>}
                </span>
                <span className="q-when tiny mono dim">{ago(r.last)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="q-list">
          {leads!.map((l) => (
            <div key={l.id} className="q-row">
              <EnvelopeSimple size={18} className="dim" aria-hidden />
              <div className="q-main" style={{ cursor: "default" }}>
                <b className="ellipsis mono" style={{ fontWeight: 500 }}>{l.email}</b>
                <span className="tiny dim ellipsis">{igLink(l.from_name)}{l.automation_name ? ` · ${l.automation_name}` : ""}{d.status.accounts.length > 1 ? ` · ${acct(l.account)}` : ""}</span>
              </div>
              <button className="ghost xs" aria-label={`Copy ${l.email}`} onClick={() => navigator.clipboard.writeText(l.email).then(() => toast("Copied", "ok"))}>Copy</button>
              <span className="q-when tiny mono dim">{ago(l.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── Insights

const delta = (n: number, p: number) => (p ? Math.round(((n - p) / p) * 100) : n ? null : 0);

function Kpi({ label, n, p, sub }: { label: string; n: number; p: number; sub?: string }) {
  const c = delta(n, p);
  return (
    <div className="dm-kpi">
      <span className="tiny dim">{label}</span>
      <b className="mono">{compact(n)}</b>
      <span className="tiny">{sub && <span className="dim">{sub} · </span>}{c === null ? <span className="ok-t">new</span> : c === 0 ? <span className="faint">same</span> : <span className={c > 0 ? "ok-t" : "bad-t"}>{c > 0 ? "+" : ""}{c}%</span>}</span>
    </div>
  );
}

function Bars({ daily }: { daily: Insights["daily"] }) {
  const max = Math.max(1, ...daily.map((x) => x.sent));
  const [hover, setHover] = useState<number | null>(null);
  const h = hover ?? daily.length - 1;
  const cur = daily[h];
  return (
    <div className="dm-bars-wrap">
      <div className="row tiny dim" style={{ justifyContent: "space-between" }}>
        <span>{cur ? new Date(cur.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : ""}</span>
        <span className="mono">{cur ? <><b>{cur.sent}</b> sent · <b>{cur.clicked}</b> opened</> : ""}</span>
      </div>
      <div className="dm-bars" role="img" aria-label={`DMs sent each day, up to ${max}`} onMouseLeave={() => setHover(null)}>
        {daily.map((x, i) => (
          <span key={x.day} className={i === h ? "on" : ""} onMouseEnter={() => setHover(i)} style={{ "--h": `${(x.sent / max) * 100}%`, "--o": `${x.sent ? (x.clicked / x.sent) * 100 : 0}%` } as React.CSSProperties}><i /></span>
        ))}
      </div>
      <div className="row tiny faint" style={{ gap: 14 }}><span className="dm-key sent" />Sent<span className="dm-key open" />Opened</div>
    </div>
  );
}

const LOG_STATUS: Record<string, { label: string; tone: string; Ic: typeof CheckCircle }> = {
  sent: { label: "Sent", tone: "ok", Ic: CheckCircle }, gated: { label: "Waiting", tone: "warn", Ic: Hourglass }, held: { label: "Held (limit)", tone: "warn", Ic: Hourglass },
  failed: { label: "Failed", tone: "bad", Ic: XCircle }, skipped: { label: "Skipped", tone: "", Ic: Prohibit }, pending: { label: "Sending", tone: "blue", Ic: PaperPlaneTilt }, handoff: { label: "For you", tone: "blue", Ic: Flag },
};
const KIND: Record<string, string> = { comment: "Comment", dm: "DM", story: "Story reply", mention: "Mention", ai: "AI answer" };

function Log({ d }: { d: Overview }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [automation, setAutomation] = useState("");
  const [rows, setRows] = useState<Ev[] | null>(null);
  const [more, setMore] = useState(false);
  const dq = useDebounced(q);
  const load = useCallback(async (before?: number) => {
    const p = new URLSearchParams(Object.entries({ q: dq, kind, status, automation, before: before ? String(before) : "" }).filter(([, v]) => v));
    await api<{ events: Ev[] }>(`publish/autodm/activity?${p}`).then((r) => { setRows((x) => (before ? [...(x ?? []), ...r.events] : r.events)); setMore(r.events.length === 50); }).catch(() => setRows([]));
  }, [dq, kind, status, automation]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="dm-list-wrap">
      <div className="dm-toolbar">
        <label className="dm-search"><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search the log" placeholder="Search names and messages" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <Select size="sm" label="Kind" value={kind} onChange={setKind} options={[["", "Every kind"], ...Object.entries(KIND)] as [string, string][]} />
        <Select size="sm" label="Status" value={status} onChange={setStatus} options={[["", "Any status"], ["sent", "Sent"], ["gated", "Waiting to follow"], ["held", "Held by a limit"], ["failed", "Failed"], ["skipped", "Skipped"]]} />
        <Select size="sm" label="Automation" value={automation} onChange={setAutomation} options={[["", "Every automation"], ...d.settings.automations.map((a) => [a.id, a.name] as [string, string])]} />
        <button className="ghost xs" aria-label="Refresh" onClick={() => load()}><ArrowsClockwise size={13} /></button>
      </div>
      {!rows ? <div className="skel" style={{ height: 240 }} /> : !rows.length ? (
        <Empty icon={<ChatCircle size={22} />} title="Nothing yet">Every comment, DM, mention and AI answer shows here, with what was sent and why anything didn&apos;t go.</Empty>
      ) : (
        <div className="q-list">
          {rows.map((e) => {
            const s = LOG_STATUS[e.status] ?? LOG_STATUS.skipped;
            return (
              <div key={e.id} className="q-row dm-ev">
                <s.Ic size={18} weight="fill" className={s.tone ? `${s.tone}-t` : "faint"} aria-label={s.label} />
                <div className="q-main" style={{ cursor: "default" }}>
                  <b className="ellipsis">{igLink(e.from_name)}<span className="tiny dim"> · {KIND[e.kind] ?? e.kind} · {e.automation_name ?? "—"}{e.variant === "b" ? " · B" : ""}</span></b>
                  {e.text && <span className="tiny dim ellipsis">&ldquo;{e.text}&rdquo;</span>}
                  {(e.error || e.note) && <span className={`tiny ${e.error ? "bad-t" : "faint"}`}>{e.error ?? e.note}</span>}
                </div>
                <span className="dm-ev-tags">
                  <span className={`pill ${s.tone}`}>{s.label}</span>
                  {e.clicked_at && <span className="pill outline">Opened</span>}
                  {e.replied && <span className="pill outline">Answered</span>}
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

export function InsightsTab({ d }: { d: Overview; reload: () => void }) {
  const { toast } = useDialog();
  const [view, setView] = useState<"numbers" | "log">("numbers");
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [x, setX] = useState<Insights | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Insights>(`publish/autodm/insights?days=${days}`).then(setX).catch((e) => toast((e as Error).message, "bad")), [days, toast]);
  useEffect(() => { if (view === "numbers") load(); }, [load, view]);
  const make = async () => { setBusy(true); await api("publish/autodm/report", { body: {} }).then(() => { toast("Report made and sent to your notifications", "ok"); load(); }).catch((e) => toast((e as Error).message, "bad")); setBusy(false); };
  const best = x?.top[0]?.sent ?? 1;

  return (
    <div className="dm-list-wrap">
      <div className="dm-toolbar">
        <Seg label="View" value={view} set={setView} options={[["numbers", "Numbers"], ["log", "Log"]]} />
        {view === "numbers" && <span style={{ marginLeft: "auto" }}><Seg label="Period" value={days} set={setDays} options={[["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]} /></span>}
      </div>
      {view === "log" ? <Log d={d} /> : !x ? <div className="skel" style={{ height: 320 }} /> : (
        <>
          <section className="card dm-report">
            <Sparkle size={18} weight="duotone" className="dm-report-ic" aria-hidden />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span className="tiny dim">{x.report ? `The week ${x.report.from} to ${x.report.to}` : "The weekly report"}</span>
              <p className="small" style={{ margin: "2px 0 0" }}>{x.report?.text ?? `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.settings.report.day]} you get the week in one note: sent, opened, emails, the best automation.`}</p>
            </div>
            <button className="ghost xs" disabled={busy} onClick={make}>{x.report ? "Make it now" : "Make the first one"}</button>
          </section>

          <div className="dm-kpis">
            <Kpi label="DMs sent" n={x.now.sent} p={x.prev.sent} />
            <Kpi label="Links opened" n={x.now.clicked} p={x.prev.clicked} sub={rate(x.now.clicked, x.now.sent)} />
            <Kpi label="People" n={x.now.people} p={x.prev.people} />
            <Kpi label="Emails" n={x.now.leads} p={x.prev.leads} />
            <Kpi label="AI answers" n={x.now.ai} p={x.prev.ai} />
            <Kpi label="Comments caught" n={x.now.moderated} p={x.prev.moderated} />
          </div>

          <div className="dm-two">
            <section className="card"><h2>Every day</h2><Bars daily={x.daily} /></section>
            <section className="card">
              <h2>Best automations</h2>
              {!x.top.length ? <p className="small dim">Nothing sent in this period yet.</p> : (
                <ol className="dm-top">
                  {x.top.map((t) => (
                    <li key={t.automation}>
                      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}><span className="small ellipsis">{t.name}</span><span className="tiny mono dim">{t.sent} · {rate(t.clicked, t.sent)} opened</span></div>
                      <span className="fx-hatch" style={{ "--c": "var(--ink)" } as React.CSSProperties}><i style={{ width: `${(t.sent / best) * 100}%` }} /></span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          {x.ab.length > 0 && (
            <section className="card">
              <h2>A/B tests</h2>
              <p className="small dim" style={{ marginTop: 2 }}>Each DM goes out as A or B. Once one is clearly opened more, everyone gets it.</p>
              <div className="dm-ab-list">
                {x.ab.map((t) => {
                  const ra = t.a.sent ? t.a.clicked / t.a.sent : 0, rb = t.b.sent ? t.b.clicked / t.b.sent : 0, top = Math.max(ra, rb, 0.01);
                  const left = Math.max(0, t.min - Math.min(t.a.sent, t.b.sent));
                  return (
                    <div key={t.id} className="dm-ab">
                      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <b className="small ellipsis">{t.name}</b>
                        {t.winner ? <span className="pill ok"><Trophy size={12} weight="fill" />{t.winner.toUpperCase()} won</span> : <span className="pill">{left ? `${left} more each to call it` : "Testing"}</span>}
                      </div>
                      {(["a", "b"] as const).map((v) => (
                        <div key={v} className={`dm-ab-row${t.winner === v ? " win" : ""}`}>
                          <span className="mono tiny">{v.toUpperCase()}</span>
                          <span className="fx-hatch" style={{ "--c": t.winner === v ? "var(--ok)" : "var(--mute)" } as React.CSSProperties}><i style={{ width: `${((v === "a" ? ra : rb) / top) * 100}%` }} /></span>
                          <span className="tiny mono dim">{rate(t[v].clicked, t[v].sent)} of {t[v].sent}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
