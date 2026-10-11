"use client";
import { useEffect, useState } from "react";
import { GUIDES, LANGUAGES } from "./guides";

export function GuideButton({ engine, label = "Writing guide" }: { engine: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ghost sm" onClick={() => setOpen(true)} title="How to write for this engine">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6M12 7.5v.01" strokeLinecap="round" /></svg>
        {label}
      </button>
      {open && <GuideDrawer initial={engine} onClose={() => setOpen(false)} />}
    </>
  );
}

export default function GuideDrawer({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [tab, setTab] = useState(initial in GUIDES ? initial : "orpheus");
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  const g = GUIDES[tab];
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer guide" role="dialog" aria-label="Writing guide">
        <div className="row between"><h2 style={{ margin: 0 }}>Writing guide</h2><button className="ghost xs" onClick={onClose}>Esc</button></div>
        <div className="chips" style={{ margin: "14px 0 18px" }}>
          {[...Object.keys(GUIDES), "languages"].map((k) => (
            <button key={k} className={`chip ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{k === "languages" ? "Languages" : GUIDES[k].title.split(" ·")[0]}</button>
          ))}
        </div>
        {tab === "languages" ? (
          <>
            <h3>Which engine speaks what</h3>
            <p>Orpheus is English only. Chatterbox covers 23 languages and can clone a voice. Kokoro has fixed voices in 9 languages. Whisper subtitles all of them (and 99 in total). Always write in the language's native script.</p>
            <table className="table small">
              <thead><tr><th>Language</th><th>Voice engines</th><th>Kokoro voices</th></tr></thead>
              <tbody>
                {LANGUAGES.map((l) => (
                  <tr key={l.code}>
                    <td><b>{l.name}</b> <span className="mono dim">{l.code}</span>{l.script && <div className="dim tiny">write in {l.script}</div>}</td>
                    <td className="small">{l.engines.filter((e) => e !== "whisper").join(", ")}</td>
                    <td className="mono tiny dim">{l.kokoro?.join(" ") ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <>
            <h3 style={{ fontSize: 19 }}>{g.title}</h3>
            <p style={{ marginTop: 6 }}>{g.tagline}</p>
            {g.sections.map((s) => (
              <section key={s.h}>
                <h4>{s.h}</h4>
                <ul>{s.body.map((b) => <li key={b}>{b}</li>)}</ul>
                {s.example && <div className="ex">{s.example}</div>}
              </section>
            ))}
          </>
        )}
      </aside>
    </>
  );
}
