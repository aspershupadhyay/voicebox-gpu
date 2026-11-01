// node tools/render.js <out.mp4> [workers] [fps]   |  node tools/render.js stills t1 t2 ...  |  sheet N
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve(__dirname, '..');
function serve() { return new Promise(r => { const s = http.createServer((q, res) => { const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }); s.listen(0, '127.0.0.1', () => r(s)); }); }
async function page(browser, port) { const p = await browser.newPage({ viewport: { width: 1080, height: 1920 } }); await p.goto(`http://127.0.0.1:${port}/film.html`); await p.evaluate(() => window.ready); return p; }
async function shot(p, t, type = 'png') { await p.evaluate(t => window.seek(t), t); return p.screenshot({ type, quality: type === 'jpeg' ? 95 : undefined, clip: { x: 0, y: 0, width: 1080, height: 1920 } }); }
(async () => {
  const [mode, ...args] = process.argv.slice(2);
  const srv = await serve(); const port = srv.address().port;
  const browser = await chromium.launch();
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  if (mode === 'stills') { const p = await page(browser, port); for (const a of args) { const t = parseFloat(a); fs.writeFileSync(path.join(ROOT, `out/still-${t.toFixed(2)}.png`), await shot(p, t)); } }
  else if (mode === 'sheet') {
    const p = await page(browser, port); const dur = await p.evaluate(() => window.DURATION); const n = parseInt(args[0] || 24); const from = parseFloat(args[1] || 0), to = parseFloat(args[2] || dur);
    const dir = path.join(ROOT, 'out/sheet'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) { const t = from + (to - from) * (i + .5) / n; fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.png`), await shot(p, t)); }
    await new Promise(r => spawn('ffmpeg', ['-v', 'error', '-y', '-pattern_type', 'glob', '-i', dir + '/*.png', '-vf', `scale=270:480,tile=${Math.min(n, 8)}x${Math.ceil(n / 8)}`, path.join(ROOT, args[3] || 'out/sheet.png')], { stdio: 'inherit' }).on('close', r));
  } else {
    const out = path.join(ROOT, mode); const W = parseInt(args[0] || 6), FPS = parseInt(args[1] || 30);
    const p0 = await page(browser, port); const dur = await p0.evaluate(() => window.DURATION); const N = Math.ceil(dur * FPS);
    const pages = [p0]; for (let i = 1; i < W; i++) pages.push(await page(browser, port));
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const buf = new Map(); let next = 0, issued = 0; const t0 = Date.now();
    const flush = async () => { while (buf.has(next)) { const b = buf.get(next); buf.delete(next); if (!ff.stdin.write(b)) await new Promise(r => ff.stdin.once('drain', r)); next++; if (next % 150 === 0) console.log(`${next}/${N} ${((Date.now() - t0) / 1000).toFixed(0)}s`); } };
    await Promise.all(pages.map(async p => { while (true) { const f = issued++; if (f >= N) return; buf.set(f, await shot(p, f / FPS, 'jpeg')); await flush(); } }));
    await flush(); ff.stdin.end(); await new Promise(r => ff.on('close', r)); console.log(`done ${N} frames ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out}`);
  }
  await browser.close(); srv.close();
})();
