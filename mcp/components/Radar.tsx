"use client";
// Grow → Radar (/analytics/radar): what to post next, from free public signals and your own numbers (lib/radar.ts
// scores, lib/radar-data.ts reads and keeps them). Three views at ?view=:
//   Sweep      a radar scope (components/RadarScope.tsx) of what's moving in your lane right now, from fifteen free
//              sources (Google Trends and News, Hacker News, Lobsters, DEV, Mastodon, Hugging Face, GitHub, Wikipedia's
//              most read, autocomplete, YouTube trending, your rivals' outliers): the closer to the middle, the better
//              the bet; the angle is where the signals came from. Pick a blip for its evidence, what its heat is made
//              of and how sure it is, then research or watch it. Below: every topic, the live signal feed, trending
//              searches, which sources answered, and the track record.
//   Keyword    one keyword in depth (?q=): demand, momentum, competition and fit with what each is made of, the
//              opportunity and verdict, a view prediction against your usual, the long tail, the questions people
//              ask, what ranks now, and a title lab that scores search and click as you type.
//   Watchlist  keywords followed over time, and the prediction track record (what was predicted, what happened).
// Every number says where it came from; nothing is made up when a source doesn't answer. Claude reaches all of it
// over MCP (radar, keyword_research, seo_score, radar_watch).
import { ArrowSquareOut, ArrowsClockwise, Check, Copy, Crosshair, Eye, Hash, MagnifyingGlass, PencilSimple, Plus, Sparkle, Target, Trash, TrendUp, Warning, X } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Fmt } from "@/lib/analytics";
import { SECTORS, SRC_NAME, SWEEP_NAME, seoScore, titleScore, type Blip, type Research, type Score as ScoreT, type Sweep, type TrackRecord } from "@/lib/radar";
import type { RadarConfig, Watch } from "@/lib/radar-data";
import { titleModel } from "@/lib/writing";
import type { WritingData } from "@/lib/writing-data";
import { compact, full, Sparkline } from "./anparts";
import { ago, api, useSeed } from "./api";
import { useDialog } from "./Dialog";
import { Select } from "./pop";
import { RadarScope, toneOf } from "./RadarScope";
import { Empty, Field, Notice } from "./ui";

type Overview = { sweep: Sweep & { cached: boolean; stale?: boolean; auto_seeds: boolean }; watch: Watch[]; record: TrackRecord; config: RadarConfig & { auto: boolean }; needs: string[] };
type Kw = Research & { cached: boolean; needs: string[]; record: TrackRecord };
type View = "sweep" | "keyword" | "watch";

const FMTS: [Fmt, string][] = [["yt_video", "YouTube video"], ["yt_short", "Short"], ["ig_reel", "Reel"], ["ig_post", "Instagram post"]];
const GEO_NAMES: [string, string][] = [["US", "United States"], ["IN", "India"], ["GB", "United Kingdom"], ["CA", "Canada"], ["AU", "Australia"], ["DE", "Germany"], ["FR", "France"], ["BR", "Brazil"], ["ID", "Indonesia"], ["PH", "Philippines"], ["NG", "Nigeria"], ["PK", "Pakistan"], ["AE", "UAE"], ["SG", "Singapore"]];
const xText = (v: number) => `${v >= 10 ? Math.round(v) : v.toFixed(v < 1 ? 2 : 1)}×`;
const ageText = (d: number | null) => (d == null ? "—" : d < 1 ? "today" : d < 14 ? `${Math.round(d)} d` : d < 60 ? `${Math.round(d / 7)} wk` : d < 365 ? `${Math.round(d / 30)} mo` : `${Math.round(d / 365)} yr`);

function useView(): [View, (v: View, q?: string) => void, string] {
  const sp = useSearchParams(), router = useRouter(), path = usePathname();
  const v = (["sweep", "keyword", "watch"] as const).find((x) => x === sp.get("view")) ?? (sp.get("q") ? "keyword" : "sweep");
  const go = (to: View, q?: string) => router.push(`${path}?view=${to}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  return [v, go, sp.get("q") ?? ""];
}

/** "Ask Claude": a prompt for Claude with the Voicebox connector, which does the writing with these numbers. */
function AskClaude({ prompt, label = "Ask Claude" }: { prompt: string; label?: string }) {
  const { toast } = useDialog();
  return (
    <button type="button" className="ghost sm" title={prompt}
      onClick={() => navigator.clipboard.writeText(prompt).then(() => toast("Copied. Paste it into Claude (with the Voicebox connector)."), () => toast("Couldn't copy", "bad"))}>
      <Sparkle size={14} weight="duotone" />{label}
    </button>
  );
}

export default function Radar() {
  const [view, go, q] = useView();
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useSeed<Overview>("radar", setData);
  const load = (fresh = false) => { setBusy(true); setErr(""); return api<Overview>(`radar${fresh ? "?fresh=1" : ""}`).then(setData, (e) => setErr((e as Error).message)).finally(() => setBusy(false)); };
  useEffect(() => { load(); }, []);
  // a stale copy was served while a new sweep is read behind it: pick that up
  useEffect(() => { if (!data?.sweep.stale) return; const t = setTimeout(() => api<Overview>("radar").then(setData).catch(() => null), 12_000); return () => clearTimeout(t); }, [data?.sweep.stale, data?.sweep.at]);
  return (
    <>
      <div className="rd-bar">
        <nav className="seg" aria-label="Radar views">
          {([["sweep", "Sweep"], ["keyword", "Keyword"], ["watch", "Watchlist"]] as const).map(([id, name]) => (
            <button key={id} type="button" className={view === id ? "on" : ""} aria-pressed={view === id} onClick={() => go(id, id === "keyword" ? q : undefined)}>{name}{id === "watch" && data?.watch.length ? <span className="rd-count mono">{data.watch.length}</span> : null}</button>
          ))}
        </nav>
        <KwSearch initial={view === "keyword" ? q : ""} onGo={(k) => go("keyword", k)} />
      </div>
      {err && <Notice icon={<Warning size={18} />} tone="bad" action={<button className="ghost sm" onClick={() => load()}>Try again</button>}>Couldn&apos;t load Radar: {err}</Notice>}
      {data?.needs.map((n, i) => <Notice key={i} icon={<Warning size={18} />} tone="warn">{n}</Notice>)}
      {view === "sweep" && <SweepView data={data} busy={busy} reload={() => load(true)} onConfig={(c) => setData((d) => (d ? { ...d, config: c } : d))} research={(k) => go("keyword", k)} onWatch={() => load()} />}
      {view === "keyword" && <KeywordView key={q} q={q} research={(k) => go("keyword", k)} onWatch={() => load()} />}
      {view === "watch" && <WatchView data={data} research={(k) => go("keyword", k)} onChange={() => load()} />}
    </>
  );
}

function KwSearch({ initial, onGo }: { initial: string; onGo: (q: string) => void }) {
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial]);
  return (
    <form className="rd-search" role="search" onSubmit={(e) => { e.preventDefault(); if (v.trim().length >= 2) onGo(v.trim()); }}>
      <div className="searchbox">
        <MagnifyingGlass size={15} className="ic" aria-hidden />
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Research a keyword or topic…" aria-label="Keyword to research" maxLength={80} />
      </div>
      <button type="submit" className="sm">Research</button>
    </form>
  );
}

/* ───────────── Sweep */

function SweepView({ data, busy, reload, onConfig, research, onWatch }: { data: Overview | null; busy: boolean; reload: () => void; onConfig: (c: Overview["config"]) => void; research: (q: string) => void; onWatch: () => void }) {
  const [pick, setPick] = useState<string | null>(null);
  if (!data) return <div className="an-wrap" aria-busy="true" aria-label="Reading the sources"><div className="skel" style={{ height: 460 }} /><div className="skel" style={{ height: 160 }} /></div>;
  const sw = data.sweep;
  const blip = sw.blips.find((b) => b.topic === pick) ?? sw.blips[0] ?? null;
  const ok = sw.sources.filter((s) => s.ok).length;
  const signals = sw.feed?.length ?? 0;
  const status = [
    `SRC ${String(ok).padStart(2, "0")}/${String(sw.sources.length).padStart(2, "0")} ONLINE`,
    `TOPICS ${String(sw.blips.length).padStart(2, "0")} · GO ${String(sw.blips.filter((b) => b.verdict === "Go now").length).padStart(2, "0")}`,
    `LANE ${sw.seeds.slice(0, 2).join(" · ").toUpperCase()}`,
    `GEO ${sw.geos.join(" · ")}`,
    `READ ${ago(sw.at).toUpperCase()}`,
    ...(signals ? [`FEED ${signals} SIGNALS`] : []),
  ];
  return (
    <>
      <div className="gr-status" role="status">
        <span><b className="mono">{sw.blips.length}</b> topics moving in your lane</span>
        <span className="hide-sm">{ok} of {sw.sources.length} sources answered · checked {ago(sw.at)}{sw.stale ? " · reading again" : ""}</span>
        <button type="button" className="quiet sm" onClick={reload} disabled={busy}><ArrowsClockwise size={14} className={busy || sw.stale ? "spin" : ""} />Sweep again</button>
      </div>
      <Lane config={data.config} onSaved={(c) => { onConfig(c); reload(); }} />
      <section className="card an-card rd-hero" aria-labelledby="rd-scope-h">
        <div className="card-head">
          <div><h2 id="rd-scope-h">Right now</h2><p className="sub">Nearer the middle is a better bet (heat and fit); the angle is where the signals came from</p></div>
          <AskClaude prompt="Use the Voicebox radar tool to see what's moving in my lane, run keyword_research on the three best blips (or a sharper long-tail of each), and give me three post ideas with titles scored by seo_score and the predicted views." />
        </div>
        {sw.blips.length ? (
          <div className="rd-hero-in">
            <RadarScope blips={sw.blips} on={blip?.topic ?? null} pick={setPick} status={status} />
            {blip && <BlipCard key={blip.topic} b={blip} research={research} onWatch={onWatch} />}
          </div>
        ) : <Empty icon={<Crosshair size={22} />} title="Nothing moving in your lane yet">Add a few topics to your lane above, or sweep again in a while: Radar groups signals once two sources agree.</Empty>}
      </section>
      {sw.blips.length > 1 && (
        <div className="erows rd-list" role="list" aria-label="Every topic">
          {sw.blips.map((b, i) => (
            <div key={b.topic} className={`rd-row ${blip?.topic === b.topic ? "on" : ""}`} role="listitem">
              <span className="mono dim rd-rank">{String(i + 1).padStart(2, "0")}</span>
              <button type="button" className="rd-row-main" onClick={() => setPick(b.topic)} aria-pressed={blip?.topic === b.topic}>
                <b className="ellipsis">{b.topic}</b>
                <span className="tiny dim ellipsis">{b.why}</span>
              </button>
              <span className={`pill ${toneOf(b.verdict)}`}>{b.verdict}</span>
              <span className="mono small rd-num" title="Score: 60% heat, 40% fit">{b.score}</span>
              <button type="button" className="ghost xs" onClick={() => research(b.topic)}>Research</button>
            </div>
          ))}
        </div>
      )}
      <div className="an-duo">
        <Feed feed={sw.feed ?? []} research={research} />
        <section className="card an-card" aria-labelledby="rd-tr-h">
          <div className="card-head"><div><h2 id="rd-tr-h">Trending searches</h2><p className="sub">Google Trends today, {sw.geos.join(" and ")}: big, but often outside your lane</p></div></div>
          {sw.trending.length ? (
            <div className="chips">{sw.trending.map((t) => <button key={t.title} type="button" className="chip" onClick={() => research(t.title.split(" · ")[0].slice(0, 80))} title={`${t.metric}, ${t.geo}`}>{t.title.split(" · ")[0]} <span className="tiny dim">{t.metric.replace(" searches", "")}</span></button>)}</div>
          ) : <p className="small dim" style={{ margin: 0 }}>Google Trends didn&apos;t answer this time.</p>}
        </section>
      </div>
      <div className="an-duo">
        <SourceGrid list={sw.sources.map((s) => ({ ...s, name: SRC_NAME[s.id] ?? s.id }))} />
        <RecordCard rec={data.record} />
      </div>
    </>
  );
}

const fresh = (h: number) => (h < 1 ? "under an hour" : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`);

function BlipCard({ b, research, onWatch }: { b: Blip; research: (q: string) => void; onWatch: () => void }) {
  const { toast } = useDialog();
  const [watching, setWatching] = useState(false);
  const watch = async () => { setWatching(true); try { await api("radar/watch", { body: { q: b.topic } }); toast(`Watching “${b.topic}”`); onWatch(); } catch (e) { toast((e as Error).message, "bad"); } finally { setWatching(false); } };
  const conf = b.conf ?? "medium";
  return (
    <div className="rd-blipcard" aria-live="polite">
      <div className="rd-bc-top">
        <span className={`pill ${toneOf(b.verdict)}`}>{b.verdict}</span>
        <span className={`pill ${conf === "high" ? "ok" : conf === "medium" ? "warn" : "bad"}`} title={b.conf_why}>{conf} confidence</span>
        {b.sector && <span className="tiny dim mono">{SECTORS.find((s) => s.id === b.sector)?.name.toUpperCase()}{b.fresh_h != null ? ` · ${fresh(b.fresh_h)} old` : ""}</span>}
      </div>
      <h3>{b.topic}</h3>
      <p className="small dim">{b.why}</p>
      <div className="rd-bc-meters">
        <div><span className="tiny dim">Score</span><b className="mono">{b.score}</b></div>
        <div><span className="tiny dim">Heat</span><b className="mono">{b.heat}</b><i className="rd-tick" style={{ ["--v" as string]: `${b.heat}%` }} aria-hidden /></div>
        <div><span className="tiny dim">Fit</span><b className="mono">{b.fit}</b><i className="rd-tick" style={{ ["--v" as string]: `${b.fit}%` }} aria-hidden /></div>
      </div>
      {b.heat_parts && (
        <ul className="rd-hparts" aria-label="What the heat is made of">
          {b.heat_parts.map((p) => <li key={p.label}><span className="tiny">{p.label}</span><span className="tiny dim">{p.value}</span><span className="mono tiny">+{p.score}</span></li>)}
        </ul>
      )}
      <ul className="rd-ev">
        {b.signals.slice(0, 5).map((s, i) => (
          <li key={i}>
            <span className="pill rd-src-pill">{SWEEP_NAME[s.src] ?? s.src}</span>
            <a href={s.url} target="_blank" rel="noreferrer" className="ellipsis">{s.title.split(" · ")[0]}</a>
            <span className="tiny dim">{s.metric}</span>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="sm" onClick={() => research(b.topic)}><Target size={14} />Research it</button>
        <button type="button" className="ghost sm" onClick={watch} disabled={watching}><Eye size={14} />Watch</button>
        <AskClaude label="Ideas from Claude" prompt={`Use Voicebox keyword_research on "${b.topic}" (and its best long-tail), then write five post ideas with titles scored by seo_score. Evidence: ${b.signals.slice(0, 3).map((s) => s.title.split(" · ")[0]).join(" | ")}`} />
      </div>
    </div>
  );
}

/** Every signal the sweep read, newest first, across all the sources. */
function Feed({ feed, research }: { feed: NonNullable<Sweep["feed"]>; research: (q: string) => void }) {
  const [src, setSrc] = useState<string>("");
  const srcs = [...new Set(feed.map((f) => f.src))];
  const rows = (src ? feed.filter((f) => f.src === src) : feed).slice(0, 14);
  return (
    <section className="card an-card" aria-labelledby="rd-feed-h">
      <div className="card-head"><div><h2 id="rd-feed-h"><span className="gr-dot" aria-hidden />Signal feed</h2><p className="sub">The newest of {feed.length} signals this sweep read</p></div>
        {srcs.length > 1 && <Select size="sm" className="fx-chip-sel" label="Source" value={src} onChange={setSrc} options={[["", "Every source"], ...srcs.map((x) => [x, SWEEP_NAME[x] ?? x] as [string, string])]} />}</div>
      {rows.length ? (
        <ul className="rd-feed">
          {rows.map((f, i) => (
            <li key={`${f.url}${i}`} style={{ animationDelay: `${i * 35}ms` }}>
              <span className="mono tiny dim rd-feed-t">{f.src === "mastodon" || f.src === "hf" ? "trending" : ago(f.at)}</span>
              <span className="pill rd-src-pill">{SWEEP_NAME[f.src] ?? f.src}</span>
              <a href={f.url} target="_blank" rel="noreferrer" className="ellipsis">{f.title.split(" · ")[0]}</a>
              <button type="button" className="quiet xs hide-sm" onClick={() => research(f.title.split(" · ")[0].split(":")[0].slice(0, 60))} aria-label={`Research ${f.title.split(" · ")[0]}`}><Target size={13} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="small dim" style={{ margin: 0 }}>Sweep again to fill the feed.</p>}
    </section>
  );
}

/** Which sources answered this time and how fast, as a grid of lights. */
function SourceGrid({ list }: { list: { id: string; name: string; ok: boolean; ms: number; note?: string }[] }) {
  const ok = list.filter((s) => s.ok).length;
  return (
    <section className="card an-card" aria-labelledby="rd-sg-h">
      <div className="card-head"><div><h2 id="rd-sg-h">Sources</h2><p className="sub">{ok} of {list.length} answered. All free and public; Reddit and Bluesky refuse servers without a key</p></div></div>
      <ul className="rd-sgrid">
        {list.map((s) => (
          <li key={s.id} className={s.ok ? "" : "off"} title={s.ok ? undefined : s.note ?? "no answer"}>
            <span className={`gr-dot ${s.ok ? "" : "off"}`} aria-hidden /><span className="small ellipsis">{s.name}</span>
            <span className="mono tiny dim">{s.ok ? `${s.ms} ms` : s.note ?? "no answer"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Lane({ config, onSaved }: { config: Overview["config"]; onSaved: (c: Overview["config"]) => void }) {
  const [edit, setEdit] = useState(false);
  const [seeds, setSeeds] = useState(config.seeds.join(", "));
  const [geos, setGeos] = useState(config.geos);
  const [saving, setSaving] = useState(false);
  const { toast } = useDialog();
  useEffect(() => { setSeeds(config.seeds.join(", ")); setGeos(config.geos); }, [config]);
  const save = async () => {
    setSaving(true);
    try { onSaved(await api<Overview["config"]>("radar/config", { body: { seeds: seeds.split(",").map((s) => s.trim()).filter(Boolean), geos } })); setEdit(false); toast("Lane saved: sweeping again"); }
    catch (e) { toast((e as Error).message, "bad"); } finally { setSaving(false); }
  };
  if (!edit) return (
    <div className="rd-lane">
      <span className="small dim">Your lane{config.auto ? " (from your hits)" : ""}</span>
      <div className="chips">{config.seeds.map((s) => <span key={s} className="chip tag">{s}</span>)}</div>
      <span className="tiny dim">{config.geos.join(" · ")}</span>
      <button type="button" className="quiet sm" onClick={() => setEdit(true)}><PencilSimple size={14} />Edit</button>
    </div>
  );
  return (
    <div className="card rd-lane-edit">
      <Field label="Topics Radar watches" hint="Comma-separated, up to 16: your niche, products, people and formats (e.g. AI agents, Claude, n8n)">
        <input value={seeds} onChange={(e) => setSeeds(e.target.value)} maxLength={600} />
      </Field>
      <div className="row">
        <Field label="Main country"><Select value={geos[0] ?? "US"} onChange={(g) => setGeos([g, ...geos.slice(1).filter((x) => x !== g)].slice(0, 2))} options={GEO_NAMES} label="Main country" /></Field>
        <Field label="Second country"><Select value={geos[1] ?? ""} onChange={(g) => setGeos([geos[0] ?? "US", ...(g && g !== geos[0] ? [g] : [])])} options={[["", "None"], ...GEO_NAMES]} label="Second country" /></Field>
      </div>
      <div className="row"><button type="button" className="sm" onClick={save} disabled={saving}><Check size={14} />Save lane</button><button type="button" className="ghost sm" onClick={() => setEdit(false)}>Cancel</button></div>
    </div>
  );
}

function Sources({ list }: { list: { id: string; name: string; ok: boolean; ms: number; note?: string }[] }) {
  return (
    <details className="rd-src">
      <summary className="small dim">Sources: {list.filter((s) => s.ok).length} of {list.length} answered</summary>
      <ul>{list.map((s) => <li key={s.id} className="small"><span className={`gr-dot ${s.ok ? "" : "off"}`} aria-hidden />{s.name}<span className="tiny dim">{s.ok ? `${s.ms} ms` : s.note ?? "no answer"}</span></li>)}</ul>
      <p className="tiny dim">All free and public. Reddit and Bluesky refuse servers without a key, so they aren&apos;t read. Subscriber counts come from your connected YouTube channel (1 quota unit a keyword).</p>
    </details>
  );
}

function RecordCard({ rec }: { rec: TrackRecord }) {
  return (
    <section className="card an-card" aria-labelledby="rd-rec-h">
      <div className="card-head"><div><h2 id="rd-rec-h">Track record</h2><p className="sub">Each prediction against what the post actually did, a week after it went out</p></div></div>
      {rec.n ? (
        <div className="rd-rec">
          <div><b className="mono">{rec.within == null ? "—" : `${Math.round(rec.within * 100)}%`}</b><span className="tiny dim">within 2× of the prediction</span></div>
          <div><b className="mono">{rec.median_err == null ? "—" : xText(rec.median_err)}</b><span className="tiny dim">typical miss</span></div>
          <div><b className="mono">{rec.hit_calls == null ? "—" : `${Math.round(rec.hit_calls * 100)}%`}</b><span className="tiny dim">hit calls right</span></div>
          <div><b className="mono">{rec.n}</b><span className="tiny dim">played out, {rec.open} waiting</span></div>
        </div>
      ) : <p className="small dim" style={{ margin: 0 }}>{rec.open ? `${rec.open} prediction${rec.open === 1 ? "" : "s"} waiting on posts. Each is judged a week after its post goes out, and the predictions correct themselves as these add up.` : "No predictions judged yet. Watch a keyword or research one for a post (Claude: keyword_research with post_id), and they'll be checked against what happens."}</p>}
    </section>
  );
}

/* ───────────── Keyword */

function KeywordView({ q, research, onWatch }: { q: string; research: (q: string) => void; onWatch: () => void }) {
  const [geo, setGeo] = useState("");
  const [fmt, setFmt] = useState<Fmt | "">("");
  const [deep, setDeep] = useState(false);
  const [r, setR] = useState<Kw | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useDialog();
  const qs = `radar/kw?q=${encodeURIComponent(q)}${geo ? `&geo=${geo}` : ""}${fmt ? `&fmt=${fmt}` : ""}${deep ? "&deep=1" : ""}`;
  useSeed<Kw>(qs, (v) => q && setR(v));
  const run = (fresh = false) => {
    if (!q) return;
    setBusy(true); setErr("");
    api<Kw>(`${qs}${fresh ? "&fresh=1" : ""}`).then(setR, (e) => setErr((e as Error).message)).finally(() => setBusy(false));
  };
  useEffect(() => { run(); }, [qs]);
  const watch = async () => { try { await api("radar/watch", { body: { q, fmt: fmt || null } }); toast(`Watching “${q}”`); onWatch(); } catch (e) { toast((e as Error).message, "bad"); } };

  if (!q) return <Empty icon={<Target size={22} />} title="Research a keyword">Type a topic above. Radar reads autocomplete, YouTube, news, Hacker News, Wikipedia and Trends, then scores it against your own numbers.</Empty>;
  return (
    <>
      <div className="rd-opts">
        <Select size="sm" className="fx-chip-sel" label="Country" value={geo} onChange={setGeo} options={[["", "Lane's country"], ...GEO_NAMES]} />
        <Select size="sm" className="fx-chip-sel" label="Format" value={fmt} onChange={setFmt} options={[["", "Your main format"], ...FMTS]} />
        <button type="button" className={`chip ${deep ? "on" : ""}`} aria-pressed={deep} onClick={() => setDeep(!deep)} title="Adds an a-z sweep of the long tail">Deep long tail</button>
        <span className="rd-grow" />
        {r && <span className="tiny dim hide-sm">{r.cached ? "read" : "fresh"} {ago(r.at)}</span>}
        <button type="button" className="quiet sm" onClick={() => run(true)} disabled={busy} aria-label="Read the sources again"><ArrowsClockwise size={14} className={busy ? "spin" : ""} /></button>
      </div>
      {err && <Notice icon={<Warning size={18} />} tone="bad" action={<button className="ghost sm" onClick={() => run()}>Try again</button>}>Couldn&apos;t research “{q}”: {err}</Notice>}
      {!r ? <div className="an-wrap" aria-busy="true" aria-label={`Researching ${q}`}><div className="skel" style={{ height: 150 }} /><div className="skel" style={{ height: 300 }} /></div> : (
        <div className={`an-wrap ${busy ? "busy" : ""}`}>
          <section className="card an-card rd-verdict" aria-labelledby="rd-v-h">
            <OppRing v={r.opportunity} />
            <div className="rd-v-text">
              <div className="row"><span className={`pill ${toneOf(r.verdict)}`}>{r.verdict}</span><span className={`pill ${r.confidence === "high" ? "ok" : r.confidence === "medium" ? "warn" : "bad"}`} title={`${r.confidence_n} of 8 key sources answered`}>{r.confidence} confidence</span><span className="tiny dim">{r.geo}</span></div>
              <h2 id="rd-v-h">{r.q}</h2>
              {r.why.map((w, i) => <p key={i} className="small dim">{w}</p>)}
              <div className="row">
                <button type="button" className="sm" onClick={watch}><Eye size={14} />Watch</button>
                <AskClaude prompt={`Use Voicebox keyword_research on "${r.q}"${fmt ? ` for ${fmt}` : ""}, then write 10 titles, score them with seo_score, and give me the best 3 with a hook and a description that covers the related words.`} />
              </div>
            </div>
          </section>
          <div className="rd-four">
            <ScoreCard name="Demand" s={r.demand} />
            <ScoreCard name="Momentum" s={r.momentum} note="50 is steady" />
            <ScoreCard name="Competition" s={r.competition} invert note="Higher is harder" />
            <ScoreCard name="Fit" s={r.fit} />
          </div>
          <Predict r={r} />
          <TitleLab r={r} />
          <div className="an-duo">
            <section className="card an-card" aria-labelledby="rd-lt-h">
              <div className="card-head"><div><h2 id="rd-lt-h">Long tail</h2><p className="sub">Longer searches around it: easier to rank for, and clearer about what people want</p></div></div>
              <div className="rd-tail">{r.longtail.map((l) => (
                <button key={l.q} type="button" className="rd-tail-row" onClick={() => research(l.q)} title={l.why}><span className="ellipsis">{l.q}</span><span className="tiny dim hide-sm">{l.why}</span><span className="mono small">{l.opp}</span></button>
              ))}</div>
            </section>
            <div className="stack">
              <section className="card an-card" aria-labelledby="rd-qs-h">
                <div className="card-head"><div><h2 id="rd-qs-h">Questions people ask</h2><p className="sub">Each one is a video, or a line to answer in yours</p></div></div>
                {r.questions.length ? <ul className="rd-qs">{r.questions.map((x) => <li key={x}><button type="button" className="quiet sm" onClick={() => research(x)}>{x}?</button></li>)}</ul> : <p className="small dim" style={{ margin: 0 }}>No questions in the autocompletes.</p>}
              </section>
              <section className="card an-card" aria-labelledby="rd-rel-h">
                <div className="card-head"><div><h2 id="rd-rel-h">Words searchers add</h2><p className="sub">Cover the top ones in your title, description and tags</p></div></div>
                <div className="chips">{r.related.slice(0, 16).map((w) => <span key={w.word} className="chip tag">{w.word} <span className="dim">{w.n}</span></span>)}</div>
              </section>
              {(r.hashtags?.length ?? 0) > 0 && <Hashtags tags={r.hashtags} />}
            </div>
          </div>
          <Ranking r={r} />
          {(r.news.length > 0 || r.hn.length > 0) && (
            <div className="an-duo">
              <section className="card an-card" aria-labelledby="rd-news-h">
                <div className="card-head"><div><h2 id="rd-news-h">In the news</h2><p className="sub">Google News, the last month</p></div></div>
                <ul className="rd-ev">{r.news.map((n, i) => <li key={i}><a href={n.url} target="_blank" rel="noreferrer" className="ellipsis">{n.title}</a><span className="tiny dim">{n.source} · {ago(n.at)}</span></li>)}</ul>
              </section>
              <section className="card an-card" aria-labelledby="rd-hn-h">
                <div className="card-head"><div><h2 id="rd-hn-h">On Hacker News</h2><p className="sub">What builders are reading about it this month</p></div></div>
                {r.hn.length ? <ul className="rd-ev">{r.hn.map((n, i) => <li key={i}><a href={n.url} target="_blank" rel="noreferrer" className="ellipsis">{n.title}</a><span className="tiny dim mono">{n.points} pts · {n.comments} comments</span></li>)}</ul> : <p className="small dim" style={{ margin: 0 }}>Nothing this month.</p>}
              </section>
            </div>
          )}
          <Sources list={r.sources.map((s) => ({ ...s, name: SRC_NAME[s.id] }))} />
        </div>
      )}
    </>
  );
}

function Hashtags({ tags }: { tags: Research["hashtags"] }) {
  const { toast } = useDialog();
  const all = tags.slice(0, 8).map((t) => `#${t.tag}`).join(" ");
  return (
    <section className="card an-card" aria-labelledby="rd-ht-h">
      <div className="card-head"><div><h2 id="rd-ht-h"><Hash size={15} />Hashtags</h2><p className="sub">What the videos ranking for it use, the keyword and its long tail</p></div>
        <button type="button" className="ghost sm" onClick={() => navigator.clipboard.writeText(all).then(() => toast("Hashtags copied"), () => toast("Couldn't copy", "bad"))}><Copy size={14} />Copy</button></div>
      <div className="chips">{tags.map((t) => <span key={t.tag} className="chip tag" title={t.why}>#{t.tag} <span className="dim">{t.n}</span></span>)}</div>
    </section>
  );
}

function OppRing({ v }: { v: number }) {
  const n = 9, lit = Math.round((v / 100) * n);
  return (
    <figure className="rd-opp" aria-label={`Opportunity ${v} out of 100`}>
      <span className="rd-opp-dial">
        <svg viewBox="-60 -60 120 120" aria-hidden>{Array.from({ length: n }, (_, i) => <circle key={i} r={24 + i * 4} className={i < lit ? "lit" : ""} style={{ transitionDelay: `${i * 40}ms` }} />)}</svg>
        <b className="mono">{v}</b>
      </span>
      <figcaption className="tiny dim">Opportunity</figcaption>
    </figure>
  );
}

function ScoreCard({ name, s, invert, note }: { name: string; s: ScoreT; invert?: boolean; note?: string }) {
  const tone = invert ? (s.score >= 65 ? "bad" : s.score >= 45 ? "warn" : "ok") : name === "Momentum" ? (s.score >= 60 ? "ok" : s.score >= 44 ? "" : "warn") : s.score >= 65 ? "ok" : s.score >= 40 ? "" : "warn";
  return (
    <section className="card an-card rd-score" aria-label={`${name}: ${s.score} out of 100`}>
      <div className="rd-s-top"><h3>{name}</h3>{note && <span className="tiny dim">{note}</span>}</div>
      <div className="rd-s-num"><b className={`mono rd-${tone}`}>{s.score}</b><span className="small">{s.line}</span></div>
      <div className="rd-meter" aria-hidden><i style={{ width: `${s.score}%` }} className={`rd-${tone}`} /></div>
      <ul className="rd-parts">{s.parts.map((p) => <li key={p.label}><span className="tiny">{p.label}</span><span className="tiny dim ellipsis" title={p.value}>{p.value}</span><span className="mono tiny">{p.score}</span></li>)}</ul>
      {s.cover < 0.6 && <p className="tiny dim" style={{ margin: 0 }}>Only part of this had data behind it.</p>}
    </section>
  );
}

function Predict({ r }: { r: Kw }) {
  const p = r.prediction;
  const max = Math.max(3, p.x_high * 1.15);
  const at = (x: number) => `${Math.min(100, (Math.log(1 + x) / Math.log(1 + max)) * 100)}%`;
  return (
    <section className="card an-card" aria-labelledby="rd-p-h">
      <div className="card-head"><div><h2 id="rd-p-h">Prediction</h2><p className="sub">{p.basis}</p></div><span className="pill blue">{FMTS.find((f) => f[0] === p.fmt)?.[1]}</span></div>
      <div className="rd-pred">
        <div className="rd-pred-nums">
          <div><b className="mono">{p.views == null ? xText(p.x) : compact(p.views)}</b><span className="tiny dim">{p.views == null ? "your usual" : `views expected (${xText(p.x)} your usual)`}</span></div>
          <div><b className="mono">{p.low == null ? `${xText(p.x_low)}–${xText(p.x_high)}` : `${compact(p.low)}–${compact(p.high)}`}</b><span className="tiny dim">the middle half of outcomes</span></div>
          <div><b className="mono">{Math.round(p.hit_chance * 100)}%</b><span className="tiny dim">chance of a hit (1.5× your usual)</span></div>
        </div>
        <div className="rd-range" role="img" aria-label={`Expected ${xText(p.x)} your usual, most likely between ${xText(p.x_low)} and ${xText(p.x_high)}`}>
          <span className="rd-range-band" style={{ left: at(p.x_low), width: `calc(${at(p.x_high)} - ${at(p.x_low)})` }} />
          <span className="rd-range-usual" style={{ left: at(1) }}><span className="tiny dim">usual</span></span>
          <span className="rd-range-hit" style={{ left: at(1.5) }}><span className="tiny dim">hit</span></span>
          <span className="rd-range-x" style={{ left: at(p.x) }} />
        </div>
        <ul className="rd-factors">{p.factors.map((f) => <li key={f.label} className="small"><span>{f.label}</span><span className={`mono ${f.x >= 1.05 ? "rd-ok" : f.x <= 0.95 ? "rd-warn" : "dim"}`}>{xText(f.x)}</span></li>)}</ul>
        <p className="tiny dim" style={{ margin: 0 }}>Your usual, moved by each factor above. {r.record.n ? `Corrected by ${r.record.n} predictions that played out.` : "It corrects itself as predictions play out (Watchlist → Track record)."}</p>
      </div>
    </section>
  );
}

function TitleLab({ r }: { r: Kw }) {
  const [room, setRoom] = useState<WritingData | null>(null);
  useSeed<WritingData>("writing", setRoom);
  useEffect(() => { api<WritingData>("writing").then(setRoom).catch(() => null); }, []);
  const model = useMemo(() => (room ? titleModel(room.items) : null), [room]);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [tags, setTags] = useState("");
  const related = r.related.slice(0, 8).map((x) => x.word);
  const ideas = useMemo(() => (model ? r.titles.map((t) => ({ ...t, ...titleScore(t.title, r.q, model, { related, fmt: r.fmt }) })).sort((a, b) => b.score - a.score) : r.titles), [model, r]);
  const mine = title.trim() ? { ...titleScore(title, r.q, model, { related, fmt: r.fmt }), seoFull: seoScore({ q: r.q, title, description: desc || null, tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : null, related, fmt: r.fmt }) } : null;
  return (
    <section className="card an-card" aria-labelledby="rd-tl-h">
      <div className="card-head"><div><h2 id="rd-tl-h">Title lab</h2><p className="sub">Search (SEO) and click (what your hits do) together. Starters below are rule-made; Claude writes better ones</p></div>
        <AskClaude prompt={`Use Voicebox keyword_research on "${r.q}", write 12 titles that put the keyword first, cover these related words (${related.slice(0, 5).join(", ")}) and follow my winning title habits (title_lab), score them with seo_score, and give me the best 5.`} /></div>
      <div className="rd-tl">
        <div className="stack">
          <Field label="Your title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`e.g. ${ideas[0]?.title ?? r.q}`} maxLength={200} /></Field>
          <Field label="Description" hint="Optional: adds the description checks"><textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} maxLength={5000} /></Field>
          <Field label="Tags" hint="Optional, comma-separated"><input value={tags} onChange={(e) => setTags(e.target.value)} maxLength={600} /></Field>
          {mine && (
            <div className="rd-mine" aria-live="polite">
              <div className="rd-mine-nums"><div><b className="mono">{mine.score}</b><span className="tiny dim">title score</span></div><div><b className="mono">{mine.seoFull.score}</b><span className="tiny dim">SEO{mine.seoFull.partial ? " (partial)" : ""}</span></div><div><b className="mono">{mine.click}</b><span className="tiny dim">click</span></div></div>
              <ul className="wr-checks">{mine.seoFull.checks.map((c) => <li key={c.id} className={c.ok ? "ok" : c.part > 0 ? "half" : "no"}><span className="wr-ck" aria-hidden>{c.ok ? <Check size={12} weight="bold" /> : c.part > 0 ? "½" : <X size={12} weight="bold" />}</span><span><b>{c.label}</b><span className="small dim">{c.why}</span></span><span className="mono tiny wr-ck-w">{Math.round(c.weight * c.part)}/{c.weight}</span></li>)}</ul>
            </div>
          )}
        </div>
        <div className="erows" role="list" aria-label="Starter titles">
          {ideas.map((t) => (
            <div key={t.title} className="rd-idea" role="listitem">
              <button type="button" className="rd-idea-t" onClick={() => setTitle(t.title)} title="Try it in the lab"><b>{t.title}</b><span className="tiny dim">{t.from}</span></button>
              <span className="tiny dim mono hide-sm" title="SEO · click">{t.seo} · {t.click}</span>
              <span className="mono small rd-num">{t.score}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Ranking({ r }: { r: Kw }) {
  const [tab, setTab] = useState<"top" | "month">("top");
  const rows = tab === "top" ? r.top : r.month;
  return (
    <section className="card an-card" aria-labelledby="rd-rk-h">
      <div className="card-head"><div><h2 id="rd-rk-h">What ranks now</h2><p className="sub">YouTube&apos;s results for it: who you&apos;re up against</p></div>
        <div className="seg"><button type="button" className={tab === "top" ? "on" : ""} aria-pressed={tab === "top"} onClick={() => setTab("top")}>Top results</button><button type="button" className={tab === "month" ? "on" : ""} aria-pressed={tab === "month"} onClick={() => setTab("month")}>This month</button></div></div>
      {rows.length ? (
        <div className="table-wrap"><table className="table rd-table">
          <thead><tr><th scope="col">Video</th><th scope="col" className="rd-n">Views</th><th scope="col" className="rd-n hide-sm">A day</th><th scope="col" className="rd-n">Age</th><th scope="col" className="rd-n hide-sm">Channel subs</th></tr></thead>
          <tbody>{rows.map((h) => (
            <tr key={h.id}>
              <td><a href={`https://youtu.be/${h.id}`} target="_blank" rel="noreferrer" className="rd-vid"><img src={`https://i.ytimg.com/vi/${h.id}/mqdefault.jpg`} alt="" loading="lazy" /><span><b className="ellipsis">{h.title}</b><span className="tiny dim ellipsis">{h.channel}</span></span></a></td>
              <td className="rd-n mono">{compact(h.views)}</td>
              <td className="rd-n mono hide-sm">{h.views != null && h.age_days != null ? compact(h.views / Math.max(1, h.age_days)) : "—"}</td>
              <td className="rd-n mono">{ageText(h.age_days)}</td>
              <td className="rd-n mono hide-sm">{compact(h.subs ?? null)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="small dim" style={{ margin: 0 }}>{tab === "top" ? "YouTube's search didn't answer." : "Nothing uploaded this month."}</p>}
    </section>
  );
}

/* ───────────── Watchlist */

function WatchView({ data, research, onChange }: { data: Overview | null; research: (q: string) => void; onChange: () => void }) {
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState("");
  const { toast } = useDialog();
  if (!data) return <div className="skel" style={{ height: 300 }} aria-busy="true" aria-label="Loading the watchlist" />;
  const doAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (add.trim().length < 2) return;
    setBusy(add);
    try { await api("radar/watch", { body: { q: add.trim() } }); setAdd(""); onChange(); } catch (er) { toast((er as Error).message, "bad"); } finally { setBusy(""); }
  };
  const remove = async (q: string) => { setBusy(q); try { await api("radar/unwatch", { body: { q } }); onChange(); } catch (er) { toast((er as Error).message, "bad"); } finally { setBusy(""); } };
  return (
    <>
      <form className="rd-search" onSubmit={doAdd}>
        <div className="searchbox"><Plus size={15} className="ic" aria-hidden /><input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Watch a keyword…" aria-label="Keyword to watch" maxLength={80} /></div>
        <button type="submit" className="sm" disabled={!!busy}>{busy && busy === add ? "Reading…" : "Watch"}</button>
      </form>
      {data.watch.length ? (
        <div className="table-wrap"><table className="table rd-table">
          <thead><tr><th scope="col">Keyword</th><th scope="col">Opportunity</th><th scope="col" className="rd-n hide-sm">Demand</th><th scope="col" className="rd-n hide-sm">Momentum</th><th scope="col" className="rd-n hide-sm">Competition</th><th scope="col" className="rd-n">Predicted</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{data.watch.map((w) => {
            const h = w.history.at(-1), prev = w.history.at(-2);
            const d = h && prev ? h.opp - prev.opp : 0;
            const flag = h ? (d >= 6 ? ["Rising", "ok"] : h.m >= 70 ? ["Moving fast", "ok"] : d <= -6 ? ["Cooling", "warn"] : null) : null;
            return (
              <tr key={w.q}>
                <th scope="row"><button type="button" className="quiet sm" onClick={() => research(w.q)}>{w.q}</button>{flag && <span className={`pill ${flag[1]} rd-flag`}>{flag[0]}</span>}<div className="tiny dim">{w.by} · {ago(w.added)}</div></th>
                <td><span className="rd-wopp"><b className="mono">{h?.opp ?? "—"}</b>{d !== 0 && <span className={`tiny mono ${d > 0 ? "rd-ok" : "rd-warn"}`}>{d > 0 ? "+" : ""}{d}</span>}{w.history.length > 1 && <Sparkline values={w.history.map((x) => x.opp)} w={72} h={22} label={`${w.q} opportunity over time`} fit />}</span></td>
                <td className="rd-n mono hide-sm">{h?.d ?? "—"}</td>
                <td className="rd-n mono hide-sm">{h?.m ?? "—"}</td>
                <td className="rd-n mono hide-sm">{h?.c ?? "—"}</td>
                <td className="rd-n mono">{h ? xText(h.x) : "—"}</td>
                <td className="rd-n"><button type="button" className="quiet xs" onClick={() => remove(w.q)} disabled={busy === w.q} aria-label={`Stop watching ${w.q}`}><Trash size={14} /></button></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      ) : <Empty icon={<TrendUp size={22} />} title="Nothing watched yet">Watch a keyword and Radar re-reads it about once a day, so you see it rising before it peaks.</Empty>}
      <RecordCard rec={data.record} />
      {data.record.recent.length > 0 && (
        <div className="table-wrap"><table className="table rd-table">
          <thead><tr><th scope="col">Prediction</th><th scope="col" className="rd-n">Predicted</th><th scope="col" className="rd-n">Actual</th><th scope="col" className="hide-sm">Post</th></tr></thead>
          <tbody>{data.record.recent.map((p) => (
            <tr key={p.id}>
              <th scope="row"><span className="small">{p.q}</span><div className="tiny dim">{FMTS.find((f) => f[0] === p.fmt)?.[1]} · {ago(p.at)} · {p.by}</div></th>
              <td className="rd-n mono">{xText(p.x)} <span className="tiny dim">{Math.round(p.hit_chance * 100)}%</span></td>
              <td className="rd-n mono">{p.actual ? <span className={p.actual.x >= p.x / 2 && p.actual.x <= p.x * 2 ? "rd-ok" : "rd-warn"}>{xText(p.actual.x)}</span> : <span className="tiny dim">waiting</span>}</td>
              <td className="hide-sm">{p.actual ? <a href={p.actual.url} target="_blank" rel="noreferrer" className="small ellipsis">{p.actual.title} <ArrowSquareOut size={12} /></a> : p.post_id ? <Link href={`/posts?post=${p.post_id}`} className="small">Open post</Link> : <span className="tiny dim">first post on it</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
