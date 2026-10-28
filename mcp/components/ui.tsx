"use client";
// The shared parts every page is built from, so pages stay consistent: the page header, a labelled field, a stat card,
// an empty state, a notice strip, a settings toggle and a small popover menu. Styles in app/globals.css; rules in
// docs/DESIGN.md.
import { CaretRight } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import { Info } from "./Info";
import { PageScene, sceneFor } from "./pixel";
import { Floating, useDismiss } from "./pop";

/** Every page opens with this: the page's name as the H1, one short line under it, at most two actions, and the page's
 *  own small pixel scene (picked from the address; `scene={false}` leaves it out). */
export function PageHeader({ title, eyebrow, sub, actions, className, scene }: { title: React.ReactNode; eyebrow?: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; className?: string; scene?: string | false }) {
  const path = usePathname();
  const name = scene === false ? undefined : scene ?? sceneFor(path ?? "");
  return (
    <header className={`ph ${className ?? ""}`}>
      <div className="ph-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {name && <PageScene name={name} className="ph-scene" />}
      {actions && <div className="ph-actions">{actions}</div>}
    </header>
  );
}

/** A label wired to its control (htmlFor/id), with an optional ⓘ and hint. The child is a single input/select/textarea. */
export function Field({ label, info, hint, children, className, style }: {
  label: React.ReactNode; info?: React.ReactNode; hint?: React.ReactNode; children: React.ReactElement<{ id?: string; "aria-describedby"?: string }>;
  className?: string; style?: React.CSSProperties;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const child = isValidElement(children) ? cloneElement(children, { id: children.props.id ?? id, "aria-describedby": hintId }) : children;
  return (
    <div className={`field ${className ?? ""}`} style={style}>
      <label className="f" htmlFor={children.props.id ?? id}>{label}{info && <Info label={typeof label === "string" ? label : undefined}>{info}</Info>}</label>
      {child}
      {hint && <div className="hint" id={hintId}>{hint}</div>}
    </div>
  );
}

/** Tasklify-style summary card: an icon, a number, what it counts, and an optional link. */
export function StatCard({ icon, value, label, href, linkLabel = "View", onClick, children }: {
  icon: React.ReactNode; value: React.ReactNode; label: React.ReactNode; href?: string; linkLabel?: string; onClick?: () => void; children?: React.ReactNode;
}) {
  const inner = (
    <>
      <div className="sc-top">
        <span className="sc-ic" aria-hidden>{icon}</span>
        {(href || onClick) && <span className="sc-link">{linkLabel} <CaretRight size={12} weight="bold" /></span>}
      </div>
      <div>
        <div className="sc-v">{value}</div>
        <div className="sc-k">{label}</div>
      </div>
      {children}
    </>
  );
  if (href) return <Link href={href} className="stat-card">{inner}</Link>;
  if (onClick) return <button type="button" className="stat-card" onClick={onClick}>{inner}</button>;
  return <div className="stat-card">{inner}</div>;
}

export function Empty({ icon, art, title, children, action }: { icon?: React.ReactNode; art?: React.ReactNode; title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      {art}
      {icon && <span className="e-ic" aria-hidden>{icon}</span>}
      <b>{title}</b>
      {children && <span>{children}</span>}
      {action}
    </div>
  );
}

/** A full-width strip for system state ("The GPU is off") with one action. */
export function Notice({ icon, tone, children, action }: { icon: React.ReactNode; tone?: "bad" | "warn" | "ok"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`notice ${tone ?? ""}`} role={tone === "bad" ? "status" : undefined}>
      <span className="n-ic" aria-hidden>{icon}</span>
      <div className="n-text">{children}</div>
      {action}
    </div>
  );
}

/** A settings row: what it does, a sentence of detail, and a switch. */
export function Toggle({ on, set, title, about }: { on: boolean; set: (v: boolean) => void; title: string; about?: React.ReactNode }) {
  return (
    <div className="toggle-row">
      <div style={{ minWidth: 0 }}>
        <div className="tr-t">{title}</div>
        {about && <div className="tr-d">{about}</div>}
      </div>
      <button type="button" role="switch" aria-checked={on} className={`switch ${on ? "on" : ""}`} onClick={() => set(!on)} aria-label={title} />
    </div>
  );
}

/** A small popover menu anchored to its trigger, kept on screen. Escape or a click outside closes it; focus returns to
 *  the trigger. */
export function PopMenu({ trigger, children, align = "right", up = false, width }: {
  trigger: (p: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode; align?: "left" | "right"; up?: boolean; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); ref.current?.focus(); };
  useDismiss(open, () => setOpen(false), [ref, box]);
  useEffect(() => {
    if (open) setTimeout(() => box.current?.querySelector<HTMLElement>("button, a")?.focus(), 0);
  }, [open]);
  return (
    <>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref })}
      <Floating anchor={ref} open={open} boxRef={box} prefer={up ? "top" : "bottom"} align={align === "left" ? "start" : "end"} className="popmenu" role="menu" style={{ width }}>
        {children(close)}
      </Floating>
    </>
  );
}

/** The layout every tool page shares (Re-voice, Clean-up, Subtitles, Images): the header, an optional notice, then the
 *  work on a canvas on the left and its settings in a panel on the right, with the one primary action at the panel's
 *  foot. On phones the panel stacks under the canvas. */
export function ToolPage({ title, sub, actions, notice, side, sideLabel = "Settings", children }: {
  title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; notice?: React.ReactNode; side: React.ReactNode; sideLabel?: string; children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} sub={sub} actions={actions} />
      {notice}
      <div className="tool">
        <div className="tool-main">{children}</div>
        <aside className="tool-side" aria-label={sideLabel}>{side}</aside>
      </div>
    </>
  );
}

/** One setting in a side panel: its label (wired with htmlFor), an optional ⓘ and a note on the right. */
export function SideRow({ label, htmlFor, info, aside, children }: { label: React.ReactNode; htmlFor?: string; info?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="sr-h"><span className="sr-l">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}{info && <Info label={typeof label === "string" ? label : undefined}>{info}</Info>}</span>{aside && <span className="aside">{aside}</span>}</div>
      {children}
    </div>
  );
}

/** A big drop target for files: click to choose, or drop. */
export function DropZone({ icon, title, hint, accept, multiple, onFiles }: { icon: React.ReactNode; title: string; hint?: string; accept: string; multiple?: boolean; onFiles: (f: File[]) => void }) {
  const [over, setOver] = useState(false);
  return (
    <label className={`dropzone ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files)); }}>
      <span className="dz-ic" aria-hidden>{icon}</span>
      <b>{title}</b>
      {hint && <span>{hint}</span>}
      <input type="file" accept={accept} multiple={multiple} hidden onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    </label>
  );
}
