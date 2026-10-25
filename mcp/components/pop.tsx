"use client";
// Floating things that follow the studio's theme instead of the device's: a Select (our own listbox, never the
// browser's native menu), the placement maths they share with Info, and useDismiss, which closes any open popup on a
// click outside it or on Escape. Floating parts render in a portal with fixed positioning, so a scrolling panel or an
// overflow:hidden card never clips them, and they're clamped to the viewport on phones.
import { Check, CaretDown } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GAP = 6, EDGE = 8;

/** Close on a pointer down outside every element in `inside`, or on Escape. */
export function useDismiss(open: boolean, close: () => void, inside: React.RefObject<HTMLElement | null>[]) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!inside.some((r) => r.current?.contains(t))) latest.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); latest.current(); } };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** Where a floating box goes next to its anchor: below (or above when there's no room), aligned, kept on screen. */
export function place(a: DOMRect, w: number, h: number, prefer: "top" | "bottom" = "bottom", align: "start" | "center" | "end" = "start") {
  const vw = window.innerWidth, vh = window.innerHeight;
  const below = vh - a.bottom - GAP - EDGE, above = a.top - GAP - EDGE;
  const side = prefer === "top" ? (above >= h || above >= below ? "top" : "bottom") : (below >= h || below >= above ? "bottom" : "top");
  let left = align === "start" ? a.left : align === "end" ? a.right - w : a.left + a.width / 2 - w / 2;
  left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
  const room = side === "bottom" ? below : above;
  const top = side === "bottom" ? a.bottom + GAP : a.top - GAP - Math.min(h, room);
  return { left, top: Math.max(EDGE, top), maxHeight: Math.max(120, room), side };
}

/** A box floating next to an anchor, in a portal, repositioned on scroll and resize. */
export function Floating({ anchor, open, children, prefer = "bottom", align = "start", matchWidth, className, style, boxRef, ...rest }: {
  anchor: React.RefObject<HTMLElement | null>; open: boolean; children: React.ReactNode; prefer?: "top" | "bottom"; align?: "start" | "center" | "end";
  matchWidth?: boolean; className?: string; style?: React.CSSProperties; boxRef?: React.RefObject<HTMLDivElement | null>;
} & React.HTMLAttributes<HTMLDivElement>) {
  const own = useRef<HTMLDivElement>(null);
  const ref = boxRef ?? own;
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number; width?: number; side: string } | null>(null);
  const update = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect(), el = ref.current;
    if (!a || !el) return;
    const width = matchWidth ? Math.max(a.width, 200) : undefined;
    const w = Math.min(width ?? el.offsetWidth, window.innerWidth - EDGE * 2);
    setPos({ ...place(a, w, el.scrollHeight, prefer, align), width: matchWidth ? w : undefined });
  }, [anchor, ref, matchWidth, prefer, align]);
  useLayoutEffect(() => { if (open) update(); else setPos(null); }, [open, update]);
  useEffect(() => {
    if (!open) return;
    addEventListener("resize", update);
    addEventListener("scroll", update, true);
    return () => { removeEventListener("resize", update); removeEventListener("scroll", update, true); };
  }, [open, update]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} className={`floating ${pos?.side ?? ""} ${className ?? ""}`} {...rest}
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? 0, maxHeight: pos?.maxHeight, width: pos?.width, visibility: pos ? "visible" : "hidden", ...style }}>
      {children}
    </div>,
    document.body,
  );
}

export type Opt<T> = { value: T; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean; text?: string };
const norm = <T,>(o: Opt<T> | readonly [T, React.ReactNode]): Opt<T> => (Array.isArray(o) ? { value: o[0], label: o[1] } : (o as Opt<T>));
const textOf = (o: Opt<unknown>) => o.text ?? (typeof o.label === "string" ? o.label : String(o.value));

/** A themed drop-down: a button showing the choice and a listbox of options (arrow keys, Home/End, type to jump,
 *  Enter to pick, Escape or a click outside to close). Options are `[value, label]` pairs or `{value, label, hint}`. */
export function Select<T extends string | number>({ value, onChange, options, id, label, disabled, className, size, placeholder, style, "aria-describedby": describedBy }: {
  value: T; onChange: (v: T) => void; options: readonly (Opt<T> | readonly [T, React.ReactNode])[]; id?: string; label?: string;
  disabled?: boolean; className?: string; size?: "sm"; placeholder?: string; style?: React.CSSProperties; "aria-describedby"?: string;
}) {
  const opts = options.map(norm);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const typed = useRef({ s: "", t: 0 });
  const current = opts.find((o) => o.value === value);
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  useDismiss(open, () => close(false), [btn, box]);

  function show() {
    if (disabled) return;
    setActive(Math.max(0, opts.findIndex((o) => o.value === value)));
    setOpen(true);
  }
  useEffect(() => { if (open) requestAnimationFrame(() => list.current?.focus({ preventScroll: true })); }, [open]);
  useEffect(() => { if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, active]);

  const step = (from: number, d: number) => {
    for (let i = 1; i <= opts.length; i++) { const k = (from + d * i + opts.length * 2) % opts.length; if (!opts[k].disabled) return k; }
    return from;
  };
  const pick = (i: number) => { const o = opts[i]; if (!o || o.disabled) return; onChange(o.value); close(); };
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => step(a, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => step(a, -1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(step(-1, 1)); }
    else if (e.key === "End") { e.preventDefault(); setActive(step(opts.length, -1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
    else if (e.key === "Tab") close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      typed.current = { s: (now - typed.current.t < 700 ? typed.current.s : "") + e.key.toLowerCase(), t: now };
      const k = opts.findIndex((o) => !o.disabled && textOf(o).toLowerCase().startsWith(typed.current.s));
      if (k >= 0) setActive(k);
    }
  }

  return (
    <>
      <button ref={btn} type="button" id={id} className={`select ${size ?? ""} ${open ? "open" : ""} ${className ?? ""}`} style={style} disabled={disabled}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${uid}-list` : undefined} aria-label={label} aria-describedby={describedBy}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); show(); } }}>
        <span className="select-v">{current ? current.label : <span className="select-ph">{placeholder ?? "Choose…"}</span>}</span>
        <CaretDown size={13} weight="bold" className="select-c" aria-hidden />
      </button>
      <Floating anchor={btn} open={open} matchWidth boxRef={box} className="listbox-pop">
        <div ref={list} id={`${uid}-list`} role="listbox" tabIndex={-1} aria-label={label} onKeyDown={onKey}
          aria-activedescendant={opts[active] ? `${uid}-o${active}` : undefined}>
          {opts.map((o, i) => (
            <div key={String(o.value)} id={`${uid}-o${i}`} data-i={i} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
              className={`lb-opt ${i === active ? "active" : ""}`} onPointerMove={() => !o.disabled && setActive(i)} onClick={() => pick(i)}>
              <span className="lb-t"><span>{o.label}</span>{o.hint && <small>{o.hint}</small>}</span>
              {o.value === value && <Check size={14} weight="bold" className="lb-check" aria-hidden />}
            </div>
          ))}
        </div>
      </Floating>
    </>
  );
}
