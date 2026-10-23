"use client";
// The content planner, built around how a creator thinks about the week, kept quiet: ink, hairlines, one accent.
//   - platforms as a row of logo chips; inside one, its formats (Reels, Shorts, Posts...)
//   - shipped this week against the weekly goal, the streak
//   - the next seven days as a hairline timeline: what goes out when; drag a post to another day to reschedule
//   - the work as cards grouped Up next → In the works → Ideas → Shipped. Pipeline and List views too.
// A post can go to many formats at once (cross-posting); click one for the full editor.
import { Flame, Kanban, Lightbulb, ListBullets, Minus, Plus, SquaresFour, TrashSimple } from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { NETWORKS, SHAPE, SPACES, spaceName, spaceOf, shippedAt, targetsOf, type SpaceId, type Target } from "@/lib/spaces";
import { AW, fileUrl, STATUSES, type Media, type Post, type Status } from "@/lib/workspace";
import { aw, logActivity, Query, timeAgo, useLive, useMe } from "./aw";
import { useDialog } from "./Dialog";
import { NET, PlatformBadge, ShapeGlyph } from "./platform";
import { createPost, dueLabel, PostDrawer, savePost } from "./Workspace";
import { forgetTargets, saveGoals, saveTargets, useTargets } from "./useTargets";
import { Avatar, Gate } from "./wsparts";

type View = "gallery" | "pipeline" | "list";
type Entry = { p: Post; t: Target | null; all: Target[] }; // one post as seen from the current scope
const IDEAS = "none";
const RANK = Object.fromEntries(STATUSES.map((s, i) => [s.id, i])) as Record<Status, number>;
const DAY = 864e5;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d: Date) => { const x = startOfDay(d); return new Date(x.getTime() - ((x.getDay() + 6) % 7) * DAY); }; // Monday
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const inHuman = (iso: string) => {
  const m = Math.round((Date.parse(iso) - Date.now()) / 6e4);
  if (m < 0) return "overdue";
  if (m < 60) return `in ${m} min`;
  if (m < 60 * 24) return `in ${Math.round(m / 60)} h`;
  return `in ${Math.round(m / 1440)} days`;
};

/** Which spaces a scope covers: everything, one platform, one format, or the idea vault. */
function scopeSpaces(scope: string): SpaceId[] | null {
  if (!scope) return null;
  if (scope === IDEAS) return [];
  const net = NETWORKS.find((n) => n.id === scope);
  if (net) return net.spaces.map((s) => s.id);
  return spaceOf(scope) ? [scope as SpaceId] : null;
}

const STAGE_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label])) as Record<Status, string>;

/** One post: logos of where it goes, the title, a line of the words, stage and date. A cover image when there is one. */
function Card({ e, cover, onOpen, onDelete }: { e: Entry; cover: string | null; onOpen: () => void; onDelete: () => void }) {
  const status = e.t?.status ?? e.p.status;
  const due = e.t ? e.t.due_at ?? null : e.p.due_at;
  const late = !!due && status !== "posted" && Date.parse(due) < Date.now();
  const words = (e.p.caption || e.p.script || e.p.notes || "").trim();
  const formats = e.all.map((t) => spaceOf(t.space)?.label).filter(Boolean);
  return (
    <article className={`pcard ${late ? "late" : ""} ${status === "posted" ? "shipped" : ""}`} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(k) => { if (k.key === "Enter") onOpen(); }} draggable
      onDragStart={(d) => { d.dataTransfer.setData("text/post", e.p.$id); if (e.t) d.dataTransfer.setData("text/space", e.t.space); }}>
      {cover && <div className={`pc-cover ${e.t || e.all[0] ? SHAPE[(e.t ?? e.all[0])!.space] : ""}`}><img src={cover} alt="" loading="lazy" /></div>}
      <div className="pc-top">
        <span className="pc-logos">
          {e.all.length ? e.all.map((t) => <PlatformBadge key={t.space} space={t.space} size={20} solid={t.status === "posted"} />) : <Lightbulb size={16} />}
        </span>
        <span className="pc-fmt">{formats.length ? [...new Set(formats)].join(" · ") : "Idea"}</span>
      </div>
      <h3 className="pc-h">{e.p.title}</h3>
      {words && <p className="pc-words">{words}</p>}
      <div className="pc-bottom">
        <span className={`pc-stage st-${status}`}><i />{STAGE_LABEL[status]}</span>
        {due && status !== "posted" && <span className={`pc-when ${late ? "late" : ""}`}>{late ? "Late" : dueLabel(due)}</span>}
        <span style={{ marginLeft: "auto" }}>{(e.p.assignee_name || e.p.owner_name) && <Avatar id={e.p.assignee_id ?? e.p.owner_id} name={e.p.assignee_name ?? e.p.owner_name} sm />}</span>
      </div>
      <button className="pc-del" title="Delete post" onClick={(x) => { x.stopPropagation(); onDelete(); }}><TrashSimple size={13} /></button>
    </article>
  );
}

function NewMenu({ scope, onPick, onClose }: { scope: string; onPick: (space: SpaceId | null) => void; onClose: () => void }) {
  const nets = scopeSpaces(scope)?.length ? NETWORKS.filter((n) => n.id === spaceOf(scopeSpaces(scope)![0])?.network) : NETWORKS;
  return (
    <>
      <div className="gpu-scrim" onClick={onClose} />
      <div className="new-menu">
        {nets.map((n) => (
          <div key={n.id} className="nm-net">
            <PlatformBadge net={n.id} size={22} />
            <div className="nm-formats">{n.spaces.map((s) => <button key={s.id} className="nm-f" onClick={() => onPick(s.id)}><ShapeGlyph space={s.id} />{s.label}</button>)}</div>
          </div>
        ))}
        <button className="nm-f idea" onClick={() => onPick(null)}><Lightbulb size={14} weight="fill" />Just an idea</button>
      </div>
    </>
  );
}

function ContentInner() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe();
  const { confirm, toast } = useDialog();
  const { rows: posts, loading, error } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(500)]);
  const { rows: media } = useLive<Media>("media", [Query.orderDesc("$createdAt"), Query.limit(500)]);
  const { map, goals } = useTargets();
  const scope = params.get("space") ?? "";
  const open = params.get("post");
  const [view, setView] = useState<View>("gallery");
  const [q, setQ] = useState("");
  const [who, setWho] = useState<"all" | "mine">("all");
  const [menu, setMenu] = useState(false);
  const [showShipped, setShowShipped] = useState(false);
  const [overDay, setOverDay] = useState<number | null>(null);
  useEffect(() => { try { const v = localStorage.getItem("vb-content-view"); if (v === "gallery" || v === "pipeline" || v === "list") setView(v); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem("vb-content-view", view); } catch {} }, [view]);

  const go = (next: { space?: string; post?: string | null }) => {
    const u = new URLSearchParams();
    const sp = next.space ?? scope;
    if (sp) u.set("space", sp);
    const po = next.post === undefined ? open : next.post;
    if (po) u.set("post", po);
    router.push(`/content${u.size ? `?${u}` : ""}`, { scroll: false });
  };

  const spaces = scopeSpaces(scope);
  const net = NETWORKS.find((n) => n.id === scope || n.spaces.some((s) => s.id === scope));
  const space = spaceOf(scope);

  // covers: the post's chosen cover, else its first image
  const covers = useMemo(() => {
    const byId = new Map(media.map((m) => [m.$id, m]));
    const first = new Map<string, Media>();
    for (const m of media) if (m.post_id && m.kind === "image" && m.token && !first.has(m.post_id)) first.set(m.post_id, m);
    return (p: Post) => { const m = (p.cover && byId.get(p.cover)) || first.get(p.$id); return m?.token ? fileUrl(m, "preview", 520) : null; };
  }, [media]);

  // every post as seen from this scope (one entry per post; t = its target in this scope)
  const entries: Entry[] = useMemo(() => {
    const mine = (p: Post) => p.assignee_id === me?.user?.id || (!p.assignee_id && p.owner_id === me?.user?.id);
    const text = (p: Post) => !q || `${p.title} ${p.script ?? ""} ${p.caption ?? ""} ${p.notes ?? ""}`.toLowerCase().includes(q.toLowerCase());
    const out: Entry[] = [];
    for (const p of posts) {
      if (!(who === "all" || mine(p)) || !text(p)) continue;
      const all = targetsOf(p, map);
      if (scope === IDEAS) { if (!all.length) out.push({ p, t: null, all }); continue; }
      if (!spaces) { out.push({ p, t: null, all }); continue; }
      const t = all.find((x) => spaces.includes(x.space));
      if (t) out.push({ p, t, all });
    }
    return out;
  }, [posts, map, scope, q, who, me, spaces]);

  // (post, target) pairs in scope: what the week strip and momentum count
  const drops = useMemo(() => {
    const out: { p: Post; t: Target | null }[] = [];
    for (const p of posts) {
      const all = targetsOf(p, map);
      if (scope === IDEAS) { if (!all.length) out.push({ p, t: null }); continue; }
      const ts = spaces ? all.filter((t) => spaces.includes(t.space)) : all;
      if (!ts.length && !spaces) out.push({ p, t: null });
      for (const t of ts) out.push({ p, t });
    }
    return out;
  }, [posts, map, scope, spaces]);

  const now = new Date();
  const days = Array.from({ length: 7 }, (_, i) => new Date(startOfDay(now).getTime() + i * DAY));
  const dueOf = (d: { p: Post; t: Target | null }) => (d.t ? d.t.due_at ?? null : d.p.due_at);
  const statusOf = (d: { p: Post; t: Target | null }) => d.t?.status ?? d.p.status;
  const week0 = startOfWeek(now).getTime();
  const shipped = drops.filter((d) => { const at = d.t ? shippedAt(d.t, d.p) : d.p.status === "posted" ? d.p.posted_at ?? d.p.$updatedAt : null; return at && Date.parse(at) >= week0; }).length;
  const goal = (spaces ?? SPACES.map((s) => s.id)).reduce((n, s) => n + (goals[s] ?? 0), 0);
  const streak = useMemo(() => {
    const weeks = new Set<number>();
    for (const d of drops) {
      const at = d.t ? shippedAt(d.t, d.p) : d.p.status === "posted" ? d.p.posted_at ?? d.p.$updatedAt : null;
      if (at) weeks.add(startOfWeek(new Date(at)).getTime());
    }
    let n = 0, w = weeks.has(week0) ? week0 : week0 - 7 * DAY;
    while (weeks.has(w)) { n++; w -= 7 * DAY; }
    return n;
  }, [drops, week0]);
  const upcoming = drops.filter((d) => statusOf(d) !== "posted" && dueOf(d)).sort((a, b) => Date.parse(dueOf(a)!) - Date.parse(dueOf(b)!));
  const overdue = upcoming.filter((d) => Date.parse(dueOf(d)!) < Date.now());
  const next = upcoming.find((d) => Date.parse(dueOf(d)!) >= Date.now());
  const thisWeek = upcoming.filter((d) => Date.parse(dueOf(d)!) >= startOfDay(now).getTime() && Date.parse(dueOf(d)!) < startOfDay(now).getTime() + 7 * DAY);
  const emptyDays = days.filter((day) => !thisWeek.some((d) => sameDay(new Date(dueOf(d)!), day))).length;

  const headline = loading ? "Loading your plan…"
    : overdue.length ? `${overdue.length} ${overdue.length === 1 ? "drop is" : "drops are"} past due.`
    : thisWeek.length === 0 ? "Nothing's going out this week. Yet."
    : `${thisWeek.length} ${thisWeek.length === 1 ? "drop" : "drops"} this week.`;
  const sub = loading ? "" : overdue.length ? "Post them, push them to a new day, or let them go."
    : thisWeek.length === 0 ? "Pick a day below and give it something."
    : next ? `Next up: “${next.p.title}” ${inHuman(dueOf(next)!)}.${emptyDays ? ` ${emptyDays} open ${emptyDays === 1 ? "day" : "days"} ahead.` : " Every day is covered."}` : "";

  async function setStatus(e: { p: Post; t: Target | null }, status: Status) {
    try {
      const all = targetsOf(e.p, map);
      if (e.t) await saveTargets(e.p.$id, all.map((t) => (t.space === e.t!.space ? { ...t, status } : t)));
      else if (all.length) await saveTargets(e.p.$id, all.map((t) => ({ ...t, status })));
      else await savePost(e.p, { status });
    } catch (x) { toast((x as Error).message, "bad"); }
  }
  async function setDue(e: { p: Post; t: Target | null }, iso: string | null) {
    try {
      if (e.t) await saveTargets(e.p.$id, targetsOf(e.p, map).map((t) => (t.space === e.t!.space ? { ...t, due_at: iso } : t)));
      else await savePost(e.p, { due_at: iso });
    } catch (x) { toast((x as Error).message, "bad"); }
  }
  /** A drop dragged onto a day: same time of day, new date (6 pm when it had none). */
  async function moveTo(postId: string, spaceId: string | null, day: Date) {
    const p = posts.find((x) => x.$id === postId);
    if (!p) return;
    const t = spaceId ? targetsOf(p, map).find((x) => x.space === spaceId) ?? null : null;
    const old = dueOf({ p, t });
    const at = new Date(day);
    if (old) { const o = new Date(old); at.setHours(o.getHours(), o.getMinutes()); } else at.setHours(18, 0);
    await setDue({ p, t }, at.toISOString());
  }
  async function remove(p: Post) {
    if (!(await confirm({ title: "Delete this post?", body: <>“{p.title}” goes from every platform. Media files stay in the Media library.</>, confirm: "Delete", danger: true }))) return;
    try {
      await aw().tables.deleteRow({ databaseId: AW.db, tableId: "posts", rowId: p.$id });
      forgetTargets(p.$id);
      logActivity(null, "deleted", p.title);
    } catch (x) { toast((x as Error).message, "bad"); }
  }
  async function newPost(sp: SpaceId | null, opts: { status?: Status; due?: Date } = {}) {
    setMenu(false);
    try {
      const s = sp ? spaceOf(sp) : null;
      const due = opts.due ? new Date(new Date(opts.due).setHours(18, 0, 0, 0)).toISOString() : null;
      const status = opts.status ?? (due ? "draft" : "idea");
      const p = await createPost({ title: "Untitled", status, platforms: s ? [s.legacy] : [], due_at: s ? null : due });
      if (s) await saveTargets(p.$id, [{ space: s.id, status, due_at: due, link: null }]);
      go({ post: p.$id });
    } catch (x) { toast((x as Error).message, "bad"); }
  }
  const quickSpace = (space?.id ?? (net ? net.spaces[0].id : null)) as SpaceId | null;

  const groups: [string, string, Entry[]][] = useMemo(() => {
    const st = (e: Entry) => e.t?.status ?? e.p.status;
    const due = (e: Entry) => (e.t ? e.t.due_at ?? null : e.p.due_at);
    const byDue = (a: Entry, b: Entry) => (due(a) && due(b) ? Date.parse(due(a)!) - Date.parse(due(b)!) : due(a) ? -1 : due(b) ? 1 : 0);
    return [
      ["next", "Up next", entries.filter((e) => st(e) !== "posted" && (due(e) || st(e) === "scheduled")).sort(byDue)],
      ["works", "In the works", entries.filter((e) => (st(e) === "draft" || st(e) === "review") && !due(e))],
      ["ideas", "Ideas", entries.filter((e) => st(e) === "idea" && !due(e))],
      ["shipped", "Shipped", entries.filter((e) => st(e) === "posted").sort((a, b) => Date.parse(b.p.posted_at ?? b.p.$updatedAt) - Date.parse(a.p.posted_at ?? a.p.$updatedAt))],
    ];
  }, [entries]);

  const openPost = posts.find((p) => p.$id === open);
  const countFor = (ids: SpaceId[]) => posts.reduce((n, p) => n + (targetsOf(p, map).some((t) => ids.includes(t.space) && t.status !== "posted") ? 1 : 0), 0);
  const ideasCount = posts.filter((p) => !targetsOf(p, map).length && p.status !== "posted").length;

  const formatTabs = net ? [{ id: net.id, label: `All`, n: countFor(net.spaces.map((x) => x.id)) }, ...net.spaces.map((x) => ({ id: x.id as string, label: x.label, n: countFor([x.id]), sp: x.id }))] : [];

  return (
    <div className="cp">
      <header className="cp-head">
        <div style={{ minWidth: 0 }}>
          <h1>{headline}</h1>
          {sub && <p className="sub">{sub}</p>}
        </div>
        <div className="row" style={{ gap: 8, position: "relative" }}>
          <div className="seg view-seg">
            <button className={view === "gallery" ? "on" : ""} onClick={() => setView("gallery")} title="Cards"><SquaresFour size={15} /></button>
            <button className={view === "pipeline" ? "on" : ""} onClick={() => setView("pipeline")} title="Pipeline"><Kanban size={15} /></button>
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")} title="List"><ListBullets size={15} /></button>
          </div>
          <button onClick={() => (space ? newPost(space.id) : setMenu(!menu))}>
            <Plus size={15} weight="bold" />New{space ? ` ${space.label.replace(/s$/, "").toLowerCase()}` : ""}
          </button>
          {menu && <NewMenu scope={scope} onPick={(x) => newPost(x)} onClose={() => setMenu(false)} />}
        </div>
      </header>

      <nav className="pf-row" aria-label="Platforms">
        <button className={`pf ${!scope ? "on" : ""}`} onClick={() => go({ space: "", post: null })}>All</button>
        {NETWORKS.map((n) => {
          const c = countFor(n.spaces.map((x) => x.id));
          const N = NET[n.id].Icon;
          return (
            <button key={n.id} className={`pf ${net?.id === n.id ? "on" : ""}`} onClick={() => go({ space: n.id, post: null })} title={n.label}>
              <N size={16} weight={net?.id === n.id ? "fill" : "regular"} /><span className="pf-l">{n.label}</span>{c > 0 && <span className="pf-n">{c}</span>}
            </button>
          );
        })}
        <button className={`pf ${scope === IDEAS ? "on" : ""}`} onClick={() => go({ space: IDEAS, post: null })}><Lightbulb size={16} weight={scope === IDEAS ? "fill" : "regular"} /><span className="pf-l">Ideas</span>{ideasCount > 0 && <span className="pf-n">{ideasCount}</span>}</button>
      </nav>

      {net && (
        <div className="fmt-row">
          {formatTabs.map((f) => (
            <button key={f.id} className={`fmt-t ${scope === f.id ? "on" : ""}`} onClick={() => go({ space: f.id, post: null })}>
              {"sp" in f && f.sp && <ShapeGlyph space={f.sp} size={13} />}{f.label}{f.n > 0 && <span className="faint">{f.n}</span>}
            </button>
          ))}
        </div>
      )}

      {scope !== IDEAS && (
        <>
          <div className="stats">
            <span><b>{shipped}{goal ? `/${goal}` : ""}</b> shipped this week</span>
            <span className={streak ? "hot" : ""}><Flame size={13} weight={streak ? "fill" : "regular"} />{streak ? `${streak}-week streak` : "no streak yet"}</span>
            {space && (
              <span className="goal">
                weekly goal
                <button className="icon-btn xs" onClick={() => saveGoals({ ...goals, [space.id]: Math.max(0, (goals[space.id] ?? 0) - 1) }).catch(() => {})} aria-label="Lower the goal"><Minus size={10} /></button>
                <b>{goals[space.id] ?? 0}</b>
                <button className="icon-btn xs" onClick={() => saveGoals({ ...goals, [space.id]: (goals[space.id] ?? 0) + 1 }).catch(() => {})} aria-label="Raise the goal"><Plus size={10} /></button>
              </span>
            )}
          </div>
          <section className="wk" aria-label="Next seven days">
            {days.map((day, i) => {
              const items = thisWeek.filter((d) => sameDay(new Date(dueOf(d)!), day));
              return (
                <div key={i} className={`wk-day ${i === 0 ? "today" : ""} ${overDay === i ? "over" : ""}`}
                  onDragOver={(x) => { x.preventDefault(); setOverDay(i); }} onDragLeave={() => setOverDay((o) => (o === i ? null : o))}
                  onDrop={(x) => { x.preventDefault(); setOverDay(null); const id = x.dataTransfer.getData("text/post"); if (id) moveTo(id, x.dataTransfer.getData("text/space") || null, day); }}>
                  <div className="wk-h"><span>{i === 0 ? "Today" : day.toLocaleDateString(undefined, { weekday: "short" })}</span><b>{day.getDate()}</b></div>
                  {items.map((d) => (
                    <button key={`${d.p.$id}-${d.t?.space ?? "p"}`} className="wk-item" draggable onClick={() => go({ post: d.p.$id })}
                      onDragStart={(x) => { x.dataTransfer.setData("text/post", d.p.$id); if (d.t) x.dataTransfer.setData("text/space", d.t.space); }}
                      title={`${d.p.title}${d.t ? ` · ${spaceName(d.t.space)}` : ""}`}>
                      {d.t ? <PlatformBadge space={d.t.space} size={16} /> : <Lightbulb size={13} />}
                      <span>{d.p.title}</span>
                    </button>
                  ))}
                  <button className="wk-add" onClick={() => newPost(quickSpace, { due: day })} aria-label="Plan something for this day"><Plus size={12} /></button>
                </div>
              );
            })}
          </section>
        </>
      )}

      <div className="cp-tools">
        <div className="seg">
          <button className={who === "all" ? "on" : ""} onClick={() => setWho("all")}>Everyone</button>
          <button className={who === "mine" ? "on" : ""} onClick={() => setWho("mine")}>Mine</button>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
      </div>
      {error && <p className="err">{error}</p>}

      {view === "gallery" ? (
        <div className="stack" style={{ gap: 30 }}>
          {!loading && !entries.length && (
            <div className="cp-empty">
              {net ? <PlatformBadge net={net.id} size={40} /> : <Lightbulb size={30} />}
              <b>{space ? `No ${space.label.toLowerCase()} yet` : net ? `Nothing for ${net.label} yet` : scope === IDEAS ? "No ideas yet" : "A blank slate"}</b>
              <span className="dim small">Start with a title. The script, caption and voice come later.</span>
              <button onClick={() => (space ? newPost(space.id) : setMenu(true))}><Plus size={14} weight="bold" />New</button>
            </div>
          )}
          {groups.map(([key, label, list]) => {
            if (!list.length) return null;
            const hidden = key === "shipped" && !showShipped;
            return (
              <section key={key}>
                <header className="sec-h">
                  <span>{label}</span><span className="faint">{list.length}</span>
                  {key === "shipped" && <button className="quiet xs" onClick={() => setShowShipped(!showShipped)}>{showShipped ? "Hide" : "Show"}</button>}
                </header>
                {!hidden && <div className="pgrid">{list.map((e) => <Card key={e.p.$id} e={e} cover={covers(e.p)} onOpen={() => go({ post: e.p.$id })} onDelete={() => remove(e.p)} />)}</div>}
              </section>
            );
          })}
        </div>
      ) : view === "pipeline" ? (
        <div className="board">
          {STATUSES.map((st) => {
            const col = entries.filter((e) => (e.t?.status ?? e.p.status) === st.id);
            return (
              <section key={st.id} className="col" onDragOver={(x) => x.preventDefault()}
                onDrop={(x) => { x.preventDefault(); const id = x.dataTransfer.getData("text/post"); const e = entries.find((y) => y.p.$id === id); if (e && (e.t?.status ?? e.p.status) !== st.id) setStatus(e, st.id); }}>
                <header className="col-head"><span className={`col-dot s-${st.id}`} /><b>{st.label}</b><span className="faint mono tiny">{col.length}</span></header>
                <div className="col-body">
                  {col.map((e) => {
                    const due = e.t ? e.t.due_at ?? null : e.p.due_at;
                    return (
                      <div key={e.p.$id} className="post-card" draggable onDragStart={(x) => x.dataTransfer.setData("text/post", e.p.$id)} onClick={() => go({ post: e.p.$id })} role="button" tabIndex={0}>
                        <div className="pc-title">{e.p.title}</div>
                        <div className="pc-foot">
                          <span className="row" style={{ gap: 4 }}>{e.all.map((t) => <PlatformBadge key={t.space} space={t.space} size={16} />)}</span>
                          {due ? <span className="pc-due">{dueLabel(due)}</span> : null}
                          <span style={{ marginLeft: "auto" }}>{(e.p.assignee_name || e.p.owner_name) && <Avatar id={e.p.assignee_id ?? e.p.owner_id} name={e.p.assignee_name ?? e.p.owner_name} sm />}</span>
                        </div>
                      </div>
                    );
                  })}
                  <button className="col-add" onClick={() => newPost(quickSpace, { status: st.id })}><Plus size={14} /> Add</button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="card flush">
          {entries.length > 0 ? (
            <table className="table content-table">
              <thead><tr><th>Title</th><th>Where</th><th>Stage</th><th>Publish</th><th>Owner</th><th /></tr></thead>
              <tbody>
                {entries.map((e) => {
                  const due = e.t ? e.t.due_at ?? null : e.p.due_at;
                  const local = due ? new Date(Date.parse(due) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";
                  return (
                    <tr key={e.p.$id} className={open === e.p.$id ? "on" : ""}>
                      <td><button className="linkish plain" onClick={() => go({ post: e.p.$id })}><b>{e.p.title}</b></button><div className="tiny faint">{timeAgo(e.p.$updatedAt)}</div></td>
                      <td><div className="row" style={{ gap: 4 }}>{e.all.map((t) => <PlatformBadge key={t.space} space={t.space} size={18} solid={t.status === "posted"} />)}{!e.all.length && <span className="tiny faint">idea</span>}</div></td>
                      <td><select value={e.t?.status ?? e.p.status} onChange={(x) => setStatus(e, x.target.value as Status)} style={{ width: "auto" }}>{STATUSES.map((st) => <option key={st.id} value={st.id}>{st.label}</option>)}</select></td>
                      <td><input type="datetime-local" value={local} style={{ width: "auto" }} onChange={(x) => setDue(e, x.target.value ? new Date(x.target.value).toISOString() : null)} /></td>
                      <td>{(e.p.assignee_name || e.p.owner_name) && <Avatar id={e.p.assignee_id ?? e.p.owner_id} name={e.p.assignee_name ?? e.p.owner_name} sm />}</td>
                      <td><button className="icon-btn danger-h" title="Delete post" onClick={() => remove(e.p)}><TrashSimple size={15} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="empty"><b>Nothing here yet</b></div>}
        </div>
      )}
      {open && openPost && <PostDrawer key={open} post={openPost} onClose={() => go({ post: null })} />}
    </div>
  );
}

export default function Content() {
  return <Gate><ContentInner /></Gate>;
}
