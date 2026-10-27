# The shared workspace

One desk for the two of you: every post you're making, its script, caption, files, voiceovers and the conversation about
it, on both screens at once. It runs on **Appwrite Cloud** (project `voicebox-studio`, Singapore region, GitHub Student
organization). Voiceovers and voices stay in **R2**, which is also the backup for workspace media.

## What's where

| Page | What it's for |
|---|---|
| **Posts** | Every post, with summary cards (due this week, overdue, in production, shipped vs the weekly goal) and four views: **Board** by stage (Ideas → In production → Review → Scheduled → Posted; drag cards between stages), **Calendar** (drag a post onto a day; double-click a day to start one), **List** (stage and publish time editable inline) and **Gallery** (the week ahead plus cards grouped Up next / In the works / Ideas / Shipped). Filter by platform or format (YouTube Videos / Shorts / Posts, Instagram Reels / Posts / Stories, X Posts / Threads, TikTok, LinkedIn, Podcast) or Ideas, and by "Mine". **New post** starts one already in that format. **Activity** shows who did what. |
| **Post** (drawer) | Title, stage, **Publish to** (one row per space, each with its own stage, publish time and live link; *Cross-post to…* adds another; the post's stage is its furthest-behind target, so it's Posted only when every target is), publish time, owner, script (with **Voiceover** → opens the voice page with the script loaded; the result is attached back to the post), caption with per-platform character counts, media, notes, discussion. Edits save as you type. |
| **Files** | A file manager over every upload (images, videos up to 2 GB, audio, docs) and everything the GPU made, in folders (six colours, nested). Upload with the button, by dropping files anywhere (or onto a folder) or by pasting a photo, files or a link. Drag cards onto a folder or the path to move them; right-click or ⋮ for open, rename (F2), move, cut, star, download, copy link and delete. Search covers every folder; filter by type, source, date and who added it; grid or list. Keys: ⌘F search, ⌘A select all, ⌘C copy links, ⌘X then ⌘V move, Delete, Esc. |

Everything is live (Appwrite Realtime): when one of you moves a card, edits a script or comments, the other sees it within
a second. **Activity** (top right of Posts) says who did what.

## Accounts

Each person signs in with their own email and password (**Create an account** on the sign-in page). The Appwrite project
allows up to **four** accounts (Auth → Security → Users limit); a fifth sign-up is refused. Signing in puts you on the
`studio` team, which is what grants access to the data. To lock it down further, set `WORKSPACE_EMAILS` on Vercel; people
listed in **Settings → Claude / MCP access → Workspace people** are always let in on top of it.

**Claude / MCP:** any number of connections. In the same Settings card, up to 4 GitHub usernames may connect with
"Continue with GitHub" (besides `OWNER_GITHUB`); anyone with the access token can connect too.

The old access-token sign-in still works for the studio (voice, library, settings) but can't see the workspace, because
posts and comments belong to people.

## Install it as an app

- **Phone:** open the dashboard in Safari (iPhone) or Chrome (Android) → Share / menu → **Add to Home Screen**.
- **Desktop:** Chrome or Edge → the install icon in the address bar.

It opens full-screen with a bottom tab bar on phones, and starts on Home.

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

Folders, where each file sits and stars are not in Appwrite: they're one small JSON file in R2 (`workspace/files.json`,
`mcp/lib/files.ts`), read fresh before every change. The page re-reads it every 20 s and when the tab comes back.

Schema (database `studio`): `posts`, `comments`, `activity`, `media` tables, team-level permissions for `team:studio`;
storage bucket `media` (2 GB per file, encrypted, antivirus, image previews). The dashboard's web platform is registered
for `voiceboxstudio.vercel.app`, `mcp-eta-tawny.vercel.app` and `localhost`; add a platform in the Appwrite console if you add a custom domain.

## From Claude (MCP)

The MCP server covers the workspace too: `workspace_board`, `get_post`, `create_post`, `update_post`, `comment_on_post`,
`content_calendar`, `workspace_media`, `add_media` (from a link), `upload_media` (file bytes), `delete_media`, `attach_voiceover`, `workspace_activity`, `workspace_members`,
the Files tools (`list_files`, `get_file`, `create_folder`, `update_folder`, `delete_folder`, `move_files`, `rename_file`, `star_files`, `delete_files`; see docs/API.md), and
`voice_lines` with `post_id` to voice a post's script. Posts take `targets` (spaces such as `ig_reel`, `yt_short`, `x_post`) to cross-post, and `workspace_board` filters by `space`.
Where each post goes is stored in R2 (`workspace/spaces.json`) next to the Appwrite post, whose `platforms` follow it.
Ask things like "plan three Shorts for next week about Git and
write the scripts", "voice the Docker post in my voice", or "what did Ravi change today?".
