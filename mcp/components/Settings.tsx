"use client";
import { CheckCircle, Copy, FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type MyVoice } from "./api";
import { useDialog } from "./Dialog";

type S = {
  engine: string; voice: string; style: string; platform: string; takes: number; subtitles: boolean; lexicon: boolean;
  pronounce: Record<string, string>; enhance_recordings: boolean; enhance_input: boolean; enhance_output: boolean;
  backup_media: boolean; review: boolean; personal?: boolean; mcp_github: string[]; workspace_emails: string[];
};

const opt = (pairs: readonly (readonly [string, string])[]) => pairs.map(([v, l]) => <option key={v} value={v}>{l}</option>);

function Toggle({ on, set, title, about }: { on: boolean; set: (v: boolean) => void; title: string; about: string }) {
  return (
    <div className="row between" style={{ gap: 14, padding: "10px 0" }}>
      <div style={{ minWidth: 0 }}><b className="small">{title}</b><div className="dim tiny">{about}</div></div>
      <button className={`switch ${on ? "on" : ""}`} onClick={() => set(!on)} aria-label={title} />
    </div>
  );
}

/** Studio-wide defaults, stored with the library so the dashboard and every MCP client share them. */
export default function Settings() {
  const { toast } = useDialog();
  const [s, setS] = useState<S | null>(null);
  const [mine, setMine] = useState<MyVoice[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [lex, setLex] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<S>("settings").then((x) => { setS(x); setLex(Object.entries(x.pronounce).map(([k, v]) => `${k} = ${v}`).join("\n")); }).catch((e) => setErr(e.message));
    api<{ voices: MyVoice[] }>("myvoices").then((r) => setMine(r.voices)).catch(() => {});
    api<{ models: { name: string }[] }>("models").then((r) => setModels(r.models.map((m) => m.name))).catch(() => {});
    fetch("/api/ws/me").then((r) => r.json()).then((m) => setSignedIn(!!m?.user)).catch(() => {});
  }, []);
  if (!s) return <>{err ? <p className="err">{err}</p> : <p className="dim">Loading…</p>}</>;
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
      setS(next);
      toast("Defaults saved: the dashboard and your MCP clients use them now", "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setSaving(false);
    }
  }

  const voices: [string, string][] = s.engine === "myvoice" ? (models.length ? models.map((n) => [n, `${n} (trained)`] as [string, string]) : [["me", "trained model"]]) : s.engine === "orpheus" ? ["tara", "leah", "jess", "mia", "zoe", "leo", "dan", "zac"].map((v) => [v, v])
    : s.engine === "kokoro" ? ["af_heart", "af_bella", "am_fenrir", "am_michael", "am_puck"].map((v) => [v, v])
    : [...mine.map((m) => [m.name, `${m.label} (your voice)`] as [string, string]), ["female", "female preset"], ["male", "male preset"]];

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Your <em>defaults.</em></h1>
          <p className="sub">Set once, used everywhere: the Generate and Studio pages and every MCP client. A request can still override any of them.</p>
        </div>
        <button className="sig" onClick={save} disabled={saving}><FloppyDisk size={16} weight="bold" />{saving ? "Saving…" : "Save defaults"}</button>
      </div>

      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>Voice</h2></div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="field" style={{ margin: 0 }}><label className="f">Engine</label>
                <select value={s.engine} onChange={(e) => setS({ ...s, engine: e.target.value, voice: e.target.value === "myvoice" ? models[0] ?? "me" : e.target.value === "orpheus" ? "tara" : e.target.value === "kokoro" ? "af_heart" : mine[0]?.name ?? "female" })}>
                  {opt([["qwen", "Qwen · your voice"], ["myvoice", "Your trained model"], ["orpheus", "Orpheus · most human"], ["chatterbox", "Chatterbox · emotion"], ["kokoro", "Kokoro · instant"]])}
                </select></div>
              <div className="field" style={{ margin: 0 }}><label className="f">Voice</label>
                <select value={s.voice} onChange={(e) => set("voice", e.target.value)}>{opt(voices)}</select></div>
              <div className="field" style={{ margin: 0 }}><label className="f">Delivery</label>
                <select value={s.style} onChange={(e) => set("style", e.target.value)}>{opt([["tech", "Tech explainer"], ["hype", "Launch / hype"], ["narrator", "Calm narrator"], ["neutral", "Neutral"]])}</select></div>
              <div className="field" style={{ margin: 0 }}><label className="f">Best of</label>
                <div className="seg">{[1, 2, 3, 4].map((n) => <button key={n} className={s.takes === n ? "on" : ""} onClick={() => set("takes", n)}>{n}×</button>)}</div></div>
            </div>
            {signedIn && <Toggle on={!!s.personal} set={(v) => set("personal", v)} title="This engine and voice just for me"
              about="On: only your voiceovers default to them; the other person keeps theirs. Off: they're the studio default for both of you and every MCP client." />}
            <Toggle on={s.subtitles} set={(v) => set("subtitles", v)} title="Subtitles" about="Word-timed SRT/VTT, script match and voice match scores." />
            <Toggle on={s.review} set={(v) => set("review", v)} title="Review every sentence"
              about="Whisper listens back; a sentence that skips, swaps or invents a word, or drifts off your voice, is re-voiced (up to 2 more tries). The scores teach each voice its best settings." />
            <Toggle on={s.lexicon} set={(v) => set("lexicon", v)} title="Tech pronunciation" about="SQL → sequel, GPU → G-P-U, 16GB → 16 gigabytes, markdown and links cleaned." />
            <label className="f" style={{ marginTop: 8 }}>Your pronunciation dictionary</label>
            <textarea value={lex} onChange={(e) => setLex(e.target.value)} spellCheck={false} style={{ minHeight: 120 }}
              placeholder={"One per line: word = how to say it\nKubernetes = koo-ber-net-eez\nYourBrand = your brand"} />
            <div className="dim tiny" style={{ marginTop: 4 }}>Applied to every voiceover and video; a request&apos;s own pronunciations win per word.</div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Claude / MCP access</h2><span className="dim tiny">no setup needed</span></div>
            <label className="f">MCP server URL</label>
            <div className="row" style={{ gap: 8 }}>
              <input readOnly value={typeof window === "undefined" ? "" : `${location.origin}/api/mcp`} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "var(--mono)", fontSize: 12.5 }} />
              <button className="ghost sm" onClick={() => { navigator.clipboard.writeText(`${location.origin}/api/mcp`).then(() => toast("Copied", "ok")).catch(() => {}); }}><Copy size={14} />Copy</button>
            </div>
            <div className="dim tiny" style={{ margin: "6px 0 14px" }}>In claude.ai: Settings → Connectors → Add custom connector, paste the URL, leave the OAuth fields empty. Each person connects their own Claude; there&apos;s no limit on connections.</div>
            <div className="dim tiny">Anyone signed in to this dashboard can connect: they press Allow and they're in. Up to 4 people can create a workspace account on the sign-in page.</div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Studio sound</h2><span className="dim tiny">bad mic, good audio</span></div>
            <Toggle on={s.enhance_recordings} set={(v) => set("enhance_recordings", v)} title="Enhance voice recordings"
              about="AI clean-up on the Voices page: noise and echo out, detail restored. A cleaner reference means a better clone." />
            <Toggle on={s.enhance_input} set={(v) => set("enhance_input", v)} title="Clean re-voice input"
              about="Remove background noise from a performance before re-voicing it." />
            <Toggle on={s.enhance_output} set={(v) => set("enhance_output", v)} title="Studio polish on generated speech"
              about="Run every generated line through the enhancer too (44.1 kHz air on 24 kHz engines). Slower; subtle." />
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>Publishing</h2></div>
            <div className="field"><label className="f">Default platform</label>
              <select value={s.platform} onChange={(e) => set("platform", e.target.value)}>
                {opt([["youtube", "YouTube · -14 LUFS, subtitles"], ["shorts", "YouTube Shorts · -14 LUFS, pop-up captions"], ["reels", "Instagram Reels · -14 LUFS, pop-up captions"],
                  ["tiktok", "TikTok · -14 LUFS, pop-up captions"], ["podcast", "Podcast · -16 LUFS"], ["raw", "Raw · no mastering"]])}
              </select></div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Workspace</h2><span className="dim tiny">Appwrite + R2</span></div>
            <Toggle on={s.backup_media} set={(v) => set("backup_media", v)} title="Back up uploads to R2"
              about="Every file you add to the workspace is also copied to your R2 bucket (files up to ~180 MB), so nothing is lost if Appwrite is down or the plan ends." />
          </div>
          <div className="card flat">
            <div className="row" style={{ gap: 10 }}><CheckCircle size={18} weight="duotone" color="var(--ok)" />
              <span className="small">Stored with your library (R2), not in this browser, so both of you, and Claude through MCP, use the same defaults.</span></div>
          </div>
        </div>
      </div>
      <div style={{ height: 30 }} />
    </>
  );
}
