// What the free tiers have left (Settings → Usage, docs/MIGRATION.md): R2's 10 GB, Neon's database (1 GB) and compute
// hours (100 CU-hours a month; read from Neon's API when NEON_API_KEY is set), and the backup bucket (5 GB). Each one
// warns at 70 % and is in trouble at 90 %; new uploads already stop at the R2 budget (STORAGE_CAP_GB, lib/r2files.ts).
import { storageUse } from "./r2files";

export type Meter = { id: string; name: string; used: number | null; limit: number; unit: "bytes" | "hours"; note: string; level: "ok" | "warn" | "bad" | "unknown" };
const level = (used: number | null, limit: number): Meter["level"] => (used == null ? "unknown" : used >= limit * 0.9 ? "bad" : used >= limit * 0.7 ? "warn" : "ok");
const meter = (m: Omit<Meter, "level">): Meter => ({ ...m, level: level(m.used, m.limit) });
const GB = 1e9;

export async function usage() {
  const meters: Meter[] = [];
  const r2 = await storageUse().catch(() => null);
  const top = r2 ? Object.entries(r2.parts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${(v / GB).toFixed(1)} GB`).join(", ") : "";
  meters.push(meter({ id: "r2", name: "Files and voices (Cloudflare R2)", used: r2?.bytes ?? null, limit: 10 * GB, unit: "bytes",
    note: r2 ? `New uploads stop at ${(r2.cap / GB).toFixed(1)} GB. Biggest: ${top}.` : "Couldn't count the bucket right now." }));

  const { hasDb, sql } = await import("./db");
  if (hasDb()) {
    const size = await sql().query("select pg_database_size(current_database())::bigint as b").then((r) => Number((r as { b: string }[])[0].b)).catch(() => null);
    meters.push(meter({ id: "neon-db", name: "Database (Neon Postgres)", used: size, limit: Number(process.env.NEON_STORAGE_GB || 1) * GB, unit: "bytes",
      note: process.env.DB_BACKEND === "neon" ? "Posts, comments, activity and the file list live here." : "A copy for now; Appwrite still leads." }));
    meters.push(meter({ id: "neon-cu", name: "Database compute (Neon)", used: await computeHours(), limit: 100, unit: "hours",
      note: process.env.NEON_API_KEY ? "CU-hours this month. Capped at 0.25 CU; it sleeps after 5 idle minutes." : "Add NEON_API_KEY on Vercel to see this month's hours." }));
  }

  const { hasBackup, backupList, backupState } = await import("./backup");
  const state = await backupState().catch(() => null);
  if (hasBackup()) {
    const used = await backupList("").then((l) => l.reduce((n, o) => n + o.size, 0)).catch(() => null);
    meters.push(meter({ id: "backup", name: "Backups (Neon storage)", used, limit: 5 * GB, unit: "bytes", note: "Nightly database copies and the trained voices." }));
  }
  return { meters, backup: hasBackup() ? state : null, backupConfigured: hasBackup() };
}

/** This month's compute (CU-hours) from Neon's API, or null without a key. */
async function computeHours() {
  const key = process.env.NEON_API_KEY;
  if (!key) return null;
  const r = await fetch(`https://console.neon.tech/api/v2/projects/${process.env.NEON_PROJECT_ID || "plain-unit-11439440"}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }).catch(() => null);
  if (!r?.ok) return null;
  const p = ((await r.json()) as { project?: { compute_time_seconds?: number } }).project;
  return p?.compute_time_seconds != null ? p.compute_time_seconds / 3600 : null;
}
