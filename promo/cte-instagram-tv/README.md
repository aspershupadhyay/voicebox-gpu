# Catch the Error: Instagram on Apple TV (57 s, 1080×1920)

News Reel on Instagram's Apple TV app (live Oct 23, 2026; @instagram posted it Nov 3), built on `docs/BRAND.md`, the
video-director skill and the Cyclon kit (`promo/cte-cyclon/`).

**The story** (one question: is Instagram coming for your TV?): claim (Instagram landed on the biggest screen in your
house: Apple TV, US only) → the quiet launch (Oct 23, the App Store listing) → the real post, ten days later (the
owner's screenshot, the pen rings "US only") → the tour (the app opens from the TV's home screen; the focus walks
Reels, longer videos, live shows on the voice; a remote clicks) → the handoff (our Reel jumps from the phone to the TV,
the couch rises) → what's missing (posting, DMs, the photo feed struck out: built to watch) → the pattern (the fourth
TV in a year, a timeline) → **the turn: "So, what's the catch?"** (IGTV, June 2018 to March 2022, its screen switches
off; no date outside the US) → payoff, labelled as our take (this time it's Reels, it wants YouTube's spot on your
couch) → a yes/no question → the brand ident.

**The look**: paper and ink, the red pen, and a TV drawn in code with a TV-style interface (a focus engine that lifts
the focused tile with a light edge, a sheen and a little parallax; a top shelf; the app's tabs and rows). No Apple or
Instagram logos: the app is a drawn camera glyph. The Reel playing on the TV is **our own** (Catch the Error: Cyclon,
Files → Videos/Cyclon): `sh tools/frames.sh <cyclon.mp4>` makes `assets/reel/` (0-14 s at 30 fps) and `assets/thumb/`.
The film preloads and decodes every frame, and `seek()` waits for the images, so no frame renders blank.

**Sound**: 23 files from the SFX library placed per motion (a spin on the phone-to-TV morph, ticks and a soft UI tone
for each focus move, a remote click, a notification as the post lands, the "off" sound as IGTV dies, the sub hit on
the catch) plus the synthesized pen. Nightfall at 120 BPM in four segments (cut dead before the catch). Voice -15,
music -27 ducked, SFX -23 under the voice guard, master -14.3 LUFS, -2.0 dBTP.

**Voice**: Sparsh (`myvoice`, hype, 1.10x, best of 2) on Colab L4; l08 re-voiced with "DMs" said as "dee emms"
(best of 3) after Whisper heard "demiss". Every line heard word for word.

Build: `sh tools/frames.sh <cyclon.mp4>` → `python3 tools/mkvo.py <voice dir>` → `node tools/render.js cues` →
`python3 tools/audio.py <SFX wav dir>` (aliases like `tick`, `sharp-pop` as in `promo/cte-cyclon/`, plus
`nightfall120.wav`) → `python3 tools/mix.py` → `node tools/render.js out/video.mp4 4` (167 s on 4 cores) → mux.
The MP4 is in Files → Videos/Instagram on Apple TV.
