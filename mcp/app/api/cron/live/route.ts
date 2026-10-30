// The minute timer's knock (Grow → Live): a Cloudflare cron (workers/live-timer.js) POSTs here every minute and
// lib/live.ts reads every fresh post's counters, only while someone has a Grow page open and in use (otherwise it
// answers { idle: true } without asking YouTube or Instagram anything; the timer itself now only knocks while someone
// is watching). Locked like the other scheduled routes (lib/cronauth.ts): the timer's own secret, kept only as a SHA-256.
import { timerTick } from "@/lib/live";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await (await import("@/lib/cronauth")).cronAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await timerTick());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
