"use client";
import { useState } from "react";

export default function Login() {
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    setBusy(false);
    if (r.ok) location.href = "/"; else setErr("That token didn't match.");
  }
  return (
    <div className="shell" style={{ maxWidth: 420, paddingTop: "18vh" }}>
      <div className="brand" style={{ fontSize: 26, marginBottom: 8 }}>voice<b style={{ color: "var(--signal)" }}>box</b></div>
      <p className="sub">Paste your <span className="mono">MCP_TOKEN</span> (from <span className="mono">.secrets.local</span>). You stay signed in for 30 days.</p>
      <form onSubmit={go} className="card">
        <div className="field">
          <label className="f">Access token</label>
          <input type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" />
        </div>
        {err && <p className="err">{err}</p>}
        <button className="sig" disabled={!token || busy}>{busy ? "Checking…" : "Sign in"}</button>
      </form>
    </div>
  );
}
