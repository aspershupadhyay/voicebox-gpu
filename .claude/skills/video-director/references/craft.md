# Craft: how the best creators make a short look directed (learned 2026-11-02)

The owner's ask: "learn how other people are creating and make it more amazing… design rules, psychology, font pairing,
visual and focal point… a beautiful storyteller visually, in text and in speech… how the audience will feel." This is
what we took from the research and from studying the strongest explainers (Vox and Johnny Harris's map-and-anchor
style, Kallaway's frameworks, devmonk's one-world diagrams, Pixar's Luxo Jr. ident). Read it with the style guide;
the owner's feedback (`docs/FEEDBACK.md`) wins over both.

Sources: [hook engineering, first 3 s](https://dev.to/bulkdl/hook-engineering-the-science-of-the-first-3-seconds-in-short-form-video-2026-2jp9),
[Shorts hook formulas](https://www.opus.pro/blog/youtube-shorts-hook-formulas),
[animation principles, UW CSE 457](https://courses.cs.washington.edu/courses/cse457/01sp/lectures/16-animation-principles.pdf),
[Luxo Jr. rig notes](https://media.confetti.ac.uk/tsvetinad-xs20-yr2/?p=2210),
[typography in motion design](https://www.rmcad.edu/?p=87077), [font pairs](https://blog.wave.video/blog/font-pairs/),
[Johnny Harris's visual storytelling](https://medium.com/@LMK_writing/how-johnny-harris-mastered-visual-storytelling-on-youtube-343ddf9160ec),
[how to write a video like Vox](https://recapio.com/digest/how-to-write-a-video-like-vox-by-k-j-grey).
Much of what's published about retention is practitioner data, not controlled studies: treat numbers as directional
and trust our own analytics (`analytics`, Radar) over anyone's percentages.

## 1. Story (the spine before any pixel)
- **One question carries the video.** The hook opens a gap the viewer needs closed ("is the iPhone the wrong
  design?"); every beat narrows it; the payoff closes it and the CTA opens a new one ("would you switch?").
- **Shape: claim → tension → proof → turn → payoff.** The turn is where trust is earned: the honest catch, the
  limitation, the thing the hype left out. On our channel the turn has a name: *what's the catch?*
- **Specific beats general.** "Nine photos from yesterday's chat" beats "it finds your photos". A number, a name, a
  real prompt, a real date. Every claim is from a source we've read; estimates and opinions are said as such.
- **Relatable pain before the product.** Show the viewer their own life first (tap, swipe, copy, paste, repeat), so
  the product answers a feeling, not a feature list.
- **Visual anchor, then bridge** (Johnny Harris): each idea gets one strong image the viewer remembers (the anchor);
  between anchors, quick connective motion carries the line (the bridge). Never two anchors fighting in one frame.

## 2. Psychology (how the audience feels, beat by beat)
- **First 3 seconds decide it.** On frame 1: motion already happening, the text hook already on screen, the voice
  already speaking. No logo, no title card, no fade from black at the start: the brand comes at the end.
- **Curiosity gap > information.** Say enough to make them need the rest: the hook names the stakes, not the answer.
- **Pattern interrupts on a schedule.** Something changes every 1-2 s (a cut, a new element, a camera move, a sound),
  and every ~8-10 s the *mode* changes (paper → ink scene, wide → close, voice → a beat of silence) so attention
  re-sets. Monotony is what makes people swipe, not slowness.
- **Contrast creates attention.** Big next to small, dark next to light, still next to moving, silence next to a hit.
  The eye goes to the one thing that differs.
- **Earn the payoff with a breath.** A 0.3-0.6 s silence before the reveal makes the reveal land; it's worth its time.
- **Respect = trust = follows.** Honest catches, credited sources, no fake urgency. Viewers follow people who
  told them the truth about the hype.
- **Comments are a design surface.** End on a binary question the viewer can answer in one word ("would you
  switch?"), not a vague "thoughts?".

## 3. Visual design
- **One focal point per frame.** Before a scene is built, name the one thing the eye should land on. Everything else
  is smaller, dimmer or still. If two things compete, delete one.
- **Hierarchy by contrast, in this order:** size (the hero is 3-5x the support), then value (ink vs grey), then
  colour (the accent, used rarely), then motion (the thing that moves is the thing that's read).
- **Accent discipline.** Neutrals do 90% of the work. The accent marks *meaning* (the error, the catch, the answer),
  never decoration. Banned colours: the style guide → "Banned colours".
- **Rule of thirds and the safe area.** In 9:16, the hero sits around y 600-1200, centred on x 540; captions ≈ y
  1500; nothing important below ~y 1330 on the right (the app's buttons) or under the top ~200 px (the UI).
- **Negative space is a feature.** One idea per frame, with air around it, reads as expensive. Clutter reads as AI.
- **A visual language you can name.** Each video has one: for Catch the Error it's *the editor's desk*: paper, ink and
  a red pen that circles, underlines, strikes through and ticks (`docs/BRAND.md`).
- **Real over decorative.** Show the real thing: the real quote, the real prompt, the real numbers. Generic icons
  are fine as props; never stock-ish filler, never another company's UI or logo.

## 4. Type and font pairing
- **Two families plus a mono, each with one job.** A display serif for the idea (emotion, the word you'd underline),
  a clean sans for statements (clarity), a mono or typewriter for facts and labels (evidence: dates, prompts, sources).
- **Contrast, not similarity.** Pair a serif with a sans, never two near-identical sans or two slab serifs. Make the
  emphasised word much bigger or a different family, not just bold.
- **Read time.** On screen at least as long as it takes to read twice (~0.3 s per short word, 1.2 s minimum for a
  phrase). Short lines: 2-5 words per line in vertical.
- **Typography moves with the voice.** Words land on their spoken time; the idea word lands last and biggest.

## 5. Motion (Disney's principles, for graphics)
- **Easing, always.** Nothing moves linearly except a scroll. Ease-out for arrivals (expo), ease-in for exits,
  ease-in-out for camera moves.
- **Anticipation → action → follow-through.** Before a big move, a small move the other way (a 6-10% dip); after it,
  a settle (overshoot ≤ 4%, one wobble). This alone makes graphics feel animated instead of tweened.
- **Squash and stretch, keep the volume.** When something lands, scale-y down and scale-x up by the same factor;
  in flight, stretch along the motion. For characters and the logo, not for body text.
- **Overlap.** Parts of a group arrive 40-80 ms apart, never all at once; loose parts trail the leader.
- **Arcs.** Things travel on curves, not straight lines; a hop is a parabola.
- **Staging and the camera.** The camera moves *toward* what matters (push in on the reveal), pulls back for
  context, and drifts slowly so the frame is never dead. Transitions are motivated: something in frame A becomes
  something in frame B (a match cut), the move continues through the cut (a whip in the direction of travel), or a
  shape wipes (our red pen stroke).
- **Timing is rhythm.** Hits on beats (120 BPM = a beat every 0.5 s); cuts on spoken words.

## 6. Sound
- The voice leads; music is a bed with a shape (enters, drops out for the turn, returns for the payoff); every SFX
  scores something that moves (the sound-design reference has the library map). Real, physical sounds for real
  objects (a pen on paper, a tap, a whoosh with the move), never synthesized beeps standing in for them.

## 7. The brand outro
- Every video ends on the Catch the Error ident (`promo/brand/`, `docs/BRAND.md`): a 4-5 s character animation of
  the logo, then a still hold. Before it: the binary question. The ident is the sign-off, like a studio's ident before
  a film: it never changes from video to video, so it becomes recognisable.

## 8. The checklist we hold ourselves to
1. Can you say the video's one question in one sentence?
2. Does frame 1 have motion, text and voice?
3. For each scene: what is the focal point? Is anything competing with it?
4. Does something change every 1-2 s, and does the mode change every ~10 s?
5. Is there a turn (the catch), and is it honest and sourced?
6. Do the type families each do one job?
7. Does every motion ease, anticipate and settle?
8. Does every sound score something on screen?
9. `check_colors.py` clean?
10. Does it end on a one-word question and the brand ident?
