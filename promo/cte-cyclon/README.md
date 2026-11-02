# Catch the Error: Cyclon, the AI phone (v2, 62 s, 1080×1920)

v2 of the Cyclon Reel after the owner's notes on v1 ("slop design", "the outro is shit", "the swipe and typing SFX
suck", "the script needs to feel professional"). Built on `docs/BRAND.md` and the skill's `references/craft.md`.

**The story** (one question: did the smartphone get it backwards?): claim (a YC startup thinks your iPhone has it
backwards) → pain (20 years of adapting; tap, swipe, switch, copy, paste, repeat) → the idea (the phone adapts to you;
their rule, quoted) → proof (the photos demo, an app built by asking and changed the same way, MCPs/APIs, background
work) → **the turn: "So, what's the catch?"** (the claim marked up like a proof: software for now, a Pixel 8a for the
first buyers, their own phone a concept for Q2 2027, with the source) → payoff (you'll stop opening apps, you'll just
ask) → a yes/no question → the brand ident.

**The look**: paper and ink with grain, one accent (the brand's red pen, `#D8463A`), line-art phones instead of glossy
mock-ups, every emphasis a pen gesture anchored to its words (`mark()`: ring, strike, underline; `pathLength=1`
so it draws exactly). Jost for statements, Instrument Serif italic for the idea word, Courier Prime for evidence,
Caveat for the pen's notes, Geist only inside the phone UI. `check_colors.py` clean.

**Motion**: words rise on their spoken times; objects arrive with anticipation and settle (`arrive()`); the hook's
phone turns upside down on "backwards"; the montage hits one action per word; the grid melts into one line you talk
to; the app assembles block by block on the beat; tiles fall away on the payoff. Transitions are motivated: a whip
in the direction of travel, a pull back, a zoom into the empty slot, and the brand's red marker stroke (`pen`).

**Sound**: the studio's SFX library (26 files) placed per motion, plus a synthesized pen-on-paper for every pen gesture;
the bed is nightfall (really 100 BPM) sped to 120 BPM and used as a story: under the hook, lifting for the demo, cut
dead before the catch, the quiet intro under the proof, the drop back for the payoff. Voice -15, music -27 ducked,
SFX -23 under a voice guard, master -14.2 LUFS, -1.3 dBFS peak.

**Voice**: Sparsh (`myvoice`, hype, 1.10x, best of 2) on Colab; all 17 lines heard word for word.

Build: `python3 tools/mkvo.py <voice dir>` → `node tools/render.js cues` → `python3 tools/audio.py <SFX wav dir>`
(needs `nightfall120.wav`: `ffmpeg -i nightfall.wav -af atempo=1.2 nightfall120.wav`) → `python3 tools/mix.py` →
`node tools/render.js out/video.mp4 4` → mux. Facts: the tweet, a Whisper transcript of Cyclon's launch video, and
cyclon.ai. The MP4 is in Files → Videos/Cyclon.
