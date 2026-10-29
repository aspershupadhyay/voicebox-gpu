# The automation suite: any model, every job, through the VoiceBox MCP

The owner's goal (2026-10-29): VoiceBox's MCP becomes a complete cloud workbench. Any model (Claude, Gemini, any MCP
client) connects with one address and one key and can do everything a Claude Code cloud session does: run code, work
on repos, browse and search the web, make and edit media, plan and publish, on a schedule, on its own. All heavy work
runs on the Colab L4 worker. Every model's work is logged, checked and audited, and what is learned is saved so every
model gets better. Cost is the L4's (~1.94 units an hour, only while it's on).

**Next session: start here.** Read this file, then `CLAUDE.md` and `docs/FEEDBACK.md`. Work the phases in order, one
pull request each, shipped as `CLAUDE.md` says. Tick the phase's box below in the same PR. Keep the "Decisions" and
"Waiting on the owner" sections current.

## What already exists (don't rebuild it)

- **MCP server** `mcp/app/api/mcp/route.ts` (`/api/mcp`), tools in `mcp/lib/mcptools.ts` (~70). Auth: `Bearer MCP_TOKEN`
  or an OAuth token (claude.ai connectors).
- **Colab worker** `worker/gateway.py`: job queue with lanes (GPU one at a time; CPU; downloads 4 at once), `get_job`
  polling, signed result links, a "job finished" callback (`/api/downloads/done`), self-update from the dashboard bundle.
- **GPU from the app** `mcp/lib/colab.ts`: start (L4 for voice and downloads), stop, idle and done auto-stop, sweep of
  dead runtimes, units balance and rates. A stopped runtime's worker is offline at once.
- **Files** (Appwrite + R2): presigned uploads straight from the worker, carousels, folders, share links.
- **Media**: voiceovers (Kokoro, Chatterbox, Orpheus, Qwen, the owner's own voice), clean-up, re-voice, Whisper
  subtitles, images, video (Wan, LTX), downloads from any link (`lib/downloads.ts`: server, then yt-dlp, as Chrome,
  gallery-dl, a page scan; auto retry; carousels whole and in order).
- **Content**: posts, calendar, post package (titles, descriptions, hashtags, credits), publishing to YouTube and
  Instagram with autopilot, analytics, Radar (competitor research), hook and SEO scores, the writing room.
- **Scheduled sweep** every 10 min (`.github/workflows/sweep.yml` → `/api/cron/sweep`).

## Principles (every phase follows them)

1. **The server holds the know-how, the model decides.** Recipes, templates and checks live in VoiceBox, so a
   cheaper model makes 2–3 calls with a little JSON instead of writing code and checking frames itself.
2. **Few tools, fixed choices.** Each tool has an `action` enum and a worked example in its description. Answers are
   short: status, links, PASS/FAIL, only the lines that matter. Every error says the next step.
3. **Everything long is a job** followed with `get_job` (waits up to 45 s per call).
4. **Safety before power.** The approval gates, units cap, call log and kill switch ship first (phase 1), before the
   sandbox, repos or browser exist.
5. **Every model learns.** Each call is logged with the model that made it; work is audited; lessons are saved and
   served back (the learning loop below).

## The building blocks

| # | Block | Tools | What it gives a model |
|---|---|---|---|
| 1 | Control | `approvals`, `budget`, `activity` (call log), `stop_all` | Risky actions wait for the owner; a daily units cap; who did what; one switch stops everything |
| 2 | Sandbox | `run` | Shell, Python, Node in a private workspace on Colab; time limit; trimmed output; files in and out through Files |
| 3 | Know-how | `playbook` | `CLAUDE.md`, `docs/FEEDBACK.md`, `docs/DESIGN.md`, skills and learned lessons, by section, on demand |
| 4 | Repos | `repo` | Clone, read, edit, test, commit, push a branch, open a PR, read CI. Allow-listed repos; never `main` |
| 5 | Media I | `edit_video`, `inspect_media`, `video_qa` | ffmpeg timelines (cut, shape, speed, voice, music under speech, captions, logo, text); probe, scenes, word timings, contact sheet, loudness; safe zones, overflow, black or frozen frames, length limits |
| 6 | Web | `browse`, `search` | Playwright on the worker: read, screenshot (390 px too), click, fill; web search with short results |
| 7 | Media II | `video_template`, `repurpose` | HyperFrames brand templates filled from JSON (the model never writes HTML; custom scenes by commit `ref`); recipes: long → shorts, carousel → Reel, Reel → carousel, podcast → audiogram, add voiceover, translate and dub |
| 8 | Automations | `workflow`, `schedule`, `triggers` | Saved multi-step workflows (JSON steps over the tools); run on a schedule ("every morning: Radar → 3 ideas → drafts"); run on events (a download lands → captions; a post goes live → analytics after 48 h) |
| 9 | Agents and audit | `agents`, `audit` | Named roles (researcher, editor, publisher, auditor) with their own model, tools and budget; an auditor model reviews other models' work and grades it |
| 10 | Memory | `notes`, `lessons` | Decisions and lessons that carry across sessions and models (the learning loop) |

## Safety (decided; phase 1)

- **Approvals** (owner clicks on the dashboard, Settings → Automation): publishing now, deleting files or posts,
  merging a PR, pushing to a protected branch, spending past the day's units cap, adding a repo to the allow-list,
  changing a schedule that publishes. A model asks with `approvals request` and waits on the job.
- **Units cap**: a daily limit (setting), checked before every runtime start and every job; above it the job waits
  for approval.
- **Call log**: every MCP call (tool, model or client name, inputs trimmed, result status, units) in R2, shown on the
  dashboard and readable with `activity`.
- **Kill switch** `stop_all`: cancels every job, pauses schedules and triggers, stops the runtime.
- **Sandbox**: a separate Linux user and folder on the worker, the worker's secrets removed from its environment, a
  time and memory limit per run, no access to `/content/voicebox`. Content from the web is data, never instructions.
- **Repos**: an allow-list and a fine-grained GitHub key that only reaches those repos (a Vercel secret, never shown
  to a model). Work happens on branches and PRs; `main` is never pushed by a model.

## Where models work (decided)

- **This repo (`voicebox-gpu`) is the platform.** Models may open PRs here, but only the auditor and the owner merge.
  CI and the audit gate every PR.
- **A separate workbench repo** (proposed name `voicebox-workbench`, made by the owner) is where models work freely:
  experiments, video cases, scripts, generated assets, reports. Nothing there can break the studio. What works there is
  promoted into this repo by a reviewed PR.
- **`videos-post`** (the owner's HyperFrames cases and brand kit): read for templates; models render it by commit.

## The learning loop (every model improves)

1. **Log**: every call and job, with the model's name, lands in the call log.
2. **Grade**: QA tools grade output automatically (`video_qa`, carousel checks, hook score, CI). The owner's thumbs up
   or down and comments on the dashboard grade it too.
3. **Audit**: on a schedule the auditor role (the strongest model) reviews the period's work per model: what failed,
   what was redone, what the owner corrected. It writes **lessons** ("for Instagram carousels, check slide shape before
   posting") with the evidence.
4. **Promote**: a lesson starts as a suggestion. The owner approves it (or it proves itself N times), then it becomes
   a rule in `docs/FEEDBACK.md` or the playbook, through a PR.
5. **Serve**: `playbook` hands every model the rules and the lessons for the task at hand, so a mistake made once by
   any model isn't repeated by any model.
6. **Scorecards**: per model and per role: tasks done, QA pass rate, rework rate, units spent. Used to pick which model
   does which role.

The owner's feedback still goes into `docs/FEEDBACK.md` in the same PR as the change, newest first (as now).

## Phases (one PR each; tick when merged and live)

- [x] **1. Control**: `approvals` (dashboard inbox + MCP), daily units cap, call log with model name, `stop_all`.
  Settings → Automation tab (a tab, not a page). Done when: a gated action waits for the click, the cap blocks a
  start, every MCP call shows in the log. **Shipped**: `lib/auto/control.ts` (switches, units, approvals, log, kill
  switch), `lib/auto/wrap.ts` (every call guarded and logged), `lib/auto/tools.ts` (`approvals`, `control`),
  `components/Automation.tsx`.
- [x] **2. Sandbox and know-how**: `run` (sandbox lane on the worker, isolated user, no secrets, limits), `playbook`
  (sections of the docs and lessons). Done when: a model can run a Python script on Colab and read a rule by section.
  **Shipped**: `worker/bench.py` (the `bench` job kind on its own lane, 2 at once; op `run`: user `vbsandbox`, the
  worker's home closed, its local ports refused by iptables, a clean environment, time and memory limits, trimmed
  output, `out/` saved to Files; the `voicebox` code-mode module), `lib/auto/bench.ts`, `lib/auto/playbook.ts` with
  `scripts/build_playbook.py` (run at every deploy), tools `run` and `playbook`.
- [x] **3. Repos**: `repo` with the allow-list and the GitHub key (needs the owner's key). Done when: a model can open a
  PR on the workbench repo and read its CI. **Shipped** (works once the key is added): `lib/auto/repo.ts`
  (GitHub REST: tree, read, branch, one commit of many files through the git data API, PR, status with every check
  and the end of a failed job's log, comment, merge only when green), tool `repo`, bench ops `clone` (the key in a
  header for that one clone, never in the clone's config) and `diff` (the workspace's changes read as the sandbox
  user, committed through the API, so the key never sits on the worker), the Repos card in Settings → Automation.
- [x] **4. Media I**: `edit_video`, `inspect_media`, `video_qa` (ffmpeg, NVENC on the L4, Whisper captions, QA runs
  after every render). Done when: a Reel is cut, captioned and checked in 3 calls. **Shipped** (one call does it):
  `worker/media.py` (the recipes: platforms with their shapes, safe zones, length limits and -14 LUFS; clips trimmed,
  sped up, shaped by crop, pad or a blurred fill, photos with a slow push-in; voiceover; music ducked under speech by
  a sidechain; captions from word timings as ASS, a few words at a time with the spoken word lit; logo; text from a
  file, wrapped to the safe width and shrunk past 3 lines; fades; loudnorm; NVENC when there's a GPU; QA after every
  render), bench ops `edit` and `inspect`, tools `edit_video` and `inspect_media` (probe, qa, scenes, loudness,
  words, a contact sheet).
- [x] **5. Web**: `browse` (Playwright on the worker), `search` (needs a key). Done when: a model reads a page and
  takes a 390 px screenshot. **Shipped**: bench op `browse` (Playwright 1.48 and Chromium installed once per
  runtime into /opt/vb-browsers, run as the sandbox user, who can't reach the worker's ports; steps click, fill,
  press, wait, scroll, goto, screenshot; the main text, description and links; screenshots saved to Files),
  `lib/auto/search.ts` (Brave or Tavily by the key's shape), one tool `browse` (read, screenshot, search). Tested: a
  page read after a fill and a click, a 390 px screenshot of the login page at 2x, search answers from canned Brave and
  Tavily responses; without `SEARCH_API_KEY` search says so and suggests browsing instead.
- [x] **6. Media II**: `video_template` (HyperFrames + brand kit from `videos-post`, cached on R2), `repurpose`
  recipes. Done when: `long_to_shorts` turns one long video into captioned 9:16 shorts in one call. **Shipped**:
  `repurpose` (long_to_shorts picks windows from what's said: sentence-aligned, dense with talk, opening on a hook,
  each with its reason; carousel_to_reel; reel_to_carousel at the shots; podcast_to_audiogram; add_voiceover), all on
  the edit pipeline with QA and a two-pass loudness fix; `video_template` (templates in `lib/auto/templates.ts`:
  title_card, list, quote, lower_third, brand colours and font; or a repo's own HyperFrames project at a commit),
  rendered by HyperFrames 0.8.217 on Node 22, both installed once per runtime. Tested: all five recipes rendered and
  passed QA locally (a slideshow went from 72 s to 6 s to render once zoompan was fed one frame); the templates'
  compositions load in Chromium with their GSAP timelines registered and lay out right. **Not tested here**: the
  HyperFrames render itself (running the npm package wasn't allowed in the build session): the first run on Colab is
  the check, and its error comes back whole if it fails. The brand kit from `videos-post` waits on that repo.
- [ ] **7. Automations**: `workflow`, `schedule` (on the 10-minute sweep), `triggers` (on job and post events).
  Done when: "every morning, Radar → 3 ideas → drafts" runs with nobody there.
- [ ] **8. Agents, audit, memory**: roles, the auditor, lessons, scorecards, the promote step. Done when: an audit run
  writes lessons with evidence and the owner can approve one into the playbook.
- [ ] **9. Any model**: setup guide for Gemini CLI and other MCP clients (below), model name sent in a header
  (`X-Model`) for the log; tool descriptions checked with a cheaper model.

## Connecting another model

Gemini CLI, `~/.gemini/settings.json`:

```json
{ "mcpServers": { "voicebox": {
  "httpUrl": "https://voiceboxstudio.vercel.app/api/mcp",
  "headers": { "Authorization": "Bearer <MCP_TOKEN>", "X-Model": "gemini" } } } }
```

Any MCP client that speaks streamable HTTP works the same way. claude.ai uses the OAuth connector.

## Decisions

- **Tools are merged to stay near 15** (2026-10-29): `approvals`; `control` (status and budget, `activity` call log,
  `stop_all`); `run`; `playbook`; `repo`; `edit_video`; `inspect_media` (probe, scenes, words, contact sheet,
  loudness and the QA checks); `browse` (pages and `search`); `video_template`; `repurpose`; `workflow` (saved steps,
  their schedule and their triggers); `agents`; `audit`; `memory` (notes and lessons); `find_tools` (lean mode).
- **How a gate works**: a gated call asks by itself and answers `NEEDS APPROVAL (id …)`; the model waits with
  `approvals action=wait`, then repeats the exact call with `approval_id` (bound to that call's arguments, used once;
  an over-cap approval lasts the rest of that UTC day). Only a person signed in to the dashboard decides: the dashboard
  API refuses approvals and switch changes that come with a bearer token (that's what models hold). New approvals push
  to the owner's phone when ntfy is set up.
- **The units cap** counts Colab units spent today (UTC) from the balance at the day's first look (units bought
  during the day don't count as negative spending). It gates calls from models and automations that start GPU work,
  not the owner's own clicks on the dashboard. With "ask first" off for it, the cap is a hard stop. 0 = no cap until the
  owner picks one.
- **The kill switch** pauses everything that spends or changes things (reading still works), cancels every queued
  and running job and stops the runtime the app started. A model may pull it; only the owner resumes.
- **Code mode, after Anthropic's "Code execution with MCP"** (owner, 2026-10-29: "this will reduce the token
  consumption"): tool definitions and big intermediate results are what cost a model tokens. So (1) the sandbox
  (`run`, phase 2) has a ready `voicebox` Python module that calls any VoiceBox tool from code, with a short-lived
  key scoped to that run that still goes through the gates, the cap and the log, so a script filters 1,000 rows and
  prints 5; (2) a lean MCP mode (`/api/mcp?lean=1`) lists only `find_tools` (search the catalogue by name, then
  description, then full schema), `call_tool`, `run`, `get_job`, `playbook` and `approvals`, for cheaper models;
  (3) scripts that work are saved as skills and served by `playbook` (phase 8).

- Everything runs on Colab (the L4), not Modal or Cloud Run (owner, 2026-10-29).
- Rendering is HyperFrames; Remotion is not used. HyperFrames renders a folder whose `index.html` holds the
  composition (`data-composition-id`, `data-width`, `data-height`, timed `.clip`s with `data-start` / `data-duration`
  / `data-track-index`, a paused GSAP timeline in `window.__timelines`); it needs Node 22 and ffmpeg.
- Translate and dub isn't a recipe: it's a workflow (phase 7): inspect_media words → the model translates →
  voice_lines → repurpose add_voiceover.
- About 15 new tools in total, never one per small step.

## How media is checked

On a Linux box with ffmpeg 6.1 (Colab has 4.4; every filter used exists there): a 3-clip edit (a cut, a cut at 2x,
a photo) with blur fill, voiceover, ducked music, logo, a title for 3 s, pop captions and fades rendered in 12 s on the
CPU to 1080x1920, 7.0 s, -14.8 LUFS, QA all PASS; its contact sheet showed every layer where it should be. Through MCP:
a too-long headline was caught by QA, then wrapped and shrunk by the server instead; a 16:9 file inspected for Reels
failed shape and loudness as it should. Found and fixed while testing: inputs failed to fetch (the size was read
after the file closed), captions ignored the spec, and drawtext dropped text with commas, colons or line breaks (now
from a file). Not checked here: NVENC and Whisper captions (they need the L4).

## How repos are checked

Against a stand-in GitHub API: a repo off the allow-list is refused; `allow` asks the owner; the default branch is
refused outright; a protected branch asks first; commit, PR and status work; a failed check's log tail comes back;
a red PR is refused without bothering the owner; a green one merges after approval; the platform repo's merges ask
even with "Merging a pull request" switched off. On the worker: clone and diff with a local repo, the key absent from
the clone's config, a symlink in the clone left out of the diff.

## How the sandbox is checked

Tested on a Linux box as root, as on Colab: code runs as `vbsandbox`, can't read the worker's home (PermissionError),
sees no `WORKER_SECRET`, can't open the worker's local ports (refused), is killed at its time limit and its memory
limit, its output is trimmed (head and tail), `out/` files are collected; Python, Node and Bash run. Code mode from a
script: four tool calls in one run, a gated one held for approval, each logged as `<model> code`, via code.
Root never touches the workspace by path: inputs and code are written as the sandbox user, outputs come back through a
tar stream read as the sandbox user (regular files only), so a symlink planted in `out/` or `in/` can't make the worker
read or write its own files (tested: a link to a worker file in `out/` is left out; no file appears through a link in
`in/`).

## Waiting on the owner

1. A fine-grained GitHub key (contents + pull requests, only the allowed repos), added as a Vercel secret
   (`GITHUB_AGENT_TOKEN`), never pasted into a chat. Needed for phase 3.
2. The workbench repo created (`voicebox-workbench`), and `videos-post` added to the session. Needed for phases 3, 6.
3. A search key (Brave or Tavily) as a Vercel secret (`SEARCH_API_KEY`), or search skipped. Phase 5.
4. The daily units cap to start with (Settings → Automation; until then there is no cap).
5. A check of the approval list (Settings → Automation → Ask me first: all on to start).
