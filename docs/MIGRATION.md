# Moving off Appwrite and most of Vercel

The owner's call (2026-10-30): stay on free tiers without the hectic. Files all go to R2, data goes to CockroachDB, the
API and the MCP move to one Cloudflare Worker, and Vercel keeps only the pages. **Nothing may break on the way**: every
feature keeps working at every step, trained voice models are never touched, and Appwrite is only switched off after a
week on the new setup.

## Rules for every phase

- One phase per pull request, merged only after `tsc`, `next build`, `check-register` and `py_compile` pass.
- Every switch sits behind a setting (`FILES_BACKEND=appwrite|r2`, `DB_BACKEND=appwrite|cockroach`), so going back is
  changing a setting, not a redeploy.
- Old and new run side by side: writes go to both, reads stay on Appwrite until counts and checksums match.
- Nothing is deleted from Appwrite until the owner has used the new setup for a week.
- `models/`, `datasets/`, `pairs/`, `profiles/`, `kvoices/` and `coach/` in R2 are the trained voices and what made
  them: no phase deletes or rewrites them.
- Before each switch, check on a preview: sign-in, Files (upload, download, share, trash), posts and the board,
  voiceover jobs, downloads, publishing to YouTube and Instagram, analytics, the MCP tools, the Colab worker.
- Secrets (the CockroachDB password, Cloudflare tokens) live only in Vercel / Cloudflare secrets and `.secrets.local`,
  never in git.

## Where things stand (measured 2026-10-30)

R2 bucket `voicebox`: 20.3 GB in 2,777 objects before the clean-up, against a 10 GB free tier.

| Prefix | Size | What it is | Plan |
|---|---|---|---|
| `cache/hf` | 13.7 GB | Hugging Face weights mirrored by the worker (Orpheus 6.6, Qwen3-TTS 4.5, Whisper 1.6, WavLM 0.8) | Rebuildable: drop, or keep one copy per engine |
| `cache/toolchain` | 1.7 GB | Motion tools (rembg, manim, scenedetect, node…) | Rebuildable: expire after 30 days |
| `cache/compile` | 0.2 GB | vLLM kernels per GPU | Rebuildable: keep the latest only |
| `models/` | 1.7 GB | **Trained voices** (harsh 1.25, sparsh 0.42) | Keep, back up to a private Hugging Face repo |
| `datasets/`, `pairs/` | 0.24 GB | **Training data** | Keep |
| `workspace/media` | 1.6 GB | R2 copies of Files uploads | Files were cleared on 2026-10-30 (only Passwords.docx kept); copies to delete |
| `workspace/downloads` | 1.0 GB | Download staging | Delete once copied into Files |

The Files page was emptied on the owner's request on 2026-10-30, except `Passwords.docx`.

## Phases

0. **Stop the waste** (shipped, #144). Hidden tabs no longer poll: the shell's status every 15 s (was 6 s, in every tab),
   GPU jobs 5 s (3 s), Home 8 s (4 s), the job tray 5 s (4 s), all paused while the tab is hidden. The sweep stays every
   10 min because it also runs the publishing autopilot (slots must not slip).
   **Clean-up (2026-10-30)**: the Files backups and download staging deleted (2.6 GB), two orphans in Appwrite
   Storage deleted (a stalled 900 MB download and a 9 MB recording with no row), the worker no longer mirrors Hugging
   Face weights by default (`VOICEBOX_R2_WEIGHTS=0`), and bucket rules expire `cache/hf/` after 7 days (the 13.7 GB
   left goes by itself around 2026-11-03), `cache/toolchain/` and `cache/compile/` after 30 (they're rebuilt on the
   next runtime that needs them) and `cache/thumbs/` after 30. That leaves about 4 GB: the trained voices, their data,
   the tool and kernel caches, and new files.
1. **All files to R2** (this PR, behind `NEXT_PUBLIC_FILES_BACKEND=r2`). A row whose `file_id` starts with `r2_` has
   its bytes at `r2_key` and a token that is an HMAC of that key; `fileUrl` sends it through `/api/m/<token>/<key>`,
   which redirects to a presigned R2 link the CDN keeps for an hour (the bytes never pass through Vercel). Photos get
   resized copies made once with sharp under `cache/thumbs/`; Instagram and YouTube get a real JPEG from the same
   place, presigned with no redirect. Uploads from the browser, the MCP, upload links and scripts all go straight to
   R2 (the browser with a progress bar) and are never copied into Appwrite; a download's file is copied inside R2 to
   its Files key and its staging slot deleted. Deleting an R2 file deletes its bytes. Share links hand out hour-long
   presigned links on each visit, so they still stop working when the link does. Rows already in Appwrite keep
   working as they are; only `Passwords.docx` is left there, and it moves when Appwrite goes.
   **The storage budget**: `STORAGE_CAP_GB` (default 9.5) is checked before every upload starts; one that would take
   the bucket past it is refused with what fills it. The Files page shows the bucket against it.
2. **Data to Postgres on Neon** (project `plain-unit-11439440`, Singapore, branch `production`; Postgres, Object
   Storage and Realtime enabled; Better Auth, Functions and the AI Gateway left off: sign-in stays ours, code runs on
   Vercel / Workers). Why Neon over CockroachDB: real Postgres, an HTTP driver that works from Vercel and Workers
   without Hyperdrive, a branch per preview, and Realtime for the live board. The data is under 1 MB against 1 GB.
   **The limit to respect is compute: 100 CU-hours a month** (about 400 awake hours at 0.25 CU; it sleeps after 5 idle
   minutes and pauses until next month if the hours run out). So: compute capped at 0.25 CU, the sweep reads Postgres
   only when something is due, polling never touches it, busy reads are cached. Neon's object storage (5 GB) is the
   off-Cloudflare backup: nightly database dumps and a copy of `models/`.
   **Done (2026-10-30)**: all three services checked end to end from here (Postgres 18 answers; storage PUT/GET/DELETE;
   a Realtime subscription saw an insert 244 ms later, and a sealed query for a browser carries no secret). The schema
   is `mcp/db/001_workspace.sql` (the same four tables and columns as Appwrite, ids kept) and is applied on
   `production`. `lib/db.ts` holds the driver, `copyFromAppwrite()` (upserts every row, safe to run again) and
   `checkCopy()`; signed in, `POST /api/ws/db-copy` runs both and `GET /api/ws/db-check` compares (Appwrite today: 7
   posts, 1 comment, 708 activity, 1 media).
   **Dual writes (2026-10-30)**: an Appwrite webhook on `tablesdb.studio.tables.*.rows.*` (create, update, upsert,
   delete) posts every row change, from the browser or the server, to `/api/hooks/appwrite`, which mirrors it into
   Postgres; an older delivery never overwrites a newer row. The webhook's signing key is derived from
   `DATABASE_URL_POOLED` (`hookKey()` in lib/db.ts), so rotating the database password means setting the webhook's
   secret again. The same signed route runs the full copy (`{"op":"copy"}`) and the check (`{"op":"check"}`).
   **Next, before**: the owner adds `DATABASE_URL_POOLED`, `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` on Vercel; server
   writes go to both (Appwrite stays the source); the browser's `useLive` (components/aw.ts) moves to API routes plus
   sealed Realtime queries; run the copy, check it matches, then `DB_BACKEND=neon` switches reads. Sign-in stays on
   Appwrite until its own step.
3. **API and MCP to one Cloudflare Worker.** `/api/*` and the MCP run there, reaching CockroachDB through Hyperdrive.
   The long routes (starting the Colab GPU, copying downloads) become Queue jobs; a Cloudflare cron replaces
   `sweep.yml`. Vercel rewrites `/api/*` to the Worker so it stays one origin (cookies, the same-origin check and
   sign-in unchanged). MCP clients get the new address once.
4. **Appwrite off** after a week with nothing wrong. Vercel serves only the pages.
5. **Extras.** Trained voices backed up to a private Hugging Face repo; Google Drive for nightly backups and
   import/export.

## Not doing

- Files inside CockroachDB or Azure SQL: row size limits, no streaming or range requests, and the free request units
  would go on video bytes. Databases hold the file records; R2 holds the bytes.
- MEGA: no app-friendly API (S4 is paid), end-to-end encryption blocks streaming, and free downloads are capped.
- Several Cloudflare accounts to stack free tiers: against Cloudflare's terms, and a ban would take everything down.
  The $5 Workers Paid plan covers 10M requests if the free tier runs out.
