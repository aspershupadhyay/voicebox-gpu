# The shared workspace

One desk for the two of you: every post you're making, its script, caption, files, voiceovers and the conversation about
it, on both screens at once. It runs on **Appwrite Cloud** (project `voicebox-studio`, Singapore region, GitHub Student
organization). Voiceovers and voices stay in **R2**, which is also the backup for workspace media.

## What's where

| Page | What it's for |
|---|---|
| **Board** | Posts by stage: Ideas → In production → Review → Scheduled → Posted. Drag cards between stages, press **N** for a new post, filter by platform or "Mine". Click a card for the full post. |
| **Post** (drawer) | Title, stage, platforms, publish time, owner, script (with **Voiceover** → opens the voice page with the script loaded; the result is attached back to the post), caption with per-platform character counts, media, notes, discussion. Edits save as you type. |
| **Calendar** | Month view. Drag a post onto a day to schedule it; double-click a day to start one there. |
| **Media** | Every file either of you added: images, videos (up to 2 GB each), audio, docs. Drop files anywhere on the page. |

Everything is live (Appwrite Realtime): when one of you moves a card, edits a script or comments, the other sees it within
a second. The activity feed under the board says who did what.

## Accounts

Each of you signs in with your own email and password (**Create an account** on the sign-in page). The project allows
exactly **two** accounts; a third sign-up is refused. Signing in puts you on the `studio` team, which is what grants access
to the data. To lock it down further, set `WORKSPACE_EMAILS="you@x.com,friend@y.com"` on Vercel.

The old access-token sign-in still works for the studio (voice, library, settings) but can't see the workspace, because
posts and comments belong to people.

## Install it as an app

- **Phone:** open the dashboard in Safari (iPhone) or Chrome (Android) → Share / menu → **Add to Home Screen**.
- **Desktop:** Chrome or Edge → the install icon in the address bar.

It opens full-screen with a bottom tab bar on phones, and starts on the Board.

## Storage and the R2 backup

Files upload straight from the browser to Appwrite Storage (chunked, so large videos resume after a network blip). Each
file then gets a view token (so previews and video play anywhere) and, with **Settings → Back up uploads to R2** on, a copy
in your R2 bucket under `workspace/media/`. Files over ~180 MB skip the automatic copy (a serverless function holds the
file in memory to copy it).

Watch the plan's storage and bandwidth in the Appwrite console. If the student plan ends: everything in R2 is yours,
and the code paths to R2 (`mcp/lib/store.ts`) are unchanged.

## Server configuration

| Variable | Where | What |
|---|---|---|
| `APPWRITE_API_KEY` | Vercel | Server key `dashboard-server` (scopes: users.read, teams.read/write, tables.read, rows.read/write, buckets.read, files.read/write, tokens.read/write). Needed to put people on the team, mint file tokens, back up to R2 and for the MCP workspace tools. |
| `NEXT_PUBLIC_APPWRITE_ENDPOINT` / `NEXT_PUBLIC_APPWRITE_PROJECT` | optional | Default to `https://sgp.cloud.appwrite.io/v1` and `voicebox-studio`. |
| `WORKSPACE_EMAILS` | optional | Comma-separated allow-list. |

Schema (database `studio`): `posts`, `comments`, `activity`, `media` tables, team-level permissions for `team:studio`;
storage bucket `media` (2 GB per file, encrypted, antivirus, image previews). The dashboard's web platform is registered
for `voiceboxstudio.vercel.app`, `mcp-eta-tawny.vercel.app` and `localhost`; add a platform in the Appwrite console if you add a custom domain.

## From Claude (MCP)

The MCP server covers the workspace too: `workspace_board`, `get_post`, `create_post`, `update_post`, `comment_on_post`,
`content_calendar`, `workspace_media`, `add_media`, `attach_voiceover`, `workspace_activity`, `workspace_members`, and
`voice_lines` with `post_id` to voice a post's script. Ask things like "plan three Shorts for next week about Git and
write the scripts", "voice the Docker post in my voice", or "what did Ravi change today?".
