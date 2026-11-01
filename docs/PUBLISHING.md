# Publishing and the autopilot

Voicebox posts to **YouTube** (Videos, Shorts) and **Instagram** (Reels, photo/video/carousel Posts, Stories) by itself,
from a post's targets. X, TikTok, LinkedIn and podcasts get a hand-off: copy the caption, download the file, open the
upload page, mark it posted. Code: `mcp/lib/publish/` (server), `mcp/components/Publish.tsx` (composer),
`mcp/components/Autopilot.tsx` (Posts → Autopilot).

## How it works

1. Open a post and press **Publish** on a target (or **Set up** in Posts → Autopilot). Pick the account, the file and
   the cover, and fill in the options. It saves as you type and shows a preview.
2. **Publish now** sends it at once. **Set to go** hands it to the autopilot for the target's publish time (the date on
   the board and calendar). For a public YouTube video, "Let YouTube publish it on the minute" uploads it up to 6 h early
   as private with `publishAt`, and YouTube makes it public exactly then.
3. The autopilot runs every 10 minutes (`.github/workflows/sweep.yml` → `/api/cron/sweep`, after the GPU sweep). It
   starts what's due, carries on a big upload where the last run stopped (YouTube resumable upload, 32 MB pieces),
   waits for Instagram to finish processing, retries failures (5 min, 20 min, 1 h, 3 h …), moves the target to Posted
   with its live link, pushes to your phone (the ntfy topic from GPU & engines), and applies the rules: cross-post,
   posting slots, footers.

Files come from the post's Media (uploads) and the videos Voicebox made for it. Instagram photos are sent as JPEG
(made from the R2 original, `lib/r2files.ts`). Tokens are sealed with AES-256-GCM under `PUBLISH_KEY` (falls back to `MCP_TOKEN`) and
kept in R2 under `workspace/publish/accounts/`; plans are in `workspace/publish/plans/`, rules in
`workspace/publish/rules.json`.

## Set up YouTube (about 10 minutes, free)

1. In [Google Cloud Console](https://console.cloud.google.com/) make a project, then **APIs & Services → Library →
   YouTube Data API v3 → Enable**.
2. **Google Auth Platform → Branding / Audience**: user type *External*, add both your Google accounts as test users,
   then **Publish app** (In production). Unverified is fine for your own channels: you'll click past a warning once.
   Leaving it in *Testing* makes the key expire every 7 days.
3. **Clients → Create client → Web application**. Authorised redirect URI:
   `https://voiceboxstudio.vercel.app/api/publish/youtube/callback`.
4. On Vercel add `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` (and optionally `PUBLISH_KEY`, any long random string),
   redeploy, then Posts → Autopilot → Connect YouTube.

**The audit.** Uploads from an API project that Google hasn't audited are locked to private. Voicebox says so on the
plan ("Private"). Until the audit passes, open YouTube Studio and switch it to public (or schedule it there). Apply with
the [YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form); it's free and takes a few
weeks. Custom thumbnails need a phone-verified channel. Quota: uploads have their own bucket (about 100 a day); the rest
comes from the usual 10,000 units.

## Set up Instagram (about 10 minutes, free)

1. The account must be **Creator or Business** (Instagram → Settings → Account type and tools).
2. At [developers.facebook.com](https://developers.facebook.com/apps) create an app (type *Business*), add the
   **Instagram** product → *API setup with Instagram login*.
3. Under *Roles → Instagram testers* add your account(s) and accept the invite in Instagram (Settings → Website
   permissions → Apps and websites → Tester invites). In development mode that's all; no app review for your own accounts.
4. In *Business login settings* add the redirect URL `https://voiceboxstudio.vercel.app/api/publish/instagram/callback`.
5. Copy the **Instagram app ID** and **Instagram app secret** to Vercel as `INSTAGRAM_APP_ID` and
   `INSTAGRAM_APP_SECRET`, redeploy, then Posts → Autopilot → Connect Instagram.

Limits: about 100 API posts per account per 24 h (the composer shows what's left); Reels 3 s to 15 min, under 300 MB,
MP4 H.264/AAC; Stories up to 60 s; feed photos 4:5 to 1.91:1; carousels up to 20 items, cropped to the first one's
shape. Long-lived tokens last 60 days and the autopilot renews them from 20 days out.

## Auto-DM (the Auto-DM page, `/auto-dm`)

Our own ManyChat-style automations. The engine is `mcp/lib/publish/autodm.ts` (flows, sending, the webhook) and
`autodm-more.ts` (comment rules, AI replies, the held queue, sync, the weekly report, auto-attach, A/B); matching is
`dmmatch.ts`; history is Postgres (`dmstore.ts`, `db/003_autodm.sql`, `db/004_autodm_more.sql`); the webhook is
`mcp/app/api/ig/webhook`; link clicks go through `mcp/app/l/[token]`; the page is `mcp/components/autodm/`. Five tabs
(`?tab=`), each doing one job:

- **Automations**: one quiet line of 30-day numbers (live, sent, opened, emails, people), then the list, built for
  hundreds. Search by name, keyword or post; filter live/off and by account; sort by recent, most sent, best open rate
  or name; select many to switch on/off or delete. Each row shows its sends, its open rate and short tags for the extra
  steps (Followers, Email, choices, A/B, AI, Auto). *New* starts from a template (keyword → link, let them choose,
  collect emails, followers only, thank story mentions, any comment, blank) or **Find them in my captions** (recent
  posts whose caption says "comment WORD" with nothing answering it; tick them and each becomes an automation).
  The editor (`?edit=<id>`) is a **flow**: steps down a line, one open at a time, each with a one-line summary:
  - **When**: comments, DMs, story replies and/or **story mentions**; every account or chosen ones; every post or
    chosen posts (from the Instagram grid or studio posts, which count once live).
  - **Match**: *typos ok* (fuzzy: "cathc", "CATCHHH", "c a t c h"; the first letter must match), *has the keyword*,
    *just the keyword*, or *anything*; words to ignore; top-level comments only.
  - **Followers only** (optional): "follow, then tap"; the tap is checked (`is_user_follow_business`).
  - **Email first** (optional): asks for an email before the DM; the address is saved and the DM follows.
  - **The DM** (`{username}`, `{handle}`) with a link button (**Count opens** on: the link becomes a signed short link
    `/l/<token>` that counts the open and forwards to the real address, bots and link previews not counted), up to
    three **choices** (each button answers with its own reply and link), and **Version B** (an A/B test: half get each
    until one is clearly opened more, a 95% two-proportion test once both have the minimum sends, or the better one
    after ten times that; the winner then goes to everyone and you get a notification).
  - **Ask for email after** (optional): the DM ends asking for an email; replies with one are saved to People.
  - **Public answer** (one at random), **AI follow-ups** (below) and **Limits** (once per person).
  - Beside it, a phone shows the whole flow as people get it (tap the choices, switch A/B) with a comment box that
    tries a comment against the draft. Nothing is sent from the editor.
- **Comments**: **comment rules** run on every new comment before any automation: words (exact or with typos) and/or
  any link → **hide**, **delete** or **flag**. Rules read as sentences ("Hide comments with “promo”, “crypto” (typos
  too)"); presets for links and spam. Beside them the review list: flagged, hidden, deleted; show a hidden one again,
  hide or delete a flagged one, or leave it up.
- **People**: everyone who triggered an automation (times, DMs, opens, email, follows) and, under *Emails*, every
  address collected, for a newsletter; CSV for both. **Block** anyone (they never get a DM).
- **Insights**: the weekly note, six numbers against the period before (7, 30 or 90 days), every day as striped bars
  (sent, with opened inside), the best automations, A/B tests and their state, and the full **Log** (every comment,
  DM, story reply, mention and AI answer, with why anything didn't go).
- **Settings**, a section at a time down the side (`?section=`):
  - **General**: the master switch and a pause per account.
  - **Safety**: DMs an hour per account (default 150; Instagram allows about 200) and a day per person (default 5).
    Past the hourly limit DMs are **held** and sent in a later hour by the sweep (`/api/cron/sweep`), within
    Instagram's windows; blocked usernames.
  - **Auto-attach**: when the studio posts a Reel or post whose caption asks for a keyword, an automation is made from
    the chosen template (`{title}`, `{keyword}`; a link in the caption fills the button), live or off for you to check.
  - **AI replies**: when someone who got a DM writes back, Claude answers from the post's script and caption, the
    automation's notes and the persona here; anything it can't answer is handed to you (a notification), and it
    answers at most N times a person a day. Needs a **Claude key** (Settings → Automation → Keys, kept encrypted like
    the other tool keys; or `ANTHROPIC_API_KEY` on the Worker). Uses `claude-opus-5-5` with server-side fallbacks on.
  - **Sync & report**: an https address that gets each new email (and optionally each DM) as JSON: a Google Sheet
    (the how-to has a 6-line Apps Script `doPost`), Zapier, Make or a CRM; *Send a test* and *Send every email*. The
    **weekly report** ("Auto-DM this week": sent, opened, emails, AI answers, comments caught, the best automation)
    goes to your notifications on the day you pick and is kept on Insights.
  - **Default words**: public answers, the follow-gate texts, the email ask and thanks.
  - **Set up**: the checklist below per account, and *Try a comment* against every live automation.

Each comment and message is answered at most once (a unique row per account × kind × id), our own comments never
trigger anything, and the follow button's payload is signed. The MCP tool is `auto_dm` (status, list, get, save,
switch, delete, settings, test, activity, contacts, leads, insights, report, comments, comment_act, suggest,
create_suggested, ai_test, sync_test, subscribe); saving, switching on, acting on a comment and changing the riskier
settings ask first (`lib/auto/wrap.ts`). `cd mcp && npx tsx scripts/check-autodm.cts` runs 76 end-to-end checks of
the engine against a real Postgres in WASM (`npm i --no-save @electric-sql/pglite` first); nothing leaves the machine.

It sends nothing until all of these are done (the view shows each step):

1. **Messaging permission.** In the Meta app (the one with `INSTAGRAM_APP_ID`): Instagram → API setup with Instagram
   login → permissions → add `instagram_business_manage_messages`. For your own tester accounts that's enough; for
   anyone else to get DMs the app needs **App Review** for it (Advanced Access) and the app switched to Live.
   Then `npx wrangler secret put INSTAGRAM_DM` with the value `1`. (Until then sign-in doesn't ask for it: asking for a
   permission the app doesn't have breaks Instagram sign-in.)
2. **Webhook.** Pick a long random verify token and `npx wrangler secret put INSTAGRAM_WEBHOOK_TOKEN`. In the Meta app:
   Instagram → Webhooks → callback URL `https://voiceboxstudio.pages.dev/api/ig/webhook` (Copy on the view), the same
   verify token, Verify and save, then subscribe to `comments`, `messages`, `messaging_postbacks` (button taps) and `mentions` (story mentions). Deliveries are checked against
   `X-Hub-Signature-256` with `INSTAGRAM_APP_SECRET` (or `META_APP_SECRET` if the webhook is on a parent Facebook app).
3. **Reconnect** each account (Settings tab → Reconnect, or Posts → Autopilot) so it grants messages. Voicebox then
   subscribes it to the webhook by itself; *Subscribe* does it again by hand.
4. **On the phone:** Instagram → Settings → Messages and story replies → Message controls → Connected tools → Allow
   access to messages.
5. Switch **Send DMs automatically** on, and test from a second account.

Instagram's limits: one private reply per comment, within 7 days of it; after someone DMs you, 24 hours to answer. A
button DM's text is up to 640 characters (longer, and the link goes in the text instead).

The webhook is public by design (the owner approved it, 2026-11-01): GET answers Meta's one-time check only with the
right `INSTAGRAM_WEBHOOK_TOKEN`; POST is refused unless the signature matches the body, and it reads and lists nothing
for the caller. The click links `/l/<token>` are public by design too: the token is HMAC-signed, names one sent DM and
one of its buttons, counts the open once and redirects only to the address stored on that DM; anything else is a 404.

## Every option

| YouTube | Instagram |
|---|---|
| Title (100), description (5000), tags (500 in all), category, visibility, playlist, language, license, recording date | Caption (2200, 30 hashtags, 20 mentions), carousel order, cover image or a frame (Reels) |
| Thumbnail, made for kids, altered or synthetic content, allow embedding, show views and likes, notify subscribers | Also in the feed (Reels), collaborators (3), tag people, trial reel (manual / automatic), audio name, alt text, AI label, location, first comment |
| Shorts take a custom thumbnail too | A Post's cover is its first slide (pick it in the composer); a single feed video takes a cover image |
| **After it's up**: change the title, description, tags, privacy, licence… and the thumbnail, then *Update on YouTube* (Videos and Shorts) | **Stories** are built like sharing a post by hand (`lib/publish/storycard.ts`): *Post card* (the whole post with your @handle on a blur of itself; default), *Whole picture*, or *Fill the screen* (Instagram's own crop). Photos are built on the server, videos on the GPU worker (job `storycard`). *Share to story* sends a live Post or Reel to the story that way |

What the platforms' APIs don't allow, so Voicebox can't either: YouTube Community posts (no API: they stay a hand-off),
changing an Instagram cover or caption after it's posted, and Instagram's tappable "post" sticker in a story (the card is
a picture of it).

## Rules (Posts → Autopilot)

- **Autopilot** on or off (nothing goes out by itself while it's off), retries, mark posted, phone push.
- **Cross-post**: when something goes live on one format, it's queued for another N hours later with the same file.
- **Posting slots**: a post moved to Scheduled without a time takes the next free slot of its format (in your time zone).
- **Footers** per format, a default Instagram first comment, YouTube defaults for new plans.

## Analytics

The Analytics page (`/analytics`, `lib/analytics.ts`) reads the same connected accounts. YouTube counts come from the
Data API; daily views, watch time, retention, traffic and audience need the **YouTube Analytics API** turned on in the
same Google Cloud project (APIs & Services → Library → YouTube Analytics API → Enable). Instagram reach, views, saves,
shares and audience need the `instagram_business_manage_insights` permission: channels connected before Analytics
existed show a **Reconnect** strip once. Instagram's audience details need 100 followers. A report per range is kept
for 30 minutes in `workspace/analytics/` (and a post's deep dive in `workspace/analytics/posts/`); Refresh asks the
platforms again. Follower counts are noted once a day in `workspace/analytics/history.json`, so growth shows past the 30
days Instagram keeps. YouTube gives views by day, not by hour; the hour a post should go out comes from how your posts
did by when they went out, and on Instagram from when your followers are online.

MCP: `analytics`, `publish_accounts`, `publish_post`, `publish_status`, `automation_rules` (see `docs/API.md`).
