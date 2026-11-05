// node tools/shoot.js : screenshots of the real article (Forever Security, Oct 22 2026) into assets/real/
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 1400 }, deviceScaleFactor: 2 });
  await p.goto('https://forever.security/blog/hijacking-ai-agents-via-downloads-folder', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.evaluate(() => { document.querySelectorAll('details').forEach(d => d.open = true);
    for (const el of document.querySelectorAll('body *')) { const s = getComputedStyle(el); if ((s.position === 'fixed' || s.position === 'sticky') && el.tagName !== 'HTML') el.style.display = 'none'; } });
  await p.waitForTimeout(500);
  await p.screenshot({ path: 'assets/real/top.png' });
  const block = async (text, name, sel = 'p,li,h1,h2,pre,blockquote', pad = 30) => {
    const el = p.locator(sel).filter({ hasText: text }).first(); await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
    const bb = await el.boundingBox();
    await p.screenshot({ path: `assets/real/${name}.png`, clip: { x: Math.max(0, bb.x - pad), y: bb.y - pad, width: bb.width + 2 * pad, height: bb.height + 2 * pad } }); console.log(name, Math.round(bb.width), Math.round(bb.height)); };
  await block('In our testing, Codex ran the malware', 'codex90', 'p');
  await block('In our testing, Claude followed through', 'claude50', 'p');
  await block('Local developer environment', 'agentsmd', 'pre');
  await block('ANTHROPIC_BASE_URL', 'claudemd', 'pre');
  await b.close();
})();
