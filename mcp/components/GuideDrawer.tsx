"use client";
import { BookOpenText, Info, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { GUIDES, LANGUAGES, VIDEO_GUIDES } from "./guides";

export function GuideButton({ engine, label = "Writing guide" }: { engine: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ghost sm" onClick={() => setOpen(true)} title="How to write for this engine">
        {label === "Writing guide" ? <BookOpenText size={15} weight="duotone" /> : <Info size={15} weight="duotone" />}
        {label}
      </button>
      {open && <GuideDrawer initial={engine} onClose={() => setOpen(false)} />}
    </>
  );
}

export default function GuideDrawer({ initial, onClose }: { initial: string; onClose: () => void }) {
  const video = initial in VIDEO_GUIDES;
  const set = video ? VIDEO_GUIDES : GUIDES;
  const [tab, setTab] = useState(initial in set ? initial : "orpheus");
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  const g = set[tab];
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer guide" role="dialog" aria-label="Writing guide">
        <div className="row between"><div className="eyebrow" style={{ margin: 0 }}>{video ? "Prompting guide" : "Writing guide"}</div><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="seg" style={{ margin: "16px 0 22px", flexWrap: "wrap" }}>
          {[...Object.keys(set), ...(video ? [] : ["languages"])].map((k) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k === "languages" ? "Languages" : set[k].title.split(" ·")[0]}</button>
          ))}
        </div>
        {tab === "languages" ? (
          <>
            <h3>Which engine speaks what</h3>
            <p>Orpheus is English only. Chatterbox covers 23 languages and can clone a voice; Qwen clones best, in 10 languages. Kokoro has fixed voices in 9 languages. Whisper subtitles all of them (and 99 in total). Always write in the language's native script.</p>
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
            <h3>{g.title}</h3>
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
