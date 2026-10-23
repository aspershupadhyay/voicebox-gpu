# Your voice, studio sound

How to get a clone that sounds like *you* presenting a tech video, and how to publish it.

## 1 · Record the reference (Voices page)

The cloner copies **how** you speak as well as how you sound, so record the way you want the video to sound.

- **Room:** small and soft (curtains, a bed, a wardrobe of clothes). No fan, AC or music. The clone copies the room too.
- **Mic:** any decent USB or lavalier mic beats a laptop mic. A hand's width away, slightly off to the side.
- **Delivery:** confident, a slight smile, explaining to one friend. Read the full card (15–20 s).
- **Check the result:** the saved voice shows its level. If it warns *quiet* or *clips*, record again.
- **Make a few:** `me_tech` (default explainer), `me_hype` (hooks and launches), `me_calm` (deep dives). Pick per video.

**Bad mic?** Leave *Enhance voice recordings* on (Settings). Before cloning, the studio enhancer removes background
noise and room echo and rebuilds the crisp detail a laptop or phone mic loses. The voice card shows *studio-enhanced*
when it ran. A quiet room still helps most; the enhancer can't undo clipping, so keep the level out of the red.

## 2 · Generate

| Setting | Tech explainer | Short / Reel hook |
|---|---|---|
| Engine | `qwen` with your voice (Hindi lines go to Chatterbox automatically) | `qwen` |
| Style | `tech` | `hype` |
| Temperature | 0.7–0.8 (steadier, more "anchor") | 0.85–0.9 |
| Publish for | YouTube | Shorts / Reels / TikTok |
| Best of | 3× for the final render, 1× while drafting | 3× |
| Subtitles | on (gives the script match and voice match scores) | on (1–3 word pop-up captions) |

Keep the same `seed` for a whole video so the voice stays consistent. Use `[pause 0.6]` before a reveal and
`[beat]` after a question. Add brand and product names under **Your pronunciations** (`Kubernetes = koo-ber-net-eez`).

**Reading the scores:** *script match* ≥ 95% means every word landed. *Voice match* is a speaker-embedding score:
0.86+ is the same speaker, and a good clone of a clean recording usually lands at 0.90–0.97. If it's low, re-record
the reference in a quieter room before tuning anything else.

## 3 · Re-voice (when you want your exact delivery)

Record the take yourself with your timing and emphasis, even on a phone, then use **Re-voice a take** on the
Voices page (or the `revoice` MCP tool). You get it back in your clean recorded voice, the same length, so it drops
straight onto the edit.

## 4 · Your own recordings, cleaned up

Recorded the voiceover yourself on a cheap mic? **Clean-up** (or the `clean_audio` MCP tool) makes it
sound studio-grade and masters it for the platform, at the same length so it stays in sync with your video.
*Denoise only* keeps your exact tone; *Studio* also restores detail.

## 5 · Your own model (beyond cloning)

Zero-shot cloning copies about 20 seconds of you. A trained model learns how you actually talk, from 30-60 minutes of it.
Everything below runs on free compute.

1. **Collect** (dashboard → **Your model**). *Read along* shows one line at a time from a script written like a tech
   video (hooks, explanations, numbers, questions, asides) plus tongue-twisters that cover every English sound; press
   space for the next line and record 5-15 minutes per session. Or *Upload* long recordings of only you talking. The
   worker removes noise (never "restores" the tone, so the model learns your real voice), Whisper cuts 2-12 s clips at
   sentence ends, and noisy, clipped or mis-timed clips are dropped. The meter shows minutes collected: 15 works, 30 is
   good, 60 is best. Same mic and room every session.
2. **Train** (same page, **Train my voice**). The GPU worker that's already running in Colab does it: it pauses other
   jobs, fine-tunes Orpheus 3B with a LoRA adapter (Unsloth) on every clip, voices a test line you can play on the page,
   and saves the adapter (a few hundred MB) to your R2 bucket. No Hugging Face account needed. About 1-2 hours on a free
   T4, less on an L4. The first run also installs the training tools (~7 min). Keep the Colab tab open until it's done.
3. **Use it.** Nothing to set: the trained model is the **myvoice** engine everywhere (Voiceover, Settings, MCP
   `engine: "myvoice"`) right away, and a fresh worker downloads it from R2 at start-up. Training again replaces it.
   To serve an Orpheus fine-tune from Hugging Face instead, set `MY_VOICE_MODEL` (the repo) and `MY_VOICE_SPEAKER` on
   Vercel; that takes priority.
4. **Benchmark** (same page, or the `benchmark_voices` MCP tool). The same unseen sentences in your model, your Qwen
   and Chatterbox clones, and optionally an Orpheus preset, scored identically: script accuracy, voice match against
   your real recording, naturalness (UTMOS) and speed. Listen side by side, then make the winner your default.

The review keeps learning per voice as you use it, so whichever engine wins also gets its best settings over time.
