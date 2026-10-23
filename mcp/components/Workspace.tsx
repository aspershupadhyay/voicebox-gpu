"use client";
// The shared desk: every post the two of you are making, by stage. Drag a card to move it; click it for the full post.
// Everything here is live: when your partner moves a card, edits a script or comments, it changes on your screen too.
import { ArrowUpRight, CalendarBlank, ChatCircle, Pulse, Microphone, Paperclip, Plus, TrashSimple, UploadSimple, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AW, PLATFORMS, STATUSES, type Activity, type Comment, type Media, type Platform, type Post, type Status } from "@/lib/workspace";
import { api, fmtS } from "./api";
import { aw, getMe, ID, logActivity, Query, timeAgo, useLive, useMe, useMembers } from "./aw";
import { useDialog } from "./Dialog";
import Player from "./Player";
import { Avatar, deleteMedia, Gate, MediaTile, MediaViewer, UploadList, useUploader } from "./wsparts";
import { NETWORKS, spaceName, spaceOf, targetsOf, type Target } from "@/lib/spaces";
import { forgetTargets, saveTargets, useTargets } from "./useTargets";
import { PlatformBadge } from "./platform";

const T = { databaseId: AW.db, tableId: "posts" };
const LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.label])) as Record<Platform, string>;

export function dueLabel(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 864e5);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
const overdue = (p: Post) => !!p.due_at && p.status !== "posted" && Date.parse(p.due_at) < Date.now();

export async function createPost(data: Partial<Post>) {
  const me = await getMe();
  const row = await aw().tables.createRow<Post>({ ...T, rowId: ID.unique(), data: {
    title: "Untitled", status: "idea", platforms: [], jobs: [], ...data, owner_id: me.user?.id ?? null, owner_name: me.user?.name ?? null,
  } as Partial<Post> as Post });
  logActivity(row.$id, "created", row.title);
  return row;
}

export async function savePost(p: Post, data: Partial<Post>) {
  if (data.status === "posted" && p.status !== "posted" && !data.posted_at) data.posted_at = new Date().toISOString();
  const row = await aw().tables.updateRow<Post>({ ...T, rowId: p.$id, data });
  if (data.status && data.status !== p.status) logActivity(p.$id, "moved", `${p.title} → ${STATUSES.find((s) => s.id === data.status)?.label}`);
  return row;
}

export function PostCard({ p, onOpen, dragging }: { p: Post; onOpen: () => void; dragging: (id: string | null) => void }) {
  const { map } = useTargets();
  const targets = targetsOf(p, map);
  return (
    <div className={`post-card ${overdue(p) ? "late" : ""}`} draggable onDragStart={(e) => { e.dataTransfer.setData("text/post", p.$id); e.dataTransfer.effectAllowed = "move"; dragging(p.$id); }}
      onDragEnd={() => dragging(null)} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <div className="pc-title">{p.title}</div>
      {targets.length > 0 && (
        <div className="pc-meta">
          {targets.map((t) => <PlatformBadge key={t.space} space={t.space} size={20} solid={t.status === "posted"} />)}
          {targets.length === 1 && <span className="tiny dim">{spaceOf(targets[0].space)?.label}</span>}
        </div>
      )}
      <div className="pc-foot">
        {p.due_at ? <span className={`pc-due ${overdue(p) ? "late" : ""}`}><CalendarBlank size={12} />{dueLabel(p.due_at)}</span> : <span className="tiny faint">{timeAgo(p.$updatedAt)}</span>}
        <span className="row" style={{ gap: 6, marginLeft: "auto" }}>
          {p.jobs?.length > 0 && <span className="pc-icon" title={`${p.jobs.length} voiceover${p.jobs.length > 1 ? "s" : ""}`}><Microphone size={12} />{p.jobs.length}</span>}
          {(p.assignee_name || p.owner_name) && <Avatar id={p.assignee_id ?? p.owner_id} name={p.assignee_name ?? p.owner_name} sm />}
        </span>
      </div>
    </div>
  );
}

function QuickAdd({ status, onAdd }: { status: Status; onAdd: (title: string, status: Status) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  if (!open) return <button className="col-add" onClick={() => setOpen(true)}><Plus size={14} /> Add</button>;
  return (
    <input className="col-input" autoFocus value={v} placeholder="Title, then Enter" onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (!v.trim()) setOpen(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { setV(""); setOpen(false); }
        if (e.key === "Enter" && v.trim()) { onAdd(v.trim(), status); setV(""); }
      }} />
  );
}

function Feed() {
  const { rows } = useLive<Activity>("activity", [Query.orderDesc("$createdAt"), Query.limit(30)]);
  if (!rows.length) return <p className="dim small">Nothing yet. Moves, edits, voiceovers and comments from both of you show up here.</p>;
  return (
    <div className="feed-list">
      {rows.slice(0, 30).map((a) => (
        <div key={a.$id} className="feed-row">
          <Avatar id={a.actor_id} name={a.actor_name} sm />
          <span className="small"><b>{a.actor_name?.split(" ")[0] ?? "Someone"}</b> <span className="dim">{a.verb}</span> {a.text}</span>
          <span className="tiny faint" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{timeAgo(a.$createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

function BoardInner() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe();
  const { toast } = useDialog();
  const { rows: posts, setRows, loading, error } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(500)]);
  const { map } = useTargets();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [who, setWho] = useState<"all" | "mine">("all");
  const [plat, setPlat] = useState<Platform | "">("");
  const [q, setQ] = useState("");
  const [feed, setFeed] = useState(false);
  const open = params.get("post");

  const shown = useMemo(() => posts.filter((p) =>
    (who === "all" || p.assignee_id === me?.user?.id || (!p.assignee_id && p.owner_id === me?.user?.id))
    && (!plat || p.platforms.includes(plat))
    && (!q || `${p.title} ${p.script ?? ""} ${p.caption ?? ""}`.toLowerCase().includes(q.toLowerCase()))), [posts, who, plat, q, me]);

  async function add(title: string, status: Status) {
    try { await createPost({ title, status }); } catch (e) { toast((e as Error).message, "bad"); }
  }
  async function move(id: string, status: Status) {
    const p = posts.find((x) => x.$id === id);
    if (!p || p.status === status) return;
    setRows((cur) => cur.map((x) => (x.$id === id ? { ...x, status } : x))); // optimistic; realtime confirms
    try {
      // the whole post moved: every platform it goes to moves with it
      if (map[id]?.length) await saveTargets(id, map[id].map((t) => ({ ...t, status })));
      else await savePost(p, { status });
    } catch (e) { toast((e as Error).message, "bad"); setRows((cur) => cur.map((x) => (x.$id === id ? p : x))); }
  }
  const go = (id: string | null) => router.push(id ? `/workspace?post=${id}` : "/workspace", { scroll: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      createPost({ title: "Untitled" }).then((p) => go(p.$id)).catch((x) => toast(x.message, "bad"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPost = posts.find((p) => p.$id === open);
  const late = posts.filter(overdue).length;
  const week = posts.filter((p) => p.due_at && Date.parse(p.due_at) - Date.now() < 7 * 864e5 && Date.parse(p.due_at) > Date.now() && p.status !== "posted").length;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>The board. <em>Everything you two are making.</em></h1>
          <p className="sub">{loading ? "Loading…" : `${posts.length} post${posts.length === 1 ? "" : "s"} · ${week} due this week${late ? ` · ${late} overdue` : ""}. Drag cards between stages; press N for a new one.`}</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost" onClick={() => setFeed(true)}><Pulse size={15} weight="bold" /> Activity</button>
          <button onClick={() => createPost({ title: "Untitled" }).then((p) => go(p.$id)).catch((x) => toast(x.message, "bad"))}><Plus size={15} weight="bold" /> New post</button>
        </div>
      </div>
      {error && <p className="err">{error}</p>}
      <div className="filters">
        <div className="seg">
          <button className={who === "all" ? "on" : ""} onClick={() => setWho("all")}>Everyone</button>
          <button className={who === "mine" ? "on" : ""} onClick={() => setWho("mine")}>Mine</button>
        </div>
        <select value={plat} onChange={(e) => setPlat(e.target.value as Platform | "")} style={{ width: "auto", minWidth: 150 }}>
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, scripts, captions" style={{ flex: 1, minWidth: 180 }} />
      </div>
      <div className="board">
        {STATUSES.map((s) => {
          const col = shown.filter((p) => p.status === s.id).sort((a, b) => (a.due_at && b.due_at ? Date.parse(a.due_at) - Date.parse(b.due_at) : a.due_at ? -1 : b.due_at ? 1 : 0));
          return (
            <section key={s.id} className={`col ${over === s.id && drag ? "over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(s.id); }} onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/post"); if (id) move(id, s.id); }}>
              <header className="col-head"><span className={`col-dot s-${s.id}`} /><b>{s.label}</b><span className="faint mono tiny">{col.length}</span></header>
              <div className="col-body">
                {col.map((p) => <PostCard key={p.$id} p={p} onOpen={() => go(p.$id)} dragging={setDrag} />)}
                <QuickAdd status={s.id} onAdd={add} />
              </div>
            </section>
          );
        })}
      </div>
      {feed && (
        <>
          <div className="scrim" onClick={() => setFeed(false)} />
          <aside className="drawer feed-drawer" aria-label="Activity">
            <div className="row between" style={{ marginBottom: 14 }}>
              <h2 style={{ margin: 0 }}><Pulse size={17} weight="bold" /> Activity</h2>
              <button className="icon-btn" title="Close" onClick={() => setFeed(false)}><X size={17} /></button>
            </div>
            <Feed />
          </aside>
        </>
      )}
      {open && (openPost ? <PostDrawer key={open} post={openPost} onClose={() => go(null)} /> : !loading && <PostMissing onClose={() => go(null)} />)}
    </>
  );
}

function PostMissing({ onClose }: { onClose: () => void }) {
  return (<><div className="scrim" onClick={onClose} /><aside className="drawer"><p className="dim">This post was deleted.</p><button onClick={onClose}>Close</button></aside></>);
}

type LibItem = { id: string; label?: string; engine: string; voice: string; created: number; results: { id: string; text: string; duration: number; audio?: string }[] };

function Voiceovers({ ids }: { ids: string[] }) {
  const [items, setItems] = useState<Record<string, LibItem | null>>({});
  useEffect(() => {
    ids.filter((id) => !(id in items)).forEach((id) => api<LibItem>(`library/${id}`).then((j) => setItems((m) => ({ ...m, [id]: j }))).catch(() => setItems((m) => ({ ...m, [id]: null }))));
  }, [ids, items]);
  if (!ids.length) return <p className="tiny faint" style={{ margin: 0 }}>None yet. Make one from the script above.</p>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {ids.slice().reverse().map((id) => {
        const j = items[id];
        if (j === undefined) return <div key={id} className="tiny faint">Loading {id}…</div>;
        if (j === null) return <div key={id} className="tiny faint">{id}: still rendering, or deleted from the Library.</div>;
        const total = j.results.reduce((s, r) => s + r.duration, 0);
        return (
          <div key={id} className="vo-row">
            <div className="row between" style={{ gap: 8 }}>
              <span className="small" style={{ fontWeight: 600 }}>{j.label || j.results[0]?.text.slice(0, 48)}</span>
              <span className="tiny dim mono">{j.engine} · {j.results.length} line{j.results.length > 1 ? "s" : ""} · {fmtS(total)}</span>
            </div>
            {j.results[0]?.audio && <Player src={j.results[0].audio} duration={j.results[0].duration} compact />}
            <Link className="tiny dim" href={`/library#${id}`}>Open in Library <ArrowUpRight size={11} /></Link>
          </div>
        );
      })}
    </div>
  );
}

function Comments({ postId }: { postId: string }) {
  const { rows, loading } = useLive<Comment>("comments", [Query.equal("post_id", postId), Query.orderAsc("$createdAt"), Query.limit(200)], (c) => c.post_id === postId, [postId]);
  const me = useMe();
  const [v, setV] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const sorted = rows.slice().sort((a, b) => Date.parse(a.$createdAt) - Date.parse(b.$createdAt));
  const seen = useRef(-1);
  useEffect(() => { // follow new messages, but don't jump to the thread when the post first opens
    if (loading) return;
    if (seen.current >= 0 && rows.length > seen.current) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    seen.current = rows.length;
  }, [rows.length, loading]);
  async function send() {
    const body = v.trim();
    if (!body) return;
    setV("");
    await aw().tables.createRow({ databaseId: AW.db, tableId: "comments", rowId: ID.unique(), data: { post_id: postId, body, author_id: me?.user?.id ?? null, author_name: me?.user?.name ?? null } });
    logActivity(postId, "commented", body.slice(0, 120));
  }
  return (
    <div>
      <div className="stack" style={{ gap: 12 }}>
        {sorted.map((c) => (
          <div key={c.$id} className={`cmt ${c.author_id === me?.user?.id ? "mine" : ""}`}>
            <Avatar id={c.author_id} name={c.author_name} sm />
            <div style={{ minWidth: 0 }}>
              <div className="tiny"><b>{c.author_name ?? "Someone"}</b> <span className="faint">{timeAgo(c.$createdAt)}</span></div>
              <div className="cmt-body">{c.body}</div>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="cmt-input">
        <textarea value={v} onChange={(e) => setV(e.target.value)} placeholder="Leave a note for your partner…  (⌘/Ctrl + Enter)"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <button className="sm" disabled={!v.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}

const LIMITS: [string, number][] = [["X", 280], ["Instagram", 2200], ["TikTok", 2200], ["YouTube", 5000]];

const toLocal = (iso?: string | null) => { if (!iso) return ""; const x = new Date(iso); return new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };

function LinkInput({ value, onSave }: { value: string; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input value={v} placeholder="Live link https://…" onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onSave(v.trim() || null); }} style={{ minWidth: 0 }} />;
}

/** Where a post goes: one row per platform space, each with its own stage, publish time and live link. */
export function TargetsEditor({ post }: { post: Post }) {
  const { map } = useTargets();
  const { toast } = useDialog();
  const targets = targetsOf(post, map);
  const set = (next: Target[]) => saveTargets(post.$id, next).catch((e) => toast((e as Error).message, "bad"));
  const patch = (i: number, p: Partial<Target>) => set(targets.map((t, k) => (k === i ? { ...t, ...p } : t)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {targets.map((t, i) => (
        <div key={t.space} className="target-row">
          <b className="small row" style={{ gap: 7 }} title={spaceOf(t.space)?.about}><PlatformBadge space={t.space} size={20} solid={t.status === "posted"} />{spaceName(t.space)}</b>
          <select value={t.status} onChange={(e) => patch(i, { status: e.target.value as Status })}>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <input type="datetime-local" value={toLocal(t.due_at)} onChange={(e) => patch(i, { due_at: e.target.value ? new Date(e.target.value).toISOString() : null })} />
          <LinkInput value={t.link ?? ""} onSave={(link) => patch(i, { link })} />
          <button className="icon-btn danger-h" title={`Stop posting to ${spaceName(t.space)}`} onClick={() => set(targets.filter((_, k) => k !== i))}><X size={14} /></button>
        </div>
      ))}
      <select value="" style={{ width: "auto", alignSelf: "flex-start" }}
        onChange={(e) => { const sp = spaceOf(e.target.value); if (sp) set([...targets, { space: sp.id, status: post.status === "posted" ? "draft" : post.status, due_at: post.due_at, link: null }]); }}>
        <option value="">{targets.length ? "+ Cross-post to…" : "+ Where does it go?"}</option>
        {NETWORKS.map((n) => (
          <optgroup key={n.id} label={n.label}>
            {n.spaces.filter((sp) => !targets.some((t) => t.space === sp.id)).map((sp) => <option key={sp.id} value={sp.id}>{n.label} {sp.label}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export function PostDrawer({ post, onClose }: { post: Post; onClose: () => void }) {
  const { confirm, toast } = useDialog();
  const members = useMembers();
  const [draft, setDraft] = useState<Partial<Post>>({});
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<Post>>({});
  const { uploads, upload } = useUploader(post.$id);
  const { rows: media } = useLive<Media>("media", [Query.equal("post_id", post.$id), Query.orderDesc("$createdAt"), Query.limit(100)], (m) => m.post_id === post.$id, [post.$id]);
  const [view, setView] = useState<Media | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const [drop, setDrop] = useState(false);

  // what you're typing wins over what just arrived from your partner; everything else follows the live row
  const val = <K extends keyof Post>(k: K): Post[K] => (k in draft ? (draft[k] as Post[K]) : post[k]);

  function edit(patch: Partial<Post>, now = false) {
    setDraft((d) => ({ ...d, ...patch }));
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    const flush = async () => {
      const data = pending.current; pending.current = {};
      if (!Object.keys(data).length) return;
      setSaved("saving");
      try {
        await savePost(post, data);
        setDraft((d) => { const n = { ...d }; for (const k of Object.keys(data)) if ((n as Record<string, unknown>)[k] === (data as Record<string, unknown>)[k]) delete (n as Record<string, unknown>)[k]; return n; });
        setSaved("saved");
      } catch (e) { toast((e as Error).message, "bad"); setSaved("idle"); }
    };
    if (now) flush(); else timer.current = setTimeout(flush, 700);
  }
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); const data = pending.current; if (Object.keys(data).length) savePost(post, data).catch(() => {}); } }, [post]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !view) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, view]);

  const script = val("script") ?? "";
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const caption = val("caption") ?? "";
  const { map: tmap } = useTargets();
  const hasTargets = targetsOf(post, tmap).length > 0;
  const dueLocal = (() => { const d = val("due_at"); if (!d) return ""; const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); })();

  async function remove() {
    if (!(await confirm({ title: "Delete this post?", body: <>“{post.title}”, its comments stay in the activity log. Media files stay in the Media library.</>, confirm: "Delete", danger: true }))) return;
    await aw().tables.deleteRow({ ...T, rowId: post.$id });
    forgetTargets(post.$id);
    logActivity(null, "deleted", post.title);
    onClose();
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer post-drawer" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrop(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDrop(false); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDrop(false); upload(e.dataTransfer.files); } }}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <span className="tiny faint">{saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : `Edited ${timeAgo(post.$updatedAt)}`}{post.owner_name ? ` · started by ${post.owner_name.split(" ")[0]}` : ""}</span>
          <span className="row" style={{ gap: 2 }}>
            <button className="icon-btn danger-h" title="Delete post" onClick={remove}><TrashSimple size={16} /></button>
            <button className="icon-btn" title="Close (Esc)" onClick={onClose}><X size={17} /></button>
          </span>
        </div>
        <input className="title-input" value={val("title")} onChange={(e) => edit({ title: e.target.value.slice(0, 200) || "Untitled" })} aria-label="Title" />

        <div className="seg status-seg" style={{ margin: "14px 0 18px" }}>
          {STATUSES.map((s) => <button key={s.id} className={val("status") === s.id ? "on" : ""} onClick={() => edit({ status: s.id }, true)}><span className={`col-dot s-${s.id}`} />{s.label}</button>)}
        </div>

        <dl className="props">
          <dt>Publish to</dt>
          <dd><TargetsEditor post={post} /></dd>
          {!hasTargets && <>
            <dt>Publish</dt>
            <dd className="row" style={{ gap: 8 }}>
              <input type="datetime-local" value={dueLocal} style={{ width: "auto" }} onChange={(e) => edit({ due_at: e.target.value ? new Date(e.target.value).toISOString() : null }, true)} />
              {val("due_at") && <button className="quiet xs" onClick={() => edit({ due_at: null }, true)}>Clear</button>}
            </dd>
          </>}
          <dt>Owner</dt>
          <dd>
            <select value={val("assignee_id") ?? ""} style={{ width: "auto", minWidth: 180 }} onChange={(e) => { const m = members.find((x) => x.id === e.target.value); edit({ assignee_id: m?.id ?? null, assignee_name: m?.name ?? null }, true); }}>
              <option value="">Nobody yet</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </dd>
          {!hasTargets && (val("status") === "posted" || val("link")) && <><dt>Live link</dt><dd><input value={val("link") ?? ""} placeholder="https://…" onChange={(e) => edit({ link: e.target.value.slice(0, 500) || null })} /></dd></>}
        </dl>

        <section className="dsec">
          <div className="row between"><h2 style={{ margin: 0 }}>Script</h2>
            <span className="row" style={{ gap: 8 }}>
              <span className="tiny faint mono">{words} words · ~{fmtS((words / 150) * 60)}</span>
              <Link className="btn sm" href={`/generate?post=${post.$id}`}><Microphone size={14} /> Voiceover</Link>
            </span>
          </div>
          <textarea className="doc" value={script} onChange={(e) => edit({ script: e.target.value })} placeholder={"What you'll say. One line per beat.\n[pause] before a reveal, [beat] after a question."} />
        </section>

        <section className="dsec">
          <h2>Voiceovers</h2>
          <Voiceovers ids={post.jobs ?? []} />
        </section>

        <section className="dsec">
          <div className="row between"><h2 style={{ margin: 0 }}>Caption</h2>
            <span className="row" style={{ gap: 10 }}>{LIMITS.map(([n, max]) => <span key={n} className={`tiny mono ${caption.length > max ? "over" : "faint"}`}>{n} {caption.length}/{max}</span>)}</span>
          </div>
          <textarea className="doc short" value={caption} onChange={(e) => edit({ caption: e.target.value })} placeholder="Caption, hashtags, the hook in the first line." />
        </section>

        <section className="dsec">
          <div className="row between"><h2 style={{ margin: 0 }}>Media</h2>
            <button className="ghost sm" onClick={() => fileIn.current?.click()}><UploadSimple size={14} /> Add files</button>
          </div>
          <input ref={fileIn} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ""; }} />
          <UploadList uploads={uploads} />
          {media.length ? (
            <div className="media-grid sm">{media.map((m) => <MediaTile key={m.$id} m={m} onOpen={() => setView(m)} selected={val("cover") === m.$id} />)}</div>
          ) : !uploads.length && <div className={`drop slim ${drop ? "over" : ""}`} onClick={() => fileIn.current?.click()}><Paperclip size={18} /><span className="small dim">Drop thumbnails, B-roll or the final cut here</span></div>}
        </section>

        <section className="dsec">
          <h2>Notes</h2>
          <textarea className="doc short" value={val("notes") ?? ""} onChange={(e) => edit({ notes: e.target.value })} placeholder="References, links, what to shoot." />
        </section>

        <section className="dsec">
          <h2><ChatCircle size={15} /> Discussion</h2>
          <Comments postId={post.$id} />
        </section>
        {drop && <div className="drawer-drop">Drop to attach to this post</div>}
      </aside>
      {view && <MediaViewer m={view} onClose={() => setView(null)}
        onDelete={async () => { if (await confirm({ title: "Delete this file?", body: view.name, confirm: "Delete", danger: true })) { await deleteMedia(view); setView(null); } }} />}
      {view && view.kind === "image" && (
        <div className="lb-extra"><button className="ghost sm" onClick={() => { edit({ cover: val("cover") === view.$id ? null : view.$id }, true); setView(null); }}>{val("cover") === view.$id ? "Remove as cover" : "Use as cover"}</button></div>
      )}
    </>
  );
}

export default function Board() {
  return <Gate><BoardInner /></Gate>;
}
