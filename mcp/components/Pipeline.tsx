"use client";
// The one-click post pipeline in a post's drawer (lib/pipeline.ts): seven steps from script to scheduled (the package is
// the researched title, description, hashtags and credits), each lit from
// what the post already has. "Run all" starts every missing step in order on the GPU; the server keeps it going with
// the drawer closed (the 10-minute sweep), and this panel follows it while it's open.
import { ArrowClockwise, CalendarCheck, Check, ClosedCaptioning, Hash, ImageSquare, Lightning, Microphone, Pause, Play, TextAlignLeft, Warning, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { watching } from "./watching";

type StepId = "script" | "hook" | "voice" | "subtitles" | "thumbnail" | "package" | "schedule";
type Step = { id: StepId; label: string; state: "done" | "todo" | "running" | "blocked" | "warn" | "failed"; detail: string };
type Status = { steps: Step[]; running: boolean; next: StepId | null; done: boolean; log: { at: number; text: string; ok?: boolean }[]; hook: { score: number } | null };

const ICON: Record<StepId, React.ComponentType<{ size?: number; weight?: "bold" }>> = {
  script: TextAlignLeft, hook: Lightning, voice: Microphone, subtitles: ClosedCaptioning, thumbnail: ImageSquare, package: Hash, schedule: CalendarCheck,
};
const RUNNABLE: StepId[] = ["voice", "subtitles", "thumbnail", "package", "schedule"];

export function Pipeline({ postId, script, onWrite }: { postId: string; script: string; onWrite: () => void }) {
  const { toast } = useDialog();
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const live = useRef(true);
  const load = useCallback(() => api<Status>(`pipeline/${postId}`).then((r) => { if (live.current) setS(r); }).catch(() => null), [postId]);
  useEffect(() => { live.current = true; load(); return () => { live.current = false; }; }, [load]);
  // a new script changes the hook score: look again once typing stops
  useEffect(() => { const t = setTimeout(load, 1500); return () => clearTimeout(t); }, [script, load]);
  const moving = !!s && (s.running || s.steps.some((x) => x.state === "running"));
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => { if (watching()) load(); }, 5000);
    return () => clearInterval(t);
  }, [moving, load]);

  async function run(step: string, force = false) {
    setBusy(step);
    try { setS(await api<Status>(`pipeline/${postId}`, { body: { step, force } })); }
    catch (e) { toast((e as Error).message, "bad"); }
    finally { setBusy(null); }
  }
  async function stop() {
    setBusy("stop");
    try { setS(await api<Status>(`pipeline/${postId}/stop`, { body: {} })); } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(null); }
  }

  const doneN = s?.steps.filter((x) => x.state === "done" || x.state === "warn").length ?? 0;
  const weakHook = s?.steps.find((x) => x.id === "hook")?.state === "todo" && s.hook;
  const last = s?.log[s.log.length - 1];
  return (
    <section className="dsec pl" aria-label="Post pipeline">
      <div className="row between" style={{ flexWrap: "nowrap", gap: 10 }}>
        <h2 style={{ margin: 0 }}>Pipeline <span className="tiny faint mono">{s ? `${doneN}/${s.steps.length}` : ""}</span></h2>
        <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
          {s?.running ? (
            <button className="ghost sm" onClick={stop} disabled={busy === "stop"}><Pause size={14} weight="bold" />Pause</button>
          ) : s?.done ? <span className="pill ok"><Check size={12} weight="bold" />Ready</span> : (
            <button className="sm" onClick={() => run("all")} disabled={!s || !!busy} aria-busy={busy === "all"} title="Do every missing step, in order">
              {busy === "all" ? <span className="vp-spin sm" /> : <Play size={14} weight="fill" />}Run all
            </button>
          )}
        </span>
      </div>
      <ol className="pl-steps">
        {(s?.steps ?? (["script", "hook", "voice", "subtitles", "thumbnail", "package", "schedule"] as StepId[]).map((id) => ({ id, label: "", state: "blocked", detail: "" }) as Step)).map((st, i) => {
          const Ic = ICON[st.id];
          return (
            <li key={st.id} className={`pl-step ${st.state}`}>
              <span className="pl-dot" aria-hidden>
                {st.state === "done" ? <Check size={13} weight="bold" /> : st.state === "running" ? <span className="vp-spin sm" /> : st.state === "failed" ? <X size={13} weight="bold" /> : st.state === "warn" ? <Warning size={13} weight="bold" /> : <Ic size={13} weight="bold" />}
              </span>
              {i < 6 && <span className="pl-line" aria-hidden />}
              <span className="pl-text">
                <b>{st.label || "…"}</b>
                <span className="tiny dim ellipsis">{s ? st.detail : <span className="skel" style={{ display: "inline-block", width: 120, height: 10 }} />}</span>
              </span>
              <span className="pl-act">
                {st.id === "script" && st.state !== "done" && <button className="quiet xs" onClick={onWrite}>Write</button>}
                {st.id === "package" && st.state === "done" && <button className="quiet xs" onClick={() => run("package")} disabled={!!busy} aria-label="Research the package again">{busy === "package" ? <span className="vp-spin sm" /> : "Redo"}</button>}
                {RUNNABLE.includes(st.id) && (st.state === "todo" || st.state === "failed") && (
                  <button className="quiet xs" onClick={() => run(st.id)} disabled={!!busy} aria-label={`${st.label} now`}>
                    {busy === st.id ? <span className="vp-spin sm" /> : st.state === "failed" ? <><ArrowClockwise size={12} weight="bold" />Retry</> : "Do it"}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {weakHook && !s?.running && (
        <p className="tiny dim pl-note"><Warning size={12} weight="bold" /> The hook scores {s!.hook!.score}: Run all waits for a stronger opening. <button className="quiet xs" onClick={() => run("all", true)}>Run anyway</button></p>
      )}
      {last && <p className={`tiny pl-note ${last.ok === false ? "bad" : "dim"}`}>{last.text}</p>}
    </section>
  );
}
