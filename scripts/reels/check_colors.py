#!/usr/bin/env python3
"""The slop-colour check (the owner's hard rule, 2026-11-02): fails on the colours AI agents reach for by default.
usage: python3 scripts/reels/check_colors.py <file> [<file> ...]      exit 1 if anything is flagged

Flags, for every #hex / rgb() / rgba() / hsl() colour in the file:
  1. a colour on the banned list (Tailwind / shadcn defaults and the usual "AI" palette), or within a small distance of one
  2. any purple, violet, indigo or lavender (hue 235-300 deg with saturation over 18%): no exceptions
  3. neon: saturation over 75% at mid lightness (cheap, glowing "tech" colours)
  4. pure black, pure white and pure primaries (#000, #fff, #f00, #0f0, #00f)
  5. linear-, conic- and mesh-style gradients (the dot grid's radial-gradient dots are allowed)
The rules behind it are in .claude/skills/video-director/references/style-guide.md → "Banned colours"."""
import re, sys, colorsys

BANNED = {
    # AI purple / indigo / violet (Tailwind 400-700, shadcn, "AI startup" defaults)
    '#6366f1': 'indigo-500', '#4f46e5': 'indigo-600', '#818cf8': 'indigo-400', '#4338ca': 'indigo-700',
    '#8b5cf6': 'violet-500', '#7c3aed': 'violet-600', '#a78bfa': 'violet-400', '#6d28d9': 'violet-700',
    '#a855f7': 'purple-500', '#9333ea': 'purple-600', '#c084fc': 'purple-400', '#7e22ce': 'purple-700',
    '#7c6cf2': 'the v1 Cyclon violet', '#a99eff': 'the v1 Cyclon lilac', '#667eea': 'the purple-blue gradient start',
    '#764ba2': 'the purple-blue gradient end', '#5b5bd6': 'radix iris', '#6e56cf': 'radix violet',
    # pastel lavender washes
    '#e0e7ff': 'indigo-100', '#ede9fe': 'violet-100', '#f3e8ff': 'purple-100', '#ece9f5': 'the v1 lavender wash',
    '#e4e0fb': 'the v1 lilac tint', '#c7d2fe': 'indigo-200', '#ddd6fe': 'violet-200',
    # default blues
    '#3b82f6': 'blue-500', '#2563eb': 'blue-600', '#60a5fa': 'blue-400', '#1d4ed8': 'blue-700', '#0ea5e9': 'sky-500',
    '#2f6feb': 'GitHub-ish link blue',
    # neon cyan / teal "cyber"
    '#06b6d4': 'cyan-500', '#22d3ee': 'cyan-400', '#14b8a6': 'teal-500', '#2dd4bf': 'teal-400', '#00ffff': 'pure cyan',
    # hot pink / fuchsia / magenta
    '#ec4899': 'pink-500', '#db2777': 'pink-600', '#d946ef': 'fuchsia-500', '#f472b6': 'pink-400', '#ff00ff': 'magenta',
    '#d63a78': 'the v1 Cyclon pink', '#e86aa6': 'the v1 tile pink',
    # stock success green, amber, orange, red
    '#10b981': 'emerald-500', '#22c55e': 'green-500', '#84cc16': 'lime-500', '#f59e0b': 'amber-500',
    '#eab308': 'yellow-500', '#f97316': 'orange-500', '#ef4444': 'red-500', '#e9482b': 'stock red-orange',
    '#f2b705': 'stock yellow',
    # Claude's clay (the owner: never Claude's colour)
    '#d97757': "Claude's clay", '#cc785c': "Claude's clay", '#da7756': "Claude's clay",
    # Tailwind slate "navy dark mode"
    '#0f172a': 'slate-900', '#1e293b': 'slate-800', '#020617': 'slate-950', '#334155': 'slate-700',
    # pure
    '#000000': 'pure black', '#ffffff': 'pure white', '#ff0000': 'pure red', '#00ff00': 'pure green', '#0000ff': 'pure blue',
}

def rgb_of(tok):
    tok = tok.strip().lower()
    if tok.startswith('#'):
        h = tok[1:]
        if len(h) in (3, 4): h = ''.join(c * 2 for c in h[:3])
        elif len(h) in (6, 8): h = h[:6]
        else: return None
        try: return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError: return None
    m = re.match(r'rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)', tok)
    if m: return tuple(int(float(x)) for x in m.groups())
    m = re.match(r'hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%', tok)
    if m:
        h, s, l = (float(x) for x in m.groups())
        r, g, b = colorsys.hls_to_rgb(h / 360 % 1, l / 100, s / 100)
        return (round(r * 255), round(g * 255), round(b * 255))
    return None

def hexs(c): return '#%02x%02x%02x' % c
BANNED_RGB = {k: rgb_of(k) for k in BANNED}

def verdict(c):
    hx = hexs(c)
    if hx in BANNED: return f'banned: {BANNED[hx]}'
    for k, v in BANNED_RGB.items():
        if k in ('#000000', '#ffffff'): continue
        if sum((a - b) ** 2 for a, b in zip(c, v)) ** .5 < 14: return f'too close to banned {k} ({BANNED[k]})'
    h, l, s = colorsys.rgb_to_hls(*(x / 255 for x in c)); hue = h * 360
    if s > .18 and .08 < l < .97 and 235 <= hue <= 300: return f'purple/violet/lavender (hue {hue:.0f}, sat {s:.0%})'
    if s > .75 and .35 < l < .7: return f'neon (sat {s:.0%}, light {l:.0%})'
    return None

COLOR = re.compile(r'#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)')
def check(path):
    bad = 0
    for n, line in enumerate(open(path, encoding='utf-8', errors='replace'), 1):
        if 'slop-ok' in line: continue          # an explicit, reviewed exception on this line
        for m in COLOR.finditer(line):
            tok = m.group(0)
            if tok.startswith('#') and not re.fullmatch(r'#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})', tok): continue
            c = rgb_of(tok)
            if c is None: continue
            v = verdict(c)
            if v: print(f'{path}:{n}: {tok} -> {v}'); bad += 1
        if re.search(r'(linear|conic)-gradient\(', line):
            print(f'{path}:{n}: gradient -> flat colour only (docs/DESIGN.md)'); bad += 1
    return bad

if __name__ == '__main__':
    total = sum(check(p) for p in sys.argv[1:])
    print(f'{total} slop colour(s)' if total else 'clean: no slop colours')
    sys.exit(1 if total else 0)
