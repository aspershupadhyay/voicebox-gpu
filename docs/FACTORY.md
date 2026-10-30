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

## A. Fix the basics (one PR, first)

- Node 22 and `npx` in the sandbox. `run lang=node` works, and so do `npx hyperframes check | snapshot | render`, at the
  version the project's `package.json` pins.
- Templates render from the first frame: fonts and GSAP come from the worker's cache instead of a CDN; there's a
  `music` field (a Files id, ducked under any voice); motion at least every 2 s.
- `repo checkout` accepts a commit sha.
- The clean-up DNS failure diagnosed and fixed; the stale `?lean=1` line in `docs/AUTOMATION.md` corrected.
- Checked by a model on Colab with the test prompt, and the results written here.

## B. Projects: each agent works in its own space, and cleans up (the owner's ask)

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

## C. One endpoint that adapts (instead of choosing lean or full)

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

A → B → C → D → E, with F's measurements taken along the way.

Decisions (recommended first):
1. **One endpoint with a small core, toolsets on demand** (C), vs listing everything by default.
2. **Agents delete their own project's files freely, to the trash only** (B); other files still ask; deleting forever
   stays the owner's.
3. **The CPU Colab runtime as the render farm** (D): it spends a few units an hour while a batch runs, and saves GPU time.
