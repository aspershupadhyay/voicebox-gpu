"use client";
// Settings → Usage: how much of each free tier is used (lib/usage.ts), so nothing runs out by surprise again. A meter
// turns amber at 70 % and red at 90 %; new uploads already stop at the R2 budget. Plus the last nightly backup.
import { CloudArrowUp, Database, HardDrives, Lightning, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Notice } from "./ui";

type Meter = { id: string; name: string; used: number | null; limit: number; unit: "bytes" | "hours"; note: string; level: "ok" | "warn" | "bad" | "unknown" };
type Backup = { dump?: { at: string; bytes: number; rows: Record<string, number> }; pruned?: number; error?: string;
  models?: { at: string; done: boolean; copied: number; total: number; left: number; error?: string } } | null;
type U = { meters: Meter[]; backup: Backup; backupConfigured: boolean };

const ICON: Record<string, React.ReactNode> = { r2: <HardDrives size={18} />, "neon-db": <Database size={18} />, "neon-cu": <Lightning size={18} />, backup: <CloudArrowUp size={18} /> };
const fmt = (v: number, unit: Meter["unit"]) => (unit === "hours" ? `${v.toFixed(1)} h` : v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : `${Math.round(v / 1e3)} KB`);
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");
const PILL = { ok: ["ok", "Fine"], warn: ["warn", "Over 70 %"], bad: ["bad", "Over 90 %"], unknown: ["", "Not known"] } as const;

export default function Usage() {
  const [u, setU] = useState<U | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { fetch("/api/ws/usage").then(async (r) => (r.ok ? setU(await r.json()) : setErr((await r.json().catch(() => ({}))).error || "Couldn't read usage"))).catch((e) => setErr(e.message)); }, []);
  if (err) return <p className="err" role="alert">{err}</p>;
  if (!u) return <div className="skel" style={{ height: 320 }} />;
  const hot = u.meters.filter((m) => m.level === "warn" || m.level === "bad");
  const b = u.backup;
  return (
    <div className="bento">
      {hot.length > 0 && (
        <div className="b-6"><Notice icon={<WarningCircle size={16} />} tone={hot.some((m) => m.level === "bad") ? "bad" : "warn"}>
          {hot.map((m) => m.name).join(", ")} {hot.length > 1 ? "are" : "is"} running high. Clear what isn't needed before it fills.
        </Notice></div>
      )}
      {u.meters.map((m) => {
        const pct = m.used == null ? 0 : Math.min(100, (m.used / m.limit) * 100);
        return (
          <section key={m.id} className="card b-3">
            <div className="card-head">
              <div className="row" style={{ gap: 10 }}>{ICON[m.id]}<h2>{m.name}</h2></div>
              <span className={`pill ${PILL[m.level][0]}`}>{PILL[m.level][1]}</span>
            </div>
            <p className="mono" style={{ margin: "0 0 10px", fontSize: 20 }}>
              {m.used == null ? "—" : fmt(m.used, m.unit)} <span className="dim small">of {fmt(m.limit, m.unit)} free{m.used != null ? ` · ${pct.toFixed(0)} %` : ""}</span>
            </p>
            <div className="bar" role="meter" aria-label={`${m.name} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <i style={{ width: `${pct}%`, background: m.level === "bad" ? "var(--bad)" : m.level === "warn" ? "var(--warn)" : undefined }} />
            </div>
            <p className="tiny dim" style={{ margin: "10px 0 0" }}>{m.note}</p>
          </section>
        );
      })}
      <section className="card b-6">
        <div className="card-head"><div><h2>Nightly backup</h2><p className="sub">A copy of the database and the trained voices outside Cloudflare, every night after 02:00 UTC.</p></div></div>
        {!u.backupConfigured ? (
          <p className="small dim">Not set up: add NEON_S3_ENDPOINT, NEON_S3_ACCESS_KEY_ID, NEON_S3_SECRET_ACCESS_KEY, NEON_S3_REGION and NEON_S3_BUCKET on Vercel.</p>
        ) : (
          <div className="stack small" style={{ gap: 6 }}>
            <span>Database: {b?.dump ? <>{when(b.dump.at)} · {fmt(b.dump.bytes, "bytes")} · {Object.entries(b.dump.rows).map(([t, n]) => `${n} ${t}`).join(", ")}</> : "not yet"}{b?.error && <span className="pill bad" style={{ marginLeft: 8 }}>{b.error}</span>}</span>
            <span>Trained voices: {b?.models ? <>{b.models.done ? "up to date" : `${b.models.left} files still to copy`} · {when(b.models.at)} · {fmt(b.models.total, "bytes")} in all</> : "not yet"}{b?.models?.error && <span className="pill bad" style={{ marginLeft: 8 }}>{b.models.error}</span>}</span>
            {!!b?.pruned && <span className="dim">{b.pruned} activity entries older than a year cleared.</span>}
          </div>
        )}
      </section>
    </div>
  );
}
