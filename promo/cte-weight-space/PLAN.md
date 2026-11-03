# Catch the Error: an AI fixed another AI's brain (weight-space programming)

**What it's for:** a Reel / Short (1080×1920, ~85 s + ident) on Rikiya Takehi et al.'s "Sparks of Weight-Space
Programming" (MIT CSAIL, Nov 2 2026): GPT-6 Astra read Qwen3.5-0.8B's raw weights, found what made it loop, and
changed 0.016% of them. MATH-500 7.9% → 48.1%.
**Who it's for:** people who follow AI news but have never trained a model. Weights are explained in one line.
**One question:** can an AI fix another AI just by reading its numbers?

**Format:** "they quietly did X" + the catch (formats.md #1), shaped as a case: the patient, the symptom, the
diagnosis, the operation, the result, the catch.
**World:** *the operating notebook*. The brand's paper and ink (the owner asked for it "like Cyclon"), but the
material is the model itself: an ink neural-network graph whose nodes are dots, and the **real** weight matrices of
Qwen's layers 15 and 19 (downloaded from Hugging Face, rendered as ink on paper). The red pen is the scalpel: the
edits are red dots, exactly like the logo's red letters, and the pen's ring (the logo's ring) is also the shape of
the thinking loop, so the brand's own mark tells the story: the loop is a ring; the fix is a ring caught by the pen.
Ink scenes (dark) for the loop and the catch, paper for everything else.
**Anchor image:** the real 1024 × 3584 matrix of layer 15, and 64 thin red columns lighting up in it: the edit.
**The unique thing (one):** the real output. Qwen's own MATH-500 answer to problem 515 (from the rerun's published
samples) found the answer, 27, then wrote "Wait, I need to check if N=27 is a perfect cube." 1,237 times and never
answered. The edited model's answer to the same problem ends `\boxed{27}`.

## Triple hook (first 2 s)
- **See:** frame 1 the ink network is already firing (pulses on its edges); a red dot cluster is being circled.
- **Read:** "An AI just opened up another AI's brain" in big type.
- **Hear:** the voice from 0.05 s, a soft pulse tick under the network, the pen on "fixed".

## Beats
| # | Voice | Scene type | Picture (on which word) | Sound |
| --- | --- | --- | --- | --- |
| l01 | An AI just opened up another AI's brain, and fixed it. | full | ink network firing; on *fixed* the pen rings a red cluster | ticks, pen |
| l02 | No retraining. It changed 0.016% of its weights. | captions + UI | *retraining* struck; 10,000 dots, 2 turn red; big 0.016% | strike pen, pops |
| l03 | And it got six times better at math. | half | REAL: the tweet clipping, pen under "up to 6x"; 7.9 → 48.1 bars | flip, hit |
| l04 | Every AI is a giant web of numbers, called weights. | full | push into one edge of the network: it becomes a number (real: 0.0236) | whoosh, pop |
| l05 | This one, Qwen 3.5, has 800 million. | full | the network becomes the REAL layer-15 matrix; counter to 800,000,000 | ticks run |
| l06 | And its own model card warns: it gets stuck in thinking loops. | half | REAL: Qwen's model card line, pen under "prone to entering thinking loops" | flip, pen |
| l07 | On one problem, it found the answer, 27. | full (ink) | REAL: the problem; the answer line, 27 ringed | pen |
| l07b | Then it wrote "wait, I need to check" 1,200 times. And never answered. | full (ink) | REAL: the loop lines scroll faster and faster around the ring; counter 1,200+; stops dead at TOKEN LIMIT | accelerating ticks, a dead stop |
| l08 | 85 of its first 96 practice answers hit the limit. | captions + UI | 96 cells, 85 cut off | soft pop run |
| l09 | So researchers at MIT handed the raw weights to GPT-6 Astra. | half | REAL: the blog's title + MIT CSAIL; numbers stream into a card "GPT-6 Astra" | whoosh |
| l10 | No training allowed. Just: make it better at math. | captions + UI | the real task line from the logs, typed card; ✕ training ✕ gradients | pen strikes |
| l11 | Astra traced the loop to one direction, written by layers 15 and 19. | full | 24 layer columns; a scan; 15 and 19 light; a red arrow (the direction) through them | scanner, pops |
| l12 | And subtracted it. 131,072 weights, out of 800 million. | full | REAL matrices L15/L19: 64 red columns each light up; counter | pen, hit |
| l13 | Same model. Same settings. Math went from 7.9% to 48. | full | hand-plotted bars 7.9 → 48.1; REAL: same problem now ends \boxed{27} | ticks, the hit |
| l14 | Instruction following tripled. An independent rerun got 51. | half | IFEval 21.0 → 62.3; REAL: the rerun note on the model page, 51.0% ringed | pen |
| l15 | So, what's the catch? | captions (ink) | silence, the logo's ring around *catch* | silence, pen, hit |
| l16 | They tried it on Google's Gemma… Nothing moved. | captions + UI | Gemma line flat: 6.8 → 7.0 / 7.6 / 7.7 / 7.0 | dull tick |
| l17 | Editing removed what blocked a skill. It couldn't add one that wasn't there. | half | a ring (the loop) cut open ✓; an empty slot ✕ | pen tick, pen X |
| l18 | And it's early: small models, one lab. | captions + UI | proof marks: 0.8B · 270M · MIT CSAIL · "very early results" | pen |
| l19 | But their bet is big: AIs that read weights like code, and fix them. | full | the matrix becomes lines of code; one line struck and rewritten in red | whoosh, riser |
| l20 | Would you let an AI operate on another AI? Yes or no. | captions + UI | ballot | pops, pen |
| ident | | | the brand ident | |

## Facts and sources (checked 2026-11-03)
- Blog: rikiyat.github.io/blog/weight-space-programming (Takehi*, Teoh*, Zhang, Khattab, MIT CSAIL, Nov 2 2026).
  0.016% of weights; MATH-500 7.9 → 48.1 (50 forward passes); IFEval 21.0 → 62.3 (≈3×); GSM8K 13.8 → 67.1;
  85 of its first 96 practice answers ran to the 32,768-token limit; "one direction written by the MLPs of layers 15
  and 19", subtracted from 64 output columns in each (131,072 weights); no training, no gradients. Gemma 3 270M:
  rarely loops (8.5%), Astra could not improve it (6.8 → at best 7.7); "Editing weights could remove an obstacle that
  hid an ability, but it could not add an ability the model lacked." Early results.
- Qwen3.5-0.8B model card: "more prone to entering thinking loops compared to other Qwen3.5 models".
- huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming: independent rerun 51.0% MATH-500 (2,000
  generations, H200); only layers 15 and 19 `down_proj` differ.
- **We checked ourselves:** diffing the two checkpoints' `down_proj` tensors gives exactly 64 changed columns in each
  layer. The loop text is from the rerun's published `eval/samples_base_math500.jsonl` (problem 515: 1,237 repeats
  of the line, no final answer); the fixed one from `samples_edited_math500.jsonl` (`\boxed{27}`).
- "Six times" = 7.9 → 48.1 (6.1×), the tweet's "up to 6x".

## Real media (credited on screen, small)
The tweet (the owner's screenshot), the blog's title and TL;DR, Qwen's model card warning, the edited model page's
rerun note (screenshots, toned to ink on paper so nothing off-brand like the card's purple reaches the frame), the real
layer-15 and layer-19 weight matrices, the real loop text and the real fixed answer.
