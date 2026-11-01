# Rewind: a 40-second film for Prompt Motion

- `film.html`: the film (1920×1080). Every style is computed from time in `window.seek(t)`.
- `story.html`: the Instagram Story (1080×1920, 10 s).
- `audio.html`: the score and sound design (Web Audio, OfflineAudioContext → WAV).
- `rewind-storyboard.png`: 26 key frames with timecodes. `prompt-motion-rewind-cover.png`: the Reel cover.
- `POSTING.md`: caption, pinned comment, DM text, and the CATCH → DM automation setup.

The rendered MP4s and the WAV are in VoiceBox Files → Videos/Prompt Motion Rewind (not in git).
They need the build's assets (fonts, thumbnails from prompt-motion.com) next to them to re-render.
