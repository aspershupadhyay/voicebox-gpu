"use client";
import { ArrowRight, GithubLogo, LockKey } from "@phosphor-icons/react";
import { useState } from "react";
import { Logo, Orb } from "@/components/art";

export default function LoginForm({ github }: { github?: string }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.trim() }) });
    setBusy(false);
    if (r.ok) location.href = "/"; else setErr("That token didn't match.");
  }
  return (
    <div className="login">
      <div className="l-art">
        <Orb />
        <p className="quote">Voices that sound <em>human</em>,<br />subtitles that land on the word.</p>
      </div>
      <div className="l-form">
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div className="row" style={{ gap: 12, marginBottom: 34 }}><Logo size={36} /><span style={{ font: "400 32px var(--display)" }}>voice<em style={{ color: "var(--signal)" }}>box</em></span></div>
          <div className="eyebrow">Private studio</div>
          <h1 style={{ fontSize: 40 }}>Welcome back.</h1>
          <p className="sub" style={{ marginBottom: 28 }}>Expressive voiceovers and word-perfect subtitles, running on your own GPU.</p>
          {github && (
            <>
              <a className="btn sig lg" href={github} style={{ width: "100%", justifyContent: "center" }}><GithubLogo size={18} weight="fill" /> Continue with GitHub</a>
              <p className="faint tiny" style={{ margin: "18px 0" }}>or use your access token</p>
            </>
          )}
          <form onSubmit={go}>
            <label className="f" htmlFor="tok">Access token</label>
            <div style={{ position: "relative" }}>
              <LockKey size={17} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--faint)" }} />
              <input id="tok" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" placeholder="MCP_TOKEN from .secrets.local" style={{ paddingLeft: 38, height: 46 }} />
            </div>
            {err && <p className="err">{err}</p>}
            <button className={github ? "lg" : "sig lg"} style={{ width: "100%", marginTop: 16 }} disabled={!token || busy}>{busy ? "Checking…" : <>Enter the studio <ArrowRight size={16} weight="bold" /></>}</button>
            <p className="faint tiny" style={{ margin: "14px 0 0" }}>You stay signed in for 30 days on this browser.</p>
          </form>
        </div>
      </div>
    </div>
  );
}
