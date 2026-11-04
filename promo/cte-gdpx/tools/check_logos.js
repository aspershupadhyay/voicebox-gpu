// node tools/check_logos.js: every logo tile is drawn on its own background (as the film draws it) and measured.
// A mark fails if too little of it differs from its tile (it vanished: e.g. a black mark on a black tile) or if its
// colour against the tile is under 3:1 (WCAG's floor for graphics). Run it before any render that uses logos.js.
const { chromium } = require('playwright'); const path = require('path');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.setContent('<html><body></body></html>'); await p.addScriptTag({ path: path.resolve(__dirname, '..', 'logos.js') });
  const res = await p.evaluate(async () => {
    const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const out = [];
    for (const L of window.LOGOS) {
      const S = 240, c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d');
      x.fillStyle = L.bg; x.fillRect(0, 0, S, S);
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${S}" height="${S}">${L.svg}</svg>`);
      await img.decode(); x.drawImage(img, 0, 0, S, S);
      const d = x.getImageData(0, 0, S, S).data, bg = hex(L.bg), lb = lum(bg); let n = 0, worst = 99, sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { const px = [d[i], d[i + 1], d[i + 2]]; const dist = Math.hypot(px[0] - bg[0], px[1] - bg[1], px[2] - bg[2]);
        if (dist > 40) { n++; sum = sum.map((s, k) => s + px[k]); } }
      const cover = n / (S * S); const mean = sum.map(s => n ? s / n : 0); const lm = lum(mean);
      const ratio = (Math.max(lm, lb) + .05) / (Math.min(lm, lb) + .05);
      out.push({ id: L.id, bg: L.bg, mark: '#' + mean.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''), cover: +(cover * 100).toFixed(1), ratio: +ratio.toFixed(2) });
    }
    return out;
  });
  let bad = 0;
  for (const r of res) { const ok = r.cover >= 4 && r.ratio >= 3; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.id.padEnd(9)} tile ${r.bg}  mark ${r.mark}  visible ${String(r.cover).padStart(5)}%  contrast ${r.ratio}:1`); }
  await b.close(); if (bad) { console.log(`${bad} logo(s) not visible on their tile`); process.exit(1); } else console.log('clean: every logo reads on its tile');
})();
