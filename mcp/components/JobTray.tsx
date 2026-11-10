"use client";
// Everything you started, from any page: a small pill in the corner while jobs run; open it for each job's progress,
// a link back to its page and cancel. It polls the dashboard for each tracked job, which is also what stores finished
// results (so leaving a page never leaves a voice, a dataset session or a trained model unsaved).
import { CheckCircle, CircleNotch, WarningCircle, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { forgetSettled, forgetTracked, isLive, isTracked, pageFor, STALE_MS, trackJob, updateTracked, useTracked, type Tracked } from "./jobs";
import { watching } from "./watching";

type Polled = { id: string; status: string; error?: string; label?: string; kind?: string; progress?: { fraction?: number; stage?: string; detail?: string };
  library?: unknown; part?: unknown; model?: unknown; myvoice?: unknown; kvoice_saved?: unknown };

const stored = (j: Polled) => !!(j.library || j.part || j.model || j.myvoice || j.kvoice_saved);

export default function JobTray() {
  const list = useTracked();
  const { toast } = useDialog();
  const [open, setOpen] = useState(false);
  const tries = useRef<Record<string, number>>({});
  const live = list.filter(isLive);

  useEffect(() => {
    // jobs started anywhere else (MCP, the other person's device, auto-train) join the tray too, so nothing runs unseen
    const look = () => api<{ jobs: Polled[] }>("jobs").then((r) => r.jobs.forEach((j) => {
      if (["queued", "running"].includes(j.status) && !isTracked(j.id)) trackJob(j, j.kind ?? "job", j.label, pageFor(j.kind ?? ""));
    })).catch(() => {});
    look();
    const t = setInterval(() => { if (watching()) look(); }, 20_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!live.length) return;
    let stop = false;
    const tick = async () => {
      for (const t of live) {
        try {
          const j = await api<Polled>(`jobs/${t.id}`);
          if (stop) return;
          const p = { status: j.status, fraction: j.progress?.fraction, stage: j.progress?.stage, detail: j.progress?.detail, error: j.error, seen: Date.now() };
          const finished = j.status === "error" || j.status === "cancelled" || (j.status === "done" && (stored(j) || (tries.current[t.id] = (tries.current[t.id] ?? 0) + 1) > 4));
          updateTracked(t.id, finished ? { ...p, settled: Date.now() } : p);
          if (finished && j.status === "done") toast(`${t.label}: done`, "ok");
          if (finished && j.status === "error") toast(`${t.label}: ${j.error ?? "failed"}`, "bad");
        } catch (e) {
          // the worker restarted (job gone): it's lost. The GPU is off: it waits a while (a restart, a tunnel coming
          // back), then it's lost too: a job queued on a GPU that went off went with it
          if (/404|not found/i.test((e as Error).message)) updateTracked(t.id, { status: "lost", settled: Date.now(), error: "the worker restarted" });
          else if (Date.now() - (t.seen ?? t.at) > STALE_MS) updateTracked(t.id, { status: "lost", settled: Date.now(), error: "the GPU went off before it finished" });
        }
      }
    };
    tick();
    const iv = setInterval(() => { if (watching()) tick(); }, 5000);
    return () => { stop = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.map((t) => t.id).join(",")]);

  // like every popup: Escape and a click outside close it
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("pointerdown", down); };
  }, [open]);

  if (!list.length) return null;
  const pct = (t: Tracked) => Math.round((t.fraction ?? 0) * 100);
  return (
    <div ref={box} className={`jobtray ${open ? "open" : ""}`}>
      {open && (
        <div className="jt-panel">
          <div className="row between"><b className="small">Your jobs</b><span className="row" style={{ gap: 4 }}>
            {list.some((t) => !isLive(t)) && <button className="quiet xs" onClick={() => forgetSettled()}>Clear finished</button>}
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close"><X size={14} /></button></span></div>
          {list.map((t) => (
            <div key={t.id} className="jt-row">
              {isLive(t) ? <CircleNotch size={15} className="spin" /> : t.status === "done" ? <CheckCircle size={15} weight="fill" color="var(--ok)" /> : <WarningCircle size={15} weight="fill" color="var(--danger)" />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <Link href={t.path} className="small" style={{ fontWeight: 600, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} onClick={() => setOpen(false)}>{t.label}</Link>
                <div className="tiny dim" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {isLive(t) ? `${t.status === "queued" ? "Waiting for the GPU" : t.detail || t.stage || "Working"}${t.status === "running" ? ` · ${pct(t)}%` : ""}` : t.status === "done" ? "Done" : t.error || t.status}
                </div>
                {isLive(t) && t.status === "running" && <div className="bar thin live" style={{ marginTop: 4 }}><i style={{ width: `${pct(t)}%` }} /></div>}
              </div>
              {isLive(t)
                ? <button className="quiet xs" onClick={() => { api(`jobs/${t.id}/cancel`, { body: {} }).catch(() => null).finally(() => updateTracked(t.id, { status: "cancelled", settled: Date.now(), error: "cancelled" })); }}>Cancel</button>
                : <button className="icon-btn" title="Clear" onClick={() => forgetTracked(t.id)}><X size={12} /></button>}
            </div>
          ))}
        </div>
      )}
      <button className="jt-pill" onClick={() => setOpen(!open)}>
        {live.length ? <><CircleNotch size={14} className="spin" />{live.length} running{live[0]?.status === "running" ? ` · ${pct(live[0])}%` : ""}</> : <><CheckCircle size={14} weight="fill" color="var(--ok)" />{list.length} done</>}
      </button>
    </div>
  );
}
