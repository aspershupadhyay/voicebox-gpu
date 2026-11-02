# Sound design (the "sound training")

The library is VoiceBox Files → **SFX** (92 files, about 82 distinct after duplicates). Every sound is mapped in
`sfx-library.json`: its family, what it's for, its length, its loudness and **where its peak is** (`peak_s`), so a
cue can put the loudest moment exactly on the frame it scores.

## The philosophy
1. **Sound emphasises motion.** Every sound exists because something on screen moves, appears, changes or builds.
   Nothing happens on screen → nothing happens in the sound. Name the thing it scores in the cue's comment.
2. **Three jobs, three families.**
   - **Whooshes → movement**: slides, pushes, zooms, the pixel wipe, a card flying in.
   - **Textures → things that appear without sliding**: pops, clicks, UI blips, ticks, typing, check marks.
   - **Risers & hits → anticipation**: a build into a reveal, then one deep hit as it lands.
3. **Never too loud.** Whooshes sit low, textures a little higher (they're short and need to be felt), the one hit
   highest. Nothing ever covers the voice: the voice is always on top.
4. **One big hit per scene.** Each scene has one loudest moment (usually the reveal word). Everything else under it.
5. **Scale matches the shot.** A full-screen move gets a bigger, deeper whoosh; a small chip gets a small pop.
6. **Diegetic first.** If the thing on screen makes a sound in the real world (keys typing, a click, a card flip, a
   message sent), use that sound.
7. **The whoosh peaks on the fastest frame.** Align the file's `peak_s` to the moment the motion is fastest (mid-move,
   or the cut itself for a wipe), so it swells with the move and settles with it. `tools/audio.py` does this for any
   cue with `peak: true`.
8. **Rows get a run.** Seven chips landing 0.06 s apart get seven soft pops 0.06 s apart, quieter than a single pop.

## Our library, by job (details in sfx-library.json)
| Job | First choice | Also |
| --- | --- | --- |
| Section change / pixel wipe | `swoosh-014-383768` (peak on the cut) + `ui-sound-374228` / `ui-sound-2-374229` under the blocks | `swoosh-2-359826`, `universfield-swoosh-023-454830` |
| A panel or card sliding in | `woosh-230554` | `swoosh-06-351021`, `swoosh-010-352856`, `swoosh-015-383769` |
| A snap or a quick shrink | `swoosh-sound-effect-for-fight-scenes-…-149890` | `simple-whoosh-382724` |
| Into the end card / a big move | `simple-whoosh-02-433006` | `whoosh-velocity-383019` (trim) |
| **The hit** (one per scene) | `whoosh-end-384629`: a sub boom, despite the name (trim `len` 1.6-2.6 s, fade 1 s) | |
| **Riser** into the hit | `shine-6-268910` reversed (`reverse: true, len: 0.5-0.9`, ending on the hit) | `benkirb-shine-1-268902` forward as a glint after |
| A number landing / a title | `creatorshome-sharp-pop-328170` | `pop-402324` |
| Chips, tiles, rows | `soft-pop-sfx-433612` (run), `ui-pop-up-2-197887` | `bubble_pop_1-476367`, `soft-subtle-ui-pop-sfx-348820`, `pop-2-269283` |
| Clicks, ticks, a ruler | `App_Click_1`, `universfield-computer-mouse-click-352734` | `immersivecontrol-button-click-sound-463065` (a 50 ms tick, one per word) |
| Typing | `keyboard-typing-fast-371229` (trim to the typing) | `iphone-keyboard-typing-…-336778` for a phone |
| Success / fail | `sfx-acceptation-363730` / `sfx-erreur-363728` | `marimba-bloop-3-188151` for a friendly yes |
| A tip or note pops up | `new-notification-013-363676`, `new-notification-09-352705` | `pop-up-notify-smooth-modern-332448_2_`, `bright-notification-352449` |
| Data, counters, progress | `ui-processing-data-sequence-…-230495` (trim) | sci-fi blips, sparingly |
| A voice / a signal | `sonar-ping-95840` (quiet) | |
| A refresh / a rebuild | `victorabdo-spin-232536` | |
| A page or card flip | `flipcard-91468` | |
| Music bed | `nightfall-future-bass-music-228100` (**100 BPM**: its kick measured 2026-11-02, not 134; sped up 1.2x with `atempo` it's a clean 120 BPM bed: intro 0-14 s, drop 16-46, breakdown 48-78, drop 80-112 at 120 BPM) | `88300` (~150 BPM, 2:59, steady), `gorila-315977` (~105 BPM, 1:55) |

Use the glitch and sci-fi sounds rarely: they read as "AI video", which is what we're trying not to look like.

## The mix (docs/REELS.md rule 13)
- Voice **-15 LUFS**, music **-27 LUFS** side-chain ducked by the voice (ffmpeg `sidechaincompress`, threshold
  0.015, ratio 4, attack 25 ms, release 350 ms), SFX stem **-23 LUFS**, master **-14 LUFS** with a limiter at -1 dBFS.
- Per cue: `tools/audio.py` first levels each clip (its loudest 50 ms to -12 dBFS) so the `db` you write is relative
  and comparable across files; then -2…-6 dB for hits and whooshes you want felt, -8…-14 for pops, ticks and rows.
- Measure, don't guess: `ffmpeg -i out/mix.wav -af ebur128 -f null -` for the master, and listen at the hits.

## How a cue is written (film.html cues())
```js
add(at('l20','risers')-.8, 'shine-6-268910', -6, {reverse:true, len:.8});      // swells into the word
add(at('l20','risers')-.02, 'whoosh-end-384629', -3, {peak:true, len:2, fade:1}); // the hit lands on it
add(T-.12, 'swoosh-014-383768', -1, {peak:true});                              // wipe: peak on the cut
```
`t` is when the clip starts, or with `peak: true` where its loudest moment lands (`at:` overrides that time).

## Tension and release (learned on the Director's Cut, 2026-11-02)
- **Music as a story beat, not wallpaper**: `MUSIC()` in film.html lists segments of the bed (where it plays, from which
  point of the track). The Director's Cut plays it under the hook, cuts it dead on "Strip the sound", and slams it back
  on the hit ("Start directing"), from a later, stronger point of the track.
- **The Shepard tone**: `SHEPARD()` in film.html, synthesized by `tools/audio.py` (seven sine octaves gliding up under
  a fixed bell curve: it rises for ever without getting higher). Fast (rate ~1.2 octaves/s, short) for a rewind; very
  slow (~0.08) and quiet as a drone that holds tension under a long stretch. It lives in the SFX stem, so the voice
  guard holds it under the voice.
- **Silence is the biggest hit**: cut everything (music, drone, SFX) ~0.4 s before the reveal line, then land it.

## The pen (learned on the Catch the Error Cyclon Reel, 2026-11-02)
The library has no pen-on-paper sound, and the brand's red pen draws in every scene. `promo/cte-cyclon/tools/audio.py`
synthesizes it per cue (`{synth: 'pen', len}`): band-passed noise whose loudness follows the stroke (one swell per loop
of a ring) with a paper-tooth grain. It's the one synthesized sound we keep: everything else comes from the library.
The owner disliked synthesized swooshes and clicky typing in v1: real library whooshes for moves, and a prompt that is
*said* (a live waveform and words on the voice's times), not typed.
