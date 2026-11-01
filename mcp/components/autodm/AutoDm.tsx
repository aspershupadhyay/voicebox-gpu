"use client";
// The Auto-DM page (/auto-dm): Instagram automations like ManyChat's, as tabs along the top with their own addresses
// (?tab=), the way Settings is laid out. Automations (the list, built for hundreds, and the editor at ?edit=<id>),
// Activity (every comment and DM answered), Contacts (everyone who triggered one) and Settings (the master switch,
// per-account pauses, defaults, setup and a tester). The engine is lib/publish/autodm.ts.
import { ChatCircleDots, ChatsCircle, Gear, Lightning, Plus, PaperPlaneTilt, UsersThree, Warning, Hourglass, MagnifyingGlass, CaretRight, Image as ImageIc, Pulse } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useDialog } from "../Dialog";
import { useDismiss, Select } from "../pop";
import { Empty, Notice, PageHeader, StatCard } from "../ui";
import Editor from "./Editor";
import { Activity, Contacts, DmSettingsTab } from "./panels";
import { ago, compact, summary, type Automation, type Overview } from "./shared";

const TABS = [
  { id: "automations", name: "Automations", icon: Lightning },
  { id: "activity", name: "Activity", icon: Pulse },
  { id: "contacts", name: "Contacts", icon: UsersThree },
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
          <Ic size={16} weight="duotone" />{name}
        </Link>
      ))}
    </nav>
  );
}

/** Ready-made starting points for a new automation. */
export const TEMPLATES: { id: string; name: string; about: string; make: (d: Overview["defaults"]) => Partial<Automation> }[] = [
  { id: "keyword", name: "Comment a keyword, get a link", about: "\"Comment CATCH and I'll DM you the link.\" The classic.", make: (d) => ({ name: "Comment CATCH", match: "fuzzy", keywords: ["CATCH"], triggers: { comments: true, dms: true, story_replies: true }, public_replies: d.public_replies, message: "Hey {username}! Here's the link you asked for 👇", button: { label: "Open the link", url: "" } }) },
  { id: "followers", name: "Followers only", about: "Same, but they must follow you first. Non-followers get a \"follow, then tap\" button.", make: (d) => ({ name: "Followers get the link", match: "fuzzy", keywords: ["LINK"], triggers: { comments: true, dms: true, story_replies: true }, public_replies: d.public_replies, message: "Thanks for following, {username}! Here it is 👇", button: { label: "Open the link", url: "" }, follow_gate: { on: true, message: d.gate_message, button: d.gate_button, not_following: d.not_following } }) },
  { id: "any", name: "Anyone who comments", about: "Every comment on the chosen posts gets the DM, whatever it says.", make: (d) => ({ name: "Every comment", match: "any", keywords: [], where: "some", triggers: { comments: true, dms: false, story_replies: false }, public_replies: d.public_replies, message: "Thanks for the comment, {username}! 🙌" }) },
  { id: "story", name: "Story replies", about: "Someone replies to your story with the keyword and gets the DM.", make: () => ({ name: "Story reply", match: "fuzzy", keywords: ["YES"], triggers: { comments: false, dms: false, story_replies: true }, message: "Here you go 👇", button: { label: "Open the link", url: "" } }) },
  { id: "blank", name: "Start from scratch", about: "An empty automation.", make: () => ({ name: "New automation" }) },
];

function NewMenu({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, [box]);
  return (
    <>
      <div className="scrim-modal" aria-hidden />
      <div className="modal dm-new" ref={box} role="dialog" aria-modal="true" aria-label="New automation">
        <h3>New automation</h3>
        <p className="modal-body" style={{ marginTop: 4 }}>Pick a starting point. Everything can be changed after.</p>
        <div className="dm-tpls">
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="dm-tpl" onClick={() => onPick(t.id)}>
              <b>{t.name}</b><span>{t.about}</span>
            </button>
          ))}
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
  const [sort, setSort] = useState<"recent" | "sent" | "name">("recent");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(50);
  const accounts = d.status.accounts;
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = d.settings.automations.filter((a) => (state === "all" || (state === "on") === a.on) && (!acct || !a.accounts.length || a.accounts.includes(acct))
      && (!t || a.name.toLowerCase().includes(t) || a.keywords.some((k) => k.toLowerCase().includes(t)) || a.media.some((m) => m.label.toLowerCase().includes(t)) || a.posts.some((p) => p.label.toLowerCase().includes(t))));
    const sent = (a: Automation) => d.stats[a.id]?.sent ?? 0;
    return sort === "name" ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : sort === "sent" ? [...list].sort((a, b) => sent(b) - sent(a)) : [...list].sort((a, b) => b.updated - a.updated);
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
      An automation answers a comment, DM or story reply with a message: &ldquo;Comment CATCH and I&apos;ll DM you the link.&rdquo; Make one per post, or one for every post.
    </Empty>
  );
  return (
    <div className="dm-list-wrap">
      <div className="dm-toolbar">
        <label className="dm-search"><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search automations" placeholder="Search by name, keyword or post" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div className="seg" role="radiogroup" aria-label="Show">
          {(["all", "on", "off"] as const).map((s) => <button key={s} type="button" role="radio" aria-checked={state === s} className={state === s ? "on" : ""} onClick={() => setState(s)}>{s === "all" ? "All" : s === "on" ? "Live" : "Off"}</button>)}
        </div>
        {accounts.length > 1 && <Select size="sm" label="Account" value={acct} onChange={setAcct} options={[["", "All accounts"], ...accounts.map((a) => [a.id, `@${a.handle ?? a.name}`] as [string, string])]} />}
        <Select size="sm" label="Sort" value={sort} onChange={setSort} options={[["recent", "Recently changed"], ["sent", "Most sent"], ["name", "Name"]]} />
      </div>
      {sel.size > 0 && (
        <div className="dm-bulk" role="toolbar" aria-label="Selected automations">
          <b className="small">{sel.size} selected</b>
          <button className="ghost xs" onClick={() => act("switch", { ids: [...sel], on: true }, "Switched on (the ones that are ready)")}>Turn on</button>
          <button className="ghost xs" onClick={() => act("switch", { ids: [...sel], on: false }, "Switched off")}>Turn off</button>
          <button className="ghost xs danger-h" onClick={async () => { if (await confirm({ title: `Delete ${sel.size} automation${sel.size > 1 ? "s" : ""}?`, body: "They stop answering. Activity keeps what was already sent.", confirm: "Delete", danger: true })) act("delete", { ids: [...sel] }, "Deleted"); }}>Delete</button>
          <button className="ghost xs" style={{ marginLeft: "auto" }} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      <div className="q-list dm-list">
        <div className="dm-row dm-head">
          <input type="checkbox" aria-label="Select all shown" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(all.map((a) => a.id)))} />
          <span className="tiny dim">{rows.length} automation{rows.length === 1 ? "" : "s"}</span>
          <span className="tiny dim dm-col-n">Sent · 30 d</span>
          <span className="tiny dim dm-col-l">Last</span>
          <span className="tiny dim" style={{ width: 40, textAlign: "right" }}>Live</span>
          <span style={{ width: 16 }} />
        </div>
        {all.map((a) => {
          const st = d.stats[a.id];
          const thumb = a.media.find((m) => m.thumb)?.thumb;
          return (
            <div key={a.id} className={`dm-row ${a.on ? "" : "off"}`}>
              <input type="checkbox" aria-label={`Select ${a.name}`} checked={sel.has(a.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} />
              <button type="button" className="dm-main" onClick={() => open(a.id)}>
                <span className="dm-thumb" aria-hidden>{thumb ? <img src={thumb} alt="" loading="lazy" /> : a.where === "all" ? <ChatsCircle size={18} /> : <ImageIc size={18} />}</span>
                <span style={{ minWidth: 0 }}>
                  <b className="ellipsis" style={{ display: "block" }}>{a.name}</b>
                  <span className="tiny dim ellipsis" style={{ display: "block" }}>{summary(a, accounts)}</span>
                </span>
              </button>
              <span className="dm-col-n"><span className="mono small">{st ? compact(st.sent) : "0"}</span>{st?.failed ? <span className="tiny bad-t">{st.failed} failed</span> : null}</span>
              <span className="dm-col-l tiny dim">{st?.last ? ago(st.last) : "—"}</span>
              <button type="button" role="switch" aria-checked={a.on} aria-label={`${a.name} live`} className={`switch ${a.on ? "on" : ""}`} onClick={() => toggle(a)} />
              <CaretRight size={14} className="faint" aria-hidden />
            </div>
          );
        })}
        {!rows.length && <p className="small dim" style={{ padding: 16, margin: 0 }}>Nothing matches.</p>}
      </div>
      {rows.length > shown && <button className="ghost sm" style={{ alignSelf: "center" }} onClick={() => setShown((n) => n + 50)}>Show more ({rows.length - shown} left)</button>}
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
  const load = useCallback(() => api<Overview>("publish/autodm").then((x) => { setD(x); setErr(""); }).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);

  const ready = !!d && d.status.flag && d.status.accounts.some((a) => a.messages === true && a.subscribed);
  const live = d?.settings.automations.filter((a) => a.on).length ?? 0;
  const header = (
    <PageHeader title="Auto-DM" sub="Comments, DMs and story replies answered in seconds, on every account: a keyword, the DM, a link."
      actions={tab === "automations" && !edit ? <button className="sm" onClick={() => setPicking(true)}><Plus size={14} />New automation</button> : undefined} />
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
        {!d.settings.on ? (
          <Notice icon={<Warning size={18} />} tone="warn" action={<button className="sm" onClick={() => api("publish/autodm", { body: { on: true } }).then(() => { toast("Auto-DM is on", "ok"); load(); }).catch((e) => toast((e as Error).message, "bad"))}>Switch on</button>}>
            Auto-DM is off: nothing is sent. {ready ? "" : "Setup isn't finished either (Settings tab)."}
          </Notice>
        ) : !ready ? (
          <Notice icon={<Warning size={18} />} tone="warn" action={tab !== "settings" ? <button className="sm" onClick={() => go("settings")}>Finish setup</button> : undefined}>Auto-DM is on but can&apos;t send yet: finish the steps under Settings → Set up.</Notice>
        ) : null}
        {tab === "automations" && (
          <>
            <div className="stats-row">
              <StatCard icon={<Lightning size={17} weight="bold" />} value={`${live}/${d.settings.automations.length}`} label="Automations live" />
              <StatCard icon={<PaperPlaneTilt size={17} weight="bold" />} value={compact(d.totals?.sent ?? 0)} label="DMs sent · 30 days" onClick={() => go("activity")} linkLabel="Activity" />
              <StatCard icon={<Hourglass size={17} weight="bold" />} value={compact(d.totals?.gated ?? 0)} label="Waiting to follow" />
              <StatCard icon={<UsersThree size={17} weight="bold" />} value={compact(d.totals?.people ?? 0)} label="People reached" onClick={() => go("contacts")} linkLabel="Contacts" />
            </div>
            <List d={d} reload={load} open={(id) => router.replace(`/auto-dm?tab=automations&edit=${id}`, { scroll: false })} create={() => setPicking(true)} />
          </>
        )}
        {tab === "activity" && <Activity d={d} />}
        {tab === "contacts" && <Contacts d={d} />}
        {tab === "settings" && <DmSettingsTab d={d} reload={load} />}
      </div>
      {picking && <NewMenu onClose={() => setPicking(false)} onPick={(t) => { setPicking(false); router.replace(`/auto-dm?tab=automations&edit=new&template=${t}`, { scroll: false }); }} />}
    </>
  );
}
