"use client";
// Content calendar: what goes out when, across every platform. Drag a post onto a day to reschedule it (keeps its time),
// drag an unscheduled one in to give it a date. Live, like the board.
import { CaretLeft, CaretRight, Plus } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PLATFORMS, type Platform, type Post } from "@/lib/workspace";
import { Query, useLive } from "./aw";
import { useDialog } from "./Dialog";
import { createPost, savePost } from "./Workspace";
import { Gate } from "./wsparts";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.label])) as Record<Platform, string>;
const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function CalendarInner() {
  const router = useRouter();
  const { toast } = useDialog();
  const { rows: posts, setRows } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(500)]);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [over, setOver] = useState<string | null>(null);

  const days = useMemo(() => {
    const first = new Date(month);
    const lead = (first.getDay() + 6) % 7; // Monday first
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
    const n = Math.ceil((lead + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7;
    return Array.from({ length: n }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);

  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of posts) if (p.due_at) { const k = key(new Date(p.due_at)); m.set(k, [...(m.get(k) ?? []), p]); }
    for (const v of m.values()) v.sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!));
    return m;
  }, [posts]);
  const unscheduled = posts.filter((p) => !p.due_at && p.status !== "posted");
  const today = key(new Date());

  async function moveTo(id: string, day: Date) {
    const p = posts.find((x) => x.$id === id);
    if (!p) return;
    const old = p.due_at ? new Date(p.due_at) : null;
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old?.getHours() ?? 18, old?.getMinutes() ?? 0);
    const due_at = d.toISOString();
    const status = p.status === "idea" ? "scheduled" : p.status;
    setRows((cur) => cur.map((x) => (x.$id === id ? { ...x, due_at, status } : x)));
    try { await savePost(p, { due_at, ...(status !== p.status ? { status } : {}) }); } catch (e) { toast((e as Error).message, "bad"); }
  }

  const chip = (p: Post) => (
    <button key={p.$id} className={`cal-chip s-${p.status}`} draggable onDragStart={(e) => e.dataTransfer.setData("text/post", p.$id)}
      onClick={() => router.push(`/workspace?post=${p.$id}`)} title={`${p.title}${p.platforms.length ? ` · ${p.platforms.map((x) => LABEL[x]).join(", ")}` : ""}`}>
      {p.due_at && <span className="mono">{new Date(p.due_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(":00", "")}</span>}
      <span className="cc-t">{p.title}</span>
    </button>
  );

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Calendar. <em>What goes out, when.</em></h1>
          <p className="sub">Drag posts onto a day to schedule them. Ideas you drop on a day become Scheduled.</p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="ghost sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
          <button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><CaretLeft size={16} /></button>
          <b style={{ minWidth: 130, textAlign: "center" }}>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b>
          <button className="icon-btn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><CaretRight size={16} /></button>
        </div>
      </div>
      <div className="cal-wrap">
        <div className="cal">
          {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
          {days.map((d) => {
            const k = key(d);
            const list = byDay.get(k) ?? [];
            return (
              <div key={k} className={`cal-day ${d.getMonth() !== month.getMonth() ? "out" : ""} ${k === today ? "today" : ""} ${over === k ? "over" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver((o) => (o === k ? null : o))}
                onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/post"); if (id) moveTo(id, d); }}
                onDoubleClick={() => createPost({ title: "Untitled", status: "scheduled", due_at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18).toISOString() }).then((p) => router.push(`/workspace?post=${p.$id}`))}>
                <span className="cal-n">{d.getDate()}</span>
                <div className="cal-list">{list.slice(0, 4).map(chip)}{list.length > 4 && <span className="tiny faint">+{list.length - 4} more</span>}</div>
              </div>
            );
          })}
        </div>
        <aside className="cal-side">
          <div className="row between" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Not scheduled</h2><span className="faint mono tiny">{unscheduled.length}</span></div>
          <div className="stack" style={{ gap: 6 }}>
            {unscheduled.map(chip)}
            {!unscheduled.length && <p className="tiny faint" style={{ margin: 0 }}>Everything has a date.</p>}
          </div>
          <button className="quiet sm" style={{ marginTop: 10 }} onClick={() => createPost({ title: "Untitled" }).then((p) => router.push(`/workspace?post=${p.$id}`))}><Plus size={14} /> New post</button>
          <p className="tiny faint" style={{ marginTop: 16 }}>Tip: double-click a day to start a post on it.</p>
        </aside>
      </div>
    </>
  );
}

export default function Calendar() {
  return <Gate><CalendarInner /></Gate>;
}
