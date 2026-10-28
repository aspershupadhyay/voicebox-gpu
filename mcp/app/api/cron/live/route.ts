// The minute timer's knock (Grow → Live): a Cloudflare cron (workers/live-timer.js) POSTs here every minute and
// lib/live.ts reads every fresh post's counters, only while someone has a Grow page open and in use (otherwise it
// answers { idle: true } without asking YouTube or Instagram anything). Locked like the other worker routes:
// WORKER_SECRET, or the timer's own secret, which only lives in Cloudflare; this file keeps its SHA-256
// (LIVE_TIMER_HASH on Vercel overrides it).
import { createHash } from "node:crypto";
import { timerTick } from "@/lib/live";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TIMER_HASH = process.env.LIVE_TIMER_HASH || "541b2cb0083a8d393b100b7fd63cc230cdf6b4fb27a5ed79e1fdc03b987060e4";

function allowed(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token.length < 24) return false;
  const worker = process.env.WORKER_SECRET ?? "";
  if (worker.length >= 24 && safeEqual(token, worker)) return true;
  return safeEqual(createHash("sha256").update(token).digest("hex"), TIMER_HASH);
}

export async function POST(req: Request) {
  if (!allowed(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await timerTick());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
