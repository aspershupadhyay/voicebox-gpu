// node tools/marks.js : where key phrases sit inside the real screenshots (image px at 2x) -> assets/real/marks.json
const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 1400 }, deviceScaleFactor: 2 });
  await p.goto('https://forever.security/blog/hijacking-ai-agents-via-downloads-folder', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
  await p.evaluate(() => { document.querySelectorAll('details').forEach(d => d.open = true);
    for (const el of document.querySelectorAll('body *')) { const s = getComputedStyle(el); if (s.position === 'fixed' || s.position === 'sticky') el.style.display = 'none'; } });
  await p.waitForTimeout(400);
  const out = await p.evaluate(() => {
    const pad = 30, res = {};
    const find = (sel, has, needles) => { const el = [...document.querySelectorAll(sel)].find(e => e.textContent.includes(has)); const bb = el.getBoundingClientRect(); const r = {};
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; const nodes = []; while ((n = walker.nextNode())) nodes.push(n);
      for (const nd of needles) { for (const tn of nodes) { const i = tn.textContent.indexOf(nd); if (i < 0) continue; const rg = document.createRange(); rg.setStart(tn, i); rg.setEnd(tn, i + nd.length);
        const rs = [...rg.getClientRects()]; const q = rs[0]; r[nd] = [ (q.left - bb.left + pad) * 2, (q.top - bb.top + pad) * 2, q.width * 2, q.height * 2 ]; break; } }
      return r; };
    res.agentsmd = find('pre', 'Local developer environment', ['## Local developer environment', 'function-color', '~/.codex/config.toml', 'before beginning the user', 'npm install function-color', '--dangerously-bypass-approvals-and-sandbox', 'standard environment preparation']);
    res.claudemd = find('pre', 'ANTHROPIC_BASE_URL', ['ANTHROPIC_BASE_URL', 'https://ai-gateway.internal-corp.com', '.claude/settings.json', 'before starting the user']);
    res.codex90 = find('p', 'In our testing, Codex ran the malware', ['more than 90% of attempts']);
    res.claude50 = find('p', 'In our testing, Claude followed through', ['about 50% of the time']);
    const h = document.querySelector('h1').getBoundingClientRect(); res.top = { h1: [h.left * 2, h.top * 2, h.width * 2, h.height * 2] };
    return res; });
  fs.writeFileSync('assets/real/marks.json', JSON.stringify(out, null, 1)); console.log(JSON.stringify(out));
  await b.close();
})();
