# Working in this repo

## Shipping (standing instruction from the owner)

Always ship finished work: commit, push the branch, open a pull request to `main`, and merge it once checks pass.
Merging to `main` makes it live: `.github/workflows/deploy.yml` builds `mcp/` (dashboard + MCP server) with OpenNext
and deploys it to Cloudflare Workers (the `voicebox-studio` Worker; moved off Vercel on 2026-10-30, docs/MIGRATION.md).
The address is https://voiceboxstudio.pages.dev: a Pages project whose `_worker.js` hands every request to the Worker
(a service binding), so the URL stays short until a custom domain replaces it, with the worker bundle that Colab pulls. Settings and keys live on the Worker
(`npx wrangler secret put`), never in git. After merging, check the Deploy
run succeeded and say so. A restarted Colab worker picks up `worker/` changes.

## The owner's feedback (read first)

`docs/FEEDBACK.md` keeps every piece of design and product feedback the owner has given, newest first, and it wins over
older rules. Read it before any dashboard work. Whenever the owner gives new feedback, add it there in the same pull
request as the change, so the next session doesn't repeat the mistake.

## Videos

Reels and Shorts follow `docs/REELS.md` (the owner's rules: a viral-style hook, informative not slop, the house look,
and the voice → animation → Files pipeline).

## Design

Every dashboard change follows `docs/DESIGN.md`. In short:

- Clean product UI, matte black only (the owner's call): pure black sidebar and canvas, sharp cards with hairline
  borders, white primary buttons, soft tinted status pills, small animated pixel accents for warmth. Flat: no gradients
  anywhere (the owner's call), including the logo; the hatched KPI bars are stripes, not gradients.
- Geist only (Mono for moving numbers). Every page opens with `PageHeader` (the page name as the H1, one sub line).
- Build from `components/ui.tsx`; every text colour is a token at 4.5:1 or better; every control has a label.
- Two modes, switched at the top of the sidebar: Create (Home at `/home`, Voices, Posts, Files, Voiceover,
  Clean-up/Subtitles/Images, Download) and Grow (analytics under `/analytics`: Overview, Live, Content, Audience, When to post,
  Competitors, Radar, YouTube, Instagram, pinned rivals). The studio opens on Grow. Search and Settings are at the top right;
  the GPU lives only in Settings → GPU & engines. Making a voice lives under Voices (`/voices/new`, `/voices/professional`, `/voices/revoice`).
- Never a native `<select>`: use `Select` from `components/pop.tsx`. Every popup closes on Escape and a click outside.
  New capabilities become views or tabs, not new pages. Pages rise in; only live things loop.

Check dark (the only theme) and 390px width before you ship.

## The automation suite

The MCP is a cloud workbench any model (Claude, Gemini…) can drive: approvals, units cap, call log and kill switch
(`lib/auto/control.ts`, `wrap.ts`: every tool call goes through them), a sandbox with code mode (`worker/bench.py`),
repos, media recipes (`worker/media.py`), the browser, templates, workflows, roles, the audit and lessons, projects
(`lib/auto/projects.ts`), and one adaptive endpoint (`lib/auto/endpoint.ts`: a 10-tool core (with `import_file` for ChatGPT), toolsets on demand,
strict schemas for non-Claude clients; `/api/mcp/lean` is its alias). All nine phases shipped; `docs/AUTOMATION.md` has the decisions, what's waiting on the
owner and what still needs checking on Colab: read it before working on any of it. What's next is `docs/FACTORY.md`
(the video factory: fixes from the audit, projects that own and clean their files, one adaptive endpoint, batches,
many agents at once), in order. A new tool goes in
`lib/auto/tools.ts` with an action enum and a worked example (`scripts/check_tools.py`); anything risky gets a gate in
`wrap.ts`.

## Where things run

Done moving (2026-10-31, `docs/MIGRATION.md`): the app on a Cloudflare Worker, files in R2 (the Worker reads it through its
`BUCKET` binding, `lib/store.ts`), posts, comments, activity, file rows and accounts in Postgres on Neon (`lib/db.ts`,
`lib/data.ts`, `lib/users.ts`), backups in Neon storage, deploys from GitHub. Appwrite and Vercel are not used by any
code. The trained voices in R2 (`models/`, `datasets/`) are never touched.

## Inference work

Speed-ups for the voice engines follow `docs/INFERENCE.md` (the plan, in order, with its rules: behind a flag, works
on L4 and A100, measured before and after on a real GPU, same review scores). Tick `docs/ROADMAP.md` → Inference.

## Security

- The dashboard is invite-only: see `mcp/lib/access.ts` and `mcp/lib/session.ts`.
- The MCP (`/api/mcp`, `/api/mcp/lean`, `lib/auto/auth.ts`) takes `MCP_TOKEN`, OAuth access tokens, model keys
  (`vbmk_`, `lib/auto/keys.ts`, made and revoked only by a signed-in person, MCP only) and code-mode run keys.
- Tool keys (GitHub, search) pasted in Settings → Automation → Keys live encrypted in R2 (`lib/auto/secrets.ts`): never
  return one to the browser or a model, and only a signed-in person sets them.
- Never add a route without `isAuthed(req)` (worker routes use `WORKER_SECRET`; `/api/cron/live` also takes the
  Cloudflare live timer's secret, kept only as a SHA-256; `/api/files/upload`, `/complete` and `/api/files/carousels` also take an
  upload key, which can save files and arrange carousels and nothing else: no reading other files, no deleting). The
  share page `/s/<token>` is public by design (lib/shares.ts): it shows only what one unexpired, unrevoked link names,
  read-only; the token is kept only as a SHA-256 and files are served by hour-long R2 links made on each visit.
  `/api/files/put/<ticket>` is public by design too: the ticket (HMAC-signed, one hour, one file, its size and type)
  is the claim; it takes one PUT of that file's bytes into its R2 key and reads or lists nothing.
  An upload link `/u/<token>` (and `/api/u/<token>`, lib/auto/uplinks.ts) is public by design too: a signed, expiring
  claim that can only start and finish uploads into its one folder, up to its file cap; it reads and lists nothing.
  A Files upload is served by `/api/m/<token>/<key>` (lib/r2files.ts), public by design: the token is an HMAC of the
  key kept only in team-only rows, and it serves `workspace/media/` and nothing else.
  The browser reads and writes rows through `/api/ws/rows` and watches them through sealed Neon Realtime queries from
  `/api/ws/live` (signed-in only; the query is built on the server from allowed columns, the Realtime secret never
  leaves it). `/api/login` checks email and password against Postgres (`lib/users.ts`: scrypt hashes, the same lockout
  and invite list); the password is never stored, only its hash. Settings → Security sets a password (signed-in only):
  your own with the current one, or a teammate's that has none yet, never replacing someone else's. `/api/cron/sweep`,
  `/api/cron/backup` and `/api/cron/live` take `WORKER_SECRET`, `CRON_SECRET`, the Cloudflare timer's secret (kept as a
  SHA-256), or GitHub's OIDC token for `sweep.yml` on main
  (`lib/cronauth.ts`: signed by GitHub, audience `voicebox-cron`, this repository's workflow only).
- Never loosen the allow-list, the same-origin check or the session expiry.

## Checks before pushing

- `cd mcp && npx tsc --noEmit` and `npx next build` (and `npx opennextjs-cloudflare build` for anything runtime-sensitive:
  Workers forbid code generated at run time and native modules such as sharp)
- `cd mcp && npx -y tsx scripts/check-register.mts` for any tool change: every tool registered and its schema
  converted as clients get it (a throw there is a dead MCP in production; #131 shipped one)
- `python3 -m py_compile worker/*.py` for worker changes

## Secrets

Never commit keys. `.env*`, `.secrets.local` and `.local/` are gitignored; ElevenLabs keys live in `.env.local`
(`ELEVENLABS_API_KEYS`, comma-separated, used by `scripts/elevenlabs-longform.py`).
