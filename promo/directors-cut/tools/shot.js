// node tools/shot.js page.html out.png : a 1920x1080 screenshot of a static page in this folder
const { chromium } = require('playwright'); const path = require('path');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('console', m => console.log('page:', m.text())); p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + path.resolve(process.argv[2])); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(200);
  await p.screenshot({ path: process.argv[3] }); await b.close(); })();
