"use client";
// Content spaces: every post, organised by where it goes (YouTube Videos / Shorts / Posts, Instagram Reels / Posts...).
// Pick a space in the sidebar; see its posts as a list or a board by stage. A post can live in several spaces at once
// (cross-posting), each with its own stage, publish time and live link. Click a post for the full editor.
import { CalendarBlank, Kanban, ListBullets, Plus, TrashSimple } from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { NETWORKS, spaceName, spaceOf, targetsOf, type Target } from "@/lib/spaces";
import { AW, STATUSES, type Post, type Status } from "@/lib/workspace";
import { aw, logActivity, Query, timeAgo, useLive, useMe } from "./aw";
import { useDialog } from "./Dialog";
import { createPost, dueLabel, PostDrawer, savePost } from "./Workspace";
import { forgetTargets, saveTargets, useTargets } from "./useTargets";
import { Avatar, Gate } from "./wsparts";

type View = "list" | "board";
type Row = { p: Post; t: Target | null; all: Target[] };
const UNPLANNED = "none";

function ContentInner() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe();
  const { confirm, toast } = useDialog();
  const { rows: posts, loading, error } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(500)]);
  const { map } = useTargets();
  const space = params.get("space") ?? "";
  const open = params.get("post");
  const [view, setView] = useState<View>("list");
  const [q, setQ] = useState("");
  const [who, setWho] = useState<"all" | "mine">("all");
  const [drag, setDrag] = useState<string | null>(null);
  useEffect(() => { try { const v = localStorage.getItem("vb-content-view"); if (v === "board" || v === "list") setView(v); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem("vb-content-view", view); } catch {} }, [view]);

  const go = (next: { space?: string; post?: string | null }) => {
    const u = new URLSearchParams();
    const sp = next.space ?? space;
    if (sp) u.set("space", sp);
    const po = next.post === undefined ? open : next.post;
    if (po) u.set("post", po);
    router.push(`/content${u.size ? `?${u}` : ""}`, { scroll: false });
  };

  const all: Row[] = useMemo(() => posts.map((p) => { const ts = targetsOf(p, map); return { p, t: null, all: ts }; }), [posts, map]);
  const counts = useMemo(() => {
    const c: Record<string, { open: number; total: number }> = {};
    for (const r of all) {
      for (const t of r.all) { c[t.space] ??= { open: 0, total: 0 }; c[t.space].total++; if (t.status !== "posted") c[t.space].open++; }
      if (!r.all.length) { c[UNPLANNED] ??= { open: 0, total: 0 }; c[UNPLANNED].total++; if (r.p.status !== "posted") c[UNPLANNED].open++; }
    }
    return c;
  }, [all]);

  const rows: Row[] = useMemo(() => {
    const mine = (p: Post) => p.assignee_id === me?.user?.id || (!p.assignee_id && p.owner_id === me?.user?.id);
    const text = (p: Post) => !q || `${p.title} ${p.script ?? ""} ${p.caption ?? ""} ${p.notes ?? ""}`.toLowerCase().includes(q.toLowerCase());
    return all
      .map((r) => ({ ...r, t: space && space !== UNPLANNED ? r.all.find((t) => t.space === space) ?? null : null }))
      .filter((r) => (space === UNPLANNED ? !r.all.length : !space || r.t) && (who === "all" || mine(r.p)) && text(r.p));
  }, [all, space, q, who, me]);

  const stageOf = (r: Row): Status => r.t?.status ?? r.p.status;
  const dueOf = (r: Row) => (r.t ? r.t.due_at ?? null : r.p.due_at);

  async function setStage(r: Row, status: Status) {
    try {
      if (r.t) await saveTargets(r.p.$id, r.all.map((t) => (t.space === r.t!.space ? { ...t, status } : t)));
      else if (r.all.length) await saveTargets(r.p.$id, r.all.map((t) => ({ ...t, status })));
      else await savePost(r.p, { status });
    } catch (e) { toast((e as Error).message, "bad"); }
  }
  async function setDue(r: Row, iso: string | null) {
    try {
      if (r.t) await saveTargets(r.p.$id, r.all.map((t) => (t.space === r.t!.space ? { ...t, due_at: iso } : t)));
      else await savePost(r.p, { due_at: iso });
    } catch (e) { toast((e as Error).message, "bad"); }
  }
  async function remove(p: Post) {
    if (!(await confirm({ title: "Delete this post?", body: <>“{p.title}” goes from every platform space. Media files stay in the Media library.</>, confirm: "Delete", danger: true }))) return;
    try {
      await aw().tables.deleteRow({ databaseId: AW.db, tableId: "posts", rowId: p.$id });
      forgetTargets(p.$id);
      logActivity(null, "deleted", p.title);
      toast("Post deleted", "ok");
    } catch (e) { toast((e as Error).message, "bad"); }
  }
  async function newPost(status: Status = "idea") {
    try {
      const sp = spaceOf(space);
      const p = await createPost({ title: "Untitled", status, platforms: sp ? [sp.legacy] : [] });
      if (sp) await saveTargets(p.$id, [{ space: sp.id, status, due_at: null, link: null }]);
      go({ post: p.$id });
    } catch (e) { toast((e as Error).message, "bad"); }
  }

  const sp = spaceOf(space);
  const title = space === UNPLANNED ? "No platform yet" : sp ? `${sp.networkLabel} ${sp.label}` : "All content";
  const openPost = posts.find((p) => p.$id === open);
  const toLocal = (iso: string | null) => { if (!iso) return ""; const x = new Date(iso); return new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };

  return (
    <div className="spaces">
      <nav className="spaces-side" aria-label="Spaces">
        <button className={`sp-link ${!space ? "on" : ""}`} onClick={() => go({ space: "", post: null })}><span>All content</span><span className="faint mono tiny">{posts.length}</span></button>
        {NETWORKS.map((n) => (
          <div key={n.id} className="sp-group">
            <div className="sp-net">{n.label}</div>
            {n.spaces.map((s) => (
              <button key={s.id} className={`sp-link ${space === s.id ? "on" : ""}`} onClick={() => go({ space: s.id, post: null })} title={s.about}>
                <span>{s.label}</span><span className="faint mono tiny">{counts[s.id]?.open ?? 0}{counts[s.id]?.total && counts[s.id].total !== counts[s.id].open ? `/${counts[s.id].total}` : ""}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="sp-group"><button className={`sp-link ${space === UNPLANNED ? "on" : ""}`} onClick={() => go({ space: UNPLANNED, post: null })}><span>No platform yet</span><span className="faint mono tiny">{counts[UNPLANNED]?.open ?? 0}</span></button></div>
      </nav>

      <div className="spaces-main">
        <div className="head">
          <div>
            <div className="eyebrow">Content</div>
            <h1>{title}</h1>
            <p className="sub">{loading ? "Loading…" : sp ? `${sp.about}. ${rows.length} post${rows.length === 1 ? "" : "s"}; a post can go to several platforms at once (Publish to, in the post).`
              : "Every post by where it goes. Pick a space on the left, or cross-post one post to many."}</p>
          </div>
          <button onClick={() => newPost()}><Plus size={15} weight="bold" /> New {sp ? sp.label.replace(/s$/, "").toLowerCase() : "post"}</button>
        </div>
        {error && <p className="err">{error}</p>}
        <div className="filters">
          <div className="seg">
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}><ListBullets size={14} /> List</button>
            <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}><Kanban size={14} /> Board</button>
          </div>
          <div className="seg">
            <button className={who === "all" ? "on" : ""} onClick={() => setWho("all")}>Everyone</button>
            <button className={who === "mine" ? "on" : ""} onClick={() => setWho("mine")}>Mine</button>
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, scripts, captions, notes" style={{ flex: 1, minWidth: 180 }} />
        </div>

        {view === "list" ? (
          <div className="card flush">
            {!rows.length && !loading && <div className="empty"><b>Nothing here yet</b><span>Press New to start one{sp ? ` in ${sp.networkLabel} ${sp.label}` : ""}.</span></div>}
            {rows.length > 0 && (
              <table className="table content-table">
                <thead><tr><th>Title</th><th>Stage</th><th>Publish</th><th>{sp ? "Also on" : "Goes to"}</th><th>Owner</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const others = r.all.filter((t) => t.space !== r.t?.space);
                    return (
                      <tr key={r.p.$id} className={open === r.p.$id ? "on" : ""}>
                        <td><button className="linkish" onClick={() => go({ post: r.p.$id })}><b>{r.p.title}</b></button><div className="tiny faint">{timeAgo(r.p.$updatedAt)}</div></td>
                        <td><select value={stageOf(r)} onChange={(e) => setStage(r, e.target.value as Status)} style={{ width: "auto" }}>{STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></td>
                        <td><input type="datetime-local" value={toLocal(dueOf(r))} style={{ width: "auto" }} onChange={(e) => setDue(r, e.target.value ? new Date(e.target.value).toISOString() : null)} /></td>
                        <td><div className="row" style={{ gap: 4, flexWrap: "wrap" }}>{others.map((t) => (
                          <button key={t.space} className="pc-tag" title={`${spaceName(t.space)} · ${STATUSES.find((s) => s.id === t.status)?.label}`} onClick={() => go({ space: t.space })}>{spaceName(t.space)}{t.status === "posted" ? " ✓" : ""}</button>
                        ))}{!others.length && <span className="tiny faint">—</span>}</div></td>
                        <td>{(r.p.assignee_name || r.p.owner_name) && <Avatar id={r.p.assignee_id ?? r.p.owner_id} name={r.p.assignee_name ?? r.p.owner_name} sm />}</td>
                        <td><button className="icon-btn danger-h" title="Delete post" onClick={() => remove(r.p)}><TrashSimple size={15} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div className="board">
            {STATUSES.map((s) => {
              const col = rows.filter((r) => stageOf(r) === s.id);
              return (
                <section key={s.id} className="col" onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/post"); const r = rows.find((x) => x.p.$id === id); if (r && stageOf(r) !== s.id) setStage(r, s.id); setDrag(null); }}>
                  <header className="col-head"><span className={`col-dot s-${s.id}`} /><b>{s.label}</b><span className="faint mono tiny">{col.length}</span></header>
                  <div className="col-body">
                    {col.map((r) => (
                      <div key={r.p.$id} className={`post-card ${drag === r.p.$id ? "dragging" : ""}`} draggable
                        onDragStart={(e) => { e.dataTransfer.setData("text/post", r.p.$id); setDrag(r.p.$id); }} onDragEnd={() => setDrag(null)}
                        onClick={() => go({ post: r.p.$id })} role="button" tabIndex={0}>
                        <div className="pc-title">{r.p.title}</div>
                        <div className="pc-meta">{r.all.filter((t) => t.space !== r.t?.space).slice(0, 3).map((t) => <span key={t.space} className="pc-tag">{spaceName(t.space)}</span>)}</div>
                        <div className="pc-foot">
                          {dueOf(r) ? <span className="pc-due"><CalendarBlank size={12} />{dueLabel(dueOf(r))}</span> : <span className="tiny faint">{timeAgo(r.p.$updatedAt)}</span>}
                          <span style={{ marginLeft: "auto" }}>{(r.p.assignee_name || r.p.owner_name) && <Avatar id={r.p.assignee_id ?? r.p.owner_id} name={r.p.assignee_name ?? r.p.owner_name} sm />}</span>
                        </div>
                      </div>
                    ))}
                    <button className="col-add" onClick={() => newPost(s.id)}><Plus size={14} /> Add</button>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {open && openPost && <PostDrawer key={open} post={openPost} onClose={() => go({ post: null })} />}
    </div>
  );
}

export default function Content() {
  return <Gate><ContentInner /></Gate>;
}
