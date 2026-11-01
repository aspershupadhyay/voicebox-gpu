"use client";
// One automation, edited in full (/auto-dm?tab=automations&edit=<id>, or edit=new&template=<id>): when it fires (comments,
// DMs, story replies; which accounts; every post or chosen ones), how comments are matched (a keyword as a word, fuzzy for
// typos, exact, any comment; exclude words), the follow gate, the DM and its button, the public answers and limits.
// The right column shows what people will see and tries any comment against this draft (nothing is sent).
import { ArrowLeft, Check, CheckCircle, Copy, DotsThree, Flask, Image as ImageIc, MagnifyingGlass, Plus, Trash, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useDialog } from "../Dialog";
import { Select, useDismiss } from "../pop";
import { Field, PopMenu, Toggle } from "../ui";
import { TEMPLATES } from "./AutoDm";
import { Chips, Seg, handleOf, type Acct, type Automation, type Overview } from "./shared";

type Media = { id: string; caption: string; kind: string; thumb: string | null; url: string | null; at: string | null; comments: number | null };
type Studio = { id: string; title: string; space: string; state: string; account: string | null; media: string | null; url: string | null };

const blank = (): Automation => ({
  id: "", name: "New automation", on: false, created: 0, updated: 0, by: null, accounts: [], where: "all", media: [], posts: [], resolved: {},
  triggers: { comments: true, dms: false, story_replies: false }, match: "fuzzy", keywords: [], exclude: [], typos: 0, top_level_only: false,
  message: "", button: null, public_replies: [], follow_gate: { on: false, message: "", button: "", not_following: "" }, once_per_person: true,
});
const missing = (a: Automation) => {
  const out: string[] = [];
  if (!a.message.trim()) out.push("Write the DM");
  if (a.match !== "any" && !a.keywords.length) out.push("Add a keyword (or answer any comment)");
  if (!a.triggers.comments && !a.triggers.dms && !a.triggers.story_replies) out.push("Pick a trigger");
  if (a.where === "some" && a.triggers.comments && !a.media.length && !a.posts.length) out.push("Choose the posts");
  if (a.button && a.message.length > 640) out.push("With a button the DM is up to 640 characters");
  if (a.button && !a.button.url) out.push("Add the button's link (or remove the button)");
  return out;
};

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
                      <span className="dm-media-kind tiny">{m.kind}{m.comments != null ? ` · ${compactN(m.comments)} 💬` : ""}</span>
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
          <span className="small dim">{a.media.length + a.posts.length} chosen</span>
          <button className="sm" onClick={close}>Done</button>
        </div>
        <p className="tiny faint" style={{ margin: "8px 0 0" }}>A studio post counts once it&apos;s live on Instagram, so you can set this up before it goes out.</p>
      </div>
    </>
  );
}
const compactN = (n: number) => Intl.NumberFormat(undefined, { notation: "compact" }).format(n);

function Preview({ a, d }: { a: Automation; d: Overview }) {
  const acc = d.status.accounts.find((x) => a.accounts.includes(x.id)) ?? d.status.accounts[0];
  const handle = acc?.handle ?? "you";
  const fill = (t: string) => t.replace(/\{handle\}/g, handle).replace(/\{username\}/g, "alex");
  const kw = a.match === "any" ? "This is fire 🔥" : `${a.keywords[0] ?? "KEYWORD"}`;
  const gate = a.follow_gate.on;
  return (
    <div className="dm-phone" aria-label="What people see">
      {a.triggers.comments && (
        <div className="dm-thread">
          <span className="tiny faint">Comment</span>
          <div className="dm-cmt"><b>alex</b> {kw}</div>
          {a.public_replies[0] && <div className="dm-cmt reply"><b>{handle}</b> {fill(a.public_replies[0])}</div>}
        </div>
      )}
      <div className="dm-thread">
        <span className="tiny faint">DM from @{handle}</span>
        {gate && (
          <>
            <div className="dm-bub">{fill(a.follow_gate.message || d.defaults.gate_message)}<span className="dm-btn">{a.follow_gate.button || d.defaults.gate_button}</span></div>
            <div className="dm-bub me">tapped &ldquo;{a.follow_gate.button || d.defaults.gate_button}&rdquo;</div>
            <span className="tiny faint">If they follow:</span>
          </>
        )}
        <div className="dm-bub">{a.message ? fill(a.message) : <span className="faint">Your DM shows here</span>}{a.button && <span className="dm-btn">{a.button.label || "Open"}</span>}</div>
        {gate && <><span className="tiny faint">If not yet:</span><div className="dm-bub">{fill(a.follow_gate.not_following || d.defaults.not_following)}<span className="dm-btn">{a.follow_gate.button || d.defaults.gate_button}</span></div></>}
      </div>
    </div>
  );
}

function Tester({ a }: { a: Automation }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"comment" | "dm" | "story">("comment");
  const [res, setRes] = useState<{ keyword: string | null; note: string } | null>(null);
  const run = () => text.trim() && api<{ keyword: string | null; note: string }>("publish/autodm/test", { body: { text, kind, automation: a, media: a.where === "some" ? a.media[0]?.id ?? Object.values(a.resolved)[0] ?? null : null } })
    .then(setRes).catch((e) => setRes({ keyword: null, note: (e as Error).message }));
  useEffect(() => setRes(null), [a.match, a.keywords, a.exclude, a.typos]);
  return (
    <section className="card">
      <h2 className="row" style={{ gap: 7 }}><Flask size={17} />Try it</h2>
      <p className="small dim" style={{ marginTop: 4 }}>Type a comment the way people write it. Nothing is sent.</p>
      <div style={{ marginTop: 10 }}><Seg label="Kind" value={kind} set={setKind} options={[["comment", "Comment"], ["dm", "DM"], ["story", "Story reply"]]} /></div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <input aria-label="Text to try" placeholder="e.g. cathc pls!!" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} style={{ flex: 1, minWidth: 0 }} />
        <button className="sm" onClick={run} disabled={!text.trim()}>Try</button>
      </div>
      {res && <p className={`small ${res.keyword ? "ok-t" : "dim"}`} role="status" style={{ margin: "8px 0 0" }}>{res.keyword ? <><CheckCircle size={14} weight="fill" /> Fires{res.keyword !== "*" ? ` (matched “${res.keyword}”)` : ""}</> : res.note === "No automation answers that." ? "Doesn't fire." : res.note}</p>}
    </section>
  );
}

export default function Editor({ id, template, d, reload, close, opened }: { id: string; template: string | null; d: Overview; reload: () => void; close: () => void; opened: (id: string) => void }) {
  const { toast, confirm } = useDialog();
  const found = d.settings.automations.find((x) => x.id === id);
  const start = useMemo<Automation>(() => {
    if (found) return found;
    const t = TEMPLATES.find((x) => x.id === template) ?? TEMPLATES[TEMPLATES.length - 1];
    const made = t.make(d.defaults);
    return { ...blank(), ...made, triggers: { ...blank().triggers, ...made.triggers }, follow_gate: { ...blank().follow_gate, ...made.follow_gate } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [a, setA] = useState<Automation>(start);
  const [saved, setSaved] = useState<string>(found ? JSON.stringify(found) : "");
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<Automation>) => setA((x) => ({ ...x, ...p }));
  const dirty = JSON.stringify(a) !== saved;
  const todo = missing(a);
  const accounts = d.status.accounts;

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
  const fg = a.follow_gate;
  const handle = handleOf(accounts.find((x) => a.accounts.includes(x.id)) ?? accounts[0]) || "@you";

  return (
    <div className="dm-edit">
      <div className="dm-edit-bar">
        <button className="ghost xs" onClick={back}><ArrowLeft size={14} />Automations</button>
        <input className="dm-title" aria-label="Automation name" value={a.name} onChange={(e) => set({ name: e.target.value })} />
        <span className={`pill ${a.on ? "ok" : ""}`}>{a.on ? "Live" : "Off"}</span>
        {dirty && <span className="tiny warn-t">Unsaved</span>}
        <div className="row" style={{ gap: 6, marginLeft: "auto" }}>
          {a.id && <PopMenu width={190} trigger={({ toggle, ref, open }) => <button ref={ref} className="icon-btn" onClick={toggle} aria-expanded={open} aria-label="More"><DotsThree size={18} weight="bold" /></button>}>
            {(done) => <>
              <button className="pm-item" role="menuitem" onClick={() => { done(); setA({ ...a, id: "", name: `${a.name} (copy)`, on: false }); setSaved(""); toast("Copy made: save it to keep it", "ok"); }}><Copy size={15} className="ic" />Duplicate</button>
              <button className="pm-item pm-danger" role="menuitem" onClick={async () => { done(); if (await confirm({ title: `Delete "${a.name}"?`, body: "It stops answering. Activity keeps what was already sent.", confirm: "Delete", danger: true })) { await api("publish/autodm/delete", { body: { ids: [a.id] } }).catch((e) => toast((e as Error).message, "bad")); reload(); close(); } }}><Trash size={15} className="ic" />Delete</button>
            </>}
          </PopMenu>}
          <button className="ghost sm" disabled={saving || (!dirty && !!a.id)} onClick={() => save()}>Save</button>
          {a.on ? <button className="ghost sm" disabled={saving} onClick={() => save(false)}>Switch off</button>
            : <button className="sm" disabled={saving || todo.length > 0} title={todo[0]} onClick={() => save(true)}>Save and go live</button>}
        </div>
      </div>
      {todo.length > 0 && <p className="small warn-t" role="status" style={{ margin: "0 0 12px" }}>Before it can go live: {todo.join(" · ")}.</p>}

      <div className="ap-cols">
        <div className="ap-main">
          <section className="card">
            <h2>When</h2>
            <p className="small dim" style={{ marginTop: 4 }}>What starts it.</p>
            <div className="dm-checks" role="group" aria-label="Triggers">
              {([["comments", "A comment on a post or reel"], ["dms", "A DM"], ["story_replies", "A reply to a story"]] as const).map(([k, l]) => (
                <button key={k} type="button" className={`dm-check-row ${a.triggers[k] ? "on" : ""}`} aria-pressed={a.triggers[k]} onClick={() => set({ triggers: { ...a.triggers, [k]: !a.triggers[k] } })}>
                  <span className={`dm-check ${a.triggers[k] ? "on" : ""}`} aria-hidden>{a.triggers[k] && <Check size={12} weight="bold" />}</span>{l}
                </button>
              ))}
            </div>
            {accounts.length > 1 && (
              <Field label="On which accounts" style={{ marginTop: 14 }}>
                <div className="acct-row" role="group">
                  <button type="button" className={`acct-chip ${!a.accounts.length ? "on" : ""}`} onClick={() => set({ accounts: [] })}>All accounts</button>
                  {accounts.map((x) => (
                    <button key={x.id} type="button" className={`acct-chip ${a.accounts.includes(x.id) ? "on" : ""}`} aria-pressed={a.accounts.includes(x.id)}
                      onClick={() => set({ accounts: a.accounts.includes(x.id) ? a.accounts.filter((y) => y !== x.id) : [...a.accounts, x.id] })}>
                      <span className="pv-av">{x.avatar ? <img src={x.avatar} alt="" /> : (x.handle ?? x.name).slice(0, 1)}</span>@{x.handle ?? x.name}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {a.triggers.comments && (
              <>
                <div style={{ marginTop: 14 }}><Seg label="Which posts" value={a.where} set={(v) => set({ where: v })} options={[["all", "Every post and reel"], ["some", "Chosen posts"]]} /></div>
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
                <p className="tiny faint" style={{ margin: "8px 0 0" }}>An automation for chosen posts wins over an every-post one on those posts.</p>
                <Toggle on={a.top_level_only} set={(v) => set({ top_level_only: v })} title="Only comments on the post itself" about="Replies under someone else's comment don't count." />
              </>
            )}
          </section>

          <section className="card">
            <h2>Matching</h2>
            <p className="small dim" style={{ marginTop: 4 }}>Which comments and messages count.</p>
            <div style={{ marginTop: 12 }}><Seg label="Match" value={a.match} set={(v) => set({ match: v })} options={[["fuzzy", "Keyword, typos ok"], ["word", "Has the keyword"], ["exact", "Just the keyword"], ["any", "Anything"]]} /></div>
            <p className="tiny dim" style={{ margin: "6px 0 0" }}>{a.match === "fuzzy" ? "\"cathc\", \"CATCHHH\" and \"c a t c h\" count too. Capitals and emoji never matter." : a.match === "word" ? "The keyword anywhere, as a word: \"I want it CATCH!\" counts, \"catching\" doesn't." : a.match === "exact" ? "The whole comment is the keyword (punctuation and emoji aside)." : "Every comment or message counts, whatever it says."}</p>
            {a.match !== "any" && (
              <Field label="Keywords" hint="Press Enter after each. Any one of them counts." style={{ marginTop: 12 }}>
                <Chips label="Keywords" value={a.keywords} set={(v) => set({ keywords: v })} placeholder="CATCH, LINK, PROMPT" />
              </Field>
            )}
            {a.match === "fuzzy" && (
              <Field label="Typos allowed" style={{ marginTop: 12 }}>
                <Select size="sm" label="Typos allowed" value={a.typos} onChange={(v) => set({ typos: v })} options={[[0, "By length (1 for short words, 2 for long)"], [1, "Up to 1"], [2, "Up to 2"], [3, "Up to 3"]]} />
              </Field>
            )}
            <Field label="Ignore comments with" hint="e.g. stop, unsubscribe, spam" style={{ marginTop: 12 }}>
              <Chips label="Exclude words" value={a.exclude} set={(v) => set({ exclude: v })} placeholder="Optional" />
            </Field>
          </section>

          <section className="card">
            <h2>Followers only</h2>
            <Toggle on={fg.on} set={(v) => set({ follow_gate: { ...fg, on: v } })} title={`Only send it to people who follow ${handle}`}
              about="Non-followers first get a message asking them to follow, with a button. When they tap it, Voicebox checks and sends the DM if they follow." />
            {fg.on && (
              <div className="dm-stack">
                <Field label="Ask them to follow" hint="{handle} is your @, {username} theirs.">
                  <textarea className="doc short" value={fg.message} placeholder={d.defaults.gate_message} onChange={(e) => set({ follow_gate: { ...fg, message: e.target.value } })} />
                </Field>
                <Field label="Button"><input value={fg.button} maxLength={20} placeholder={d.defaults.gate_button} onChange={(e) => set({ follow_gate: { ...fg, button: e.target.value } })} /></Field>
                <Field label="If they tap but don't follow yet">
                  <textarea className="doc short" value={fg.not_following} placeholder={d.defaults.not_following} onChange={(e) => set({ follow_gate: { ...fg, not_following: e.target.value } })} />
                </Field>
                <p className="tiny faint" style={{ margin: 0 }}>Empty fields use the defaults from Settings.</p>
              </div>
            )}
          </section>

          <section className="card">
            <h2>The DM</h2>
            <Field label="Message" hint={`${a.message.length} / ${a.button ? 640 : 1000} · {username} is their name, {handle} yours`} style={{ marginTop: 10 }}>
              <textarea className="doc" rows={5} value={a.message} placeholder="Hey {username}! Here's the link you asked for 👇" onChange={(e) => set({ message: e.target.value })} />
            </Field>
            {a.button ? (
              <div className="dm-grid" style={{ marginTop: 12 }}>
                <Field label="Button text"><input value={a.button.label} maxLength={20} placeholder="Open the link" onChange={(e) => set({ button: { label: e.target.value, url: a.button?.url ?? "" } })} /></Field>
                <Field label="Button link"><input type="url" value={a.button.url} placeholder="https://" onChange={(e) => set({ button: { label: a.button?.label ?? "", url: e.target.value } })} /></Field>
                <button className="ghost xs" style={{ alignSelf: "end", justifySelf: "start" }} onClick={() => set({ button: null })}><X size={13} />Remove button</button>
              </div>
            ) : <button className="ghost xs" style={{ marginTop: 10 }} onClick={() => set({ button: { label: "Open the link", url: "" } })}><Plus size={13} />Add a link button</button>}
          </section>

          {a.triggers.comments && (
            <section className="card">
              <div className="row between"><h2>Public answer</h2>
                {d.defaults.public_replies.length > 0 && <button className="ghost xs" onClick={() => set({ public_replies: d.defaults.public_replies })}>Use the defaults</button>}</div>
              <Field label="Answers under the comment" hint="One per line; a different one each time, so it doesn't look like a bot. Empty: no public answer." style={{ marginTop: 10 }}>
                <textarea className="doc short" value={a.public_replies.join("\n")} placeholder={"Sent! Check your DMs 📩\nJust sent it 🙌"} onChange={(e) => set({ public_replies: e.target.value.split("\n") })}
                  onBlur={() => set({ public_replies: a.public_replies.map((x) => x.trim()).filter(Boolean) })} />
              </Field>
            </section>
          )}

          <section className="card">
            <h2>Limits</h2>
            <Toggle on={a.once_per_person} set={(v) => set({ once_per_person: v })} title="Once per person" about="Someone who comments again doesn't get the DM twice. Off: every matching comment gets it (Instagram still allows one private reply per comment)." />
          </section>
        </div>
        <aside className="ap-side dm-side">
          <section className="card"><h2>What they see</h2><Preview a={a} d={d} /></section>
          <Tester a={a} />
        </aside>
      </div>
      {picker && <Picker accounts={accounts} a={a} set={set} close={() => setPicker(false)} />}
    </div>
  );
}
