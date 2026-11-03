// Catch the Error: the brand ident (docs/BRAND.md). A Pixar-style character animation of the logo, drawn in code.
//   CTE.ident(t, {w, h, cx, cy, k})  -> SVG markup for time t (seconds since the ident starts)
//   CTE.cues(t0)                     -> sound cues [{t, f, db, ...}] for the SFX placer (tools/audio.py), absolute times
//   CTE.DUR                          -> seconds until it holds still (hold at least 1.5 s after)
// The story in 4.3 s: the baseline draws itself; "c" hops in on an arc, "t" drops onto the line (c flinches); "e" hops
// in like a desk lamp, lands on the line, the line gives way and "e" slips below it: the error. c and t lean to look.
// The red pen circles it (two loose loops, like the logo), "e" jumps ("caught!"), and the tagline types out.
// Principles used: anticipation before every hop, squash and stretch with the volume kept, arcs, overlap (c reacts
// to t), follow-through (the line wobbles back), staging (the camera never moves; the eye follows the letters).
(function () {
  const RED = '#D8463A', LINE = '#A6A49F', INK = '#3A3936', PAPER = '#E7E5E1';
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const eo = x => x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
  const ei = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * x;
  const eio = x => x <= 0 ? 0 : x >= 1 ? 1 : x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const back = x => { if (x <= 0) return 0; if (x >= 1) return 1; const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const seg = (t, a, d) => clamp((t - a) / d);
  // a landing: squash then a damped spring back to 1 (returns [sx, sy]); amt = how hard it landed
  function land(t, tl, amt = .28, dur = .45) {
    if (t < tl) return [1, 1]; const u = t - tl; if (u > dur) return [1, 1];
    const s = amt * Math.exp(-u * 9) * Math.cos(u * 22); return [1 + s * .9, 1 - s];
  }
  // a hop on an arc from x0 to x1 (peak h) between ta and tb, with a crouch before and a stretch in the air
  function hop(t, ta, tb, x0, x1, h, crouch = .08) {
    if (t < ta - crouch) return null;
    if (t < ta) { const c = Math.sin(Math.PI * seg(t, ta - crouch, crouch)) * .22; return { x: x0, y: 0, sx: 1 + c * .8, sy: 1 - c }; }
    if (t > tb) return null;
    const p = seg(t, ta, tb - ta), q = eio(p);
    const y = -4 * h * p * (1 - p);                       // the parabola
    const st = .16 * Math.sin(Math.PI * p) * (p < .5 ? 1 : .6); // stretched along the jump, less on the way down
    return { x: lerp(x0, x1, q), y, sx: 1 - st * .55, sy: 1 + st, rot: (x1 > x0 ? 1 : -1) * 8 * Math.sin(Math.PI * 2 * p) * (1 - p) };
  }
  // the pen: a loose double loop around (cx, cy), like the logo's hand-drawn ring
  function ring(cx, cy, rx, ry) {
    const pts = []; const turns = 2.35, n = 220, a0 = -2.2;
    for (let i = 0; i <= n; i++) {
      const u = i / n, a = a0 + u * Math.PI * 2 * turns;
      const wob = 1 + .05 * Math.sin(3 * a + .7) + .035 * Math.sin(5 * a + 2.1) + .028 * Math.sin(u * 7.3);
      pts.push([cx + Math.cos(a) * rx * wob + 6 * Math.sin(u * 9), cy + Math.sin(a) * ry * wob * (1 - .05 * u)]);
    }
    let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { d: 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L'), L };
  }
  const T = { line: 0, c0: .3, c1: .62, t0: .62, t1: .9, e: [[1.0, 1.26], [1.34, 1.58], [1.66, 1.92]], press: 1.92, slip: 2.06, look: 2.3, pen0: 2.5, pen1: 3.2, jump: 3.24, tag0: 3.45, tag1: 4.1 };
  const DUR = 4.3;

  function ident(t, o = {}) {
    const w = o.w || 1080, h = o.h || 1920, k = o.k || 6.2, cx = o.cx ?? w / 2, cy = o.cy ?? h * .45;
    // logo geometry (in the 160 px logo's units, mapped around its centre at (84, 90))
    const X = x => cx + (x - 84) * k, Y = y => cy + (y - 90) * k, F = 50 * k;   // Jost 400, x-height ≈ 25 units
    const B = Y(87.4), xl0 = X(35), xl1 = X(122);
    const xc = X(52), xt = X(74.5), xe = X(110), ye = Y(110.5);
    let svg = '';
    // paper grain (texture, not a gradient)
    svg += `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 .3  0 0 0 0 .29  0 0 0 0 .27  0 0 0 .06 0"/></filter>`;
    svg += `<rect width="${w}" height="${h}" fill="${PAPER}"/><rect width="${w}" height="${h}" filter="url(#grain)"/>`;
    // the baseline: draws out from the centre, then is a rubber string under e
    const lp = eo(seg(t, T.line, .45)); const mid = (xl0 + xl1) / 2;
    const a = lerp(mid, xl0, lp), b = lerp(mid, xl1, lp);
    let dip = 0;
    if (t >= T.press && t < T.slip) dip = 46 * eo(seg(t, T.press, T.slip - T.press));
    else if (t >= T.slip) { const u = t - T.slip; dip = 46 * Math.exp(-u * 7) * Math.cos(u * 26); }
    svg += `<path d="M${a.toFixed(1)} ${B} Q${xe.toFixed(1)} ${(B + dip * 2).toFixed(1)} ${b.toFixed(1)} ${B}" fill="none" stroke="${LINE}" stroke-width="${(.55 * k).toFixed(1)}" stroke-linecap="round"/>`;
    const letter = (ch, x, y, sx, sy, rot = 0, op = 1) =>
      `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})" opacity="${op}"><text x="0" y="0" text-anchor="middle" font-family="Jost" font-weight="400" font-size="${F.toFixed(1)}" fill="${RED}">${ch}</text></g>`;
    // lean toward e (they look at the error), then straighten when it's caught
    const lean = 7 * eo(seg(t, T.look, .3)) * (1 - eo(seg(t, T.jump + .05, .35)));
    // c: hops in from the left
    if (t >= T.c0 - .08) {
      const hp = hop(t, T.c0, T.c1, xc - 330, xc, 190);
      let [sx, sy] = land(t, T.c1, .3); const [fx, fy] = land(t, T.t1, .1, .3);   // flinches when t lands
      if (hp) svg += letter('c', hp.x, B + hp.y, hp.sx, hp.sy, hp.rot || 0);
      else svg += letter('c', xc, B, sx * fx, sy * fy, lean);
    }
    // t: falls onto the line (stretched while falling)
    if (t >= T.t0) {
      if (t < T.t1) { const p = ei(seg(t, T.t0, T.t1 - T.t0)); svg += letter('t', xt, lerp(B - 760, B, p), .9, 1.18); }
      else { const [sx, sy] = land(t, T.t1, .34); svg += letter('t', xt, B, sx, sy, lean * .8); }
    }
    // e: three hops in from the right, lands on the line, presses it, slips below
    const E = T.e, ex = [xe + 520, xe + 330, xe + 150, xe];
    let drawn = false;
    for (let i = 0; i < 3 && !drawn; i++) {
      const hp = hop(t, E[i][0], E[i][1], ex[i], ex[i + 1], [150, 120, 95][i]);
      if (hp) { svg += letter('e', hp.x, B + hp.y, hp.sx, hp.sy, hp.rot || 0); drawn = true; }
      else if (t > E[i][1] && (i === 2 || t < E[i + 1][0] - .08)) {
        if (i < 2) { const [sx, sy] = land(t, E[i][1], .22, .2); svg += letter('e', ex[i + 1], B, sx, sy); drawn = true; }
      }
    }
    if (!drawn && t >= E[0][0] - .08) {
      if (t < T.press) { const [sx, sy] = land(t, E[2][1], .3, .3); svg += letter('e', xe, B, sx, sy); }
      else if (t < T.slip) { svg += letter('e', xe, B + 2 * 46 * eo(seg(t, T.press, T.slip - T.press)), 1.06, .94); }
      else {
        const p = eo(seg(t, T.slip, .28)); let y = lerp(B + 92, ye, p);
        let [sx, sy] = land(t, T.slip + .26, .22, .4);
        if (t >= T.jump) { const u = seg(t, T.jump, .32); y -= 70 * Math.sin(Math.PI * u); const st = .12 * Math.sin(Math.PI * u); sx *= 1 - st * .5; sy *= 1 + st; [sx, sy] = [sx, sy]; const [lx, ly] = land(t, T.jump + .32, .18, .35); sx *= lx; sy *= ly; }
        svg += letter('e', xe, y, sx, sy, -4 * eo(seg(t, T.slip, .3)) * (1 - eo(seg(t, T.jump, .3))));
      }
    }
    // the red pen: a loose double ring around e (the catch)
    if (t >= T.pen0) {
      const r = ring(X(107.5), Y(96), 28 * k, 25.5 * k); const p = eio(seg(t, T.pen0, T.pen1 - T.pen0));
      svg += `<path d="${r.d}" fill="none" stroke="${RED}" stroke-width="${(.42 * k).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity=".92" stroke-dasharray="${r.L.toFixed(0)}" stroke-dashoffset="${(r.L * (1 - p)).toFixed(1)}"/>`;
    }
    // the tagline types out (one word per beat of the type, no keyboard clatter)
    if (t >= T.tag0) {
      const words = ['CATCH', '-', 'THE', '-', 'ERROR']; const per = (T.tag1 - T.tag0) / words.length;
      const shown = words.map((wd, i) => { const p = seg(t, T.tag0 + i * per, .16); return `<tspan opacity="${p.toFixed(3)}">${wd}</tspan>`; }).join('<tspan> </tspan>');
      svg += `<text x="${cx}" y="${Y(133)}" text-anchor="middle" xml:space="preserve" font-family="Courier Prime" font-size="${(5.6 * k).toFixed(1)}" letter-spacing="${(1.05 * k).toFixed(1)}" fill="${INK}">${shown}</text>`;
    }
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;left:0;top:0">${svg}</svg>`;
  }
  // sound: every cue scores a motion (names are the SFX library's files, as 48 kHz mono WAVs)
  function cues(t0) {
    const q = []; const add = (t, f, db, o = {}) => q.push({ t: +(t0 + t).toFixed(3), f, db, ...o });
    add(T.line, 'simple-whoosh-382724', -14, { peak: true, at: t0 + T.line + .2 });          // the line draws out
    add(T.c0 - .05, 'swoosh-snap', -14); add(T.c1 - .01, 'pop-402324', -8);                // c hops, lands
    add(T.t0 + .05, 'simple-whoosh-382724', -16); add(T.t1 - .01, 'sharp-pop', -6);          // t falls, lands
    T.e.forEach(([a, b], i) => { add(a - .04, 'soft-pop', -12 + i); add(b - .01, 'subtle-pop', -9 + i); }); // the lamp hops
    add(T.press, 'sound-off', -10, { len: .5, fade: .3 });                                   // the line gives
    add(T.slip, 'swoosh-snap', -8); add(T.slip + .26, 'pop-402324', -7);                     // e slips below, lands
    add(T.pen0, 'PEN', -6, { synth: 'pen', len: T.pen1 - T.pen0 });                          // the red pen circles
    add(T.jump, 'ui-pop-up-2', -6); add(T.jump + .02, 'benkirb-shine-1-268902', -14, { len: 1.2, fade: .7 }); // caught!
    for (let i = 0; i < 3; i++) add(T.tag0 + i * 2 * (T.tag1 - T.tag0) / 5, 'tick', -12);   // tagline words
    return q;
  }
  window.CTE = { ident, cues, DUR, T, RED, PAPER, INK, LINE };
})();
