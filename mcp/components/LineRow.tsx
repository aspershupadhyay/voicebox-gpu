"use client";
import { useEffect, useState } from "react";
import { fileUrl, matchClass, pct, type Word } from "./api";
import Player from "./Player";

export type Line = {
  id: string; text: string; duration: number; window?: number | null; fits?: boolean | null; heard?: string;
  match?: number | null; subs?: boolean; name?: string; chunks?: number;
};

/** One voice line: player (+ karaoke words when subtitled), fit/match badges, downloads. */
export default function LineRow({ jobId, line, audio, slug, onEnded, playRef, words: given }: {
  jobId: string; line: Line; audio?: string | null; slug: string; onEnded?: () => void;
  playRef?: (fn: () => void) => void; words?: Word[] | null;
}) {
  const [words, setWords] = useState<Word[] | null>(given ?? null);
  const [showHeard, setShowHeard] = useState(false);
  useEffect(() => {
    if (given || !line.subs) return;
    fetch(fileUrl(jobId, `${line.id}.subs.json`)).then((r) => (r.ok ? r.json() : null)).then((j) => j && setWords(j.words)).catch(() => {});
  }, [jobId, line.id, line.subs, given]);

  return (
    <div className="line reveal">
      <span className="lid">{line.id}</span>
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        {audio ? <Player src={audio} words={words} duration={line.duration} onEnded={onEnded} playRef={playRef} />
          : words ? <div className="words">{words.map((w) => w.w).join(" ")}</div> : null}
        {!words && line.text && <div className="txt">{line.text}</div>}
        {showHeard && line.heard && <div className="small dim">Heard: “{line.heard}”</div>}
      </div>
      <div className="stack" style={{ alignItems: "flex-end", gap: 6 }}>
        <div className="row" style={{ gap: 6 }}>
          {line.duration > 0 && <span className="mono small">{line.duration.toFixed(2)}s</span>}
          {line.fits === false && <span className="pill bad" title={`window ${line.window}s`}>over {line.window}s</span>}
          {line.fits === true && <span className="pill ok">fits</span>}
          {line.match != null && <button className={`pill ${matchClass(line.match)}`} style={{ cursor: "pointer" }} onClick={() => setShowHeard(!showHeard)} title="How closely the subtitles match your script (click to see what was heard)">match {pct(line.match)}</button>}
        </div>
        <div className="row tiny" style={{ gap: 8 }}>
          {audio && <a href={fileUrl(jobId, `${line.id}.wav`, `${slug}-${line.id}.wav`)}>wav</a>}
          {line.subs && <><a href={fileUrl(jobId, `${line.id}.subs.srt`, `${slug}-${line.id}.srt`)}>srt</a><a href={fileUrl(jobId, `${line.id}.subs.vtt`, `${slug}-${line.id}.vtt`)}>vtt</a></>}
        </div>
      </div>
    </div>
  );
}
