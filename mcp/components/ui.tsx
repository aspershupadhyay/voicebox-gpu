"use client";
// The shared parts every page is built from, so pages stay consistent: the page header, a labelled field, a stat card,
// an empty state, a notice strip, a settings toggle and a small popover menu. Styles in app/globals.css; rules in
// docs/DESIGN.md.
import { CaretRight } from "@phosphor-icons/react";
import Link from "next/link";
import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import { Info } from "./Info";

/** Every page opens with this: the page's name as the H1, one short line under it, and at most two actions. */
export function PageHeader({ title, eyebrow, sub, actions }: { title: React.ReactNode; eyebrow?: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="ph">
      <div className="ph-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
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

/** A small popover menu anchored to its trigger. Escape or a click outside closes it; focus returns to the trigger. */
export function PopMenu({ trigger, children, align = "right", up = false, width }: {
  trigger: (p: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode; align?: "left" | "right"; up?: boolean; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); ref.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", k);
    setTimeout(() => box.current?.querySelector<HTMLElement>("button, a")?.focus(), 0);
    return () => window.removeEventListener("keydown", k);
  }, [open]);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref })}
      {open && (
        <>
          <div className="pop-scrim" onClick={() => setOpen(false)} />
          <div ref={box} className="popmenu" role="menu" style={{ [align]: 0, [up ? "bottom" : "top"]: "calc(100% + 6px)", width }}>{children(close)}</div>
        </>
      )}
    </span>
  );
}
