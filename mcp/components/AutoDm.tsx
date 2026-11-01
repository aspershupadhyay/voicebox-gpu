"use client";
// Posts → Auto-DM: keyword rules ("comment CATCH and we'll DM you the link"), the setup checklist (Meta permission,
// webhook, reconnect, subscribe, the master switch), a dry-run tester and the DMs sent lately. The engine is
// lib/publish/autodm.ts; Instagram calls /api/ig/webhook.
import { ArrowsClockwise, ChatCircleDots, CheckCircle, Circle, Copy, Flask, PaperPlaneTilt, Plus, Trash, Warning, XCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DmLog, DmRule, DmSettings } from "@/lib/publish/autodm";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { Select } from "./pop";
import { Empty, Field, Notice, Toggle } from "./ui";

type Status = {
  flag: boolean; app_secret: boolean; verify_token: boolean; last_event: number | null;
  accounts: { id: string; handle: string | null; name: string; error: string | null; messages: boolean | null; subscribed: number | null }[];
};
type Data = { settings: DmSettings; log: DmLog[]; status: Status };
type Media = { id: string; caption: string; kind: string; thumb: string | null; url: string | null; at: string | null };
/** A rule as it's being typed: keywords and public answers stay text until they're saved. */
type Draft = Omit<DmRule, "keywords" | "public_replies"> & { keywords: string; public_replies: string };

const toDraft = (r: DmRule): Draft => ({ ...r, keywords: r.keywords.join(", "), public_replies: r.public_replies.join("\n") });
const fromDraft = (d: Draft): DmRule => ({
  ...d, keywords: d.keywords.split(",").map((k) => k.trim()).filter(Boolean),
  public_replies: d.public_replies.split("\n").map((x) => x.trim()).filter(Boolean),
});
const problem = (d: Draft) => (!d.on ? null : !d.message.trim() ? "Write the DM before switching this rule on." : d.match !== "any" && !d.keywords.trim() ? "Add a keyword, or set it to answer every comment." : null);
const rid = () => Math.random().toString(36).slice(2, 10);
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 6e4);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 60 * 36 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

function Step({ ok, title, children }: { ok: boolean | null; title: string; children?: React.ReactNode }) {
  return (
    <li className="dm-step">
      {ok ? <CheckCircle size={18} weight="fill" className="ok-t" aria-label="Done" /> : ok === false ? <Circle size={18} className="warn-t" aria-label="To do" /> : <Circle size={18} className="faint" aria-label="Check by hand" />}
      <div style={{ minWidth: 0, flex: 1 }}><div className="tr-t">{title}</div>{children && <div className="tr-d">{children}</div>}</div>
    </li>
  );
}

function Setup({ d, onChange }: { d: Data; onChange: () => void }) {
  const { toast } = useDialog();
  const [busy, setBusy] = useState(false);
  const s = d.status;
  const hook = typeof location === "undefined" ? "" : `${location.origin}/api/ig/webhook`;
  const copy = (v: string) => navigator.clipboard.writeText(v).then(() => toast("Copied", "ok"));
  const subscribe = async () => {
    setBusy(true);
    await api<{ results: { handle: string | null; ok: boolean; error?: string }[] }>("publish/autodm/subscribe", { body: {} })
      .then((r) => r.results.forEach((x) => toast(x.ok ? `@${x.handle} is sending its comments` : `@${x.handle}: ${x.error}`, x.ok ? "ok" : "bad")))
      .catch((e) => toast((e as Error).message, "bad"));
    setBusy(false); onChange();
  };
  return (
    <section className="card">
      <h2>Set up</h2>
      <ol className="dm-steps">
        <Step ok={s.flag} title="Messaging permission in the Meta app">
          {s.flag ? "On: Instagram sign-in asks for messages." : <>Add <code>instagram_business_manage_messages</code> to the Meta app (App Review → Advanced Access, for anyone who isn&apos;t a tester), then set <code>INSTAGRAM_DM=1</code> on the Worker.</>}
        </Step>
        <Step ok={s.verify_token && s.app_secret && !!s.last_event} title="Webhook in the Meta app">
          <>In the Meta app: Instagram → Webhooks. Callback URL below, the verify token is <code>INSTAGRAM_WEBHOOK_TOKEN</code>{s.verify_token ? " (set)" : " (not set yet: add it on the Worker)"}. Subscribe to <code>comments</code> and <code>messages</code>.</>
          <div className="row" style={{ gap: 6, marginTop: 6 }}><code className="ellipsis" style={{ flex: 1 }}>{hook}</code><button className="ghost xs" onClick={() => copy(hook)}><Copy size={12} />Copy</button></div>
          <span className="tiny faint" style={{ display: "block", marginTop: 4 }}>{s.last_event ? `Last heard from Instagram ${ago(s.last_event)}` : "Nothing heard from Instagram yet"}</span>
        </Step>
        {s.accounts.length ? s.accounts.map((a) => (
          <Step key={a.id} ok={a.messages === true && !!a.subscribed} title={`@${a.handle ?? a.name}`}>
            {a.error ? <span className="bad-t">{a.error} </span> : null}
            {a.messages === true ? "Messages allowed. " : <>Reconnect it so Instagram asks for messages{a.messages === null ? " (connected before Auto-DM, so its permissions aren't known)" : ""}. </>}
            {a.subscribed ? `Sending its comments since ${new Date(a.subscribed).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.` : "Not sending its comments yet."}
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              {a.messages !== true && <a className="btn ghost xs" href="/api/publish/instagram/connect"><ArrowsClockwise size={13} />Reconnect</a>}
              <button className="ghost xs" disabled={busy} onClick={subscribe}><PaperPlaneTilt size={13} />{a.subscribed ? "Subscribe again" : "Subscribe"}</button>
            </div>
          </Step>
        )) : <Step ok={false} title="Connect Instagram">In the Autopilot tab, connect the Creator or Business account.</Step>}
        <Step ok={null} title="On the phone">Instagram → Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages.</Step>
      </ol>
    </section>
  );
}

function Tester({ media }: { media: Media[] }) {
  const [text, setText] = useState("");
  const [post, setPost] = useState("");
  const [kind, setKind] = useState<"comment" | "dm">("comment");
  const [res, setRes] = useState<{ rule: { name: string } | null; would_send: { message: string; button: { label: string; url: string } | null; public_reply: string | null } | null; note: string } | null>(null);
  const run = () => text.trim() && api("publish/autodm/test", { body: { text, media: post || null, kind } }).then(setRes).catch((e) => setRes({ rule: null, would_send: null, note: (e as Error).message }));
  return (
    <section className="card">
      <h2 className="row" style={{ gap: 7 }}><Flask size={17} />Try a comment</h2>
      <p className="small dim" style={{ marginTop: 4 }}>See which rule answers it and what goes out. Nothing is sent.</p>
      <div className="dm-grid" style={{ marginTop: 10 }}>
        <Select size="sm" label="Comment or DM" value={kind} onChange={setKind} options={[["comment", "A comment"], ["dm", "A DM or story reply"]]} />
        {kind === "comment" && <Select size="sm" label="On which post" value={post} onChange={setPost} options={[["", "Any post"], ...media.map((m) => [m.id, m.caption || `${m.kind} ${m.id.slice(-5)}`] as const)]} />}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <input aria-label="Comment text" placeholder="e.g. CATCH!" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} style={{ flex: 1, minWidth: 0 }} />
        <button className="sm" onClick={run} disabled={!text.trim()}>Test</button>
      </div>
      {res && (
        <div className="dm-preview" role="status">
          <b className="small">{res.rule ? `"${res.rule.name}" answers it` : res.note}</b>
          {res.would_send && <>
            <p className="small" style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}>{res.would_send.message}</p>
            {res.would_send.button && <span className="pill outline" style={{ marginTop: 6 }}>{res.would_send.button.label}</span>}
            {res.would_send.public_reply && <p className="tiny dim" style={{ margin: "6px 0 0" }}>Public answer: {res.would_send.public_reply}</p>}
            <p className="tiny faint" style={{ margin: "6px 0 0" }}>{res.note}</p>
          </>}
        </div>
      )}
    </section>
  );
}

function RuleCard({ r, accounts, media, set, remove }: { r: Draft; accounts: Status["accounts"]; media: Media[]; set: (p: Partial<Draft>, now?: boolean) => void; remove: () => void }) {
  const { confirm, toast } = useDialog();
  const err = problem(r);
  const postOpts: [string, string][] = [["", "Every post and reel"], ...media.map((m) => [m.id, `${m.kind === "reel" ? "Reel" : m.kind === "carousel" ? "Carousel" : m.kind === "video" ? "Video" : "Photo"}: ${m.caption || m.id.slice(-6)}`] as [string, string])];
  if (r.media && !media.some((m) => m.id === r.media)) postOpts.push([r.media, r.media_label || `Post ${r.media.slice(-6)}`]);
  return (
    <section className="card dm-rule">
      <div className="row between" style={{ gap: 8 }}>
        <input className="dm-name" aria-label="Rule name" value={r.name} onChange={(e) => set({ name: e.target.value }, false)} />
        <div className="row" style={{ gap: 6 }}>
          <button type="button" role="switch" aria-checked={r.on} aria-label={`${r.name} on`} className={`switch ${r.on ? "on" : ""}`} onClick={() => set({ on: !r.on })} />
          <button className="icon-btn danger-h" aria-label={`Delete ${r.name}`} title="Delete" onClick={async () => { if (await confirm({ title: `Delete "${r.name}"?`, body: "Comments stop getting this DM. The log keeps what was already sent.", confirm: "Delete", danger: true })) remove(); }}><Trash size={15} /></button>
        </div>
      </div>
      <div className="dm-grid" style={{ marginTop: 12 }}>
        {accounts.length > 1 && <Field label="Account"><Select size="sm" label="Account" value={r.account ?? ""} onChange={(v) => set({ account: v || null })} options={[["", "Every account"], ...accounts.map((a) => [a.id, `@${a.handle ?? a.name}`] as [string, string])]} /></Field>}
        <Field label="When someone comments on"><Select size="sm" label="Post" value={r.media ?? ""} onChange={(v) => set({ media: v || null, media_label: v ? postOpts.find(([id]) => id === v)?.[1] ?? null : null })} options={postOpts} /></Field>
        <Field label="Their comment"><Select size="sm" label="Match" value={r.match} onChange={(v) => set({ match: v })} options={[["word", "Has the keyword"], ["exact", "Is just the keyword"], ["any", "Anything at all"]]} /></Field>
        {r.match !== "any" && <Field label="Keywords" hint="Comma between them. Capitals don't matter: CATCH, catch and Catch! all count."><input value={r.keywords} placeholder="CATCH" onChange={(e) => set({ keywords: e.target.value }, false)} /></Field>}
      </div>
      <Field label="The DM" hint={`${r.message.length} / 1000${r.button ? " (640 with a button)" : ""}`} style={{ marginTop: 12 }}>
        <textarea className="doc short" value={r.message} placeholder="Hey! Here's the link you asked for 👇" onChange={(e) => set({ message: e.target.value }, false)} />
      </Field>
      <div className="dm-grid" style={{ marginTop: 12 }}>
        <Field label="Button text" hint="Optional: a link button under the DM"><input value={r.button?.label ?? ""} maxLength={20} placeholder="Open the prompt" onChange={(e) => set({ button: { label: e.target.value, url: r.button?.url ?? "" } }, false)} /></Field>
        <Field label="Button link"><input type="url" value={r.button?.url ?? ""} placeholder="https://" onChange={(e) => set({ button: e.target.value || r.button?.label ? { label: r.button?.label ?? "", url: e.target.value } : null }, false)} /></Field>
      </div>
      <Field label="Answer the comment in public" hint="One per line; a different one is picked each time so it doesn't look like a bot. Empty: no public answer." style={{ marginTop: 12 }}>
        <textarea className="doc short" value={r.public_replies} placeholder={"Sent! Check your DMs 📩\nIt's in your DMs 🙌"} onChange={(e) => set({ public_replies: e.target.value }, false)} />
      </Field>
      <Toggle on={r.dms} set={(v) => set({ dms: v })} title="Also answer DMs and story replies" about="Someone who sends the keyword in a DM or as a reply to your story gets the same message." />
      <Toggle on={r.once_per_person} set={(v) => set({ once_per_person: v })} title="Once per person" about="Someone who comments the keyword again doesn't get the DM twice." />
      {r.once_per_person && <button className="ghost xs" style={{ marginTop: 4 }} onClick={async () => { if (await confirm({ title: "Let everyone get it again?", body: "People who already got this DM get it again the next time they comment the keyword.", confirm: "Reset" })) api<{ cleared: number }>(`publish/autodm/reset/${r.id}`, { body: {} }).then((x) => toast(`Reset (${x.cleared} people)`, "ok")).catch((e) => toast((e as Error).message, "bad")); }}>Let everyone get it again</button>}
      {err && <p className="err" role="status">{err}</p>}
    </section>
  );
}

export function AutoDm() {
  const { toast } = useDialog();
  const [d, setD] = useState<Data | null>(null);
  const [rules, setRules] = useState<Draft[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState("");
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(() => api<Data>("publish/autodm").then((x) => { setD(x); setRules(x.settings.rules.map(toDraft)); setError(""); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const first = d?.status.accounts[0]?.id;
  useEffect(() => { if (first) api<{ media: Media[] }>(`publish/autodm/media/${first}`).then((x) => setMedia(x.media)).catch(() => null); }, [first]);

  const save = (next: Draft[], now = true) => {
    setRules(next);
    clearTimeout(t.current);
    if (next.some(problem)) return; // said under the rule; saved once it's fixed
    const go = () => api<{ settings: DmSettings }>("publish/autodm", { body: { rules: next.map(fromDraft) } })
      .then((x) => setD((cur) => (cur ? { ...cur, settings: x.settings } : cur))).catch((e) => toast((e as Error).message, "bad"));
    if (now) go(); else t.current = setTimeout(go, 700);
  };
  const setOn = (on: boolean) => api<{ settings: DmSettings }>("publish/autodm", { body: { on } }).then((x) => { setD((cur) => (cur ? { ...cur, settings: x.settings } : cur)); toast(on ? "Auto-DM is on" : "Auto-DM is off", "ok"); }).catch((e) => toast((e as Error).message, "bad"));
  const add = () => save([...rules, toDraft({ id: rid(), on: false, name: "Comment CATCH", account: null, media: null, media_label: null, keywords: ["CATCH"], match: "word", message: "", button: null, public_replies: ["Sent! Check your DMs 📩"], dms: true, once_per_person: true })]);

  if (!d) return <div className="autopilot">{error ? <Notice icon={<Warning size={18} />} tone="bad" action={<button className="sm" onClick={load}>Try again</button>}>{error}</Notice> : <p className="small dim">Loading…</p>}</div>;
  const ready = d.status.flag && d.status.accounts.some((a) => a.messages === true && a.subscribed);
  const sent = d.log.filter((l) => l.ok && !l.note).length;
  return (
    <div className="autopilot">
      {d.settings.on && !ready && <Notice icon={<Warning size={18} />} tone="warn">Auto-DM is on but can&apos;t send yet: finish the steps under Set up.</Notice>}
      <div className="ap-cols">
        <div className="ap-main">
          <section className="card">
            <Toggle on={d.settings.on} set={setOn} title="Send DMs automatically" about={ready ? "Comments and DMs that match a rule below get their message within seconds." : "You can switch it on now; it starts sending once setup is done."} />
          </section>
          <div className="row between"><h2 className="row" style={{ gap: 7, margin: 0 }}><ChatCircleDots size={17} />Rules<span className="pill">{rules.length}</span></h2>
            <button className="ghost xs" onClick={add}><Plus size={13} />Rule</button></div>
          {rules.length ? rules.map((r, i) => (
            <RuleCard key={r.id} r={r} accounts={d.status.accounts} media={media}
              set={(p, now = true) => save(rules.map((x, k) => (k === i ? { ...x, ...p } : x)), now)}
              remove={() => save(rules.filter((_, k) => k !== i))} />
          )) : <Empty icon={<ChatCircleDots size={20} />} title="No rules yet" action={<button className="sm" onClick={add}><Plus size={14} />Add a rule</button>}>A rule is a keyword and the DM it sends: &ldquo;Comment CATCH and we&apos;ll DM you the link.&rdquo;</Empty>}
          <section className="q-group">
            <h2><PaperPlaneTilt size={16} />Sent lately<span className="pill">{sent}</span><button className="ghost xs" style={{ marginLeft: "auto" }} onClick={load}><ArrowsClockwise size={13} />Refresh</button></h2>
            {d.log.length ? <div className="q-list">{d.log.map((l) => (
              <div key={`${l.at}-${l.ref}`} className="q-row">
                {l.ok ? <CheckCircle size={18} weight="fill" className={l.note ? "faint" : "ok-t"} aria-label={l.note ? "Skipped" : "Sent"} /> : <XCircle size={18} weight="fill" className="bad-t" aria-label="Failed" />}
                <div className="q-main" style={{ cursor: "default" }}>
                  <b className="ellipsis">{l.from ? `@${l.from}` : l.kind === "dm" ? "A DM" : "A comment"} · {l.rule_name || "No rule"}</b>
                  <span className="tiny dim ellipsis">&ldquo;{l.text}&rdquo;{l.replied ? " · answered in public" : ""}</span>
                  {(l.error || l.note) && <span className={`tiny ${l.error ? "bad-t" : "faint"}`}>{l.error ?? l.note}</span>}
                </div>
                <span className="q-when tiny mono dim">{ago(l.at)}</span>
              </div>
            ))}</div> : <p className="tiny faint" style={{ margin: "4px 0 0" }}>Nothing sent yet.</p>}
          </section>
        </div>
        <aside className="ap-side dm-side">
          <Setup d={d} onChange={load} />
          <Tester media={media} />
          <p className="tiny faint">Instagram&apos;s limits: one private reply per comment, within 7 days of it; a DM conversation stays open for 24 hours after the person&apos;s last message.</p>
        </aside>
      </div>
    </div>
  );
}
