# Posting: an AI fixed another AI's brain (Reel / Short, 89 s, 1080×1920)

File: VoiceBox Files → Videos/WeightSpace/cte-ai-edits-ai-weight-space.mp4 (m:01a1a2ca1d539a3f3411)

**Title (Shorts, under 50 chars, a question):** Can an AI fix another AI's brain?

**Caption / description:**
An AI just opened up another AI's brain and fixed it. No retraining.

MIT researchers gave GPT-6 Astra the raw weights of Qwen3.5-0.8B, a small model that gets stuck in thinking loops
(its own model card warns about it). On one problem it found the answer, 27, then wrote "Wait, I need to check if
N=27 is a perfect cube" 1,237 times and never answered. Astra traced the loop to one direction in layers 15 and 19
and subtracted it: 131,072 weights out of 800 million (0.016%). MATH-500 went from 7.9% to 48.1%, IFEval 21.0 to
62.3, and an independent rerun got 51.0%.

The catch: on Google's Gemma 3 270M, which rarely loops, it changed nothing. Editing removed what blocked a skill;
it couldn't add a skill that wasn't there. Early results: small models, one lab.

We checked: the two checkpoints differ in exactly 64 columns of each layer. The loop and the fixed answer are the
real outputs from the rerun's published samples.

Would you let an AI operate on another AI? Yes or no 👇

Credits: "Sparks of Weight-Space Programming" by Rikiya Takehi, Jayden Teoh, Alex Zhang and Omar Khattab (MIT CSAIL),
rikiyat.github.io/blog/weight-space-programming · Qwen3.5-0.8B model card (Qwen, Hugging Face) · edited checkpoint and
rerun: huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming

**Hashtags:** #AI #MachineLearning #LLM #Qwen #AIResearch #MIT #NeuralNetworks #CatchTheError

**Flags:** youtube.synthetic false, instagram.ai_generated false (the owner's rule).

**Cover idea:** the frame at 48.8 s (the real layer-15 and layer-19 matrices with the 64 red columns, "131,072") with
"0.016%" in big type. Or the loop ring at 29 s: "×1,200+".
