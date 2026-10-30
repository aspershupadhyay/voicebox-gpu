# The automation suite: any model, every job, through the VoiceBox MCP

The owner's goal (2026-10-29): VoiceBox's MCP becomes a complete cloud workbench. Any model (Claude, Gemini, any MCP
client) connects with one address and one key and can do everything a Claude Code cloud session does: run code, work
on repos, browse and search the web, make and edit media, plan and publish, on a schedule, on its own. All heavy work
runs on the Colab L4 worker. Every model's work is logged, checked and audited, and what is learned is saved so every
model gets better. Cost is the L4's (~1.94 units an hour, only while it's on).

**Next session: start here.** All nine phases shipped on 2026-10-29/30 (PRs #118-#126). What's left is checking the
parts that need the L4 or the owner's keys on the real thing (see "Still to check on Colab" and "Waiting on the
owner"), fixing what that turns up, and the owner's next ideas. Read `CLAUDE.md` and `docs/FEEDBACK.md` first; keep
"Decisions" and "Waiting on the owner" current.

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
  Tavily responses; without a search key search says so and suggests browsing instead.
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
- [x] **7. Automations**: `workflow`, `schedule` (on the 10-minute sweep), `triggers` (on job and post events).
  Done when: "every morning, Radar → 3 ideas → drafts" runs with nobody there. **Shipped**: `lib/auto/flows.ts` and
  one tool, `workflow` (save, run, runs, stop, enable, disable, delete, examples). Steps call tools in-process through
  the same guarded path as a model (logged as `workflow:<name>`, via workflow; capped; paused by the kill switch;
  gated steps park the run until the owner decides). `{{steps.<as>.<path>}}`, `{{input}}`, `{{event}}`, `{{today}}`;
  `foreach` with `limit`; `if`; a step that starts a job parks the run until it's done. Schedules (hour, day, week,
  a time zone) start on the 10-minute sweep, which also carries every open run on; triggers `download.done`
  (lib/downloads.ts) and `post.live` (lib/publish/run.ts) with `delay_h` and `match`. Examples: `morning_ideas`
  (Radar → 3 idea drafts, 07:30 Kolkata), `check_downloads`, `check_after_48h`, `translate_and_dub`. A schedule or
  trigger on steps that publish needs the owner's approval to save or switch on; a workflow can't start workflows.
  Settings → Automation → Workflows: each one, when it runs, its last run, Run and on/off, recent runs with Stop.
- [x] **8. Agents, audit, memory**: roles, the auditor, lessons, scorecards, the promote step. Done when: an audit run
  writes lessons with evidence and the owner can approve one into the playbook. **Shipped**: `lib/auto/agents.ts`
  (roles researcher, editor, publisher, auditor with their tools, enforced when a client sends `X-Role`; scorecards per
  model and role from the call log: calls, worked, QA pass rate, redos, approvals hit; the rule-based audit: the same
  error 3+ times, the same QA check failing, the owner's refusals, the same work sent again, each a suggested lesson
  with evidence; `packet` for an auditor model), `lib/auto/memory.ts` (notes by key; lessons suggested → kept →
  "Make it a rule", a PR adding it to `docs/FEEDBACK.md`; skills: saved scripts `run` imports), tools `agents`,
  `audit`, `memory`; `playbook` search serves kept lessons and skills; the call log keeps each call's role and QA
  verdict; a `nightly_audit` example workflow; Settings → Automation → Lessons and Scorecards.
- [x] **9. Any model**: setup guide for Gemini CLI and other MCP clients (below), model name sent in a header
  (`X-Model`) for the log; tool descriptions checked with a cheaper model. **Shipped**: the lean endpoint
  `/api/mcp/lean` (`lib/auto/lean.ts`: `find_tools` names → summary → JSON schema, `call_tool` guarded and logged
  as `via: lean`, plus `run`, `get_job`, `playbook`, `approvals`), measured: 84 tools in ~30,100 tokens of
  definitions on the full endpoint, 6 tools in ~1,700 on the lean one (94% less, every session); `X-Model` and
  `X-Role` in the log and the scorecards; Settings → Claude & API → Other models writes a client's settings (lean or
  full, its name, its role) and makes a **model key** for it (`lib/auto/keys.ts`, `vbmk_…`: shown once, kept as a
  SHA-256, names the model in the log over any `X-Model`, can be held to a role, also inside its code-mode scripts,
  revoked at once, opens the MCP only; making one never touches `MCP_TOKEN`, so nobody is signed out); `scripts/check_tools.py` checks every description (size, a
  worked example, a fixed action list) and the context they cost. The check by a cheaper model is the owner's
  (paste a description into Gemini Flash, ask it to make a call; see the script's header).

## Connecting another model

Settings → Claude & API → Other models: name the model, pick a role (optional), **Make a key**, copy the settings
(the key is in them). Gemini CLI, `~/.gemini/settings.json`, then `/mcp` in Gemini to check:

```json
{ "mcpServers": { "voicebox": {
  "httpUrl": "https://voiceboxstudio.vercel.app/api/mcp/lean",
  "headers": { "Authorization": "Bearer vbmk_…" } } } }
```

`/api/mcp/lean` lists six tools and finds the rest with `find_tools` (for cheaper models and long sessions);
`/api/mcp` lists all of them. The key names the model in the call log and the scorecards and holds it to its role
(`agents`). `MCP_TOKEN` still works, with `X-Model` and `X-Role` headers, but give each model its own key instead. Any MCP client that speaks streamable HTTP works the same way. claude.ai uses
the OAuth connector (full endpoint).

## Still to check on Colab (the build session had no GPU and couldn't run some packages)

1. The sandbox's iptables rule and `vbsandbox` user on the real runtime: a `run` answer lists its isolation.
2. NVENC renders and Whisper captions in `edit_video` and `repurpose` (they fell back to x264 and given words here).
3. Playwright's `install --with-deps chromium` on Colab (here the pre-installed Chromium was used).
4. HyperFrames: the first `video_template` render installs Node 22 and HyperFrames; if it fails, the whole error
   comes back. Running the npm package wasn't allowed in the build session, so this is its first real test.
5. Saving `out/` files, renders and screenshots into Files (the worker only pushes to https, i.e. R2; locally the
   storage stand-in was http).
6. `morning_ideas` against the real Radar and board (save it: `workflow action=save example=morning_ideas`).

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

## How workflows are checked

Locally, with nobody at the keyboard after the first call: a 6-step run carried a search's result into code by
template, probed two files in a foreach, parked on a 50 s job, was carried on by the sweep, skipped a step on `if`,
then parked on a gated step until the owner approved it and finished. Schedules: 07:30 Kolkata came out 02:00Z,
Friday 18:45 New York 22:45Z (summer time), hourly at :20; one forced due fired on the sweep. A trigger with
`match {source: instagram}` started for an Instagram download and not for a YouTube one. A scheduled workflow that
publishes asked for approval; one that calls `workflow` was refused; the dashboard's Run / on-off refused a bearer
token. Found and fixed: a run out of time mid-job said "running" instead of "waiting".

## How the learning loop is checked

Locally: a model's 3 identical failures, two files failing QA on shape and loudness, and an approval the owner denied
with a note became 4 suggested lessons with evidence; a second audit over the same hours added nothing (fixed: it
counted them seen again); a kept lesson came back in `playbook` search and in the editor's brief; a researcher's
`edit_video` was refused, its playbook call went through; a saved skill imported in a run (fixed: the workspace
wasn't on Python's path); "Make it a rule" opened a PR adding the lesson under "Lessons from the models" (fixed: a
branch with a / in its name was sent as %2F to GitHub; newer lessons went above the section's line).

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

1. A fine-grained GitHub key (Contents, Pull requests, Issues read and write; Checks and Actions read; only the
   allowed repos), pasted in Settings → Automation → Keys (or `GITHUB_AGENT_TOKEN` on Vercel), never into a chat;
   then the repos on Settings → Automation → Repos. Until then `repo` and "Make it a rule" say so.
2. The workbench repo created (`voicebox-workbench`) by the owner on github.com (the session's GitHub app can't
   create repos), and `videos-post` added to the key. Needed for phases 3, 6.
3. Optional: a search key (Brave or Tavily) in Settings → Automation → Keys (or `SEARCH_API_KEY` on Vercel), only for
   scheduled workflows and sandbox scripts (chat models search the web themselves); until then `browse action=search`
   says so.

Keys pasted in the dashboard (`lib/auto/secrets.ts`) are kept in R2 encrypted with AES-256-GCM under a key derived
from `MCP_TOKEN` (rotating it asks for them again), shown back only as their last 4 characters, saved and removed only
by a signed-in person, and never given to a model: tools use them server side. They win over the Vercel variables.
4. The daily units cap to start with (Settings → Automation; until then there is no cap).
5. A check of the approval list (Settings → Automation → Ask me first: all on to start).
