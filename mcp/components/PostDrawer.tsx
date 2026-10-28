"use client";
// One post, everywhere: create and save posts, the activity feed, and the drawer that edits a post (where it goes,
// script, voiceovers, caption, media, notes, discussion). Everything is live: your partner's edits land as they type.
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
import { NETWORKS, spaceName, spaceOf, targetsOf, type SpaceId, type Target } from "@/lib/spaces";
import { forgetTargets, saveTargets, useTargets } from "./useTargets";
import { PlatformBadge } from "./platform";
import { Select } from "./pop";
import { Composer, PublishPill } from "./Publish";
import { Pipeline } from "./Pipeline";

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

export function Feed() {
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
        if (j === null) return <div key={id} className="tiny faint">{id}: still rendering, or deleted from Files.</div>;
        const total = j.results.reduce((s, r) => s + r.duration, 0);
        return (
          <div key={id} className="vo-row">
            <div className="row between" style={{ gap: 8 }}>
              <span className="small" style={{ fontWeight: 600 }}>{j.label || j.results[0]?.text.slice(0, 48)}</span>
              <span className="tiny dim mono">{j.engine} · {j.results.length} line{j.results.length > 1 ? "s" : ""} · {fmtS(total)}</span>
            </div>
            {j.results[0]?.audio && <Player src={j.results[0].audio} duration={j.results[0].duration} compact />}
            <Link className="tiny dim" href={`/files#${id}`}>Open in Files <ArrowUpRight size={11} /></Link>
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
        <textarea aria-label="Comment" value={v} onChange={(e) => setV(e.target.value)} placeholder="Leave a note for your partner…  (⌘/Ctrl + Enter)"
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
  return <input value={v} aria-label="Live link" placeholder="Live link https://…" onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onSave(v.trim() || null); }} style={{ minWidth: 0 }} />;
}

/** Where a post goes: one row per platform space, each with its own stage, publish time and live link. */
export function TargetsEditor({ post, onPublish }: { post: Post; onPublish?: (space: SpaceId) => void }) {
  const { map } = useTargets();
  const { toast } = useDialog();
  const targets = targetsOf(post, map);
  const set = (next: Target[]) => saveTargets(post.$id, next).catch((e) => toast((e as Error).message, "bad"));
  const patch = (i: number, p: Partial<Target>) => set(targets.map((t, k) => (k === i ? { ...t, ...p } : t)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {targets.map((t, i) => (
        <div key={t.space} className="target-row">
          <b className="small" title={spaceOf(t.space)?.about}><PlatformBadge space={t.space} size={20} solid={t.status === "posted"} />{spaceName(t.space)}</b>
          <Select size="sm" label={`Stage on ${spaceName(t.space)}`} value={t.status} onChange={(v) => patch(i, { status: v as Status })} options={STATUSES.map((s) => [s.id, s.label] as const)} />
          <input type="datetime-local" aria-label={`Publish time on ${spaceName(t.space)}`} value={toLocal(t.due_at)} onChange={(e) => patch(i, { due_at: e.target.value ? new Date(e.target.value).toISOString() : null })} />
          <LinkInput value={t.link ?? ""} onSave={(link) => patch(i, { link })} />
          {onPublish && <PublishPill post={post} space={t.space} onOpen={() => onPublish(t.space)} />}
          <button className="icon-btn danger-h" title={`Stop posting to ${spaceName(t.space)}`} onClick={() => set(targets.filter((_, k) => k !== i))}><X size={14} /></button>
        </div>
      ))}
      <Select size="sm" label="Add a platform" value="" style={{ width: "auto", alignSelf: "flex-start" }} placeholder={targets.length ? "+ Cross-post to…" : "+ Where does it go?"}
        onChange={(v) => { const sp = spaceOf(v); if (sp) set([...targets, { space: sp.id, status: post.status === "posted" ? "draft" : post.status, due_at: post.due_at, link: null }]); }}
        options={NETWORKS.flatMap((n) => n.spaces.filter((sp) => !targets.some((t) => t.space === sp.id)).map((sp) => ({ value: sp.id, label: `${n.label} ${sp.label}` })))} />
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
  const [composer, setComposer] = useState<SpaceId | null>(null);
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !view && !composer && !document.querySelector(".modal")) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, view, composer]);

  const script = val("script") ?? "";
  const scriptBox = useRef<HTMLTextAreaElement>(null);
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const caption = val("caption") ?? "";
  const { map: tmap } = useTargets();
  const hasTargets = targetsOf(post, tmap).length > 0;
  const dueLocal = (() => { const d = val("due_at"); if (!d) return ""; const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); })();

  async function remove() {
    if (!(await confirm({ title: "Delete this post?", body: <>“{post.title}”, its comments stay in the activity log. Its files stay in Files.</>, confirm: "Delete", danger: true }))) return;
    await aw().tables.deleteRow({ ...T, rowId: post.$id });
    forgetTargets(post.$id);
    logActivity(null, "deleted", post.title);
    onClose();
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer post-drawer" role="dialog" aria-label={post.title} onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrop(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDrop(false); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDrop(false); upload(e.dataTransfer.files); } }}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <span className="tiny faint">{saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : `Edited ${timeAgo(post.$updatedAt)}`}{post.owner_name ? ` · started by ${post.owner_name.split(" ")[0]}` : ""}</span>
          <span className="row" style={{ gap: 2 }}>
            <button className="icon-btn danger-h" aria-label="Delete post" title="Delete post" onClick={remove}><TrashSimple size={16} /></button>
            <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}><X size={17} /></button>
          </span>
        </div>
        <input className="title-input" value={val("title")} onChange={(e) => edit({ title: e.target.value.slice(0, 200) || "Untitled" })} aria-label="Title" />

        <div className="seg status-seg" style={{ margin: "14px 0 18px" }}>
          {STATUSES.map((s) => <button key={s.id} className={val("status") === s.id ? "on" : ""} onClick={() => edit({ status: s.id }, true)}><span className={`col-dot s-${s.id}`} />{s.label}</button>)}
        </div>

        <dl className="props">
          <dt>Publish to</dt>
          <dd><TargetsEditor post={post} onPublish={setComposer} /></dd>
          {!hasTargets && <>
            <dt>Publish</dt>
            <dd className="row" style={{ gap: 8 }}>
              <input type="datetime-local" aria-label="Publish time" value={dueLocal} style={{ width: "auto" }} onChange={(e) => edit({ due_at: e.target.value ? new Date(e.target.value).toISOString() : null }, true)} />
              {val("due_at") && <button className="quiet xs" onClick={() => edit({ due_at: null }, true)}>Clear</button>}
            </dd>
          </>}
          <dt>Owner</dt>
          <dd>
            <Select size="sm" label="Owner" value={(val("assignee_id") as string | null) ?? ""} style={{ width: "auto", minWidth: 180 }}
              onChange={(v) => { const m = members.find((x) => x.id === v); edit({ assignee_id: m?.id ?? null, assignee_name: m?.name ?? null }, true); }}
              options={[["", "Nobody yet"] as const, ...members.map((m) => [m.id, m.name] as const)]} />
          </dd>
          {!hasTargets && (val("status") === "posted" || val("link")) && <><dt>Live link</dt><dd><input value={val("link") ?? ""} placeholder="https://…" onChange={(e) => edit({ link: e.target.value.slice(0, 500) || null })} /></dd></>}
        </dl>

        <Pipeline postId={post.$id} script={script} onWrite={() => { scriptBox.current?.focus(); scriptBox.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }} />

        <section className="dsec">
          <div className="row between"><h2 style={{ margin: 0 }}>Script</h2>
            <span className="row" style={{ gap: 8 }}>
              <span className="tiny faint mono">{words} words · ~{fmtS((words / 150) * 60)}</span>
              <Link className="btn sm" href={`/voiceover?post=${post.$id}`}><Microphone size={14} /> Voiceover</Link>
            </span>
          </div>
          <textarea ref={scriptBox} className="doc" aria-label="Script" value={script} onChange={(e) => edit({ script: e.target.value })} placeholder={"What you'll say. One line per beat.\n[pause] before a reveal, [beat] after a question."} />
        </section>

        <section className="dsec">
          <h2>Voiceovers</h2>
          <Voiceovers ids={post.jobs ?? []} />
        </section>

        <section className="dsec">
          <div className="row between"><h2 style={{ margin: 0 }}>Caption</h2>
            <span className="row" style={{ gap: 10 }}>{LIMITS.map(([n, max]) => <span key={n} className={`tiny mono ${caption.length > max ? "over" : "faint"}`}>{n} {caption.length}/{max}</span>)}</span>
          </div>
          <textarea className="doc short" aria-label="Caption" value={caption} onChange={(e) => edit({ caption: e.target.value })} placeholder="Caption, hashtags, the hook in the first line." />
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
          <textarea className="doc short" aria-label="Notes" value={val("notes") ?? ""} onChange={(e) => edit({ notes: e.target.value })} placeholder="References, links, what to shoot." />
        </section>

        <section className="dsec">
          <h2><ChatCircle size={15} /> Discussion</h2>
          <Comments postId={post.$id} />
        </section>
        {drop && <div className="drawer-drop">Drop to attach to this post</div>}
      </aside>
      {composer && <Composer post={post} space={composer} onClose={() => setComposer(null)} />}
      {view && <MediaViewer m={view} onClose={() => setView(null)}
        onDelete={async () => { if (await confirm({ title: "Delete this file?", body: view.name, confirm: "Delete", danger: true })) { await deleteMedia(view); setView(null); } }} />}
      {view && view.kind === "image" && (
        <div className="lb-extra"><button className="ghost sm" onClick={() => { edit({ cover: val("cover") === view.$id ? null : view.$id }, true); setView(null); }}>{val("cover") === view.$id ? "Remove as cover" : "Use as cover"}</button></div>
      )}
    </>
  );
}
