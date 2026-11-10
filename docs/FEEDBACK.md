# The owner's feedback, kept

Every piece of design or product feedback the owner gives lands here, in the same pull request as the change it asked
for. Read this before touching the dashboard. Newest first. When something here conflicts with an older rule in
`docs/DESIGN.md`, this wins (and DESIGN.md is updated to match).

## Latest round (Appwrite and Vercel gone, speed first, 2026-10-31)

- **"Build the Auto-DM suite completely, organise it, and make it fast: the tab takes forever to load, it must feel
  instant"** (2026-11-10): the tab paints at once from the last copy and refreshes behind it; each tab is its own
  chunk, warmed while the page is idle; the database setup is one version check instead of a dozen statements per cold
  start. New, to stand in for ManyChat: an **Inbox** tab (live chat with every conversation, answer by hand, saved
  replies, the bot steps back for that person, pause/hand back, tags, notes, done), **ig.me links with a QR code** as a
  trigger, **conversation starters**, **follow-ups** inside Instagram's 24-hour window, and **tags** an automation
  gives. No Claude key for now: AI replies stay optional, bring-your-own-key, and nothing else depends on them (the
  owner plans an app later).

- **"Stop the Kaggle benchmark, it's not useful in our suite"** (2026-11-10): removed (`kaggle_benchmark` and
  lib/kagglebench.ts). Writing runs on Sonnet 5.5 / Opus 5.5 through the owner's Claude plan; real results in
  analytics are the test. Kaggle stays as a free GPU. Free GPUs still work side by side: with Colab and Kaggle both
  on, a new job goes to the less busy one.
- **"Connect Kaggle too, and optimise the free resources"** (2026-11-10): Kaggle is a fourth GPU (about 30 free
  hours a week on a T4). The app starts a private Kaggle notebook through Kaggle's API when work needs a GPU and Colab
  is off, it runs the same worker, and it stops itself after 15 idle minutes, when Stop is pressed, past the week's
  cap (28 h by default) or before Kaggle's 12-hour limit, so the hours go to work, not waiting. Fallback order is the
  free ones first: Colab, Kaggle, Modal, Cerebrium. Kaggle's $100/month and $10/day are AI model credits for Kaggle
  Benchmarks only, not GPU time and not an API key, so they aren't wired into the app.
- **"Keep the models and the heavy work on R2, move the files and audio work to Backblaze"** (2026-11-10): Files
  (`workspace/media/`, posters, photo thumbnails), downloads in progress, finished voice jobs (`library/`), publish
  cards and temporary uploads live in the Backblaze B2 bucket `voicebox-files`; models, datasets, GPU caches and the
  small state files stay on R2 (`B2_PREFIXES`, `lib/store.ts`). B2 keeps a deleted file's last version 30 days (bucket
  lifecycle rule), so a delete there can be undone. Files are streamed to the browser through `/api/m` (B2 charges
  nothing for what goes to Cloudflare). The Worker holds a key for that one bucket only, never the master key.
- **Incident, 2026-11-10 15:24 UTC: 179 live files deleted for good by an agent.** Claude ran `storage clean` with
  `empty_trash: true` to clear 20 empty project records without looking at the trash first; it held about 185 live
  files (everything uploaded after the Nov 2 SFX batch except Passwords.docx), and their rows and R2 bytes went. How
  they got into the trash isn't known yet (the trash isn't logged). Since then: emptying the trash from the MCP is two
  steps (see what's in it, show the user, then `expect` that count), `storage clean` never touches Files or the trash,
  and the automatic tidy of empty folders is off until the cause is found. Rule: never empty a trash you haven't shown.
- **"Downloads still has stale ones; give the list its own box to scroll, the page shouldn't move a cm; Recents in Files
  are confusing, a deleted one still shows: do something creative"** (2026-11-10): a download that stopped moving
  (reading the link or saving for 15 minutes, on the worker for 3 hours) ends as an error you can Retry or clear, and
  every row has × (a running one is stopped). The history scrolls inside its own box (`.dl-list.scroll`), so the
  page never grows or jumps. Files' Recent grid became **Jump back in**: one row that scrolls sideways, only the last
  week, split by day, each tile saying where the file lives (click to go there), × hides it from the row (the file
  stays). It never refills with older files, so a deleted one just leaves. The folder tree's writes are now
  conditional (ETag, read again on a clash): two saves at once used to overwrite each other, which is how a file
  just deleted could come back. Another model's project can be finished once it has been idle a day.
- **"Don't ask any permission; when the user says it's done, delete the useless data completely, not to the trash;
  why is R2 growing, it shouldn't hold cache after the task; Automation takes eternity to load; no stale tasks after
  the AI marked them done; clearing download history must take it from everywhere"** (2026-11-10): deleting never asks
  any more (to the trash, for good, emptying the trash; the `delete` approval is gone). `project finish` takes `purge`:
  once the user says it's done, what isn't kept is deleted for good (row, bytes in R2, poster), the folder too, its
  jobs still queued are cancelled, then the caches are cleared. `storage` (MCP) reports what fills the bucket and
  `clean` deletes what nothing needs (lib/janitor.ts: the motion tools' cache, older compile caches, download staging,
  temporary uploads, bytes, posters and thumbnails whose file is gone, logs past 31 days); it also runs every night.
  The compile cache keeps its newest version per GPU: without it every runtime compiles again on paid GPU time. The
  Automation page reads everything at once (it read 8 days of log one hour-file at a time, twice). The job tray drops
  a job nobody could reach for 20 minutes, Cancel always clears it, and it has Clear finished (it kept "waiting for
  the GPU" forever while the GPU was off). Download: Clear history, and forgetting one removes what it left in
  storage; the files it saved stay in Files.
- **"It's time to manage the storage, it's all too cluttered"** (2026-11-10): cleaned by hand first, on the owner's
  word (22 empty folders, the 11 wallpaper zips, old cuts of a video, exact duplicates; the loose screenshots filed),
  then made to stay tidy: a folder of your own with nothing live in it and nothing made in it for 3 days goes to the
  trash when the Files page is opened (`emptyFolders` in lib/filetree.ts; category folders never; a file restored
  into one brings it back), a finished project's folder goes even when only empty folders are left in it, a link
  whose files are already in Files isn't downloaded twice (the earlier download is answered with a note; `again`
  forces it), and Files has **Biggest** (every file, largest first; the "x of y GB" in the header opens it;
  `list_files` takes sort size and answers `storage`). Deleting a file two rows share keeps the bytes until the last
  row goes. Keep it that way: nothing new may leave empty folders or twin copies behind.
- **"I've already uploaded the cookies but it's not giving me access"** (2026-11-07, YouTube downloads; "our local
  downloader works, why not ours"): yt-dlp on a home connection passes, but the cloud downloader (Colab, Cerebrium) is
  on datacenter addresses YouTube bot-checks, so it needs a signed-in YouTube export. Sign-ins was one cookies.txt
  for every site and each paste replaced it, so saving Instagram's wiped YouTube's (an extension exports one site at a
  time). Now a paste replaces only the sites it has cookies for; the panel shows each signed-in site (expired, or a
  YouTube export with no sign-in in it, shows amber and is refused on paste) with its own Remove; a bot check with a
  YouTube sign-in saved says how to export one YouTube won't sign out (a private window, then close it); the worker
  gives yt-dlp a JavaScript runtime (node on Colab) for YouTube's player and logs whether a YouTube sign-in came with
  the job. Getting past the bot check by disguise (rotating clients, faked tokens) stays not built.

- **Video feedback moved** (2026-11-05, the owner: "move all the learning to a specific git project… so we won't
  conflict"): every note on videos, Reels, covers and posting now lives in aspershupadhyay/content-creation
  `docs/FEEDBACK.md`, with the video-director skill, `docs/REELS.md`, `docs/BRAND.md`, the brand ident and every video kit.

- **"Why does our analytics page just say updating?"** (2026-11-05): the report older than 30 minutes was served at once
  marked stale and rebuilt with `after()` (Workers `waitUntil`), which Cloudflare cancels about 30 s after the response;
  a build of every account now takes longer (the log: "waitUntil() tasks did not complete… cancelled", 33 s), so it
  never landed and the page polled for two minutes, then sat on "Updating…". Now the page asks once more with
  `&wait=1`, which builds it inside that request (no 30 s limit), and a build older than 90 s is never joined (a
  cancelled one never settles). Rule: on Workers, nothing that can take over ~25 s goes into `after()`.
- **"If we want to review the rivals' account through our Voicebox, how can we… give me the steps… link to our Facebook
  account… you go on and do it, first we need to test the feature"** (2026-11-04, on @themoneycipher): Instagram
  rivals are read through Facebook Login for Business (Business Discovery): Grow → Competitors → Connect Facebook, then
  each Instagram rival gets the table row and its own page (followers, posts a week, hits against their own usual by
  likes, when they post, their hashtags); the analytics MCP tool's view "rival" reads any one. Setup is in
  `docs/PUBLISHING.md` → "Instagram rivals".
- **"Make sure no matter how many accounts we have, Instagram and YouTube, it should work the same… fix it all… make it
  workable for any apps"** (2026-11-03): Grow works for any number of accounts. Accounts group by name or handle, also
  when one says "Official", "HQ", "TV", "YT", "IG" or "The"; when names don't match, Audience → Accounts → "Group
  accounts" sets a brand by hand (kept in R2, wins over the name). Shares are never added across accounts (reach from
  non-followers is weighed by reach, not summed to 195%), and anything that shows one account's data among several
  names the account. Instagram's net totals (an un-like counts −1) never show below zero.
- **"Voicebox grow page is not built for multiple IG and YT"** and **"go ahead and build it"** (2026-11-03, after the
  Elite Minds review): Grow mixed every account. Elite Minds' viral Reel set the "usual" for Catch the Error, its
  #billgates showed up as Catch the Error's best hashtag, its May hit set the best posting time, and a post with no
  views was scored by its likes against other posts' views (the "776×"). Now Grow has an account switcher (All, or one
  brand with its Instagram and YouTube together, kept in the link as `?acc=`); scores, tips, hashtags and best times are
  worked out per brand and never mixed; All shows totals and the accounts side by side with no tips; a score compares
  views with views inside one account. The Writing room's hashtags and the analytics MCP tool (`account`) follow the
  same rule.
- **"Check why Cerebrium is running on its own even when I turn it off"** (2026-11-02, two containers running on two
  providers, two terminating): an open dashboard kept every cloud GPU awake (each tab's status poll, metrics and job
  list reached it, and every request restarts its sleep timer), and Stop exited the container, which Cerebrium takes
  for a crash and replaces. Now the studio answers those polls from the GPU's own heartbeat and never sends them to a
  cloud GPU (the job list only while it has work), and a stopped Cerebrium container goes quiet and is put to sleep
  by Cerebrium (cooldown 5 min) instead of exiting. A cloud GPU only ever gets work, its own jobs' follow-ups and
  explicit tests.
- **"Can we run it as a GUI in our website?"** → "Deploy from the website" (2026-11-02): no terminal for the cloud
  GPUs. Their tokens are pasted once on their tab, and Deploy is one button; GitHub runs the deploy
  (`gpu-deploy.yml`) and the card follows it (`docs/MODAL.md` → Deploying from the website). Anything the owner had
  to run in a terminal should become a button the website can do, with the terminal as the fallback.
- **Cerebrium's first job: "worker 404: not found"** (2026-11-02): Cerebrium ran two containers at once (the log had
  two gateways starting, two self-checks) and sent the job's progress to the one that didn't have it. Interruptible
  capacity (Cerebrium's default) is preempted and moved "during consolidation"; the wrapper ignored SIGTERM, so the
  old one lingered. Now `compute_tier = "protected"` (2x the rate: a job finishes where it started), SIGTERM shuts the
  container down, and a cloud job lost that way says so ("send it again") instead of a bare 404.
- **Cerebrium's setup: "Failed to download checksums: CERTIFICATE_VERIFY_FAILED"** (2026-11-02, a Mac): the
  `cerebrium` pip package downloads its real CLI with the system Python, which on the python.org build trusts no
  certificates. The setup's first line now exports `SSL_CERT_FILE` from certifi before `cerebrium login`. Every setup
  command that runs Python on the owner's Mac gets certifi's certificates.
- **"Let's set up Cerebrium quickly"** (2026-11-02): a third GPU, the same pattern as Modal (`cerebrium_app/`,
  `docs/MODAL.md` → Cerebrium): its own card on the Overview, its own tab, the same four-command setup, cap, Wake and
  Stop, and the fallback runs down Colab, Modal, Cerebrium. A new cloud GPU is one more entry in `lib/gpus.ts` CLOUDS
  with its app folder, never a second copy of the routing.
- **"The GPU page is so cluttered… how will I stop it… UI & UX needs to be simple"** (2026-11-02): Settings → GPU &
  engines is tabs that each do one job: Overview (Colab and Modal side by side, each with its state and one button:
  Start / Stop, Wake / Stop; then "goes first" and the fallback switch, nothing else), Colab, Modal, Engines, Machine.
  Modal has a real Stop (its next heartbeat shuts the container down, within a minute; MCP `gpu` backend
  `stop_modal`). Keep the overview to those two cards: anything new goes in its GPU's tab.
- **Modal's doctor: "waiting to be scheduled on a GPU_L4 worker… Time in queue: 0:08:00"** (2026-11-02): the reason
  Modal never started: no L4 free for the account. Modal now takes the first free of L4, A10G, A100 40 GB, L40S
  (`VOICEBOX_MODAL_GPU` pins one). A cloud GPU is never asked for as one card type only.
- **"the studio said 400: the Modal address looks like…"** (2026-11-02): `modal deploy` prints a regional address
  (`…gateway.us-east.modal.run`) and the check only took `…gateway.modal.run`, so the setup couldn't connect, Modal's
  heartbeats would have been refused, and the guessed address answered "still starting" for ever. Never guess an
  address a tool prints: take what it prints, and check it against real output before shipping.
- **The deploy step's "HTTP Error 403: Forbidden"** (2026-11-02): Cloudflare refusing Python's own user agent again
  (error 1010): `urlopen(..., context=)` builds its own opener and drops the installed one's User-Agent. Every request
  a script sends to the studio sets User-Agent on the Request itself, and a step that's only an optimisation (baking
  the code in) warns instead of stopping the deploy.
- **"Check if it's working or not"** (2026-11-02, after the owner deployed Modal): it wasn't: the container never came
  up (Modal answered "still starting" for 9+ minutes) and nothing said why. Now a Modal start never depends on the
  studio (the worker code is baked in at deploy and kept on the Volume), a start that fails answers every request with
  its reason (HTTP 424, shown by Test Modal), Cloudflare's block on Python's user agent can't hit it, and the MCP's
  test answers within its 60 s. A thing that runs out of sight must say why it isn't working, never hang.
- **"Got this error, also make sure MCP can use this"** (2026-11-02, the setup's last step failing with
  CERTIFICATE_VERIFY_FAILED on a Mac after `modal deploy` succeeded): setup scripts that run on the owner's machine use
  certifi's certificates, never the system Python's, and a failed last step says the GPU is deployed and what to do.
  Everything the card does, the MCP can do too (`gpu` action `backend`: the address, the choice, a test wake).
- **"Where will I get this worker secret, that's BS, give me an option for that"** (2026-11-02, on Modal's setup): the
  owner shouldn't have to dig up a secret. Set up Modal (Settings → GPU & engines) makes Modal its own key and prints
  four commands with it inside, and the last one connects Modal's address by itself (`docs/MODAL.md`). Any setup that
  needs a value the studio already has should hand it over in the commands, never ask for it.
- **"Set up Modal so we don't just rely on Colab… both should be options in the MCP and the UI, and if one fails it
  should fall back to the other"** (2026-11-02): Modal is a second GPU running the same worker (`modal_app/`,
  `docs/MODAL.md`). Settings → GPU & engines → Which GPU and the MCP `gpu` tool (action `backend`) pick which goes first;
  fallback is on by default, both ways, and never sends a job twice. Modal sleeps until work wakes it, has a monthly
  hour cap, and keeps training and video on Colab unless switched on. Any new GPU path goes through `lib/worker.ts`
  `call()`, never straight to one worker's address.
- **"Fix this 'upload failed (network or storage CORS)'… it took me 18 mins, make sure it doesn't get lost"** (2026-11-02,
  adding a read-along session to a trained voice's dataset): studio uploads (`uploadFile`: datasets, clones, revoice,
  subtitles, images) PUT straight to the R2 hostname, which the bucket's CORS refused. Now they go through our own
  domain first (`/api/upload/put`, same origin, signed-in, only into the `uploads/` key just handed out, up to 95 MB),
  with retries, and the presigned address only as the fallback; the deploy sets the bucket's CORS too
  (`workers/r2-cors.json`). A failed upload never loses a recording: takes stay on the device until a batch is in the
  dataset, and the error says so. Never make an upload depend on cross-site CORS when the Worker can carry it.
- **"Check the root cause, it's taking too long"** (2026-11-02, the HackerTube Reel sat at "processing" on Instagram
  for 6 minutes after Publish now): on Cloudflare, `after()` work is stopped 30 s after the response, but publishing
  gave itself 280 s there, so the run died mid-wait with its lock held, and only the next sweep (itself cut at 30 s)
  finished it. Now a click's run takes 22 s and hands over, the timer carries busy posts on every minute inside its
  own request (`/api/cron/publish`), the sweep does its work inside the request, and a lock lasts only as long as its
  run. Anything long on the Worker runs inside a request the timer waits for, never in `after()` (docs/PUBLISHING.md).
- **Auto-DM, round 3 (2026-11-01)**: "do it all and verify each one by one", "UI don't clutter, be creative: the
  current one feels too cluttered and not structured properly". Every one of the ten features has its own end-to-end
  checks (`mcp/scripts/check-autodm.cts`) before the next was started. The page was restructured: five tabs that each
  do one job (Automations, Comments, People, Insights, Settings); one quiet line of numbers instead of a wall of cards;
  the editor is a flow of steps on a line, one open at a time with a one-line summary each, optional steps added from
  "+ Add a step" pills rather than shown empty; Settings is a section at a time down the side. Keep it that way: a new
  Auto-DM capability is a step in the flow or a section in Settings, never another card on an existing view.
- **Auto-DM, round 2 (2026-11-01)**: "suppose I've 100s of videos: manage it like ManyChat", "it shouldn't trigger on
  just the given text: settings, fuzzy match, or anyone who comments", "only if they're following me, with a switch",
  "its own tab structure, managed like the Settings tab, no clutter in one tab", "it must work on my multiple
  accounts", and the CATCH automation for the Rewind Reel. Auto-DM is its own page now (`/auto-dm`, sidebar, tabs
  Automations / Activity / Contacts / Settings): the owner's call overrides "new capabilities become views, not pages"
  for this one. Details in `docs/PUBLISHING.md` → Auto-DM.
- **"Let's build our own instead of relying on someone"** (2026-11-01, on the "comment CATCH, get the prompt" DM for
  the Rewind Reel, instead of ManyChat): Auto-DM is built in (Posts → Auto-DM, MCP `auto_dm`, `docs/PUBLISHING.md` →
  Auto-DM) and sends nothing until Meta grants the messaging permission.

- **"Remove the post approval, I don't want that"** (2026-11-01): `publish_post go=now` / `share_to_story` and
  `auto_post go=now` no longer wait for a click (`lib/auto/wrap.ts`; the switch is gone from Settings → Automation).
  A model still publishes only when the user asked. Scheduled posts never asked; publishing rules still do.
- **"Pasting an image in Files says 'Upload failed: the connection dropped', and the card can't be deleted"**: the
  browser PUT straight to the R2 hostname, which a browser refuses cross-site after the move to pages.dev and reports
  only as a dropped connection. Files, the post drawer and upload links now send up to 95 MB through our own
  `/api/files/put/<ticket>` (same origin), falling back to R2 directly; Delete on a failed upload's card takes it off.
- **"How many images can it upload in one go? Make it unlimited; we need that capacity"**: `import_file` takes `files`
  (up to 100 per call, four at a time, no limit overall: the next call takes the next 100), all filed in one folder in
  one write, each answering its own bytes, SHA-256 and folder; one that fails doesn't stop the rest.
- **"The answer says `folder: sysimages`; return the folder's name and path apart from its id"** (and "I can say which
  folder to save in"): every file-saving answer (`import_file`, `save_file`, `add_media`, `upload_media`, the Files
  import) gives `folder_id` (internal, unchanged), `folder_name` and `folder_path` (`lib/files.ts` `whereFiled`: where
  the file really shows). A folder named by path (`"Images/Samurai"`) is made when it doesn't exist yet.
- **"ChatGPT should be able to upload a generated image directly into Files, original bytes, no Base64, one upload
  workflow"**: `save_file` now also answers a `put_url` on our own domain (`/api/files/put/<ticket>`) for clients that
  can't reach the R2 hostname: the raw bytes of a PUT stream into R2 through the Worker's binding, checked against the
  ticket (name, type, size), and the receipt gives bytes and SHA-256. Up to 95 MB (Cloudflare's request cap); bigger
  files still use the presigned `upload_url`. Same ticket, same `/api/files/complete`, same folders and backup.
  Then: ChatGPT's sandbox has no network at all (`Could not resolve host`), so it can't PUT anywhere. Its one route is
  `import_file`, now in the core listing so ChatGPT hands it the file itself (`openai/fileParams` only fire on a tool
  the client listed), answering bytes and SHA-256 of the stored copy.
- **"I don't need Appwrite and the Vercel project; get over with Appwrite completely"**: no code talks to Appwrite now
  (`lib/data.ts`, Postgres and R2 only; the package, webhook and switches removed), and the old Vercel project is
  unused. Deleting both projects is the owner's click (docs/MIGRATION.md phase 4).
- **"Login fast as fuck; speed and performance really matter now; loading at lightning speed"**: sign-in checks the
  lockout, the list and the password at once and writes its log after the reply; storage goes through the Worker's R2
  binding (no signed S3 round trip); the Appwrite SDK is gone from every page; the session check reads its two cached
  lists at once. Keep it that way: nothing slow on the sign-in path or in front of the first paint.
- **"We need templates for our videos so we save resources"** (and the 20 motion tools list): saved formats (news,
  explainer, clip), stickers on every template (SVG or any Lottie), beat-synced cuts, lossless trims, Remotion's own
  skills for models (docs/FACTORY.md I). Of the list, Blender, the path tracer, Jolt, Tweakpane, ComfyUI and OBS were
  left out on purpose (why: FACTORY.md I and the reply); 3D and WhisperX come later.
- **"Don't ask for delete permission, there's nothing as such important"**: moving files or folders to the trash and
  deleting posts no longer wait for an approval (the trash keeps 30 days, the nightly dump 14); only deleting files
  for good (`forever`, `delete_media`, `empty_trash`) still asks (`lib/auto/wrap.ts`).
- **"Make sure everything we've done so far is written down"**: docs/MIGRATION.md opens with where everything runs.

## Earlier round (off Appwrite and most of Vercel, 2026-10-30)

- **"Stay free without the hectic: R2 for every file, CockroachDB for data, the API and MCP on a Cloudflare Worker,
  Vercel only for the pages"**: the plan is `docs/MIGRATION.md`, one phase per PR.
- **"Make sure nothing breaks, each functionality must work; take care of the data, especially the model"**: every
  switch sits behind a setting with the old path kept, Appwrite stays until a week on the new setup, and the trained
  voices (`models/`, `datasets/`) are never touched by a migration step.
- **"Be serious with storage: never go over, keep only what matters, the cache too"**: a hard budget
  (`STORAGE_CAP_GB`, 9.5 GB of the free 10) checked before every upload, the bucket's use on the Files page, bucket
  rules that expire caches, and no copy of public model weights in R2. Files are stored once (R2), not twice.
- **"Neon instead of CockroachDB; decide it properly so we never get stuck again"**: Neon (Postgres, Object Storage as
  the off-Cloudflare backup, Realtime for the live board; not Better Auth, Functions or the AI Gateway). The limit that
  can bite is compute hours, not storage, so the design keeps the database asleep unless something is due.
- **"No new repo"**: stay in this one (the deploy, the Colab bundle and the history live here).
- **"Empty the Files page except Passwords.docx"**: done, deleted for good on the owner's word.

## Earlier round (build the factory, 2026-10-30)

- **"Build ALL of docs/FACTORY.md in one go, A → B → C+H → D → G → E, measuring F along the way; verify each part
  yourself, ship each as its own PR, only stop for what truly needs me"**: done as asked (PRs #131-#143); the one
  thing that needed the owner was the day's units cap (5.09 of 5 spent), approved in Settings → Automation. Each
  part's notes and numbers are in docs/FACTORY.md; what still needs the GPU or the owner's accounts is under "Still to
  check on Colab".

## Earlier round (Gemini's post-mortem, 2026-10-30)

- **"Check Gemini's audit and save it"**: checked claim by claim in `docs/FACTORY.md` (true: the asset round trip,
  mixed id shapes, Node's PATH, the delete gate; rejected: a shared mount and putting a key in the worker's
  environment; the owner's call: replacing the "Send it our way" ending, A/B it first).
- **"Load every tool for video, not just HyperFrames: Remotion, motion skills, Apple-level editing"**: FACTORY.md G.
- **"Work from ChatGPT (Go) too, with image uploads; the MCP must work with any AI tool, on fewer tokens"**:
  FACTORY.md H.
- **"Give me a prompt for new sessions so several agents work at once"**: FACTORY.md, Session prompts.

## Earlier round (the video factory, 2026-10-30)

- **"Make the MCP faster and leaner; 5 videos shouldn't take 5× the time; don't waste resources"**: the plan is
  `docs/FACTORY.md` (an assembly line: one batched voice job, renders on the CPU runtime, per-scene re-renders).
- **"One endpoint instead of lean or code; the AI switches by use case"**: adopted. One endpoint lists a small core,
  and models load toolsets on demand (FACTORY.md, C).
- **"Deleting shouldn't ask me; an agent deletes only what it works on, in its own folder, and cleans up when done"**:
  adopted. Projects own their files and clean up at finish (FACTORY.md, B).
- **"Me, Gemini, Claude, OpenCode and another user at once: creativity, repos, speed"**: fair queues, server-numbered
  cases, a branch per video, a shared ledger instead of editing shared files, and competing creatives with a judge
  (FACTORY.md, E).
- **ChatGPT's audit** (Node missing in the sandbox, a template's black opening, a renderer PASS hiding frozen frames,
  the clean-up DNS error, checkout by sha): checked against the code, and the fixes are phase A.

## Earlier round (keys for other models, 2026-10-30)

- **"Add the GitHub key in the website so it can be used through the MCP as well"**: Settings → Automation → Keys
  takes the GitHub key and the search key: saved encrypted, checked with GitHub on save, never shown again (last 4
  characters only) and never given to a model; models use them through `repo` and `browse`. No Vercel step needed.

- **"Add a make-new-token button so I can add new models in their MCP settings"**: Settings → Claude & API → Other
  models makes a key per model (shown once, revocable, held to a role if picked), and the settings to paste already
  carry it. Never rotate `MCP_TOKEN` for a new model: that signs everyone out.
- **"Gemini has web search, so what's the point?"**: right for chat; `SEARCH_API_KEY` is optional, only for
  scheduled workflows and sandbox scripts that run with no chat model.

## Earlier round (code execution with MCP, 2026-10-29)

- **"Check out code execution with MCP; this will reduce the token consumption"** (Anthropic's article): adopted.
  The sandbox gets a `voicebox` module so a model calls tools from a script and only the filtered result enters its
  context; a lean MCP mode lists six tools and finds the rest on demand; working scripts are saved as skills. Every
  call from code still goes through the approvals, the units cap and the call log. See `docs/AUTOMATION.md`, Decisions.
- **"Start the automation suite and build it all, verify your own work"**: phase 1 (Control) is shipped:
  Settings → Automation (approvals inbox, kill switch, daily units cap, ask-first switches, call log by model).

## Earlier round (the automation suite plan, 2026-10-29)

- **"Any AI, everything you can do in a cloud environment, through our MCP; a full automation suite; save it so a new
  session picks it up"**: the plan is `docs/AUTOMATION.md` (linked from `CLAUDE.md`): ten building blocks (control,
  sandbox, know-how, repos, media, web, automations, agents and audit, memory), safety first, nine phases.
- **"On Colab"**: everything runs on the Colab L4, not Modal.
- **"Save my tokens; I'll add Gemini through the MCP"**: the server holds recipes, templates and checks so a cheaper
  model works in 2–3 calls; a setup guide for Gemini CLI is in the plan.
- **"A separate repo so it doesn't mess up what we built; audit their work"**: models work freely in a separate
  workbench repo; here they may only open PRs that the auditor and the owner merge.
- **"Any model doing anything must improve and save the feedback, like you do"**: the learning loop: log, grade,
  audit, lessons, promote to rules, serve to every model, scorecards per model.

## Earlier round (square and portrait, whole, 2026-10-29)

- **"It's cutting the actual size of the posts; give us what Instagram stores; ready for both square and portrait"**:
  the carousel's photos came as 1080x1080, Instagram's square grid crop of 4:5 posts (the top line and the bottom of
  the picture cut off). Instagram lists the crop (c<x>.<y>.<w>.<h> in its address) beside the photo as posted, and the
  crop claimed to be bigger. Now every uncropped size is tried before any crop, and the whole photo wins: a portrait
  post comes at 1080x1350, a square one at 1080x1080.
- **The carousel viewer trimmed slides too**: its cards were a fixed 5:7 with object-fit cover, so a square or 4:5
  slide lost its sides. The cards take the carousel's own shape now (its first measured slide) and show each slide
  whole (contain). The phone preview still crops like Instagram does (every slide to the first one's shape).

## Earlier round (the L4 for downloads, side by side, full-size carousel photos, 2026-10-29)

- **"It just keeps saying connecting to Colab; keep it on the L4"**: the runtime the downloads started had been stopped
  ("downloads done"), but its worker kept heartbeating while Colab tore it down, so a new download kept sending to a
  dead tunnel (530) and never started a runtime. Now stopping a runtime marks its worker offline at once, heartbeats
  from a stopped runtime are ignored, and a worker that stays unreachable for three looks starts a fresh runtime (if
  Colab has none assigned). Downloads start the L4 again (the owner's call), not the CPU runtime; it still stops itself
  once they're in.
- **"Downloads should run at the same time, not queue"**: the worker has its own download lane, four at once, beside
  the GPU and CPU lanes (VOICEBOX_FETCH_WORKERS); the per-site pacing still spaces each site's requests.
- **Carousel photos came at 150x150** (slide check: "Too small (150x150)" on #02-#08): Instagram lists each photo's
  sizes smallest first and without dimensions for a signed-out downloader, and the picker took the first. Now sizes
  are ranked by their dimensions, else the size in the address (s150x150, p1080x1350), else later = bigger; the saved
  photo's real size is checked and the next sizes are tried while it's under 600 px. If the site offers nothing bigger,
  the row says so ("Photo 4 only came at 150x150: Instagram gave a signed-out downloader nothing bigger").

## Earlier round ("fetch failed", 2026-10-29)

- **"It says fetch failed"**: the Colab CPU runtime started (0.08 units an hour) and its worker registered 7 s after
  launch, but its brand-new trycloudflare address didn't resolve yet, so the dashboard's first job request threw
  Node's bare "fetch failed" and the download ended there; no job ever reached the worker. Now the worker only
  registers once its public address answers; a request that never left (the address not resolving, a refused
  connection) is sent again for ~20 s, a POST too; "on but unreachable" keeps a download waiting ("Connecting to the
  Colab downloader") instead of failing it, and goes to the automatic retry after ~15 looks. A connection error never
  shows as a bare "fetch failed": it says which hop dropped and that the link is fine.

## Earlier round (a downloaded carousel stays one carousel, 2026-10-29)

- **"Will a carousel be grouped as one?"**: it wasn't: its photos and videos landed as loose files. Now a download
  with several files becomes one carousel in Files, in the post's order, named after the post ("@handle on Instagram -
  title"), for the post it was downloaded for. The row says "Carousel of 5" and Open goes straight to it; the
  `download` tool returns its carousel id.

## Earlier round (tries again by itself, whole carousels, 2026-10-29)

- **"Build the auto retry"**: a block that passes (too many requests, a non-standard 4xx such as 470, a 5xx, a timeout)
  no longer ends the download: it waits 10 minutes, then 25, and runs the whole chain again by itself (server, then
  the Colab downloader), saying so on the row ("Trying again by itself in 10 min (1 of 2)"). The 10-minute sweep wakes
  it with nobody on the page and the worker off; one waiting to try later doesn't keep the runtime on. A missing post,
  a sign-in wall or a private post isn't retried; it says what to do. Retry by hand starts the count again.
- **"Keep the Chrome one"**: kept, as the second step of the chain.
- **"Change the IP too, so we don't get flagged"**: not built (rotating IPs to get past a site's blocks); the
  automatic retry after the block lifts is what's built instead.
- **"Carousels as well; whatever the platform offers"**: an Instagram (or Threads, Facebook…) carousel came back with
  its videos only, or failed at its first photo. Now the post is read once, then every item is saved in the post's
  order: each video through yt-dlp, each photo at the biggest size the post lists. A photo post works the same way.

## Earlier round (errors that say what happened, any link, a gentle downloader, 2026-10-29)

- **"Why am I getting 470? Make the error obvious instead of BS"**: a site refusing the server's file fetch showed as
  a bare "the file answered 470" and stopped there. Now every error says who refused (the site by name, Colab, or
  storage), what the HTTP code means (404 gone, 401/403 needs a sign-in, 429 too many requests, 5xx the site is down,
  any other 4xx such as 470: the site blocking automated downloads) and what to do. The worker reports the most telling
  of everything it tried.
- **"Any link should work"**: when the server can't get a file, the Colab downloader now tries it (yt-dlp, gallery-dl,
  the page scan) instead of giving up; the final error keeps what the server got.
- **"No bot behaviour, so our IP doesn't get flagged"**: the downloader paces itself: the same site at most once every
  few seconds (social sites longer, with a little randomness), short pauses between a site's requests and a carousel's
  items, fewer parallel connections on YouTube. Signed-in cookies (Download → Sign-ins) are the way through a site's
  bot check. Disguising requests (spoofed browser headers or fingerprints, proxies to hide the IP) is not built: it's
  against the sites' terms and gets accounts flagged faster.

## Earlier round (a CPU runtime for downloads, faster, never stuck, 2026-10-29)

- **"Build the Colab one"** (the no-GPU way suggested last round): downloads now start a Colab CPU runtime
  (`variant=DEFAULT`, the worker in `VOICEBOX_MODE=fetch`: no engines fetched or checked, fetch jobs only, anything else
  refused with "start the GPU"), and fall back to the cheap L4 if Colab won't give one. Starting the GPU from the app
  replaces the downloads runtime; a download that was on it starts again on the new worker (twice at most).
- **"Make it faster; write the file while it's downloading"**: each file goes to storage the moment it's whole (yt-dlp's
  post hook, after the merge), while the next one downloads; fragments come 8 at a time; yt-dlp and gallery-dl are
  installed at boot, not on the first link; the worker calls the dashboard back when a download is done
  (`/api/downloads/done`, WORKER_SECRET), so it's saved to Files at once instead of on the next look. A byte-by-byte
  stream into Files isn't possible: Appwrite needs a file's size before the first chunk, and a merged video only
  exists once it's merged.
- **"503 first byte timeout" while saving a download** (`upload failed: <?xml …503 first byte timeout`): Appwrite's
  edge gave up waiting, mostly on a big video's last chunk while Appwrite assembled it. Every chunk is retried now;
  after a failure it asks Appwrite how far the file got and carries on from there; a file that's already whole (or
  already has its row) isn't sent again. Reads from R2 retry too.
- **"Make it invincible: if it has any video links, extract and download"**: yt-dlp, then yt-dlp as Chrome (curl_cffi),
  then gallery-dl, then every video link in the page itself (og:video, `<video>`/`<source>`, a bare .mp4 or .m3u8 in
  its scripts); YouTube tries other player clients when the default is refused. On the server, a page with a video
  gives the video, not its preview image, and a page with a stream or a player goes to the worker.

## Earlier round (downloads start and stop the GPU, a folder per site, 2026-10-29)

- **"Make sure it auto starts quickly"**: an Instagram link "didn't work" because the GPU worker was off and the
  download sat waiting. Now an Instagram, YouTube, TikTok (any worker-only) link with the worker off starts the cheap
  voice GPU (an L4) by itself, once for any number of links, and the worker's first heartbeat hands the waiting ones over,
  with nobody on the page. If it can't start, the row says why (connect Colab, or run the notebook).
- **"Once the task is done stop the GPU"**: a GPU the Download page started is stopped as soon as nothing is running on
  it and no download is still under way (checked on every heartbeat, at least 3 min after it started). A GPU someone
  started themselves keeps the usual idle stop.
- **"Each platform has its own folder"**: downloads land in the site's folder inside the one picked:
  Downloads/Instagram, Downloads/YouTube, Downloads/X, Downloads/Web…, made the first time.
- **"Is there any way to run without the GPU? Don't build it, suggest it"**: suggested, not built (yt-dlp needs no GPU:
  a CPU-only Colab runtime, or a small always-on box, would do the same for a fraction of the units).

## Earlier round (Download from any link, 2026-10-29)

- **"Give you a link from Instagram, YouTube or X and it downloads through our website, over MCP too, into a folder;
  images from Pinterest, Cosmos or any source"**: Create → Download (`/download`, also in the Create menu). Paste a
  link (or several, one per line) and it starts on its own; pick the folder (default "Downloads", made if new). X,
  Pinterest (the video, else the original-size image), Cosmos, any page's own photo or video, a Google Images link and a
  direct file come straight from the server; Instagram, YouTube, TikTok, Facebook, Threads, Reddit and Vimeo go through
  the GPU worker's yt-dlp (photo posts through gallery-dl), which uploads straight to storage. Files are named
  "@handle on Instagram - title" so the post package credits the creator. Claude has `download` (waits until the files
  are in, returns m: ids ready for auto_post) and `downloads` (list, retry, forget). Pasting a link in Files or the
  upload overlay uses the same downloader now.
- **"Handle everything smartly"**: every link the server fetches is checked (http(s), public addresses only, on every
  redirect); a site that refuses the server falls through to the worker; with the worker off, a download waits and
  starts on its own when it's back; errors say what to do ("YouTube asked the worker to sign in: add your sign-in
  cookies, then Retry"). YouTube's bot check and Instagram's login wall need sign-in cookies (Download → Sign-ins,
  kept privately, only sent to the worker).
- **"Clean and animated, fast"**: a bracketed command bar that turns green when it sees links and shows which site
  each one is, the sources with the worker's state, rows that rise in and show live progress (a scan line over the
  thumbnail, marching stripes), a green edge when one lands. Still for people who ask for less motion.

## Earlier round (the upload overlay, research ignores file names, 2026-10-29)

- **"The best upload overlay: upload files, drag and drop or paste images; premium, animated"**: Files → Upload opens
  one overlay with all three ways (Choose files or a folder, a link box, and the hints for dropping and ⌘V). Pasting
  while it's open uploads the photo or adds the link. Dragging files onto the page shows the same scene: "Incoming",
  how many files, and the cards dropping into the tray. Bracketed panel, pixel strip, green only while something is
  arriving; flat, no gradients, still for people who ask for less motion. Escape and a click outside close it.
- **"Fill from research" built the caption from the file name** ("Case-025-Veliz-Tech-Never-Neutral-9x16 … Save this
  for later."): an editor's export name (hyphenated, a 9x16, "case 025", "final", "v2") now counts as a file name, is
  cleaned to its words ("veliz tech never neutral") for the topic, and is never used as the caption's summary. A topic
  guessed from a file name is guessed again next time instead of sticking; one someone chose still sticks.

## Earlier round (the publish preview, 2026-10-29)

- **"The preview while posting shows off the screen"**: the Reel / Short / Story phone was taller than 9:16 and the
  video filled it by cropping the sides ("CASE 025" showed as "ASE 025"). The screen is 9:16 now, so a 9:16 video
  shows whole.
- **"While I was typing in the text field the frame was blinking"**: the preview's video was a component made inside
  the preview, so every keystroke made a new one and the video reloaded. It's a stable component now: typing changes
  the caption on the phone and nothing else.

## Earlier round (a saved caption is never replaced, 2026-10-29)

- **"Publish now" through the MCP threw away the saved Instagram caption** (post `6ae310935b4d2f43c22f`, a Reel): the
  package treated a plan caption that matched the post's caption as "seeded, not written by a person" and replaced it
  with its own title, first paragraph, "Save this for later." and keyword hashtags, dropping the credits, the question
  and the hashtags. Now a caption saved on the plan, per target (`captions`) or on the post goes out unchanged; the
  package only fills what's empty or what it wrote itself. The same goes for a YouTube title and description. The
  credit is only added when the caption credits no one (no "credit", "via", ©, 📸 or @handle).

## Earlier round (post a video like a carousel, Radar's plan, 2026-10-29)

- **"An option like the carousel's, to just post on Instagram or YouTube, for videos as well"**: a video open in Files
  has **Instagram** (a Reel) and **YouTube** (a Short at 3 minutes or less, else a Video) in its top bar, and its menu
  has all three ("Post to Instagram as a Reel…", "…YouTube as a Short…", "…as a Video…"); a photo gets "Post to
  Instagram". Like the carousel's button it sets up the post with the researched package as a draft (nothing is
  armed or sent) and opens the composer to check and send.
- **"Make Radar the Palantir of content research, better than the paid tools, for any creator, free"**: the plan is
  `docs/RADAR.md` (an audit of today's screens, the redesign, sources checked live, the features in order) and
  ROADMAP → Radar. Not built yet; next session starts at R1.
- **"Radar must feel like a different world, but clean and organised; nobody should be confused about what an option
  does"**: one score for a topic everywhere (today Sweep says 100 and Keyword says 63 for "apple"), every part
  higher-is-better, no codes without words, one action bar per topic in a fixed order, three moves (Brief,
  Investigate, Track) instead of three unrelated tabs, and an operations-room look in our theme (command bar,
  bracketed panels, status rail, timeline, link graph).
- **The "Opportunity" label sat on the rings**: it's under the dial now.

## Earlier round (Radar as an instrument, one-click posting with a researched package, 2026-10-29)

- **"I don't see the Radar tab"**: Radar is now second in Grow (right after Overview), in Create's sidebar next to the
  Writing room, and one of the four phone tabs in Grow.
- **The radar should look like the reference video** (a dot-matrix core turning in a bracketed frame with mono
  telemetry): the scope has corner brackets, a turning dot-matrix core with folding arms, a beam that pings each topic as
  it passes, a status line cycling through real numbers and a mono readout of the best topics. Only real numbers, never
  filler digits.
- **"Text must look properly kept, not cluttered"**: labels are placed so they never sit on each other, a blip, the
  core or the ring names; the ones that don't fit stay off (the list has every topic). Topics sit in sectors by where
  their signals came from (search, news, builders, social, video).
- **"Collection of data must be insane, add more free APIs"**: the sweep now also reads Google News' Technology front,
  Lobsters, DEV Community, Mastodon's trending tags and links, Hugging Face's trending models, GitHub's fastest new repos
  and Wikipedia's most read; keyword research adds Mastodon hashtag counts and Stack Overflow's question count. Reddit
  and Bluesky still refuse servers without a key.
- **"Confident based on the scores"**: each topic has a confidence (independent sources, signals, freshness) and its
  heat broken into parts; keyword confidence counts eight key sources.
- **"Fast"**: an older sweep is served at once while a new one is read behind it, and the top three topics are
  researched ahead so opening one is instant.
- **Watchlist**: watch straight from a topic; rows flag Rising, Moving fast and Cooling.
- **"Video post automated with one click, AI too"**: Files → Auto-post (or Post now) on a video, photos or a carousel
  makes the post, its targets (a video: Reel + Short; photos: an Instagram carousel), the package and armed plans at the
  next posting slots. Claude does the same with `auto_post`.
- **"Every video or carousel must have everything: best title, description, credits, keywords, hashtags from
  research"**: the post package (`lib/postpack.ts`, `post_package`): the best of a scored set of titles, a description
  with the keyword early and the words searchers add, tags from the long tail, hashtags the ranking videos use, and
  credits read from the file names (a Pinterest pin, a TikTok or Instagram handle). It's a pipeline step, a "Fill from
  research" button in the composer, and it runs before every arm or send, whoever set it up, so nothing goes out
  without hashtags and the credit. A person's own words are never overwritten.

## Earlier round (Radar: keyword research and what to post, 2026-10-29)

- **Build a radar and elite keyword research, "like Palantir and World Monitor but for content"**: Grow → Radar
  (`/analytics/radar`). A sweep of what's moving in the lane right now (Google Trends, Google News, Hacker News,
  autocomplete, YouTube trending, rivals' outliers) on a radar scope; deep research on any keyword (demand, momentum,
  competition, fit, opportunity, long tail, questions, what ranks); the best titles with SEO and click scores; a
  watchlist over time.
- **Free resources only**: every source is free and public (autocompletes of YouTube, Google, Bing and DuckDuckGo,
  YouTube's search page, Google News, Hacker News, Wikipedia pageviews, Google Trends). Reddit refuses servers without a
  paid key, so it's left out and the page says so.
- **"The best prediction, not BS"**: every score lists what it's made of and which sources answered, with a confidence;
  the prediction is your own usual views moved by named factors, with a range and a hit chance, and every prediction is
  kept and judged against the real post a week after it goes out (the track record), which then corrects later ones.
- **Everything through the MCP**: `radar`, `keyword_research` (compare, watch, save a prediction for a post),
  `seo_score` and `radar_watch`.

## Earlier round (covers, thumbnails, stories, a calmer top bar, 2026-10-29)

- **Stories shouldn't be Instagram's stretched crop**: build them the way you share a post by hand, the whole post as a
  card with the @handle on a blur of itself (videos too), for anything already posted ("Share to story"). Fill stays
  as an option.
- **Thumbnails and covers everywhere the APIs allow**: Reels and single feed videos take a cover image, a Post's cover
  is its first slide, YouTube Videos and Shorts take a thumbnail, and a live YouTube video's thumbnail and details can
  be changed. Say plainly what the APIs can't do (YouTube Community posts; Instagram covers after posting).
- **The carousel top bar was cluttered**: one icon toggle for Curve / Phone, one status chip (Live, or slides to look
  at), the Instagram button, and everything else under one ⋯ menu.

## Earlier round (Instagram fixes, smart search, share links, pipeline, 2026-10-28)

- **"Post to Instagram" made two posts for the same carousel** (the agent's "Case 023 … (carousel)" post already held the
  photos; the button made another, which went live). It now reuses the post the photos already belong to and never
  posts the same files twice: photos already live are refused, and the publishing runner itself stops a repeat.
- **Posting to Instagram was slow**: one listing instead of two, only the files not yet on the post are moved, and the
  composer opens straight away from the reply (no waiting for the live post list). The button shows it's working and
  can't be pressed twice.
- **The carousel should open on the first photo**, and **the active photo bigger**: the card in focus is ~40% larger,
  fewer cards each side so all of them are bigger.
- **Sideways swipes went Back in the browser**: swipes on the carousel and the viewer now browse the photos instead.
- **The phone preview needs our logo**: the connected Instagram account's picture (the studio's logo if it can't load).
- **A carousel already live must not be posted again**; Claude can set up, arm or send a carousel through MCP.
- **Smart search, share links and the one-click post pipeline**: build them. **Not the duplicate finder** ("it will
  impact the performance"): left out. Keep background work light: smart search waits for the page to settle, looks at
  new photos one at a time, only on computers, never on data saver.

## Earlier round (carousels to Instagram, 2026-10-28)

- **The carousel stage was laggy and the spacing was off.** The curve is now placed straight on the page while you drag
  (no re-render per frame, ~60 fps), the cards have even gaps, the labels sit flat under them, and the whole curve fits
  the stage's width and height. Invisible wrappers were swallowing clicks on the middle card: fixed.
- **Opening a single file needed motion too**: the viewer zooms the file up on open, slides the next one in from the
  side you stepped towards, and sinks away on close.
- **Build the five carousel ideas**: post a carousel to Instagram (the composer opens with the slides in order and a
  fitted caption), drag a card up to reorder, a phone preview of the feed (P), slide checks (shape, size, duplicates),
  and its Instagram numbers once it's out. Instagram's API doesn't report which slide people stop on; say so rather
  than invent it.

## Earlier round (carousel fixes, 2026-10-28)

- **Uploading a carousel through the API failed on every file after the first** ("carousels are busy"). Fixed: the
  conditional write now matches R2's tag, falls back to a checked plain write, and turning a ticket in again retries
  the join. Files already uploaded can join a carousel without a re-upload (`/api/files/carousels`), and upload keys
  can do that too (the owner's call). Batch uploads take several files in one call.
- **"I don't see the UI"**: carousels now have their own row at the top of Files, not only inside their folder.
- **Uploads and image loading must be fast**: uploads go straight to storage; the copy into the workspace reads ahead,
  previews are made when the upload lands, the photos around the open one load ahead, and the Appwrite connection
  opens early.

## Earlier round (carousels in Files, 2026-10-28)

- **A post's photos must not scatter across Files.** A ten-photo post showed as ten loose files. Now they're one
  carousel card (the owner's reference: a curved fan of tall photo cards, each numbered #01… with a label under it).
- **Opening a carousel: the photos rise from the bottom to the middle of the screen**, one after another, "like the
  falling stick game but from bottom to up", then sit on the curve. Clicking a photo opens that photo.
- **Shortcuts to go back and forward inside a carousel, and to jump to the next post's**, in the stage and in the
  full-size viewer (← → inside, `[` `]` between posts). Make Files' image watching feel unique and creative, with
  motion.
- **Carousels need an MCP endpoint and must work through the upload API**: the `carousels` tool, `carousel` +
  `position` on `save_file` / `upload_media` / `add_media` and on `/api/files/upload`.

## Earlier round (Writing room, 2026-10-28)

- **The Writing room looks like the poster the owner sent** ("It's okay to be okay": marbled orbs in concentric rings,
  curved labels, black number chips, threads gathered into one hand, a small ring key). Built in matte black, flat and
  Geist (the owner picked "poster on black"): pixel marbles instead of paint, white chips, a pixel hand. Each orb opens
  its tool; keep it curated and premium, not a form page.
- **No AI model in the dashboard for writing** (the owner's call): the page scores from their own numbers with rules;
  the writing itself happens through Claude over MCP (`hook_score`, `title_lab`, `captions`, `weekly_digest`), which
  uses the same rules. "Ask Claude" buttons hand over the prompt.

## Earlier round (deck, cursor and charts, 2026-10-28)

- **A take you made must still be there after a refresh**, and play: it's kept in this browser (IndexedDB) and rebuilt
  from the library when it isn't, never "Couldn't play this take". Its player is our own: a turning disc with a ginger
  progress rim, the waveform as the scrubber. The voiceover being made uses the same deck.
- **Cursor: the white arrowhead the owner showed** (no "Studio" arrow). Every click drops a ginger water ripple (Miso's
  colour).
- **Settings' tabs are one centred pill bar**, sections sharing it equally, the white pill sliding to the open one.
- **Home → This week was cluttered**: now a ring per format, the next seven days as a strip, a slim Up next.
- **The YouTube and Instagram marks were rendering 4 px wide** in the sidebar (a flex item shrinking): fixed, and they
  have their own hover moves. Check a fix in the real frame, not only in isolation.
- **Charts must be visibly creative**: a dotted plot field, hatched areas, the latest value in a chip, numbers counting
  up, equalizer columns (fits an audio studio), tick-meter bars, a dot-size heatmap. Still flat.
- **Home's pixel desk is bigger** (up to 380 px) and handled with the header; gone on phones.

## Earlier round (premium pass, 2026-10-28)

- **Pixel icons didn't look good: undone.** The frame uses premium line icons (Phosphor, duotone) again. Keep a move per
  icon, but make it feel premium: smooth springy transitions that settle back, the soft duotone fill fading in on hover.
  Pixel art stays for the characters, the cursor option and the page scenes only.
- **Pixel loading wasn't intriguing.** Loading should be so fast you don't notice it: paint from the last copy at once,
  refresh behind it. A skeleton only shows if a wait passes ~180 ms, and it's a flat tile that breathes, nothing shiny.
- **Profile pictures are five pixel characters** you pick from (not a generated pattern).
- **A custom cursor**, ASCII-style as one option, changeable by the user.
- **Charts must look premium**: more contrast, a clear look, some life (lines drawing in, bars growing), still flat.
- **YouTube and Instagram marks must look right**, as their own logos, not generic outline icons.
- **YouTube and Instagram analytics in depth, down to each video**, every metric the APIs give.
- **Make what exists robust first**, then the new features (trend radar, watcher feeds, MCP for them: see ROADMAP →
  Next up).

## Earlier round (pixel pass)

- **The GPU once per page, at most.** The Voiceover page showed it three times (a "GPU is off" banner, a "GPU off"
  status and a "Start the GPU" button). A page that needs the GPU shows only its one action button ("Start the GPU", in
  place of Generate / Create); no banner, no status pill. The tool pages and the instant clone follow the same rule.
- ~~Pixel icons everywhere in the frame~~ (undone in the premium pass: line icons again).
- **Each icon has its own hover move**, the way the Settings gear turns: the house hops, the waves ripple, the cards
  shuffle, the folder's paper pops out, the mic bobs, the wand flicks, CC types itself, the sun rises, tiles light up in
  turn, rings go out, rows slide in, people hop, the calendar flips, the trophy wobbles, the gear turns in pixel steps.
- **Each page has its own calm pixel scene** next to its title (a mic and ripples on Voices, a corkboard on Posts, a cat
  asleep on a filing cabinet on Files, an on-air sign on Voiceover, a radio tower on Live…).
- ~~Loading is pixel~~ (replaced in the premium pass: fast first, a flat breathing tile only after 180 ms). Never shiny.
- **Files gets the most life**: cards build in from pixel blocks, folders tip open with a sheet of paper peeking out,
  covers zoom, audio waves dance on hover. Keep it light: transforms and opacity only, nothing for reduced motion.

## How to work with this owner

- They send screenshots and inspiration images. Build to the look they show, not to a reinterpretation. When they
  approved a mock (an artifact), the shipped page must look like that mock. They noticed when Grow first shipped in
  the old card style instead of the Flux mock they'd approved, and asked again.
- Say what's live and what isn't. A screenshot from before a deploy finished isn't a bug report on the new version.
- Anything left running in the background (a watcher waiting for a deploy, say) gets one plain sentence on what it is,
  and is stopped once its job is done. Finish a round by confirming the live site shows the change, not just the merge.
- Plan first when they ask for a plan; build when they say go. Ship every round (CLAUDE.md → Shipping).
- Never repeat the same control in several places. One home per thing (the GPU lives in Settings only).
- Their phrasing is casual. Act on the design and product asks, and keep replies professional.

## Look and feel

- **Matte black.** Pure, quiet blacks: canvas `#0a0a0a`, sidebar `#070707`, cards `#0f0f0f`, hairlines `#1c1c1c`. No
  blue-grey tints. Cards are sharp: small radii (10–12 px), crisp 1 px borders, no soft drop shadows.
- **The Flux look for Grow** (inspiration: the Flux analytics dashboard). Title and chips on one row, a KPI strip with
  hatched bars, step charts, a split bar with a table, a ranked table with gauges and live dots. Pinned rivals in the
  sidebar.
- **Pixel accents, calm and cozy.** Pixel-art details (the profile's pixel avatar, a small animated pixel scene) give
  the studio warmth. Animate gently (slow twinkles, a breathing glow), never busily, and respect reduced motion.
- **No dead space in cards.** A card in a row with a taller neighbour must not leave a big empty block: let the
  content (a chart) fill the height, or align the row to the top.
- **The logo is just a logo.** The Voicebox mark and name sit plainly at the top of the sidebar, not inside a button
  or a menu. Studio settings live in Settings.

## Layout and navigation

- Two modes, Create and Grow, with a switch at the top of the sidebar. The studio opens on Grow (`/` → `/analytics`).
- Search and Settings sit at the top right. Settings shows its icon and the word; on phones only the icon.
- The sidebar folds to an icon rail with a deliberate, nice-looking control (and ⌘B), not a bare chevron.
- Settings is tabs along the top (like a navbar), each a bento of cards. No "Settings" H1, the breadcrumb says it.
- Don't crowd one page with metrics: split into views, one question each.

## Data and cost

- Live numbers are read only while someone is on a Grow page with the tab visible and in use. Away = no API calls.
- Never pay for something that can be built: free tiers first (Cloudflare cron, R2), and say what something costs.
- Rivals: the five YouTube channels and four Instagram accounts the owner named (see `lib/live.ts`). Same metrics for
  them as for us, wherever the platforms make them public.
- Files of any size are saved through the upload endpoint (`save_file`), never pushed through MCP.
