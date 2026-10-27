"use client";
// Settings → Ask Voicebox: which brain the assistant uses, and Antigravity's Google sign-in on the Colab worker (a link
// to open, then the code Google shows pasted back within a minute). Acts at once, like Security.
import { ArrowSquareOut, CheckCircle, CircleNotch, GoogleLogo, Sparkle, Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { askApi, useAsk } from "./Ask";
import { useDialog } from "./Dialog";
import { Field } from "./ui";
import { Select } from "./pop";

type Brains = { brain: "auto" | "gemini" | "antigravity"; gemini: boolean; antigravity: { signed_in: boolean; email: string | null; worker: boolean } };
type Agy = { online: boolean; installed?: boolean; signed_in?: boolean; saved?: boolean; email?: string | null; login?: { url: string; expires: number } | null; error?: string };

export default function AskCard() {
  const { toast } = useDialog();
  const ask = useAsk();
  const [b, setB] = useState<Brains | null>(null);
  const [agy, setAgy] = useState<Agy | null>(null);
  const [login, setLogin] = useState<{ url: string; expires: number } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"" | "login" | "code" | "out">("");
  const [left, setLeft] = useState(0);

  const load = useCallback(() => {
    askApi<Brains>("").then(setB).catch(() => null);
    askApi<Agy>("/agy").then(setAgy).catch(() => null);
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!login) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.round(login.expires - Date.now() / 1000))), 500);
    return () => clearInterval(t);
  }, [login]);

  const setBrain = async (brain: Brains["brain"]) => {
    try { setB(await askApi<Brains>("/prefs", { body: { brain } })); toast("Saved", "ok"); } catch (e) { toast((e as Error).message, "bad"); }
  };

  const start = async () => {
    // the tab opens now (a click can open it; a link after an await may be blocked) and gets its address when it's ready
    const tab = window.open("about:blank", "_blank");
    setBusy("login");
    try {
      const r = await askApi<{ url: string | null; expires: number; signed_in?: boolean }>("/agy/login", { body: {} });
      if (r.signed_in || !r.url) { tab?.close(); toast("Antigravity is signed in", "ok"); load(); return; }
      setLogin({ url: r.url, expires: r.expires });
      setLeft(Math.round(r.expires - Date.now() / 1000));
      if (tab) tab.location.href = r.url;
    } catch (e) {
      tab?.close();
      toast((e as Error).message, "bad");
    } finally {
      setBusy("");
    }
  };

  const send = async () => {
    setBusy("code");
    try {
      const r = await askApi<{ ok: boolean; email: string | null; error?: string }>("/agy/code", { body: { code } });
      if (!r.ok) throw new Error(r.error || "that didn't work");
      setLogin(null); setCode("");
      toast(`Antigravity is signed in${r.email ? ` as ${r.email}` : ""}`, "ok");
      load();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy("");
    }
  };

  const out = async () => {
    setBusy("out");
    await askApi("/agy/logout", { body: {} }).catch(() => null);
    setBusy(""); toast("Signed out of Antigravity", "ok"); load();
  };

  const signed = !!(agy?.saved || agy?.signed_in);
  return (
    <div className="card" id="ask">
      <div className="card-head">
        <div><h2>Ask Voicebox</h2><p className="sub">The assistant in the top bar (⌘J). It does the work with the same tools Claude uses; deleting and GPU spending wait for your OK.</p></div>
        <button className="ghost sm" onClick={() => ask.open()}><Sparkle size={14} weight="fill" />Open</button>
      </div>
      <Field label="Brain" hint="Auto uses Antigravity while the Colab worker is on (your Google plan, no API cost) and Gemini when it's off.">
        <Select value={b?.brain ?? "auto"} onChange={setBrain} disabled={!b}
          options={[["auto", "Auto"], ["antigravity", "Antigravity · your Google AI plan, on the worker"], ["gemini", "Gemini API · free key, always on"]]} />
      </Field>

      <div className="ask-set">
        <div className="as-row">
          <span className={`as-dot ${b?.gemini ? "ok" : ""}`} aria-hidden />
          <div className="as-text">
            <b>Gemini API</b>
            <span>{b?.gemini ? "Ready (GEMINI_API_KEY is set)." : <>Add a free key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">AI Studio</a> as GEMINI_API_KEY in the Vercel project, then redeploy.</>}</span>
          </div>
        </div>
        <div className="as-row">
          <span className={`as-dot ${signed && agy?.online ? "ok" : signed ? "warn" : ""}`} aria-hidden />
          <div className="as-text">
            <b>Antigravity on the Colab worker</b>
            <span>
              {!agy ? "Checking…"
                : signed ? <>Signed in{agy.email ? ` as ${agy.email}` : ""}. {agy.online ? "The worker is on, so it's ready." : "Works whenever the worker is on."}</>
                : agy.online ? "Sign in with your Google account (the one with your Google AI plan). Uses no GPU."
                : "Start the Colab worker (GPU & engines) to sign in. It uses no GPU itself."}
            </span>
          </div>
          {signed
            ? <button className="ghost sm" onClick={out} disabled={busy !== ""}>{busy === "out" ? <CircleNotch size={14} className="spin" /> : null}Sign out</button>
            : <button className="sm" onClick={start} disabled={!agy?.online || busy !== ""}>{busy === "login" ? <CircleNotch size={14} className="spin" /> : <GoogleLogo size={14} weight="bold" />}Sign in with Google</button>}
        </div>
        {login && (
          <div className="as-login">
            <p className="small">A Google tab opened: sign in, copy the code it shows, and paste it here <b>within {left}s</b>.
              {" "}<a href={login.url} target="_blank" rel="noreferrer">Open the sign-in again <ArrowSquareOut size={12} /></a></p>
            {left > 0 ? (
              <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                <input aria-label="Code from Google" value={code} onChange={(e) => setCode(e.target.value)} placeholder="4/0A…" autoFocus spellCheck={false}
                  onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) send(); }} style={{ fontFamily: "var(--mono)", fontSize: 13 }} />
                <button className="sm" onClick={send} disabled={!code.trim() || busy !== ""}>{busy === "code" ? <CircleNotch size={14} className="spin" /> : <CheckCircle size={14} weight="bold" />}Done</button>
              </div>
            ) : (
              <p className="small warn-text"><Warning size={13} weight="fill" /> That sign-in expired. <button className="quiet xs" onClick={start}>Get a new one</button></p>
            )}
          </div>
        )}
        {agy?.error && <p className="tiny faint">{agy.error}</p>}
      </div>
    </div>
  );
}
