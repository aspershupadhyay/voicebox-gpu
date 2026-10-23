"""Script -> finished video: the pieces that don't need a GPU.

The gateway voices the script, writes word-timed subtitles, makes one visual per scene, then calls these helpers
to time the scenes to the voice, animate stills (Ken Burns), cross-fade, burn in captions and mix the soundtrack.
Everything here is plain Python + ffmpeg, so it is testable without models.
"""
import json
import os
import re
import subprocess
import urllib.request

FPS = 30
FRAME = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
LEAD_IN, GAP, TAIL, FADE = 0.25, 0.3, 0.8, 0.35  # seconds: before the first line, between scenes, after the last, cross-fade

VISUAL_STYLES = {
    "tech": {"label": "Tech 3D", "prompt": "sleek 3D render, soft studio lighting, dark gradient background, subtle glowing "
             "accents, crisp detail, cinematic composition, shallow depth of field"},
    "neon": {"label": "Neon cinematic", "prompt": "cinematic night scene, neon cyan and magenta rim light, volumetric haze, "
             "reflections, moody contrast, anamorphic look"},
    "minimal": {"label": "Minimal flat", "prompt": "clean minimal flat illustration, bold simple shapes, two-tone palette with "
                "one accent color, generous negative space, vector style"},
    "photo": {"label": "Photo b-roll", "prompt": "photoreal b-roll photograph, natural light, 35mm lens, shallow depth of field, "
              "rich detail, editorial look"},
    "paper": {"label": "Paper cut", "prompt": "layered paper-cut diorama, soft shadows between layers, warm studio light, "
              "handcrafted texture, playful"},
    "blueprint": {"label": "Blueprint", "prompt": "technical blueprint drawing, white precise line art on deep blue paper, "
                  "annotations as abstract marks, engineering diagram aesthetic"},
}
CAPTION_LOOKS = {
    "bold": {"label": "Bold pop", "about": "Big 1-3 word captions, current word highlighted (Shorts / Reels / TikTok)."},
    "clean": {"label": "Clean subtitles", "about": "Two-line subtitles at the bottom (YouTube)."},
    "none": {"label": "None", "about": "No burned-in captions (subtitle files are still made)."},
}
FONTS = {  # downloaded once into <home>/fonts; libass falls back to a system font if a download fails
    "Anton": "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/anton/Anton-Regular.ttf",
    "Inter": "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/inter/Inter%5Bopsz,wght%5D.ttf",
}
MOTIONS = ("in", "pan_r", "out", "pan_l", "in_up")


def aspect_for(platform, aspect=None):
    if aspect in FRAME:
        return aspect
    return "9:16" if platform in ("shorts", "reels", "tiktok") else "16:9"


def visual_prompt(visual, text, style, aspect):
    """The image prompt for one scene: the scene's own visual description (or a metaphor for its line) + the look."""
    subject = (visual or "").strip() or f"a striking visual metaphor for: {text.strip()}"
    frame = {"9:16": "vertical composition, subject centered", "16:9": "wide cinematic composition", "1:1": "square composition"}[aspect]
    look = VISUAL_STYLES.get(style, VISUAL_STYLES["tech"])["prompt"]
    return f"{subject.rstrip('. ')}. {look}, {frame}. No text, no letters, no logos, no watermark."


def timeline(durations):
    """Scene starts and on-screen lengths from the voice line durations: a short lead-in, a breath between scenes,
    a tail after the last line. Returns ([voice start per scene], [visual length per scene], total)."""
    starts, lengths, t = [], [], LEAD_IN
    for i, d in enumerate(durations):
        starts.append(round(t, 3))
        last = i == len(durations) - 1
        lengths.append(round(d + (TAIL if last else GAP) + (LEAD_IN if i == 0 else 0), 3))
        t += d + GAP
    return starts, lengths, round(sum(lengths), 3)


# ------------------------------------------------------------------------------------------------ captions (ASS)
def _t(s):
    s = max(0.0, s)
    return f"{int(s // 3600)}:{int(s % 3600 // 60):02d}:{s % 60:05.2f}"


def _esc(s):
    return s.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def word_groups(words, max_words=3, max_chars=16, max_gap=0.45):
    """Words -> pop-up caption groups: break after sentence punctuation, after a pause, or when the group is full."""
    groups, cur = [], []
    for w in words:
        if cur and (len(cur) >= max_words or len(" ".join(x["w"] for x in cur + [w])) > max_chars or w["s"] - cur[-1]["e"] > max_gap):
            groups.append(cur); cur = []
        cur.append(w)
        if re.search(r"[.!?;:,]$", w["w"]):
            groups.append(cur); cur = []
    if cur:
        groups.append(cur)
    return groups


def make_ass(look, size, words=None, cues=None):
    """ASS subtitle script. bold: big centred 1-3 word groups, the spoken word turns yellow and each group pops in.
    clean: subtitle cues (already cut sentence by sentence) at the bottom."""
    w, h = size
    if look == "bold":
        fs, outline, margin, align, font = round(h * (0.064 if h > w else 0.085)), round(h * 0.0045) + 2, round(h * (0.27 if h > w else 0.12)), 2, "Anton"
    else:
        fs, outline, margin, align, font = round(min(w, h) * 0.05), 3, round(h * 0.06), 2, "Inter"
    head = (f"[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
            "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
            "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Cap,{font},{fs},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,{-1 if look != 'bold' else 0},0,0,0,100,100,"
            f"{2 if look == 'bold' else 0},0,1,{outline},{3 if look == 'bold' else 1},{align},{round(w * 0.08)},{round(w * 0.08)},{margin},1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
    ev = []
    if look == "bold":
        for g in word_groups(words or []):
            texts = [_esc(x["w"]).upper() for x in g]
            g_end = g[-1]["e"] + 0.12
            for i, x in enumerate(g):
                st = g[0]["s"] if i == 0 else x["s"]
                en = g[i + 1]["s"] if i + 1 < len(g) else g_end
                line = " ".join(r"{\c&H0000E5FF&}" + t + r"{\c&H00FFFFFF&}" if j == i else t for j, t in enumerate(texts))
                pop = r"{\fscx112\fscy112\t(0,90,\fscx100\fscy100)}" if i == 0 else ""
                ev.append(f"Dialogue: 0,{_t(st)},{_t(max(en, st + 0.05))},Cap,,0,0,0,,{pop}{line}")
    else:
        for c in cues or []:
            ev.append(f"Dialogue: 0,{_t(c['s'])},{_t(c['e'])},Cap,,0,0,0,,{_esc(c['text'])}")
    return head + "\n".join(ev) + "\n"


def ensure_fonts(home):
    d = os.path.join(home, "fonts")
    os.makedirs(d, exist_ok=True)
    for name, url in FONTS.items():
        path = os.path.join(d, os.path.basename(url).replace("%5B", "[").replace("%5D", "]"))
        if not os.path.exists(path):
            try:
                with urllib.request.urlopen(url, timeout=30) as r, open(path + ".part", "wb") as f:
                    f.write(r.read())
                os.replace(path + ".part", path)
            except Exception:  # noqa: BLE001  captions still render, in a fallback font
                pass
    return d


# ------------------------------------------------------------------------------------------------ video
def _run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg: {(p.stderr.strip().splitlines() or ['failed'])[-1]}")


def still_clip(img, out, seconds, size, motion):
    """A still -> a moving shot (Ken Burns). The image is upscaled 2x before zoompan so the pan never stair-steps."""
    w, h = size
    n = max(1, round(seconds * FPS))
    z = {"in": f"1+0.14*on/{n}", "out": f"1.14-0.14*on/{n}", "pan_r": "1.12", "pan_l": "1.12", "in_up": f"1+0.16*on/{n}"}[motion]
    x = {"pan_r": f"(iw-iw/zoom)*on/{n}", "pan_l": f"(iw-iw/zoom)*(1-on/{n})"}.get(motion, "iw/2-(iw/zoom/2)")
    y = "ih/3-(ih/zoom/3)" if motion == "in_up" else "ih/2-(ih/zoom/2)"
    vf = (f"scale={w * 2}:{h * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop={w * 2}:{h * 2},"
          f"zoompan=z='{z}':x='{x}':y='{y}':d={n}:s={w}x{h}:fps={FPS},format=yuv420p")
    _run(["ffmpeg", "-v", "error", "-y", "-i", img, "-vf", vf, "-frames:v", str(n), "-c:v", "libx264", "-preset", "veryfast",
          "-crf", "17", "-pix_fmt", "yuv420p", out])


def motion_clip(src, out, seconds, size):
    """A generated clip -> exactly `seconds` long at the output size: up to 1.5x slow-motion, then ping-pong looping."""
    w, h = size
    dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], text=True).strip() or 0)
    slow = min(1.5, max(1.0, seconds / max(dur, 0.1)))
    fit = f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},setpts={slow:.4f}*PTS,fps={FPS}"
    if dur * slow >= seconds:
        vf = f"[0:v]{fit},trim=duration={seconds:.3f},format=yuv420p[v]"
    else:
        loops = int(seconds / (2 * dur * slow)) + 1
        vf = (f"[0:v]{fit},split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[pp];[pp]loop=loop={loops}:size=32767,"
              f"trim=duration={seconds:.3f},setpts=PTS-STARTPTS,format=yuv420p[v]")
    _run(["ffmpeg", "-v", "error", "-y", "-i", src, "-filter_complex", vf, "-map", "[v]", "-an", "-c:v", "libx264",
          "-preset", "veryfast", "-crf", "17", out])


def assemble(segments, lengths, audio, ass_path, fonts_dir, out, transition="fade"):
    """Scene segments (each `lengths[i]` long, plus FADE of overlap when cross-fading) -> one MP4 with the mixed
    soundtrack and burned-in captions. Cross-fades keep the total equal to sum(lengths), so captions stay in sync."""
    n = len(segments)
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for s in segments:
        cmd += ["-i", s]
    cmd += ["-i", audio]
    parts, last = [], "[0:v]"
    if transition == "fade" and n > 1:
        off = 0.0
        for i in range(1, n):
            off += lengths[i - 1]
            tag = f"[x{i}]"
            # the stream so far is sum(lengths[:i]) + FADE long, so fading over its last FADE starts exactly at scene i
            parts.append(f"{last}[{i}:v]xfade=transition=fade:duration={FADE}:offset={off:.3f}{tag}")
            last = tag
    elif n > 1:
        parts.append("".join(f"[{i}:v]" for i in range(n)) + f"concat=n={n}:v=1:a=0[cat]")
        last = "[cat]"
    total = sum(lengths)
    sub = ""
    if ass_path:
        esc = lambda p: p.replace("\\", "/").replace(":", r"\:").replace("'", r"\'")  # noqa: E731
        sub = f",ass='{esc(ass_path)}':fontsdir='{esc(fonts_dir)}'"
    parts.append(f"{last}trim=duration={total:.3f},setpts=PTS-STARTPTS{sub},format=yuv420p[v]")
    cmd += ["-filter_complex", ";".join(parts), "-map", "[v]", "-map", f"{n}:a", "-t", f"{total:.3f}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-r", str(FPS),
            "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", out]
    _run(cmd)


def segment_length(lengths, i, transition):
    """How long segment i must be rendered: its scene, plus the overlap the next cross-fade eats."""
    return lengths[i] + (FADE if transition == "fade" and i < len(lengths) - 1 else 0)


def mix_music(voice, music, out, total, music_lufs=-28.0):
    """Voice + a music bed: the bed is levelled to `music_lufs`, ducked under the voice (sidechain), looped to length
    and faded out. Without music, just pads the voice to the full length."""
    if not music:
        _run(["ffmpeg", "-v", "error", "-y", "-i", voice, "-af", f"apad=whole_dur={total:.3f}", "-t", f"{total:.3f}", out])
        return
    fc = (f"[1:a]aformat=sample_rates=48000:channel_layouts=mono,loudnorm=I={music_lufs}:TP=-3,"
          f"afade=t=in:d=1.0,afade=t=out:st={max(0.0, total - 2.0):.3f}:d=2.0[m];"
          f"[0:a]aformat=sample_rates=48000:channel_layouts=mono,apad=whole_dur={total:.3f},asplit[v1][v2];"
          f"[m][v1]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400:makeup=1[duck];"
          f"[v2][duck]amix=inputs=2:duration=first:normalize=0[a]")
    _run(["ffmpeg", "-v", "error", "-y", "-i", voice, "-stream_loop", "-1", "-i", music, "-filter_complex", fc,
          "-map", "[a]", "-t", f"{total:.3f}", "-ar", "48000", out])


def probe(path):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                                   "stream=width,height,nb_read_packets:format=duration", "-of", "json", path], text=True)
    j = json.loads(out)
    s = j["streams"][0]
    return {"width": s["width"], "height": s["height"], "frames": int(s.get("nb_read_packets", 0)), "fps": FPS,
            "duration": round(float(j["format"]["duration"]), 3), "has_audio": True}
