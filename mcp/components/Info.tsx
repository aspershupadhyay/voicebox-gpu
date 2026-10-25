"use client";
// The quiet way to explain: an (i) that shows one or two plain sentences on hover (mouse), on keyboard focus, or on a
// tap (touch), instead of a paragraph on the page. Use it for anything a first-time user might wonder about; never for
// what they must know to act (that belongs in the label itself). Pass `label` so screen readers hear "About Pace".
// The tip floats in a portal and is kept inside the screen, so it never runs off the edge of a panel or a phone.
import { Info as InfoIcon } from "@phosphor-icons/react";
import { useId, useRef, useState } from "react";
import { Floating, useDismiss } from "./pop";

export function Info({ children, side = "top", label }: { children: React.ReactNode; side?: "top" | "bottom"; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const pinned = useRef(false); // opened by a tap or click: stays until a tap outside, Escape or another tap
  useDismiss(open, () => { pinned.current = false; setOpen(false); }, [btn, tip]);
  // without a label, use the first words of the explanation so every (i) on a page has its own name
  const name = label ?? (typeof children === "string" ? children.split(/[.:;]/)[0].slice(0, 60) : "this");
  return (
    <span className={`info ${open ? "open" : ""}`}>
      <button ref={btn} type="button" className="info-btn" aria-label={`About ${name}`} aria-expanded={open} aria-describedby={open ? id : undefined}
        onPointerEnter={(e) => { if (e.pointerType === "mouse") setOpen(true); }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse" && !pinned.current) setOpen(false); }}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); pinned.current = !pinned.current || !open; setOpen(pinned.current); }}
        onKeyUp={(e) => { if (e.key === "Tab") setOpen(true); }}
        onBlur={() => { if (!pinned.current) setOpen(false); }}>
        <InfoIcon size={14} weight="regular" />
      </button>
      <Floating anchor={btn} open={open} prefer={side} align="center" boxRef={tip} role="tooltip" id={id} className="info-tip">{children}</Floating>
    </span>
  );
}

export default Info;
