// Voicebox timer: a Cloudflare Worker whose cron (* * * * *) does the studio's scheduled work, so Vercel is only woken
// when there's something to do (docs/MIGRATION.md, step 3: Vercel's function hours were at 75 %).
// - Every minute: Grow → Live's counters (/api/cron/live), but only while someone is watching. The Worker reads the
//   "seen" marker straight from R2 (binding BUCKET) instead of asking Vercel, which used to wake 1,440 times a day to
//   answer "nobody's here".
// - Every 10 minutes: the sweep (/api/cron/sweep: dead GPUs, the publishing autopilot, downloads, workflows), on time,
//   unlike GitHub's schedule, which ran every few hours.
// - The nightly backup (/api/cron/backup), only when it's due: after 02:00 UTC once a day, or while a copy of the
//   trained voices is catching up (backups/state.json in R2).
// Settings: TARGET (the live route; the others are on the same site), LIVE_SECRET (made inside Cloudflare and never
// written down; Vercel keeps only its SHA-256, lib/cronauth.ts) and BUCKET (the voicebox R2 bucket, read only).
const WATCH_MS = 150_000; // lib/live.ts

const json = async (env, key) => {
  try { const o = await env.BUCKET.get(key); return o ? await o.json() : null; } catch { return undefined; } // undefined: couldn't read
};

export default {
  async scheduled(event, env, ctx) {
    const site = new URL(env.TARGET).origin;
    const knock = (path) => fetch(`${site}${path}`, { method: "POST", headers: { Authorization: `Bearer ${env.LIVE_SECRET}` } }).then((r) => r.text()).catch(() => null);
    const now = new Date(event.scheduledTime);

    const seen = await json(env, "workspace/live/seen.json");
    if (seen === undefined || (seen && now - seen.at <= WATCH_MS)) ctx.waitUntil(knock("/api/cron/live"));

    if (now.getUTCMinutes() % 10 === 0) {
      ctx.waitUntil(knock("/api/cron/sweep"));
      const b = await json(env, "backups/state.json");
      const day = now.toISOString().slice(0, 10);
      const due = b === undefined || !b || (now.getUTCHours() >= 2 && b.day !== day) || (b.models && !b.models.done);
      if (due) ctx.waitUntil(knock("/api/cron/backup"));
    }
  },
  async fetch() {
    return new Response("Voicebox timer: live counters while someone watches, the sweep every 10 minutes, the nightly backup.", { headers: { "content-type": "text/plain" } });
  },
};
