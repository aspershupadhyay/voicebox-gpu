// In-app writing guides. Sourced from each model's documentation and what we measured on this worker.
export type Guide = { title: string; tagline: string; sections: { h: string; body: string[]; example?: string }[] };

export const LANGUAGES: { code: string; name: string; engines: string[]; kokoro?: string[]; script?: string }[] = [
  { code: "en", name: "English", engines: ["orpheus", "chatterbox", "kokoro", "whisper"], kokoro: ["af_heart", "af_bella", "am_michael", "am_fenrir", "bf_emma", "bm_george"] },
  { code: "hi", name: "Hindi", engines: ["chatterbox", "kokoro", "whisper"], kokoro: ["hf_alpha", "hf_beta", "hm_omega", "hm_psi"], script: "Devanagari (हिन्दी)" },
  { code: "es", name: "Spanish", engines: ["chatterbox", "kokoro", "whisper"], kokoro: ["ef_dora", "em_alex"] },
  { code: "fr", name: "French", engines: ["chatterbox", "kokoro", "whisper"], kokoro: ["ff_siwis"] },
  { code: "it", name: "Italian", engines: ["chatterbox", "kokoro", "whisper"], kokoro: ["if_sara", "im_nicola"] },
  { code: "pt", name: "Portuguese", engines: ["chatterbox", "kokoro", "whisper"], kokoro: ["pf_dora", "pm_alex"] },
  { code: "ja", name: "Japanese", engines: ["chatterbox", "kokoro", "whisper"], kokoro: ["jf_alpha", "jf_gongitsune", "jm_kumo"], script: "Japanese script (kana/kanji)" },
  { code: "zh", name: "Chinese (Mandarin)", engines: ["chatterbox", "kokoro", "whisper"], kokoro: ["zf_xiaobei", "zf_xiaoxiao", "zm_yunjian", "zm_yunxi"], script: "Simplified Chinese" },
  { code: "de", name: "German", engines: ["chatterbox", "whisper"] },
  { code: "ar", name: "Arabic", engines: ["chatterbox", "whisper"], script: "Arabic script" },
  { code: "ru", name: "Russian", engines: ["chatterbox", "whisper"], script: "Cyrillic" },
  { code: "ko", name: "Korean", engines: ["chatterbox", "whisper"], script: "Hangul" },
  { code: "tr", name: "Turkish", engines: ["chatterbox", "whisper"] },
  { code: "nl", name: "Dutch", engines: ["chatterbox", "whisper"] },
  { code: "pl", name: "Polish", engines: ["chatterbox", "whisper"] },
  { code: "sv", name: "Swedish", engines: ["chatterbox", "whisper"] },
  { code: "da", name: "Danish", engines: ["chatterbox", "whisper"] },
  { code: "no", name: "Norwegian", engines: ["chatterbox", "whisper"] },
  { code: "fi", name: "Finnish", engines: ["chatterbox", "whisper"] },
  { code: "el", name: "Greek", engines: ["chatterbox", "whisper"], script: "Greek" },
  { code: "he", name: "Hebrew", engines: ["chatterbox", "whisper"], script: "Hebrew" },
  { code: "ms", name: "Malay", engines: ["chatterbox", "whisper"] },
  { code: "sw", name: "Swahili", engines: ["chatterbox", "whisper"] },
];

export const KOKORO_LANG: Record<string, string> = { a: "en", b: "en", e: "es", f: "fr", h: "hi", i: "it", j: "ja", p: "pt", z: "zh" };

export const GUIDES: Record<string, Guide> = {
  orpheus: {
    title: "Orpheus 3B",
    tagline: "The most human-sounding engine here. English only. Best for narration that needs warmth, timing and little reactions.",
    sections: [
      {
        h: "Voices",
        body: [
          "Eight built-in speakers. Canopy Labs ranks them by conversational realism: tara, leah, jess, leo, dan, mia, zac, zoe.",
          "tara (female preset) is warm and conversational. dan (male preset) is relaxed and clear. leo is brighter and more energetic; leah and jess are lighter and younger.",
          "Orpheus can't clone a voice. For a custom voice, use Chatterbox with a reference clip.",
        ],
      },
      {
        h: "Write it the way a person would say it",
        body: [
          "Use contractions (it's, you're, that's). Formal text gets read formally.",
          "Punctuation is your direction. Comma = a breath. Period = full stop with a fall. Question mark = rise. Ellipsis (...) = hesitation or trailing off. An em dash (—) = a sudden turn.",
          "Spell out numbers, units and symbols the way they should be spoken: \"three hundred meters\", not \"300m\"; \"twenty twenty-six\", not \"2026\"; \"ten percent\", not \"10%\".",
          "Acronyms: write \"G.P.S.\" or \"G P S\" to have them spelled out, or the word itself (\"NASA\") to have it read as a word.",
          "Avoid ALL CAPS for emphasis, since it can get spelled out letter by letter. Emphasise with word choice and short sentences instead.",
          "Unusual names: spell them phonetically (\"Nee-ah-mh\" for Niamh) and keep that spelling for the whole script.",
        ],
        example: "Here's the strange thing about maps... they only help if you know exactly where you're standing.",
      },
      {
        h: "Emotion tags",
        body: [
          "Eight sounds are supported: <laugh> <chuckle> <sigh> <cough> <sniffle> <groan> <yawn> <gasp>.",
          "Put the tag exactly where the sound should happen, between words, never inside one. Use one per sentence at most; stacking them sounds fake.",
          "Tags are sounds, not moods. <sad> or <excited> don't exist and will be read aloud or garbled. Set the mood with the words and punctuation around the tag.",
        ],
        example: "One catch. <sigh> Your phone's clock is cheap.",
      },
      {
        h: "Length",
        body: [
          "There's no length limit. Long text is split at sentence boundaries (about 260 characters per chunk), all chunks are generated together in one GPU batch, and they're joined with a natural 0.2 s pause.",
          "Each chunk is generated independently, so make every sentence carry its own tone. Keep the same seed for the whole script so the delivery stays consistent.",
          "Very short lines (\"But how?\") can come out clipped or over-acted. Give them a beat (\"But... how?\") or merge them with the next sentence.",
        ],
      },
      {
        h: "Parameters",
        body: [
          "temperature: 0.4–0.5 for steady, consistent narration; 0.6 (default) balanced; 0.7–0.9 for animated reads (more expressive, but more risk of mumbles or invented sounds).",
          "repetition_penalty: keep it at 1.1 or higher. If a word repeats or the audio loops at the end, raise it to 1.2–1.3.",
          "top_p: 0.9–0.95. Lower makes it more conservative.",
          "seed: the same seed gives the same take. Change only the seed to get an alternative read of a line you almost like.",
        ],
      },
      {
        h: "If a line comes out wrong",
        body: [
          "Turn on Subtitles. Every line gets a match score against your script, so anything under about 95% is worth a listen.",
          "Swallowed or swapped word: regenerate that line with a different seed. Odd noise at the end: raise repetition_penalty slightly.",
        ],
      },
    ],
  },
  chatterbox: {
    title: "Chatterbox",
    tagline: "Emotion dial, zero-shot voice cloning, and 23 languages including Hindi. The pick for non-English or a specific voice.",
    sections: [
      {
        h: "Languages",
        body: [
          "English uses the English model. Any other language code switches to the multilingual model: Arabic, Danish, German, Greek, Spanish, Finnish, French, Hebrew, Hindi, Italian, Japanese, Korean, Malay, Dutch, Norwegian, Polish, Portuguese, Russian, Swedish, Swahili, Turkish and Chinese.",
          "Pick the language in the Language menu. Then write the script in that language's native script: Hindi in Devanagari (नमस्ते), not in Latin letters (namaste). The model was trained on native script, and romanised Hindi gets read as English.",
          "Hinglish: write the Hindi parts in Devanagari. English words can stay in Latin letters, but every switch costs a little naturalness. Common English loanwords often sound better in Devanagari (फ़ोन, सैटेलाइट).",
          "Write numbers as words in the target language (तीन सौ मीटर). Use the language's normal punctuation (। works for Hindi full stops).",
        ],
        example: "ये छोटा सा बिंदु बिल्कुल जानता है कि आप कहाँ हैं। लेकिन कैसे?",
      },
      {
        h: "Voices and cloning",
        body: [
          "The female/male presets are clones of Orpheus' tara and dan, so Chatterbox matches the Orpheus timbre. \"default\" is Chatterbox's own built-in voice.",
          "Your own voice: upload 5–20 s of clean speech from a single speaker, with no music or reverb, and use its name as the voice. More clean audio beats more audio.",
          "The reference's accent carries over. For Hindi output, use a Hindi-speaking reference. If the reference language differs from the output language, set cfg_weight to 0 to reduce accent transfer.",
        ],
      },
      {
        h: "The two dials",
        body: [
          "exaggeration (emotion intensity): 0.25–0.4 calm, 0.5 natural (default), 0.7–0.9 dramatic. Higher values also speed up delivery.",
          "cfg_weight (pacing and adherence): 0.5 default. Lower it (around 0.3) for slower, more deliberate pacing, and whenever you raise exaggeration.",
          "Recipe for an expressive read: exaggeration 0.7 + cfg_weight 0.3. For a fast-talking reference voice, drop cfg_weight to about 0.3.",
          "Per-line emotion: in the timeline TSV, a 5th column sets that line's exaggeration (e.g. 0.75 for \"But how?\").",
        ],
      },
      {
        h: "Writing tips",
        body: [
          "There are no bracket tags. Emotion comes from the words, the punctuation and the exaggeration dial.",
          "Long text is split into ~280-character chunks at sentence boundaries and re-joined. No length limit.",
          "Every output carries Resemble's inaudible Perth watermark.",
        ],
      },
    ],
  },
  kokoro: {
    title: "Kokoro 82M",
    tagline: "Instant, clean and flat. Runs on CPU, so it never competes for GPU memory. Use it to time a script before spending GPU time.",
    sections: [
      {
        h: "Voices = languages",
        body: [
          "The first letter of a voice is its language: a = American English, b = British English, e = Spanish, f = French, h = Hindi, i = Italian, j = Japanese, p = Brazilian Portuguese, z = Mandarin. The second letter is f (female) or m (male).",
          "The language is picked automatically from the voice. Only set lang to override it.",
          "Quality varies a lot. af_heart is the best voice (grade A), then af_bella. Most non-English voices are noticeably weaker (C/D grades): fine for drafts, but use Chatterbox for final non-English audio.",
        ],
      },
      {
        h: "Writing",
        body: [
          "Commas and periods control pauses. Kokoro doesn't act, so emotional punctuation has little effect.",
          "English numbers are expanded automatically, but spelling them out is still safer for years and units.",
          "Hindi voices (hf_alpha, hf_beta, hm_omega, hm_psi): write in Devanagari.",
          "speed: 0.9 for clearer explainer narration, 1.1 to tighten a line that runs over its window.",
        ],
        example: "Four clocks in space, agreeing on one tiny dot. That's how G.P.S. finds you.",
      },
    ],
  },
  whisper: {
    title: "Subtitles · Whisper large-v3",
    tagline: "OpenAI's most accurate open model. Word-level timestamps, 99 languages, any length.",
    sections: [
      {
        h: "Language",
        body: [
          "Auto-detect works for clean audio. Set the language when you know it: it's more accurate, and it stops short clips from being transcribed in the wrong language.",
          "Hindi comes out in Devanagari. Mixed Hindi-English audio usually comes out in Devanagari with English words transliterated.",
        ],
      },
      {
        h: "How cues are built",
        body: [
          "Captions are cut from word timestamps the way subtitlers do it: one sentence per cue when it fits (about 42 characters / 3.5 s, with a little grace so a single word is never orphaned). Longer sentences are split into balanced parts, preferably after a comma.",
          "When voice lines have timeline starts (from the TSV), the combined subtitles.srt places every cue at its real position in the video. Otherwise lines are laid back to back.",
        ],
      },
      {
        h: "Match score",
        body: [
          "For voice jobs, each line's transcript is compared word by word with your script. 100% means every word was heard as written.",
          "Under about 95%, listen: a word was swallowed, swapped or added. Regenerate just that line with a new seed.",
          "Numbers written differently (\"300\" vs \"three hundred\") and punctuation are ignored or cost very little.",
        ],
      },
      {
        h: "Formats",
        body: [
          "SRT: YouTube, Premiere, Final Cut, CapCut, DaVinci.",
          "VTT: web players and HTML <track>.",
          "JSON: every word with start and end times, for word-pop or karaoke captions in HyperFrames.",
        ],
      },
      {
        h: "For best accuracy",
        body: [
          "Clean audio wins. Music beds and long silences are where Whisper invents words. Transcribe the voice track before it's mixed with music.",
          "Any audio or video format works (wav, mp3, m4a, mp4, mov…). Files go straight from your browser to private storage, so size isn't a problem.",
        ],
      },
    ],
  },
};
