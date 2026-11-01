"use client";
// Auto-DM → Settings: one section at a time, picked down the side (?section=): General (the switch and per-account
// pauses), Safety (hourly and per-person limits, blocked usernames), Auto-attach (an automation for every new post),
// AI replies (Claude answers follow-ups), Sync & report (a sheet or CRM, the weekly note), Defaults (the words new
// automations start from) and Set up (the Meta checklist and a tester).
import { ArrowsClockwise, CheckCircle, Circle, Copy, Flask, Gear, Lightning, Link as LinkIc, PaperPlaneTilt, ShieldCheck, Sparkle, TextAa, Wrench } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "../api";
import { useDialog } from "../Dialog";
import { Select } from "../pop";
import { Field, Toggle } from "../ui";
import { Chips, Seg, ago, handleOf, type Overview } from "./shared";

const SECTIONS = [
  { id: "general", name: "General", Ic: Gear },
  { id: "safety", name: "Safety", Ic: ShieldCheck },
  { id: "attach", name: "Auto-attach", Ic: Lightning },
  { id: "ai", name: "AI replies", Ic: Sparkle },
  { id: "sync", name: "Sync & report", Ic: LinkIc },
  { id: "defaults", name: "Default words", Ic: TextAa },
  { id: "setup", name: "Set up", Ic: Wrench },
] as const;
type Sec = (typeof SECTIONS)[number]["id"];
type Props = { d: Overview; save: (body: object, msg: string) => Promise<unknown> };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="dm-set-h"><h2>{title}</h2>{children && <p className="small dim">{children}</p>}</div>;
}
function SaveBar({ changed, onSave, onUndo, label = "Save" }: { changed: boolean; onSave: () => void; onUndo: () => void; label?: string }) {
  return <div className="row" style={{ gap: 8, marginTop: 14 }}><button className="sm" disabled={!changed} onClick={onSave}>{label}</button>{changed && <button className="ghost sm" onClick={onUndo}>Undo</button>}</div>;
}

function General({ d, save }: Props) {
  const s = d.settings;
  return (
    <>
      <Head title="General">The master switch, and a pause for each Instagram account.</Head>
      <Toggle on={s.on} set={(v) => save({ on: v }, v ? "Auto-DM is on" : "Auto-DM is off: nothing is sent")} title="Send DMs automatically" about="Off stops every automation on every account at once." />
      {d.status.accounts.map((a) => (
        <Toggle key={a.id} on={!s.paused.includes(a.id)} set={(v) => save({ paused: v ? s.paused.filter((x) => x !== a.id) : [...s.paused, a.id] }, v ? `Answering on ${handleOf(a)}` : `Paused on ${handleOf(a)}`)}
          title={`Answer on ${handleOf(a)}`} about={a.error ?? "Off pauses this account only."} />
      ))}
    </>
  );
}

function Safety({ d, save }: Props) {
  const cur = d.settings.safety;
  const [x, setX] = useState(cur);
  const changed = JSON.stringify(x) !== JSON.stringify(cur);
  return (
    <>
      <Head title="Safety">Instagram limits how fast an account can message. Past the hourly limit, DMs wait and go out in the next hour, never lost.</Head>
      <div className="dm-grid">
        <Field label="DMs an hour, per account" hint="Instagram allows about 200. 150 leaves room for you."><input type="number" min={1} max={750} value={x.per_hour} onChange={(e) => setX({ ...x, per_hour: Number(e.target.value) })} /></Field>
        <Field label="DMs a day, per person" hint="However many keywords they comment."><input type="number" min={1} max={100} value={x.per_person_day} onChange={(e) => setX({ ...x, per_person_day: Number(e.target.value) })} /></Field>
      </div>
      <Field label="Never DM these usernames" hint="Rivals, bots, your own other accounts. Block from People too." style={{ marginTop: 12 }}>
        <Chips label="Blocked usernames" value={x.blocklist} set={(blocklist) => setX({ ...x, blocklist: blocklist.map((b) => b.replace(/^@/, "").toLowerCase()) })} placeholder="username, another…" max={2000} />
      </Field>
      <SaveBar changed={changed} onSave={() => save({ safety: x }, "Safety saved")} onUndo={() => setX(cur)} />
    </>
  );
}

function Attach({ d, save }: Props) {
  const cur = d.settings.auto_attach;
  const opts = d.settings.automations.filter((a) => !a.made_from).map((a) => [a.id, a.name] as [string, string]);
  return (
    <>
      <Head title="Auto-attach">When the studio posts a Reel or a post whose caption says &ldquo;comment WORD&rdquo;, a new automation is made from your template, for that post and that word.</Head>
      <Toggle on={cur.on} set={(v) => save({ auto_attach: { ...cur, on: v } }, v ? "New posts get an automation" : "Auto-attach is off")} title="Make one for each new post" about="Only when the caption asks for a comment keyword." />
      <div className="dm-grid" style={{ marginTop: 12 }}>
        <Field label="Template" hint={'Its message can use {title} and {keyword}. A link in the caption fills the button.'}>
          <Select label="Template" value={cur.template ?? ""} onChange={(v) => save({ auto_attach: { ...cur, template: v || null } }, "Template saved")} options={[["", "The default (a link DM)"], ...opts]} />
        </Field>
      </div>
      <Toggle on={cur.live} set={(v) => save({ auto_attach: { ...cur, live: v } }, v ? "They'll start live" : "They'll start off, for you to check")} title="Switch them on straight away" about="Off: each is made switched off, for you to look over first." />
      <p className="tiny faint" style={{ marginTop: 10 }}>For posts already up, use <b>New → Find them in my captions</b> on Automations.</p>
    </>
  );
}

function Ai({ d, save }: Props) {
  const cur = d.settings.ai;
  const [x, setX] = useState(cur);
  const changed = JSON.stringify(x) !== JSON.stringify(cur);
  return (
    <>
      <Head title="AI replies">When someone writes back after the DM, Claude answers from the post&apos;s script and your notes. Anything it can&apos;t answer comes to you. Turn it on per automation, in its flow.</Head>
      <div className={`dm-keyrow ${d.status.ai_key ? "ok" : "warn"}`}>
        {d.status.ai_key ? <CheckCircle size={18} weight="fill" className="ok-t" aria-hidden /> : <Circle size={18} className="warn-t" aria-hidden />}
        <span className="small" style={{ flex: 1 }}>{d.status.ai_key ? <>Claude key set{d.status.ai_key_last4 ? <> (…{d.status.ai_key_last4})</> : null}</> : "Add a Claude key to turn AI replies on"}</span>
        <Link className="btn ghost xs" href="/settings?tab=automation">{d.status.ai_key ? "Change" : "Add key"}</Link>
      </div>
      <Field label="How to sound" hint="Who you are, how you talk, what never to say." style={{ marginTop: 12 }}>
        <textarea className="doc short" maxLength={1000} placeholder="Friendly, short, a bit funny. I make AI video tutorials. Never promise a reply time." value={x.persona} onChange={(e) => setX({ ...x, persona: e.target.value })} />
      </Field>
      <div className="dm-grid" style={{ marginTop: 12 }}>
        <Field label="AI answers a day, per person"><input type="number" min={1} max={50} value={x.per_person_day} onChange={(e) => setX({ ...x, per_person_day: Number(e.target.value) })} /></Field>
      </div>
      <SaveBar changed={changed} onSave={() => save({ ai: x }, "AI settings saved")} onUndo={() => setX(cur)} />
    </>
  );
}

const SCRIPT = `function doPost(e) {
  var d = JSON.parse(e.postData.contents);
  var sh = SpreadsheetApp.getActive().getSheetByName("Auto-DM") || SpreadsheetApp.getActive().insertSheet("Auto-DM");
  var rows = d.leads || [d];
  rows.forEach(function (r) { sh.appendRow([new Date(), r.type || "lead", r.account, r.username, r.email || "", r.automation, r.text || ""]); });
  return ContentService.createTextOutput("ok");
}`;

function Sync({ d, save }: Props) {
  const { toast } = useDialog();
  const cur = d.settings.sync, rep = d.settings.report;
  const [x, setX] = useState(cur);
  const [busy, setBusy] = useState(false);
  const [howto, setHowto] = useState(false);
  const changed = JSON.stringify(x) !== JSON.stringify(cur);
  const run = async (what: "test" | "all") => {
    setBusy(true);
    await api<{ ok: boolean; sent: number }>("publish/autodm/sync", { body: { what } }).then((r) => toast(what === "test" ? "Test row sent" : `Sent ${r.sent} emails`, "ok")).catch((e) => toast((e as Error).message, "bad"));
    setBusy(false);
  };
  return (
    <>
      <Head title="Sync">Each new email (and, if you like, each DM) is posted to an address of yours: a Google Sheet, Zapier, Make, your CRM.</Head>
      <Field label="Address (https)"><input type="url" inputMode="url" placeholder="https://script.google.com/macros/s/…/exec" value={x.url} onChange={(e) => setX({ ...x, url: e.target.value.trim() })} /></Field>
      <div className="dm-pills" style={{ marginTop: 10 }}>
        <button type="button" className={`dm-pill${x.leads ? " on" : ""}`} aria-pressed={x.leads} onClick={() => setX({ ...x, leads: !x.leads })}>Emails</button>
        <button type="button" className={`dm-pill${x.dms ? " on" : ""}`} aria-pressed={x.dms} onClick={() => setX({ ...x, dms: !x.dms })}>Every DM sent</button>
        <button type="button" className={`dm-pill${x.on ? " on" : ""}`} aria-pressed={x.on} disabled={!x.url} onClick={() => setX({ ...x, on: !x.on })}>{x.on ? "Sync on" : "Sync off"}</button>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button className="sm" disabled={!changed} onClick={() => save({ sync: x }, "Sync saved")}>Save</button>
        <button className="ghost sm" disabled={busy || changed || !cur.url} onClick={() => run("test")}><PaperPlaneTilt size={14} />Send a test</button>
        <button className="ghost sm" disabled={busy || changed || !cur.url} onClick={() => run("all")}>Send every email</button>
        <button className="ghost sm" style={{ marginLeft: "auto" }} aria-expanded={howto} onClick={() => setHowto(!howto)}>Google Sheet how-to</button>
      </div>
      {howto && (
        <div className="dm-howto">
          <p className="small" style={{ margin: 0 }}>In the sheet: Extensions → Apps Script, paste this, then Deploy → New deployment → Web app, anyone can access. Paste the address above.</p>
          <pre className="mono tiny">{SCRIPT}</pre>
          <button className="ghost xs" onClick={() => navigator.clipboard.writeText(SCRIPT).then(() => toast("Copied", "ok"))}><Copy size={12} />Copy</button>
        </div>
      )}

      <div className="dm-set-split" />
      <Head title="Weekly report">The week in one note, in your notifications: sent, opened, emails, the best automation. Insights keeps the latest.</Head>
      <Toggle on={rep.on} set={(v) => save({ report: { ...rep, on: v } }, v ? "Weekly report on" : "Weekly report off")} title="Send it every week" about={rep.last ? `Last one ${ago(rep.last)}.` : "None yet."} />
      <div className="dm-grid" style={{ marginTop: 10 }}>
        <Field label="Report day"><Select label="Report day" value={String(rep.day)} onChange={(v) => save({ report: { ...rep, day: Number(v) } }, `Reports on ${DAYS[Number(v)]}s`)} options={DAYS.map((n, i) => [String(i), n] as [string, string])} /></Field>
      </div>
    </>
  );
}

function Defaults({ d, save }: Props) {
  const flat = (x: Overview["defaults"]) => ({ ...x, public_replies: x.public_replies.join("\n") });
  const [x, setX] = useState(flat(d.settings.defaults));
  const changed = JSON.stringify(flat(d.settings.defaults)) !== JSON.stringify(x);
  const t = (k: keyof typeof x, label: string, hint?: string) => (
    <Field label={label} hint={hint}><textarea className="doc short" value={x[k]} onChange={(e) => setX({ ...x, [k]: e.target.value })} /></Field>
  );
  return (
    <>
      <Head title="Default words">New automations start from these, and an empty field in one uses them. {"{handle}"} is your @, {"{username}"} theirs.</Head>
      <div className="dm-stack">
        {t("public_replies", "Public answers", "One per line, picked at random.")}
        {t("gate_message", "Ask non-followers to follow")}
        <Field label="Follow button"><input value={x.gate_button} maxLength={20} onChange={(e) => setX({ ...x, gate_button: e.target.value })} /></Field>
        {t("not_following", "Tapped but not following yet")}
        {t("ask_email", "Ask for their email")}
        {t("thanks_email", "Thanks for the email")}
      </div>
      <SaveBar changed={changed} onSave={() => save({ defaults: { ...x, public_replies: x.public_replies.split("\n") } }, "Defaults saved")} onUndo={() => setX(flat(d.settings.defaults))} />
    </>
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
  const [res, setRes] = useState<{ automation: { name: string } | null; steps: { to: string; text: string; buttons: string[] }[]; note: string } | null>(null);
  const run = () => text.trim() && api("publish/autodm/test", { body: { text, kind, account } }).then(setRes).catch((e) => setRes({ automation: null, steps: [], note: (e as Error).message }));
  return (
    <div className="dm-tester">
      <h3 className="row small" style={{ gap: 7, margin: 0 }}><Flask size={16} />Try a comment</h3>
      <p className="tiny dim" style={{ margin: "2px 0 8px" }}>Against every live automation, the way Instagram would send it. Nothing goes out.</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Seg label="Kind" value={kind} set={setKind} options={[["comment", "Comment"], ["dm", "DM"], ["story", "Story reply"]]} />
        {d.status.accounts.length > 1 && <Select size="sm" label="Account" value={account} onChange={setAccount} options={d.status.accounts.map((a) => [a.id, handleOf(a)] as [string, string])} />}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <input aria-label="Text to try" placeholder="e.g. catch!" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} style={{ flex: 1, minWidth: 0 }} />
        <button className="sm" onClick={run} disabled={!text.trim()}>Try</button>
      </div>
      {res && (
        <div className="dm-preview" role="status">
          <b className="small">{res.automation ? `“${res.automation.name}” answers it` : res.note}</b>
          {res.steps.map((s, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <span className="tiny faint">{s.to}</span>
              <p className="small" style={{ whiteSpace: "pre-wrap", margin: "2px 0 0" }}>{s.text}</p>
              {s.buttons?.length > 0 && <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: "wrap" }}>{s.buttons.map((b) => <span key={b} className="pill outline">{b}</span>)}</div>}
            </div>
          ))}
          {res.automation && <p className="tiny faint" style={{ margin: "8px 0 0" }}>{res.note}</p>}
        </div>
      )}
    </div>
  );
}

function Setup({ d, reload }: { d: Overview; reload: () => void }) {
  const { toast } = useDialog();
  const st = d.status;
  const [busy, setBusy] = useState(false);
  const hook = typeof location === "undefined" ? "" : `${location.origin}/api/ig/webhook`;
  const subscribe = async (account?: string) => {
    setBusy(true);
    await api<{ results: { handle: string | null; ok: boolean; error?: string }[] }>("publish/autodm/subscribe", { body: { account } })
      .then((r) => r.results.forEach((x) => toast(x.ok ? `@${x.handle} is sending its comments and messages` : `@${x.handle}: ${x.error}`, x.ok ? "ok" : "bad"))).catch((e) => toast((e as Error).message, "bad"));
    setBusy(false); reload();
  };
  return (
    <>
      <Head title="Set up">Once per Meta app, then once per account.</Head>
      <ol className="dm-steps">
        <Step ok={st.flag} title="Messaging permission in the Meta app">
          {st.flag ? "On: Instagram sign-in asks for messages." : <>Add <code>instagram_business_manage_messages</code> to the Meta app (App Review → Advanced Access, for anyone who isn&apos;t a tester), then set <code>INSTAGRAM_DM=1</code> on the Worker.</>}
        </Step>
        <Step ok={st.verify_token && st.app_secret && !!st.last_event} title="Webhook in the Meta app">
          <>Instagram → Webhooks: the callback URL below, verify token <code>INSTAGRAM_WEBHOOK_TOKEN</code>{st.verify_token ? " (set)" : " (not set yet)"}. Subscribe to <code>comments</code>, <code>messages</code>, <code>messaging_postbacks</code> and <code>mentions</code>.</>
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
        )) : <Step ok={false} title="Connect Instagram">Posts → Autopilot → Connect (a Creator or Business account). Add as many as you like.</Step>}
        <Step ok={null} title="On each phone">Instagram → Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages.</Step>
      </ol>
      <p className="tiny faint" style={{ margin: "10px 0 0" }}>Instagram&apos;s limits: one private reply per comment, within 7 days of it; after someone messages you or taps a button, 24 hours to answer.</p>
      <div className="dm-set-split" />
      <Tester d={d} />
    </>
  );
}

export function DmSettingsTab({ d, reload }: { d: Overview; reload: () => void }) {
  const { toast } = useDialog();
  const router = useRouter();
  const sp = useSearchParams();
  const raw = sp.get("section");
  const sec: Sec = SECTIONS.some((s) => s.id === raw) ? (raw as Sec) : "general";
  const go = (id: Sec) => router.replace(`/auto-dm?tab=settings&section=${id}`, { scroll: false });
  const save = (body: object, msg: string) => api("publish/autodm", { body }).then(() => { toast(msg, "ok"); reload(); }).catch((e) => toast((e as Error).message, "bad"));
  const dot: Partial<Record<Sec, "ok" | "warn">> = {
    general: d.settings.on ? "ok" : undefined,
    setup: d.status.flag && d.status.last_event && d.status.accounts.every((a) => a.messages === true && a.subscribed) ? "ok" : "warn",
    ai: d.status.ai_key ? "ok" : undefined,
    attach: d.settings.auto_attach.on ? "ok" : undefined,
    sync: d.settings.sync.on ? "ok" : undefined,
  };
  return (
    <div className="dm-set">
      <nav className="dm-set-nav" aria-label="Settings sections">
        {SECTIONS.map(({ id, name, Ic }) => (
          <Link key={id} href={`/auto-dm?tab=settings&section=${id}`} scroll={false} className={sec === id ? "on" : ""} aria-current={sec === id ? "page" : undefined} onClick={(e) => { e.preventDefault(); go(id); }}>
            <Ic size={16} weight="duotone" aria-hidden /><span>{name}</span>{dot[id] && <i className={`dm-set-dot ${dot[id]}`} aria-label={dot[id] === "ok" ? "on" : "needs attention"} />}
          </Link>
        ))}
      </nav>
      <section className="card dm-set-body" key={sec}>
        {sec === "general" && <General d={d} save={save} />}
        {sec === "safety" && <Safety d={d} save={save} />}
        {sec === "attach" && <Attach d={d} save={save} />}
        {sec === "ai" && <Ai d={d} save={save} />}
        {sec === "sync" && <Sync d={d} save={save} />}
        {sec === "defaults" && <Defaults d={d} save={save} />}
        {sec === "setup" && <Setup d={d} reload={reload} />}
      </section>
    </div>
  );
}
