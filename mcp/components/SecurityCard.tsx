"use client";
// Settings → Security: who can get into the studio (and remove them), how this browser is signed in, "sign out
// everywhere", and the last sign-ins, failed ones included. Server side: lib/access.ts, lib/session.ts.
import { CheckCircle, GithubLogo, Key, ShieldCheck, SignOut, UserPlus, WarningCircle, X } from "@phosphor-icons/react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useDialog } from "./Dialog";
import { Info } from "./Info";

type Person = { email: string; name: string | null; on_vercel: boolean; invited: boolean; member: boolean; no_password?: boolean };
type Sec = { session: { how: string; who: string; since: number; until: number } | null; me: string | null; people: Person[]; github: string[]; session_days: number;
  log: { at: number; ok: boolean; who: string; how: string; ip: string; agent: string }[] };

const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const device = (ua: string) => `${/iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device"}${/Edg\//.test(ua) ? " · Edge" : /Chrome\//.test(ua) ? " · Chrome" : /Safari\//.test(ua) ? " · Safari" : /Firefox\//.test(ua) ? " · Firefox" : ""}`;

/** The whole card, or one part of it for Settings' bento: who can sign in, this device, or the sign-in log. */
export default function SecurityCard({ part }: { part?: "people" | "device" | "log" }) {
  const show = (p: "people" | "device" | "log") => !part || part === p;
  const { toast, confirm } = useDialog();
  const [d, setD] = useState<Sec | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState<{ email: string; next: string; current: string } | null>(null); // the set-password form, open on one person
  const load = useCallback(() => { api<Sec>("security").then(setD).catch(() => {}); }, []);
  useEffect(load, [load]);

  async function act(path: string, body: object, ok: string) {
    setBusy(true);
    let done = false;
    try { await api(`security/${path}`, { body }); toast(ok, "ok"); load(); done = true; } catch (e) { toast((e as Error).message, "bad"); }
    setBusy(false);
    return done;
  }

  return (
    <div className="card">
      {part === "device" && <div className="card-head"><div><h2>This device</h2><p className="sub">How you&apos;re signed in here</p></div></div>}
      {part === "log" && <div className="card-head"><div><h2>Recent sign-ins</h2><p className="sub">Every attempt, refused ones included</p></div></div>}
      {show("people") && <>
      <div className="card-head"><h2><ShieldCheck size={17} /> {part ? "Who can sign in" : "Security"}</h2>
        <span className="row" style={{ gap: 4 }}><span className="pill ok"><CheckCircle size={12} weight="fill" /> Invite-only</span>
          <Info label="Security">Only the people below can sign in. Removing someone locks them out within a minute, on every device.</Info></span></div>

      <div className="stack" style={{ gap: 0, marginTop: 8 }}>
        {(d?.people ?? []).map((p) => (
          <Fragment key={p.email}>
          <div className="sec-row">
            <span className="avatar sm">{(p.name ?? p.email).slice(0, 2).toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div className="small" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name ?? p.email}{p.email === d?.me ? <span className="faint"> · you</span> : null}</div>
              <div className="tiny dim">{p.email} · {p.member ? "member" : "invited, not signed in yet"}{p.no_password ? " · no password yet" : ""}{p.on_vercel ? " · set on the Worker" : ""}</div>
            </div>
            <span className="row" style={{ gap: 4 }}>
            {p.email === d?.me || p.no_password ? (
              <button className="icon-btn" title={p.email === d?.me ? "Change your password" : `Set a password for ${p.email}`} aria-label={p.email === d?.me ? "Change your password" : `Set a password for ${p.email}`}
                disabled={busy} onClick={() => setPw(pw?.email === p.email ? null : { email: p.email, next: "", current: "" })}><Key size={15} /></button>
            ) : null}
            {p.email !== d?.me && !p.on_vercel ? (
              <button className="icon-btn danger-h" title={`Remove ${p.email}`} disabled={busy} onClick={async () => {
                if (await confirm({ title: `Remove ${p.email}?`, body: "They're signed out everywhere within a minute and can't sign back in until you add them again.", confirm: "Remove", danger: true }))
                  act("remove", { email: p.email }, `${p.email} removed`);
              }}><X size={15} /></button>
            ) : null}
            </span>
          </div>
          {pw?.email === p.email && (
            <form className="stack" style={{ gap: 8, padding: "4px 0 12px 40px" }} onSubmit={(e) => {
              e.preventDefault();
              const mine = p.email === d?.me;
              act("password", mine && !p.no_password ? { email: p.email, password: pw.next, current: pw.current } : { email: p.email, password: pw.next },
                mine ? "Password saved" : `Password set for ${p.email}`).then((ok) => { if (ok) setPw(null); });
            }}>
              {p.email === d?.me && !p.no_password && <input type="password" autoComplete="current-password" aria-label="Current password" placeholder="Current password"
                value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}
              <input type="password" autoComplete="new-password" aria-label="New password" placeholder="New password (8+ characters)" minLength={8}
                value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              <div className="row" style={{ gap: 8 }}>
                <button className="primary sm" disabled={busy || pw.next.length < 8}>Save password</button>
                <button type="button" className="ghost sm" onClick={() => setPw(null)}>Cancel</button>
              </div>
            </form>
          )}
          </Fragment>
        ))}
        {d?.github.length ? <div className="sec-row"><GithubLogo size={20} /><div className="small">GitHub sign-in: <span className="mono">{d.github.join(", ")}</span></div><span /></div> : null}
      </div>
      <form className="row" style={{ gap: 8, marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); if (email.trim()) act("add", { email }, `${email.trim()} can now sign in`).then(() => setEmail("")); }}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="partner@email.com" aria-label="Email to invite" style={{ flex: 1, minWidth: 200 }} />
        <button className="ghost" disabled={busy || !email.trim()}><UserPlus size={15} /> Invite</button>
      </form>
      </>}
      {show("device") && <div className="row between" style={part ? { gap: 12 } : { marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)", gap: 12 }}>
        <div className="small">
          {!part && <b>This device</b>}
          <div className="tiny dim">{d?.session ? `${d.session.how === "user" ? "Account" : d.session.how === "github" ? "GitHub" : "Access token"} · signed in ${ago(d.session.since)} · until ${new Date(d.session.until).toLocaleDateString()}` : "—"}
            <Info label="Session length">Sessions last {d?.session_days ?? 14} days, then you sign in again.</Info></div>
        </div>
        <button className="ghost sm" disabled={busy} onClick={async () => {
          if (await confirm({ title: "Sign out everywhere?", body: "Every browser and device is signed out, this one included. Scripts using the access token keep working.", confirm: "Sign out everywhere", danger: true })) {
            await act("signout-all", {}, "Signed out everywhere");
            location.href = "/login";
          }
        }}><SignOut size={14} /> Sign out everywhere</button>
      </div>}
      {show("log") && <details style={{ marginTop: part ? 0 : 14 }} open={part === "log"}>
        <summary className="small">Recent sign-ins {d?.log.some((l) => !l.ok) ? <span className="pill bad" style={{ marginLeft: 6 }}>{d.log.filter((l) => !l.ok).length} refused</span> : null}</summary>
        <div style={{ marginTop: 8 }}>
          {!d?.log.length ? <p className="tiny dim">None recorded yet.</p> : d.log.slice(0, 20).map((l, k) => (
            <div key={k} className="sec-log">
              {l.ok ? <CheckCircle size={15} weight="fill" color="var(--ok)" /> : <WarningCircle size={15} weight="fill" color="var(--danger)" />}
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><b style={{ fontWeight: 550 }}>{l.who}</b> <span className="dim">{l.how}</span></span>
              <span className="dim agent">{device(l.agent)} · {l.ip}</span>
              <span className="faint tiny">{ago(l.at)}</span>
            </div>
          ))}
        </div>
      </details>}
    </div>
  );
}
