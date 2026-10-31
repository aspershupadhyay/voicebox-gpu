"use client";
// How the studio looks for you: your character (one of five pixel characters, saved to your account so it follows you
// and the other person sees it too) and your cursor (Arrow, ASCII or System; kept in this browser). The ASCII cursors
// are drawn below as 1-bit bitmaps, one character per pixel ("X" outline, "o" fill), and turned into images at runtime.
// Every click drops a small ginger ripple where it lands (Miso's colour), like a drop on water.
import { Check } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { CHARACTERS, CHARACTER_IDS, characterFor, PixelAvatar, type Character } from "./pixel";

export type CursorStyle = "system" | "arrow" | "ascii";
type Look = { avatar: Character | null; cursor: CursorStyle };
const KEY = "vb-look";
const read = (): Look => {
  try { const l = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return { avatar: l.avatar in CHARACTERS ? l.avatar : null, cursor: ["system", "arrow", "ascii"].includes(l.cursor) ? l.cursor : "arrow" }; }
  catch { return { avatar: null, cursor: "arrow" }; }
};

// ───────────── the cursors
const ASCII_ARROW = [
  "X...........", "XX..........", "XoX.........", "XooX........", "XoooX.......", "XooooX......", "XoooooX.....", "XooooooX....",
  "XoooooooX...", "XooooooooX..", "XoooooXXXXX.", "XooXooX.....", "XoX.XooX....", "XX..XooX....", "X....XooX...", ".....XXX....",
];
const ASCII_HAND = [
  "....XX.........", "...XooX........", "...XooX........", "...XooX........", "...XooXXX......", "...XooXooXXX...", ".XXXooXooXooXX.", "XooXooooooooXoX",
  "XooooooooooooX.", ".XoooooooooooX.", "..XoooooooooooX", "..XooooooooooX.", "...XoooooooooX.", "....XooooooooX.", "....XooooooooX.", "....XXXXXXXXXX.",
];
const INK = "#0b0b0b", PAPER = "#f4f4f0", GINGER = "#eda76a"; // cursor images can't read CSS variables
function bitmap(rows: string[], px = 2) {
  const rects = rows.flatMap((r, y) => [...r].map((c, x) => (c === "X" || c === "o" ? `<rect x='${x * px}' y='${y * px}' width='${px}' height='${px}' fill='${c === "X" ? INK : PAPER}'/>` : ""))).join("");
  const w = Math.max(...rows.map((r) => r.length)) * px, h = rows.length * px;
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' shape-rendering='crispEdges'>${rects}</svg>`)}")`;
}
/** The arrowhead: a solid tip with a notch at the back, tilted like a paper plane. */
export const ARROW_PATH = "M3.2 2.6 20.4 9.6 12.6 11.9 9.9 19.8z";
const arrow = (fill: string, stroke: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><path d='${ARROW_PATH}' fill='${fill}' stroke='${stroke}' stroke-width='1.3' stroke-linejoin='round'/></svg>`)}")`;
const CURSORS: Record<Exclude<CursorStyle, "system">, { def: string; ptr: string }> = {
  arrow: { def: `${arrow(PAPER, INK)} 3 3, auto`, ptr: `${arrow(GINGER, INK)} 3 3, pointer` },
  ascii: { def: `${bitmap(ASCII_ARROW)} 0 0, auto`, ptr: `${bitmap(ASCII_HAND)} 8 1, pointer` },
};
function applyCursor(c: CursorStyle) {
  const el = document.documentElement;
  el.classList.toggle("cur-custom", c !== "system");
  if (c === "system") { el.style.removeProperty("--cur-default"); el.style.removeProperty("--cur-pointer"); return; }
  el.style.setProperty("--cur-default", CURSORS[c].def);
  el.style.setProperty("--cur-pointer", CURSORS[c].ptr);
}

// ───────────── the hook
export function useLook() {
  const [look, setLook] = useState<Look>({ avatar: null, cursor: "arrow" });
  useEffect(() => {
    setLook(read());
    const on = () => setLook(read());
    addEventListener("vb-look", on);
    return () => removeEventListener("vb-look", on);
  }, []);
  return look;
}
function save(part: Partial<Look>, toAccount = true) {
  const next = { ...read(), ...part };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  if (part.cursor) applyCursor(part.cursor);
  dispatchEvent(new Event("vb-look"));
}
/** Put the saved cursor on as the frame mounts, and drop a ripple wherever you click (one element per click, gone when
 *  its animation ends; nothing for reduced motion). */
export function useCursor() {
  useEffect(() => {
    applyCursor(read().cursor);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const drop = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch" && !e.isPrimary) return;
      const d = document.createElement("span");
      d.className = "drop-fx";
      d.style.left = `${e.clientX}px`; d.style.top = `${e.clientY}px`;
      d.innerHTML = "<i></i><i></i><b></b>";
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 900);
    };
    addEventListener("pointerdown", drop, { passive: true });
    return () => removeEventListener("pointerdown", drop);
  }, []);
}

// ───────────── Settings → Profile: pick your character and your cursor
const CURSOR_OPTS: { id: CursorStyle; name: string; about: string }[] = [
  { id: "arrow", name: "Arrow", about: "A sharp white arrowhead; ginger over things you can click" },
  { id: "ascii", name: "ASCII", about: "An arrow and a hand drawn pixel by pixel, the old-computer way" },
  { id: "system", name: "System", about: "Your computer's own cursor" },
];
export function LookCard({ name }: { name: string }) {
  const look = useLook();
  const mine = characterFor(name, look.avatar);
  return (
    <section className="card b-6 look-card">
      <div className="card-head"><div><h2>Look</h2><p className="sub">Your character shows wherever you do; the cursor is just for this browser.</p></div></div>
      <div className="look-grid">
        <div>
          <h3 className="an-h3" id="look-char">Your character</h3>
          <div className="look-chars" role="radiogroup" aria-labelledby="look-char">
            {CHARACTER_IDS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={mine === c} className={`look-char ${mine === c ? "on" : ""}`} onClick={() => save({ avatar: c })}>
                <PixelAvatar name={name} char={c} size={56} />
                <b>{CHARACTERS[c].name}</b><span className="tiny dim">{CHARACTERS[c].about}</span>
                {mine === c && <Check size={13} weight="bold" className="look-tick" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
        <div>
          <h3 className="an-h3" id="look-cur">Cursor</h3>
          <div className="look-curs" role="radiogroup" aria-labelledby="look-cur">
            {CURSOR_OPTS.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={look.cursor === o.id} className={`look-cur c-${o.id} ${look.cursor === o.id ? "on" : ""}`} onClick={() => save({ cursor: o.id })}
                style={o.id === "system" ? undefined : { cursor: CURSORS[o.id].def }}>
                <span className="look-cur-demo" aria-hidden>{o.id === "ascii" ? <AsciiPreview /> : o.id === "arrow" ? <ArrowPreview /> : <SystemPreview />}</span>
                <span><b>{o.name}</b><span className="tiny dim">{o.about}</span></span>
              </button>
            ))}
          </div>
          <p className="tiny dim" style={{ marginTop: 10 }}>Hover a choice to try it before you pick.</p>
        </div>
      </div>
    </section>
  );
}
const AsciiPreview = () => (
  <svg width="24" height="32" viewBox="0 0 12 16" shapeRendering="crispEdges">
    {ASCII_ARROW.flatMap((r, y) => [...r].map((c, x) => (c === "X" ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className="lc-ink" /> : c === "o" ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className="lc-paper" /> : null)))}
  </svg>
);
const ArrowPreview = () => <svg width="24" height="24" viewBox="0 0 24 24"><path d={ARROW_PATH} className="lc-paper" stroke="var(--on-ink)" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
const SystemPreview = () => <svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3v16l4-4 3 7 2.6-1.2-3-6.8H17z" className="lc-mute" /></svg>;
