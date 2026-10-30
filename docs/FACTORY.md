# The video factory: faster, leaner, many agents at once

The owner's goal (2026-10-30): the automation suite (docs/AUTOMATION.md, all nine phases shipped) becomes a factory.
Five or twenty videos should take about as long as one. Claude, Gemini, OpenCode and other people can work at the same
time without wasting the GPU, tokens or each other's work. Every agent cleans up after itself. This is the plan, in
order. Each phase ships as its own PR and is checked on the real Colab L4 before it's ticked.

## What the ChatGPT audit found, checked against the code

| Finding | Verdict | Cause in our code | Fix (phase) |
|---|---|---|---|
| `run lang=node` fails: no `node` | **True** | `worker/bench.py` installs Node 22 in `/opt/vb-node` only for templates; `LANGS["node"]` calls a bare `node` that isn't on the sandbox's PATH | put `/opt/vb-node/bin` on the sandbox PATH, install on first use, add `npx` (A) |
| No HyperFrames CLI (check, snapshot, preview) | **True** | only `render` is wired (template op); the project's pinned version (videos-post pins 0.8.192, we install 0.8.217) is ignored | CLI available in `run`, version read from the project's `package.json` (A) |
| Generic `list` template: ~3 s black opening, no audio | **True** | `lib/auto/templates.ts` loads Google Fonts with `display=block` and GSAP from a CDN at render time; there's no sound bed | fonts and GSAP served from the worker's cache, a music bed option, motion from frame 0 (A) |
| Renderer PASS but the inspector found frozen stretches | **True and important** | `list` holds still between items; a renderer's PASS only means it rendered | something moves at least every 2 s in every template; `inspect_media` becomes a required second gate (A, E) |
| Clean-up self-check: `socket.gaierror` (DNS) | **Unverified** | the self-check fetches a sample or a model over the network; the browser could reach the web, so it's one path, not all networking | find the host it calls, add a retry and a cached copy (A) |
| `repo checkout` by short commit hash fails | **True** | checkout takes branch names only | resolve a sha (short or full) to a commit (A) |
| Lean endpoint not tried | n/a | it exists (`/api/mcp/lean`); `docs/AUTOMATION.md` still mentions an old `?lean=1` form | replaced by one adaptive endpoint (C) |
| WAN, LTX, animate, NVENC, batches untested | **True** | built, never measured end to end on the L4 by a model | a benchmark pass with numbers in this doc (F) |

ChatGPT's own conclusion holds: the gap isn't missing tools, it's that the sandbox, the renderer and the pipeline aren't
one environment yet, and nothing runs videos as a batch.

## What Gemini's post-mortem found (Case 027), checked against the code

Gemini made Case 027 end to end through the MCP and wrote a "10× speedup" post-mortem. Verdicts:

| Claim | Verdict | What's really going on | Fix (phase) |
|---|---|---|---|
| Assets make a 6-step round trip (ticket → upload → complete → signed URL → download) | **True, partly by design** | an image made on the model's side has to reach Colab somehow; the worker's tunnel serves jobs, not files (the 501) | make images on the worker (`imagine`) or in the sandbox so they never leave it; a project workspace on the worker holds drafts, and only keepers go to Files at `finish` (B, D). One presigned PUT when a file must come from outside |
| Shared FUSE/S3FS/SSHFS mount between the model's computer and Colab | **Rejected** | it would expose the worker and storage to the model's machine and break on Colab restarts | the project workspace above does the same job safely |
| Inconsistent ids and parameters (`get_file` wants `file_id`, `upload_media` returns `id`, `delete_media` rejects `m:`, `add_media` wants a URL) | **True** (`lib/mcptools.ts`) | tools grew one at a time | one id shape everywhere: every tool accepts `m:x` or `x` and takes a `file_id` wherever it takes a `url` (A) |
| Node not on PATH in `run` | **True** (same as the ChatGPT finding) | see above | (A) |
| GitHub 403 pushing to `videos-post` | **True, a key setting** | the owner's GitHub key has write access to the workbench, not to `videos-post` | the owner adds Contents + Pull requests write for `videos-post` to the key if models should open PRs there |
| Deleting a 1-pixel scratch file waited for approval | **True** | blanket `delete` gate in `lib/auto/wrap.ts` | projects own their files (B) |
| One pipeline command instead of six scripts | **Agreed** | the case scripts (`prep_audio`, `build_scenes`, `make_cues`…) run by hand | a `pipeline` op (D): one spec in, a draft and a QA report out, each step cached and re-run only when its inputs change |
| A pre-baked Docker image | **Not possible on Colab** (it doesn't run custom images) | | a cached toolchain bundle (Node, Chromium, HyperFrames, Remotion, fonts) restored at boot from R2 in seconds (G) |
| Put `VOICEBOX_UPLOAD_TOKEN` in the worker's `/etc/environment` | **Rejected** | the sandbox must never hold a key; its run key already saves files | none |
| Taste and psychology checks at the script step | **Agreed** | weak scripts are only caught after a render | a `script_check` before any voice job: hook length, banned openers, spine, word count, numbers on screen, the ending (D) |
| Ban "Seen a clip like this? Send it our way" and end on an identity line ("The industry sells you the score. We check the grader.") | **The owner's call** | that ending is the owner's own rule 13 in `videos-post/CLAUDE.md`; Gemini wants to replace it | A/B both endings on the next two posts, then keep the winner (owner decides) |
| 45 min → 4–5 min per video | **Too optimistic** | one HyperFrames render already took ~125 s on the L4; voice, QA and the owner's checkpoints add up | measure in F; our target is a single video in ~10–12 min and a batch of 5 in under 2× that |

## G. The motion toolkit (Apple-level editing)

Everything a top motion editor reaches for, installed once, cached, and loaded into a model's context only when it
needs it (the skill is fetched from `playbook`, not pasted into every session).

- **Code-to-video renderers**: HyperFrames (pinned per project), **Remotion** (React; official agent skills since
  January 2026; free for individuals and companies of up to 3 people, otherwise a company licence: the owner
  confirms), **Revideo** (MIT, headless, made for pipelines). One `render` op picks by the project's `package.json`.
- **Motion**: GSAP (check the current licence when installing), Lottie (`lottie-web`, dotLottie), Three.js for 3D
  shots, Manim for explainer diagrams.
- **Editing and finishing**: ffmpeg with NVENC, `auto-editor` (silence and dead-air cuts), PySceneDetect (shot
  lists), Whisper word timings (already in), `rembg`/SAM 2 (cut-outs), Real-ESRGAN (upscaling stills), RIFE (smooth
  slow motion), LUT grading (`videos-post` has LUTs), planar tracking (`videos-post/tools/track_plane.py`).
- **Skills served on demand**: `videos-post/.claude/skills` (hyperframes, apple-film-moves, media-use) and Remotion's
  skills indexed in `playbook`, so `playbook search "label pinned to a surface"` returns the right page and only that.
- **Proof**: one short test shot per tool on the L4, with its time and a frame in this doc. A tool that doesn't
  work is left out of the list instead of left broken.

## H. Works with every AI tool, including ChatGPT (and image uploads from there) ✅ shipped (with C)

**Done (2026-10-30)**:
- [x] Schemas every client accepts: clients that aren't Claude (by user agent or X-Model), or `?schema=strict`, get a
  strict subset: no `$schema`, `anyOf`, `oneOf`, `const`, `propertyNames`, empty `additionalProperties`; one type per
  field (a number-or-text union becomes text, and the tools take a number written as text). All 90 tools pass the
  subset check in `scripts/check-register.mts`. Claude keeps the full schemas.
- [x] `readOnlyHint` / `destructiveHint` / `openWorldHint` on every tool (reads, the five deletes, the web).
- [x] `upload_link`: a page at `/u/<token>` (a signed claim: one folder, usually a project's, 1-72 h, a file cap) where
  the user drops images from any phone or app; files go straight to R2 and land in the folder, recorded as the
  project's. Public by design like a share link, and it can only upload into that one folder. Checked: a bad token
  and a used-up link are refused; screenshots at 1280 and 390 px.
- [x] `import_file` with `_meta["openai/fileParams"] = ["file"]`: ChatGPT hands an attachment as
  `{download_url, file_id}`; any client can pass a `download_url`.
- Test matrix (what's proven): **Claude Code** against the live MCP (this session); core, load, full, lean, strict,
  hints and the notification over HTTP on a local build. **Needs the owner** (a client signed in as them): claude.ai
  (OAuth connector), Gemini CLI (`httpUrl` + a model key), ChatGPT developer mode (Settings → Connectors → Advanced;
  OAuth through `/api/oauth`; whether chat attachments reach `import_file` is the open question), OpenCode and Cursor
  (`npx mcp-remote https://voiceboxstudio.vercel.app/api/mcp --header "Authorization: Bearer vbmk_…"` for clients
  without remote MCP).

- **Schemas every client accepts**: our tool schemas include `$schema`, `anyOf` (e.g. `from` is an integer or a
  string) and `propertyNames`. Gemini rejects these (third-party reports; it follows an OpenAPI 3.0 subset), and other
  clients differ. Emit a safe subset (one type per field, no `$schema`), and check every schema in
  `scripts/check_tools.py`.
- **Test matrix**: claude.ai, Claude Code, Gemini CLI, ChatGPT (developer mode: OpenAI documents it for Business and
  Enterprise, guides report Plus and Pro, and Go is unconfirmed, so the owner checks for the toggle under Settings →
  Connectors → Advanced), OpenCode, Cursor. Clients without remote MCP get a stdio bridge (`npx mcp-remote <url>`).
  ChatGPT needs OAuth; check our `/api/oauth` with its connector flow.
- **Images from ChatGPT (or any chat app)**:
  1. `upload_link` tool: answers with a one-time page on the dashboard. Open it on a phone or computer, drop the
     images, and they land in the project's folder. Works from any app.
  2. ChatGPT's Apps SDK `openai/fileParams` on an `import_file` tool, so ChatGPT hands an attached file to the tool
     as a download URL (whether chat attachments reach a tool is unclear in OpenAI's forums: test it).
  3. `add_media` with a URL, as today.
- **Fewer tokens in every client**: short descriptions (what it does, when to pick it), concise answers by default
  with `detail: "full"` on request, paging, one id shape, errors that say how to fix the call, and
  `readOnlyHint`/`destructiveHint` annotations so clients can skip confirmations on safe reads.

## A. Fix the basics (one PR, first) ✅ shipped

**Done (2026-10-30)**, checked on a Linux box as root the way Colab runs it (the sandbox user, Node from nodejs.org,
HyperFrames from npm, Chromium 1243):
- [x] Node 22 + npm + npx in `run`: installed once per runtime into `/opt/vb-node` (3.4 s here) and put first on the
  sandbox's PATH whenever the run is `lang=node` or its code mentions node/npx/npm/hyperframes. Measured: `node
  v22.11.0` as uid `vbsandbox`, `npx 10.9.0`.
- [x] `hyperframes` on the sandbox's PATH at the version the nearest `package.json` pins (a project pinning `^0.8.192`
  got `0.8.192`, the folder above it `0.8.217`; each pinned version is installed by root from the version string
  alone, read as the sandbox user); `check`, `snapshot`, `render`, `preview`, `lint`, `inspect` all listed.
  `video_template action=render project=…` renders with the project's own pin too.
- [x] Templates: fonts (Google font fetched once to `/opt/vb-fonts`, served from `assets/`) and GSAP (`npm` beside
  HyperFrames) from the worker's cache, never a CDN; the title is on screen at frame 0; every template has a drifting
  shape, a progress bar and a slow push-in, so something moves on every frame, and `qa` now checks frozen frames on
  templates (it used to skip them). `music` (+ `music_db`) mixes a bed, ducked under any voice in the piece.
  Measured (draft quality, CPU): `list` 3 items 10 s in 17.8 s, `title_card` 9.9 s, `quote` 11.9 s; `list` with music
  QA **PASS** on every check (no black, no frozen stretch, -13.8 LUFS, peaks -6.9 dBFS).
- [x] `repo checkout` takes a commit: a short or full sha is resolved through GitHub to the full sha (a branch named
  like a sha still wins), and the worker fetches just that commit, checked out detached. Measured: `HEAD~3` cloned at
  `2cfb5ab` as asked.
- [x] One id shape (`lib/auto/ids.ts`, run by `guarded()` for every tool): every file tool takes `m:x`, `g:x` or the
  bare id (12 hex = a generated item, else an upload); `delete_media` takes `m:x`; `revoice`, `clean_audio`,
  `add_media`, `add_reference_voice` take `file_id` beside `url` (or an id in `url`); `imagine image_urls`,
  `voice_dataset add_urls` and `transcribe sources[].url` take ids too.
- [x] The clean-up DNS error, diagnosed: the self-check hands the clean-up job a voiced line's link on the worker's own
  brand-new trycloudflare name, which doesn't resolve on the machine itself for the first minute ("Name or service not
  known", seen in `worker_status.selfcheck` on the live L4). Fixed: a link to the worker's own address is fetched from
  the gateway on localhost, and every download retries a name or connection failure 4 times (2, 4, 8 s).
- [x] The stale `?lean=1` line: `docs/AUTOMATION.md` already says `/api/mcp/lean`; the playbook's copy was stale and is
  rebuilt.

- Node 22 and `npx` in the sandbox. `run lang=node` works, and so do `npx hyperframes check | snapshot | render`, at the
  version the project's `package.json` pins.
- Templates render from the first frame: fonts and GSAP come from the worker's cache instead of a CDN; there's a
  `music` field (a Files id, ducked under any voice); motion at least every 2 s.
- `repo checkout` accepts a commit sha.
- One id shape: every file tool accepts `m:x` or `x`, and a `file_id` wherever it takes a `url` (Gemini's finding).
- The clean-up DNS failure diagnosed and fixed; the stale `?lean=1` line in `docs/AUTOMATION.md` corrected.
- Checked by a model on Colab with the test prompt, and the results written here.

## B. Projects: each agent works in its own space, and cleans up (the owner's ask) ✅ shipped

**Done (2026-10-30)**: `lib/auto/projects.ts`, the `project` tool, `guarded()` (wrap.ts) and Settings → Automation →
Projects. Checked locally against an S3 stand-in (the tree, the trash and the records live in R2):
- [x] `project start` → id, folder `Projects/<name>-<id>`, workspace `p-<id>`, branch `agent/<model>/<name>-<id>`,
  owned by the caller's model name (its model key's name, or X-Model). `status`, `list` (yours; `all` for everyone's),
  `finish`. Someone else's project is refused ("belongs to gemini, not you").
- [x] `project: "<id>"` on run, edit_video, video_template, repurpose, inspect_media, browse, save_file, upload_media,
  add_media, download, voice_lines, imagine, transcribe, clean_audio, revoice: outputs default to the project's folder
  (and `run` to its workspace); the file ids an answer names are recorded as the project's, and a job's files when
  `get_job` sees it finish (a job → project pointer in R2).
- [x] Deleting: `delete_files` (to the trash) of only the caller's own live project's files or its folder runs with no
  approval; another model's call on the same file, a file it didn't make, or `forever` still asks. Measured: gemini's
  own file → no approval; claude on gemini's file → NEEDS APPROVAL; forever → NEEDS APPROVAL; after finish → asks again.
- [x] `finish keep=[…]`: kept files go back to their kind's folder (or `keep_to`), the rest to the trash (30 days),
  the folder to the trash once nothing else is in it, the workspace removed by the worker's new `drop` op (worker
  3.12.1). Answer: kept, removed count and ids, folder, workspace.
- [x] Settings → Automation → Projects: each project (who, files, jobs, calls, folder, when) with Stop (no more calls
  under it, its running jobs cancelled, files kept). Checked at 1280 and 390 px.
- Units per project aren't counted (Colab bills the runtime, not a job); calls and jobs stand in.

The owner's rule: "deletion asking me defeats automation; an agent may delete only what it works on, in its own
folder, and clean up when it's done."

- **`project` tool**: `start` gives an id, a Files folder `Projects/<name>-<id>`, a sandbox workspace and a repo
  branch, all tied to the key or connector that started it (a model key, a Claude connector, a person). `status`,
  `finish`.
- **Every file gets an owner**: what a tool makes or uploads inside a project carries `{project, by, made}`. Outputs
  of `run`, `edit_video`, `voice_lines`, `video_template` and the others land in the project folder by default, never
  loose in the drive.
- **Delete without asking, only your own**: an agent may delete, move or overwrite files its own project made, with
  no approval. A file it didn't make is still gated, so the owner's drive stays safe. Deleting always goes to the
  trash (30 days, restorable). Emptying the trash or deleting forever stays the owner's call.
- **`finish` cleans up**: deliverables the agent marks `keep` move to their real home (Videos, Images); drafts,
  intermediate renders, voice takes and the workspace are deleted. The answer lists what was kept and what was
  removed.
- Settings → Automation shows live projects (who, what, files, units spent) with a Stop button.

## C. One endpoint that adapts (instead of choosing lean or full) ✅ shipped (with H)

**Done (2026-10-30)**: `lib/auto/endpoint.ts`, `lib/auto/toolsets.ts`, both routes. Measured with
`scripts/check-register.mts` (the real McpServer, its own tools/list):
- [x] `/api/mcp` lists the core: `tools`, `find_tools`, `call_tool`, `run`, `get_job`, `project`, `playbook`,
  `approvals`, `worker_status`: **9 tools, ~2,700 tokens**, against **~34,300** for all 90 (`?full=1`), **−92%** every
  session. `/api/mcp/lean` is the same core.
- [x] `tools action=load set=video|voice|files|posts|analytics|repo` adds a set (9 → 20 with video) and sends
  `notifications/tools/list_changed` on the call's own stream (checked over HTTP: the event comes before the answer).
  Sets are kept per key (a hash of the bearer token) for 12 h, since every request is a fresh server. Every tool is
  callable by name or through `call_tool` whether listed or not.
- [x] `vb.gather((tool, args), …)` in the code-mode kit runs calls side by side (8 threads); `vb.tools("word")`
  searches every tool through `find_tools` (the listing is only the core now).
- [x] Short answers: every answer's JSON goes out compact (no indentation), and for a model (not a script or a
  workflow, which read every row) lists past 25 rows are cut with a note; `detail: "full"` on any tool gets everything.
  Measured on a 60-row file list: 2,967 characters pretty → 1,395 compact → 491 brief.
- The tool list keeps its order and wording, so prompt caches keep hitting.

The owner's idea is right: one URL, and the model decides how much it needs.

- `/api/mcp` lists a small core (about 10 tools): `run`, `get_job`, `project`, `find_tools`, `call_tool`, `playbook`,
  `approvals`, `worker_status` and a `tools` loader. Its definitions cost ~2,500 tokens instead of ~30,100.
- **Toolsets on demand**: `tools action=load set=video` (or `voice`, `posts`, `files`, `repo`, `analytics`) adds that
  set's tools to the list and tells the client the list changed. Clients that support that (Claude Code does) see
  them as normal tools. Others still reach every tool with `call_tool`. Nothing is ever out of reach.
- **Code mode for anything repeated**: the `voicebox` kit gets `vb.gather(...)`, so one script fires many tool calls
  at once and prints only what matters. Large lists come back as a handle a script reads, not 200 rows in the chat.
- **Short answers by default**: every tool answers briefly, and `detail: "full"` gets everything. The tool list
  keeps a stable order and wording, so the client's prompt cache keeps hitting.
- `/api/mcp/lean` stays as an alias; `/api/mcp?full=1` lists all 84 for clients that want them.

## D. The factory: N videos in about the time of one

Today one video runs its steps one after another, and the GPU sits idle while Chromium renders. The factory turns
that into an assembly line.

| Stage | Runs on | How it's sped up |
|---|---|---|
| Research, spine, script | the models (free, parallel) | all N at once; code mode collects only the results |
| Voice | GPU | **one batched job for every line of every video**: the model loads once, re-voices only changed lines (cache by text) |
| Generated shots (WAN, LTX) | GPU | queued after the voice; skipped when real footage exists (the brand's rule) |
| Render (HyperFrames, ffmpeg) | CPU | several at once, NVENC encode; **the CPU runtime the downloads already use becomes the render farm**, so the GPU never waits on Chromium |
| QA | CPU | qa_layout, qa_frames, loudness, captions on every draft in parallel |

- **`factory` tool**: take N specs (or N topics), plan the stages, run them overlapped, and answer with one batch id.
  `get_job` on the batch returns only failures and finished file ids, never N full logs.
- **Render only what changed**: per-scene renders cached by content, so a fix re-renders one scene and splices it in.
  Drafts render at 540p and 15 fps for QA; the delivery is rendered once at full quality.
- **Warm caches**: models stay loaded across a batch; fonts, GSAP, `node_modules` and each repo commit are cached on
  the worker and on R2.
- Target, to be measured in F: 5 videos in under 2× the time of one.

## E. Many agents and many people at once

- **Fair queues**: each lane takes turns between keys and people, so one person's 20-video batch doesn't block
  another person's single voiceover. A daily units cap per key, alongside the global one.
- **No collisions**: case numbers and project names come from a server counter (the audit found two sessions
  heading for case-027). One folder and one branch per video, `agent/<model>/<case>`, so PRs never touch the same
  files.
- **Shared notes without merge conflicts**: agents never edit `LEARNINGS.md`, `TOPICS.md` or the scoreboard
  directly. They add to a server ledger (`memory`), and one nightly PR folds the ledger into those files for the
  owner to merge.
- **Creativity**: the factory can ask two or three models for competing hooks or looks on the same spine. A judge
  (`hook_score`, `inspect_media`, a reviewer model with the brand's rubric) picks one; the losers go in `SPEC.md` for
  A/B tests. Scorecards learn which model is best at which stage (research, script, look) and route work to it.
- **Quality before speed**: renderer PASS → `qa_layout` → `qa_frames` → `inspect_media` → a contact sheet a model
  reviews against `CLAUDE.md`'s taste rules → the owner's checkpoint. A failing scene is fixed and re-rendered alone.

## F. Measure (numbers go here)

WAN, LTX and animate each make one real shot; NVENC encode vs CPU; 1, 2 and 4 renders at once on the L4 and on the
CPU runtime; one video vs five end to end; tokens per video before and after C. Any engine that fails gets a fix or
is hidden from the tool list, not left in it broken.

## Order and owner decisions

A, B and C+H can run at the same time in separate sessions (they touch different files); D, E and G follow once A
is merged (they share `worker/bench.py` and `worker/gateway.py`). F's measurements are taken along the way.

Decisions (recommended first):
1. **One endpoint with a small core, toolsets on demand** (C), vs listing everything by default.
2. **Agents delete their own project's files freely, to the trash only** (B); other files still ask; deleting forever
   stays the owner's.
3. **The CPU Colab runtime as the render farm** (D): it spends a few units an hour while a batch runs, and saves GPU time.

## Session prompts (paste one into a new session; several can run at once)

Every session gets the same opening, then its own part. Run sessions 1–3 together; start 4–6 after session 1 merges.

```
You're working on voicebox-gpu (VoiceBox Studio). Read CLAUDE.md, docs/FEEDBACK.md, docs/AUTOMATION.md and
docs/FACTORY.md first. Your job is ONE part of docs/FACTORY.md, named below. Other sessions are building the other
parts at the same time, so:
- touch only the files your part needs; if you must change a shared file (lib/auto/wrap.ts, lib/mcptools.ts,
  worker/gateway.py, worker/config.py), keep the change small and merge origin/main into your branch right before
  your PR;
- in docs/FACTORY.md, tick and add notes only under your own part's heading;
- bump worker/config.py VERSION only if you changed worker/, after merging main.
Verify your own work: run the repo's checks (CLAUDE.md), test end to end against the local harness or the live MCP,
and screenshot any dashboard change at 1280 and 390 px. Anything you can't prove without the Colab GPU goes in
FACTORY.md under "Still to check on Colab" with the exact test a model should run. Keep tool answers short and
token-lean. Ship per CLAUDE.md (PR to main, merge once checks pass, confirm the Deploy run), then tell me what's
live, what you measured, and what still needs the GPU.

YOUR PART: <one line from below>
```

1. **A: Fix the basics.** Node 22 and npx in the sandbox; the HyperFrames CLI at the project's pinned version;
   templates with no black opening and something moving every 2 s, plus a music bed; `repo checkout` by sha; one id
   shape across the file tools; diagnose the clean-up DNS error.
2. **B: Projects.** The `project` tool (start, status, finish), files owned by the project and the key that made
   them, free deleting of the project's own files (to the trash only), cleanup at `finish`, live projects in
   Settings → Automation.
3. **C + H: One endpoint for every client.** The small core plus toolsets on demand at `/api/mcp`; concise answers;
   `vb.gather` in the code-mode kit; schemas every client accepts; the client test matrix; `upload_link` and the
   ChatGPT `import_file` tool; measure the tokens before and after.
4. **D: The factory** (after A). The `pipeline` op and `script_check`; one batched voice job for N videos; renders
   on the CPU runtime; per-scene caching; the `factory` batch tool.
5. **G: The motion toolkit** (after A). The cached toolchain bundle; Remotion, Revideo, Lottie, Three.js, Manim,
   auto-editor, PySceneDetect, rembg/SAM 2, Real-ESRGAN, RIFE; skills indexed in `playbook`; one test shot per tool.
6. **E: Many agents at once** (after B). Fair queues per key, per-key units caps, server-numbered cases, the shared
   ledger with a nightly PR, competing creatives with a judge.

## Still to check on Colab

Each with the exact test a model should run through the MCP (worker 3.12.0 or later: `gpu action=update_worker`).

- ~~A1, Node in the sandbox~~ **checked on the L4 (worker 3.12.1)**: `/opt/vb-node/bin/node`, `v22.11.0`, `npx 10.9.0`, as `vbsandbox`.
- **A2, the clean-up self-check**: `gpu action=selfcheck`, then `worker_status` → `selfcheck.steps` has `clean-up · Resemble Enhance` ok.
- **C1, toolsets in a real client**: in Claude Code connected to `/api/mcp`, call `tools action=load set=video`, then check `edit_video` appears without reconnecting (the list_changed notification). If it doesn't, the client ignores it: note which.
- **H1, ChatGPT and Gemini** (the owner's accounts): connect each (see H), call `worker_status`, `tools action=load set=files`, `list_files`; in ChatGPT attach an image and ask it to `import_file` it.
- ~~B1~~ **checked on the L4**: a code-mode script started a project, `run project=…` wrote `out/hello.txt` into its workspace `p-166ac7` and its folder (recorded as the project's), `delete_files` trashed it with no approval, `finish` answered `workspace: removed`, `folder: in the trash`. Found and fixed on the way: `video_template` already had a `project` (a repo folder), so it now takes either.
- **B1 (as first written)**: `project start name="colab check"`, then `run {"project":"<id>","code":"open('out/a.txt','w').write('x')"}`, `project status` lists the saved file, `delete_files` on it runs with no approval, `project finish` answers `workspace: removed`.
- ~~A3~~ **checked on the L4**: `list` rendered by HyperFrames 0.8.217 in **15.3 s** (draft), QA no black and no frozen stretch (only "no sound", as expected without `music`); its contact sheet shows the title on frame 0 in Inter and steady motion. The first HyperFrames render on Colab ever.
- **A3 (as first written), a template on the L4**: `video_template {"template":"list","fields":{"title":"3 Reels mistakes","items":["No hook","Too long","No captions"]}}` → qa PASS, then `inspect_media checks ["sheet"]` on it: the title is on the first frame.
