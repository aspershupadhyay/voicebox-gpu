// Voicebox live timer: a Cloudflare Worker whose cron (* * * * *) knocks on the dashboard's /api/cron/live once a
// minute, so Grow → Live reads fresh counters all day (Vercel's free plan only runs crons daily). Deployed as
// "voicebox-live-timer" with two settings: TARGET (the route) and LIVE_SECRET (a secret made inside Cloudflare and never written down; the route keeps only its SHA-256).
// Free: Workers' free plan includes cron triggers, and a knock spends almost no CPU (it waits on the fetch).
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(fetch(env.TARGET, { method: "POST", headers: { Authorization: `Bearer ${env.LIVE_SECRET}` } }).then((r) => r.text()));
  },
  async fetch() {
    return new Response("Voicebox live timer: knocks on /api/cron/live every minute.", { headers: { "content-type": "text/plain" } });
  },
};
