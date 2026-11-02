// Cue, the studio's pixel director: a blob drawn cell by cell (no image files), so it can blink, talk to the voice's
// own loudness, squash on a landing and clap its slate. blob({...}) returns an <svg> string.
// Variants: A periwinkle + beret + slate (the one we use), B mint + headset + megaphone, C marigold + backwards cap + viewfinder.
(function () {
  const PAL = {
    A: { o: '#1C1A3A', b: '#8D88EE', l: '#B5B1FF', d: '#6560CC', w: '#EEEDFF', h: '#141318', hl: '#2B2A33', p: '#B98BE0' },
    B: { o: '#10261C', b: '#6FCB9F', l: '#A5E8C6', d: '#479D75', w: '#ECFFF5', h: '#22262A', hl: '#3B4248', p: '#9BD8A0' },
    C: { o: '#2B1F07', b: '#E3BC5C', l: '#F3DA94', d: '#B48A33', w: '#FFF7E3', h: '#7C3B2A', hl: '#A2513C', p: '#E79E6E' },
  };
  const GW = 26, GH = 24;
  function grid() { return Array.from({ length: GH }, () => Array(GW).fill('')); }
  function body(g, o) {
    const s = o.squash || 0, cx = 12.5, rx = 10.6 * (1 + .12 * s), top = 6 + 2.2 * s, bot = 22, cy = top + (bot - top) * .5;
    const ryT = cy - top, ryB = bot - cy;
    const inside = (x, y) => { const dx = (x + .5 - cx) / rx, dy = (y + .5 - cy) / (y + .5 < cy ? ryT : ryB);
      const p = y + .5 < cy ? 2 : 3.2; return Math.pow(Math.abs(dx), p) + Math.pow(Math.abs(dy), p) <= 1; };
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (inside(x, y)) {
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      const dx = (x + .5 - cx) / rx, dy = (y + .5 - cy) / ryT;
      g[y][x] = edge ? 'o' : (dx < -.3 && dy < -.15 ? 'l' : (dx * .55 + dy > .95 ? 'd' : 'b'));
    }
    // a glint, top left
    const gy = Math.round(top + 2.2), gx = Math.round(cx - rx * .55);
    [[0, 0], [1, 0], [0, 1]].forEach(([a, b]) => { if (g[gy + b] && g[gy + b][gx + a] && g[gy + b][gx + a] !== 'o') g[gy + b][gx + a] = 'w'; });
    return { cx, top, bot, cy, rx };
  }
  function face(g, B, o) {
    const ey = Math.round(B.cy - 1), lk = Math.round((o.look || 0) * 1);
    [Math.round(B.cx - 4.5), Math.round(B.cx + 2.5)].forEach(ex => {
      if (o.blink) { g[ey + 1][ex] = g[ey + 1][ex + 1] = 'o'; return; }
      for (let y = 0; y < 3; y++) for (let x = 0; x < 2; x++) g[ey + y][ex + x] = 'w';
      const px = ex + (lk > 0 ? 1 : 0), py = ey + 1; g[py][px] = g[py + 1][px] = 'o';
    });
    // cheeks
    g[ey + 3][Math.round(B.cx - 6)] = g[ey + 3][Math.round(B.cx + 5)] = 'p';
    // mouth: opens with the voice
    const my = ey + 4, mx = Math.round(B.cx - 1), open = o.talk || 0;
    if (open > .55) { g[my][mx] = g[my][mx + 1] = 'o'; g[my + 1][mx] = g[my + 1][mx + 1] = 'o'; g[my + 1][mx - 1] = g[my + 1][mx + 2] = 'o'; }
    else if (open > .2) { g[my][mx] = g[my][mx + 1] = 'o'; g[my + 1][mx] = g[my + 1][mx + 1] = 'o'; }
    else { g[my][mx - 1] = g[my][mx + 2] = 'o'; g[my + 1][mx] = g[my + 1][mx + 1] = 'o'; }
  }
  function hat(g, B, v) {
    const t = Math.round(B.top);
    if (v === 'A') { // a beret, tilted to the right, with its little stalk
      const rows = [[4, 15], [3, 18], [2, 20], [3, 19]];
      rows.forEach(([a, b], i) => { for (let x = a + 3; x <= b; x++) { const y = t - 3 + i; if (y >= 0) g[y][x] = (i === 0 || x === a + 3 || x === b) ? 'h' : (i === 1 && x < a + 7 ? 'hl' : 'h'); } });
      if (t - 4 >= 0) g[t - 4][11] = g[t - 5 >= 0 ? t - 5 : 0][11] = 'h';
    } else if (v === 'B') { // a headset band, cups and a mic boom
      for (let x = 5; x <= 20; x++) { const y = t - 1 - Math.round(2.2 * Math.sin(Math.PI * (x - 5) / 15)); if (y >= 0) g[y][x] = 'h'; }
      for (let y = t + 3; y < t + 8; y++) { g[y][2] = g[y][3] = 'h'; g[y][22] = g[y][23] = 'h'; }
      for (let x = 18; x <= 21; x++) g[t + 13][x] = 'hl'; g[t + 12][21] = g[t + 11][22] = 'hl'; g[t + 13][17] = 'h';
    } else { // a cap worn backwards: dome + brim out the back
      for (let i = 0; i < 3; i++) for (let x = 6 - i; x <= 19 + i; x++) { const y = t - 2 + i; if (y >= 0) g[y][x] = i === 0 ? 'h' : 'hl'; }
      for (let x = 0; x <= 7; x++) g[t + 1][x] = 'h';
    }
  }
  function arms(g, B, o) {
    const y = Math.round(B.cy + 3 - (o.raise || 0) * 3);
    [[Math.round(B.cx - B.rx - 1), 'L'], [Math.round(B.cx + B.rx), 'R']].forEach(([x]) => {
      for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (g[y + b] && x + a >= 0 && x + a < GW && !g[y + b][x + a]) g[y + b][x + a] = 'b';
      if (g[y - 1] && x >= 0 && x < GW && !g[y - 1][x]) g[y - 1][x] = 'o';
    });
  }
  function svg(g, P, px, extra = '', W = GW, H = GH) {
    let r = '';
    for (let y = 0; y < g.length; y++) { let x = 0; while (x < W) { const c = g[y][x]; if (!c) { x++; continue; } let n = 1; while (x + n < W && g[y][x + n] === c) n++;
      r += `<rect x="${x * px}" y="${y * px}" width="${n * px}" height="${px}" fill="${P[c] || c}"/>`; x += n; } }
    return r + extra;
  }
  // the slate: top stick opens by `clap` (0 closed, 1 open), the board says what it's told
  function slate(px, clap, lines, col) {
    const w = 15 * px, h = 11 * px, st = 3 * px; let s = `<g>`;
    s += `<rect x="0" y="${st}" width="${w}" height="${h}" fill="#151417" stroke="#EDEBE6" stroke-width="${px * .35}"/>`;
    for (let i = 0; i < 5; i++) s += `<rect x="${i * 3 * px}" y="${st}" width="${1.5 * px}" height="${px * .9}" fill="#EDEBE6"/>`;
    (lines || []).forEach((l, i) => { s += `<text x="${px * .9}" y="${st + px * (3.6 + i * 2.9)}" font-family="Mono,monospace" font-size="${px * 1.75}" fill="${i === 0 ? '#EDEBE6' : col}">${l}</text>`; });
    const ang = -26 * (clap || 0);
    s += `<g transform="rotate(${ang} 0 ${st})"><rect x="0" y="0" width="${w}" height="${st - px * .2}" fill="#EDEBE6"/>`;
    for (let i = 0; i < 5; i++) s += `<polygon points="${i * 3 * px},0 ${(i * 3 + 1.5) * px},0 ${(i * 3 + .7) * px},${st - px * .2} ${(i * 3 - .8) * px},${st - px * .2}" fill="#151417"/>`;
    return s + `</g></g>`;
  }
  function megaphone(px, P) { return `<g><polygon points="0,${3 * px} ${8 * px},0 ${8 * px},${9 * px} 0,${6 * px}" fill="${P.w}" stroke="${P.o}" stroke-width="${px * .5}"/><rect x="${-2 * px}" y="${3 * px}" width="${2 * px}" height="${3 * px}" fill="${P.h}"/></g>`; }
  function viewfinder(px, P) { const L = (x, y, r) => `<path d="M${x} ${y + 3 * px*r[1]} V${y} H${x + 3 * px*r[0]}" stroke="${P.h}" stroke-width="${px * 1.1}" fill="none" stroke-linecap="square"/>`;
    return `<g>${L(0, 0, [1, 1])}<g transform="rotate(180 ${4 * px} ${3 * px})">${L(0, 0, [1, 1])}</g></g>`; }
  window.blob = function (o = {}) {
    const v = o.variant || 'A', P = PAL[v], px = o.px || 10, g = grid();
    const B = body(g, o); hat(g, B, v); face(g, B, o); arms(g, B, o);
    let extra = '';
    if (o.holdSlate) extra = `<g transform="translate(${(GW - 1) * px} ${(B.cy - 3 - (o.raise || 0) * 4) * px}) rotate(${-8 + 10 * (o.clap || 0)})">${slate(px * .85, o.clap, o.slate || ['SCENE 01', 'TAKE 1'], P.b)}</g>`;
    else if (o.prop !== false) {
      if (v === 'A') extra = `<g transform="translate(${(GW - 1) * px} ${(B.cy - 3 - (o.raise || 0) * 4) * px}) rotate(${-8 + 10 * (o.clap || 0)})">${slate(px * .85, o.clap, o.slate || ['SCENE 01', 'TAKE 1'], P.b)}</g>`;
      if (v === 'B') extra = `<g transform="translate(${(GW + .5) * px} ${(B.cy - 2) * px}) rotate(-12)">${megaphone(px, P)}</g>`;
      if (v === 'C') extra = `<g transform="translate(${(B.cx + 6) * px} ${(B.cy - 5) * px})">${viewfinder(px, P)}</g>`;
    }
    const W = (GW + 15) * px, H = GH * px;
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" style="position:static;overflow:visible">${svg(g, P, px, extra)}</svg>`;
  };
  window.BLOB_PAL = PAL;
})();
