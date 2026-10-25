"use client";
// The quiet way to explain: an (i) that shows one or two plain sentences on hover, focus or tap, instead of a
// paragraph on the page. Use it for anything a first-time user might wonder about; never for what they must know
// to act (that belongs in the label itself). Pass `label` so screen readers hear "About Pace", not "More info".
import { Info as InfoIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";

export function Info({ children, side = "top", label }: { children: React.ReactNode; side?: "top" | "bottom"; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  // without a label, use the first words of the explanation so every (i) on a page has its own name
  const name = label ?? (typeof children === "string" ? children.split(/[.:;]/)[0].slice(0, 60) : "this");
  return (
    <span ref={ref} className={`info ${open ? "open" : ""} ${side}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="info-btn" aria-label={`About ${name}`} aria-expanded={open} aria-describedby={open ? id : undefined}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        <InfoIcon size={14} weight="regular" />
      </button>
      {open && <span role="tooltip" id={id} className="info-tip">{children}</span>}
    </span>
  );
}

export default Info;
