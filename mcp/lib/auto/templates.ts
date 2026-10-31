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
    fields: "title, items (2-6 strings), per_item? (2.5 s), lead? (1.5 s before the first point)",
    build: (f, b, w, h) => {
      const items = (Array.isArray(f.items) ? f.items : []).slice(0, 6).map(String);
      if (items.length < 2) throw new Error("list needs items: 2 to 6 points");
      const per = Math.min(Math.max(Number(f.per_item) || 2.5, 0.4), 8);
      const lead = Math.min(Math.max(Number(f.lead) || 1.5, 0.3), 5);
      const s = Math.max(lead + items.length * per + 1, Number(f.seconds) || 0);
      const rows = items.map((it, i) => `<li id="i${i}"><b style="color:${b.accent}">${i + 1}</b><span>${esc(it)}</span></li>`).join("");
      return { seconds: s, media: [], html: scene(w, h, s, b, `
    <div class="clip pad" data-start="0" data-duration="${s}" data-track-index="1">
      <h1 id="t" style="font-size:${Math.round(w * 0.075)}px">${esc(f.title)}</h1>
      <ol style="font-size:${Math.round(w * 0.05)}px">${rows}</ol>
    </div>`, `tl.from("#t", {y: 40, duration: 0.6}, 0);${items.map((_, i) => `tl.from("#i${i}", {x: -50, opacity: 0, duration: ${Math.min(0.5, per * 0.8).toFixed(2)}}, ${lead + i * per});tl.fromTo("#i${i} b", {scale: 1}, {scale: 1.25, duration: ${Math.max(0.2, per / 2).toFixed(2)}, yoyo: true, repeat: 1, ease: "sine.inOut"}, ${lead + i * per + Math.min(0.5, per * 0.8)});`).join("")}`) };
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
    <!--STICKERS-->
    <script src="assets/gsap.min.js"></script>
    <!--LOTTIE-->
    <script>
      const tl = gsap.timeline({ paused: true });
      // something moves on every frame from frame 0 (docs/FACTORY.md A): the stage breathes, a shape drifts, the bar fills
      tl.fromTo("#stage > .pad, #stage > img, #stage > video", {scale: 1}, {scale: 1.04, duration: ${s}, ease: "none"}, 0);
      tl.fromTo("#drift", {x: 0, y: 0}, {x: ${-Math.round(w * 0.5)}, y: ${Math.round(h * 0.55)}, duration: ${s}, ease: "sine.inOut"}, 0);
      tl.to("#bar", {scaleX: 1, duration: ${s}, ease: "none"}, 0);
      ${tl}
      /*STICKERS*/
      window.__timelines = window.__timelines || {};
      window.__timelines.vb = tl;
    </script>
  </div>
</body></html>
`;
}

export function build(template: string, fields: Fields, shape: Shape = "9:16", brand: Partial<Brand> = {}, half = false) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`template: one of ${Object.keys(TEMPLATES).join(", ")}`);
  // half: a draft at half the size (540x960 for 9:16): everything is laid out in proportion, and Chromium paints a
  // quarter of the pixels (docs/FACTORY.md D)
  const [w, h] = (SIZES[shape] ?? SIZES["9:16"]).map((x) => (half ? x / 2 : x));
  const b: Brand = { bg: color(brand.bg, BRAND.bg), ink: color(brand.ink, BRAND.ink), accent: color(brand.accent, BRAND.accent), font: font(brand.font, BRAND.font) };
  const built = t.build(fields, b, w, h);
  const st = fields.sticker ? sticker(fields.sticker, b, w, h, built.seconds) : null;
  const html = built.html.replace("<!--STICKERS-->", st?.html ?? "").replace("/*STICKERS*/", st?.tl ?? "")
    .replace("<!--LOTTIE-->", st?.lottie ? '<script src="assets/lottie.min.js"></script>' : "");
  return { ...built, html, width: w, height: h, font: b.font, lottie: !!st?.lottie };
}

// ── stickers: a small animated accent on any template (fields.sticker), drawn in SVG and moved by GSAP, so it costs
// nothing to render and needs no files; or any Lottie animation (kind "lottie" with its JSON, which the MCP reads from
// Files), played frame-exact on the template's timeline (lottie-web from the worker's cache, never a CDN)
export const STICKERS = ["badge", "arrow", "check", "follow", "pop", "lottie"] as const;
type StickerSpec = { kind?: string; text?: string; at?: number; position?: string; lottie?: unknown };

function sticker(raw: unknown, b: Brand, w: number, h: number, s: number) {
  const o: StickerSpec = typeof raw === "string" ? { kind: raw } : (raw && typeof raw === "object" ? raw as StickerSpec : {});
  const kind = String(o.kind ?? "");
  if (!(STICKERS as readonly string[]).includes(kind)) throw new Error(`sticker: one of ${STICKERS.join(", ")}`);
  const at = Math.min(Math.max(Number(o.at) || 0.15, 0), Math.max(0, s - 0.5));
  const pos = o.position ?? (kind === "arrow" || kind === "follow" ? "bottom" : kind === "badge" ? "top" : "middle");
  const place = pos === "top" ? `top:${Math.round(h * 0.09)}px;left:0;right:0` : pos === "bottom" ? `bottom:${Math.round(h * 0.2)}px;left:0;right:0`
    : pos === "corner" ? `top:${Math.round(h * 0.08)}px;right:${Math.round(w * 0.06)}px` : `top:${Math.round(h * 0.42)}px;left:0;right:0`;
  const wrap = (inner: string) => `<div class="clip" data-start="0" data-duration="${s}" data-track-index="6" style="position:absolute;inset:0;pointer-events:none">
      <div style="position:absolute;${place};display:flex;justify-content:center">${inner}</div></div>`;
  const u = Math.round(w * 0.01); // one unit: 1% of the width
  const label = esc(String(o.text ?? "").slice(0, 40));
  if (kind === "badge") return { html: wrap(`<div id="stk" style="background:${b.accent};color:${b.bg};font-weight:800;letter-spacing:.06em;font-size:${u * 4}px;padding:${u * 1.4}px ${u * 3}px;border-radius:${u * 1.2}px;text-transform:uppercase">${label || "NEW"}</div>`),
    tl: `tl.from("#stk", {scale: 0, rotation: -8, duration: 0.45, ease: "back.out(2.5)"}, ${at});tl.to("#stk", {x: ${u}, duration: 0.06, yoyo: true, repeat: 5, ease: "none"}, ${at + 0.5});` };
  if (kind === "arrow") return { html: wrap(`<svg id="stk" width="${u * 14}" height="${u * 14}" viewBox="0 0 100 100"><path d="M20 35 L50 65 L80 35" fill="none" stroke="${b.accent}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`),
    tl: `tl.from("#stk", {opacity: 0, y: -${u * 4}, duration: 0.35}, ${at});tl.to("#stk", {y: ${u * 3}, duration: 0.45, yoyo: true, repeat: ${Math.max(1, Math.floor((s - at - 0.4) / 0.45) - 1)}, ease: "sine.inOut"}, ${at + 0.35});` };
  if (kind === "check") return { html: wrap(`<svg id="stk" width="${u * 22}" height="${u * 22}" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="${b.accent}" stroke-width="7" stroke-dasharray="277" stroke-dashoffset="277" id="stkc"/><path id="stkp" d="M30 52 L45 66 L72 36" fill="none" stroke="${b.ink}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="70" stroke-dashoffset="70"/></svg>`),
    tl: `tl.to("#stkc", {strokeDashoffset: 0, duration: 0.5, ease: "power2.out"}, ${at});tl.to("#stkp", {strokeDashoffset: 0, duration: 0.35, ease: "power2.out"}, ${at + 0.4});tl.fromTo("#stk", {scale: 0.9}, {scale: 1, duration: 0.3, ease: "back.out(3)"}, ${at + 0.7});` };
  if (kind === "follow") return { html: wrap(`<div id="stk" style="display:flex;align-items:center;gap:${u * 1.5}px;background:${b.accent};color:${b.bg};font-weight:800;font-size:${u * 4.2}px;padding:${u * 2}px ${u * 4}px;border-radius:999px"><span style="font-size:${u * 5.5}px;line-height:1">+</span>${label ? `Follow ${label}` : "Follow"}</div>`),
    tl: `tl.from("#stk", {y: ${u * 12}, opacity: 0, duration: 0.5, ease: "back.out(1.8)"}, ${at});tl.to("#stk", {scale: 0.92, duration: 0.12, yoyo: true, repeat: 1}, ${at + 1.1});` };
  if (kind === "pop") return { html: wrap(`<div id="stk" style="color:${b.accent};font-weight:900;font-size:${u * 14}px;letter-spacing:-0.02em;text-shadow:0 ${u * 0.6}px 0 ${b.bg}">${label || "WAIT"}</div>`),
    tl: `tl.from("#stk", {scale: 3, opacity: 0, duration: 0.35, ease: "power4.out"}, ${at});tl.to("#stk", {opacity: 0, duration: 0.3}, ${Math.min(s - 0.3, at + 1.6)});` };
  // lottie: its JSON inline (the MCP read it from Files), driven through a proxy so a seek to any frame shows that frame
  const data = (typeof o.lottie === "string" ? o.lottie : JSON.stringify(o.lottie ?? null)).replace(/<\//g, "<\\/"); // never a </script> inside
  if (!data || data === "null" || data.length > 600_000) throw new Error("sticker lottie: give lottie (a Files id of a Lottie .json, up to 600 KB)");
  const size = Math.round(w * 0.42);
  return { lottie: true, html: wrap(`<div id="stk" style="width:${size}px;height:${size}px"></div>`),
    tl: `const stkData = ${data};
      const stkAnim = lottie.loadAnimation({ container: document.getElementById("stk"), renderer: "svg", loop: false, autoplay: false, animationData: stkData });
      const stkFrames = Math.max(1, (stkData.op || 60) - (stkData.ip || 0));
      const stkProxy = { _f: 0, get f() { return this._f; }, set f(v) { this._f = v; stkAnim.goToAndStop(v, true); } };
      tl.fromTo(stkProxy, {f: 0}, {f: stkFrames - 1, duration: Math.min(${s - at}, stkFrames / (stkData.fr || 30)), ease: "none"}, ${at});` };
}
