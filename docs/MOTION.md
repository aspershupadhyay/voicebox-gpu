# The motion toolkit (what a model reaches for, and how)

Served by `playbook` (doc `motion`), so a model reads only the part it needs. Everything runs on the Colab worker. A
tool is installed the first time a run asks for it, then kept in R2 (`cache/toolchain/`), so the next runtime
restores it in seconds instead of installing it again. A tool that didn't work when tested is left out of this list,
not left broken (docs/FACTORY.md G).

## Renderers

- **HyperFrames** (default): `video_template` for the brand templates (title_card, list, quote, lower_third; fonts and
  GSAP from the worker's cache, motion from frame 0, `music` bed). A repo project renders with the version its
  `package.json` pins: `repo checkout` (ref = a branch or a commit sha), then `video_template action=render
  project={workspace, dir}`. In `run`, `hyperframes check | snapshot | render | lint | inspect` work at the pinned
  version.
- **Remotion**: a repo project whose `package.json` names `remotion` renders with `npx remotion render <composition>`
  (pass `composition`). In `run`, `tools: ["remotion"]` puts Node 22 and npx on PATH. Licence: free for individuals
  and companies of up to 3 people; past that a company licence (the owner confirms).
- **Revideo**: no special path; it's an npm project like any other: `run` with `lang: "bash"` and its own scripts.

## Motion libraries (inside a composition)

GSAP (cached), Lottie (`lottie-web`, dotLottie) and Three.js are npm packages a project installs itself (`npm i` in a
`run` workspace; the sandbox has the network). Keep every scene moving: something changes at least every 2 s, and
`inspect_media` QA fails frozen stretches.

## Stickers, beats, lossless cuts and formats

- Any template takes `fields.sticker`: `badge` (text), `arrow`, `check`, `follow` (text: the handle), `pop` (a word),
  or `{kind: "lottie", lottie: "m:<Files id>" | a link}` for a Lottie animation, with `at` (s) and `position`.
- `edit_video` spec `beat_sync: true` puts cuts and text starts on the music's beats; `lossless: true` cuts one clip
  with no re-encode.
- A saved look is a format (`formats`): pass `format` to the factory or `edit_video` instead of repeating the brand,
  captions, music, logo, sticker and outro (docs/FACTORY.md I).
- Writing a Remotion scene: clone `https://github.com/remotion-dev/skills` into the `run` workspace first and follow
  `skills/remotion-best-practices/SKILL.md` and `skills/remotion-markup/SKILL.md` (animate with `useCurrentFrame()` and
  `interpolate()`, never CSS transitions; seconds to frames with `fps` from `useVideoConfig()`).

## Editing and finishing (`run` with `tools`)

| Tool | `tools:` | For | Test it passed |
|---|---|---|---|
| auto-editor | `auto-editor` | cutting silences and dead air from a talking take | a 4 s clip with 2 s of silence came out 2.2 s |
| PySceneDetect | `scenedetect` | a shot list (`scenedetect -i in/x.mp4 list-scenes`) | `scenedetect version` |
| rembg | `rembg` | cut-outs (a person off the background) for a still | `import rembg` (installs in ~90 s once) |
| Manim | `manim` | explainer diagrams | needs Colab's Python 3.12 (see FACTORY.md, still to check) |
| ffmpeg (always) | — | NVENC encodes, LUTs (`lut3d=file.cube`), slow motion (`minterpolate=fps=60:mi_mode=mci`) | in every render |
| Whisper (always) | — | word timings: `inspect_media checks ["words"]` | in every caption |

Left out: Real-ESRGAN (its `basicsr` dependency doesn't build), RIFE and SAM 2 (weights from Google Drive / several GB;
`minterpolate` and rembg cover slow motion and cut-outs).

## The order a top editor works in

1. The spine and the script (`script_check`), then the voice (`voice_lines`, or the factory for many).
2. Scenes: a template per beat, or the brand's own HyperFrames scene from `videos-post` at a commit.
3. The join: `edit_video` (scenes cut to their lines, music ducked, pop captions), or the `factory`.
4. Finishing in `run`: auto-editor on talking takes, a LUT, slow motion where it earns it.
5. The gates: render PASS → `inspect_media` qa (black, frozen, loudness, safe zones) → a contact sheet (`checks
   ["sheet"]`) read against the brand's taste rules → the owner's checkpoint.
