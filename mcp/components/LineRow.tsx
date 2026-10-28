"use client";
import { ThumbsDown, ThumbsUp } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, fileUrl, matchClass, pct, simClass, type Cleanup, type Review, type Word } from "./api";
import Player from "./Player";

export type Line = {
  id: string; text: string; duration: number; window?: number | null; fits?: boolean | null; heard?: string;
  match?: number | null; subs?: boolean; name?: string; chunks?: number;
  lufs?: number | null; similarity?: number | null; spoken?: string; engine?: string; takes?: { n: number; picked: number[]; match: number; similarity: number | null };
  review?: Review | null; diff?: { missed: string[]; added: string[] } | null; cleanup?: Cleanup | null;
};

const issueText = (r: Review) => r.issues.map((i) => `sentence ${i.chunk}: ${[i.missed.length ? `missed “${i.missed.join(" ")}”` : "", i.added.length ? `added “${i.added.join(" ")}”` : "", i.similarity != null && !i.missed.length && !i.added.length ? `voice ${pct(i.similarity)}` : ""].filter(Boolean).join(", ")}`).join("\n");

/** A trained voice (Your model, or a fine-tuned ft_ voice on Qwen3-TTS): its lines can be rated for the voice coach. */
export const coached = (engine?: string, voice?: string) => engine === "myvoice" || (engine === "qwen" && !!voice?.startsWith("ft_"));

/** Thumbs up / down on a line. Kept per voice with the line's scores (lib/ratings.ts); for a trained voice the coach
 *  also learns from it what to ask you to record next. */
export function Rate({ jobId, line, voice, initial }: { jobId: string; line: Line; voice: { engine: string; voice: string }; initial?: number }) {
  const key = `vb-rate-${jobId}-${line.id}`;
  const [r, setR] = useState(0);
  useEffect(() => { try { setR(initial ?? (Number(localStorage.getItem(key)) || 0)); } catch {} }, [key, initial]);
  const send = (v: number) => {
    const next = r === v ? 0 : v;
    setR(next);
    try { localStorage.setItem(key, String(next)); } catch {}
    api("coach/rate", { body: { ...voice, job: jobId, line: line.id, rating: next, text: line.text, duration: line.duration, match: line.match, sim: line.similarity } }).catch(() => setR(r));
  };
  return (
    <span className="row" style={{ gap: 2 }} title="Rate this line: your ratings are kept with its scores to steer this voice">
      <button className={`icon-btn ${r === 1 ? "on" : ""}`} aria-label="Sounds good" onClick={() => send(1)}><ThumbsUp size={14} weight={r === 1 ? "fill" : "regular"} /></button>
      <button className={`icon-btn ${r === -1 ? "on" : ""}`} aria-label="Sounds off" onClick={() => send(-1)}><ThumbsDown size={14} weight={r === -1 ? "fill" : "regular"} /></button>
    </span>
  );
}

/** One voice line: player (+ karaoke words when subtitled), fit/match badges, downloads. */
export default function LineRow({ jobId, line, audio, slug, onEnded, playRef, words: given, scale, rate }: {
  jobId: string; line: Line; audio?: string | null; slug: string; onEnded?: () => void;
  playRef?: (fn: () => void) => void; words?: Word[] | null; scale?: number; rate?: { engine: string; voice: string } | null;
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
        {audio ? <Player src={audio} words={words} duration={line.duration} onEnded={onEnded} playRef={playRef} scale={scale} />
          : words ? <div className="words">{words.map((w) => w.w).join(" ")}</div> : null}
        {!words && line.text && <div className="txt">{line.text}</div>}
        {showHeard && line.heard && <div className="small dim">Whisper heard: “{line.heard}”</div>}
        {showHeard && line.spoken && <div className="small dim">Voice read: “{line.spoken}”</div>}
        {showHeard && line.diff && (line.diff.missed.length > 0 || line.diff.added.length > 0) && (
          <div className="small dim">{line.diff.missed.length > 0 && <>Not heard: <b>{line.diff.missed.join(" ")}</b>. </>}{line.diff.added.length > 0 && <>Extra: <b>{line.diff.added.join(" ")}</b>.</>}</div>
        )}
      </div>
      <div className="side-meta">
        <div className="row" style={{ gap: 6 }}>
          {line.fits === false && <span className="pill bad" title={`window ${line.window}s`}>over {line.window}s</span>}
          {line.fits === true && <span className="pill ok">fits</span>}
          {line.similarity != null && <span className={`pill ${simClass(line.similarity)}`} title="Voice match vs your recording (speaker embedding; 0.86+ = same speaker)">voice {pct(line.similarity)}</span>}
          {line.lufs != null && <span className="pill" title="Integrated loudness after mastering">{line.lufs.toFixed(0)} LUFS</span>}
          {line.review && line.review.issues.length > 0 && <span className="pill warn" title={`Still off after retries:\n${issueText(line.review)}`}>check {line.review.issues.length}</span>}
          {line.review && line.review.fixed > 0 && <span className="pill ok" title="The review heard a sentence miss the script or the voice and re-voiced it">fixed {line.review.fixed}</span>}
          {line.takes && line.takes.n > 1 && <span className="pill" title={`Best of ${line.takes.n}: picked take ${line.takes.picked.join(", ")} (per sentence)`}>best of {line.takes.n}</span>}
          {line.engine && <span className="pill" title="Voiced by a different engine in the same voice">{line.engine}</span>}
          {line.match != null && <button className={`pill ${matchClass(line.match)}`} style={{ cursor: "var(--cur-pointer, pointer)" }} onClick={() => setShowHeard(!showHeard)} title="How closely the subtitles match your script (click to see what was heard)">match {pct(line.match)}</button>}
        </div>
        <div className="dl">
          {rate && audio && <Rate jobId={jobId} line={line} voice={rate} />}
          {audio && <a href={fileUrl(jobId, `${line.id}.wav`, `${slug}-${line.id}.wav`)} title="Download WAV">wav</a>}
          {line.subs && <><a href={fileUrl(jobId, `${line.id}.subs.srt`, `${slug}-${line.id}.srt`)} title="Download SRT">srt</a><a href={fileUrl(jobId, `${line.id}.subs.vtt`, `${slug}-${line.id}.vtt`)} title="Download VTT">vtt</a></>}
        </div>
      </div>
    </div>
  );
}
