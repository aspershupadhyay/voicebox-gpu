// Video templates (docs/AUTOMATION.md, phase 6): HyperFrames compositions filled from a little JSON, so a model never
// writes HTML. Each template is a function of its fields and the brand (colours, font) that returns index.html; the
// worker renders it (bench op "template", `hyperframes render`). Fonts and GSAP come from the worker's cache
// (assets/, written by bench.py), never a CDN at render time, so the first frame isn't black while they load; a
// music bed (an input key) is mixed under the piece's own sound by the worker. Custom scenes come from a repo (videos-post) at a
// commit: repo checkout, then video_template action render with that workspace folder.
export type Brand = { bg: string; ink: string; accent: string; font: string };
export const BRAND: Brand = { bg: "#0a0a0a", ink: "#ffffff", accent: "#ffb020", font: "Inter" };

const SIZES = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350] } as const;
export type Shape = keyof typeof SIZES;

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const color = (c: unknown, d: string) => (typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : d);
const font = (f: unknown, d: string) => (typeof f === "string" && /^[A-Za-z0-9 ]{2,40}$/.test(f) ? f : d);

type Fields = Record<string, unknown>;
type Built = { html: string; seconds: number; media: string[] };

export const TEMPLATES: Record<string, { about: string; fields: string; build: (f: Fields, b: Brand, w: number, h: number) => Built }> = {
  title_card: {
    about: "A big title (and a line under it) over the brand colour, a photo or a video (media: an input key), sliding in.",
    fields: "title, sub?, media? (input key), seconds? (4)",
    build: (f, b, w, h) => {
      const s = Math.min(Math.max(Number(f.seconds) || 4, 2), 20);
      const bg = f.media ? mediaTag(String(f.media), s, 0, "cover") : "";
      return { seconds: s, media: f.media ? [String(f.media)] : [], html: scene(w, h, s, b, `${bg}
    <div class="clip pad" data-start="0" data-duration="${s}" data-track-index="2" style="justify-content:center">
      <h1 id="t" style="font-size:${Math.round(w * 0.09)}px">${esc(f.title)}</h1>
      ${f.sub ? `<p id="s" style="font-size:${Math.round(w * 0.042)}px;color:${b.accent}">${esc(f.sub)}</p>` : ""}
    </div>`, `tl.from("#t", {y: 60, duration: 0.7, ease: "power3.out"}, 0);${f.sub ? `tl.from("#s", {y: 30, opacity: 0, duration: 0.6}, 0.4);` : ""}tl.to(".pad", {opacity: 0, duration: 0.4}, ${s - 0.4});`) };
    },
  },
  list: {
    about: "A numbered list that builds point by point (\"3 tips\"): a heading, then each point in turn.",
    fields: "title, items (2-6 strings), per_item? (2.5 s)",
    build: (f, b, w, h) => {
      const items = (Array.isArray(f.items) ? f.items : []).slice(0, 6).map(String);
      if (items.length < 2) throw new Error("list needs items: 2 to 6 points");
      const per = Math.min(Math.max(Number(f.per_item) || 2.5, 1), 8);
      const s = 1.5 + items.length * per + 1;
      const rows = items.map((it, i) => `<li id="i${i}"><b style="color:${b.accent}">${i + 1}</b><span>${esc(it)}</span></li>`).join("");
      return { seconds: s, media: [], html: scene(w, h, s, b, `
    <div class="clip pad" data-start="0" data-duration="${s}" data-track-index="1">
      <h1 id="t" style="font-size:${Math.round(w * 0.075)}px">${esc(f.title)}</h1>
      <ol style="font-size:${Math.round(w * 0.05)}px">${rows}</ol>
    </div>`, `tl.from("#t", {y: 40, duration: 0.6}, 0);${items.map((_, i) => `tl.from("#i${i}", {x: -50, opacity: 0, duration: 0.5}, ${1.5 + i * per});tl.fromTo("#i${i} b", {scale: 1}, {scale: 1.25, duration: ${(per / 2).toFixed(2)}, yoyo: true, repeat: 1, ease: "sine.inOut"}, ${1.5 + i * per + 0.5});`).join("")}`) };
    },
  },
  quote: {
    about: "A quote in large type with who said it, over the brand colour or a photo.",
    fields: "quote, author?, media? (input key), seconds? (6)",
    build: (f, b, w, h) => {
      const s = Math.min(Math.max(Number(f.seconds) || 6, 3), 20);
      const bg = f.media ? mediaTag(String(f.media), s, 0, "cover", "opacity:.35") : "";
      return { seconds: s, media: f.media ? [String(f.media)] : [], html: scene(w, h, s, b, `${bg}
    <div class="clip pad" data-start="0" data-duration="${s}" data-track-index="2" style="justify-content:center">
      <p id="q" style="font-size:${Math.round(w * 0.065)}px;line-height:1.25">“${esc(f.quote)}”</p>
      ${f.author ? `<p id="a" style="font-size:${Math.round(w * 0.04)}px;color:${b.accent}">— ${esc(f.author)}</p>` : ""}
    </div>`, `tl.from("#q", {y: 30, duration: 0.9}, 0);${f.author ? `tl.from("#a", {opacity: 0, duration: 0.6}, 1.2);` : ""}`) };
    },
  },
  lower_third: {
    about: "A video with a name and title sliding in at the bottom left for a few seconds.",
    fields: "media (a video's input key), name, role?, at? (1 s), hold? (4 s), seconds (the video's length)",
    build: (f, b, w, h) => {
      if (!f.media) throw new Error("lower_third needs media: the video's input key");
      const s = Math.min(Math.max(Number(f.seconds) || 10, 2), 600);
      const at = Number(f.at) || 1, hold = Number(f.hold) || 4;
      return { seconds: s, media: [String(f.media)], html: scene(w, h, s, b, `${mediaTag(String(f.media), s, 0, "cover")}
    <div id="lt" class="clip" data-start="${at}" data-duration="${hold}" data-track-index="2" style="position:absolute;left:${Math.round(w * 0.07)}px;bottom:${Math.round(h * 0.22)}px;background:${b.bg}e6;padding:${Math.round(w * 0.02)}px ${Math.round(w * 0.03)}px;border-left:${Math.round(w * 0.008)}px solid ${b.accent}">
      <div style="font-size:${Math.round(w * 0.045)}px;font-weight:700">${esc(f.name)}</div>
      ${f.role ? `<div style="font-size:${Math.round(w * 0.03)}px;opacity:.8">${esc(f.role)}</div>` : ""}
    </div>`, `tl.from("#lt", {x: -80, opacity: 0, duration: 0.5}, ${at});tl.to("#lt", {x: -80, opacity: 0, duration: 0.4}, ${at + hold - 0.4});`) };
    },
  },
};

/** A video or photo filling the frame, as a timed clip itself (HyperFrames seeks a <video> clip frame by frame). The
 *  worker turns data-media into a real <img> or muted <video> with its file (media/<key>.<ext>), and keeps the sound
 *  of a video through the <audio> beside it (dropped for a photo). */
function mediaTag(key: string, seconds: number, start: number, fit: string, style = "") {
  const k = esc(key);
  return `<img data-media="${k}" class="clip" data-start="${start}" data-duration="${seconds}" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};${style}" />
    <audio data-media-audio="${k}" data-start="${start}" data-duration="${seconds}" data-track-index="3" data-volume="1"></audio>`;
}

function scene(w: number, h: number, s: number, b: Brand, body: string, tl: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="assets/fonts.css">
<style>
  html, body { margin: 0; background: ${b.bg}; }
  #stage { position: relative; width: ${w}px; height: ${h}px; overflow: hidden; background: ${b.bg}; color: ${b.ink}; font-family: "${b.font}", "DejaVu Sans", sans-serif; }
  .pad { position: absolute; inset: 0; display: flex; flex-direction: column; padding: ${Math.round(h * 0.12)}px ${Math.round(w * 0.08)}px; gap: ${Math.round(w * 0.03)}px; }
  h1 { margin: 0; font-weight: 800; line-height: 1.05; letter-spacing: -0.02em; }
  p { margin: 0; }
  ol { list-style: none; padding: 0; margin: ${Math.round(h * 0.04)}px 0 0; display: flex; flex-direction: column; gap: ${Math.round(h * 0.03)}px; }
  li { display: flex; gap: ${Math.round(w * 0.04)}px; align-items: baseline; font-weight: 600; }
  li b { display: inline-block; transform-origin: 50% 60%; }
</style></head>
<body>
  <div id="stage" data-composition-id="vb" data-start="0" data-duration="${s}" data-width="${w}" data-height="${h}">
    ${body}
    <div class="clip" data-start="0" data-duration="${s}" data-track-index="5" style="position:absolute;inset:0;pointer-events:none">
      <div id="drift" style="position:absolute;width:${Math.round(w * 0.9)}px;height:${Math.round(w * 0.9)}px;border-radius:50%;background:${b.accent};opacity:.16;left:${Math.round(w * 0.45)}px;top:${Math.round(h * -0.12)}px"></div>
      <div id="bar" style="position:absolute;left:0;bottom:0;height:${Math.max(6, Math.round(h * 0.006))}px;width:${w}px;background:${b.accent};transform-origin:0 50%;transform:scaleX(0)"></div>
    </div>
    <script src="assets/gsap.min.js"></script>
    <script>
      const tl = gsap.timeline({ paused: true });
      // something moves on every frame from frame 0 (docs/FACTORY.md A): the stage breathes, a shape drifts, the bar fills
      tl.fromTo("#stage > .pad, #stage > img, #stage > video", {scale: 1}, {scale: 1.04, duration: ${s}, ease: "none"}, 0);
      tl.fromTo("#drift", {x: 0, y: 0}, {x: ${-Math.round(w * 0.5)}, y: ${Math.round(h * 0.55)}, duration: ${s}, ease: "sine.inOut"}, 0);
      tl.to("#bar", {scaleX: 1, duration: ${s}, ease: "none"}, 0);
      ${tl}
      window.__timelines = window.__timelines || {};
      window.__timelines.vb = tl;
    </script>
  </div>
</body></html>
`;
}

export function build(template: string, fields: Fields, shape: Shape = "9:16", brand: Partial<Brand> = {}) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`template: one of ${Object.keys(TEMPLATES).join(", ")}`);
  const [w, h] = SIZES[shape] ?? SIZES["9:16"];
  const b: Brand = { bg: color(brand.bg, BRAND.bg), ink: color(brand.ink, BRAND.ink), accent: color(brand.accent, BRAND.accent), font: font(brand.font, BRAND.font) };
  return { ...t.build(fields, b, w, h), width: w, height: h, font: b.font };
}
