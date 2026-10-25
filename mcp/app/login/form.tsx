"use client";
import { ArrowRight, GithubLogo } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Logo } from "@/components/art";
import { signIn } from "@/components/aw";

type Mode = "signin" | "signup" | "token";

// The left panel: a script reading itself, words lighting up like a voiceover being recorded, over a waveform and a
// running timecode; three scripts take turns. With reduced motion it's one still script.
const SCRIPTS = [
  "Write the line. Hear it in your own voice. Fix one word, not the whole take.",
  "Every take gets listened to, scored, and the best one kept. You just press play.",
  "Plan the week together, voice the script, and post it. One studio for both of you.",
];
const BARS = 64;

function Reading() {
  const [s, setS] = useState(0);
  const [w, setW] = useState(0);
  const [still, setStill] = useState(false);
  const words = useMemo(() => SCRIPTS[s].split(" "), [s]);
  useEffect(() => { setStill(matchMedia("(prefers-reduced-motion: reduce)").matches); }, []);
  useEffect(() => {
    if (still) return;
    const t = setTimeout(() => {
      if (w < words.length) setW(w + 1);
      else { setS((s + 1) % SCRIPTS.length); setW(0); }
    }, w < words.length ? 230 + words[Math.max(0, w - 1)].length * 22 : 2200);
    return () => clearTimeout(t);
  }, [w, words, s, still]);
  const secs = still ? 6 : Math.round((w / words.length) * (words.length * 0.38));
  const lit = still ? 1 : w / words.length;
  return (
    <div className="l-reading">
      <p className="sr-only">{SCRIPTS[0]}</p>
      <p className={`l-script ${still ? "static" : ""}`} aria-hidden>
        {words.map((x, i) => <span key={`${s}-${i}`} className={still || i < w - 1 ? "done" : i === w - 1 ? "now" : ""}>{x} </span>)}
      </p>
      <div className="l-wave" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => {
          const h = 18 + Math.round(Math.abs(Math.sin(i * 0.9 + s) * Math.cos(i * 0.31)) * 70);
          return <i key={i} className={i / BARS < lit && !still ? "lit" : ""} style={{ height: `${h}%`, animationDelay: `${(i % 9) * 0.07}s`, ...(still ? { background: "var(--ink)" } : {}) }} />;
        })}
      </div>
      <div className="l-time" aria-hidden><span className="rec" />REC  00:{String(secs).padStart(2, "0")}  ·  take {s + 1}</div>
    </div>
  );
}

const TITLES: Record<Mode, [string, string]> = {
  signin: ["Sign in", "Welcome back to your studio."],
  signup: ["Take your seat", "Only emails the owner has added in Settings can join."],
  token: ["Use an access token", "For scripts and the single-user setup. It opens the studio, not the shared workspace."],
};

export default function LoginForm({ github, next = "/" }: { github?: string; next?: string }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [bad, setBad] = useState<"email" | "password" | "token" | "both" | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const switched = useRef(false);
  useEffect(() => { if (switched.current) first.current?.focus(); switched.current = true; }, [mode]);
  const pick = (m: Mode) => { setMode(m); setErr(""); setBad(null); };

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBad(null);
    // check here, with the reason next to the field, rather than greying out the button
    if (mode === "token") { if (!token.trim()) { setBad("token"); return setErr("Paste the access token."); } }
    else {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setBad("email"); return setErr("Enter your email address."); }
      if (password.length < 8) { setBad("password"); return setErr(mode === "signup" ? "Use at least 8 characters for the password." : "Enter your password (at least 8 characters)."); }
    }
    setBusy(true);
    try {
      if (mode === "token") {
        const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.trim() }) });
        if (!r.ok) { setBad("token"); throw new Error(r.status === 429 ? (await r.json()).error : "That token didn't match."); }
      } else {
        await signIn(email.trim(), password, mode === "signup" ? name.trim() : undefined);
      }
      location.href = next;
    } catch (x) {
      const m = (x as Error).message;
      if (mode !== "token") setBad("both");
      setErr(/user_count_exceeded|limit/i.test(m) ? "This studio is full. Sign in instead." : /Invalid credentials|invalid/i.test(m) ? "Email or password didn't match." : m);
      setBusy(false);
    }
  }

  const [title, sub] = TITLES[mode];
  return (
    <div className="login">
      <div className="l-art">
        <div className="l-brand"><Logo size={30} />Voicebox <span>Studio</span></div>
        <Reading />
        <div className="l-foot">Private studio · invite only</div>
      </div>
      <main className="l-form">
        <div className="l-card">
          <div className="l-mobile-brand"><Logo size={28} />Voicebox <span>Studio</span></div>
          <h1>{title}</h1>
          <p className="l-sub">{sub}</p>
          {github && mode === "signin" && (
            <>
              <a className="btn ghost lg block" href={github}><GithubLogo size={18} weight="fill" /> Continue with GitHub</a>
              <div className="l-or" aria-hidden><span>or</span></div>
            </>
          )}
          <form onSubmit={go} noValidate className="stack" style={{ gap: 14 }}>
            {mode === "token" ? (
              <div><label className="f" htmlFor="tok">Access token</label>
                <input id="tok" ref={first} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password"
                  aria-invalid={bad === "token"} aria-describedby={err ? "l-err" : undefined} /></div>
            ) : (
              <>
                {mode === "signup" && <div><label className="f" htmlFor="nm">Name</label>
                  <input id="nm" ref={first} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>}
                <div><label className="f" htmlFor="em">Email</label>
                  <input id="em" ref={mode === "signin" ? first : undefined} type="email" autoFocus={mode === "signin"} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
                    aria-invalid={bad === "email" || bad === "both"} aria-describedby={err ? "l-err" : undefined} /></div>
                <div><label className="f" htmlFor="pw">Password</label>
                  <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    aria-invalid={bad === "password" || bad === "both"} aria-describedby={`${mode === "signup" ? "pw-hint " : ""}${err ? "l-err" : ""}`.trim() || undefined} />
                  {mode === "signup" && <div className="tiny faint" id="pw-hint" style={{ marginTop: 5 }}>At least 8 characters.</div>}</div>
              </>
            )}
            <p className="err" id="l-err" role="alert" style={{ margin: 0, minHeight: err ? undefined : 0 }}>{err}</p>
            <button className="lg block" disabled={busy}>
              {busy ? "One moment…" : <>{mode === "signup" ? "Create account" : "Continue"} <ArrowRight size={16} weight="bold" /></>}
            </button>
          </form>
          <div className="l-alt">
            {mode === "signin" && <span>Invited? <button className="linkish u" onClick={() => pick("signup")}>Create your seat</button></span>}
            {mode !== "signin" && <span>Already have a seat? <button className="linkish u" onClick={() => pick("signin")}>Sign in</button></span>}
            {mode !== "token" && <span><button className="linkish u" onClick={() => pick("token")}>Use an access token</button></span>}
          </div>
        </div>
      </main>
    </div>
  );
}
