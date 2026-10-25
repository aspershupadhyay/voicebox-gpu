"use client";
import { ArrowRight, GithubLogo, Key } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/art";
import { Info } from "@/components/Info";
import { signIn } from "@/components/aw";

type Mode = "signin" | "signup" | "token";

// The left panel: a script reading itself. Words light up under the playhead like a voiceover being recorded,
// over a live waveform and a running timecode; three scripts take turns.
const SCRIPTS = [
  "Here's the strange thing about maps. They only help if you know exactly where you're standing.",
  "Write the line. Hear it in your own voice. Fix one word, not the whole take.",
  "Every take gets listened to, scored, and the best one kept. You just press play.",
];
const BARS = 64;

function Reading() {
  const [s, setS] = useState(0);
  const [w, setW] = useState(0);
  const words = useMemo(() => SCRIPTS[s].split(" "), [s]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (w < words.length) setW(w + 1);
      else { setS((s + 1) % SCRIPTS.length); setW(0); }
    }, w < words.length ? 230 + words[Math.max(0, w - 1)].length * 22 : 2200);
    return () => clearTimeout(t);
  }, [w, words, s]);
  const secs = Math.round((w / words.length) * (words.length * 0.38));
  return (
    <div className="l-reading">
      <p className="l-script" aria-label={SCRIPTS[s]}>
        {words.map((x, i) => <span key={`${s}-${i}`} className={i < w - 1 ? "done" : i === w - 1 ? "now" : ""}>{x} </span>)}
      </p>
      <div className="l-wave" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => {
          const lit = i / BARS < w / words.length;
          const h = 18 + Math.round(Math.abs(Math.sin(i * 0.9 + s) * Math.cos(i * 0.31)) * 70);
          return <i key={i} className={lit ? "lit" : ""} style={{ height: `${h}%`, animationDelay: `${(i % 9) * 0.07}s` }} />;
        })}
      </div>
      <div className="l-time mono"><span className="rec" />REC  00:{String(secs).padStart(2, "0")}<span className="dimmed">  /  take {s + 1}</span></div>
    </div>
  );
}

export default function LoginForm({ github }: { github?: string }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      if (mode === "token") {
        const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.trim() }) });
        if (!r.ok) throw new Error(r.status === 429 ? (await r.json()).error : "That token didn't match.");
        location.href = "/";
      } else {
        await signIn(email.trim(), password, mode === "signup" ? name.trim() : undefined);
        location.href = "/generate";
      }
    } catch (x) {
      const m = (x as Error).message;
      setErr(/user_count_exceeded|limit/i.test(m) ? "This studio is full. Sign in instead." : /Invalid credentials|invalid/i.test(m) ? "Email or password didn't match." : m);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="l-art">
        <div className="l-brand"><Logo size={30} /><span>Voicebox <em>Studio</em></span></div>
        <Reading />
        <div className="l-foot">Private studio · invite only</div>
      </div>
      <div className="l-form">
        <div className="l-card">
          <div className="l-mobile-brand"><Logo size={28} /><span>Voicebox <em>Studio</em></span></div>
          <h1>{mode === "signup" ? <>Take your <em>seat</em></> : mode === "token" ? <>Access <em>token</em></> : <>Welcome <em>back</em></>}</h1>
          {github && mode !== "signup" && (
            <>
              <a className="btn ghost lg" href={github} style={{ width: "100%", marginTop: 28 }}><GithubLogo size={18} weight="fill" /> Continue with GitHub</a>
              <div className="l-or"><span>or</span></div>
            </>
          )}
          <form onSubmit={go} className="stack" style={{ gap: 14, marginTop: github && mode !== "signup" ? 0 : 28 }}>
            {mode === "token" ? (
              <div><label className="f" htmlFor="tok">Token <Info>The studio&apos;s MCP_TOKEN. It opens the studio, not the shared workspace.</Info></label>
                <input id="tok" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" /></div>
            ) : (
              <>
                {mode === "signup" && <div><label className="f" htmlFor="nm">Name</label>
                  <input id="nm" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>}
                <div><label className="f" htmlFor="em">Email {mode === "signup" && <Info>Only emails the owner added in Settings → Security can get in.</Info>}</label>
                  <input id="em" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
                <div><label className="f" htmlFor="pw">Password</label>
                  <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} /></div>
              </>
            )}
            {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
            <button className="sig lg" style={{ width: "100%", marginTop: 4 }} disabled={busy || (mode === "token" ? !token : !email || password.length < 8)}>
              {busy ? "One moment…" : <>{mode === "signup" ? "Create account" : "Continue"} <ArrowRight size={16} weight="bold" /></>}
            </button>
          </form>
          <div className="row between" style={{ marginTop: 16 }}>
            {mode === "signin" && <button className="quiet sm" onClick={() => { setMode("signup"); setErr(""); }}>Invited? Create your seat</button>}
            {mode !== "signin" && <button className="quiet sm" onClick={() => { setMode("signin"); setErr(""); }}>Back to sign in</button>}
            {mode !== "token" && <button className="quiet sm" onClick={() => { setMode("token"); setErr(""); }}><Key size={14} /> Token</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
