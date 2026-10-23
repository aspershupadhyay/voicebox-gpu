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
- [ ] Spaces: YouTube (Videos, Shorts, Posts), Instagram (Reels, Posts), X (Posts), TikTok, LinkedIn, Podcast;
      sidebar with counts, board-by-stage and list views per space, "new post" pre-set to the space
- [ ] Cross-posting: one post, many targets; each target has its own status, publish time and live link
- [ ] Delete posts from the list view (and the drawer, already there)
- [ ] Storage: targets live in R2 (`workspace/spaces.json`) because the Appwrite posts table can't get new columns from
      this deployment's key (no tables.write scope); the legacy `platforms` array is kept in sync for filters and MCP
- [ ] MCP: create/update posts with targets (spaces), list a space, upload a file to the workspace media (URL or
      base64), delete a file

## Later (not started)
- [ ] Per-target caption overrides (X 280 vs Instagram 2200)
- [ ] Teach trained voices non-verbal tags (laughs, breaths) from the recordings
- [ ] Streaming playback while a voiceover renders
