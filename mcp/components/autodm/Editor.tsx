"use client";
// One automation as a flow (/auto-dm?tab=automations&edit=<id>, or edit=new&template=<id>): steps down a line, one open
// at a time. When (comments, DMs, story replies, mentions; accounts; posts) → Match → [Followers only] → [Email first] →
// The DM (link button counted through a short link, choices, an A/B version) → [Email after] → Public answer →
// [AI follow-ups] → Limits. Optional steps come in with "+ Add a step". The phone on the right plays the flow, and its
// comment box tries any comment against this draft as you type (lib/publish/dmmatch.ts, the webhook's own matcher).
import { ArrowLeft, Brain, ChatCircle, Check, Copy, DotsThree, EnvelopeSimple, Flask, GitBranch, Image as ImageIc, Lightning, Link as LinkIc, MagnifyingGlass, PaperPlaneTilt, Plus, Scales, ShieldCheck, Sliders, Trash, UserCheck, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { matchText } from "@/lib/publish/dmmatch";
import { api } from "../api";
import { useDialog } from "../Dialog";
import { Select, useDismiss } from "../pop";
import { Field, PopMenu, Toggle } from "../ui";
import { TEMPLATES } from "./AutoDm";
import { Chips, Seg, handleOf, rate, type Acct, type Automation, type Overview } from "./shared";

type Media = { id: string; caption: string; kind: string; thumb: string | null; url: string | null; at: string | null; comments: number | null };
type Studio = { id: string; title: string; space: string; state: string; account: string | null; media: string | null; url: string | null };
type Choice = Automation["choices"][number];

const blank = (): Automation => ({
  id: "", name: "New automation", on: false, created: 0, updated: 0, by: null, accounts: [], where: "all", media: [], posts: [], resolved: {},
  triggers: { comments: true, dms: false, story_replies: false, mentions: false }, match: "fuzzy", keywords: [], exclude: [], typos: 0, top_level_only: false,
  message: "", button: null, track: true, ab: { on: false, message: "", button_label: "", min: 50, winner: null, decided: null }, choices: [],
  public_replies: [], follow_gate: { on: false, message: "", button: "", not_following: "" }, collect: { on: false, when: "after", ask: "", thanks: "" },
  ai: { on: false, notes: "" }, once_per_person: true, made_from: null,
});
const rid = () => Math.random().toString(36).slice(2, 10);
const words = (a: Automation) => a.triggers.comments || a.triggers.dms || a.triggers.story_replies;

/** The same checks the server makes before an automation can go live (lib/publish/autodm.ts problems). */
function missing(a: Automation) {
  const out: string[] = [];
  if (!a.message.trim()) out.push("Write the DM");
  if (a.match !== "any" && !a.keywords.length && words(a)) out.push("Add a keyword (or answer anything)");
  if (!words(a) && !a.triggers.mentions) out.push("Pick what starts it");
  if (a.where === "some" && a.triggers.comments && !a.media.length && !a.posts.length) out.push("Choose the posts");
  if (a.button && !a.button.url) out.push("Add the button's link");
  if ((a.button || a.choices.length) && a.message.length > 640) out.push("With buttons the DM is up to 640 characters");
  if ((a.button ? 1 : 0) + a.choices.length > 3) out.push("Up to 3 buttons (the link counts)");
  if (a.choices.some((c) => !c.label.trim() || !c.reply.trim())) out.push("Each choice needs a button and a reply");
  if (a.choices.some((c) => c.button && !c.button.url)) out.push("A choice's button needs its link");
  if (a.ab.on && !a.ab.message.trim()) out.push("Write version B");
  return out;
}

function Picker({ accounts, a, set, close }: { accounts: Acct[]; a: Automation; set: (p: Partial<Automation>) => void; close: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, close, [box]);
  const [src, setSrc] = useState<"ig" | "studio">("ig");
  const [acct, setAcct] = useState(a.accounts[0] ?? accounts[0]?.id ?? "");
  const [media, setMedia] = useState<Media[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [studio, setStudio] = useState<Studio[] | null>(null);
  const [q, setQ] = useState("");
  const more = async (reset = false) => {
    if (!acct) return;
    setBusy(true);
    await api<{ media: Media[]; after: string | null }>(`publish/autodm/media/${acct}${!reset && after ? `?after=${encodeURIComponent(after)}` : ""}`)
      .then((r) => { setMedia((m) => (reset ? r.media : [...m, ...r.media])); setAfter(r.after); setErr(""); }).catch((e) => setErr((e as Error).message));
    setBusy(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setMedia([]); setAfter(null); more(true); }, [acct]);
  useEffect(() => { if (src === "studio" && !studio) api<{ posts: Studio[] }>("publish/autodm/posts").then((r) => setStudio(r.posts)).catch((e) => setErr((e as Error).message)); }, [src, studio]);
  const t = q.trim().toLowerCase();
  const toggleM = (m: Media) => set({ media: a.media.some((x) => x.id === m.id) ? a.media.filter((x) => x.id !== m.id) : [...a.media, { id: m.id, label: m.caption || `${m.kind} ${m.id.slice(-5)}`, thumb: m.thumb }] });
  const toggleS = (p: Studio) => set({ posts: a.posts.some((x) => x.id === p.id) ? a.posts.filter((x) => x.id !== p.id) : [...a.posts, { id: p.id, label: p.title, thumb: null }] });
  return (
    <>
      <div className="scrim-modal" aria-hidden />
      <div className="modal dm-picker" ref={box} role="dialog" aria-modal="true" aria-label="Choose posts">
        <div className="row between"><h3>Choose posts</h3><button className="icon-btn" aria-label="Close" onClick={close}><X size={16} /></button></div>
        <div className="dm-picker-bar">
          <Seg label="From" value={src} set={setSrc} options={[["ig", "On Instagram"], ["studio", "Studio posts"]]} />
          {src === "ig" && accounts.length > 1 && <Select size="sm" label="Account" value={acct} onChange={setAcct} options={accounts.map((x) => [x.id, `@${x.handle ?? x.name}`] as [string, string])} />}
          <label className="dm-search" style={{ flex: 1 }}><MagnifyingGlass size={15} aria-hidden /><input type="search" aria-label="Search posts" placeholder={src === "ig" ? "Search captions" : "Search titles"} value={q} onChange={(e) => setQ(e.target.value)} /></label>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="dm-picker-body">
          {src === "ig" ? (
            <>
              <div className="dm-grid-media">
                {media.filter((m) => !t || m.caption.toLowerCase().includes(t)).map((m) => {
                  const on = a.media.some((x) => x.id === m.id);
                  return (
                    <button key={m.id} type="button" className={`dm-media ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggleM(m)} title={m.caption}>
                      {m.thumb ? <img src={m.thumb} alt="" loading="lazy" /> : <span className="dm-media-ph"><ImageIc size={22} /></span>}
                      <span className="dm-media-kind tiny">{m.kind}</span>
                      {on && <span className="dm-media-check" aria-hidden><Check size={14} weight="bold" /></span>}
                      <span className="dm-media-cap tiny ellipsis">{m.caption || "No caption"}</span>
                    </button>
                  );
                })}
              </div>
              {busy ? <p className="small dim">Loading…</p> : after ? <button className="ghost sm" style={{ margin: "10px auto 0", display: "flex" }} onClick={() => more()}>Load more</button> : !media.length && !err ? <p className="small dim">No posts on this account yet.</p> : null}
            </>
          ) : (
            <div className="q-list">
              {!studio ? <p className="small dim" style={{ padding: 12 }}>Loading…</p> : !studio.length ? <p className="small dim" style={{ padding: 12 }}>No studio posts with an Instagram Reel or Post set up.</p>
                : studio.filter((p) => !t || p.title.toLowerCase().includes(t)).map((p) => {
                  const on = a.posts.some((x) => x.id === p.id);
                  return (
                    <button key={`${p.id}-${p.space}`} type="button" className="q-row dm-studio" aria-pressed={on} onClick={() => toggleS(p)}>
                      <span className={`dm-check ${on ? "on" : ""}`} aria-hidden>{on && <Check size={12} weight="bold" />}</span>
                      <span className="q-main"><b className="ellipsis">{p.title}</b><span className="tiny dim">{p.space === "ig_reel" ? "Reel" : "Post"}</span></span>
                      <span className={`pill ${p.state === "published" ? "ok" : ""}`}>{p.state === "published" ? "Live" : "Not posted yet"}</span>
                    </button>
                  );
                })}
            </div>
          )}
        </div>
        <div className="row between" style={{ marginTop: 14 }}>
          <span className="small dim">{a.media.length + a.posts.length} chosen · a studio post counts once it&apos;s live</span>
          <button className="sm" onClick={close}>Done</button>
        </div>
      </div>
    </>
  );
}

/** One step of the flow: a dot on the line, its name and a one-line summary; open, its settings. */
function Node({ id, open, setOpen, icon, title, sum, tone, onRemove, children }: {
  id: string; open: string; setOpen: (id: string) => void; icon: React.ReactNode; title: string; sum: React.ReactNode; tone?: "warn" | "add"; onRemove?: () => void; children: React.ReactNode;
}) {
  const on = open === id;
  return (
    <section className={`dm-node ${on ? "open" : ""} ${tone ?? ""}`} aria-labelledby={`n-${id}`}>
      <span className="dm-node-dot" aria-hidden>{icon}</span>
      <div className="dm-node-card">
        <div className="dm-node-head">
          <button type="button" className="dm-node-btn" id={`n-${id}`} aria-expanded={on} onClick={() => setOpen(on ? "" : id)}>
            <b>{title}</b><span className="dm-node-sum">{sum}</span>
          </button>
          {onRemove && <button type="button" className="icon-btn" aria-label={`Remove ${title}`} onClick={onRemove}><X size={14} /></button>}
        </div>
        {on && <div className="dm-node-body">{children}</div>}
      </div>
    </section>
  );
}

/** The phone: the flow as people get it, and a comment box that tries a comment against the draft. */
function Phone({ a, d }: { a: Automation; d: Overview }) {
  const acc = d.status.accounts.find((x) => a.accounts.includes(x.id)) ?? d.status.accounts[0];
  const handle = acc?.handle ?? "you";
  const [text, setText] = useState("");
  const [v, setV] = useState<"a" | "b">("a");
  const [chose, setChose] = useState<number | null>(null);
  const fill = (t: string) => t.replace(/\{handle\}/g, handle).replace(/\{username\}/g, "alex").replace(/\{title\}/g, a.name);
  const kind = a.triggers.comments ? "comment" : a.triggers.dms ? "DM" : a.triggers.story_replies ? "story reply" : "mention";
  const hit = text.trim() ? (a.triggers.mentions && !words(a) ? "*" : matchText(a, text)) : null;
  const sample = text.trim() || (a.triggers.mentions && !words(a) ? "mentioned you in their story" : a.match === "any" ? "This is fire 🔥" : a.keywords[0] ?? "KEYWORD");
  const showFlow = !text.trim() || !!hit;
  const isB = v === "b" && a.ab.on && !!a.ab.message;
  const msg = isB ? a.ab.message : a.message;
  const label = (isB && a.ab.button_label) || a.button?.label || "Open";
  const askAfter = a.collect.on && a.collect.when === "after";
  const ask = fill(a.collect.ask || d.defaults.ask_email);
  useEffect(() => setChose(null), [a.choices.length]);
  return (
    <div className="dm-phone" aria-label="What people see">
      <div className="dm-phone-top"><span className="pv-av">{acc?.avatar ? <img src={acc.avatar} alt="" /> : handle.slice(0, 1).toUpperCase()}</span><b>{handle}</b>
        {a.ab.on && a.ab.message && <span className="dm-phone-ab"><Seg label="Version" value={v} set={setV} options={[["a", "A"], ["b", "B"]]} /></span>}</div>
      <div className="dm-phone-body">
        <div className="dm-thread">
          <span className="tiny faint">{kind === "mention" ? "Story mention" : kind === "comment" ? "Comment" : kind === "DM" ? "DM" : "Story reply"}</span>
          <div className="dm-cmt"><b>alex</b> {sample}</div>
          {showFlow && a.triggers.comments && a.public_replies[0] && kind === "comment" && <div className="dm-cmt reply"><b>{handle}</b> {fill(a.public_replies[0])}</div>}
        </div>
        {!showFlow ? <p className="dm-nofire small">Doesn&apos;t fire: {a.exclude.some((x) => text.toLowerCase().includes(x.toLowerCase())) ? "it has an ignored word" : "no keyword in it"}.</p> : (
          <div className="dm-thread">
            <span className="tiny faint">DM from @{handle}</span>
            {a.follow_gate.on && <>
              <div className="dm-bub">{fill(a.follow_gate.message || d.defaults.gate_message)}<span className="dm-btn">{a.follow_gate.button || d.defaults.gate_button}</span></div>
              <div className="dm-bub me">I&apos;m following ✅</div>
            </>}
            {a.collect.on && a.collect.when === "before" && <><div className="dm-bub">{ask}</div><div className="dm-bub me">alex@mail.com</div></>}
            <div className="dm-bub">
              {a.collect.on && a.collect.when === "before" && <span className="dm-bub-pre">{fill(a.collect.thanks || d.defaults.thanks_email)}</span>}
              {msg ? fill(msg) : <span className="faint">Your DM shows here</span>}
              {askAfter && kind === "comment" && <span className="dm-bub-pre">{ask}</span>}
              {a.button && <span className="dm-btn"><LinkIc size={12} />{label}</span>}
              {a.choices.map((c, i) => <button key={c.id} type="button" className={`dm-btn ${chose === i ? "on" : ""}`} onClick={() => setChose(i)}>{c.label || `Choice ${i + 1}`}</button>)}
            </div>
            {chose != null && a.choices[chose] && <>
              <div className="dm-bub me">{a.choices[chose].label}</div>
              <div className="dm-bub">{fill(a.choices[chose].reply) || <span className="faint">Its reply</span>}{a.choices[chose].button && <span className="dm-btn"><LinkIc size={12} />{a.choices[chose].button!.label}</span>}</div>
            </>}
            {askAfter && kind !== "comment" && <div className="dm-bub">{ask}</div>}
            {a.ai.on && <><div className="dm-bub me">how long is it?</div><div className="dm-bub ai"><span className="dm-ai-tag"><Brain size={11} />AI</span>Answers from the post&apos;s script and your notes.</div></>}
          </div>
        )}
      </div>
      <label className="dm-phone-try">
        <Flask size={15} aria-hidden />
        <input aria-label="Try a comment" placeholder={`Try a ${kind === "mention" ? "comment" : kind}…`} value={text} onChange={(e) => setText(e.target.value)} />
        {text.trim() && <span className={`pill ${hit ? "ok" : ""}`} role="status">{hit ? (hit === "*" ? "Fires" : `Fires · ${hit}`) : "No"}</span>}
      </label>
    </div>
  );
}

function AiTest({ a, dirty }: { a: Automation; dirty: boolean }) {
  const [q, setQ] = useState("");
  const [r, setR] = useState<{ answer: string | null; note: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await api<{ answer: string | null; note: string | null }>("publish/autodm/ai", { body: { automation: a.id, question: q } }).then(setR).catch((e) => setR({ answer: null, note: (e as Error).message }));
    setBusy(false);
  };
  if (!a.id || dirty) return <p className="tiny faint" style={{ margin: 0 }}>Save to try a question.</p>;
  return (
    <div>
      <div className="row" style={{ gap: 6 }}>
        <input aria-label="A follow-up question" placeholder="e.g. is the prompt free?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim() && run()} style={{ flex: 1, minWidth: 0 }} />
        <button className="ghost sm" disabled={!q.trim() || busy} onClick={run}>{busy ? "Asking…" : "Ask"}</button>
      </div>
      {r && <div className="dm-ai-out" role="status">{r.answer && <p className="small" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.answer}</p>}{r.note && <p className="tiny dim" style={{ margin: r.answer ? "6px 0 0" : 0 }}>{r.note}</p>}</div>}
    </div>
  );
}

export default function Editor({ id, template, d, reload, close, opened }: { id: string; template: string | null; d: Overview; reload: () => void; close: () => void; opened: (id: string) => void }) {
  const { toast, confirm } = useDialog();
  const found = d.settings.automations.find((x) => x.id === id);
  const start = useMemo<Automation>(() => {
    const b = blank();
    if (found) return { ...b, ...found };
    const t = TEMPLATES.find((x) => x.id === template) ?? TEMPLATES[TEMPLATES.length - 1];
    const m = t.make(d.defaults);
    return { ...b, ...m, triggers: { ...b.triggers, ...m.triggers }, follow_gate: { ...b.follow_gate, ...m.follow_gate }, collect: { ...b.collect, ...m.collect } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [a, setA] = useState<Automation>(start);
  const [saved, setSaved] = useState<string>(found ? JSON.stringify(start) : "");
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(found ? "" : "dm");
  const set = (p: Partial<Automation>) => setA((x) => ({ ...x, ...p }));
  const dirty = JSON.stringify(a) !== saved;
  const todo = missing(a);
  const accounts = d.status.accounts;
  const st = a.id ? d.stats[a.id] : undefined;

  const save = async (on?: boolean) => {
    setSaving(true);
    try {
      const r = await api<{ automation: Automation; problems: string[] }>("publish/autodm/automation", { body: { automation: { ...a, id: a.id || undefined, ...(on !== undefined ? { on } : {}) } } });
      setA(r.automation); setSaved(JSON.stringify(r.automation));
      if (on && r.problems.length) toast(`Saved, but it stays off: ${r.problems[0]}`, "bad");
      else toast(on === true ? "Live" : on === false ? "Switched off" : "Saved", "ok");
      reload();
      if (!a.id) opened(r.automation.id);
    } catch (e) { toast((e as Error).message, "bad"); }
    setSaving(false);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (dirty) save(); } };
    addEventListener("keydown", k);
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    addEventListener("beforeunload", warn);
    return () => { removeEventListener("keydown", k); removeEventListener("beforeunload", warn); };
  });
  const back = async () => { if (!dirty || await confirm({ title: "Leave without saving?", body: "Your changes to this automation will be lost.", confirm: "Leave", danger: true })) close(); };
  const handle = handleOf(accounts.find((x) => a.accounts.includes(x.id)) ?? accounts[0]) || "@you";
  const fg = a.follow_gate, co = a.collect, ab = a.ab;
  const buttons = (a.button ? 1 : 0) + a.choices.length;
  const setChoice = (i: number, p: Partial<Choice>) => set({ choices: a.choices.map((c, j) => (j === i ? { ...c, ...p } : c)) });

  // the optional steps not in the flow yet
  const adds = [
    !fg.on && { k: "follow", label: "Followers only", icon: <UserCheck size={14} />, go: () => { set({ follow_gate: { ...fg, on: true } }); setOpen("follow"); } },
    !co.on && { k: "email", label: "Ask for email", icon: <EnvelopeSimple size={14} />, go: () => { set({ collect: { ...co, on: true } }); setOpen("email"); } },
    buttons < 3 && !a.choices.length && { k: "choices", label: "Choices", icon: <GitBranch size={14} />, go: () => { set({ choices: [{ id: rid(), label: "", reply: "", button: null }] }); setOpen("dm"); } },
    !ab.on && { k: "ab", label: "A/B test", icon: <Scales size={14} />, go: () => { set({ ab: { ...ab, on: true } }); setOpen("dm"); } },
    !a.ai.on && { k: "ai", label: "AI follow-ups", icon: <Brain size={14} />, go: () => { set({ ai: { ...a.ai, on: true } }); setOpen("ai"); } },
  ].filter(Boolean) as { k: string; label: string; icon: React.ReactNode; go: () => void }[];

  const trig = [a.triggers.comments && "Comments", a.triggers.dms && "DMs", a.triggers.story_replies && "Story replies", a.triggers.mentions && "Mentions"].filter(Boolean).join(", ") || "Nothing yet";
  const emailNode = co.on && (
    <Node id="email" open={open} setOpen={setOpen} icon={<EnvelopeSimple size={14} />} title={co.when === "before" ? "Email first" : "Ask for email"} onRemove={() => set({ collect: { ...co, on: false } })}
      sum={co.when === "before" ? "The DM waits for their email" : "After the DM: they reply with it"}>
      <Seg label="When" value={co.when} set={(v) => set({ collect: { ...co, when: v } })} options={[["after", "After the DM"], ["before", "Before (unlocks the DM)"]]} />
      <Field label="The question" hint="Emails land in People → Emails, and in your sheet when sync is on."><textarea className="doc short" value={co.ask} placeholder={d.defaults.ask_email} onChange={(e) => set({ collect: { ...co, ask: e.target.value } })} /></Field>
      <Field label="When they send it"><input value={co.thanks} placeholder={d.defaults.thanks_email} onChange={(e) => set({ collect: { ...co, thanks: e.target.value } })} /></Field>
    </Node>
  );

  return (
    <div className="dm-edit">
      <div className="dm-edit-bar">
        <button className="ghost xs" onClick={back} aria-label="Back to automations"><ArrowLeft size={14} /><span className="dm-hide-s">Automations</span></button>
        <input className="dm-title" aria-label="Automation name" value={a.name} onChange={(e) => set({ name: e.target.value })} />
        <span className={`pill ${a.on ? "ok" : ""}`}>{a.on ? "Live" : "Off"}</span>
        {dirty && <span className="tiny warn-t">Unsaved</span>}
        <div className="row dm-edit-acts">
          {a.id && <PopMenu width={190} trigger={({ toggle, ref, open: o }) => <button ref={ref} className="icon-btn" onClick={toggle} aria-expanded={o} aria-label="More"><DotsThree size={18} weight="bold" /></button>}>
            {(done) => <>
              <button className="pm-item" role="menuitem" onClick={() => { done(); setA({ ...a, id: "", name: `${a.name} (copy)`, on: false, ab: { ...a.ab, winner: null, decided: null } }); setSaved(""); toast("Copy made: save it to keep it", "ok"); }}><Copy size={15} className="ic" />Duplicate</button>
              <button className="pm-item pm-danger" role="menuitem" onClick={async () => { done(); if (await confirm({ title: `Delete "${a.name}"?`, body: "It stops answering. The log keeps what was already sent.", confirm: "Delete", danger: true })) { await api("publish/autodm/delete", { body: { ids: [a.id] } }).catch((e) => toast((e as Error).message, "bad")); reload(); close(); } }}><Trash size={15} className="ic" />Delete</button>
            </>}
          </PopMenu>}
          <button className="ghost sm" disabled={saving || (!dirty && !!a.id)} onClick={() => save()}>Save</button>
          {a.on ? <button className="ghost sm" disabled={saving} onClick={() => save(false)}>Switch off</button>
            : <button className="sm" disabled={saving || todo.length > 0} title={todo[0]} onClick={() => save(true)}>Go live</button>}
        </div>
      </div>
      {todo.length > 0 && <p className="small warn-t dm-todo" role="status">To go live: {todo.join(" · ")}</p>}
      {st && st.sent > 0 && <p className="tiny dim dm-todo">30 days: {st.sent} sent · {rate(st.clicked, st.sent)} opened{st.leads ? ` · ${st.leads} emails` : ""}{st.failed ? ` · ${st.failed} failed` : ""}</p>}

      <div className="dm-edit-cols">
        <div className="dm-flow">
          <Node id="when" open={open} setOpen={setOpen} icon={<Lightning size={14} weight="fill" />} title="When" tone={!words(a) && !a.triggers.mentions ? "warn" : undefined}
            sum={`${trig}${a.triggers.comments ? ` · ${a.where === "all" ? "every post" : `${a.media.length + a.posts.length} post${a.media.length + a.posts.length === 1 ? "" : "s"}`}` : ""}${a.accounts.length && accounts.length > 1 ? ` · ${a.accounts.length} account${a.accounts.length > 1 ? "s" : ""}` : ""}`}>
            <div className="dm-pills" role="group" aria-label="What starts it">
              {([["comments", "Comment"], ["dms", "DM"], ["story_replies", "Story reply"], ["mentions", "Story mention"]] as const).map(([k, l]) => (
                <button key={k} type="button" className={`dm-pill ${a.triggers[k] ? "on" : ""}`} aria-pressed={a.triggers[k]} onClick={() => set({ triggers: { ...a.triggers, [k]: !a.triggers[k] } })}>{a.triggers[k] && <Check size={12} weight="bold" />}{l}</button>
              ))}
            </div>
            {accounts.length > 1 && (
              <Field label="Accounts">
                <div className="dm-pills" role="group">
                  <button type="button" className={`dm-pill ${!a.accounts.length ? "on" : ""}`} onClick={() => set({ accounts: [] })}>All</button>
                  {accounts.map((x) => (
                    <button key={x.id} type="button" className={`dm-pill ${a.accounts.includes(x.id) ? "on" : ""}`} aria-pressed={a.accounts.includes(x.id)}
                      onClick={() => set({ accounts: a.accounts.includes(x.id) ? a.accounts.filter((y) => y !== x.id) : [...a.accounts, x.id] })}>@{x.handle ?? x.name}</button>
                  ))}
                </div>
              </Field>
            )}
            {a.triggers.comments && (
              <>
                <Seg label="Which posts" value={a.where} set={(v) => set({ where: v })} options={[["all", "Every post"], ["some", "Chosen posts"]]} />
                {a.where === "some" && (
                  <div className="dm-targets">
                    {a.media.map((m) => (
                      <span key={m.id} className="dm-target">{m.thumb ? <img src={m.thumb} alt="" /> : <ImageIc size={16} />}<span className="ellipsis">{m.label}</span>
                        <button className="icon-btn" aria-label={`Remove ${m.label}`} onClick={() => set({ media: a.media.filter((x) => x.id !== m.id) })}><X size={12} /></button></span>
                    ))}
                    {a.posts.map((p) => (
                      <span key={p.id} className="dm-target studio"><span className={`pill ${a.resolved[p.id] ? "ok" : ""}`}>{a.resolved[p.id] ? "Live" : "Studio"}</span><span className="ellipsis">{p.label}</span>
                        <button className="icon-btn" aria-label={`Remove ${p.label}`} onClick={() => set({ posts: a.posts.filter((x) => x.id !== p.id) })}><X size={12} /></button></span>
                    ))}
                    <button className="ghost xs" onClick={() => setPicker(true)}><Plus size={13} />Choose posts</button>
                  </div>
                )}
                <Toggle on={a.top_level_only} set={(v) => set({ top_level_only: v })} title="Only comments on the post itself" about="Replies under someone else's comment don't count." />
              </>
            )}
          </Node>

          {words(a) && (
            <Node id="match" open={open} setOpen={setOpen} icon={<MagnifyingGlass size={14} weight="bold" />} title="Match" tone={a.match !== "any" && !a.keywords.length ? "warn" : undefined}
              sum={a.match === "any" ? "Anything" : a.keywords.length ? `${a.keywords.slice(0, 3).join(" / ")}${a.match === "fuzzy" ? " · typos ok" : a.match === "exact" ? " · exactly" : ""}` : "Add a keyword"}>
              <Seg label="Match" value={a.match} set={(v) => set({ match: v })} options={[["fuzzy", "Typos ok"], ["word", "Has it"], ["exact", "Exactly"], ["any", "Anything"]]} />
              <p className="tiny dim" style={{ margin: 0 }}>{a.match === "fuzzy" ? "\"cathc\", \"CATCHHH\" and \"c a t c h\" count too." : a.match === "word" ? "The keyword as a word: \"I want CATCH!\" counts, \"catching\" doesn't." : a.match === "exact" ? "The whole comment is the keyword." : "Every comment or message counts."}</p>
              {a.match !== "any" && <Field label="Keywords" hint="Enter after each; any one counts."><Chips label="Keywords" value={a.keywords} set={(v) => set({ keywords: v })} placeholder="CATCH, LINK, PROMPT" /></Field>}
              <div className="dm-grid">
                {a.match === "fuzzy" && <Field label="Typos"><Select size="sm" label="Typos allowed" value={a.typos} onChange={(v) => set({ typos: v })} options={[[0, "By length"], [1, "Up to 1"], [2, "Up to 2"], [3, "Up to 3"]]} /></Field>}
                <Field label="Ignore if it has"><Chips label="Exclude words" value={a.exclude} set={(v) => set({ exclude: v })} placeholder="stop, spam" /></Field>
              </div>
            </Node>
          )}

          {fg.on && (
            <Node id="follow" open={open} setOpen={setOpen} icon={<UserCheck size={14} />} title="Followers only" sum={`Must follow ${handle} first`} onRemove={() => set({ follow_gate: { ...fg, on: false } })}>
              <Field label="Ask them to follow" hint="{handle} is your @, {username} theirs. Empty uses Settings → Defaults."><textarea className="doc short" value={fg.message} placeholder={d.defaults.gate_message} onChange={(e) => set({ follow_gate: { ...fg, message: e.target.value } })} /></Field>
              <div className="dm-grid">
                <Field label="Button"><input value={fg.button} maxLength={20} placeholder={d.defaults.gate_button} onChange={(e) => set({ follow_gate: { ...fg, button: e.target.value } })} /></Field>
                <Field label="Tapped, not following"><input value={fg.not_following} placeholder={d.defaults.not_following} onChange={(e) => set({ follow_gate: { ...fg, not_following: e.target.value } })} /></Field>
              </div>
            </Node>
          )}

          {co.on && co.when === "before" && emailNode}

          <Node id="dm" open={open} setOpen={setOpen} icon={<PaperPlaneTilt size={14} weight="fill" />} title="The DM" tone={!a.message.trim() ? "warn" : undefined}
            sum={a.message ? <>{a.message.slice(0, 60)}{a.message.length > 60 ? "…" : ""}{[a.button && " · link", a.choices.length && ` · ${a.choices.length} choices`, ab.on && " · A/B"].filter(Boolean).join("")}</> : "Write it"}>
            <Field label={ab.on ? "Version A" : "Message"} hint={`${a.message.length} / ${a.button || a.choices.length ? 640 : 1000} · {username} theirs, {handle} yours`}>
              <textarea className="doc" rows={4} value={a.message} placeholder="Hey {username}! Here's the link you asked for 👇" onChange={(e) => set({ message: e.target.value })} />
            </Field>
            {a.button ? (
              <div className="dm-sub">
                <div className="dm-sub-h"><LinkIc size={14} /><b>Link button</b><button type="button" className="icon-btn" aria-label="Remove the link button" onClick={() => set({ button: null })}><X size={13} /></button></div>
                <div className="dm-grid">
                  <Field label="Text"><input value={a.button.label} maxLength={20} placeholder="Open the link" onChange={(e) => set({ button: { label: e.target.value, url: a.button?.url ?? "" } })} /></Field>
                  <Field label="Link"><input type="url" value={a.button.url} placeholder="https://" onChange={(e) => set({ button: { label: a.button?.label ?? "", url: e.target.value } })} /></Field>
                </div>
                <Toggle on={a.track} set={(v) => set({ track: v })} title="Count opens" about="The button goes through a short link of ours, so you see who opened it. People land on your link either way." />
              </div>
            ) : buttons < 3 && <button className="ghost xs" onClick={() => set({ button: { label: "Open the link", url: "" } })}><Plus size={13} />Link button</button>}

            {a.choices.length > 0 && (
              <div className="dm-sub">
                <div className="dm-sub-h"><GitBranch size={14} /><b>Choices</b><span className="tiny dim">each button answers with its own reply</span></div>
                {a.choices.map((c, i) => (
                  <div key={c.id} className="dm-choice">
                    <div className="row" style={{ gap: 6 }}>
                      <input aria-label={`Choice ${i + 1} button`} value={c.label} maxLength={20} placeholder={i ? "The tutorial" : "The prompt"} onChange={(e) => setChoice(i, { label: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
                      <button type="button" className="icon-btn" aria-label={`Remove choice ${i + 1}`} onClick={() => set({ choices: a.choices.filter((_, j) => j !== i) })}><X size={13} /></button>
                    </div>
                    <textarea className="doc short" aria-label={`Choice ${i + 1} reply`} value={c.reply} placeholder="Their reply when they tap it" onChange={(e) => setChoice(i, { reply: e.target.value })} />
                    {c.button ? (
                      <div className="dm-grid">
                        <input aria-label={`Choice ${i + 1} link text`} value={c.button.label} maxLength={20} placeholder="Open" onChange={(e) => setChoice(i, { button: { label: e.target.value, url: c.button?.url ?? "" } })} />
                        <div className="row" style={{ gap: 6 }}><input type="url" aria-label={`Choice ${i + 1} link`} value={c.button.url} placeholder="https://" onChange={(e) => setChoice(i, { button: { label: c.button?.label ?? "", url: e.target.value } })} style={{ flex: 1, minWidth: 0 }} />
                          <button type="button" className="icon-btn" aria-label="Remove its link" onClick={() => setChoice(i, { button: null })}><X size={13} /></button></div>
                      </div>
                    ) : <button className="ghost xs" onClick={() => setChoice(i, { button: { label: "Open", url: "" } })}><Plus size={13} />Add a link to this reply</button>}
                  </div>
                ))}
                {buttons < 3 && <button className="ghost xs" onClick={() => set({ choices: [...a.choices, { id: rid(), label: "", reply: "", button: null }] })}><Plus size={13} />Another choice</button>}
              </div>
            )}

            {ab.on && (
              <div className="dm-sub">
                <div className="dm-sub-h"><Scales size={14} /><b>Version B</b>{ab.winner ? <span className="pill ok">{ab.winner.toUpperCase()} won</span> : <span className="tiny dim">half get it until one is clearly opened more</span>}
                  <button type="button" className="icon-btn" aria-label="Stop the A/B test" onClick={() => set({ ab: { ...ab, on: false } })}><X size={13} /></button></div>
                <textarea className="doc short" aria-label="Version B" value={ab.message} placeholder="Another way to say it" onChange={(e) => set({ ab: { ...ab, message: e.target.value } })} />
                <div className="dm-grid">
                  {a.button && <Field label="B's button text"><input value={ab.button_label} maxLength={20} placeholder={a.button.label} onChange={(e) => set({ ab: { ...ab, button_label: e.target.value } })} /></Field>}
                  <Field label="Decide after"><Select size="sm" label="Decide after" value={ab.min} onChange={(v) => set({ ab: { ...ab, min: v } })} options={[[20, "20 sends each"], [50, "50 sends each"], [100, "100 sends each"], [250, "250 sends each"]]} /></Field>
                </div>
                {st && (st.a.sent > 0 || st.b.sent > 0) && <p className="tiny dim" style={{ margin: 0 }}>A: {st.a.sent} sent, {rate(st.a.clicked, st.a.sent)} opened · B: {st.b.sent} sent, {rate(st.b.clicked, st.b.sent)} opened</p>}
                {ab.winner && <button className="ghost xs" onClick={() => set({ ab: { ...ab, winner: null, decided: null } })}>Test again</button>}
              </div>
            )}
          </Node>

          {co.on && co.when === "after" && emailNode}

          {a.triggers.comments && (
            <Node id="public" open={open} setOpen={setOpen} icon={<ChatCircle size={14} weight="fill" />} title="Public answer" sum={a.public_replies.length ? `"${a.public_replies[0]}"${a.public_replies.length > 1 ? ` +${a.public_replies.length - 1}` : ""}` : "None"}>
              <Field label="Under the comment" hint="One per line, a different one each time. Empty: no public answer.">
                <textarea className="doc short" value={a.public_replies.join("\n")} placeholder={"Sent! Check your DMs 📩\nJust sent it 🙌"} onChange={(e) => set({ public_replies: e.target.value.split("\n") })}
                  onBlur={() => set({ public_replies: a.public_replies.map((x) => x.trim()).filter(Boolean) })} />
              </Field>
              {d.defaults.public_replies.length > 0 && <button className="ghost xs" onClick={() => set({ public_replies: d.defaults.public_replies })}>Use the defaults</button>}
            </Node>
          )}

          {a.ai.on && (
            <Node id="ai" open={open} setOpen={setOpen} icon={<Brain size={14} />} title="AI follow-ups" sum={d.status.ai_key ? "Claude answers questions after the DM" : "Needs a Claude key (Settings → AI replies)"} tone={d.status.ai_key ? undefined : "warn"} onRemove={() => set({ ai: { ...a.ai, on: false } })}>
              <p className="tiny dim" style={{ margin: 0 }}>When someone who got this DM writes back with a question, Claude answers from the post&apos;s script and caption and these notes. Anything it can&apos;t answer, it hands to you (with a notification).</p>
              <Field label="Notes for the AI" hint="Facts, prices, what to say and not say."><textarea className="doc short" value={a.ai.notes} placeholder="The film is 40 s. The prompt is free. Never promise collabs." onChange={(e) => set({ ai: { ...a.ai, notes: e.target.value } })} /></Field>
              <AiTest a={a} dirty={dirty} />
            </Node>
          )}

          <Node id="limits" open={open} setOpen={setOpen} icon={<Sliders size={14} />} title="Limits" sum={a.once_per_person ? "Once per person" : "Every matching comment"}>
            <Toggle on={a.once_per_person} set={(v) => set({ once_per_person: v })} title="Once per person" about="Someone who comments again doesn't get it twice. Safety limits for every automation are in Settings → Safety." />
          </Node>

          {adds.length > 0 && (
            <div className="dm-add" role="group" aria-label="Add a step">
              <span className="dm-node-dot add" aria-hidden><Plus size={13} weight="bold" /></span>
              <div className="dm-pills">{adds.map((x) => <button key={x.k} type="button" className="dm-pill ghosted" onClick={x.go}>{x.icon}{x.label}</button>)}</div>
            </div>
          )}
        </div>
        <aside className="dm-side">
          <Phone a={a} d={d} />
          <p className="tiny faint dm-side-note"><ShieldCheck size={12} /> Nothing is sent from here. Instagram allows one private reply per comment, within 7 days.</p>
        </aside>
      </div>
      {picker && <Picker accounts={accounts} a={a} set={set} close={() => setPicker(false)} />}
    </div>
  );
}
