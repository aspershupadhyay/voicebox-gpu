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
(Appwrite converts them). Tokens are sealed with AES-256-GCM under `PUBLISH_KEY` (falls back to `MCP_TOKEN`) and
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
