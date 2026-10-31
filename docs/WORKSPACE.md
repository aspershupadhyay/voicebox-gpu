# The shared workspace

One desk for the two of you: every post you're making, its script, caption, files, voiceovers and the conversation about
it, on both screens at once. Posts, comments, activity, the file list and accounts live in **Postgres on Neon**; every
file, voiceover and voice in **R2**; the app on **Cloudflare** at https://voiceboxstudio.pages.dev (docs/MIGRATION.md).

## What's where

| Page | What it's for |
|---|---|
| **Posts** | Every post, with summary cards (due this week, overdue, in production, shipped vs the weekly goal) and four views: **Board** by stage (Ideas → In production → Review → Scheduled → Posted; drag cards between stages), **Calendar** (drag a post onto a day; double-click a day to start one), **List** (stage and publish time editable inline) and **Gallery** (the week ahead plus cards grouped Up next / In the works / Ideas / Shipped). Filter by platform or format (YouTube Videos / Shorts / Posts, Instagram Reels / Posts / Stories, X Posts / Threads, TikTok, LinkedIn, Podcast) or Ideas, and by "Mine". **New post** starts one already in that format. **Activity** shows who did what. |
| **Post** (drawer) | Title, stage, **Publish to** (one row per space, each with its own stage, publish time and live link; *Cross-post to…* adds another; the post's stage is its furthest-behind target, so it's Posted only when every target is), publish time, owner, script (with **Voiceover** → opens the voice page with the script loaded; the result is attached back to the post), caption with per-platform character counts, media, notes, discussion. Edits save as you type. |
| **Files** | A Drive-like file manager. Five category folders (Videos, Images, Audio, Docs & scripts, Other) file everything by kind on their own; your folders sit beside them; Recent shows the newest. Deleting goes to the Trash for 30 days (Undo, Restore, Delete forever, Empty trash). Uploads show as cards at once and in a panel. Over every upload (images, videos up to 2 GB, audio, docs) and everything the GPU made, in folders (six colours, nested). Upload with the button, by dropping files anywhere (or onto a folder) or by pasting a photo, files or a link. Drag cards onto a folder or the path to move them; right-click or ⋮ for open, rename (F2), move, cut, star, download, copy link and delete. Search covers every folder; filter by type, source, date and who added it; grid or list. Keys: ⌘F search, ⌘A select all, ⌘C copy links, ⌘X then ⌘V move, Delete, Esc. |

Everything is live (Neon Realtime): when one of you moves a card, edits a script or comments, the other sees it within
a second. **Activity** (top right of Posts) says who did what.

## Accounts

Each person signs in with their own email and password (**Create an account** on the sign-in page, for an email on the
list). Accounts are rows in Postgres with scrypt password hashes (`mcp/lib/users.ts`). Who may sign in: the people in
**Settings → Security** plus `WORKSPACE_EMAILS` on the Worker. The key icon there changes your password, or sets one for
a teammate who has none yet.

**Claude / MCP:** any number of connections. In the same Settings card, up to 4 GitHub usernames may connect with
"Continue with GitHub" (besides `OWNER_GITHUB`); anyone with the access token can connect too.

The old access-token sign-in still works for the studio (voice, library, settings) but can't see the workspace, because
posts and comments belong to people.

## Install it as an app

- **Phone:** open the dashboard in Safari (iPhone) or Chrome (Android) → Share / menu → **Add to Home Screen**.
- **Desktop:** Chrome or Edge → the install icon in the address bar.

It opens full-screen with a bottom tab bar on phones, and starts on Home.

## Storage and the R2 backup

Files upload straight from the browser to R2 (`workspace/media/`) with a progress bar, then get a row with a token so
previews and video play anywhere (`/api/m/<token>/<key>`, `mcp/lib/r2files.ts`). Uploads stop at `STORAGE_CAP_GB` (9 GB
of R2's free 10); Settings → Usage shows every free tier. Each night the database is dumped to Neon storage and the
trained voices copied there too (`mcp/lib/backup.ts`).

## Server configuration

| Variable | Where | What |
|---|---|---|
| `DATABASE_URL_POOLED` | Worker | Neon's pooled connection string (posts, comments, activity, media, users). |
| `NEON_REALTIME_URL` / `NEON_REALTIME_SECRET` | Worker | The live board. |
| `WORKSPACE_EMAILS` | optional | Comma-separated allow-list. |

Folders, where each file sits and stars are not in the database: they're one small JSON file in R2 (`workspace/files.json`,
`mcp/lib/files.ts`), read fresh before every change. The page re-reads it every 20 s and when the tab comes back.

Schema: `mcp/db/001_workspace.sql` (`posts`, `comments`, `activity`, `media`) and `mcp/db/002_users.sql` (`users`).

## From Claude (MCP)

The MCP server covers the workspace too: `workspace_board`, `get_post`, `create_post`, `update_post`, `comment_on_post`,
`content_calendar`, `workspace_media`, `add_media` (from a link), `upload_media` (file bytes), `delete_media`, `attach_voiceover`, `workspace_activity`, `workspace_members`,
the Files tools (`list_files`, `get_file`, `create_folder`, `update_folder`, `delete_folder`, `move_files`, `rename_file`, `star_files`, `delete_files`, `restore_files`, `empty_trash`; see docs/API.md), and
`voice_lines` with `post_id` to voice a post's script. Posts take `targets` (spaces such as `ig_reel`, `yt_short`, `x_post`) to cross-post, and `workspace_board` filters by `space`.
Where each post goes is stored in R2 (`workspace/spaces.json`) next to the post, whose `platforms` follow it.
Ask things like "plan three Shorts for next week about Git and
write the scripts", "voice the Docker post in my voice", or "what did Ravi change today?".
