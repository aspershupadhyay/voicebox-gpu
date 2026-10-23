# Roadmap: what's being built, what's done

A working checklist so any session (or person) can pick up where the last one stopped. Tick a box in the same commit
that finishes it. Everything ships to `main`, which deploys the dashboard to Vercel and the worker bundle Colab pulls.

## Voice
- [x] Trained voices sound continuous (flow), speech-only loss, best-epoch pick, mixed-length clips (PR #2)
- [x] One trained model per person, served side by side on one worker; free-T4 float16 (PR #2)
- [x] Any number of trained voices (no cap on models a job can carry)
- [x] Your model → Collect: listen to a recording (or the files you picked) before it's added to the dataset; discard it
- [x] Clean-up: record in the browser, listen, then clean (not only upload)
- [x] Subtitles: "Generated voiceovers" tab lists every voiceover (play, subtitle, redo) + a Record tab

## Content manager (Notion-style spaces per platform)
- [x] Spaces: YouTube (Videos, Shorts, Posts), Instagram (Reels, Posts), X (Posts), TikTok, LinkedIn, Podcast;
      sidebar with counts, board-by-stage and list views per space, "new post" pre-set to the space
- [x] Cross-posting: one post, many targets; each target has its own status, publish time and live link
- [x] Delete posts from the list view (and the drawer, already there)
- [x] Storage: targets live in R2 (`workspace/spaces.json`) because the Appwrite posts table can't get new columns from
      this deployment's key (no tables.write scope); the legacy `platforms` array is kept in sync for filters and MCP
- [x] MCP: create/update posts with targets (spaces), list a space, upload a file to the workspace media (URL or
      base64), delete a file

## Reliability + polish (round 3)
- [x] Jobs survive a refresh / tab switch: every job started from the dashboard is remembered (localStorage), a tray
      follows it from any page (which also finishes archiving it), and each page picks its running job back up
- [x] Recordings are saved while you record (IndexedDB, every second): after a refresh or crash, the take is offered back
      to use, keep recording another, or discard (Voices, Your model, Clean-up, Subtitles)
- [x] Voice-reactive animation while recording (an orb that moves with your voice, a ring for the target length)
- [x] Sidebar: nav scrolls on its own, GPU card is one compact row (details on Engines), name / settings / sign out
      always visible

## Planner redesign (round 4)
- [x] GPU card: compact row in the sidebar that opens the full view (memory, mode, engines, RAM, disk) in place
- [x] Board: Activity is a button top-right that opens a side panel (no longer a list at the bottom)
- [x] Content planner: platform rail with real logos and brand colours; format tabs per platform; the next 7 days as a
      strip (empty days invite a plan, drag a drop to another day to reschedule); momentum (shipped this week vs the
      weekly goal per format, streak, next drop); gallery shaped by format (tall Reels/Shorts/TikTok, wide videos,
      square posts, text cards for X with a 280 counter, audio for podcasts) grouped Up next / In the works / Ideas /
      Shipped; Pipeline and List views; a "New" menu by platform and format
- [x] Weekly goals per format and when each target went live (posted_at) are stored with the targets in R2

## Notes for whoever picks this up
- Spaces are defined once in `mcp/lib/spaces.ts` (add a space there and it shows everywhere: sidebar, drawer, MCP enum).
- Platform logos, colours and format glyphs: `mcp/components/platform.tsx`. The Content page is `mcp/components/Content.tsx`; the drawer's "Publish to" editor is `TargetsEditor` in `Workspace.tsx`.
- Targets refresh every 15 s (not Appwrite Realtime): `mcp/components/useTargets.ts`.
- Job tracking: `mcp/components/jobs.ts` (localStorage, `useResumeJob`), the tray `JobTray.tsx`; `api()` tracks every
  POST to `jobs` / `myvoices`. Saved recordings: `takes.ts` (IndexedDB); `startRecording(scope)` in `Recorder.tsx`.

## Later (not started)
- [ ] Listen to a few of the cut training clips per session on Your model (the worker would push samples next to the zip)
- [ ] Per-target caption overrides (X 280 vs Instagram 2200)
- [ ] Teach trained voices non-verbal tags (laughs, breaths) from the recordings
- [ ] Streaming playback while a voiceover renders
