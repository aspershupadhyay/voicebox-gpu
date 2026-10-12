// In-app writing guides. Sourced from each model's documentation and what we measured on this worker.
export type Guide = { title: string; tagline: string; sections: { h: string; body: string[]; example?: string }[] };

export const LANGUAGES: { code: string; name: string; engines: string[]; kokoro?: string[]; script?: string }[] = [
  { code: "en", name: "English", engines: ["qwen", "orpheus", "chatterbox", "kokoro", "whisper"], kokoro: ["af_heart", "af_bella", "am_michael", "am_fenrir", "bf_emma", "bm_george"] },
  { code: "hi", name: "Hindi", engines: ["chatterbox", "kokoro", "whisper"], kokoro: ["hf_alpha", "hf_beta", "hm_omega", "hm_psi"], script: "Devanagari (हिन्दी)" },
  { code: "es", name: "Spanish", engines: ["qwen", "chatterbox", "kokoro", "whisper"], kokoro: ["ef_dora", "em_alex"] },
  { code: "fr", name: "French", engines: ["qwen", "chatterbox", "kokoro", "whisper"], kokoro: ["ff_siwis"] },
  { code: "it", name: "Italian", engines: ["qwen", "chatterbox", "kokoro", "whisper"], kokoro: ["if_sara", "im_nicola"] },
  { code: "pt", name: "Portuguese", engines: ["qwen", "chatterbox", "kokoro", "whisper"], kokoro: ["pf_dora", "pm_alex"] },
  { code: "ja", name: "Japanese", engines: ["qwen", "chatterbox", "kokoro", "whisper"], kokoro: ["jf_alpha", "jf_gongitsune", "jm_kumo"], script: "Japanese script (kana/kanji)" },
  { code: "zh", name: "Chinese (Mandarin)", engines: ["qwen", "chatterbox", "kokoro", "whisper"], kokoro: ["zf_xiaobei", "zf_xiaoxiao", "zm_yunjian", "zm_yunxi"], script: "Simplified Chinese" },
  { code: "de", name: "German", engines: ["qwen", "chatterbox", "whisper"] },
  { code: "ar", name: "Arabic", engines: ["chatterbox", "whisper"], script: "Arabic script" },
  { code: "ru", name: "Russian", engines: ["qwen", "chatterbox", "whisper"], script: "Cyrillic" },
  { code: "ko", name: "Korean", engines: ["qwen", "chatterbox", "whisper"], script: "Hangul" },
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

/** Qwen3-TTS takes language names, not codes. */
export const QWEN_LANG: Record<string, string> = { en: "English", zh: "Chinese", ja: "Japanese", ko: "Korean", de: "German", fr: "French", ru: "Russian", pt: "Portuguese", es: "Spanish", it: "Italian" };

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
          "temperature is a variation dial, not an energy dial. Measured on an 8-line tech script, tara read at ~175 words/min whether temperature was 0.6 or 0.85, and got slightly flatter and less accurate above 0.85 (95% word match at 0.9). Keep it at 0.6–0.7.",
          "The voice is the energy lever: mia had 36% more pitch movement than tara and read at 192 wpm, word-perfect. leo is the lively male voice; tara is warm and clear; zoe and zac are flatter. Use mia or leo for tech and hype, tara for calm narration.",
          "Pace comes from the Delivery style's tempo (pitch-preserving): Tech 1.05×, Hype 1.08×, Calm 0.95×.",
          "Energy comes from the script too: short punchy sentences, exclamation marks on the hook, and a question before a reveal (\"But how?\") all lift the read.",
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
          "Recipe for an expressive read: exaggeration 0.9 + cfg_weight 0.3 (the Tech style). Measured: the female voice's pitch movement nearly doubles from 0.5 to 1.2; on the male voice words start to slur above ~1.0, so Hype caps at 1.05.",
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
          "speed: 1.1 for tech explainers (Tech style), 1.2 for hype, 0.95 for calm narration. Speed changes pace, not expressiveness.",
          "Pick the voice for energy: am_fenrir is by far the liveliest (wide pitch range), then af_bella (opens up at speed 1.2) and am_puck. af_heart stays fairly even at any speed; af_nicole is soft and whispery (good for calm narration only).",
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
  qwen: {
    title: "Your voice · Qwen3-TTS",
    tagline: "The best cloner here: 10-20 seconds of you becomes a voice that reads any script. 10 languages.",
    sections: [
      {
        h: "Record a good reference",
        body: [
          "10-20 seconds of one person talking. Longer is trimmed to ~20 s at a word boundary; under 8 s still works but sounds less like you.",
          "A quiet room with soft furnishings beats a big echoey one. No music, TV or fans behind you: the cloner copies the room as well as the voice.",
          "Hold the phone or mic a hand's width (15-20 cm) from your mouth, slightly off to the side so p and b sounds don't pop.",
          "Read in the energy you want back. The clone copies your pace and attitude, so for tech videos read like you're excited to show something.",
        ],
      },
      {
        h: "What happens to it",
        body: [
          "The recording is cleaned (rumble and hiss removed, silence trimmed, level evened out) and Whisper writes down exactly what you said. The cloner needs those words to line up your voice with the text.",
          "It's stored privately in your R2 bucket, so it survives the Colab runtime being recycled. The worker fetches it again when needed.",
        ],
      },
      {
        h: "Settings",
        body: [
          "Temperature 0.7 stays closest to your recording; 0.85-0.9 is livelier. The Tech style uses 0.85.",
          "Change the seed for a different take of the same line, like a second read in the booth.",
          "Your voice can speak any of the 10 languages, even ones you didn't record in. For Hindi use Chatterbox with the same recording.",
        ],
      },
    ],
  },
};

/** Prompting guides for the video models. */
export const VIDEO_GUIDES: Record<string, Guide> = {
  wan: {
    title: "Wan 2.2",
    tagline: "Sharp 720p, strong motion and the best prompt following of the two. Silent clips up to 5 s.",
    sections: [
      {
        h: "Write the shot",
        body: [
          "Subject, action, place, camera, light, style. In that order. Wan likes detail: 40-100 words beats a one-liner.",
          "Name the camera move: slow dolly in, tracking shot, orbit around, aerial drone, handheld, static tripod.",
          "Name the light and the look: soft window light, neon rim light, golden hour; cinematic, macro, isometric 3D, flat motion graphics.",
        ],
        example: "Close-up of a glowing GPS chip on a dark circuit board, tiny signal rings pulsing outward from it in teal light. Slow dolly in, shallow depth of field, cinematic, high contrast, subtle dust in the air.",
      },
      {
        h: "Start from a picture",
        body: [
          "With a start frame, the image IS the first frame. Describe what moves and how the camera moves, not what things look like.",
          "Keep the motion believable for 5 seconds: one main action, one camera move.",
        ],
      },
      {
        h: "Fast or full",
        body: [
          "Fast is the 4-step Turbo distill: a few minutes per clip and very good. Use it for everything first.",
          "Full runs the original model for 30 steps: a little more detail, about 10x slower. Use it for the final hero shot once the seed and prompt are right.",
          "Text in the frame (titles, labels) comes out garbled in every video model. Add text in HyperFrames instead.",
        ],
      },
    ],
  },
  wan14: {
    title: "Wan 2.2 14B",
    tagline: "The full-size Wan (two 14B experts) with the 4-step Lightning distill. Animates a start frame at 480p, 16 fps, up to 5 s. Needs an A100.",
    sections: [
      {
        h: "Start from a picture",
        body: [
          "This model only animates: the start frame IS frame one. Upload an image or pick a library frame.",
          "Describe the motion and the camera, not the look: what moves, how fast, where the camera goes. One main action, one camera move.",
          "It keeps faces, hands and fabric far steadier than the 5B Wan. Use it for the hero shot once the frame is right.",
        ],
        example: "The woman turns her head toward the window and smiles as wind lifts her hair. Slow push in, soft daylight, gentle film grain.",
      },
      {
        h: "Adult mode",
        body: [
          "Off by default. When on, the job adds a community LoRA (lopi999/Wan2.2-I2V_General-NSFW-LoRA, downloaded once, ~1.2 GB) and its trigger word.",
          "Adults only, and never real people's likeness: both are illegal or against Colab's terms whatever the model allows.",
        ],
      },
    ],
  },
  ltx: {
    title: "LTX-2.5",
    tagline: "Video and matching sound in one pass. Up to 10 s, 8 steps. Full = the two-stage recipe at double resolution.",
    sections: [
      {
        h: "Write it like a scene",
        body: [
          "Describe the shot in time order, in present tense: what we see first, what moves, where the camera goes. 4-8 sentences.",
          "Describe the sound too. LTX generates audio from the same prompt: \"Audio: soft server hum, quick keyboard clicks, a short rising whoosh.\"",
          "Spoken lines can be written in quotes, but lip sync is rough. For narration use a voice engine and mix it in.",
        ],
        example: "A dark desk lit by one monitor. Lines of code scroll quickly as the camera slowly pushes in toward the screen. A notification pops up and glows orange. Audio: low room tone, fast mechanical keyboard typing, a soft chime when the notification appears.",
      },
      {
        h: "Good uses",
        body: [
          "Atmospheric b-roll with built-in sound effects, loops of motion behind captions, and anything longer than 5 s.",
          "Turn the sound off when you only need picture: you'll mix your own audio anyway.",
        ],
      },
    ],
  },
};
