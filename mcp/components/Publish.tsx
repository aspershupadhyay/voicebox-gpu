"use client";
// Publishing from a post: the composer (every option YouTube and Instagram take, with a live preview of how it'll look),
// the pill on each target that says where it stands, and the hand-off for places Voicebox can't post to itself.
// The server does the work (lib/publish/*): Publish now starts at once; "At the publish time" lets the autopilot do it.
import {
  ArrowSquareOut, ArrowsClockwise, BookmarkSimple, ChatCircle, CheckCircle, Clock, Copy, DownloadSimple, Heart, Image as ImageIcon, Lightning, PaperPlaneTilt,
  Play, Plus, RocketLaunch, ShareFat, Stop, Warning, X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Account } from "@/lib/publish/accounts";
import { BUSY, hashtags, LANGUAGES, LIMITS, networkOf, PLAN_LABEL, YT_CATEGORIES, type IgOptions, type Plan, type YtOptions } from "@/lib/publish/shared";
import { spaceName, spaceOf, targetsOf, type SpaceId } from "@/lib/spaces";
import { fileUrl, type Media, type Post } from "@/lib/workspace";
import { api } from "./api";
import { Query, useLive } from "./aw";
import { useDialog } from "./Dialog";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { Toggle } from "./ui";
import { notePlan, planFor, refreshPublish, usePublish } from "./usePublish";
import { saveTargets, useTargets } from "./useTargets";

const toLocal = (iso?: string | null) => { if (!iso) return ""; const x = new Date(iso); return new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };
export const whenLabel = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const UPLOAD_PAGE: Record<string, string> = {
  x_post: "https://x.com/compose/post", x_thread: "https://x.com/compose/post", tt_video: "https://www.tiktok.com/tiktokstudio/upload",
  li_post: "https://www.linkedin.com/feed/?shareActive=true", yt_post: "https://studio.youtube.com", pod_episode: "https://podcasters.spotify.com",
};

/** A file the post can send: an upload (m:) or a video Voicebox made (j:). */
type Pick = { ref: string; kind: "image" | "video" | "other"; name: string; thumb: string | null; src: string | null; w?: number; h?: number };

function usePicks(post: Post) {
  const { rows: media } = useLive<Media>("media", [Query.equal("post_id", post.$id), Query.orderDesc("$createdAt"), Query.limit(100)], (m) => m.post_id === post.$id, [post.$id]);
  const [jobs, setJobs] = useState<Pick[]>([]);
  const ids = (post.jobs ?? []).join(",");
  useEffect(() => {
    let live = true;
    Promise.all((post.jobs ?? []).map((id) => api<{ id: string; kind?: string; label?: string; video_url?: string; poster_url?: string | null; video?: { width: number; height: number } }>(`library/${id}`).catch(() => null)))
      .then((all) => live && setJobs(all.filter((j) => j?.kind === "video" && j.video_url).map((j) => ({ ref: `j:${j!.id}`, kind: "video" as const, name: j!.label || "Generated video", thumb: j!.poster_url ?? null, src: j!.video_url!, w: j!.video?.width, h: j!.video?.height }))));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const ups: Pick[] = media.filter((m) => m.token).map((m) => ({
    ref: `m:${m.$id}`, kind: m.kind === "image" || m.kind === "video" ? m.kind : "other", name: m.name,
    thumb: m.kind === "image" ? fileUrl(m, "preview", 480) : null, src: m.kind === "video" || m.kind === "image" ? fileUrl(m) : null,
  }));
  return [...ups, ...jobs];
}

/** Where a target stands, as a small button that opens the composer. */
export function PublishPill({ post, space, onOpen }: { post: Post; space: SpaceId; onOpen: () => void }) {
  usePublish();
  const p = planFor(post.$id, space);
  const net = networkOf(space);
  if (!net) return <button className="ghost xs pub-pill" onClick={onOpen} title="Copy the caption, download the file, open the upload page"><PaperPlaneTilt size={13} />Hand-off</button>;
  if (!p) return <button className="ghost xs pub-pill" onClick={onOpen}><RocketLaunch size={13} />Publish</button>;
  const tone = p.state === "published" ? "ok" : p.state === "failed" ? "bad" : BUSY.includes(p.state) ? "blue" : p.state === "armed" ? "violet" : "";
  const txt = BUSY.includes(p.state) ? `${p.state === "uploading" ? "Uploading" : "Sending"} ${Math.round(p.progress * 100)}%` : p.state === "armed" ? "Auto" : p.state === "published" ? (p.result?.private_only ? "Private" : "Live") : PLAN_LABEL[p.state];
  return <button className={`ghost xs pub-pill ${tone}`} onClick={onOpen} title={p.error ?? p.step ?? PLAN_LABEL[p.state]}>{p.state === "published" ? <CheckCircle size={13} weight="fill" /> : p.state === "failed" ? <Warning size={13} /> : p.state === "armed" ? <Lightning size={13} weight="fill" /> : <RocketLaunch size={13} />}{txt}</button>;
}

/** Tags / handles typed as chips: Enter or comma adds, Backspace on an empty box removes the last. */
function Chips({ value, onChange, label, prefix = "", max, placeholder }: { value: string[]; onChange: (v: string[]) => void; label: string; prefix?: string; max?: number; placeholder?: string }) {
  const [v, setV] = useState("");
  const add = (raw: string) => {
    const items = raw.split(",").map((x) => x.trim().replace(/^[@#]/, "")).filter(Boolean);
    if (!items.length) return;
    onChange([...new Set([...value, ...items])].slice(0, max ?? 99));
    setV("");
  };
  return (
    <div className="chips-in" onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement)?.focus()}>
      {value.map((x) => <span key={x} className="chip-x">{prefix}{x}<button type="button" aria-label={`Remove ${x}`} onClick={() => onChange(value.filter((y) => y !== x))}><X size={11} /></button></span>)}
      {(max === undefined || value.length < max) && <input aria-label={label} value={v} placeholder={value.length ? "" : placeholder} onChange={(e) => { if (e.target.value.endsWith(",")) add(e.target.value); else setV(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(v); } if (e.key === "Backspace" && !v && value.length) onChange(value.slice(0, -1)); }} onBlur={() => add(v)} />}
    </div>
  );
}

function Count({ n, max, label }: { n: number; max: number; label?: string }) {
  return <span className={`tiny mono ${n > max ? "over" : "faint"}`}>{label ? `${label} ` : ""}{n}/{max}</span>;
}

/** The live preview: a YouTube watch card, a Shorts / Reels / Story phone, or an Instagram feed post. */
export function Preview({ space, plan, picks, account }: { space: SpaceId; plan: Plan; picks: Pick[]; account: Account | null }) {
  const files = plan.media.map((r) => picks.find((p) => p.ref === r)).filter(Boolean) as Pick[];
  const cover = plan.cover ? picks.find((p) => p.ref === plan.cover) : null;
  const first = files[0];
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [plan.media.join()]);
  const shown = files[Math.min(i, files.length - 1)];
  const handle = account?.handle ?? account?.name ?? (spaceOf(space)?.network === "youtube" ? "Your channel" : "you");
  const Av = () => <span className="pv-av">{account?.avatar ? <img src={account.avatar} alt="" /> : handle.slice(0, 1).toUpperCase()}</span>;
  const Shot = ({ f, fit = "cover" }: { f?: Pick; fit?: "cover" | "contain" }) => !f ? <div className="pv-empty"><ImageIcon size={26} /><span>Pick a file</span></div>
    : f.kind === "video" && f.src ? <video key={f.src} src={f.src} poster={(cover?.thumb ?? f.thumb) || undefined} muted loop autoPlay playsInline preload="metadata" style={{ objectFit: fit }} />
    : <img src={f.thumb ?? f.src ?? ""} alt="" style={{ objectFit: fit }} />;

  if (space === "yt_video") {
    const o = plan.yt!;
    return (
      <div className="pv-yt">
        <div className="pv-yt-frame">{cover ? <img src={cover.thumb ?? ""} alt="" /> : <Shot f={first} fit="contain" />}<span className="pv-dur">{o.privacy === "public" ? "" : o.privacy}</span></div>
        <div className="pv-yt-meta"><Av /><div style={{ minWidth: 0 }}><b className="pv-yt-title">{o.title || "Your title"}</b><span className="tiny dim">{account?.name ?? "Your channel"} · {o.privacy === "public" ? "Public" : o.privacy === "unlisted" ? "Unlisted" : "Private"}{o.made_for_kids ? " · Made for kids" : ""}</span></div></div>
        {o.description && <p className="pv-yt-desc small">{o.description}</p>}
        {!!o.tags.length && <div className="tiny dim">{o.tags.slice(0, 6).map((t) => `#${t.replace(/\s+/g, "")}`).join(" ")}</div>}
      </div>
    );
  }
  if (space === "ig_post") {
    const o = plan.ig!;
    return (
      <div className="pv-ig">
        <div className="pv-ig-head"><Av /><b className="small">{handle}</b>{!!o.collaborators.length && <span className="tiny dim">and {o.collaborators.length} other{o.collaborators.length > 1 ? "s" : ""}</span>}</div>
        <div className="pv-ig-media" onClick={() => files.length > 1 && setI((i + 1) % files.length)}><Shot f={shown} />{files.length > 1 && <span className="pv-count">{i + 1}/{files.length}</span>}</div>
        {files.length > 1 && <div className="pv-dots">{files.map((_, k) => <i key={k} className={k === i ? "on" : ""} />)}</div>}
        <div className="pv-ig-acts"><Heart size={22} /><ChatCircle size={22} /><PaperPlaneTilt size={22} /><span className="grow" /><BookmarkSimple size={22} /></div>
        <p className="pv-cap small"><b>{handle}</b> {o.caption || <span className="dim">Your caption</span>}</p>
        {o.ai_generated && <span className="tiny dim">AI info</span>}
      </div>
    );
  }
  // tall: Shorts, Reels, Stories
  const caption = space === "yt_short" ? plan.yt!.title : space === "ig_story" ? "" : plan.ig!.caption;
  return (
    <div className="pv-phone">
      <div className="pv-screen">
        {space === "ig_story" && first && (plan.ig?.story_style ?? "card") !== "fill" ? (
          // built like a share by hand: the whole post on a blur (card: with corners and your @handle)
          <div className={`pv-story-card ${plan.ig?.story_style ?? "card"}`}>
            <div className="pv-story-bg" aria-hidden><Shot f={first} /></div>
            <div className="pv-story-mid">
              <div className="pv-story-stack">
                {(plan.ig?.story_style ?? "card") === "card" && <span className="pv-row pv-story-who"><Av /><b>@{handle}</b></span>}
                <div className="pv-story-pic"><Shot f={first} fit="contain" /></div>
              </div>
            </div>
          </div>
        ) : <Shot f={first} />}
        {space === "ig_story" ? <div className="pv-story-top"><i /><span className="pv-row"><Av /><b>{handle}</b><span className="dim">now</span></span></div> : (
          <>
            <div className="pv-rail"><span><Heart size={24} weight="fill" /><i>0</i></span><span><ChatCircle size={24} weight="fill" /><i>0</i></span><span><ShareFat size={24} weight="fill" /></span></div>
            <div className="pv-over"><span className="pv-row"><Av /><b>{handle}</b>{space === "yt_short" ? <em>Subscribe</em> : <em>Follow</em>}</span>
              {caption && <p>{caption}</p>}
              {space === "ig_reel" && plan.ig?.audio_name && <span className="tiny">♪ {plan.ig.audio_name}</span>}
              {space === "ig_reel" && plan.ig?.trial && <span className="tiny">Trial reel · shown to non-followers first</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Status({ plan, problems }: { plan: Plan; problems: string[] }) {
  const busy = BUSY.includes(plan.state);
  return (
    <div className="pub-status">
      {busy && <div className="pub-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(plan.progress * 100)}><i style={{ width: `${Math.max(4, plan.progress * 100)}%` }} /></div>}
      {plan.state === "published" && plan.result && (
        <div className="pub-live"><CheckCircle size={18} weight="fill" /><span className="small">{plan.step ?? "Live"}</span><a className="btn ghost xs" href={plan.result.url} target="_blank" rel="noreferrer">Open <ArrowSquareOut size={12} /></a></div>
      )}
      {plan.result?.private_only && <p className="tiny warn-t">YouTube kept it private: your Google Cloud project hasn&apos;t passed YouTube&apos;s API audit yet. Make it public in YouTube Studio for now (docs/PUBLISHING.md has the audit form).</p>}
      {plan.state === "failed" && <p className="small bad-t"><Warning size={14} /> {plan.error}{plan.next_try ? ` Trying again ${new Date(plan.next_try).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.` : ""}</p>}
      {!!problems.length && !busy && plan.state !== "published" && <ul className="pub-probs">{problems.map((p) => <li key={p}><Warning size={13} />{p}</li>)}</ul>}
      {!!plan.log.length && (
        <details className="pub-log"><summary className="tiny dim">History ({plan.log.length})</summary>
          <ol>{plan.log.slice().reverse().map((l, k) => <li key={k} className={l.ok === false ? "bad-t" : l.ok ? "ok-t" : ""}><span className="mono tiny faint">{new Date(l.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> {l.text}</li>)}</ol>
        </details>
      )}
    </div>
  );
}

/** The composer: a post's target → a plan with every option, saved as you go. */
export function Composer({ post, space, onClose }: { post: Post; space: SpaceId; onClose: () => void }) {
  const { accounts, configured } = usePublish();
  const { map } = useTargets();
  const { toast, confirm } = useDialog();
  const target = targetsOf(post, map).find((t) => t.space === space) ?? null;
  const net = networkOf(space);
  const picks = usePicks(post);
  const [plan, setPlan] = useState<Plan | null>(planFor(post.$id, space));
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lists, setLists] = useState<{ id: string; title: string }[] | null>(null);
  const [limit, setLimit] = useState<{ used: number; total: number } | null>(null);
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const mine = accounts.filter((a) => a.network === net);

  // load (or start) the plan, with sensible picks: the one account, the post's first fitting file, the post's cover
  useEffect(() => {
    if (!net) return;
    let live = true;
    api<{ plan: Plan | null; problems: string[] }>(`publish/${post.$id}/${space}`).then(async (r) => {
      if (!live) return;
      if (r.plan) { setPlan(r.plan); setProblems(r.problems); notePlan(r.plan); return; }
      const r2 = await api<{ plan: Plan; problems: string[] }>(`publish/${post.$id}/${space}`, { body: { when: "scheduled" } });
      if (live) { setPlan(r2.plan); setProblems(r2.problems); notePlan(r2.plan); }
    }).catch((e) => toast((e as Error).message, "bad"));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.$id, space]);
  // first-time picks once the files and accounts are known
  const seeded = useRef(false);
  useEffect(() => {
    if (!plan || seeded.current || plan.state !== "draft") return;
    const patch: Record<string, unknown> = {};
    if (!plan.account && mine.length === 1) patch.account = mine[0].id;
    if (!plan.media.length && picks.length) {
      const want = space === "ig_post" || space === "ig_story" ? picks.find((p) => p.kind === "image" || p.kind === "video") : picks.find((p) => p.kind === "video");
      if (want) patch.media = [want.ref];
    }
    if (!plan.cover && post.cover && space !== "ig_story" && space !== "ig_post") patch.cover = `m:${post.cover}`;
    if (Object.keys(patch).length) { seeded.current = true; edit(patch, true); }
    else if (picks.length) seeded.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.state, picks.length, mine.length]);
  // the server moves it along while it's going out
  useEffect(() => {
    if (!plan || !BUSY.includes(plan.state)) return;
    const t = setInterval(() => api<{ plan: Plan; problems: string[] }>(`publish/${post.$id}/${space}`).then((r) => { if (r.plan) { setPlan(r.plan); notePlan(r.plan); } }).catch(() => null), 2500);
    return () => clearInterval(t);
  }, [plan?.state, post.$id, space]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (net !== "youtube" || !plan?.account) return;
    api<{ playlists: { id: string; title: string }[] }>(`publish/playlists/${plan.account}`).then((r) => setLists(r.playlists)).catch(() => setLists([]));
  }, [net, plan?.account]);
  useEffect(() => {
    if (net !== "instagram" || !plan?.account) return;
    api<{ used: number; total: number }>(`publish/limit/${plan.account}`).then(setLimit).catch(() => setLimit(null));
  }, [net, plan?.account]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".modal")) onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  useEffect(() => { box.current?.focus(); }, []);

  async function flush() {
    const body = pending.current; pending.current = {};
    if (!Object.keys(body).length) return;
    try {
      const r = await api<{ plan: Plan; problems: string[] }>(`publish/${post.$id}/${space}`, { body });
      setProblems(r.problems); notePlan(r.plan);
      setPlan((cur) => (cur && Object.keys(pending.current).length ? cur : r.plan));
    } catch (e) { toast((e as Error).message, "bad"); }
  }
  function edit(patch: Record<string, unknown>, now = false) {
    setPlan((p) => p && ({ ...p, ...patch, ...(patch.yt ? { yt: { ...p.yt!, ...(patch.yt as object) } } : {}), ...(patch.ig ? { ig: { ...p.ig!, ...(patch.ig as object) } } : {}) } as Plan));
    const cur = pending.current;
    pending.current = { ...cur, ...patch, ...(patch.yt ? { yt: { ...(cur.yt as object), ...(patch.yt as object) } } : {}), ...(patch.ig ? { ig: { ...(cur.ig as object), ...(patch.ig as object) } } : {}) };
    clearTimeout(timer.current);
    if (now) flush(); else timer.current = setTimeout(flush, 600);
  }
  useEffect(() => () => { clearTimeout(timer.current); flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const yt = (p: Partial<YtOptions>) => edit({ yt: p });
  const ig = (p: Partial<IgOptions>) => edit({ ig: p });

  async function act(path: string, body: Record<string, unknown> = {}) {
    clearTimeout(timer.current);
    await flush();
    setBusy(true);
    let ok = false;
    try {
      const r = await api<{ plan: Plan; problems?: string[] }>(`publish/${post.$id}/${space}/${path}`, { body });
      ok = true;
      setPlan(r.plan); notePlan(r.plan); if (r.problems) setProblems(r.problems);
      if (path === "go" && body.mode === "now") toast(`Publishing to ${spaceName(space)}…`, "ok");
      if (path === "go" && body.mode === "arm") toast(target?.due_at ? `Goes out ${whenLabel(target.due_at)}` : "Set to go: give it a publish time", "ok");
    } catch (e) { toast((e as Error).message, "bad"); }
    setBusy(false);
    refreshPublish();
    return ok;
  }

  /** A live post or reel to the story, as a post card (the composer for the story opens on it). */
  async function shareStory() {
    if (!(await confirm({ title: "Share it to your story?", body: "It goes up now as a post card: the whole post with your @handle on a blur of itself, like sharing it by hand.", confirm: "Share to story" }))) return;
    setBusy(true);
    try { await api(`publish/${post.$id}/ig_story/share`, { body: { from: space, go: "now" } }); toast("Sharing to your story…", "ok"); refreshPublish(); }
    catch (e) { toast((e as Error).message, "bad"); }
    setBusy(false);
  }

  if (!net) return <Handoff post={post} space={space} picks={picks} onClose={onClose} />;
  const running = plan ? BUSY.includes(plan.state) : false;
  const locked = running;
  const files = plan?.media ?? [];
  const multi = space === "ig_post";
  const fit = (p: Pick) => (space === "yt_video" || space === "yt_short" || space === "ig_reel" ? p.kind === "video" : p.kind !== "other");
  const toggleFile = (ref: string) => edit({ media: multi ? (files.includes(ref) ? files.filter((x) => x !== ref) : [...files, ref]) : files[0] === ref ? [] : [ref] }, true);
  const images = picks.filter((p) => p.kind === "image");
  const caption = plan?.ig?.caption ?? "";
  const due = target?.due_at ?? null;

  return (
    <>
      <div className="scrim-modal" onClick={onClose} />
      <div className="pub" role="dialog" aria-modal="true" aria-label={`Publish to ${spaceName(space)}`} tabIndex={-1} ref={box}>
        <header className="pub-head">
          <PlatformBadge space={space} size={30} solid />
          <div style={{ minWidth: 0, flex: 1 }}><h2 className="ellipsis">Publish to {spaceName(space)}</h2><span className="tiny dim ellipsis">{post.title}</span></div>
          {plan && <span className={`pill ${plan.state === "published" ? "ok" : plan.state === "failed" ? "bad" : running ? "blue" : plan.state === "armed" ? "violet" : ""}`}>{PLAN_LABEL[plan.state]}</span>}
          <button className="icon-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)"><X size={18} /></button>
        </header>
        {!plan ? <div className="pub-body"><span className="vp-spin" /></div> : (
          <div className="pub-body">
            <div className="pub-form">
              <fieldset disabled={locked} className="pub-fs">
                <section>
                  <h3>Account</h3>
                  {!configured[net] ? <p className="small dim">{net === "youtube" ? "YouTube" : "Instagram"} isn&apos;t set up on this Voicebox yet. Posts → Autopilot has the steps.</p> : (
                    <div className="acct-row">
                      {mine.map((a) => <button key={a.id} type="button" className={`acct-chip ${plan.account === a.id ? "on" : ""}`} aria-pressed={plan.account === a.id} onClick={() => edit({ account: a.id }, true)}>
                        <span className="pv-av sm">{a.avatar ? <img src={a.avatar} alt="" /> : a.name.slice(0, 1)}</span>{a.handle ? (net === "instagram" ? `@${a.handle}` : a.name) : a.name}{a.error && <Warning size={13} className="bad-t" />}</button>)}
                      <a className="btn ghost xs" href={`/api/publish/${net}/connect`}><Plus size={13} />{mine.length ? "Another" : `Connect ${net === "youtube" ? "YouTube" : "Instagram"}`}</a>
                    </div>
                  )}
                  {limit && Number.isFinite(limit.total - limit.used) && <p className="tiny faint" style={{ margin: "6px 0 0" }}>{limit.total - limit.used} of {limit.total} API posts left in the last 24 h</p>}
                </section>

                <section>
                  <div className="row between"><h3>{multi ? "Photos and videos" : space === "ig_story" ? "Photo or video" : "Video"}</h3>{multi && <span className="tiny faint">{files.length}/{LIMITS.ig_carousel} · tap in order</span>}</div>
                  {picks.filter(fit).length ? (
                    <div className="pick-grid">
                      {picks.filter(fit).map((p) => { const n = files.indexOf(p.ref); return (
                        <button key={p.ref} type="button" className={`pick ${n >= 0 ? "on" : ""}`} aria-pressed={n >= 0} onClick={() => toggleFile(p.ref)} title={p.name}>
                          {p.thumb ? <img src={p.thumb} alt="" /> : p.kind === "video" && p.src ? <video src={`${p.src}#t=0.5`} muted preload="metadata" /> : <ImageIcon size={20} />}
                          {p.kind === "video" && <span className="pick-k"><Play size={10} weight="fill" /></span>}
                          {n >= 0 && <span className="pick-n">{multi ? n + 1 : <CheckCircle size={14} weight="fill" />}</span>}
                        </button>
                      ); })}
                    </div>
                  ) : <p className="small dim">Add the {space === "ig_post" ? "photos" : "final cut"} under Media in the post (or make a video in the studio), then pick it here.</p>}
                </section>

                {space === "ig_story" && (
                  <section>
                    <h3>Looks like</h3>
                    <div className="seg" role="radiogroup" aria-label="Story style">
                      {([["card", "Post card"], ["fit", "Whole picture"], ["fill", "Fill the screen"]] as const).map(([v, l]) => (
                        <button key={v} type="button" role="radio" aria-checked={(plan.ig?.story_style ?? "card") === v} className={(plan.ig?.story_style ?? "card") === v ? "on" : ""} onClick={() => ig({ story_style: v })}>{l}</button>
                      ))}
                    </div>
                    <p className="tiny faint" style={{ margin: "6px 0 0" }}>{(plan.ig?.story_style ?? "card") === "card" ? "Like sharing a post by hand: the whole post as a card with your @handle, on a blur of itself. Videos are laid out on the GPU worker." : (plan.ig?.story_style ?? "card") === "fit" ? "Nothing cut off: the whole picture on a blur of itself." : "Instagram crops it to fill 9:16: the top and bottom (or sides) are cut."}</p>
                  </section>
                )}

                {space === "ig_post" && files.length > 1 && (
                  <section>
                    <h3>Cover</h3>
                    <p className="tiny faint" style={{ margin: "0 0 8px" }}>On Instagram the first slide is the cover. Tap one to put it first.</p>
                    <div className="pick-grid sm">
                      {files.map((r, n) => { const p = picks.find((x) => x.ref === r); return p && (
                        <button key={r} type="button" className={`pick ${n === 0 ? "on" : ""}`} aria-pressed={n === 0} onClick={() => edit({ media: [r, ...files.filter((x) => x !== r)] }, true)} title={p.name}>
                          {p.thumb ? <img src={p.thumb} alt="" /> : p.kind === "video" && p.src ? <video src={`${p.src}#t=0.5`} muted preload="metadata" /> : <ImageIcon size={18} />}
                          {n === 0 && <span className="pick-n"><CheckCircle size={14} weight="fill" /></span>}
                        </button>
                      ); })}
                    </div>
                  </section>
                )}

                {(space === "yt_video" || space === "yt_short" || space === "ig_reel" || (space === "ig_post" && files.length === 1 && picks.find((x) => x.ref === files[0])?.kind === "video")) && (
                  <section>
                    <h3>{net === "instagram" ? "Cover" : "Thumbnail"}</h3>
                    <div className="pick-grid sm">
                      <button type="button" className={`pick none ${!plan.cover ? "on" : ""}`} aria-pressed={!plan.cover} onClick={() => edit({ cover: null }, true)}>{net === "instagram" ? "Frame" : "Auto"}</button>
                      {images.map((p) => <button key={p.ref} type="button" className={`pick ${plan.cover === p.ref ? "on" : ""}`} aria-pressed={plan.cover === p.ref} onClick={() => edit({ cover: p.ref }, true)} title={p.name}><img src={p.thumb ?? ""} alt="" />{plan.cover === p.ref && <span className="pick-n"><CheckCircle size={14} weight="fill" /></span>}</button>)}
                    </div>
                    {net === "instagram" && !plan.cover && <label className="row small dim" style={{ gap: 8, marginTop: 8 }}>Frame at
                      <input type="number" min={0} step={0.5} style={{ width: 90 }} aria-label="Cover frame, seconds" value={plan.ig!.thumb_offset_ms != null ? plan.ig!.thumb_offset_ms / 1000 : ""} placeholder="0" onChange={(e) => ig({ thumb_offset_ms: e.target.value === "" ? null : Math.round(Number(e.target.value) * 1000) })} />s</label>}
                    {net === "youtube" && <p className="tiny faint" style={{ margin: "6px 0 0" }}>{space === "yt_short" ? "Shorts take a custom thumbnail too (shown in search, the channel page and subscriptions). " : ""}Custom thumbnails need a phone-verified channel. 1280×720 looks best.{plan.state === "published" ? " Pick one, then Update on YouTube." : ""}</p>}
                    {net === "instagram" && plan.state === "published" && <p className="tiny faint" style={{ margin: "6px 0 0" }}>Instagram doesn&apos;t let apps change a cover once it&apos;s posted; change it in the Instagram app.</p>}
                  </section>
                )}

                {net === "youtube" && plan.yt && (
                  <>
                    <section>
                      <div className="row between"><h3>Title</h3><Count n={plan.yt.title.length} max={LIMITS.yt_title} /></div>
                      <input value={plan.yt.title} aria-label="Title" maxLength={LIMITS.yt_title} onChange={(e) => yt({ title: e.target.value })} placeholder="What it is, the hook first" />
                      <div className="row between" style={{ marginTop: 12 }}><h3>Description</h3><Count n={plan.yt.description.length} max={LIMITS.yt_description} /></div>
                      <textarea className="doc short" aria-label="Description" value={plan.yt.description} onChange={(e) => yt({ description: e.target.value })} placeholder="Links, chapters (0:00 Intro), credits" />
                      <div className="row between" style={{ marginTop: 12 }}><h3>Tags</h3><Count n={plan.yt.tags.join(",").length} max={LIMITS.yt_tags} /></div>
                      <Chips value={plan.yt.tags} onChange={(tags) => yt({ tags })} label="Tags" placeholder="Type a tag, Enter" />
                    </section>
                    <section className="pub-grid">
                      <label><span className="lbl">Visibility</span>
                        <div className="seg">{(["public", "unlisted", "private"] as const).map((v) => <button key={v} type="button" className={plan.yt!.privacy === v ? "on" : ""} onClick={() => yt({ privacy: v })}>{v[0].toUpperCase() + v.slice(1)}</button>)}</div></label>
                      <label><span className="lbl">Category</span><Select size="sm" label="Category" value={plan.yt.category} onChange={(v) => yt({ category: v })} options={YT_CATEGORIES} /></label>
                      <label><span className="lbl">Playlist</span><Select size="sm" label="Playlist" value={plan.yt.playlist ?? ""} onChange={(v) => yt({ playlist: v || null })}
                        options={[["", lists === null && plan.account ? "Loading…" : "None"] as const, ...(lists ?? []).map((l) => [l.id, l.title] as const)]} /></label>
                      <label><span className="lbl">Language</span><Select size="sm" label="Video language" value={plan.yt.language ?? ""} onChange={(v) => yt({ language: v || null })} options={LANGUAGES} /></label>
                      <label><span className="lbl">License</span><Select size="sm" label="License" value={plan.yt.license} onChange={(v) => yt({ license: v as YtOptions["license"] })} options={[["youtube", "Standard YouTube"], ["creativeCommon", "Creative Commons"]]} /></label>
                      <label><span className="lbl">Recorded on</span><input type="date" aria-label="Recording date" value={plan.yt.recording_date?.slice(0, 10) ?? ""} onChange={(e) => yt({ recording_date: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label>
                    </section>
                    <section>
                      <h3>Audience and disclosures</h3>
                      <Toggle on={plan.yt.made_for_kids} set={(v) => yt({ made_for_kids: v })} title="Made for kids" about="Required by law (COPPA). Turns off comments and personalised ads." />
                      <Toggle on={plan.yt.synthetic} set={(v) => yt({ synthetic: v })} title="Altered or synthetic content" about="Realistic AI voice or visuals a viewer could mistake for real. YouTube shows a label." />
                      <Toggle on={plan.yt.notify} set={(v) => yt({ notify: v })} title="Notify subscribers" about="Off for re-uploads or small fixes." />
                      <Toggle on={plan.yt.embeddable} set={(v) => yt({ embeddable: v })} title="Allow embedding" />
                      <Toggle on={plan.yt.public_stats} set={(v) => yt({ public_stats: v })} title="Show views and likes" />
                    </section>
                  </>
                )}

                {net === "instagram" && plan.ig && (
                  <>
                    {space !== "ig_story" && (
                      <section>
                        <div className="row between"><h3>Caption</h3><span className="row" style={{ gap: 10 }}><Count n={hashtags(caption).length} max={LIMITS.ig_hashtags} label="#" /><Count n={caption.length} max={LIMITS.ig_caption} /></span></div>
                        <textarea className="doc short" aria-label="Caption" value={caption} onChange={(e) => ig({ caption: e.target.value })} placeholder="The hook in the first line. Up to 30 hashtags." />
                        <div className="row" style={{ gap: 6, marginTop: 6 }}>
                          <button type="button" className="quiet xs" onClick={() => ig({ caption: post.caption ?? "" })}>Use the post&apos;s caption</button>
                          {hashtags(caption).length > 0 && <button type="button" className="quiet xs" onClick={() => ig({ caption: caption.replace(/(\s*#[\p{L}\p{N}_]+)+\s*$/u, "").trim(), first_comment: [plan.ig!.first_comment, hashtags(caption).join(" ")].filter(Boolean).join("\n") })}>Move hashtags to first comment</button>}
                        </div>
                      </section>
                    )}
                    <section>
                      <h3>People</h3>
                      {space !== "ig_story" && <><span className="lbl">Collaborators (up to 3, they get an invite)</span><Chips value={plan.ig.collaborators} onChange={(collaborators) => ig({ collaborators })} label="Collaborators" prefix="@" max={LIMITS.ig_collaborators} placeholder="username" /></>}
                      <span className="lbl" style={{ marginTop: 10 }}>Tag people</span><Chips value={plan.ig.user_tags} onChange={(user_tags) => ig({ user_tags })} label="Tagged people" prefix="@" max={20} placeholder="username" />
                    </section>
                    {space !== "ig_story" && (
                      <section className="pub-grid">
                        {space === "ig_reel" && <label><span className="lbl">Trial reel</span><Select size="sm" label="Trial reel" value={plan.ig.trial ?? ""} onChange={(v) => ig({ trial: (v || null) as IgOptions["trial"] })}
                          options={[["", "Off: show to followers"], ["MANUAL", "Trial: I'll share it if it does well"], ["SS_PERFORMANCE", "Trial: share it if it does well"]]} /></label>}
                        {space === "ig_reel" && <label><span className="lbl">Audio name</span><input value={plan.ig.audio_name ?? ""} aria-label="Audio name" maxLength={100} placeholder="Original audio" onChange={(e) => ig({ audio_name: e.target.value || null })} /></label>}
                        <label><span className="lbl">Location (Page ID)</span><input value={plan.ig.location_id ?? ""} aria-label="Location page ID" inputMode="numeric" placeholder="Optional" onChange={(e) => ig({ location_id: e.target.value.replace(/\D/g, "") || null })} /></label>
                        {space === "ig_post" && <label className="span2"><span className="lbl">Alt text (photos)</span><input value={plan.ig.alt_text ?? ""} aria-label="Alt text" maxLength={1000} placeholder="What's in the photo, for screen readers" onChange={(e) => ig({ alt_text: e.target.value || null })} /></label>}
                      </section>
                    )}
                    <section>
                      {space === "ig_reel" && <Toggle on={plan.ig.share_to_feed} set={(v) => ig({ share_to_feed: v })} title="Also show in the feed" about="Off: only in the Reels tab." />}
                      {space !== "ig_story" && <Toggle on={plan.ig.ai_generated} set={(v) => ig({ ai_generated: v })} title="AI label" about="Says AI was used to make it. Meta may add the label itself for realistic AI media." />}
                      {space !== "ig_story" && <><div className="row between" style={{ marginTop: 10 }}><h3>First comment</h3><Count n={(plan.ig.first_comment ?? "").length} max={LIMITS.ig_comment} /></div>
                        <textarea className="doc short" aria-label="First comment" value={plan.ig.first_comment ?? ""} onChange={(e) => ig({ first_comment: e.target.value || null })} placeholder="Posted right after it goes live: hashtags, a question, a link note" /></>}
                    </section>
                  </>
                )}

                <section>
                  <h3>When</h3>
                  <div className="seg">
                    <button type="button" className={plan.when === "scheduled" ? "on" : ""} onClick={() => edit({ when: "scheduled" }, true)}><Clock size={14} />At the publish time</button>
                    <button type="button" className={plan.when === "now" ? "on" : ""} onClick={() => edit({ when: "now" }, true)}><Lightning size={14} />Right away</button>
                  </div>
                  {plan.when === "scheduled" && (
                    <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      <input type="datetime-local" aria-label="Publish time" value={toLocal(due)} style={{ width: "auto" }}
                        onChange={(e) => target && saveTargets(post.$id, targetsOf(post, map).map((t) => (t.space === space ? { ...t, due_at: e.target.value ? new Date(e.target.value).toISOString() : null, status: t.status === "idea" || t.status === "draft" || t.status === "review" ? "scheduled" : t.status } : t))).catch((er) => toast((er as Error).message, "bad"))} />
                      {due && <span className="tiny dim">{Date.parse(due) < Date.now() ? "That's in the past: it goes out on the next autopilot run." : `in ${Math.max(1, Math.round((Date.parse(due) - Date.now()) / 36e5))} h`}</span>}
                    </div>
                  )}
                  {net === "youtube" && plan.when === "scheduled" && <Toggle on={plan.yt!.youtube_schedules} set={(v) => yt({ youtube_schedules: v })} title="Let YouTube publish it on the minute" about="Uploads up to 6 h early as private; YouTube makes it public exactly at the time (public videos only)." />}
                </section>
              </fieldset>
            </div>

            <aside className="pub-side">
              <div className="pub-preview"><Preview space={space} plan={plan} picks={picks} account={accounts.find((a) => a.id === plan.account) ?? null} /></div>
              <Status plan={plan} problems={problems} />
            </aside>
          </div>
        )}
        {plan && (
          <footer className="pub-foot">
            {running ? <>
              <span className="small dim grow">{plan.step ?? "Working"}</span>
              <button className="ghost" disabled={busy} onClick={async () => { if (await confirm({ title: "Stop publishing?", body: "What's already uploaded stays on the platform's side as a draft.", confirm: "Stop", danger: true })) act("cancel"); }}><Stop size={15} />Stop</button>
            </> : plan.state === "published" ? <>
              <span className="small dim grow">{net === "youtube" ? "Change the title, description, tags, privacy or thumbnail, then update it." : "Edits now don't change what's live."}</span>
              {net === "youtube" && <button disabled={busy} onClick={() => act("update").then((ok) => ok && toast("Updated on YouTube", "ok"))}><ArrowsClockwise size={15} />Update on YouTube</button>}
              {net === "instagram" && space !== "ig_story" && <button className="ghost" disabled={busy} onClick={() => shareStory()}><ShareFat size={15} />Share to story</button>}
              <button className="ghost" disabled={busy} onClick={async () => { if (await confirm({ title: "Post it again?", body: `This makes a second, separate post on ${spaceName(space)}.`, confirm: "Post again" })) act("go", { mode: plan.when === "now" ? "now" : "arm", again: true }); }}><ArrowsClockwise size={15} />Post again</button>
              {plan.result && <a className="btn" href={plan.result.url} target="_blank" rel="noreferrer">Open <ArrowSquareOut size={14} /></a>}
            </> : <>
              <span className="small dim grow">{plan.state === "armed" ? (due ? `Goes out ${whenLabel(due)}` : "Set to go: it needs a publish time") : problems.length ? `${problems.length} thing${problems.length > 1 ? "s" : ""} to fix` : "Ready"}</span>
              {(plan.state === "failed" || plan.state === "canceled") && <button className="ghost" disabled={busy} onClick={() => act("retry")}><ArrowsClockwise size={15} />Retry</button>}
              {plan.state === "armed" ? <button className="ghost" disabled={busy} onClick={() => act("go", { mode: "disarm" })}>Take off autopilot</button>
                : plan.when === "scheduled" && <button className="ghost" disabled={busy || !!problems.length} onClick={() => act("go", { mode: "arm" })}><Lightning size={15} />Set to go</button>}
              <button disabled={busy || !!problems.length} onClick={async () => { if (await confirm({ title: `Publish to ${spaceName(space)} now?`, body: net === "youtube" ? `It uploads now as ${plan.yt!.privacy}.` : "It goes live on Instagram in a minute or two.", confirm: "Publish now" })) act("go", { mode: "now" }); }}><RocketLaunch size={15} />Publish now</button>
            </>}
          </footer>
        )}
      </div>
    </>
  );
}

/** Places Voicebox can't post to by itself: everything to do it by hand in a minute, then mark it posted. */
function Handoff({ post, space, picks, onClose }: { post: Post; space: SpaceId; picks: Pick[]; onClose: () => void }) {
  const { map } = useTargets();
  const { toast } = useDialog();
  const [link, setLink] = useState("");
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".modal")) onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  const text = space === "x_thread" ? (post.script ?? post.caption ?? "") : (post.caption ?? "");
  const copy = () => navigator.clipboard.writeText(text).then(() => toast("Caption copied", "ok")).catch(() => toast("Couldn't copy", "bad"));
  const done = () => saveTargets(post.$id, targetsOf(post, map).map((t) => (t.space === space ? { ...t, status: "posted", link: link.trim() || t.link } : t))).then(() => { toast(`Marked posted on ${spaceName(space)}`, "ok"); onClose(); }).catch((e) => toast((e as Error).message, "bad"));
  return (
    <>
      <div className="scrim-modal" onClick={onClose} />
      <div className="pub narrow" role="dialog" aria-modal="true" aria-label={`Post to ${spaceName(space)}`}>
        <header className="pub-head"><PlatformBadge space={space} size={30} solid /><div style={{ flex: 1, minWidth: 0 }}><h2>Post to {spaceName(space)}</h2><span className="tiny dim">Voicebox can&apos;t post here by itself, so here&apos;s everything for doing it by hand.</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close (Esc)"><X size={18} /></button></header>
        <div className="pub-hand">
          <section><div className="row between"><h3>1 · Caption</h3><button className="ghost xs" onClick={copy}><Copy size={13} />Copy</button></div><pre className="hand-text">{text || "No caption yet: write it in the post."}</pre></section>
          <section><h3>2 · The file</h3>{picks.filter((p) => p.kind !== "other").length ? <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{picks.filter((p) => p.src).map((p) => <a key={p.ref} className="btn ghost xs" href={p.src!} download={p.name} target="_blank" rel="noreferrer"><DownloadSimple size={13} />{p.name.slice(0, 28)}</a>)}</div> : <p className="small dim">No files on the post.</p>}</section>
          <section><h3>3 · Post it</h3>{UPLOAD_PAGE[space] && <a className="btn ghost sm" href={UPLOAD_PAGE[space]} target="_blank" rel="noreferrer">Open {spaceOf(space)?.networkLabel} <ArrowSquareOut size={13} /></a>}</section>
          <section><h3>4 · Mark it posted</h3><div className="row" style={{ gap: 8 }}><input value={link} aria-label="Live link" placeholder="Live link https://… (optional)" onChange={(e) => setLink(e.target.value)} /><button onClick={done}><CheckCircle size={15} />Posted</button></div></section>
        </div>
      </div>
    </>
  );
}

/** What the queue shows for a plan. */
export function usePlanList() {
  const s = usePublish();
  const { map } = useTargets();
  return useMemo(() => s.plans.map((p) => ({ p, due: (map[p.post] ?? []).find((t) => t.space === p.space)?.due_at ?? null })), [s.plans, map]);
}
