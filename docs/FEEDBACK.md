# The owner's feedback, kept

Every piece of design or product feedback the owner gives lands here, in the same pull request as the change it asked
for. Read this before touching the dashboard. Newest first. When something here conflicts with an older rule in
`docs/DESIGN.md`, this wins (and DESIGN.md is updated to match).

## Latest round (code execution with MCP, 2026-10-29)

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
