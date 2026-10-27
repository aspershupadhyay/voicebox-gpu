"use client";
// Posts → Autopilot: the accounts Voicebox posts to, everything going out (now, next, needing you, recently live) and the
// rules that run by themselves: the master switch, retries, cross-posting, posting slots, caption footers and defaults.
import {
  ArrowSquareOut, ArrowsClockwise, CheckCircle, Clock, Copy, Lightning, LinkBreak, Plus, RocketLaunch, Warning, X,
} from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Account } from "@/lib/publish/accounts";
import { BUSY, DEFAULT_RULES, PLAN_LABEL, PUBLISHABLE, YT_CATEGORIES, LANGUAGES, type Network, type Plan, type Rules } from "@/lib/publish/shared";
import { SPACES, spaceName, type SpaceId } from "@/lib/spaces";
import type { Post } from "@/lib/workspace";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { NET, PlatformBadge } from "./platform";
import { Select } from "./pop";
import { whenLabel } from "./Publish";
import { Notice, Toggle } from "./ui";
import { noteRules, refreshPublish, usePublish } from "./usePublish";
import { useTargets } from "./useTargets";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NAMES: Record<Network, string> = { youtube: "YouTube", instagram: "Instagram" };
const rid = () => Math.random().toString(36).slice(2, 10);
const inHuman = (t: number) => {
  const m = Math.round((t - Date.now()) / 6e4);
  if (m < -1) return "overdue";
  if (m < 60) return `in ${Math.max(1, m)} min`;
  if (m < 60 * 36) return `in ${Math.round(m / 60)} h`;
  return `in ${Math.round(m / 1440)} days`;
};

function Setup({ n }: { n: Network }) {
  const { toast } = useDialog();
  const uri = typeof location === "undefined" ? "" : `${location.origin}/api/publish/${n}/callback`;
  return (
    <div className="setup small">
      <p className="dim" style={{ margin: 0 }}>{n === "youtube"
        ? <>Make a Google Cloud OAuth client (Web), turn on the YouTube Data API v3, publish the consent screen (so the key doesn&apos;t expire in 7 days), then add <code>YOUTUBE_CLIENT_ID</code> and <code>YOUTUBE_CLIENT_SECRET</code> on Vercel.</>
        : <>Make a Meta app with the Instagram product (Instagram Login), add your account as a tester, then add <code>INSTAGRAM_APP_ID</code> and <code>INSTAGRAM_APP_SECRET</code> on Vercel. The account must be Creator or Business.</>}</p>
      <div className="row" style={{ gap: 6, marginTop: 8 }}><span className="tiny dim">Redirect URI</span><code className="ellipsis" style={{ flex: 1 }}>{uri}</code>
        <button className="ghost xs" onClick={() => navigator.clipboard.writeText(uri).then(() => toast("Copied", "ok"))}><Copy size={12} />Copy</button></div>
      <p className="tiny faint" style={{ margin: "8px 0 0" }}>Step by step: docs/PUBLISHING.md in the repo.</p>
    </div>
  );
}

function AccountRow({ a }: { a: Account }) {
  const { confirm, toast } = useDialog();
  const days = a.expires_at ? Math.round((a.expires_at - Date.now()) / 864e5) : null;
  return (
    <div className="acct">
      <span className="pv-av">{a.avatar ? <img src={a.avatar} alt="" /> : a.name.slice(0, 1)}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b className="ellipsis" style={{ display: "block" }}>{a.name}</b>
        <span className="tiny dim">{[a.network === "instagram" && a.handle ? `@${a.handle}` : a.handle, a.subscribers != null ? `${Intl.NumberFormat(undefined, { notation: "compact" }).format(a.subscribers)} ${a.network === "youtube" ? "subscribers" : "followers"}` : null, `connected by ${a.by.split(" ")[0]}`].filter(Boolean).join(" · ")}</span>
        {a.error ? <span className="tiny bad-t" style={{ display: "block" }}><Warning size={12} /> {a.error}</span> : days !== null && <span className="tiny faint" style={{ display: "block" }}>Key renews automatically ({days} days left)</span>}
      </div>
      {a.error && <a className="btn ghost xs" href={`/api/publish/${a.network}/connect`}><ArrowsClockwise size={13} />Reconnect</a>}
      <button className="icon-btn danger-h" aria-label={`Disconnect ${a.name}`} title="Disconnect"
        onClick={async () => { if (await confirm({ title: `Disconnect ${a.name}?`, body: "Posts set to go out on it will wait for another account. Nothing on the platform changes.", confirm: "Disconnect", danger: true })) { await api(`publish/accounts/${a.id}`, { method: "DELETE" }).catch((e) => toast((e as Error).message, "bad")); refreshPublish(); } }}>
        <LinkBreak size={16} /></button>
    </div>
  );
}

type Row = { p: Plan; post: Post | undefined; due: string | null };

function QueueRow({ r, onCompose, onOpen }: { r: Row; onCompose: () => void; onOpen: () => void }) {
  const { p } = r;
  const busy = BUSY.includes(p.state);
  return (
    <div className="q-row">
      <PlatformBadge space={p.space} size={26} solid={p.state === "published"} />
      <button className="q-main" onClick={onOpen}>
        <b className="ellipsis">{r.post?.title ?? "Deleted post"}</b>
        <span className="tiny dim ellipsis">{spaceName(p.space)} · {busy ? p.step : p.state === "failed" ? p.error : p.state === "published" ? (p.result?.private_only ? "Uploaded as private (needs the YouTube audit)" : p.step ?? "Live") : p.state === "armed" ? (r.due ? whenLabel(r.due) : "Needs a publish time") : PLAN_LABEL[p.state]}</span>
        {busy && <span className="pub-bar" style={{ marginTop: 6 }}><i style={{ width: `${Math.max(4, p.progress * 100)}%` }} /></span>}
      </button>
      <span className="q-when tiny mono dim">{p.state === "armed" && r.due ? inHuman(Date.parse(r.due)) : p.state === "published" && p.result ? new Date(p.result.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : p.state === "failed" && p.next_try ? `retry ${inHuman(p.next_try)}` : ""}</span>
      {p.state === "published" && p.result ? <a className="btn ghost xs" href={p.result.url} target="_blank" rel="noreferrer">Open <ArrowSquareOut size={12} /></a>
        : <button className="ghost xs" onClick={onCompose} disabled={!r.post}>{p.state === "failed" ? "Fix" : "Open"}</button>}
    </div>
  );
}

function RulesEditor({ rules }: { rules: Rules }) {
  const { toast } = useDialog();
  const [r, setR] = useState(rules);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setR(rules), [rules]);
  const save = (next: Rules, now = false) => {
    setR(next);
    clearTimeout(t.current);
    const go = () => api<{ rules: Rules }>("publish/rules", { body: { rules: { ...next, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } } }).then((x) => noteRules(x.rules)).catch((e) => toast((e as Error).message, "bad"));
    if (now) go(); else t.current = setTimeout(go, 700);
  };
  const set = (p: Partial<Rules>, now = true) => save({ ...r, ...p }, now);
  const spaceOpts = SPACES.map((s) => [s.id, `${s.networkLabel} ${s.label}`] as const);
  const pubOpts = SPACES.filter((s) => PUBLISHABLE[s.id]).map((s) => [s.id, `${s.networkLabel} ${s.label}`] as const);
  const [footerSpace, setFooterSpace] = useState<SpaceId>("yt_video");
  const slotsBy = useMemo(() => [...r.slots].sort((a, b) => a.space.localeCompare(b.space) || a.day - b.day || a.time.localeCompare(b.time)), [r.slots]);
  return (
    <div className="rules">
      <section className="card">
        <h2>Autopilot</h2>
        <Toggle on={r.autopilot} set={(v) => set({ autopilot: v })} title="Post scheduled things by themselves" about="Off pauses every automatic post and retry. Publish now still works." />
        <Toggle on={r.mark_posted} set={(v) => set({ mark_posted: v })} title="Move posts to Posted with their live link" />
        <Toggle on={r.notify} set={(v) => set({ notify: v })} title="Push to my phone when something goes live or fails" about="Uses the ntfy topic from GPU & engines → Machine." />
        <div className="toggle-row"><div><div className="tr-t">Try again after a failure</div><div className="tr-d">5 min, 20 min, 1 h, 3 h… Quota and rate limits always wait it out.</div></div>
          <Select size="sm" label="Retries" value={r.retries} onChange={(v) => set({ retries: v })} options={[0, 1, 2, 3, 5, 8].map((n) => [n, n ? `${n} time${n > 1 ? "s" : ""}` : "Never"] as const)} /></div>
      </section>

      <section className="card">
        <div className="row between"><h2>Cross-post</h2><button className="ghost xs" onClick={() => set({ crosspost: [...r.crosspost, { id: rid(), from: "yt_short", to: "ig_reel", hours: 2, on: true }] })}><Plus size={13} />Rule</button></div>
        <p className="small dim" style={{ marginTop: 4 }}>When something goes live on one, it&apos;s queued for the other with the same file and caption.</p>
        {r.crosspost.length ? r.crosspost.map((c, i) => (
          <div key={c.id} className="rule-row">
            <span className="small dim">When live on</span>
            <Select size="sm" label="From" value={c.from} onChange={(v) => set({ crosspost: r.crosspost.map((x, k) => (k === i ? { ...x, from: v } : x)) })} options={pubOpts} />
            <span className="small dim">post to</span>
            <Select size="sm" label="To" value={c.to} onChange={(v) => set({ crosspost: r.crosspost.map((x, k) => (k === i ? { ...x, to: v } : x)) })} options={spaceOpts.filter(([id]) => id !== c.from)} />
            <Select size="sm" label="Delay" value={c.hours} onChange={(v) => set({ crosspost: r.crosspost.map((x, k) => (k === i ? { ...x, hours: v } : x)) })} options={[0, 1, 2, 4, 6, 12, 24, 48, 72].map((h) => [h, h ? `${h} h later` : "right away"] as const)} />
            <button type="button" role="switch" aria-checked={c.on} aria-label="Rule on" className={`switch ${c.on ? "on" : ""}`} onClick={() => set({ crosspost: r.crosspost.map((x, k) => (k === i ? { ...x, on: !x.on } : x)) })} />
            <button className="icon-btn danger-h" aria-label="Remove rule" onClick={() => set({ crosspost: r.crosspost.filter((_, k) => k !== i) })}><X size={14} /></button>
          </div>
        )) : <p className="tiny faint" style={{ margin: "10px 0 0" }}>No rules yet. A common one: YouTube Shorts → Instagram Reels, 2 h later.</p>}
      </section>

      <section className="card">
        <div className="row between"><h2>Posting slots</h2><button className="ghost xs" onClick={() => set({ slots: [...r.slots, { id: rid(), space: "yt_short", day: 2, time: "18:00" }] })}><Plus size={13} />Slot</button></div>
        <p className="small dim" style={{ marginTop: 4 }}>A post you move to Scheduled without a time takes the next free slot of its format. Times are in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
        {slotsBy.map((s) => (
          <div key={s.id} className="rule-row">
            <Select size="sm" label="Format" value={s.space} onChange={(v) => set({ slots: r.slots.map((x) => (x.id === s.id ? { ...x, space: v } : x)) })} options={spaceOpts} />
            <Select size="sm" label="Day" value={s.day} onChange={(v) => set({ slots: r.slots.map((x) => (x.id === s.id ? { ...x, day: v } : x)) })} options={DAYS.map((d, i) => [i, d] as const)} />
            <input type="time" aria-label="Time" value={s.time} style={{ width: 120 }} onChange={(e) => e.target.value && set({ slots: r.slots.map((x) => (x.id === s.id ? { ...x, time: e.target.value } : x)) }, false)} />
            <button className="icon-btn danger-h" aria-label="Remove slot" onClick={() => set({ slots: r.slots.filter((x) => x.id !== s.id) })}><X size={14} /></button>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Captions</h2>
        <div className="row" style={{ gap: 8, marginTop: 10 }}><span className="small dim">Footer for</span><Select size="sm" label="Footer format" value={footerSpace} onChange={setFooterSpace} options={pubOpts} /></div>
        <textarea className="doc short" style={{ marginTop: 8 }} aria-label={`Footer for ${spaceName(footerSpace)}`} value={r.footer[footerSpace] ?? ""} placeholder="Added to every new caption or description here: links, socials, a sign-off"
          onChange={(e) => save({ ...r, footer: { ...r.footer, [footerSpace]: e.target.value } })} />
        <h3 style={{ marginTop: 14 }}>Instagram first comment</h3>
        <textarea className="doc short" style={{ marginTop: 8 }} aria-label="Default first comment" value={r.first_comment} placeholder="e.g. your hashtag set, posted as the first comment on new plans"
          onChange={(e) => save({ ...r, first_comment: e.target.value })} />
      </section>

      <section className="card">
        <h2>YouTube defaults</h2>
        <div className="pub-grid" style={{ marginTop: 12 }}>
          <label><span className="lbl">Visibility</span><Select size="sm" label="Default visibility" value={r.yt_defaults.privacy} onChange={(v) => set({ yt_defaults: { ...r.yt_defaults, privacy: v } })} options={[["public", "Public"], ["unlisted", "Unlisted"], ["private", "Private"]]} /></label>
          <label><span className="lbl">Category</span><Select size="sm" label="Default category" value={r.yt_defaults.category} onChange={(v) => set({ yt_defaults: { ...r.yt_defaults, category: v } })} options={YT_CATEGORIES} /></label>
          <label><span className="lbl">Language</span><Select size="sm" label="Default language" value={r.yt_defaults.language ?? ""} onChange={(v) => set({ yt_defaults: { ...r.yt_defaults, language: v || null } })} options={LANGUAGES} /></label>
        </div>
        <Toggle on={r.yt_defaults.synthetic} set={(v) => set({ yt_defaults: { ...r.yt_defaults, synthetic: v } })} title="Altered or synthetic content" about="On by default if most of your videos use the cloned voice." />
        <Toggle on={r.yt_defaults.made_for_kids} set={(v) => set({ yt_defaults: { ...r.yt_defaults, made_for_kids: v } })} title="Made for kids" />
        <Toggle on={r.yt_defaults.youtube_schedules} set={(v) => set({ yt_defaults: { ...r.yt_defaults, youtube_schedules: v } })} title="Let YouTube publish on the minute" about="Upload early as private; YouTube flips it public at the time." />
      </section>
    </div>
  );
}

export function Autopilot({ posts, onCompose, onOpen }: { posts: Post[]; onCompose: (post: Post, space: SpaceId) => void; onOpen: (post: Post) => void }) {
  const s = usePublish();
  const { map } = useTargets();
  const params = useSearchParams();
  const router = useRouter();
  const { toast } = useDialog();
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const ok = params.get("connected"), bad = params.get("error");
    if (ok) toast(`Connected ${ok}`, "ok");
    if (bad) toast(bad, "bad");
    if (ok || bad) { refreshPublish(); router.replace("/posts?view=autopilot", { scroll: false }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const byId = useMemo(() => new Map(posts.map((p) => [p.$id, p])), [posts]);
  const rows: Row[] = s.plans.map((p) => ({ p, post: byId.get(p.post), due: (map[p.post] ?? []).find((t) => t.space === p.space)?.due_at ?? null }));
  const now = rows.filter((r) => BUSY.includes(r.p.state));
  const next = rows.filter((r) => r.p.state === "armed" && r.due).sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
  const attention = rows.filter((r) => r.p.state === "failed" || (r.p.state === "armed" && !r.due) || (r.p.state === "published" && r.p.result?.private_only) || (r.p.state === "draft" && r.due && Date.parse(r.due) < Date.now() + 864e5));
  const live = rows.filter((r) => r.p.state === "published" && !r.p.result?.private_only).sort((a, b) => (b.p.result?.at ?? 0) - (a.p.result?.at ?? 0)).slice(0, 12);
  const unplanned = posts.flatMap((p) => (map[p.$id] ?? []).filter((t) => PUBLISHABLE[t.space] && t.status === "scheduled" && !s.plans.some((x) => x.post === p.$id && x.space === t.space)).map((t) => ({ p, t })));
  const rules = s.rules ?? DEFAULT_RULES;
  const group = (title: string, list: Row[], icon: React.ReactNode, empty?: string) => (
    <section className="q-group">
      <h2>{icon}{title}<span className="pill">{list.length}</span></h2>
      {list.length ? <div className="q-list">{list.map((r) => <QueueRow key={`${r.p.post}/${r.p.space}`} r={r} onCompose={() => r.post && onCompose(r.post, r.p.space)} onOpen={() => r.post && onOpen(r.post)} />)}</div>
        : empty && <p className="tiny faint" style={{ margin: "4px 0 0" }}>{empty}</p>}
    </section>
  );

  return (
    <div className="autopilot">
      {!rules.autopilot && <Notice icon={<Warning size={18} />} tone="warn" action={<button className="sm" onClick={() => api<{ rules: Rules }>("publish/rules", { body: { rules: { autopilot: true } } }).then((x) => noteRules(x.rules))}>Turn on</button>}>Autopilot is paused: nothing goes out by itself.</Notice>}
      <div className="ap-cols">
        <div className="ap-main">
          <section className="card">
            <div className="row between"><h2>Accounts</h2>
              <button className="ghost xs" disabled={running} onClick={async () => { setRunning(true); await api("publish/sweep", { body: {} }).then(() => toast("Autopilot ran", "ok")).catch((e) => toast((e as Error).message, "bad")); setRunning(false); refreshPublish(); }}>
                <ArrowsClockwise size={13} className={running ? "spin" : ""} />Run now</button></div>
            <div className="acct-cols">
              {(["youtube", "instagram"] as Network[]).map((n) => {
                const Ic = NET[n].Icon;
                const list = s.accounts.filter((a) => a.network === n);
                return (
                  <div key={n} className="acct-col">
                    <div className="row between"><h3 className="row" style={{ gap: 7 }}><Ic size={18} />{NAMES[n]}</h3>
                      {s.configured[n] && <a className="btn ghost xs" href={`/api/publish/${n}/connect`}><Plus size={13} />{list.length ? "Add" : "Connect"}</a>}</div>
                    {!s.configured[n] ? <Setup n={n} /> : list.length ? list.map((a) => <AccountRow key={a.id} a={a} />) : <p className="tiny faint" style={{ margin: "8px 0 0" }}>Not connected yet.</p>}
                  </div>
                );
              })}
            </div>
          </section>
          {group("Going out now", now, <RocketLaunch size={16} />)}
          {group("Needs you", attention, <Warning size={16} />)}
          {group("Up next", next, <Clock size={16} />, "Nothing set to go. Open a post, press Publish on a target, then Set to go.")}
          {!!unplanned.length && (
            <section className="q-group">
              <h2><Lightning size={16} />Scheduled, not set up to post<span className="pill">{unplanned.length}</span></h2>
              <div className="q-list">{unplanned.slice(0, 20).map(({ p, t }) => (
                <div key={`${p.$id}/${t.space}`} className="q-row">
                  <PlatformBadge space={t.space} size={26} />
                  <button className="q-main" onClick={() => onOpen(p)}><b className="ellipsis">{p.title}</b><span className="tiny dim">{spaceName(t.space)}{t.due_at ? ` · ${whenLabel(t.due_at)}` : ""}</span></button>
                  <button className="ghost xs" onClick={() => onCompose(p, t.space)}><RocketLaunch size={13} />Set up</button>
                </div>
              ))}</div>
            </section>
          )}
          {group("Recently live", live, <CheckCircle size={16} />)}
        </div>
        <aside className="ap-side"><RulesEditor rules={rules} /></aside>
      </div>
      {s.error && <p className="err">{s.error}</p>}
    </div>
  );
}
