// Appwrite's webhook (docs/MIGRATION.md, phase 2): every row created, updated or deleted in the workspace's four tables,
// from the browser or the server, lands here and is mirrored into Postgres (lib/db.ts), so Neon keeps up with Appwrite
// until reads switch. Public by design, like a worker route: each delivery must carry Appwrite's signature, an
// HMAC-SHA1 of this URL plus the body under a key only Vercel holds (hookKey). The same signature also lets the owner's
// tooling ask for {"op": "copy"} (fill Postgres from Appwrite and compare), {"op": "check"}, {"op": "users"} (copy the
// studio team into Postgres for sign-in, lib/users.ts) or {"op": "files-to-r2"} (move files still in Appwrite Storage
// to R2; Appwrite's copy stays until Appwrite goes) or {"op": "backup"} (the nightly backup's turn, lib/backup.ts).
import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // the full copy pages through every table

export async function POST(req: Request) {
  const db = await import("@/lib/db");
  if (!db.hasDb()) return Response.json({ error: "database not configured" }, { status: 503 });
  const body = await req.text();
  const u = new URL(req.url);
  const want = createHmac("sha1", db.hookKey()).update(`${u.origin}${u.pathname}${body}`).digest("base64");
  if (!safeEqual(req.headers.get("x-appwrite-webhook-signature") ?? "", want)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let data: Record<string, unknown>;
  try { data = JSON.parse(body); } catch { return Response.json({ error: "bad body" }, { status: 400 }); }
  // once Postgres leads (DB_BACKEND=neon) Appwrite only holds its copy: its deliveries are echoes of our own writes
  const leads = process.env.DB_BACKEND === "neon";
  try {
    if (data.op === "copy") {
      if (leads) return Response.json({ error: "Postgres already leads (DB_BACKEND=neon): a copy from Appwrite would go backwards" }, { status: 409 });
      return Response.json({ copied: await db.copyFromAppwrite(), check: await db.checkCopy() });
    }
    if (data.op === "check") return Response.json(await db.checkCopy());
    if (data.op === "users") return Response.json({ copied: await (await import("@/lib/users")).copyTeam(), users: await (await import("@/lib/users")).listUsers() });
    if (data.op === "backup") return Response.json((await (await import("@/lib/backup")).nightly(100_000)) ?? { idle: true });
    if (data.op === "files-to-r2") return Response.json(await (await import("@/lib/appwrite")).filesToR2());
    if (leads) return Response.json({ ignored: "Postgres leads" });
    const table = data.$tableId;
    if (data.$databaseId !== "studio" || !db.isTable(table) || typeof data.$id !== "string") return Response.json({ ignored: true });
    const events = req.headers.get("x-appwrite-webhook-events") ?? "";
    if (/\.delete(,|$)/.test(events)) await db.unmirror(table, data.$id);
    else await db.mirror(table, data);
    return Response.json({ ok: true });
  } catch (e) {
    // a 5xx makes Appwrite try again later; the copy run before the switch fixes anything that never lands
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
