"""Media recipes for the workbench (docs/AUTOMATION.md, phase 4): the know-how lives here so a model sends a little
JSON instead of writing ffmpeg. edit: a timeline (clips cut, shaped, sped up, joined; a voiceover; music ducked under
speech; captions from word timings; a logo; text; fades; loudness) rendered with NVENC on the GPU when there is one.
inspect: probe, scenes, loudness, a contact sheet, word timings, and qa (the checks every render gets: shape, length,
black or frozen stretches, silence, loudness and peaks, text in the platforms' safe zones).

Everything here builds commands; bench.py runs them as the sandbox user in the job's own workspace."""
import json, math, re, shutil, subprocess, textwrap

# Where each platform wants a video, and the parts of a vertical frame its buttons and captions cover (pixels at
# 1080x1920): text there gets hidden.
PLATFORMS = {
    "reels": {"w": 1080, "h": 1920, "max_s": 180, "lufs": -14, "safe": {"top": 220, "bottom": 420, "right": 140, "left": 60}},
    "shorts": {"w": 1080, "h": 1920, "max_s": 180, "lufs": -14, "safe": {"top": 220, "bottom": 380, "right": 140, "left": 60}},
    "tiktok": {"w": 1080, "h": 1920, "max_s": 600, "lufs": -14, "safe": {"top": 160, "bottom": 440, "right": 160, "left": 60}},
    "youtube": {"w": 1920, "h": 1080, "max_s": None, "lufs": -14, "safe": {"top": 60, "bottom": 120, "right": 60, "left": 60}},
    "ig_post": {"w": 1080, "h": 1350, "max_s": 3600, "lufs": -14, "safe": {"top": 60, "bottom": 120, "right": 60, "left": 60}},
    "square": {"w": 1080, "h": 1080, "max_s": None, "lufs": -14, "safe": {"top": 60, "bottom": 100, "right": 60, "left": 60}},
}
SHAPES = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080), "4:5": (1080, 1350)}
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
CAPTION_STYLES = {
    # size at 1080 wide, outline, uppercase, how many words at once, the highlight colour for the word being said (ASS BGR)
    "pop": {"size": 78, "outline": 5, "upper": True, "words": 3, "hi": "&H0000E5FF&", "bold": 1},
    "bold": {"size": 92, "outline": 6, "upper": True, "words": 2, "hi": "&H0000E5FF&", "bold": 1},
    "clean": {"size": 56, "outline": 3, "upper": False, "words": 6, "hi": None, "bold": 0},
}


class MediaError(ValueError):
    pass


def num(x, lo, hi, default):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


# ── probing ────────────────────────────────────────────────────────────────────────────────────────────────────────

def probe(run, path):
    """ffprobe's facts that matter: duration, size, fps, codecs, audio, rotation."""
    code, out, err = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path])
    if code:
        raise MediaError(f"can't read {path}: {err.strip()[-200:]}")
    d = json.loads(out or b"{}")
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), None)
    fmt = d.get("format", {})
    info = {"duration": round(float(fmt.get("duration") or (v or {}).get("duration") or 0), 3), "size_mb": round(int(fmt.get("size") or 0) / 1e6, 2),
            "bitrate_kbps": round(int(fmt.get("bit_rate") or 0) / 1000), "has_audio": bool(a), "has_video": bool(v)}
    if v:
        w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        rot = int(((v.get("tags") or {}).get("rotate")) or next((sd.get("rotation", 0) for sd in v.get("side_data_list", []) if "rotation" in sd), 0) or 0)
        if abs(rot) in (90, 270):
            w, h = h, w
        fr = v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1"
        n, dd = (fr.split("/") + ["1"])[:2]
        info.update(width=w, height=h, fps=round(float(n) / float(dd), 2) if float(dd or 0) else None, video_codec=v.get("codec_name"),
                    aspect=aspect(w, h), image=path.lower().endswith(IMAGE_EXT) or v.get("codec_name") in ("mjpeg", "png", "webp") and not info["duration"])
    if a:
        info.update(audio_codec=a.get("codec_name"), sample_rate=int(a.get("sample_rate") or 0), channels=a.get("channels"))
    return info


def aspect(w, h):
    if not w or not h:
        return None
    g = math.gcd(w, h)
    r = f"{w // g}:{h // g}"
    for name, (sw, sh) in SHAPES.items():
        if abs(w / h - sw / sh) < 0.02:
            return name
    return r


def scenes(run, path, threshold=0.3, limit=200):
    code, _, err = run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-filter:v", f"select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"], timeout=1800)
    times = [round(float(m), 2) for m in re.findall(r"pts_time:([\d.]+)", err)]
    return times[:limit]


def loudness(run, path):
    code, _, err = run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], timeout=1800)
    tail = err[err.rfind("Summary:"):] if "Summary:" in err else ""
    get = lambda pat: (lambda m: float(m.group(1)) if m else None)(re.search(pat, tail))
    return {"lufs": get(r"I:\s+(-?[\d.]+) LUFS"), "range_lu": get(r"LRA:\s+(-?[\d.]+) LU"), "true_peak_db": get(r"Peak:\s+(-?[\d.]+) dBFS")}


def detect(run, path, has_audio=True, has_video=True):
    """Black stretches, frozen stretches and silences, in one pass each."""
    out = {"black": [], "frozen": [], "silence": []}
    if has_video:
        _, _, err = run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vf", "blackdetect=d=0.4:pix_th=0.10,freezedetect=n=0.003:d=1.5", "-an", "-f", "null", "-"], timeout=1800)
        out["black"] = [(round(float(a), 2), round(float(b), 2)) for a, b in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", err)]
        starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", err)]
        ends = [float(x) for x in re.findall(r"freeze_end: ([\d.]+)", err)]
        out["frozen"] = [(round(s, 2), round(e, 2)) for s, e in zip(starts, ends + [None] * (len(starts) - len(ends))) if e is not None] + \
                        [(round(s, 2), None) for s in starts[len(ends):]]
    if has_audio:
        _, _, err = run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn", "-af", "silencedetect=n=-45dB:d=1.2", "-f", "null", "-"], timeout=1800)
        starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", err)]
        ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
        out["silence"] = [(round(max(0, s), 2), round(e, 2) if e is not None else None) for s, e in zip(starts, ends + [None] * (len(starts) - len(ends)))]
    return out


def contact_sheet(run, path, dst, duration, cols=4, rows=4, width=1600):
    n = cols * rows
    step = max(duration / (n + 1), 0.05)
    code, _, err = run(["ffmpeg", "-hide_banner", "-y", "-i", path, "-vf", f"fps=1/{step:.3f},scale={width // cols}:-2,tile={cols}x{rows}:padding=4:color=black",
                        "-frames:v", "1", "-q:v", "3", dst], timeout=900)
    if code:
        raise MediaError(f"contact sheet failed: {err.strip()[-300:]}")
    return {"frames": n, "every_s": round(step, 2)}


# ── QA ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

def qa(run, path, platform="reels", layout=None, stills=False):
    """Every check a finished video should pass for where it's going, PASS / WARN / FAIL each, worst first. stills: it's
    made of photos or a cover (a slideshow, an audiogram), so frames that barely move are the point, not a fault."""
    p = PLATFORMS.get(platform) or PLATFORMS["reels"]
    info = probe(run, path)
    checks = []
    add = lambda status, name, why: checks.append({"status": status, "check": name, "why": why})
    want = "9:16" if p["h"] > p["w"] * 1.5 else aspect(p["w"], p["h"])
    if not info.get("has_video"):
        add("FAIL", "video", "no video stream")
    else:
        add("PASS" if info["aspect"] == want else "FAIL", "shape", f"{info['width']}x{info['height']} ({info['aspect']}); {platform} wants {want}")
        short_side = min(info["width"], info["height"])
        add("PASS" if short_side >= min(p["w"], p["h"]) else "WARN" if short_side >= 720 else "FAIL", "resolution", f"{info['width']}x{info['height']}; best at {p['w']}x{p['h']}")
        if info.get("fps"):
            add("PASS" if 23.5 <= info["fps"] <= 60.5 else "WARN", "frame rate", f"{info['fps']} fps")
        add("PASS" if info.get("video_codec") in ("h264", "hevc") else "WARN", "codec", f"{info.get('video_codec')} (h264 plays everywhere)")
    if p["max_s"]:
        add("PASS" if info["duration"] <= p["max_s"] else "FAIL", "length", f"{info['duration']:.1f} s; {platform} takes up to {p['max_s']} s")
    if info["duration"] < 3:
        add("FAIL", "length", f"{info['duration']:.1f} s is too short to post")
    if not info.get("has_audio"):
        add("WARN", "audio", "no sound at all")
    else:
        ld = loudness(run, path)
        if ld["lufs"] is not None:
            off = ld["lufs"] - p["lufs"]
            add("PASS" if abs(off) <= 2 else "WARN" if abs(off) <= 4 else "FAIL", "loudness", f"{ld['lufs']} LUFS; aim for {p['lufs']} (platforms turn louder ones down, quieter ones sound weak)")
        if ld["true_peak_db"] is not None:
            add("PASS" if ld["true_peak_db"] <= -0.5 else "WARN", "peaks", f"true peak {ld['true_peak_db']} dBFS (keep under -1 so it doesn't clip on phones)")
    d = detect(run, path, info.get("has_audio"), info.get("has_video"))
    if info.get("has_video"):
        black = [b for b in d["black"] if (b[1] - b[0]) >= 0.4]
        add("FAIL" if any(b[0] < 0.2 for b in black) else "WARN" if black else "PASS", "black frames",
            "none" if not black else "; ".join(f"{a}-{b} s" for a, b in black[:5]) + (" (it opens on black: the first frame is the thumbnail)" if any(b[0] < 0.2 for b in black) else ""))
        if not stills:
            add("WARN" if d["frozen"] else "PASS", "frozen frames", "none" if not d["frozen"] else "; ".join(f"{a}-{b if b is not None else 'end'} s" for a, b in d["frozen"][:5]))
    if info.get("has_audio"):
        long_quiet = [s for s in d["silence"] if (s[1] if s[1] is not None else info["duration"]) - s[0] >= 1.2]
        add("WARN" if long_quiet else "PASS", "silences", "none" if not long_quiet else "; ".join(f"{a}-{b if b is not None else 'end'} s" for a, b in long_quiet[:5]))
    for box in (layout or []):  # text drawn by an edit: inside the safe zone, and not wider than the frame
        add(*safe_zone_check(box, p, info.get("width") or p["w"], info.get("height") or p["h"]))
    order = {"FAIL": 0, "WARN": 1, "PASS": 2}
    checks.sort(key=lambda c: order[c["status"]])
    verdict = "FAIL" if any(c["status"] == "FAIL" for c in checks) else "WARN" if any(c["status"] == "WARN" for c in checks) else "PASS"
    return {"verdict": verdict, "platform": platform, "checks": checks, "info": info}


def safe_zone_check(box, p, w, h):
    sx, sy = w / p["w"], h / p["h"]
    s = p["safe"]
    top, bottom, left, right = s["top"] * sy, h - s["bottom"] * sy, s["left"] * sx, w - s["right"] * sx
    name = f"text \"{box['text'][:30]}\""
    if box["x1"] - box["x0"] > w * 0.96:
        return "FAIL", name, f"about {int(box['x1'] - box['x0'])} px wide on a {w} px frame: it runs off the edges; shorten it or make it smaller"
    if box["y0"] < top or box["y1"] > bottom or box["x0"] < left or box["x1"] > right:
        return "WARN", name, "sits where the app's buttons or caption cover it; move it toward the middle"
    return "PASS", name, "inside the safe zone"


# ── captions ───────────────────────────────────────────────────────────────────────────────────────────────────────

def _ass_time(t):
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def _esc(t):
    return t.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def captions_ass(words, w, h, style="pop", position="lower", font="DejaVu Sans", platform="reels"):
    """Word timings ([{w, s, e}]) into ASS captions: a few words at a time, the one being said lit up (pop, bold), kept
    above the platform's bottom bar. Returns (ass text, layout boxes for QA)."""
    st = CAPTION_STYLES.get(style) or CAPTION_STYLES["pop"]
    p = PLATFORMS.get(platform) or PLATFORMS["reels"]
    size = round(st["size"] * w / 1080)
    # lower: just above the bottom safe line; middle: the centre; upper: under the top safe line
    margin_v = {"lower": round(p["safe"]["bottom"] * h / p["h"] + 40), "middle": round(h / 2 - size), "upper": round(p["safe"]["top"] * h / p["h"] + 20)}[position if position in ("lower", "middle", "upper") else "lower"]
    align = 8 if position == "upper" else 2
    ml = max(round(w * 0.08), round(p["safe"]["left"] * w / p["w"]) + 20)
    mr = max(round(w * 0.08), round(p["safe"]["right"] * w / p["w"]) + 20)
    head = (f"[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\nWrapStyle: 0\n\n[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Cap,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,{st['bold']},0,0,0,100,100,0,0,1,{st['outline']},0,{align},{ml},{mr},{margin_v},1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
    groups, cur = [], []
    for wd in words:
        if cur and (len(cur) >= st["words"] or wd["s"] - cur[-1]["e"] > 0.6 or re.search(r"[.!?]$", cur[-1]["w"])):
            groups.append(cur)
            cur = []
        cur.append(wd)
    if cur:
        groups.append(cur)
    lines, boxes = [], []
    for gi, g in enumerate(groups):
        toks = [(x["w"].upper() if st["upper"] else x["w"]).strip() for x in g]
        end_all = min(g[-1]["e"] + 0.25, groups[gi + 1][0]["s"]) if gi + 1 < len(groups) else g[-1]["e"] + 0.4
        if st["hi"]:
            for i, x in enumerate(g):
                a = x["s"] if i else g[0]["s"]
                b = g[i + 1]["s"] if i + 1 < len(g) else end_all
                txt = " ".join(f"{{\\c{st['hi']}}}{_esc(t)}{{\\c&H00FFFFFF&}}" if j == i else _esc(t) for j, t in enumerate(toks))
                lines.append(f"Dialogue: 0,{_ass_time(a)},{_ass_time(b)},Cap,,0,0,0,,{txt}")
        else:
            lines.append(f"Dialogue: 0,{_ass_time(g[0]['s'])},{_ass_time(end_all)},Cap,,0,0,0,,{_esc(' '.join(toks))}")
        # libass wraps a line that's too long inside the margins, so the box is never wider than that
        tw = min(w - ml - mr, len(" ".join(toks)) * size * 0.58)
        lines_n = max(1, math.ceil(len(" ".join(toks)) * size * 0.58 / (w - ml - mr)))
        y1 = h - margin_v if align == 2 else margin_v + size * 1.2 * lines_n
        x0 = ml + (w - ml - mr - tw) / 2
        boxes.append({"text": " ".join(toks), "x0": x0, "x1": x0 + tw, "y0": y1 - size * 1.2 * lines_n, "y1": y1})
    # one box per distinct height is enough for QA: the widest group
    widest = max(boxes, key=lambda b: b["x1"] - b["x0"]) if boxes else None
    return head + "\n".join(lines) + "\n", [widest] if widest else []


def words_from_srt(text):
    """An SRT as word timings (each cue's words spread evenly), so any subtitle file can drive the captions."""
    out = []
    for block in re.split(r"\n\s*\n", text.strip()):
        m = re.search(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)", block)
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        a = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
        b = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
        toks = " ".join(block[m.end():].strip().splitlines()).split()
        for i, t in enumerate(toks):
            out.append({"w": t, "s": a + (b - a) * i / len(toks), "e": a + (b - a) * (i + 1) / len(toks)})
    return out


# ── the edit ───────────────────────────────────────────────────────────────────────────────────────────────────────

def atempo(speed):
    """atempo takes 0.5..2 per step: chain them for anything else."""
    parts, s = [], speed
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    parts.append(f"atempo={s:.4f}")
    return ",".join(parts)


def shape_filter(fit, W, H, label_in, label_out):
    if fit == "pad":
        return f"[{label_in}]scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[{label_out}]"
    if fit == "blur":  # the frame filled with a blurred, zoomed copy of itself behind the whole picture
        return (f"[{label_in}]split=2[{label_out}bg][{label_out}fg];[{label_out}bg]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=24:2,eq=brightness=-0.08[{label_out}b];"
                f"[{label_out}fg]scale={W}:{H}:force_original_aspect_ratio=decrease[{label_out}f];[{label_out}b][{label_out}f]overlay=(W-w)/2:(H-h)/2,setsar=1[{label_out}]")
    return f"[{label_in}]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1[{label_out}]"


def plan_edit(spec, infos, nvenc, font_file):
    """The ffmpeg command for an edit spec. infos: {source key: (local path, probe info)}. Returns (args, layout, seconds,
    files to write next to it first)."""
    plat = spec.get("platform") or "reels"
    p = PLATFORMS.get(plat) or PLATFORMS["reels"]
    shape = spec.get("shape")
    W, H = SHAPES[shape] if shape in SHAPES else (p["w"], p["h"])
    fps = int(num(spec.get("fps"), 15, 60, 30))
    fit = spec.get("fit") if spec.get("fit") in ("crop", "pad", "blur") else "crop"
    clips = spec.get("clips") or [{"src": next(iter(infos))}]
    args, fg, inputs, files = ["ffmpeg", "-hide_banner", "-y", "-nostats"], [], {}, {}

    def add_input(key, extra=()):
        path, _ = infos[key]
        args.extend([*extra, "-i", path])
        inputs.setdefault(key, []).append(len([a for a in args if a == "-i"]) - 1)
        return inputs[key][-1]

    seg_v, seg_a, total = [], [], 0.0
    for i, c in enumerate(clips):
        key = c.get("src")
        if key not in infos:
            raise MediaError(f"clip {i + 1}: no input called {key!r} (inputs: {', '.join(infos)})")
        path, info = infos[key]
        speed = num(c.get("speed"), 0.25, 4, 1.0)
        if info.get("image"):
            dur = num(c.get("seconds"), 0.5, 60, 3.0)
            zoom = c.get("zoom", True)
            # zoompan makes all d frames from one picture: feed it the photo once (looped, every frame would make d more)
            n = add_input(key) if zoom else add_input(key, ["-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}"])
            if zoom:  # a slow push-in so a still doesn't sit dead
                zw, zh = int(W * 1.25) // 2 * 2, int(H * 1.25) // 2 * 2  # a little headroom is enough for a 10% push-in, and 4x cheaper than 2x
                fg.append(f"[{n}:v]scale={zw}:{zh}:force_original_aspect_ratio=increase,crop={zw}:{zh},"
                          f"zoompan=z='min(zoom+0.0006,1.10)':d={int(dur * fps)}:s={W}x{H}:fps={fps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',setsar=1,format=yuv420p[v{i}]")
            else:
                fg.append(shape_filter("pad" if fit == "crop" and c.get("whole") else fit, W, H, f"{n}:v", f"v{i}s"))
                fg.append(f"[v{i}s]fps={fps},format=yuv420p[v{i}]")
            fg.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{dur:.3f}[a{i}]")
            seg_v.append(f"[v{i}]"); seg_a.append(f"[a{i}]")
            total += dur
            continue
        a = num(c.get("from"), 0, info["duration"], 0.0)
        b = num(c.get("to"), a + 0.1, info["duration"], info["duration"])
        if b - a < 0.1:
            raise MediaError(f"clip {i + 1}: from {a} to {b} is empty (the video is {info['duration']} s)")
        n = add_input(key)
        fg.append(f"[{n}:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{speed:.4f}[v{i}r]")
        fg.append(shape_filter(fit, W, H, f"v{i}r", f"v{i}s"))
        fg.append(f"[v{i}s]fps={fps},format=yuv420p[v{i}]")
        dur = (b - a) / speed
        if info.get("has_audio") and not c.get("mute"):
            fg.append(f"[{n}:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS,{atempo(speed)},aresample=48000,aformat=channel_layouts=stereo[a{i}]")
        else:
            fg.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{dur:.3f}[a{i}]")
        seg_v.append(f"[v{i}]"); seg_a.append(f"[a{i}]")
        total += dur
    fg.append(f"{''.join(v + a for v, a in zip(seg_v, seg_a))}concat=n={len(clips)}:v=1:a=1[vcat][acat]")
    maxs = num(spec.get("max_seconds"), 1, 3600, p["max_s"] or 3600)
    total = min(total, maxs)

    # sound: the clips' own (original_volume_db), a voiceover on top, music ducked under the speech
    ov = spec.get("original_volume_db")
    fg.append(f"[acat]volume={'0' if ov == 'mute' else f'{num(ov, -60, 12, 0):.1f}dB'}[orig]")
    speech, mix = ["[orig]"], []
    if spec.get("voice"):
        v = spec["voice"]
        delay = int(num(v.get("at"), 0, 3600, 0) * 1000)
        srcs = v["src"] if isinstance(v["src"], list) else [v["src"]]
        if len(srcs) == 1:
            fg.append(f"[{add_input(srcs[0])}:a]aresample=48000,aformat=channel_layouts=stereo[vraw]")
        else:  # the factory's lines, one file each, back to back with a short gap (gap_s) between them
            gap = num(v.get("gap_s"), 0, 3, 0.25)
            parts = []
            for k, src in enumerate(srcs):
                fg.append(f"[{add_input(src)}:a]aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur={gap:.2f}[vl{k}]")
                parts.append(f"[vl{k}]")
            fg.append(f"{''.join(parts)}concat=n={len(parts)}:v=0:a=1[vraw]")
        fg.append(f"[vraw]volume={num(v.get('volume_db'), -30, 12, 0):.1f}dB,adelay={delay}|{delay}[voice]")
        speech.append("[voice]")
    if len(speech) > 1:
        fg.append(f"{''.join(speech)}amix=inputs={len(speech)}:duration=first:normalize=0[speech]")
    else:
        fg.append("[orig]anull[speech]")
    if spec.get("music"):
        m = spec["music"]
        n = add_input(m["src"], ["-stream_loop", "-1"])
        fade = num(m.get("fade_s"), 0, 10, 1.5)
        fg.append(f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo,volume={num(m.get('volume_db'), -40, 0, -16):.1f}dB,atrim=0:{total:.3f},"
                  f"afade=t=in:d={fade:.2f},afade=t=out:st={max(0, total - fade):.3f}:d={fade:.2f}[mus]")
        if m.get("duck", True):  # the music dips whenever someone speaks
            fg.append("[speech]asplit=2[sp1][sp2];[mus][sp2]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]")
            fg.append("[sp1][duck]amix=inputs=2:duration=first:normalize=0[amixed]")
        else:
            fg.append("[speech][mus]amix=inputs=2:duration=first:normalize=0[amixed]")
    else:
        fg.append("[speech]anull[amixed]")
    lufs = num(spec.get("lufs"), -30, -8, p["lufs"])
    fa = spec.get("fade") or {}
    afades = ""
    if num(fa.get("in"), 0, 5, 0):
        afades += f",afade=t=in:d={num(fa.get('in'), 0, 5, 0):.2f}"
    if num(fa.get("out"), 0, 5, 0):
        afades += f",afade=t=out:st={max(0, total - num(fa.get('out'), 0, 5, 0)):.3f}:d={num(fa.get('out'), 0, 5, 0):.2f}"
    fg.append(f"[amixed]atrim=0:{total:.3f}{afades},loudnorm=I={lufs:.1f}:TP=-1.5:LRA=11,aresample=48000[aout]")

    # picture on top: logo, text, captions, fades
    vlab, layout = "vcat", []
    if spec.get("logo"):
        lg = spec["logo"]
        n = add_input(lg["src"])
        lw = int(W * num(lg.get("size"), 0.04, 0.5, 0.12))
        safe = p["safe"]
        mx, my = int(safe["left"] * W / p["w"]) + 10, int(safe["top"] * H / p["h"]) + 10
        corner = lg.get("corner") or "tr"
        x = f"{mx}" if "l" in corner else f"W-w-{int(safe['right'] * W / p['w']) + 10}"
        y = f"{my}" if "t" in corner else f"H-h-{int(safe['bottom'] * H / p['h']) + 10}"
        fg.append(f"[{n}:v]scale={lw}:-1,format=rgba,colorchannelmixer=aa={num(lg.get('opacity'), 0.1, 1, 0.9):.2f}[logo]")
        fg.append(f"[{vlab}][logo]overlay={x}:{y}[vlogo]")
        vlab = "vlogo"
    for k, t in enumerate(spec.get("texts") or []):
        txt = str(t.get("text") or "")[:200]
        if not txt:
            continue
        size = int(num(t.get("size"), 20, 200, 64) * W / 1080)
        # wrapped to the frame (and made smaller if it would take more than 3 lines): text never runs off the edges
        while True:
            per_line = max(4, int((W - 2 * max(p["safe"]["left"], p["safe"]["right"]) * W / p["w"]) / (size * 0.56)))
            wrapped = textwrap.wrap(txt, per_line) or [txt]
            if len(wrapped) <= 3 or size <= 28:
                break
            size = int(size * 0.88)
        txt = "\n".join(wrapped)
        pos = t.get("position") or "top"
        safe = p["safe"]
        y = {"top": f"{int(safe['top'] * H / p['h']) + 20}", "middle": "(h-text_h)/2", "bottom": f"h-text_h-{int(safe['bottom'] * H / p['h']) + 40}"}.get(pos, "(h-text_h)/2")
        files[f"text{k}.txt"] = txt  # from a file: no escaping to get wrong (commas, colons, quotes, %, line breaks)
        a, b = num(t.get("from"), 0, 3600, 0), num(t.get("to"), 0, 3600, total)
        font = f"fontfile='{font_file}':" if font_file else ""
        box = ":box=1:boxcolor=black@0.55:boxborderw=18" if t.get("box", True) else ""
        fg.append(f"[{vlab}]drawtext={font}textfile=text{k}.txt:expansion=none:fontsize={size}:line_spacing={int(size * 0.2)}:fontcolor=white:x=(w-text_w)/2:y={y}:borderw=3:bordercolor=black{box}:enable='between(t,{a:.2f},{b:.2f})'[vt{k}]")
        vlab = f"vt{k}"
        tw = max(len(line) for line in wrapped) * size * 0.55
        th = len(wrapped) * size * 1.2
        yy = {"top": safe["top"] * H / p["h"] + 20, "middle": H / 2 - th / 2, "bottom": H - th - safe["bottom"] * H / p["h"] - 40}.get(pos, H / 2)
        layout.append({"text": " ".join(wrapped), "x0": (W - tw) / 2, "x1": (W + tw) / 2, "y0": yy, "y1": yy + th})
    if spec.get("_captions_file"):
        fg.append(f"[{vlab}]subtitles=filename='{spec['_captions_file']}'[vcap]")
        vlab = "vcap"
        layout += spec.get("_captions_layout") or []
    vf = []
    if num(fa.get("in"), 0, 5, 0):
        vf.append(f"fade=t=in:d={num(fa.get('in'), 0, 5, 0):.2f}")
    if num(fa.get("out"), 0, 5, 0):
        vf.append(f"fade=t=out:st={max(0, total - num(fa.get('out'), 0, 5, 0)):.3f}:d={num(fa.get('out'), 0, 5, 0):.2f}")
    fg.append(f"[{vlab}]{','.join(vf) or 'null'},format=yuv420p[vout]")

    enc = (["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0"] if nvenc
           else ["-c:v", "libx264", "-preset", "veryfast" if spec.get("quality") == "fast" else "medium", "-crf", "20"])
    args += ["-filter_complex", ";".join(fg), "-map", "[vout]", "-map", "[aout]", "-t", f"{total:.3f}", *enc, "-pix_fmt", "yuv420p", "-r", str(fps),
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "out.mp4"]
    return args, layout, round(total, 2), files


def has_nvenc():
    try:
        enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20).stdout
        return "h264_nvenc" in enc and shutil.which("nvidia-smi") is not None and subprocess.run(["nvidia-smi"], capture_output=True, timeout=20).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def font_file():
    try:
        return subprocess.run(["fc-match", "-f", "%{file}", "DejaVu Sans:bold"], capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:  # noqa: BLE001
        return None


def fix_loudness(run, src, dst, target):
    """Two-pass loudness for the finished file (the one pass inside an edit drifts on short clips): measure, then set it
    exactly, the picture copied as it is. Returns the LUFS it ended at, or None when it was already within 1 LU."""
    code, _, err = run(["ffmpeg", "-hide_banner", "-nostats", "-i", src, "-vn", "-af", f"loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], timeout=1800)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err)
    if code or not m:
        return None
    d = json.loads(m.group(0))
    if abs(float(d["input_i"]) - target) <= 1.0:
        return None
    af = (f"loudnorm=I={target}:TP=-1.5:LRA=11:measured_I={d['input_i']}:measured_TP={d['input_tp']}:measured_LRA={d['input_lra']}:"
          f"measured_thresh={d['input_thresh']}:offset={d['target_offset']}:linear=true,aresample=48000")
    code, _, err = run(["ffmpeg", "-hide_banner", "-y", "-nostats", "-i", src, "-c:v", "copy", "-af", af, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", dst], timeout=1800)
    if code:
        raise MediaError(f"loudness pass failed: {err.strip()[-300:]}")
    return target


# ── repurposing: picking shorts, carousel frames, the audiogram ────────────────────────────────────────────────────

HOOK_WORDS = {"how", "why", "what", "secret", "mistake", "never", "always", "stop", "best", "worst", "easy", "fast", "free", "truth",
              "nobody", "everyone", "you", "here's", "this", "biggest", "simple", "actually", "wrong", "need"}


def sentences(words):
    out, cur = [], []
    for w in words:
        cur.append(w)
        if re.search(r"[.!?]$", w["w"]) or (len(cur) > 1 and w["s"] - cur[-2]["e"] > 0.9):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [{"s": c[0]["s"], "e": c[-1]["e"], "text": " ".join(x["w"] for x in c), "n": len(c)} for c in out]


def pick_segments(words, duration, count=3, min_s=20, max_s=55):
    """Shorts out of a long video from what's said: windows that start and end on a sentence, dense with speech, that
    open on a hook (a question, a number, how / why / mistake…). Each says why it was picked. No words: even spacing."""
    if not words:
        if duration < min_s:
            return []
        step = duration / max(count, 1)
        return [{"from": round(i * step, 2), "to": round(min(i * step + max_s, duration), 2), "why": "spaced evenly (no words to go on)"} for i in range(count)]
    sents = sentences(words)
    cands = []
    for i, first in enumerate(sents):
        for j in range(i, len(sents)):
            span = sents[j]["e"] - first["s"]
            if span > max_s:
                break
            if span < min_s:
                continue
            n = sum(x["n"] for x in sents[i:j + 1])
            pace = n / span  # words a second: dense talk holds a viewer
            opener = first["text"].lower()
            hook = sum(1 for t in re.findall(r"[a-z']+", opener)[:12] if t in HOOK_WORDS) + (2 if "?" in first["text"] else 0) + (1 if re.search(r"\d", opener) else 0)
            ends = 1 if re.search(r"[.!]$", sents[j]["text"]) else 0
            cands.append({"from": round(max(0, first["s"] - 0.15), 2), "to": round(min(duration, sents[j]["e"] + 0.35), 2), "score": pace + hook * 0.6 + ends * 0.3,
                          "why": f"opens \"{first['text'][:60]}\"; {pace:.1f} words/s" + (f"; hook words {hook}" if hook else "")})
    cands.sort(key=lambda c: -c["score"])
    picked = []
    for c in cands:
        if all(c["to"] <= p["from"] or c["from"] >= p["to"] for p in picked):
            picked.append(c)
        if len(picked) >= count:
            break
    return [{k: v for k, v in c.items() if k != "score"} for c in sorted(picked, key=lambda c: c["from"])]


def carousel_times(cuts, duration, n):
    """Where to take a carousel's slides: the middle of each shot when there are enough, else evenly through it."""
    bounds = [0.0] + [c for c in cuts if 0.3 < c < duration - 0.3] + [duration]
    mids = [(a + b) / 2 for a, b in zip(bounds, bounds[1:]) if b - a > 0.6]
    if len(mids) >= n:
        step = len(mids) / n
        return [mids[int(i * step)] for i in range(n)]
    return [duration * (i + 0.5) / n for i in range(n)]


def frame(run, src, t, dst, w, h):
    code, _, err = run(["ffmpeg", "-hide_banner", "-y", "-ss", f"{t:.3f}", "-i", src, "-frames:v", "1",
                        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}", "-q:v", "2", dst], timeout=300)
    if code:
        raise MediaError(f"couldn't take a frame at {t:.1f} s: {err.strip()[-200:]}")


def audiogram(audio, cover, a, z, W, H, title, font_file):
    """A podcast clip as a video: the cover (or black) blurred behind, the cover sharp in the middle, a waveform under
    it moving with the voice, the title on top. Captions go on in a second pass (render_spec)."""
    d = z - a
    font = f"fontfile='{font_file}':" if font_file else ""
    files = {}
    args = ["ffmpeg", "-hide_banner", "-y", "-nostats", "-ss", f"{a:.3f}", "-t", f"{d:.3f}", "-i", audio]
    if cover:
        args += ["-loop", "1", "-t", f"{d:.3f}", "-i", cover]
        bg = (f"[1:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=30:2,eq=brightness=-0.25[bg];"
              f"[1:v]scale={int(W * 0.7)}:{int(W * 0.7)}:force_original_aspect_ratio=increase,crop={int(W * 0.7)}:{int(W * 0.7)}[cv];"
              f"[bg][cv]overlay=(W-w)/2:{int(H * 0.22)}[base]")
    else:
        args += ["-f", "lavfi", "-t", f"{d:.3f}", "-i", f"color=c=0x0a0a0a:s={W}x{H}:r=30"]
        bg = "[1:v]null[base]"
    wave_h = int(H * 0.12)
    fg = (f"{bg};[0:a]aformat=channel_layouts=mono,showwaves=s={int(W * 0.84)}x{wave_h}:mode=cline:rate=30:colors=white:scale=sqrt:draw=full[wv];"
          f"[base][wv]overlay=(W-w)/2:{int(H * 0.22 + W * 0.7 + 60) if cover else int(H / 2 - wave_h / 2)}:shortest=1[v0]")
    if title:
        files["title.txt"] = "\n".join(textwrap.wrap(title, 26)[:3])
        fg += f";[v0]drawtext={font}textfile=title.txt:expansion=none:fontsize={int(W * 0.06)}:line_spacing=12:fontcolor=white:x=(w-text_w)/2:y={int(H * 0.1)}[v1]"
    else:
        fg += ";[v0]null[v1]"
    args += ["-filter_complex", fg, "-map", "[v1]", "-map", "0:a", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-shortest", "audiogram.mp4"]
    return args, files
