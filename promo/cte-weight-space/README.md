# Catch the Error: an AI fixed another AI's brain (89 s, 1080×1920)

On Takehi et al.'s "Sparks of Weight-Space Programming" (MIT CSAIL, Nov 2 2026). Plan, beats and sources: `PLAN.md`;
posting: `POSTING.md`.

**World:** the operating notebook. The brand's paper and ink (the owner asked for it like Cyclon), an ink neural
network whose edited nodes are the logo's red dots, and the pen's ring (the logo's ring) as the thinking loop.

**Real media:** the owner's screenshot of the post; the blog's title; Qwen's model card warning and the rerun note
(screenshots toned to ink on paper); the **real** `down_proj` matrices of layers 15 and 19, fetched with HTTP range
requests from both checkpoints on Hugging Face and diffed (exactly 64 changed columns per layer, drawn in red); the
**real** looping output for MATH-500 #515 (the line repeated 1,237 times, no answer) and the edited model's
`\boxed{27}` from the rerun's published samples (`real.js`).

**Sound:** library SFX per motion, the synthesized pen; the gorila bed in four segments runs under the loop and cuts
dead on the token limit (v2: the Shepard drone and the tick run were removed at the owner's note), then cuts before
the catch. -14.2 LUFS, -2 dBTP.

**Voice:** Sparsh (myvoice, hype, 1.08x, best of 2; two lines re-taken at best of 3) on a Colab L4 (Cerebrium's
first myvoice install hung with an empty log, so we switched).

Build: `python3 tools/mkvo.py <voice dir>` → `node tools/render.js cues` → `python3 tools/audio.py <SFX wav dir>`
(aliases: `tick`, `sharp-pop`, `soft-pop`, `subtle-pop`, `data`, `erreur`, `accept`, `gorila`… see the cues) →
`python3 tools/mix.py` → `node tools/render.js out/video.mp4 4` → mux.

**The Shorts cut (61 s):** the same film with fewer lines. Copy the kit to a scratch folder, keep only
`l01 l02 l06 l07 l07b l09 l11 l12 l13 l15 l16 l17 l20` in `tools/script.json`, and build as above: a missing line's
scene and cues drop out by themselves (its times are NaN) and the music segments refit.
**The cover:** `node tools/render.js stills -1` (the film draws it at t < 0). Posted as "GPT-6 Astra Rewired Another
AI. Would You?" (Radar: seo_score 72), YouTube Short 1:00 PM and Instagram Reel 1:30 PM IST, Nov 4 2026.
