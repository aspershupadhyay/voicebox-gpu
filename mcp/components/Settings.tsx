"use client";
// Studio-wide defaults, stored with the library so the dashboard and every MCP client share them. Changes collect
// until you press Save (a bar appears while anything is unsaved, and leaving asks first); Security acts at once.
import { CheckCircle, Copy } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type MyVoice } from "./api";
import { useDialog } from "./Dialog";
import SecurityCard from "./SecurityCard";
import { Field, PageHeader, Toggle } from "./ui";

type S = {
  engine: string; voice: string; style: string; platform: string; takes: number; subtitles: boolean; lexicon: boolean;
  pronounce: Record<string, string>; enhance_recordings: boolean; enhance_input: boolean; enhance_output: boolean;
  backup_media: boolean; review: boolean; personal?: boolean; mcp_github: string[]; workspace_emails: string[];
};

const opt = (pairs: readonly (readonly [string, string])[]) => pairs.map(([v, l]) => <option key={v} value={v}>{l}</option>);
const lexText = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `${k} = ${v}`).join("\n");

export default function Settings() {
  const { toast } = useDialog();
  const [saved, setSaved] = useState<S | null>(null);
  const [s, setS] = useState<S | null>(null);
  const [mine, setMine] = useState<MyVoice[]>([]);
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

  if (!s) return <>{<PageHeader title="Settings" />}{err ? <p className="err" role="alert">{err}</p> : <div className="skel" style={{ height: 320 }} />}</>;
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

  return (
    <>
      <PageHeader title="Settings" sub="Defaults for the studio, for both of you and for Claude." />

      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><div><h2>Voice</h2><p className="sub">What a new voiceover starts with. Any single request can override it.</p></div></div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0 12px" }}>
              <Field label="Engine">
                <select value={s.engine} onChange={(e) => setS({ ...s, engine: e.target.value, voice: e.target.value === "myvoice" ? models[0] ?? "me" : e.target.value === "orpheus" ? "tara" : e.target.value === "kokoro" ? "af_heart" : mine[0]?.name ?? "female" })}>
                  {opt([["qwen", "Qwen · your voice"], ["myvoice", "Your voice model"], ["orpheus", "Orpheus · most human"], ["chatterbox", "Chatterbox · emotion"], ["kokoro", "Kokoro · instant"]])}
                </select>
              </Field>
              <Field label="Voice"><select value={s.voice} onChange={(e) => set("voice", e.target.value)}>{opt(voices)}</select></Field>
              <Field label="Delivery"><select value={s.style} onChange={(e) => set("style", e.target.value)}>{opt([["tech", "Tech explainer"], ["hype", "Launch / hype"], ["narrator", "Calm narrator"], ["neutral", "Neutral"]])}</select></Field>
              <div className="field"><span className="f" style={{ display: "block", font: "500 13px var(--sans)", color: "var(--ink2)", marginBottom: 6 }} id="set-takes">Best of</span>
                <div className="seg" role="radiogroup" aria-labelledby="set-takes">{[1, 2, 3, 4].map((n) => <button key={n} role="radio" aria-checked={s.takes === n} className={s.takes === n ? "on" : ""} onClick={() => set("takes", n)}>{n}×</button>)}</div></div>
            </div>
            {signedIn && <Toggle on={!!s.personal} set={(v) => set("personal", v)} title="This engine and voice just for me"
              about="On: only your voiceovers use them; the other person keeps theirs. Off: they're the studio default for both of you and Claude." />}
            <Toggle on={s.subtitles} set={(v) => set("subtitles", v)} title="Subtitles" about="Word-timed SRT/VTT, with script and voice match scores." />
            <Toggle on={s.review} set={(v) => set("review", v)} title="Review every sentence"
              about="Whisper listens back; a sentence that skips, swaps or adds a word, or drifts off your voice, is voiced again (up to 2 more tries)." />
            <Toggle on={s.lexicon} set={(v) => set("lexicon", v)} title="Tech pronunciation" about="SQL → sequel, GPU → G-P-U, 16GB → 16 gigabytes; markdown and links cleaned." />
            <Field label="Your pronunciation dictionary" hint="One per line: word = how to say it. A request's own pronunciations win per word." style={{ marginTop: 12, marginBottom: 0 }}>
              <textarea value={lex} onChange={(e) => setLex(e.target.value)} spellCheck={false} style={{ minHeight: 110 }} placeholder={"Kubernetes = koo-ber-net-eez\nYourBrand = your brand"} />
            </Field>
          </div>

          <div className="card">
            <div className="card-head"><div><h2>Studio sound</h2><p className="sub">AI clean-up applied around your voice.</p></div></div>
            <Toggle on={s.enhance_recordings} set={(v) => set("enhance_recordings", v)} title="Enhance voice recordings"
              about="Noise and echo out, detail restored, before a recording becomes a voice. A cleaner reference means a better clone." />
            <Toggle on={s.enhance_input} set={(v) => set("enhance_input", v)} title="Clean re-voice input" about="Remove background noise from a performance before re-voicing it." />
            <Toggle on={s.enhance_output} set={(v) => set("enhance_output", v)} title="Studio polish on generated speech" about="Run every generated line through the enhancer too. Slower; subtle." />
          </div>

          <div className="card">
            <div className="card-head"><div><h2>Claude / MCP access</h2><p className="sub">Let Claude use the studio: voice scripts, plan posts, start the GPU.</p></div></div>
            <Field label="MCP server URL" hint="In claude.ai: Settings → Connectors → Add custom connector, paste the URL, leave the OAuth fields empty. Connecting asks the person to sign in here first, so only people under Security can connect a Claude.">
              <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                <input readOnly aria-label="MCP server URL" value={typeof window === "undefined" ? "" : `${location.origin}/api/mcp`} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "var(--mono)", fontSize: 13 }} />
                <button className="ghost" onClick={() => { navigator.clipboard.writeText(`${location.origin}/api/mcp`).then(() => toast("Copied", "ok")).catch(() => toast("Couldn't copy: select the address and copy it", "bad")); }}><Copy size={14} />Copy</button>
              </div>
            </Field>
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <SecurityCard />
          <div className="card">
            <div className="card-head"><h2>Publishing</h2></div>
            <Field label="Default platform" style={{ marginBottom: 0 }}>
              <select value={s.platform} onChange={(e) => set("platform", e.target.value)}>
                {opt([["youtube", "YouTube · -14 LUFS, subtitles"], ["shorts", "YouTube Shorts · -14 LUFS, pop-up captions"], ["reels", "Instagram Reels · -14 LUFS, pop-up captions"],
                  ["tiktok", "TikTok · -14 LUFS, pop-up captions"], ["podcast", "Podcast · -16 LUFS"], ["raw", "Raw · no mastering"]])}
              </select>
            </Field>
          </div>
          <div className="card">
            <div className="card-head"><h2>Workspace</h2></div>
            <Toggle on={s.backup_media} set={(v) => set("backup_media", v)} title="Back up uploads to R2"
              about="Every file added to the workspace is also copied to your R2 bucket (up to ~180 MB), so nothing is lost if Appwrite is down." />
          </div>
          <div className="notice ok" style={{ margin: 0 }}><span className="n-ic"><CheckCircle size={18} weight="fill" /></span>
            <span className="n-text">Stored with your library, not in this browser, so both of you and Claude use the same defaults.</span></div>
        </div>
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
