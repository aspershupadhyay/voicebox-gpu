"use client";
// How the studio looks for you: your character (one of five pixel characters, saved to your account so it follows you
// and the other person sees it too) and your cursor (System, Studio or ASCII; kept in this browser). The ASCII cursors
// are drawn below as 1-bit bitmaps, one character per pixel ("X" outline, "o" fill), and turned into images at runtime.
import { Check } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { aw } from "./aw";
import { CHARACTERS, CHARACTER_IDS, characterFor, PixelAvatar, type Character } from "./pixel";

export type CursorStyle = "system" | "studio" | "ascii";
type Look = { avatar: Character | null; cursor: CursorStyle };
const KEY = "vb-look";
const read = (): Look => {
  try { const l = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return { avatar: l.avatar in CHARACTERS ? l.avatar : null, cursor: ["system", "studio", "ascii"].includes(l.cursor) ? l.cursor : "studio" }; }
  catch { return { avatar: null, cursor: "studio" }; }
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
const INK = "#0b0b0b", PAPER = "#f4f4f0", VIOLET = "#9b8fff"; // cursor images can't read CSS variables
function bitmap(rows: string[], px = 2) {
  const rects = rows.flatMap((r, y) => [...r].map((c, x) => (c === "X" || c === "o" ? `<rect x='${x * px}' y='${y * px}' width='${px}' height='${px}' fill='${c === "X" ? INK : PAPER}'/>` : ""))).join("");
  const w = Math.max(...rows.map((r) => r.length)) * px, h = rows.length * px;
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' shape-rendering='crispEdges'>${rects}</svg>`)}")`;
}
const arrow = (fill: string, stroke: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><path d='M4.5 2.5v17.2l4.6-4.3 3.1 6.8 3-1.4-3.1-6.6h6.3z' fill='${fill}' stroke='${stroke}' stroke-width='1.4' stroke-linejoin='round'/></svg>`)}")`;
const CURSORS: Record<Exclude<CursorStyle, "system">, { def: string; ptr: string }> = {
  studio: { def: `${arrow(PAPER, INK)} 4 2, auto`, ptr: `${arrow(VIOLET, PAPER)} 4 2, pointer` },
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
let synced = false;
export function useLook() {
  const [look, setLook] = useState<Look>({ avatar: null, cursor: "studio" });
  useEffect(() => {
    setLook(read());
    const on = () => setLook(read());
    addEventListener("vb-look", on);
    // once per visit, take the character saved to the account (it may have been picked on another device)
    if (!synced) {
      synced = true;
      aw().account.getPrefs().then((p) => {
        const a = (p as { avatar?: string })?.avatar;
        if (a && a in CHARACTERS && a !== read().avatar) save({ avatar: a as Character }, false);
      }).catch(() => {});
    }
    return () => removeEventListener("vb-look", on);
  }, []);
  return look;
}
function save(part: Partial<Look>, toAccount = true) {
  const next = { ...read(), ...part };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  if (part.cursor) applyCursor(part.cursor);
  dispatchEvent(new Event("vb-look"));
  if (toAccount && part.avatar) aw().account.getPrefs().then((p) => aw().account.updatePrefs({ prefs: { ...p, avatar: part.avatar } })).catch(() => {});
}
/** Put the saved cursor on, as early as the frame mounts. */
export function useCursor() { useEffect(() => { applyCursor(read().cursor); }, []); }

// ───────────── Settings → Profile: pick your character and your cursor
const CURSOR_OPTS: { id: CursorStyle; name: string; about: string }[] = [
  { id: "studio", name: "Studio", about: "A crisp arrow; violet over things you can click" },
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
                <span className="look-cur-demo" aria-hidden>{o.id === "ascii" ? <AsciiPreview /> : o.id === "studio" ? <StudioPreview /> : <SystemPreview />}</span>
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
const StudioPreview = () => <svg width="24" height="24" viewBox="0 0 24 24"><path d="M4.5 2.5v17.2l4.6-4.3 3.1 6.8 3-1.4-3.1-6.6h6.3z" className="lc-paper" stroke="var(--on-ink)" strokeWidth="1.4" strokeLinejoin="round" /></svg>;
const SystemPreview = () => <svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3v16l4-4 3 7 2.6-1.2-3-6.8H17z" className="lc-mute" /></svg>;
