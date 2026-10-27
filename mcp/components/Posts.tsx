"use client";
// Posts: everything the two of you are making, in one place. Summary cards up top, then the same posts as a board
// (drag between stages), a calendar (drag onto a day), a list, or a gallery with the week ahead. Filter by platform
// or format; a post can go to many at once. Click any post for the full editor. Live: your partner's moves land here.
import {
  CalendarBlank, CaretLeft, CaretRight, ChatCircleDots, CheckCircle, Circle, CircleDashed, Clock, Eye, Flame, Kanban, Lightbulb, ListBullets,
  Lightning, MagnifyingGlass, Microphone, Minus, Paperclip, Plus, Pulse, SquaresFour, TrashSimple, WarningCircle, X,
} from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { NETWORKS, SHAPE, SPACES, spaceName, spaceOf, shippedAt, targetsOf, type SpaceId, type Target } from "@/lib/spaces";
import { AW, fileUrl, STATUSES, type Media, type Post, type Status } from "@/lib/workspace";
import { aw, logActivity, Query, timeAgo, useLive, useMe } from "./aw";
import { useDialog } from "./Dialog";
import { NET, PlatformBadge, ShapeGlyph } from "./platform";
import { createPost, dueLabel, Feed, PostDrawer, savePost } from "./PostDrawer";
import { forgetTargets, saveGoals, saveTargets, useTargets } from "./useTargets";
import { Avatar, Gate } from "./wsparts";
import { Empty, PageHeader, StatCard } from "./ui";
import { Select } from "./pop";
import { Autopilot } from "./Autopilot";
import { Composer } from "./Publish";

type View = "board" | "calendar" | "list" | "gallery" | "autopilot";
const VIEWS: { id: View; label: string; Icon: typeof Kanban }[] = [
  { id: "board", label: "Board", Icon: Kanban }, { id: "calendar", label: "Calendar", Icon: CalendarBlank },
  { id: "list", label: "List", Icon: ListBullets }, { id: "gallery", label: "Gallery", Icon: SquaresFour },
  { id: "autopilot", label: "Autopilot", Icon: Lightning },
];
type Entry = { p: Post; t: Target | null; all: Target[] }; // one post as seen from the current scope
const IDEAS = "none";
const DAY = 864e5;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STAGE_ICON: Record<Status, typeof Circle> = { idea: Lightbulb, draft: CircleDashed, review: Eye, scheduled: Clock, posted: CheckCircle };
const STAGE_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label])) as Record<Status, string>;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d: Date) => { const x = startOfDay(d); return new Date(x.getTime() - ((x.getDay() + 6) % 7) * DAY); }; // Monday
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

const stOf = (e: { p: Post; t: Target | null }) => e.t?.status ?? e.p.status;
const dueOf = (e: { p: Post; t: Target | null }) => (e.t ? e.t.due_at ?? null : e.p.due_at);
const isLate = (e: { p: Post; t: Target | null }) => { const d = dueOf(e); return !!d && stOf(e) !== "posted" && Date.parse(d) < Date.now(); };

function Where({ e }: { e: Entry }) {
  const formats = [...new Set(e.all.map((t) => spaceOf(t.space)?.label).filter(Boolean))];
  return (
    <span className="tc-where">
      {e.all.length ? e.all.slice(0, 3).map((t) => <PlatformBadge key={t.space} space={t.space} size={18} solid={t.status === "posted"} />) : <Lightbulb size={15} />}
      <span className="ellipsis">{formats.length ? formats.join(" · ") : "Idea"}</span>
    </span>
  );
}

/** A post on the board: where it goes, a flag when it's late, the title, its first words, the due date, who and what. */
function BoardCard({ e, media, onOpen, onDelete, cover }: { e: Entry; media: number; onOpen: () => void; onDelete: () => void; cover?: string | null }) {
  const [dragging, setDragging] = useState(false);
  const due = dueOf(e);
  const late = isLate(e);
  const words = (e.p.script || e.p.caption || e.p.notes || "").trim().split("\n")[0];
  return (
    <article className={`tcard ${dragging ? "dragging" : ""}`} draggable onClick={onOpen}
      onDragStart={(d) => { setDragging(true); d.dataTransfer.setData("text/post", e.p.$id); if (e.t) d.dataTransfer.setData("text/space", e.t.space); d.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => setDragging(false)}>
      {cover && <div className="tc-cover"><img src={cover} alt="" loading="lazy" /></div>}
      <div className="tc-top">
        <Where e={e} />
        {late && <span className="flag bad"><WarningCircle size={12} weight="bold" />Overdue</span>}
        {!late && stOf(e) === "review" && <span className="flag violet">Needs review</span>}
      </div>
      <div>
        <button className="tc-title tc-open" onClick={(x) => { x.stopPropagation(); onOpen(); }} aria-label={`${e.p.title}, ${STAGE_LABEL[stOf(e)]}${late ? ", overdue" : ""}`}>{e.p.title}</button>
        {words && <div className="tc-sub" style={{ marginTop: 2 }}>{words}</div>}
      </div>
      {due && stOf(e) !== "posted" && <span className={`tc-due ${late ? "late" : ""}`}><CalendarBlank size={13} />Due: <b>{dueLabel(due)}</b></span>}
      <div className="tc-foot">
        {(e.p.assignee_name || e.p.owner_name) ? <span className="avatars"><Avatar id={e.p.assignee_id ?? e.p.owner_id} name={e.p.assignee_name ?? e.p.owner_name} sm /></span> : <span className="tiny">Unassigned</span>}
        {e.p.jobs?.length > 0 && <span className="tc-stat" title={`${e.p.jobs.length} voiceover${e.p.jobs.length > 1 ? "s" : ""}`}><Microphone size={14} />{e.p.jobs.length}</span>}
        {media > 0 && <span className="tc-stat" title={`${media} file${media > 1 ? "s" : ""}`}><Paperclip size={14} />{media}</span>}
        <span className="tc-date">{shortDate(e.p.$updatedAt)}</span>
      </div>
      <button className="icon-btn sm tc-del danger-h" aria-label={`Delete ${e.p.title}`} onClick={(x) => { x.stopPropagation(); onDelete(); }}><TrashSimple size={14} /></button>
    </article>
  );
}

function NewMenu({ scope, onPick, onClose }: { scope: string; onPick: (space: SpaceId | null) => void; onClose: () => void }) {
  const nets = scopeSpaces(scope)?.length ? NETWORKS.filter((n) => n.id === spaceOf(scopeSpaces(scope)![0])?.network) : NETWORKS;
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return (
    <>
      <div className="pop-scrim" onClick={onClose} />
      <div className="new-menu" role="menu" aria-label="New post for">
        {nets.map((n) => (
          <div key={n.id} className="nm-net">
            <PlatformBadge net={n.id} size={22} />
            <div className="nm-formats">{n.spaces.map((s) => <button key={s.id} role="menuitem" className="nm-f" onClick={() => onPick(s.id)}><ShapeGlyph space={s.id} />{s.label}</button>)}</div>
          </div>
        ))}
        <button className="nm-f idea" role="menuitem" onClick={() => onPick(null)}><Lightbulb size={14} weight="fill" />Just an idea</button>
      </div>
    </>
  );
}

function PostsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe();
  const { confirm, toast } = useDialog();
  const { rows: posts, setRows, loading, error } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(500)]);
  const { rows: media } = useLive<Media>("media", [Query.orderDesc("$createdAt"), Query.limit(500)]);
  const { map, goals } = useTargets();
  const scope = params.get("space") ?? "";
  const open = params.get("post");
  const [view, setView] = useState<View>("board");
  const [q, setQ] = useState("");
  const [who, setWho] = useState<"all" | "mine">("all");
  const [menu, setMenu] = useState(false);
  const [feed, setFeed] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ post: Post; space: SpaceId } | null>(null);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  useEffect(() => {
    const v = params.get("view") as View | null;
    if (v && VIEWS.some((x) => x.id === v)) setView(v);
    else try { const s = localStorage.getItem("vb-posts-view") as View | null; if (s && VIEWS.some((x) => x.id === s)) setView(s); } catch {}
    if (params.get("new")) setMenu(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem("vb-posts-view", v); } catch {} };

  const go = (next: { space?: string; post?: string | null }) => {
    const u = new URLSearchParams();
    const sp = next.space ?? scope;
    if (sp) u.set("space", sp);
    const po = next.post === undefined ? open : next.post;
    if (po) u.set("post", po);
    router.push(`/posts${u.size ? `?${u}` : ""}`, { scroll: false });
  };

  const spaces = scopeSpaces(scope);
  const net = NETWORKS.find((n) => n.id === scope || n.spaces.some((s) => s.id === scope));
  const space = spaceOf(scope);

  const covers = useMemo(() => {
    const byId = new Map(media.map((m) => [m.$id, m]));
    const first = new Map<string, Media>();
    for (const m of media) if (m.post_id && m.kind === "image" && m.token && !first.has(m.post_id)) first.set(m.post_id, m);
    return (p: Post) => { const m = (p.cover && byId.get(p.cover)) || first.get(p.$id); return m?.token ? fileUrl(m, "preview", 520) : null; };
  }, [media]);
  const mediaCount = useMemo(() => { const c = new Map<string, number>(); for (const m of media) if (m.post_id) c.set(m.post_id, (c.get(m.post_id) ?? 0) + 1); return c; }, [media]);

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

  // (post, target) pairs in scope: what the calendar, the week and the counts use
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
  const upcoming = drops.filter((d) => stOf(d) !== "posted" && dueOf(d)).sort((a, b) => Date.parse(dueOf(a)!) - Date.parse(dueOf(b)!));
  const overdue = upcoming.filter((d) => Date.parse(dueOf(d)!) < Date.now());
  const next = upcoming.find((d) => Date.parse(dueOf(d)!) >= Date.now());
  const days = Array.from({ length: 7 }, (_, i) => new Date(startOfDay(now).getTime() + i * DAY));
  const thisWeek = upcoming.filter((d) => Date.parse(dueOf(d)!) >= startOfDay(now).getTime() && Date.parse(dueOf(d)!) < startOfDay(now).getTime() + 7 * DAY);
  const inProgress = drops.filter((d) => stOf(d) === "draft" || stOf(d) === "review").length;
  const sub = loading ? "Loading your plan…"
    : overdue.length ? `${overdue.length} ${overdue.length === 1 ? "post is" : "posts are"} past due. Post them, move them, or let them go.`
    : next ? `Next up: “${next.p.title}” ${inHuman(dueOf(next)!)}.`
    : "Nothing scheduled yet. Give a post a date and it shows up on the calendar.";

  async function setStatus(e: { p: Post; t: Target | null }, status: Status) {
    const all = targetsOf(e.p, map);
    setRows((cur) => cur.map((x) => (x.$id === e.p.$id && !all.length ? { ...x, status } : x))); // optimistic; realtime confirms
    try {
      if (e.t) await saveTargets(e.p.$id, all.map((t) => (t.space === e.t!.space ? { ...t, status } : t)));
      else if (all.length) await saveTargets(e.p.$id, all.map((t) => ({ ...t, status })));
      else await savePost(e.p, { status });
    } catch (x) { toast((x as Error).message, "bad"); }
  }
  async function setDue(e: { p: Post; t: Target | null }, iso: string | null) {
    try {
      if (e.t) await saveTargets(e.p.$id, targetsOf(e.p, map).map((t) => (t.space === e.t!.space ? { ...t, due_at: iso } : t)));
      else await savePost(e.p, { due_at: iso, ...(e.p.status === "idea" && iso ? { status: "scheduled" as Status } : {}) });
    } catch (x) { toast((x as Error).message, "bad"); }
  }
  /** A post dragged onto a day: same time of day, new date (6 pm when it had none). */
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
    if (!(await confirm({ title: "Delete this post?", body: <>“{p.title}” is removed from every platform. Its files stay in Files.</>, confirm: "Delete", danger: true }))) return;
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
  const countFor = (ids: SpaceId[]) => posts.reduce((n, p) => n + (targetsOf(p, map).some((t) => ids.includes(t.space) && t.status !== "posted") ? 1 : 0), 0);
  const ideasCount = posts.filter((p) => !targetsOf(p, map).length && p.status !== "posted").length;
  const openPost = posts.find((p) => p.$id === open);
  const drop = (ev: React.DragEvent) => ({ id: ev.dataTransfer.getData("text/post"), sp: ev.dataTransfer.getData("text/space") || null });

  // calendar month
  const monthDays = useMemo(() => {
    const lead = (month.getDay() + 6) % 7;
    const start = new Date(month.getFullYear(), month.getMonth(), 1 - lead);
    const n = Math.ceil((lead + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7;
    return Array.from({ length: n }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);
  const byDay = useMemo(() => {
    const m = new Map<string, { p: Post; t: Target | null }[]>();
    for (const d of drops) { const due = dueOf(d); if (due) { const k = dayKey(new Date(due)); m.set(k, [...(m.get(k) ?? []), d]); } }
    for (const v of m.values()) v.sort((a, b) => Date.parse(dueOf(a)!) - Date.parse(dueOf(b)!));
    return m;
  }, [drops]);
  const unscheduled = drops.filter((d) => !dueOf(d) && stOf(d) !== "posted");
  const chip = (d: { p: Post; t: Target | null }) => (
    <button key={`${d.p.$id}-${d.t?.space ?? "p"}`} className={`cal-chip s-${stOf(d)}`} draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/post", d.p.$id); if (d.t) e.dataTransfer.setData("text/space", d.t.space); }}
      onClick={() => go({ post: d.p.$id })} title={`${d.p.title}${d.t ? ` · ${spaceName(d.t.space)}` : ""} · ${STAGE_LABEL[stOf(d)]}`}>
      {d.t ? <PlatformBadge space={d.t.space} size={14} /> : null}
      {dueOf(d) && <span className="mono">{new Date(dueOf(d)!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(":00", "")}</span>}
      <span className="cc-t">{d.p.title}</span>
    </button>
  );

  return (
    <>
      <PageHeader title="Posts" sub={sub} actions={
        <>
          <button className="ghost" onClick={() => setFeed(true)}><Pulse size={15} weight="bold" />Activity</button>
          <span style={{ position: "relative", display: "inline-flex" }}>
            <button onClick={() => (space ? newPost(space.id) : setMenu(!menu))} aria-expanded={menu} aria-haspopup="menu">
              <Plus size={15} weight="bold" />New{space ? ` ${space.label.replace(/s$/, "").toLowerCase()}` : " post"}
            </button>
            {menu && <NewMenu scope={scope} onPick={(x) => newPost(x)} onClose={() => setMenu(false)} />}
          </span>
        </>
      } />

      <div className="stats-row">
        <StatCard icon={<CalendarBlank size={17} weight="bold" />} value={thisWeek.length} label="Due this week" onClick={() => pickView("calendar")} linkLabel="Calendar" />
        <StatCard icon={<WarningCircle size={17} weight="bold" />} value={overdue.length} label="Overdue" onClick={() => pickView("board")} linkLabel="Board" />
        <StatCard icon={<Kanban size={17} weight="bold" />} value={inProgress} label="In production or review" onClick={() => pickView("board")} linkLabel="Board" />
        <StatCard icon={<Flame size={17} weight="bold" />} value={<>{shipped}{goal ? <small>/ {goal}</small> : null}</>} label={streak ? `Shipped this week · ${streak}-week streak` : "Shipped this week"}>
          {goal > 0 && <div className="meter-line"><i style={{ width: `${Math.min(100, (shipped / goal) * 100)}%` }} /></div>}
        </StatCard>
      </div>

      <nav className="space-row" aria-label="Platforms">
        <button className={`space-chip ${!scope ? "on" : ""}`} aria-pressed={!scope} onClick={() => go({ space: "", post: null })}>All posts</button>
        {NETWORKS.map((n) => {
          const c = countFor(n.spaces.map((x) => x.id));
          const N = NET[n.id].Icon;
          return (
            <button key={n.id} className={`space-chip ${net?.id === n.id ? "on" : ""}`} aria-pressed={net?.id === n.id} onClick={() => go({ space: n.id, post: null })}>
              <N size={15} weight={net?.id === n.id ? "fill" : "regular"} />{n.label}{c > 0 && <span className="n">{c}</span>}
            </button>
          );
        })}
        <button className={`space-chip ${scope === IDEAS ? "on" : ""}`} aria-pressed={scope === IDEAS} onClick={() => go({ space: IDEAS, post: null })}><Lightbulb size={15} />Ideas{ideasCount > 0 && <span className="n">{ideasCount}</span>}</button>
      </nav>
      {net && (
        <div className="tabs" style={{ marginTop: -6 }}>
          {[{ id: net.id as string, label: `All ${net.label}`, sp: null as SpaceId | null }, ...net.spaces.map((x) => ({ id: x.id as string, label: x.label, sp: x.id }))].map((f) => (
            <button key={f.id} className={scope === f.id ? "on" : ""} onClick={() => go({ space: f.id, post: null })}>
              {f.sp && <ShapeGlyph space={f.sp} size={13} />} {f.label}<span className="count">{countFor(f.sp ? [f.sp] : net.spaces.map((x) => x.id))}</span>
            </button>
          ))}
        </div>
      )}

      <div className="posts-bar">
        <div className="view-tabs" role="tablist" aria-label="View">
          {VIEWS.map((v) => <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "on" : ""} onClick={() => pickView(v.id)}><v.Icon size={16} />{v.label}</button>)}
        </div>
        <div className="tool-row">
          {space && (
            <span className="goal small dim">Weekly goal
              <button className="icon-btn xs boxed" onClick={() => saveGoals({ ...goals, [space.id]: Math.max(0, (goals[space.id] ?? 0) - 1) }).catch(() => {})} aria-label="Lower the weekly goal"><Minus size={11} /></button>
              <b style={{ color: "var(--ink)" }}>{goals[space.id] ?? 0}</b>
              <button className="icon-btn xs boxed" onClick={() => saveGoals({ ...goals, [space.id]: (goals[space.id] ?? 0) + 1 }).catch(() => {})} aria-label="Raise the weekly goal"><Plus size={11} /></button>
            </span>
          )}
          <div className="seg">
            <button className={who === "all" ? "on" : ""} onClick={() => setWho("all")}>Everyone</button>
            <button className={who === "mine" ? "on" : ""} onClick={() => setWho("mine")}>Mine</button>
          </div>
          <div className="searchbox"><MagnifyingGlass size={15} className="ic" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search posts" aria-label="Search posts" /></div>
        </div>
      </div>
      {error && <p className="err" role="alert">{error}</p>}

      {view === "board" && (
        <div className="board">
          {STATUSES.map((st) => {
            const col = entries.filter((e) => stOf(e) === st.id).sort((a, b) => (dueOf(a) && dueOf(b) ? Date.parse(dueOf(a)!) - Date.parse(dueOf(b)!) : dueOf(a) ? -1 : dueOf(b) ? 1 : 0));
            const Ic = STAGE_ICON[st.id];
            return (
              <section key={st.id} className={`col ${over === st.id ? "over" : ""}`} aria-label={st.label}
                onDragOver={(x) => { x.preventDefault(); setOver(st.id); }} onDragLeave={() => setOver((o) => (o === st.id ? null : o))}
                onDrop={(x) => { x.preventDefault(); setOver(null); const { id } = drop(x); const e = entries.find((y) => y.p.$id === id); if (e && stOf(e) !== st.id) setStatus(e, st.id); }}>
                <header className="col-head">
                  <span className={`stage-pill s-${st.id}`}><Ic size={15} weight="bold" />{st.label}<span className="cnt">{col.length}</span></span>
                  <button className="icon-btn sm" aria-label={`New post in ${st.label}`} onClick={() => newPost(quickSpace, { status: st.id })}><Plus size={15} /></button>
                </header>
                <div className="col-body">
                  {col.map((e) => <BoardCard key={e.p.$id} e={e} media={mediaCount.get(e.p.$id) ?? 0} onOpen={() => go({ post: e.p.$id })} onDelete={() => remove(e.p)} />)}
                  <button className="col-add" onClick={() => newPost(quickSpace, { status: st.id })}><Plus size={15} />New post</button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {view === "calendar" && (
        <div className="cal-wrap">
          <div>
            <div className="cal-head">
              <button className="icon-btn boxed" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><CaretLeft size={16} /></button>
              <button className="icon-btn boxed" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><CaretRight size={16} /></button>
              <b>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b>
              <button className="ghost sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
            </div>
            <div className="cal">
              {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
              {monthDays.map((d) => {
                const k = dayKey(d);
                const list = byDay.get(k) ?? [];
                return (
                  <div key={k} className={`cal-day ${d.getMonth() !== month.getMonth() ? "out" : ""} ${k === dayKey(now) ? "today" : ""} ${over === k ? "over" : ""}`}
                    onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver((o) => (o === k ? null : o))}
                    onDrop={(e) => { e.preventDefault(); setOver(null); const { id, sp } = drop(e); if (id) moveTo(id, sp, d); }}
                    onDoubleClick={() => newPost(quickSpace, { due: d })}>
                    <span className="cal-n">{d.getDate()}</span>
                    <div className="cal-list">{list.slice(0, 4).map(chip)}{list.length > 4 && <span className="tiny faint">+{list.length - 4} more</span>}</div>
                  </div>
                );
              })}
            </div>
            <p className="tiny faint" style={{ marginTop: 10 }}>Drag a post onto a day to schedule it. Double-click a day to start a post on it.</p>
          </div>
          <aside className="cal-side" aria-label="Not scheduled">
            <div className="row between" style={{ marginBottom: 10 }}><h2>Not scheduled</h2><span className="pill">{unscheduled.length}</span></div>
            <div className="stack" style={{ gap: 6 }}>
              {unscheduled.map(chip)}
              {!unscheduled.length && <p className="small faint" style={{ margin: 0 }}>Everything has a date.</p>}
            </div>
            <button className="ghost sm block" style={{ marginTop: 12 }} onClick={() => newPost(quickSpace)}><Plus size={14} />New post</button>
          </aside>
        </div>
      )}

      {view === "list" && (entries.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Title</th><th>Where</th><th>Stage</th><th>Publish</th><th>Owner</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {entries.map((e) => {
                const due = dueOf(e);
                const local = due ? new Date(Date.parse(due) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";
                return (
                  <tr key={e.p.$id} className={open === e.p.$id ? "on" : ""}>
                    <td><button className="linkish" onClick={() => go({ post: e.p.$id })}><b style={{ fontWeight: 600 }}>{e.p.title}</b></button><div className="tiny faint">Edited {timeAgo(e.p.$updatedAt)}</div></td>
                    <td><div className="row" style={{ gap: 4 }}>{e.all.map((t) => <PlatformBadge key={t.space} space={t.space} size={18} solid={t.status === "posted"} />)}{!e.all.length && <span className="tiny faint">Idea</span>}</div></td>
                    <td><Select size="sm" label={`Stage of ${e.p.title}`} value={stOf(e)} onChange={(v) => setStatus(e, v as Status)} options={STATUSES.map((st) => [st.id, st.label] as const)} /></td>
                    <td><input type="datetime-local" aria-label={`Publish time of ${e.p.title}`} value={local} onChange={(x) => setDue(e, x.target.value ? new Date(x.target.value).toISOString() : null)} /></td>
                    <td>{(e.p.assignee_name || e.p.owner_name) && <Avatar id={e.p.assignee_id ?? e.p.owner_id} name={e.p.assignee_name ?? e.p.owner_name} sm />}</td>
                    <td><button className="icon-btn sm danger-h" aria-label={`Delete ${e.p.title}`} onClick={() => remove(e.p)}><TrashSimple size={15} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : !loading && <Empty icon={<ListBullets size={22} />} title="Nothing here yet" action={<button className="sm" onClick={() => setMenu(true)}><Plus size={14} />New post</button>}>Start with a title. The script, caption and voice come later.</Empty>)}

      {view === "gallery" && (
        <>
          {scope !== IDEAS && (
            <section className="wk" aria-label="Next seven days">
              {days.map((day, i) => {
                const items = thisWeek.filter((d) => sameDay(new Date(dueOf(d)!), day));
                return (
                  <div key={i} className={`wk-day ${i === 0 ? "today" : ""} ${over === `w${i}` ? "over" : ""}`}
                    onDragOver={(x) => { x.preventDefault(); setOver(`w${i}`); }} onDragLeave={() => setOver((o) => (o === `w${i}` ? null : o))}
                    onDrop={(x) => { x.preventDefault(); setOver(null); const { id, sp } = drop(x); if (id) moveTo(id, sp, day); }}>
                    <div className="wk-h"><span>{i === 0 ? "Today" : day.toLocaleDateString(undefined, { weekday: "short" })}</span><b>{day.getDate()}</b></div>
                    {items.map((d) => (
                      <button key={`${d.p.$id}-${d.t?.space ?? "p"}`} className="wk-item" draggable onClick={() => go({ post: d.p.$id })}
                        onDragStart={(x) => { x.dataTransfer.setData("text/post", d.p.$id); if (d.t) x.dataTransfer.setData("text/space", d.t.space); }}
                        title={`${d.p.title}${d.t ? ` · ${spaceName(d.t.space)}` : ""}`}>
                        {d.t ? <PlatformBadge space={d.t.space} size={15} /> : <Lightbulb size={13} />}<span>{d.p.title}</span>
                      </button>
                    ))}
                    <button className="wk-add" onClick={() => newPost(quickSpace, { due: day })} aria-label={`Plan a post for ${day.toLocaleDateString(undefined, { weekday: "long" })}`}><Plus size={13} /></button>
                  </div>
                );
              })}
            </section>
          )}
          {!loading && !entries.length && (
            <Empty icon={net ? <PlatformBadge net={net.id} size={26} /> : <Lightbulb size={22} />} title={space ? `No ${space.label.toLowerCase()} yet` : net ? `Nothing for ${net.label} yet` : scope === IDEAS ? "No ideas yet" : "A blank slate"}
              action={<button className="sm" onClick={() => (space ? newPost(space.id) : setMenu(true))}><Plus size={14} weight="bold" />New post</button>}>Start with a title. The script, caption and voice come later.</Empty>
          )}
          <div className="stack" style={{ gap: 28 }}>
            {(["next", "works", "ideas", "shipped"] as const).map((key) => {
              const list = key === "next" ? entries.filter((e) => stOf(e) !== "posted" && (dueOf(e) || stOf(e) === "scheduled")).sort((a, b) => (dueOf(a) && dueOf(b) ? Date.parse(dueOf(a)!) - Date.parse(dueOf(b)!) : 0))
                : key === "works" ? entries.filter((e) => (stOf(e) === "draft" || stOf(e) === "review") && !dueOf(e))
                : key === "ideas" ? entries.filter((e) => stOf(e) === "idea" && !dueOf(e))
                : entries.filter((e) => stOf(e) === "posted");
              if (!list.length) return null;
              return (
                <section key={key}>
                  <h2 className="group-h">{{ next: "Up next", works: "In the works", ideas: "Ideas", shipped: "Shipped" }[key]}<span className="faint">{list.length}</span></h2>
                  <div className="pgrid">{list.map((e) => <BoardCard key={e.p.$id} e={e} media={mediaCount.get(e.p.$id) ?? 0} cover={covers(e.p)} onOpen={() => go({ post: e.p.$id })} onDelete={() => remove(e.p)} />)}</div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {feed && (
        <>
          <div className="scrim" onClick={() => setFeed(false)} />
          <aside className="drawer feed-drawer" aria-label="Activity" role="dialog">
            <div className="row between" style={{ marginBottom: 14 }}>
              <h2><ChatCircleDots size={17} /> Activity</h2>
              <button className="icon-btn" aria-label="Close activity" onClick={() => setFeed(false)}><X size={17} /></button>
            </div>
            <Feed />
          </aside>
        </>
      )}
      {view === "autopilot" && <Autopilot posts={posts} onCompose={(post, space) => setCompose({ post, space })} onOpen={(p) => go({ post: p.$id })} />}
      {compose && <Composer post={posts.find((p) => p.$id === compose.post.$id) ?? compose.post} space={compose.space} onClose={() => setCompose(null)} />}
      {open && (openPost ? <PostDrawer key={open} post={openPost} onClose={() => go({ post: null })} />
        : !loading && (<><div className="scrim" onClick={() => go({ post: null })} /><aside className="drawer"><p className="dim">This post was deleted.</p><button onClick={() => go({ post: null })}>Close</button></aside></>))}
    </>
  );
}

export default function Posts() {
  return <Gate title="Posts"><PostsInner /></Gate>;
}
