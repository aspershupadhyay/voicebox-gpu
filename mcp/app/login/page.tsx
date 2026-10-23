"use client";
import { ArrowRight, Key } from "@phosphor-icons/react";
import { useState } from "react";
import { Logo, Orb } from "@/components/art";
import { signIn } from "@/components/aw";

type Mode = "signin" | "signup" | "token";

export default function Login() {
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
        if (!r.ok) throw new Error("That token didn't match.");
        location.href = "/";
      } else {
        await signIn(email.trim(), password, mode === "signup" ? name.trim() : undefined);
        location.href = "/workspace";
      }
    } catch (x) {
      const m = (x as Error).message;
      setErr(/user_count_exceeded|limit/i.test(m) ? "This studio already has its two people. Sign in instead." : /Invalid credentials|invalid/i.test(m) ? "Email or password didn't match." : m);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="l-art">
        <Orb />
        <p className="quote">Your voice, studio-grade.<br /><em>One desk for the two of you.</em></p>
      </div>
      <div className="l-form">
        <div style={{ width: "100%", maxWidth: 360 }}>
          <div className="row" style={{ gap: 10, marginBottom: 40 }}><Logo size={30} /><span style={{ font: "600 20px var(--display)", letterSpacing: "-.04em" }}>voicebox</span></div>
          <h1 style={{ fontSize: 32 }}>{mode === "signup" ? "Create your seat." : "Welcome back."}</h1>
          <p className="sub" style={{ marginBottom: 28 }}>
            {mode === "token" ? "Sign in with the MCP access token. You'll get the studio, but not the shared workspace." : mode === "signup" ? "One account each. Everything you make is shared with your partner, live." : "Sign in to your shared studio."}
          </p>
          <form onSubmit={go} className="stack" style={{ gap: 12 }}>
            {mode === "token" ? (
              <div><label className="f" htmlFor="tok">Access token</label>
                <input id="tok" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" placeholder="MCP_TOKEN" /></div>
            ) : (
              <>
                {mode === "signup" && <div><label className="f" htmlFor="nm">Your name</label>
                  <input id="nm" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="How your partner sees you" /></div>}
                <div><label className="f" htmlFor="em">Email</label>
                  <input id="em" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
                <div><label className="f" htmlFor="pw">Password</label>
                  <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} /></div>
              </>
            )}
            {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
            <button className="lg" style={{ width: "100%", marginTop: 6 }} disabled={busy || (mode === "token" ? !token : !email || password.length < 8)}>
              {busy ? "One moment…" : <>{mode === "signup" ? "Create account" : "Continue"} <ArrowRight size={16} weight="bold" /></>}
            </button>
          </form>
          <div className="row between" style={{ marginTop: 20 }}>
            {mode === "signin" && <button className="quiet sm" onClick={() => { setMode("signup"); setErr(""); }}>New here? Create an account</button>}
            {mode !== "signin" && <button className="quiet sm" onClick={() => { setMode("signin"); setErr(""); }}>Back to sign in</button>}
            {mode !== "token" && <button className="quiet sm" onClick={() => { setMode("token"); setErr(""); }}><Key size={14} /> Use token</button>}
          </div>
          <p className="faint tiny" style={{ marginTop: 26 }}>You stay signed in for 30 days on this device.</p>
        </div>
      </div>
    </div>
  );
}
