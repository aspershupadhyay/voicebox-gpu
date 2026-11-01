"use client";
// The Auto-DM page (/auto-dm): Instagram automations like ManyChat's, as five tabs with their own addresses (?tab=):
// Automations (the list, built for hundreds, and the flow editor at ?edit=<id>), Comments (rules that hide, delete or
// flag comments, and their review list), People (everyone who triggered one, and the emails collected), Insights (the
// numbers, the weekly report, A/B tests and the log) and Settings (sections down the side). The engine is
// lib/publish/autodm.ts and autodm-more.ts.
import { ChatCircleDots, ChatsCircle, ChartBar, Gear, Lightning, Plus, ShieldCheck, UsersThree, Warning, MagnifyingGlass, CaretRight, Image as ImageIc, Sparkle, X, Check, ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useDialog } from "../Dialog";
import { useDismiss, Select } from "../pop";
import { Empty, Notice, PageHeader } from "../ui";
import Editor from "./Editor";
import { CommentsTab, InsightsTab, PeopleTab } from "./panels";
import { DmSettingsTab } from "./settings";
import { compact, features, rate, summary, type Automation, type Overview } from "./shared";

const TABS = [
  { id: "automations", name: "Automations", icon: Lightning },
  { id: "comments", name: "Comments", icon: ShieldCheck },
  { id: "people", name: "People", icon: UsersThree },
  { id: "insights", name: "Insights", icon: ChartBar },
  { id: "settings", name: "Settings", icon: Gear },
] as const;
type Tab = (typeof TABS)[number]["id"];

function Nav({ tab, go }: { tab: Tab; go: (t: Tab) => void }) {
  return (
    <nav className="set-nav" aria-label="Auto-DM sections" style={{ "--i": TABS.findIndex((t) => t.id === tab), "--n": TABS.length } as React.CSSProperties}>
      <span className="set-pill" aria-hidden />
      {TABS.map(({ id, name, icon: Ic }) => (
        <Link key={id} href={`/auto-dm?tab=${id}`} scroll={false} className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined}
          onClick={(e) => { e.preventDefault(); go(id); }}
          onKeyDown={(e) => {
            const i = TABS.findIndex((t) => t.id === id);
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]; go(n.id); document.getElementById(`dm-${n.id}`)?.focus(); }
          }} id={`dm-${id}`}>
          <Ic size={16} weight="duotone" /><span className="dm-nav-l">{name}</span>
        </Link>
      ))}
    </nav>
  );
}

/** Ready-made starting points for a new automation. */
export const TEMPLATES: { id: string; name: string; about: string; make: (d: Overview["defaults"]) => Partial<Automation> }[] = [
  { id: "keyword", name: "Comment a keyword, get a link", about: "\"Comment CATCH and I'll DM you the link.\"", make: (d) => ({ name: "Comment CATCH", match: "fuzzy", keywords: ["CATCH"], triggers: { comments: true, dms: true, story_replies: true, mentions: false }, public_replies: d.public_replies, message: "Hey {username}! Here's the link you asked for 👇", button: { label: "Open the link", url: "" } }) },
  { id: "choices", name: "Let them choose", about: "\"The prompt or the tutorial?\" Each button answers with its own reply.", make: (d) => ({ name: "Prompt or tutorial", match: "fuzzy", keywords: ["CATCH"], triggers: { comments: true, dms: true, story_replies: true, mentions: false }, public_replies: d.public_replies, message: "Hey {username}! What do you want?", choices: [{ id: "c1", label: "The prompt", reply: "Here's the prompt 👇", button: { label: "Open the prompt", url: "" } }, { id: "c2", label: "The tutorial", reply: "Here's the tutorial 👇", button: { label: "Watch it", url: "" } }] }) },
  { id: "email", name: "Collect emails", about: "The link, then \"want the next one by email?\" Emails land in People.", make: (d) => ({ name: "Link + newsletter", match: "fuzzy", keywords: ["GUIDE"], triggers: { comments: true, dms: true, story_replies: true, mentions: false }, public_replies: d.public_replies, message: "Here's the guide, {username} 👇", button: { label: "Open the guide", url: "" }, collect: { on: true, when: "after", ask: d.ask_email, thanks: d.thanks_email } }) },
  { id: "followers", name: "Followers only", about: "They follow first. Non-followers get a \"follow, then tap\" button.", make: (d) => ({ name: "Followers get the link", match: "fuzzy", keywords: ["LINK"], triggers: { comments: true, dms: true, story_replies: true, mentions: false }, public_replies: d.public_replies, message: "Thanks for following, {username}! Here it is 👇", button: { label: "Open the link", url: "" }, follow_gate: { on: true, message: d.gate_message, button: d.gate_button, not_following: d.not_following } }) },
  { id: "mention", name: "Thank story mentions", about: "Anyone who mentions you in their story gets a thank-you.", make: () => ({ name: "Thanks for the mention", match: "any", keywords: [], triggers: { comments: false, dms: false, story_replies: false, mentions: true }, message: "Thanks for the mention, {username}! 🙏 Means a lot." }) },
  { id: "any", name: "Anyone who comments", about: "Every comment on the chosen posts, whatever it says.", make: (d) => ({ name: "Every comment", match: "any", keywords: [], where: "some", triggers: { comments: true, dms: false, story_replies: false, mentions: false }, public_replies: d.public_replies, message: "Thanks for the comment, {username}! 🙌" }) },
  { id: "blank", name: "Start from scratch", about: "An empty flow.", make: () => ({ name: "New automation" }) },
];

function NewMenu({ onPick, onScan, onClose }: { onPick: (id: string) => void; onScan: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, [box]);
  return (
    <>
      <div className="scrim-modal" aria-hidden />
      <div className="modal dm-new" ref={box} role="dialog" aria-modal="true" aria-label="New automation">
        <div className="row between"><h3>New automation</h3><button className="icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <div className="dm-tpls">
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="dm-tpl" onClick={() => onPick(t.id)}><b>{t.name}</b><span>{t.about}</span></button>
          ))}
        </div>
        <button type="button" className="dm-scan-cta" onClick={onScan}><Sparkle size={16} weight="duotone" /><span><b>Find them in my captions</b><span>Posts that say &ldquo;Comment WORD&rdquo; but have no automation yet</span></span><ArrowRight size={14} /></button>
      </div>
    </>
  );
}

type Suggestion = { account: string; handle: string | null; media: string; label: string; thumb: string | null; keyword: string; link: string | null; at: string | null };
/** The caption scan: recent posts asking for a keyword nothing answers, made into automations in one go (switched off). */
function Scan({ d, onClose, done }: { d: Overview; onClose: () => void; done: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, [box]);
  const { toast } = useDialog();
  const [list, setList] = useState<Suggestion[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ suggestions: Suggestion[] }>("publish/autodm/suggest").then((r) => { setList(r.suggestions); setPick(new Set(r.suggestions.map((s) => s.media))); }).catch((e) => setErr((e as Error).message)); }, []);
  const tpl = d.settings.automations.find((a) => a.id === d.settings.auto_attach.template);
  const make = async () => {
    setBusy(true);
    await api<{ created: number }>("publish/autodm/suggest", { body: { items: (list ?? []).filter((s) => pick.has(s.media)) } })
      .then((r) => { toast(`${r.created} made, switched off: check each one, then switch it on`, "ok"); done(); }).catch((e) => toast((e as Error).message, "bad"));
    setBusy(false);
  };
  return (
    <>
      <div className="scrim-modal" aria-hidden />
      <div className="modal dm-new" ref={box} role="dialog" aria-modal="true" aria-label="Find automations in captions">
        <div className="row between"><h3>From your captions</h3><button className="icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p className="modal-body" style={{ marginTop: 4 }}>Recent posts that ask for a keyword nothing answers. Each becomes an automation {tpl ? <>copied from <b>{tpl.name}</b></> : "with a simple DM"} (pick the template in Settings → Auto-attach).</p>
        {err ? <p className="err">{err}</p> : !list ? <div className="skel" style={{ height: 160, marginTop: 12 }} /> : !list.length ? <p className="small dim" style={{ marginTop: 14 }}>Every caption that asks for a keyword already has its automation.</p> : (
          <div className="dm-scan">
            {list.map((s) => {
              const on = pick.has(s.media);
              return (
                <button key={s.media} type="button" className={`dm-scan-row ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setPick((p) => { const n = new Set(p); if (n.has(s.media)) n.delete(s.media); else n.add(s.media); return n; })}>
                  <span className={`dm-check ${on ? "on" : ""}`} aria-hidden>{on && <Check size={12} weight="bold" />}</span>
                  <span className="dm-thumb" aria-hidden>{s.thumb ? <img src={s.thumb} alt="" loading="lazy" /> : <ImageIc size={16} />}</span>
                  <span className="dm-scan-t"><b className="mono">{s.keyword}</b><span className="tiny dim ellipsis">{s.label}{d.status.accounts.length > 1 && s.handle ? ` · @${s.handle}` : ""}</span></span>
                  <span className={`pill ${s.link ? "ok" : "outline"}`}>{s.link ? "Link found" : "No link"}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="row between" style={{ marginTop: 14 }}>
          <span className="small dim">{pick.size} chosen</span>
          <button className="sm" disabled={!pick.size || busy} onClick={make}>Make {pick.size || ""}</button>
        </div>
      </div>
    </>
  );
}

function List({ d, reload, open, create }: { d: Overview; reload: () => void; open: (id: string) => void; create: () => void }) {
  const { toast, confirm } = useDialog();
  const [q, setQ] = useState("");
  const [acct, setAcct] = useState("");
  const [state, setState] = useState<"all" | "on" | "off">("all");
  const [sort, setSort] = useState<"recent" | "sent" | "ctr" | "name">("recent");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(50);
  const accounts = d.status.accounts;
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = d.settings.automations.filter((a) => (state === "all" || (state === "on") === a.on) && (!acct || !a.accounts.length || a.accounts.includes(acct))
      && (!t || a.name.toLowerCase().includes(t) || a.keywords.some((k) => k.toLowerCase().includes(t)) || a.media.some((m) => m.label.toLowerCase().includes(t)) || a.posts.some((p) => p.label.toLowerCase().includes(t))));
    const sent = (a: Automation) => d.stats[a.id]?.sent ?? 0;
    const ctr = (a: Automation) => (sent(a) ? (d.stats[a.id]?.clicked ?? 0) / sent(a) : -1);
    return sort === "name" ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : sort === "sent" ? [...list].sort((a, b) => sent(b) - sent(a))
      : sort === "ctr" ? [...list].sort((a, b) => ctr(b) - ctr(a)) : [...list].sort((a, b) => b.updated - a.updated);
  }, [d, q, acct, state, sort]);
  const act = async (path: string, body: object, msg: string) => {
    await api(`publish/autodm/${path}`, { body }).then(() => toast(msg, "ok")).catch((e) => toast((e as Error).message, "bad"));
    setSel(new Set()); reload();
  };
  const toggle = (a: Automation) => api<{ problems: string[] }>("publish/autodm/automation", { body: { automation: { id: a.id, on: !a.on } } })
    .then((r) => { if (!a.on && r.problems.length) toast(`Can't switch on: ${r.problems[0]}`, "bad"); reload(); }).catch((e) => toast((e as Error).message, "bad"));
  const all = rows.slice(0, shown);
  const allSel = all.length > 0 && all.every((a) => sel.has(a.id));

  if (!d.settings.automations.length) return (
    <Empty icon={<ChatCircleDots size={22} />} title="No automations yet" action={<button className="sm" onClick={create}><Plus size={14} />New automation</button>}>
      An automation answers a comment, DM, story reply or mention with a DM: &ldquo;Comment CATCH and I&apos;ll DM you the link.&rdquo; One per post, or one for every post.
    </Empty>
  );
  return (
    <div className="dm-list-wrap">
      <div className="dm-toolbar">
        <label className="dm-search"><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search automations" placeholder="Search name, keyword or post" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div className="seg" role="radiogroup" aria-label="Show">
          {(["all", "on", "off"] as const).map((s) => <button key={s} type="button" role="radio" aria-checked={state === s} className={state === s ? "on" : ""} onClick={() => setState(s)}>{s === "all" ? "All" : s === "on" ? "Live" : "Off"}</button>)}
        </div>
        {accounts.length > 1 && <Select size="sm" label="Account" value={acct} onChange={setAcct} options={[["", "All accounts"], ...accounts.map((a) => [a.id, `@${a.handle ?? a.name}`] as [string, string])]} />}
        <Select size="sm" label="Sort" value={sort} onChange={setSort} options={[["recent", "Recently changed"], ["sent", "Most sent"], ["ctr", "Best open rate"], ["name", "Name"]]} />
      </div>
      {sel.size > 0 && (
        <div className="dm-bulk" role="toolbar" aria-label="Selected automations">
          <b className="small">{sel.size} selected</b>
          <button className="ghost xs" onClick={() => act("switch", { ids: [...sel], on: true }, "Switched on (the ones that are ready)")}>Turn on</button>
          <button className="ghost xs" onClick={() => act("switch", { ids: [...sel], on: false }, "Switched off")}>Turn off</button>
          <button className="ghost xs danger-h" onClick={async () => { if (await confirm({ title: `Delete ${sel.size} automation${sel.size > 1 ? "s" : ""}?`, body: "They stop answering. The log keeps what was already sent.", confirm: "Delete", danger: true })) act("delete", { ids: [...sel] }, "Deleted"); }}>Delete</button>
          <button className="ghost xs" style={{ marginLeft: "auto" }} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      <div className="q-list dm-list">
        <div className="dm-row dm-head">
          <input type="checkbox" aria-label="Select all shown" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(all.map((a) => a.id)))} />
          <span className="tiny dim">{rows.length} automation{rows.length === 1 ? "" : "s"}</span>
          <span className="tiny dim dm-col-n">Sent</span>
          <span className="tiny dim dm-col-n dm-col-ctr">Opened</span>
          <span style={{ width: 52 }} />
        </div>
        {all.map((a) => {
          const st = d.stats[a.id];
          const thumb = a.media.find((m) => m.thumb)?.thumb;
          const tags = features(a);
          return (
            <div key={a.id} className={`dm-row ${a.on ? "" : "off"}`}>
              <input type="checkbox" aria-label={`Select ${a.name}`} checked={sel.has(a.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} />
              <button type="button" className="dm-main" onClick={() => open(a.id)}>
                <span className="dm-thumb" aria-hidden>{thumb ? <img src={thumb} alt="" loading="lazy" /> : a.where === "all" ? <ChatsCircle size={18} /> : <ImageIc size={18} />}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="dm-name"><b className="ellipsis">{a.name}</b>{tags.map((t) => <span key={t} className="dm-tag">{t}</span>)}</span>
                  <span className="tiny dim ellipsis" style={{ display: "block" }}>{summary(a, accounts)}</span>
                </span>
              </button>
              <span className="dm-col-n"><span className="mono small">{st ? compact(st.sent) : "0"}</span>{st?.failed ? <span className="tiny bad-t">{st.failed} failed</span> : st?.held ? <span className="tiny warn-t">{st.held} held</span> : null}</span>
              <span className="dm-col-n dm-col-ctr"><span className="mono small">{st?.sent ? rate(st.clicked, st.sent) : "–"}</span>{st?.leads ? <span className="tiny dim">{st.leads} email{st.leads === 1 ? "" : "s"}</span> : null}</span>
              <button type="button" role="switch" aria-checked={a.on} aria-label={`${a.name} live`} className={`switch ${a.on ? "on" : ""}`} onClick={() => toggle(a)} />
              <CaretRight size={14} className="faint dm-caret" aria-hidden />
            </div>
          );
        })}
        {!rows.length && <p className="small dim" style={{ padding: 16, margin: 0 }}>Nothing matches.</p>}
      </div>
      {rows.length > shown && <button className="ghost sm" style={{ alignSelf: "center" }} onClick={() => setShown((n) => n + 50)}>Show more ({rows.length - shown} left)</button>}
    </div>
  );
}

/** One quiet line of numbers instead of a wall of cards: live, sent, opened, emails, people. */
function Pulse({ d, go }: { d: Overview; go: (t: Tab) => void }) {
  const t = d.totals;
  const live = d.settings.automations.filter((a) => a.on).length;
  const items: [string, string, Tab | null][] = [
    [`${live}/${d.settings.automations.length}`, "live", null],
    [compact(t?.sent ?? 0), "sent", "insights"],
    [rate(t?.clicked ?? 0, t?.sent ?? 0), "opened", "insights"],
    [compact(t?.leads ?? 0), "emails", "people"],
    [compact(t?.people ?? 0), "people", "people"],
  ];
  return (
    <div className="dm-pulse" aria-label="Last 30 days">
      {items.map(([v, l, to]) => to
        ? <button key={l} type="button" onClick={() => go(to)}><b className="mono">{v}</b><span>{l}</span></button>
        : <span key={l}><b className="mono">{v}</b><span>{l}</span></span>)}
      <span className="dm-pulse-when tiny faint">30 days</span>
    </div>
  );
}

export default function AutoDm() {
  const params = useSearchParams();
  const router = useRouter();
  const { toast } = useDialog();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "automations") as Tab;
  const edit = params.get("edit");
  const tpl = params.get("template");
  const go = (t: Tab) => router.replace(`/auto-dm?tab=${t}`, { scroll: false });
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [picking, setPicking] = useState(false);
  const [scan, setScan] = useState(false);
  const load = useCallback(() => api<Overview>("publish/autodm").then((x) => { setD(x); setErr(""); }).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);

  const ready = !!d && d.status.flag && d.status.accounts.some((a) => a.messages === true && a.subscribed);
  const state = !d ? null : !d.settings.on ? ["Off", ""] : !ready ? ["Setup needed", "warn"] : ["Live", "ok"];
  const header = (
    <PageHeader title="Auto-DM" sub="Comments, DMs, story replies and mentions answered in seconds, on every account."
      actions={<>
        {state && <button type="button" className={`pill dm-state ${state[1]}`} onClick={() => go("settings")}>{state[1] === "ok" && <span className="dm-live" aria-hidden />}{state[0]}</button>}
        {tab === "automations" && !edit && <button className="sm" onClick={() => setPicking(true)}><Plus size={14} />New</button>}
      </>} />
  );
  if (!d) return <>{header}<Nav tab={tab} go={go} />{err ? <Notice icon={<Warning size={18} />} tone="bad" action={<button className="sm" onClick={load}>Try again</button>}>{err}</Notice> : <div className="skel" style={{ height: 320 }} />}</>;

  if (tab === "automations" && edit) {
    return <>{header}<Nav tab={tab} go={go} /><Editor key={edit} id={edit} template={tpl} d={d} reload={load} close={() => router.replace("/auto-dm?tab=automations", { scroll: false })}
      opened={(id) => router.replace(`/auto-dm?tab=automations&edit=${id}`, { scroll: false })} /></>;
  }
  return (
    <>
      {header}
      <Nav tab={tab} go={go} />
      <div className="dm-page">
        {tab !== "settings" && (!d.settings.on ? (
          <Notice icon={<Warning size={18} />} tone="warn" action={<button className="sm" onClick={() => api("publish/autodm", { body: { on: true } }).then(() => { toast("Auto-DM is on", "ok"); load(); }).catch((e) => toast((e as Error).message, "bad"))}>Switch on</button>}>
            Auto-DM is off: nothing is sent.{ready ? "" : " Setup isn't finished either (Settings → Set up)."}
          </Notice>
        ) : !ready ? (
          <Notice icon={<Warning size={18} />} tone="warn" action={<button className="sm" onClick={() => router.replace("/auto-dm?tab=settings&section=setup", { scroll: false })}>Finish setup</button>}>It&apos;s on, but can&apos;t send until setup is finished.</Notice>
        ) : null)}
        {tab === "automations" && (
          <>
            <Pulse d={d} go={go} />
            <List d={d} reload={load} open={(id) => router.replace(`/auto-dm?tab=automations&edit=${id}`, { scroll: false })} create={() => setPicking(true)} />
          </>
        )}
        {tab === "comments" && <CommentsTab d={d} reload={load} />}
        {tab === "people" && <PeopleTab d={d} reload={load} />}
        {tab === "insights" && <InsightsTab d={d} reload={load} />}
        {tab === "settings" && <DmSettingsTab d={d} reload={load} />}
      </div>
      {picking && <NewMenu onClose={() => setPicking(false)} onScan={() => { setPicking(false); setScan(true); }} onPick={(t) => { setPicking(false); router.replace(`/auto-dm?tab=automations&edit=new&template=${t}`, { scroll: false }); }} />}
      {scan && <Scan d={d} onClose={() => setScan(false)} done={() => { setScan(false); load(); }} />}
    </>
  );
}
