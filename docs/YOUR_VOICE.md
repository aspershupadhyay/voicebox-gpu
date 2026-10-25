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

1. **Collect** (dashboard → **Voice model**). *Read along* shows one line at a time from a script written like a tech
   video (hooks, explanations, numbers, questions, asides) plus tongue-twisters that cover every English sound; press
   space for the next line and record 5-15 minutes per session; **P** (or the Pause button) holds the take while you
   breathe or grab water, and nothing is recorded or sent until you resume. Stopping never sends anything: each take
   lands in a list where you listen, remove what you don't want, record more, and add them all as one batch. Or
   *Upload* (pick or drop as many files as you like) long recordings of only you talking. The
   worker removes noise (never "restores" the tone, so the model learns your real voice), Whisper cuts clips at
   sentence ends in a deliberate mix of lengths (about 4, 9 and 15 s, up to 20 s, so long ones hold two or three
   sentences and the model hears how you move between them; a silence over 1.2 s always ends a clip), every clip is
   brought to the same loudness (-20 dB speech level), and noisy, echoey, muffled, clipped or mis-timed clips are dropped.
   A file that can't be read is skipped with a note instead of failing the batch, and if nothing at all is usable the
   error says why clips were dropped (your takes stay saved on the device to try again). The meter shows minutes collected: 15 works, 30 is
   good, 60 is best. Same mic and room every session.
   **Train automatically when added** (on by default, next to *Add to dataset*) starts step 2 by itself as soon as a
   batch is stored and the dataset has 15+ minutes, so you can upload and walk away. It trains on the whole dataset,
   replaces that person's current model, and is skipped if a training run for that person is already going. MCP:
   `voice_dataset` with `auto_train: true`.
2. **Train** (same page, **Train my voice**). The GPU worker that's already running in Colab does it: it pauses other
   jobs, fine-tunes Orpheus 3B with a LoRA adapter (Unsloth), voices a test line you can play on the page, and saves the
   adapter (a few hundred MB) to your R2 bucket. What makes it sound like you talking rather than reading:
   - **Flow.** About half the clips are trained with the clip you said just before them as context, and the model is
     then used the same way: each sentence is voiced with the one before it, so pitch, pace and energy carry through a
     whole script instead of resetting at every sentence. Long scripts take longer because sentences go in order;
     `flow: false` turns it off for a quick draft.
   - **Speech-only loss.** It learns how you sound, not to predict the script.
   - **Same spoken form.** Transcripts go through the same tech lexicon as the scripts you voice later ("GPU" is learnt
     as "G P U"), so terms come out the way you say them.
   - **Best epoch, by listening.** A few clips are held out. After training, every epoch's adapter voices those
     sentences; Whisper checks the words landed and a speaker model compares each take with your real recording of
     that same sentence. The epoch that sounds most like you saying the right words is kept (the page lists each
     epoch's scores), not the last one, which over-fits on a small dataset.
   - **Faster each time.** Each session's clips are turned into codec tokens once and cached on the worker, so training
     again skips that step; clips of similar length are batched together, 2-4 at a time on 24 GB+ cards.
   Datasets collected before this update still train with flow (neighbouring clips are found from the file names), but
   re-running collection on your original recordings gives the longer, multi-sentence clips too. Models trained before
   this update keep working with flow off; train again to turn it on. No Hugging Face account needed. About 1.5-3 hours on a free
   T4, under an hour on an L4. The first run also installs the training tools (~7 min). Keep the Colab tab open until it's done.
3. **Use it.** Nothing to set: the trained model is the **myvoice** engine everywhere (Voiceover, Settings, MCP
   `engine: "myvoice"`, `voice: "<your name>"`) right away. The worker fetches it from R2 the first time a job asks for
   it and keeps it. Training again replaces only your model.

   **Two of you, two models.** Each person picks their own name at the top of the Voice model page (it opens on yours
   when you're signed in) and collects and trains their own. Both models live side by side: in Voiceover, *Your model*
   lists every trained voice with its test line; in Settings, *This engine and voice just for me* makes your trained
   voice your default without changing the other person's; MCP clients see both under `my_voices` → `trained`.
   To serve an Orpheus fine-tune from Hugging Face instead, set `MY_VOICE_MODEL` (the repo) and `MY_VOICE_SPEAKER` on
   Vercel; that takes priority.
4. **Benchmark** (same page, or the `benchmark_voices` MCP tool). The same unseen sentences in your model, your Qwen
   and Chatterbox clones, and optionally an Orpheus preset, scored identically: script accuracy, voice match against
   your real recording, naturalness (UTMOS) and speed. Listen side by side, then make the winner your default.

**Clarity defaults.** Your model voices at temperature 0.5 (0.45 calm, 0.6 hype) with repetition penalty 1.12:
steadier and crisper than Orpheus's 0.65. Each finished line also goes through a *studio polish* (24 kHz codec ->
44.1 kHz detail) that is kept only when it still sounds like you (voice match >= 0.9 against the unpolished take) and
at least as natural; set `post.enhance: false` to skip it.

5. **Your voice in Kokoro** (same page, card 4). Kokoro is the engine behind af_heart: tiny, steady, instant. This searches
   for the mix of Kokoro's voices that sounds most like your recording (every English voice auditioned against you, then
   a hill-climb over the mix, 12-48 rounds), checks it still speaks every word clearly, and saves it as voice
   `kv_<name>` under Kokoro in Voiceover. It's the closest Kokoro can get to you, not a clone: your trained model copies
   you more exactly, Kokoro gives you af_heart's clarity and speed for drafts and long reads.

**Between sentences** every engine now pauses the way a presenter does: longer after a question than after a full stop,
shortest after a comma, and a longer breath at a blank line (a new paragraph). `[pause]` markers still win.

The review keeps learning per voice as you use it, so whichever engine wins also gets its best settings over time.
