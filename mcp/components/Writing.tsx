"use client";
// The Writing room (/writing, Create): five tools as orbs (after the owner's poster), each opening at ?tool=… with the
// others shrunk into a rail. Hook score, Titles, Thumbnails, Captions and the Weekly digest, all scored against your own
// numbers (lib/writing.ts, no AI); "Ask Claude" copies a prompt that does the writing through the MCP tools, which score
// with the same rules. Under the orbs, your desk: every open post with where its writing stands.
import { ArrowLeft, ArrowSquareOut, Check, Copy, Fire, ImageSquare, Plus, Sparkle, Trash, X } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Fmt } from "@/lib/analytics";
import { spaceName, targetsOf, type SpaceId, type TargetMap } from "@/lib/spaces";
import type { Post } from "@/lib/workspace";
import type { WritingData } from "@/lib/writing-data";
import {
  adaptCaption, briefChecks, briefPrompt, CAPTION, captionLimit, EMOTIONS, fmtName, hookScore, scoreTitle, titleModel, weeklyDigest,
  type Brief, type Check as CheckT, type WItem,
} from "@/lib/writing";
import { compact, Score } from "./anparts";
import { api, useSeed } from "./api";
import { Query, useLive } from "./aw";
import { useDialog } from "./Dialog";
import { Constellation, Marble, OrbRail, RingScore, type OrbSpec, type Tone } from "./orbs";
import { PlatformBadge } from "./platform";
import { createPost, savePost } from "./PostDrawer";
import { Select } from "./pop";
import { Empty, Field, Notice, PageHeader } from "./ui";

type ToolId = "hooks" | "titles" | "thumbs" | "captions" | "digest";
const TOOLS: { id: ToolId; name: string; tone: Tone; curve: string; about: string; seed: number }[] = [
  { id: "hooks", name: "Hook score", tone: "ginger", curve: "…hooks that hold", about: "Score a script's opening and fix every weak line", seed: 1.3 },
  { id: "titles", name: "Titles", tone: "blue", curve: "…titles that win", about: "Test titles against what your hits do", seed: 4.1 },
  { id: "captions", name: "Captions", tone: "warn", curve: "…a caption for every platform", about: "One caption, fitted to X, Instagram, YouTube and more", seed: 2.6 },
  { id: "thumbs", name: "Thumbnails", tone: "violet", curve: "…thumbnails that stop the scroll", about: "Brief the image, check it, make it in Images", seed: 6.2 },
  { id: "digest", name: "Weekly digest", tone: "chart", curve: "…your week, in one read", about: "What worked, what rivals did, what to post next", seed: 3.4 },
];

const OPEN = (p: Post) => p.status !== "posted";
const fmtOf = (spaces: SpaceId[]): Fmt | null => (spaces.includes("yt_short") ? "yt_short" : spaces.includes("ig_reel") ? "ig_reel" : spaces.includes("yt_video") ? "yt_video" : spaces.includes("ig_post") ? "ig_post" : null);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}%`;

/* ───────────── data */

function useRoom() {
  const [data, setData] = useState<WritingData | null>(null);
  const [err, setErr] = useState("");
  useSeed<WritingData>("writing", setData);
  useEffect(() => { api<WritingData>("writing").then(setData, (e) => setErr((e as Error).message)); }, []);
  const { rows: posts, setRows } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(200)]);
  const [targets, setTargets] = useState<TargetMap>({});
  useSeed<{ posts: TargetMap }>("spaces", (s) => setTargets(s.posts));
  useEffect(() => { api<{ posts: TargetMap }>("spaces").then((s) => setTargets(s.posts)).catch(() => null); }, []);
  const model = useMemo(() => titleModel(data?.items ?? []), [data]);
  return { data, setData, err, posts, setRows, targets, model };
}
type Room = ReturnType<typeof useRoom>;

/** "Ask Claude": copies a prompt for Claude with the Voicebox connector, which writes through the MCP tools. */
function AskClaude({ prompt }: { prompt: string }) {
  const { toast } = useDialog();
  return (
    <button type="button" className="ghost sm" onClick={() => navigator.clipboard.writeText(prompt).then(() => toast("Copied. Paste it into Claude (with the Voicebox connector) and it writes from your numbers."), () => toast("Couldn't copy", "bad"))}
      title={prompt}>
      <Sparkle size={14} weight="duotone" />Ask Claude
    </button>
  );
}

/** The post the tool works on (open posts first), or "" for text you paste. */
function PostPick({ room, value, set, filter, empty = "Paste your own" }: { room: Room; value: string; set: (id: string) => void; filter?: (p: Post) => boolean; empty?: string }) {
  const opts = useMemo(() => [["", empty] as const, ...room.posts.filter(OPEN).filter(filter ?? (() => true)).slice(0, 80).map((p) => [p.$id, p.title || "Untitled"] as const)], [room.posts, filter, empty]);
  return <Field label="Post"><Select value={value} onChange={set} options={opts} label="Post" /></Field>;
}

function Checks({ checks }: { checks: CheckT[] }) {
  return (
    <ul className="wr-checks">
      {checks.map((c) => (
        <li key={c.id} className={c.ok ? "ok" : c.part > 0 ? "half" : "no"}>
          <span className="wr-ck" aria-hidden>{c.ok ? <Check size={12} weight="bold" /> : c.part > 0 ? "½" : <X size={12} weight="bold" />}</span>
          <span><b>{c.label}</b><span className="small dim">{c.why}</span></span>
          <span className="mono tiny wr-ck-w" aria-label={`${Math.round(c.weight * c.part)} of ${c.weight} points`}>{Math.round(c.weight * c.part)}/{c.weight}</span>
        </li>
      ))}
    </ul>
  );
}

/* ───────────── the page */

export default function Writing() {
  const q = useSearchParams();
  const tool = (TOOLS.find((t) => t.id === q.get("tool"))?.id ?? null) as ToolId | null;
  const postId = q.get("post") ?? "";
  const room = useRoom();
  const router = useRouter(), path = usePathname();
  const setPost = (id: string) => {
    const u = new URLSearchParams(q.toString());
    if (id) u.set("post", id); else u.delete("post");
    router.replace(`${path}?${u}`, { scroll: false });
  };
  const orbs = useOrbs(room, postId);
  const t = TOOLS.find((x) => x.id === tool);

  if (!t) return (
    <>
      <PageHeader title="Writing room" sub="Hooks, titles, thumbnails and captions, scored against what already works for you." scene="writing" />
      {room.err && !room.data && <Notice icon={<Fire size={16} />} tone="warn">Couldn&apos;t read your numbers ({room.err}). The tools still work on general rules.</Notice>}
      {room.data?.needs[0] && <Notice icon={<Fire size={16} />} tone="warn">{room.data.needs[0]}</Notice>}
      <Constellation orbs={orbs} />
      <Desk room={room} />
    </>
  );
  return (
    <div className="wr-open" key={t.id}>
      <PageHeader title={t.name} sub={t.about} scene={false} actions={<Link href="/writing" className="btn ghost sm"><ArrowLeft size={14} />All tools</Link>} />
      <OrbRail orbs={orbs} on={t.id} />
      {t.id === "hooks" && <HookTool room={room} postId={postId} setPost={setPost} />}
      {t.id === "titles" && <TitleTool room={room} postId={postId} setPost={setPost} />}
      {t.id === "thumbs" && <ThumbTool room={room} postId={postId} setPost={setPost} />}
      {t.id === "captions" && <CaptionTool room={room} postId={postId} setPost={setPost} />}
      {t.id === "digest" && <DigestTool room={room} />}
    </div>
  );
}

/** Each orb's number: where that part of the writing stands across your open posts. */
function useOrbs(room: Room, postId: string): OrbSpec[] {
  const { data, posts, targets, model } = room;
  return useMemo(() => {
    const open = posts.filter(OPEN);
    const scripts = open.filter((p) => (p.script ?? "").trim());
    const hook = scripts.length ? Math.round(scripts.reduce((s, p) => s + hookScore(p.script!, { fmt: fmtOf(targetsOf(p, targets).map((x) => x.space)) }).score, 0) / scripts.length) : null;
    const rated = (data?.items ?? []).filter((i) => i.score != null);
    const hitRate = rated.length ? rated.filter((i) => i.score! >= 1.5).length / rated.length : null;
    const covers = open.length ? open.filter((p) => p.cover).length / open.length : null;
    const tg = open.flatMap((p) => targetsOf(p, targets).filter((x) => x.status !== "posted").map((x) => !!data?.captions[p.$id]?.[x.space]));
    const caps = tg.length ? tg.filter(Boolean).length / tg.length : null;
    const g = data ? weeklyDigest(data.items, data.rivals, data.lengths) : null;
    const change = g && g.prev_views ? (g.views - g.prev_views) / g.prev_views : null;
    const vals: Record<ToolId, [number, string]> = {
      hooks: [hook ?? 0, hook == null ? "—" : String(hook)],
      titles: [hitRate == null ? 0 : Math.min(100, hitRate * 250), hitRate == null ? "—" : `${pct(hitRate)} hit`],
      captions: [(caps ?? 0) * 100, caps == null ? "—" : `${pct(caps)} fit`],
      thumbs: [(covers ?? 0) * 100, covers == null ? "—" : `${pct(covers)} set`],
      digest: [change == null ? 50 : Math.max(0, Math.min(100, 50 + change * 50)), change == null ? (g ? `${g.posts} posts` : "—") : signed(change)],
    };
    void model;
    return TOOLS.map((t) => ({ ...t, href: `/writing?tool=${t.id}${postId && t.id !== "digest" ? `&post=${postId}` : ""}`, value: vals[t.id][0], chip: vals[t.id][1] }));
  }, [data, posts, targets, model, postId]);
}

/** Your desk: every open post and where its writing stands, each cell opening the tool for that post. */
function Desk({ room }: { room: Room }) {
  const rows = room.posts.filter(OPEN).slice(0, 10);
  if (!rows.length) return null;
  return (
    <section className="card flush wr-desk" aria-labelledby="wr-desk-h">
      <div className="card-head" style={{ padding: "16px 18px 0" }}><div><h2 id="wr-desk-h">On your desk</h2><p className="sub small dim" style={{ margin: "2px 0 0" }}>Open posts and where their writing stands. Pick a cell to work on it.</p></div></div>
      <div className="table-wrap">
        <table className="wr-table">
          <thead><tr><th scope="col">Post</th><th scope="col">Hook</th><th scope="col">Title</th><th scope="col">Thumbnail</th><th scope="col">Captions</th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const ts = targetsOf(p, room.targets).filter((x) => x.status !== "posted");
              const h = (p.script ?? "").trim() ? hookScore(p.script!, { fmt: fmtOf(ts.map((x) => x.space)) }).score : null;
              const ti = p.title ? scoreTitle(p.title, room.model).score : null;
              const fit = ts.filter((x) => room.data?.captions[p.$id]?.[x.space]).length;
              const go = (t: ToolId) => `/writing?tool=${t}&post=${p.$id}`;
              return (
                <tr key={p.$id}>
                  <th scope="row"><span className="wr-desk-t ellipsis">{p.title || "Untitled"}</span><span className="wr-desk-n">{ts.map((x) => <PlatformBadge key={x.space} space={x.space} size={16} />)}</span></th>
                  <td data-label="Hook"><Link href={go("hooks")} className={`pill mono ${h == null ? "" : h >= 70 ? "ok" : h >= 50 ? "warn" : "bad"}`}>{h ?? "No script"}</Link></td>
                  <td data-label="Title"><Link href={go("titles")} className={`pill mono ${ti == null ? "" : ti >= 70 ? "ok" : ti >= 50 ? "warn" : "bad"}`}>{ti ?? "—"}</Link></td>
                  <td data-label="Thumbnail"><Link href={go("thumbs")} className={`pill ${p.cover ? "ok" : ""}`}>{p.cover ? "Set" : "Brief it"}</Link></td>
                  <td data-label="Captions"><Link href={go("captions")} className={`pill mono ${ts.length && fit === ts.length ? "ok" : ""}`}>{ts.length ? `${fit}/${ts.length}` : "No targets"}</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type ToolProps = { room: Room; postId: string; setPost: (id: string) => void };

/* ───────────── Hook score */

function HookTool({ room, postId, setPost }: ToolProps) {
  const post = room.posts.find((p) => p.$id === postId);
  const { toast } = useDialog();
  const [text, setText] = useState("");
  useEffect(() => { if (post) setText(post.script ?? ""); }, [post?.$id]); // eslint-disable-line react-hooks/exhaustive-deps
  const fmt = post ? fmtOf(targetsOf(post, room.targets).map((x) => x.space)) : null;
  const best = fmt ? room.data?.best_len[fmt] ?? null : null;
  const r = useMemo(() => hookScore(text, { fmt, best }), [text, fmt, best]);
  const dirty = !!post && text !== (post.script ?? "");
  const save = async () => {
    try { const row = await savePost(post!, { script: text }); room.setRows((rs) => rs.map((x) => (x.$id === row.$id ? row : x))); toast("Script saved to the post", "ok"); }
    catch (e) { toast((e as Error).message, "bad"); }
  };
  const ask = post ? `Use the Voicebox hook_score tool on my post "${post.title}" (post_id ${post.$id}). Rewrite the failing lines in my voice, one beat per line, until it scores 80 or more. Show me the new script before you save it.`
    : `Score this script with the Voicebox hook_score tool, then rewrite it, one beat per line, until it scores 80 or more:\n\n${text}`;
  const flagged = r.lines.filter((l) => l.notes.length);
  return (
    <div className="wr-work">
      <section className="card wr-canvas" aria-labelledby="wr-h-script">
        <div className="wr-bar">
          <PostPick room={room} value={postId} set={setPost} />
          <span className="tiny dim mono wr-meta">{r.words} words · ~{r.secs}s · {fmtName(fmt)}</span>
        </div>
        <h2 id="wr-h-script" className="sr-only">Script</h2>
        <Field label="Script" hint="One beat per line, as you'd say it. The first line is the hook.">
          <textarea className="wr-script" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Most people edit for an hour. You need ten minutes.\nHere's the one setting that does it…"} />
        </Field>
        {r.opener && <p className="wr-opener"><span className="label">The hook, as the viewer hears it</span>“{r.opener}”</p>}
        {flagged.length > 0 && (
          <>
            <h3 className="wr-h3">Lines to fix <span className="pill mono">{flagged.length}</span></h3>
            <ol className="wr-lines">
              {flagged.map((l) => (
                <li key={l.i} className={l.tone}>
                  <span className="mono tiny dim">{l.i + 1}</span>
                  <span><span className="wr-line">{l.text}</span><span className="wr-notes">{l.notes.map((n) => <span key={n} className={`pill ${l.tone === "bad" ? "bad" : "warn"}`}>{n}</span>)}</span></span>
                </li>
              ))}
            </ol>
          </>
        )}
        <div className="wr-foot">
          <AskClaude prompt={ask} />
          {post && <button type="button" onClick={save} disabled={!dirty} title={dirty ? undefined : "No changes to save"}>Save to post</button>}
        </div>
      </section>
      <aside className="card wr-side" aria-label="Score">
        <RingScore value={r.score} label={r.grade} tone="ginger" sub={best ? `Your hits in this format run ~${best}s` : undefined} />
        <Checks checks={r.checks} />
      </aside>
    </div>
  );
}

/* ───────────── Titles */

function TitleTool({ room, postId, setPost }: ToolProps) {
  const post = room.posts.find((p) => p.$id === postId);
  const { toast } = useDialog();
  const [cands, setCands] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  useEffect(() => { setCands(post?.title && post.title !== "Untitled" ? [post.title] : []); }, [post?.$id]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = room.model;
  const scored = useMemo(() => cands.map((c) => scoreTitle(c, m)), [cands, m]);
  const best = Math.max(0, ...scored.map((s) => s.score));
  const add = () => { const t = draft.trim(); if (t && !cands.includes(t)) setCands([...cands, t]); setDraft(""); };
  const use = async (t: string) => {
    if (!post) return;
    try { const row = await savePost(post, { title: t }); room.setRows((rs) => rs.map((x) => (x.$id === row.$id ? row : x))); toast("Title set on the post", "ok"); }
    catch (e) { toast((e as Error).message, "bad"); }
  };
  const ask = `Use the Voicebox title_lab tool: write 12 titles for ${post ? `my post "${post.title}" (post_id ${post.$id})${post.script ? ", from its script" : ""}` : "my next video"} that follow what my hits do, score them with title_lab, and give me the best 5 with their scores.`;
  return (
    <div className="wr-work">
      <section className="card wr-canvas" aria-labelledby="wr-t-h">
        <div className="wr-bar"><PostPick room={room} value={postId} set={setPost} empty="No post (just testing)" /></div>
        <h2 id="wr-t-h">Your candidates</h2>
        <form className="wr-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <label className="sr-only" htmlFor="wr-t-in">A title to test</label>
          <input id="wr-t-in" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a title and press Enter" maxLength={150} />
          <button type="submit" className="ghost"><Plus size={14} />Test it</button>
        </form>
        {draft.trim() && <TitleRow s={scoreTitle(draft, m)} live />}
        {scored.length ? (
          <ol className="wr-titles">{scored.map((s, i) => <TitleRow key={s.title} s={s} top={s.score === best && scored.length > 1} onUse={post ? () => use(s.title) : undefined} onDrop={() => setCands(cands.filter((_, j) => j !== i))} />)}</ol>
        ) : !draft.trim() && <Empty title="Test a few titles side by side">Each one is scored against what your hits do. Write three or four ways to say it, or ask Claude for twelve.</Empty>}
        <div className="wr-foot"><AskClaude prompt={ask} /></div>
      </section>
      <aside className="card wr-side" aria-labelledby="wr-t-hab">
        <h2 id="wr-t-hab">What your hits do</h2>
        <p className="small dim" style={{ margin: "2px 0 12px" }}>{m.basis === "yours" ? `${m.hits} hits (1.5× your usual or more) against ${m.rest} others, last 90 days` : "General rules until you have 3 hits and 3 others to learn from"}</p>
        <div className="wr-habits" role="table" aria-label="Title habits">
          {m.lifts.map((l) => (
            <div key={l.label} role="row">
              <span role="rowheader">{l.label}</span>
              {m.basis === "yours" ? (
                <span role="cell" className="wr-hb" aria-label={`Hits ${pct(l.a)}, others ${pct(l.b)}`}><i className="a" style={{ width: `${Math.max(2, l.a * 100)}%` }} /><i className="b" style={{ width: `${Math.max(2, l.b * 100)}%` }} /></span>
              ) : <span role="cell" className="wr-hb" aria-label={`Weight ${Math.round(l.lift * 100)}`}><i className="a" style={{ width: `${Math.max(2, l.lift * 400)}%` }} /></span>}
              <span role="cell" className={`mono tiny ${l.lift > 0.05 ? "an-ok" : "dim"}`}>{l.lift >= 0 ? "+" : "−"}{Math.abs(Math.round(l.lift * 100))}</span>
            </div>
          ))}
        </div>
        {m.words.length > 0 && <><h3 className="wr-h3">Words your hits share</h3><div className="an-tags">{m.words.map((w) => <span key={w.word} className="pill">{w.word}<b className="mono">{w.n}</b></span>)}</div></>}
        {m.top.length > 0 && (
          <>
            <h3 className="wr-h3">Your winners</h3>
            <ol className="wr-wins">{m.top.slice(0, 5).map((t) => <li key={t.url}><a href={t.url} target="_blank" rel="noreferrer" className="clamp2">{t.title}</a><Score v={t.score} /></li>)}</ol>
          </>
        )}
      </aside>
    </div>
  );
}

function TitleRow({ s, top, live, onUse, onDrop }: { s: ReturnType<typeof scoreTitle>; top?: boolean; live?: boolean; onUse?: () => void; onDrop?: () => void }) {
  const tone = s.score >= 70 ? "ok" : s.score >= 50 ? "warn" : "bad";
  const Tag = live ? "div" : "li";
  return (
    <Tag className={`wr-tr ${top ? "top" : ""} ${live ? "live" : ""}`}>
      <span className={`wr-tr-n mono ${tone}`} aria-label={`Score ${s.score}`}>{s.score}</span>
      <span className="wr-tr-b">
        <b>{s.title}{top && <span className="pill ok" style={{ marginLeft: 8 }}>Best</span>}</b>
        <span className="wr-tr-meter" aria-hidden><i className={tone} style={{ width: `${s.score}%` }} /></span>
        <span className="wr-tr-parts">
          {s.parts.filter((p) => p.on && p.delta).map((p) => <span key={p.label} className={`pill ${p.delta > 0 ? "blue" : "bad"}`}>{p.label} <b className="mono">{p.delta > 0 ? "+" : "−"}{Math.abs(p.delta)}</b></span>)}
          {s.notes.map((n) => <span key={n} className="tiny dim">{n}</span>)}
          <span className={`tiny mono ${s.title.length > 70 ? "wr-bad" : "dim"}`}>{s.title.length} chars</span>
        </span>
      </span>
      {!live && <span className="wr-tr-a">
        {onUse && <button type="button" className="ghost xs" onClick={onUse}>Use</button>}
        {onDrop && <button type="button" className="icon-btn xs" onClick={onDrop} aria-label={`Remove “${s.title}”`}><Trash size={13} /></button>}
      </span>}
    </Tag>
  );
}

/* ───────────── Thumbnails */

function ThumbTool({ room, postId, setPost }: ToolProps) {
  const post = room.posts.find((p) => p.$id === postId);
  const [b, setB] = useState<Brief>({ text: "", subject: "", emotion: "", setting: "" });
  const title = post?.title && post.title !== "Untitled" ? post.title : "";
  const checks = useMemo(() => briefChecks(b, title), [b, title]);
  const score = Math.round(checks.reduce((s, c) => s + c.weight * c.part, 0));
  const set = (k: keyof Brief) => (e: { target: { value: string } }) => setB({ ...b, [k]: e.target.value });
  const mine = useMemo(() => [...(room.data?.items ?? [])].filter((i) => i.thumb && i.score != null).sort((x, y) => y.score! - x.score!).slice(0, 6), [room.data]);
  const theirs = useMemo(() => [...(room.data?.rivals ?? [])].filter((r) => r.thumb && r.x != null && r.x >= 1.5).sort((x, y) => y.x! - x.x!).slice(0, 6), [room.data]);
  const prompt = briefPrompt(b, title);
  const ask = `Use the Voicebox title_lab tool to see what my best thumbnails and titles do, then write 3 thumbnail briefs for ${post ? `"${post.title}" (post_id ${post.$id})` : "my next video"} (4 words of text at most, one subject, a face with a feeling) and make the best one with imagine at 16:9.`;
  return (
    <div className="wr-work">
      <section className="card wr-canvas" aria-labelledby="wr-th-h">
        <div className="wr-bar"><PostPick room={room} value={postId} set={setPost} empty="No post" /></div>
        <h2 id="wr-th-h">The brief</h2>
        <div className="wr-brief">
          <div className="wr-brief-f">
            <Field label="Text on the image" hint={`${b.text.trim() ? b.text.trim().split(/\s+/).length : 0} words · ${b.text.length} characters`}><input value={b.text} onChange={set("text")} placeholder="I WAS WRONG" maxLength={40} /></Field>
            <Field label="Subject"><input value={b.subject} onChange={set("subject")} placeholder="Me holding the old camera" maxLength={80} /></Field>
            <Field label="Expression"><Select value={b.emotion} onChange={(v) => setB({ ...b, emotion: v })} options={[["", "None"], ...EMOTIONS.map((e) => [e, e] as const)]} label="Expression" /></Field>
            <Field label="Background"><input value={b.setting} onChange={set("setting")} placeholder="Plain warm wall" maxLength={80} /></Field>
          </div>
          <figure className="wr-thumb" aria-label="A stand-in for the thumbnail's layout">
            <span className="wr-thumb-subject" aria-hidden><svg viewBox="-50 -50 100 100"><Marble tone="violet" seed={b.subject.length / 3 + 2} r={44} n={12} /></svg>{b.emotion && <span className="pill violet">{b.emotion}</span>}</span>
            <span className="wr-thumb-text" style={{ fontSize: `${Math.min(11, 64 / Math.max(4, ...(b.text || "Your words").split(/\s+/).map((w) => w.length)))}cqi` }}>{b.text || "Your words"}</span>
            {title && <figcaption className="tiny dim ellipsis">{title}</figcaption>}
          </figure>
        </div>
        <div className="wr-foot">
          <AskClaude prompt={ask} />
          <Link className="btn" href={`/images?prompt=${encodeURIComponent(prompt)}&aspect=16:9`}><ImageSquare size={15} />Make it in Images</Link>
        </div>
      </section>
      <aside className="card wr-side" aria-label="Brief checks and inspiration">
        <RingScore value={score} label={score >= 85 ? "Ready to shoot" : score >= 60 ? "Nearly" : "Keep going"} tone="violet" />
        <Checks checks={checks} />
        {(mine.length > 0 || theirs.length > 0) && <h3 className="wr-h3">What&apos;s worked</h3>}
        <div className="wr-mood">
          {mine.map((i) => <a key={i.id} href={i.url} target="_blank" rel="noreferrer" title={i.title}><img src={i.thumb!} alt={i.title} loading="lazy" /><Score v={i.score} /></a>)}
          {theirs.map((r) => <a key={r.id} href={r.url} target="_blank" rel="noreferrer" title={`${r.name}: ${r.title}`} className="rival"><img src={r.thumb!} alt={`${r.name}: ${r.title}`} loading="lazy" /><Score v={r.x} /></a>)}
        </div>
        {(mine.length > 0 || theirs.length > 0) && <p className="tiny dim" style={{ margin: "8px 0 0" }}>Yours first, then rivals&apos; hits (outlined), each against its channel&apos;s usual.</p>}
      </aside>
    </div>
  );
}

/* ───────────── Captions */

function CharRing({ n, max }: { n: number; max: number }) {
  const f = Math.min(1, n / max), over = n > max, C = 2 * Math.PI * 9;
  return (
    <span className={`wr-cr ${over ? "over" : f > 0.9 ? "near" : ""}`} aria-label={`${n} of ${max} characters`}>
      <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden><circle cx={12} cy={12} r={9} className="tr" /><circle cx={12} cy={12} r={9} className="fg" strokeDasharray={`${f * C} ${C}`} transform="rotate(-90 12 12)" /></svg>
      <span className="mono tiny">{over ? `−${n - max}` : max - n}</span>
    </span>
  );
}

function CaptionTool({ room, postId, setPost }: ToolProps) {
  const post = room.posts.find((p) => p.$id === postId);
  const { toast } = useDialog();
  const ts = post ? targetsOf(post, room.targets).filter((x) => x.status !== "posted") : [];
  const saved = (post && room.data?.captions[post.$id]) || {};
  const tags = (room.data?.tags ?? []).map((t) => t.tag);
  const [base, setBase] = useState("");
  const [edits, setEdits] = useState<Partial<Record<SpaceId, string>>>({});
  const [busy, setBusy] = useState(false);
  const last = useRef<SpaceId | null>(null);
  useEffect(() => { setBase(post?.caption ?? ""); setEdits({}); }, [post?.$id]); // eslint-disable-line react-hooks/exhaustive-deps
  const valueOf = (s: SpaceId) => edits[s] ?? saved[s] ?? adaptCaption(base, s, { title: post?.title, tags });
  const over = ts.some((x) => valueOf(x.space).length > captionLimit(x.space));
  const save = async () => {
    if (!post) return;
    if (over) { toast("One caption is over its limit", "bad"); return; }
    setBusy(true);
    try {
      if (base !== (post.caption ?? "")) { const row = await savePost(post, { caption: base }); room.setRows((rs) => rs.map((x) => (x.$id === row.$id ? row : x))); }
      const r = await api<{ captions: Record<string, string> }>(`captions/${post.$id}`, { body: { captions: Object.fromEntries(ts.map((x) => [x.space, valueOf(x.space)])) } });
      room.setData((d) => (d ? { ...d, captions: { ...d.captions, [post.$id]: r.captions } } : d));
      setEdits({});
      toast("Captions saved. Publishing starts each target from its own.", "ok");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  const addTag = (t: string) => { const s = last.current ?? ts[0]?.space; if (!s) return; const v = valueOf(s); if (!v.includes(t)) setEdits({ ...edits, [s]: `${v}${/\s$/.test(v) || !v ? "" : " "}${t}` }); };
  const ask = post ? `Use the Voicebox captions tool for my post "${post.title}" (post_id ${post.$id}): write each target's caption for its platform (start from the drafts, keep my voice), show me all of them, then save them when I say so.` : "Use the Voicebox captions tool to write captions for my next post, one per platform it goes to.";
  return (
    <div className="wr-work">
      <section className="card wr-canvas" aria-labelledby="wr-c-h">
        <div className="wr-bar"><PostPick room={room} value={postId} set={setPost} empty="Pick a post" filter={(p) => targetsOf(p, room.targets).some((x) => x.status !== "posted")} /></div>
        {!post ? <Empty title="Pick a post that goes somewhere">Captions are fitted to each place a post goes. Add targets to a post in Posts, then pick it here.</Empty> : (
          <>
            <Field label="The caption" hint="Write it once. Each platform below starts from this and stays yours once you edit it.">
              <textarea rows={5} value={base} onChange={(e) => setBase(e.target.value)} placeholder="The hook line first. Then why it matters." />
            </Field>
            <h2 id="wr-c-h" className="wr-h3">Fitted to each platform <span className="pill mono">{ts.length}</span></h2>
            <div className="wr-caps">
              {ts.map((x) => {
                const v = valueOf(x.space), max = captionLimit(x.space);
                const own = edits[x.space] != null || saved[x.space] != null;
                return (
                  <div key={x.space} className={`wr-cap ${v.length > max ? "over" : ""}`}>
                    <div className="wr-cap-h">
                      <PlatformBadge space={x.space} size={20} />
                      <span><b>{spaceName(x.space)}</b><span className="tiny dim">{CAPTION[x.space]?.hint}</span></span>
                      <CharRing n={v.length} max={max} />
                    </div>
                    <label className="sr-only" htmlFor={`wr-cap-${x.space}`}>{spaceName(x.space)} caption</label>
                    <textarea id={`wr-cap-${x.space}`} rows={x.space.startsWith("x_") ? 3 : 5} value={v} aria-invalid={v.length > max}
                      onFocus={() => (last.current = x.space)} onChange={(e) => setEdits({ ...edits, [x.space]: e.target.value })} />
                    <div className="wr-cap-f">
                      <span className="tiny dim">{own ? (saved[x.space] != null && edits[x.space] == null ? "Saved" : "Edited") : "Draft from the caption"}</span>
                      {own && <button type="button" className="quiet xs" onClick={() => { setEdits({ ...edits, [x.space]: adaptCaption(base, x.space, { title: post.title, tags }) }); }}>Reset to draft</button>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="wr-foot">
              <AskClaude prompt={ask} />
              <button type="button" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save captions"}</button>
            </div>
          </>
        )}
      </section>
      <aside className="card wr-side" aria-labelledby="wr-c-tags">
        <h2 id="wr-c-tags">Hashtags that go with your best</h2>
        <p className="small dim" style={{ margin: "2px 0 12px" }}>Median score of the posts that used each. Click one to add it to the caption you&apos;re on.</p>
        {room.data?.tags.length ? (
          <div className="an-tags">{room.data.tags.map((t) => <button type="button" key={t.tag} className="pill wr-tag" onClick={() => addTag(t.tag)} disabled={!post}>{t.tag}<b className="mono">{t.score}×</b></button>)}</div>
        ) : <p className="small dim">They show once a few posts have used the same hashtags.</p>}
        <h3 className="wr-h3">The limits</h3>
        <ul className="wr-limits">{(Object.entries(CAPTION) as [SpaceId, NonNullable<(typeof CAPTION)[SpaceId]>][]).filter(([s]) => ["x_post", "ig_reel", "yt_video", "tt_video", "li_post"].includes(s)).map(([s, c]) => <li key={s}><PlatformBadge space={s} size={16} /><span className="wr-lim-n">{spaceName(s)}</span><b className="mono">{c.limit.toLocaleString()}</b></li>)}</ul>
      </aside>
    </div>
  );
}

/* ───────────── Weekly digest */

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function DigestTool({ room }: { room: Room }) {
  const { toast } = useDialog();
  const g = useMemo(() => (room.data ? weeklyDigest(room.data.items, room.data.rivals, room.data.lengths) : null), [room.data]);
  const [made, setMade] = useState<Record<string, string>>({});
  if (!g) return <div className="card"><div className="skel" style={{ height: 240 }} /></div>;
  const draft = async (title: string, why: string) => {
    try { const p = await createPost({ title, notes: why, status: "idea" }); setMade((m) => ({ ...m, [title]: p.$id })); toast("Added to Ideas", "ok"); }
    catch (e) { toast((e as Error).message, "bad"); }
  };
  const d = (a: number, b: number) => (b ? signed((a - b) / b) : null);
  const kpis: [string, string, string | null][] = [
    ["Posts", String(g.posts), g.prev_posts ? `${g.prev_posts} the week before` : null],
    ["Views", compact(g.views), d(g.views, g.prev_views)],
    ["Hits", String(g.hits), "1.5× your usual or more"],
    ["Typical post", g.median_score == null ? "—" : `${g.median_score.toFixed(1)}×`, "your usual"],
  ];
  const Card = ({ i }: { i: WItem }) => (
    <a className="wr-dc" href={i.url} target="_blank" rel="noreferrer">
      <span className="wr-dc-th">{i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : <PlatformBadge net={i.network} size={22} />}</span>
      <b className="clamp2">{i.title || "Untitled"}</b>
      <span className="row tiny dim"><Score v={i.score} />{compact(i.views ?? 0)} views · {day(i.at)}</span>
    </a>
  );
  return (
    <article className="wr-digest">
      <header className="wr-dg-h">
        <span className="label mono">{day(g.from)} – {day(g.to)}</span>
        <p className="wr-dg-line">{g.line}</p>
        <div className="row"><AskClaude prompt="Use the Voicebox weekly_digest tool and write my Monday summary in my voice: what worked and why, what my rivals hit, and three posts to make next with a hook line for each." /></div>
      </header>
      <dl className="wr-kpis">{kpis.map(([k, v, s]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd>{s && <span className="tiny dim">{s}</span>}</div>)}</dl>
      <div className="wr-dg-grid">
        <section aria-labelledby="wr-dg-best"><h2 id="wr-dg-best">What worked</h2>{g.best.length ? <div className="wr-dcs">{g.best.map((i) => <Card key={i.id} i={i} />)}</div> : <p className="small dim">Nothing beat your usual this week yet.</p>}</section>
        <section aria-labelledby="wr-dg-worst"><h2 id="wr-dg-worst">What didn&apos;t</h2>{g.worst.length ? <div className="wr-dcs">{g.worst.map((i) => <Card key={i.id} i={i} />)}</div> : <p className="small dim">No post fell well below your usual.</p>}</section>
      </div>
      <section aria-labelledby="wr-dg-riv" className="wr-dg-sec">
        <h2 id="wr-dg-riv">What your rivals hit</h2>
        {g.rivals.length ? <div className="wr-dcs four">{g.rivals.map((r) => (
          <a key={r.id} className="wr-dc" href={r.url} target="_blank" rel="noreferrer">
            <span className="wr-dc-th">{r.thumb && <img src={r.thumb} alt="" loading="lazy" />}</span>
            <b className="clamp2">{r.title}</b>
            <span className="row tiny dim"><Score v={r.x} /><span className="ellipsis">{r.name}</span></span>
          </a>
        ))}</div> : <p className="small dim">No rival video beat its channel&apos;s usual this week. Follow rivals in Grow → Competitors.</p>}
        {g.gaps.length > 0 && <><h3 className="wr-h3">Topics in their hits, missing from yours</h3><div className="an-tags">{g.gaps.map((w) => <span key={w} className="pill violet">{w}</span>)}</div></>}
      </section>
      <section aria-labelledby="wr-dg-next" className="wr-dg-sec">
        <h2 id="wr-dg-next">Post next</h2>
        {g.ideas.length ? <div className="wr-ideas">{g.ideas.map((i, k) => (
          <div key={i.title} className="wr-idea">
            <span className="wr-idea-n mono" aria-hidden>{String(k + 1).padStart(2, "0")}</span>
            <b>{i.title}</b>
            <span className="small dim">{i.why}</span>
            <span className="pill" style={{ alignSelf: "flex-start" }}>{fmtName(i.fmt)}</span>
            <span className="row" style={{ marginTop: "auto", flexWrap: "nowrap" }}>
              {made[i.title] ? <Link className="btn ghost xs" href="/posts">In Ideas<ArrowSquareOut size={12} /></Link> : <button type="button" className="ghost xs" onClick={() => draft(i.title, i.why)}><Plus size={12} />Make a draft</button>}
              <button type="button" className="icon-btn xs" aria-label={`Copy “${i.title}”`} onClick={() => navigator.clipboard.writeText(i.title).then(() => toast("Copied"))}><Copy size={13} /></button>
            </span>
          </div>
        ))}</div> : <p className="small dim">Ideas show once there are a few posts to learn from.</p>}
      </section>
    </article>
  );
}
