"use client";
import { useState } from "react";

export default function Login() {
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
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", position: "relative", zIndex: 1, padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div className="brand" style={{ fontSize: 28, padding: 0, marginBottom: 10 }}><span className="wave"><i /><i /><i /><i /></span>voice<b>box</b></div>
        <p className="sub" style={{ marginBottom: 22 }}>Expressive voiceovers and word-perfect subtitles on your own GPU.</p>
        <form onSubmit={go} className="card">
          <div className="field">
            <label className="f">Access token</label>
            <input type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" placeholder="MCP_TOKEN from .secrets.local" />
          </div>
          {err && <p className="err">{err}</p>}
          <button className="sig" style={{ width: "100%" }} disabled={!token || busy}>{busy ? "Checking…" : "Sign in"}</button>
          <p className="dim tiny" style={{ margin: "12px 0 0" }}>You stay signed in for 30 days on this browser.</p>
        </form>
      </div>
    </div>
  );
}
