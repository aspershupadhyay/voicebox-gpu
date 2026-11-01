// Voicebox timer: a Cloudflare Worker whose cron (* * * * *) does the studio's scheduled work, so the studio is only
// woken when there's something to do (docs/MIGRATION.md, step 3). Deployed with the studio by
// .github/workflows/deploy.yml (workers/wrangler.timer.jsonc).
// - Every minute: Grow → Live's counters (/api/cron/live), but only while someone is watching. The Worker reads the
//   "seen" marker straight from R2 (binding BUCKET) instead of asking the studio.
// - Every minute while a post is on its way out (workspace/publish/active.json, lib/publish/plans.ts): carry it on
//   (/api/cron/publish), so a Reel goes live within a minute or two of Instagram finishing it, not at the next sweep.
// - Every 10 minutes: the sweep (/api/cron/sweep: dead GPUs, the publishing autopilot, downloads, workflows).
// - The nightly backup (/api/cron/backup), only when it's due: after 02:00 UTC once a day, or while a copy of the
//   trained voices is catching up (backups/state.json in R2).
// Every knock is awaited, not handed to waitUntil: the studio does the work inside the request now (after() work is
// stopped 30 s after a response), and a Cron Trigger may run for 15 minutes.
// Settings: TARGET (the live route; the others are on the same site), LIVE_SECRET (made inside Cloudflare and never
// written down; the studio keeps only its SHA-256, lib/cronauth.ts) and BUCKET (the voicebox R2 bucket, read only).
const WATCH_MS = 150_000; // lib/live.ts
const ACTIVE_MS = 6 * 3600_000; // a marker older than this is stale (the publish route clears it once nothing is busy)
const SITE = "https://voiceboxstudio.pages.dev";

const json = async (env, key) => {
  try { const o = await env.BUCKET.get(key); return o ? await o.json() : null; } catch { return undefined; } // undefined: couldn't read
};

export default {
  async scheduled(event, env) {
    const site = env.TARGET ? new URL(env.TARGET).origin : SITE;
    const knock = (path) => fetch(`${site}${path}`, { method: "POST", headers: { Authorization: `Bearer ${env.LIVE_SECRET}` } }).then((r) => r.text()).catch(() => null);
    const now = new Date(event.scheduledTime);
    const jobs = [];

    const seen = await json(env, "workspace/live/seen.json");
    if (seen === undefined || (seen && now - seen.at <= WATCH_MS)) jobs.push(knock("/api/cron/live"));

    const tenth = now.getUTCMinutes() % 10 === 0;
    const active = await json(env, "workspace/publish/active.json");
    // the sweep carries busy plans on too, so the minute knock sits out the tenth minute
    if (!tenth && (active === undefined || (active && now - active.at <= ACTIVE_MS))) jobs.push(knock("/api/cron/publish"));

    if (tenth) {
      jobs.push(knock("/api/cron/sweep"));
      const b = await json(env, "backups/state.json");
      const day = now.toISOString().slice(0, 10);
      const due = b === undefined || !b || (now.getUTCHours() >= 2 && b.day !== day) || (b.models && !b.models.done);
      if (due) jobs.push(knock("/api/cron/backup"));
    }
    await Promise.all(jobs);
  },
  async fetch() {
    return new Response("Voicebox timer: live counters while someone watches, publishing while a post is on its way out, the sweep every 10 minutes, the nightly backup.", { headers: { "content-type": "text/plain" } });
  },
};
