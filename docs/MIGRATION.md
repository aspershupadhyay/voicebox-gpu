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

0. **Stop the waste** (this PR). Hidden tabs no longer poll: the shell's status every 15 s (was 6 s, in every tab),
   GPU jobs 5 s (3 s), Home 8 s (4 s), the job tray 5 s (4 s), all paused while the tab is hidden. The sweep stays every
   10 min because it also runs the publishing autopilot (slots must not slip). Still to do: clearing the R2 copies
   and cache above (needs the owner's go-ahead for each delete) and lifecycle rules on `cache/` and the trash.
1. **All files to R2.** Prefixes `media/`, `models/`, `cache/` (expires), `trash/` (30 days). Uploads go straight to
   R2 in parts, up to 2 GB. Share links become presigned R2 URLs that expire with the link. A script copies every
   Appwrite file and checks counts and checksums; Appwrite stays the fallback until they match.
2. **Data to CockroachDB** (Basic tier, cluster `9f03fe46-842e-439e-ac3a-e33fce750382`, SQL user `catch`). Tables for
   posts, files, folders, shares, publishing, analytics and access; one module in `lib/` replaces the ~17 files that
   call Appwrite. Export, load, compare, then switch reads. The $400 trial credit covers test runs; the app must run
   on the free tier without it.
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
