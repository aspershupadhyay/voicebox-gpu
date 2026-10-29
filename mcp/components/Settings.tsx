"use client";
// Settings, as tabs along the top with their own addresses (?tab=): Profile, Voice & sound, Publishing, GPU & engines,
// Security, Automation, Claude & API. Each tab is a bento of cards. Studio-wide defaults are stored with the library so the dashboard
// and every MCP client share them; changes collect until you press Save (a bar appears while anything is unsaved, on any
// tab, and leaving asks first). Security, upload keys and the GPU act at once.
import { ChartLineUp, CheckCircle, Code, Robot, Copy, Cpu, Megaphone, RocketLaunch, ShieldCheck, SignOut, SlidersHorizontal, UserCircle, Waveform } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { signOut, useMe } from "./aw";
import Automation from "./Automation";
import Gpu from "./Gpu";
import { PixelAvatar, PixelScene } from "./pixel";
import { LookCard, useLook } from "./look";
import { api, useSeed, type MyVoice } from "./api";
import { useDialog } from "./Dialog";
import SecurityCard from "./SecurityCard";
import UploadKeys from "./UploadKeys";
import { Field, Toggle } from "./ui";
import { Select } from "./pop";

type S = {
  engine: string; voice: string; style: string; platform: string; takes: number; subtitles: boolean; lexicon: boolean;
  pronounce: Record<string, string>; enhance_recordings: boolean; enhance_input: boolean; enhance_output: boolean;
  backup_media: boolean; review: boolean; personal?: boolean; mcp_github: string[]; workspace_emails: string[];
};

const TABS = [
  { id: "profile", name: "Profile", icon: UserCircle, mv: "voices" },
  { id: "voice", name: "Voice & sound", icon: Waveform, mv: "cc" },
  { id: "publishing", name: "Publishing", icon: RocketLaunch, mv: "chart" },
  { id: "gpu", name: "GPU & engines", icon: Cpu, mv: "chip" },
  { id: "security", name: "Security", icon: ShieldCheck, mv: "trophy" },
  { id: "automation", name: "Automation", icon: Robot, mv: "chip" },
  { id: "api", name: "Claude & API", icon: Code, mv: "rows" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** The tabs as a bar along the top (the breadcrumb already says Settings). Arrow keys move along it. */
function SetNav({ tab, go }: { tab: Tab; go: (t: Tab) => void }) {
  // on a phone the bar scrolls: keep the open tab in view
  useEffect(() => { document.getElementById(`set-${tab}`)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [tab]);
  return (
    <nav className="set-nav" aria-label="Settings sections" style={{ "--i": TABS.findIndex((t) => t.id === tab), "--n": TABS.length } as React.CSSProperties}>
      <span className="set-pill" aria-hidden />
      {TABS.map(({ id, name, icon: Ic, mv }) => (
        <Link key={id} href={`/settings?tab=${id}`} scroll={false} className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined}
          onClick={(e) => { e.preventDefault(); go(id); }}
          onKeyDown={(e) => {
            const i = TABS.findIndex((t) => t.id === id);
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]; go(n.id); document.getElementById(`set-${n.id}`)?.focus(); }
          }} id={`set-${id}`}>
          <Ic size={16} weight="duotone" className="mv" data-move={mv} />{name}
        </Link>
      ))}
    </nav>
  );
}

const lexText = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `${k} = ${v}`).join("\n");

export default function Settings() {
  const { toast } = useDialog();
  const params = useSearchParams();
  const router = useRouter();
  const me = useMe();
  const look = useLook();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "profile") as Tab;
  const go = (t: Tab) => router.replace(`/settings?tab=${t}`, { scroll: false });
  const [saved, setSaved] = useState<S | null>(null);
  const [s, setS] = useState<S | null>(null);
  const [mine, setMine] = useState<MyVoice[]>([]);
  useSeed<S>("settings", (x) => { setS((c) => c ?? x); setSaved((c) => c ?? x); setLex((c) => c || lexText(x.pronounce)); });
  const [models, setModels] = useState<string[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [lex, setLex] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<S>("settings").then((x) => { setS(x); setSaved(x); setLex(lexText(x.pronounce)); }).catch((e) => setErr(e.message));
    api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {});
    api<{ models: { name: string }[] }>("models").then((r) => setModels(r.models.map((m) => m.name))).catch(() => {});
    fetch("/api/ws/me").then((r) => r.json()).then((m) => setSignedIn(!!m?.user)).catch(() => {});
  }, []);

  const changes = useMemo(() => {
    if (!s || !saved) return 0;
    const keys = Object.keys(s).filter((k) => k !== "pronounce") as (keyof S)[];
    return keys.filter((k) => JSON.stringify(s[k]) !== JSON.stringify(saved[k])).length + (lex.trim() !== lexText(saved.pronounce).trim() ? 1 : 0);
  }, [s, saved, lex]);
  useEffect(() => {
    if (!changes) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [changes]);

  if (!s) return <><SetNav tab={tab} go={go} />{err ? <p className="err" role="alert">{err}</p> : <div className="skel" style={{ height: 320 }} />}</>;
  const set = <K extends keyof S>(k: K, v: S[K]) => setS({ ...s, [k]: v });

  async function save() {
    setSaving(true);
    const pronounce: Record<string, string> = {};
    for (const l of lex.split("\n")) {
      const i = l.indexOf("=");
      if (i > 0 && l.slice(0, i).trim() && l.slice(i + 1).trim()) pronounce[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    try {
      const next = await api<S>("settings", { body: { ...s, pronounce } });
      setS(next); setSaved(next); setLex(lexText(next.pronounce));
      toast("Saved. The dashboard and your MCP clients use these now", "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setSaving(false);
    }
  }

  const voices: [string, string][] = s.engine === "myvoice" ? (models.length ? models.map((n) => [n, `${n} (trained)`] as [string, string]) : [["me", "trained model"]]) : s.engine === "orpheus" ? ["tara", "leah", "jess", "mia", "zoe", "leo", "dan", "zac"].map((v) => [v, v])
    : s.engine === "kokoro" ? ["af_heart", "af_bella", "am_fenrir", "am_michael", "am_puck"].map((v) => [v, v])
    : [...mine.map((m) => [m.name, `${m.label} (your voice)`] as [string, string]), ["female", "female preset"], ["male", "male preset"]];

  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast("Copied", "ok")).catch(() => toast("Couldn't copy: select it and copy", "bad"));
  const mcpUrl = typeof window === "undefined" ? "" : `${location.origin}/api/mcp`;
  const shared = (
    <div className="notice ok set-shared" style={{ margin: 0 }}><span className="n-ic"><CheckCircle size={18} weight="fill" /></span>
      <span className="n-text">Stored with your library, not in this browser, so both of you and Claude use the same defaults.</span></div>
  );

  return (
    <>
      <SetNav tab={tab} go={go} />
      <div key={tab} className="set-view">
        {tab === "profile" && (
          <div className="bento">
            <section className="card b-4 set-me-card">
              <div className="set-banner"><PixelScene /></div>
              <div className="set-me">
              <PixelAvatar name={me?.user?.email ?? me?.user?.name ?? "access token"} char={look.avatar} size={76} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <h2 className="ellipsis">{me?.user?.name ?? (me ? "Access token" : " ")}</h2>
                <p className="dim small ellipsis" style={{ margin: "2px 0 0" }}>{me?.user?.email ?? (me ? "Signed in with the access token: studio only, no shared workspace" : " ")}</p>
                <div className="row" style={{ gap: 6, marginTop: 10 }}>
                  <span className="pill ok"><CheckCircle size={12} weight="fill" />Invite-only studio</span>
                  {me?.workspace && <span className="pill blue">Shared workspace</span>}
                </div>
              </div>
              <button className="ghost sm" onClick={async () => { await signOut(); location.href = "/login"; }}><SignOut size={14} />Sign out</button>
              </div>
            </section>
            <section className="card b-2 set-jump">
              <div className="card-head"><div><h2>Jump to</h2><p className="sub">Where the studio&apos;s other controls live</p></div></div>
              <Link href="/analytics" className="set-j"><ChartLineUp size={17} weight="duotone" className="mv" data-move="chart" />Grow<span className="dim tiny">analytics, live, rivals</span></Link>
              <Link href="/posts?view=autopilot" className="set-j"><RocketLaunch size={17} weight="duotone" className="mv" data-move="chart" />Connected accounts<span className="dim tiny">Posts → Autopilot</span></Link>
              <button type="button" className="set-j" onClick={() => go("gpu")}><Cpu size={17} weight="duotone" className="mv" data-move="chip" />The GPU<span className="dim tiny">start, stop, engines</span></button>
            </section>
            <LookCard name={me?.user?.email ?? me?.user?.name ?? "access token"} />
            <div className="b-3"><SecurityCard part="device" /></div>
            <section className="card b-3">
              <div className="card-head"><div><h2>Your voice settings</h2><p className="sub">Just yours, or the studio&apos;s</p></div><SlidersHorizontal size={18} className="dim" /></div>
              {signedIn ? <Toggle on={!!s.personal} set={(v) => set("personal", v)} title="This engine and voice just for me"
                about="On: only your voiceovers use them; the other person keeps theirs. Off: they're the studio default for both of you and Claude." />
                : <p className="small dim" style={{ margin: 0 }}>Sign in with your own account to keep a voice just for you.</p>}
              <button type="button" className="ghost sm" style={{ marginTop: 12 }} onClick={() => go("voice")}>Open Voice &amp; sound</button>
            </section>
          </div>
        )}

        {tab === "voice" && (
          <div className="bento">
            <section className="card b-4">
              <div className="card-head"><div><h2>Voice</h2><p className="sub">What a new voiceover starts with. Any single request can override it.</p></div></div>
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0 12px" }}>
                <Field label="Engine">
                  <Select value={s.engine} onChange={(v) => setS({ ...s, engine: v, voice: v === "myvoice" ? models[0] ?? "me" : v === "orpheus" ? "tara" : v === "kokoro" ? "af_heart" : mine[0]?.name ?? "female" })}
                    options={[["qwen", "Qwen · your voice"], ["myvoice", "Your voice model"], ["orpheus", "Orpheus · most human"], ["chatterbox", "Chatterbox · emotion"], ["kokoro", "Kokoro · instant"]]} />
                </Field>
                <Field label="Voice"><Select value={s.voice} onChange={(v) => set("voice", v)} options={voices} /></Field>
                <Field label="Delivery"><Select value={s.style} onChange={(v) => set("style", v)} options={[["tech", "Tech explainer"], ["hype", "Launch / hype"], ["narrator", "Calm narrator"], ["neutral", "Neutral"]]} /></Field>
                <div className="field"><span className="f" style={{ display: "block", font: "500 13px var(--sans)", color: "var(--ink2)", marginBottom: 6 }} id="set-takes">Best of</span>
                  <div className="seg" role="radiogroup" aria-labelledby="set-takes">{[1, 2, 3, 4].map((n) => <button key={n} role="radio" aria-checked={s.takes === n} className={s.takes === n ? "on" : ""} onClick={() => set("takes", n)}>{n}×</button>)}</div></div>
              </div>
              {signedIn && <Toggle on={!!s.personal} set={(v) => set("personal", v)} title="This engine and voice just for me"
                about="On: only your voiceovers use them; the other person keeps theirs. Off: they're the studio default for both of you and Claude." />}
            </section>
            <section className="card b-2">
              <div className="card-head"><div><h2>Checks</h2><p className="sub">What every voiceover gets</p></div></div>
              <Toggle on={s.subtitles} set={(v) => set("subtitles", v)} title="Subtitles" about="Word-timed SRT/VTT, with script and voice match scores." />
              <Toggle on={s.review} set={(v) => set("review", v)} title="Review every sentence"
                about="Whisper listens back; a sentence that skips, swaps or adds a word, or drifts off your voice, is voiced again (up to 2 more tries)." />
              <Toggle on={s.lexicon} set={(v) => set("lexicon", v)} title="Tech pronunciation" about="SQL → sequel, GPU → G-P-U, 16GB → 16 gigabytes; markdown and links cleaned." />
            </section>
            <section className="card b-3">
              <div className="card-head"><div><h2>Pronunciation dictionary</h2><p className="sub">One per line: word = how to say it. A request&apos;s own pronunciations win per word.</p></div></div>
              <textarea aria-label="Your pronunciation dictionary" value={lex} onChange={(e) => setLex(e.target.value)} spellCheck={false} style={{ minHeight: 150 }} placeholder={"Kubernetes = koo-ber-net-eez\nYourBrand = your brand"} />
            </section>
            <section className="card b-3">
              <div className="card-head"><div><h2>Studio sound</h2><p className="sub">AI clean-up applied around your voice.</p></div></div>
              <Toggle on={s.enhance_recordings} set={(v) => set("enhance_recordings", v)} title="Enhance voice recordings"
                about="Noise and echo out, detail restored, before a recording becomes a voice. A cleaner reference means a better clone." />
              <Toggle on={s.enhance_input} set={(v) => set("enhance_input", v)} title="Clean re-voice input" about="Remove background noise from a performance before re-voicing it." />
              <Toggle on={s.enhance_output} set={(v) => set("enhance_output", v)} title="Studio polish on generated speech" about="Run every generated line through the enhancer too. Slower; subtle." />
            </section>
            <div className="b-6">{shared}</div>
          </div>
        )}

        {tab === "publishing" && (
          <div className="bento">
            <section className="card b-3">
              <div className="card-head"><div><h2>Default platform</h2><p className="sub">How a new voiceover is mastered</p></div></div>
              <Select label="Default platform" value={s.platform} onChange={(v) => set("platform", v)}
                options={[["youtube", "YouTube · -14 LUFS, subtitles"], ["shorts", "YouTube Shorts · -14 LUFS, pop-up captions"], ["reels", "Instagram Reels · -14 LUFS, pop-up captions"],
                  ["tiktok", "TikTok · -14 LUFS, pop-up captions"], ["podcast", "Podcast · -16 LUFS"], ["raw", "Raw · no mastering"]]} />
            </section>
            <section className="card b-3">
              <div className="card-head"><div><h2>Files backup</h2><p className="sub">A second copy of everything in Files</p></div></div>
              <Toggle on={s.backup_media} set={(v) => set("backup_media", v)} title="Back up uploads to R2"
                about="Every file added to the workspace is also copied to your R2 bucket (up to ~180 MB), so nothing is lost if Appwrite is down." />
            </section>
            <section className="card b-6 set-wide">
              <div><h2>YouTube and Instagram</h2><p className="sub dim small" style={{ margin: "4px 0 0" }}>Connected accounts, posting slots, cross-posting rules and retries live with the posts.</p></div>
              <Link href="/posts?view=autopilot" className="btn ghost sm"><Megaphone size={14} />Open Autopilot</Link>
            </section>
            <div className="b-6">{shared}</div>
          </div>
        )}

        {tab === "gpu" && <Gpu embedded />}

        {tab === "security" && (
          <div className="bento">
            <div className="b-3"><SecurityCard part="people" /></div>
            <div className="b-3 stack" style={{ gap: 16 }}><SecurityCard part="device" /><SecurityCard part="log" /></div>
          </div>
        )}

        {tab === "automation" && <Automation />}

        {tab === "api" && (
          <div className="bento">
            <section className="card b-3">
              <div className="card-head"><div><h2>Claude / MCP access</h2><p className="sub">Let Claude use the studio: voice scripts, plan posts, start the GPU, save files.</p></div></div>
              <Field label="MCP server URL" hint="In claude.ai: Settings → Connectors → Add custom connector, paste the URL, leave the OAuth fields empty. Connecting asks the person to sign in here first, so only people under Security can connect a Claude.">
                <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                  <input readOnly aria-label="MCP server URL" value={mcpUrl} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "var(--mono)", fontSize: 13 }} />
                  <button className="ghost" onClick={() => copy(mcpUrl)}><Copy size={14} />Copy</button>
                </div>
              </Field>
            </section>
            <div className="b-3"><UploadKeys /></div>
          </div>
        )}
      </div>

      {changes > 0 && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span className="grow">{changes} unsaved change{changes > 1 ? "s" : ""}</span>
          <button className="ghost sm" onClick={() => { setS(saved); if (saved) setLex(lexText(saved.pronounce)); }} disabled={saving}>Discard</button>
          <button className="light sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      )}
    </>
  );
}
