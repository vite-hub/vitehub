// Lumen props shared by the five cards, built on the zinc kit (iso.mjs) from boxes, prisms and face mappers.
// Each prop has one face of fine repeated detail and one glyph that names it.
import * as I from './iso.mjs';
const { P, D, fm, box, prismZ, rring, circle, quad, line, onTop, onLeft, onRight, both, strokeP, fillP, el, hatch, M } = I;

// ---------- face mappers with u to the screen right and w up ----------
// flat on a top face: u along +x, w along -y (picture "up" points to the back)
export const fTop = (x0, y1, z) => (u, w) => [x0 + u, y1 - w, z];
// on a +y face (faces lower left): u along +x
export const fLeft = (x0, y, z0) => (u, w) => [x0 + u, y, z0 + w];
// on a +x face (faces lower right): u along -y
export const fRight = (x, y1, z0) => (u, w) => [x, y1 - u, z0 + w];
export const rect = (F, u0, w0, u1, w1) => D(quad(F, u0, w0, u1, w1));
export const circ = (F, uc, wc, r, seg = 8) => D(circle(uc, wc, r, seg).map(([u, w]) => F(u, w)));

// ---------- glyphs, drawn as lines ----------
export function prompt(F, u, w, h, col = I.INK1, sw = 1.6) {          // >_
  strokeP(line(F, [[u, w + h], [u + h * 0.55, w + h * 0.5], [u, w]]), col, sw);
  strokeP(line(F, [[u + h * 0.85, w], [u + h * 1.55, w]]), col, sw);
}
export function tick(F, uc, wc, s, col = I.INK1, sw = 1.2) {
  strokeP(line(F, [[uc - s, wc], [uc - s * 0.3, wc - s * 0.7], [uc + s, wc + s * 0.7]]), col, sw);
}
export function arrowDown(F, uc, w0, w1, col = I.INK1, sw = 1.2) {
  const a = (w0 - w1) * 0.35;
  strokeP(line(F, [[uc, w0], [uc, w1]]) + line(F, [[uc - a, w1 + a], [uc, w1], [uc + a, w1 + a]]), col, sw);
}
export function braces(F, uc, wc, h, col = I.INK1, sw = 1) {          // { }
  const g = h * 0.55, d = h * 0.18;
  strokeP(line(F, [[uc - g + d, wc + h / 2], [uc - g, wc + h / 2 - d], [uc - g, wc + d * 0.6], [uc - g - d, wc], [uc - g, wc - d * 0.6], [uc - g, wc - h / 2 + d], [uc - g + d, wc - h / 2]]), col, sw);
  strokeP(line(F, [[uc + g - d, wc + h / 2], [uc + g, wc + h / 2 - d], [uc + g, wc + d * 0.6], [uc + g + d, wc], [uc + g, wc - d * 0.6], [uc + g, wc - h / 2 + d], [uc + g - d, wc - h / 2]]), col, sw);
}
// a picture: dark image well, a range of hills and a sun, inside the rect u0..u0+W, w0..w0+H of face F
export function picture(F, u0, w0, W, H, opt = {}) {
  both(rect(F, u0, w0, u0 + W, w0 + H), I.VD, I.OUT, opt.sw || 0.5);
  const hills = [[u0 + 0.6, w0 + 0.6], [u0 + W * 0.3, w0 + H * 0.55], [u0 + W * 0.46, w0 + H * 0.36], [u0 + W * 0.7, w0 + H * 0.7], [u0 + W - 0.6, w0 + H * 0.28], [u0 + W - 0.6, w0 + 0.6]];
  fillP(D(hills.map(p => F(...p))), opt.hill || I.INK3);
  strokeP(line(F, hills.slice(0, 5)), opt.ridge || I.INK2, Math.max(0.4, Math.min(0.8, W / 30)));
  both(circ(F, u0 + W * 0.24, w0 + H * 0.74, Math.max(0.9, Math.min(W, H) * 0.11), 8), I.INK1, 'none', 0);
}

// ---------- photo lying flat (a frame 2.4 thick), optional tick and crop marks ----------
export function photoFlat(o) {
  const { x0, x1, y0, y1, z = 0, th = 2.4 } = o;
  prismZ(rring((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 1.4, 0, 2), z, z + th, o.mat || M.light);
  const W = x1 - x0, H = y1 - y0, m = o.margin ?? Math.max(1.4, Math.min(W, H) * 0.09);
  const F = fTop(x0, y1, z + th);
  picture(F, m, m * (o.tick ? 2.2 : 1), W - 2 * m, H - m * (o.tick ? 3.2 : 2), { sw: 0.45 });
  if (o.tick) {
    // caption strip: a tick and two short lines
    tick(F, m + 1.4, m * 1.1, 1, I.TH.TXT1, 0.8);
    strokeP(line(F, [[m + 4, m * 1.1], [W - m - 2, m * 1.1]]), I.TH.TXT2, 0.7);
  }
  if (o.crop) cropMarks(F, -1.2, -1.2, W + 1.2, H + 1.2, 3.2);
}
// L-shaped crop marks just outside a rect
export function cropMarks(F, u0, w0, u1, w1, l, col = I.OUT, sw = 0.55) {
  let s = '';
  for (const [u, w, du, dw] of [[u0, w0, 1, 1], [u1, w0, -1, 1], [u1, w1, -1, -1], [u0, w1, 1, -1]]) {
    s += line(F, [[u - du * 1.2, w], [u - du * (1.2 + l), w]]) + line(F, [[u, w - dw * 1.2], [u, w - dw * (1.2 + l)]]);
  }
  strokeP(s, col, sw);
}

// ---------- photo standing upright, facing +y: { x0, x1, y, d, z0, z1 } ----------
export function photoStand(o) {
  const { x0, x1, y, d = 2, z0 = 0, z1 } = o;
  box(x0, x1, y - d, y, z0, z1, o.mat || M.light);
  const W = x1 - x0, H = z1 - z0, m = o.margin ?? 2.4;
  picture(fLeft(x0, y + 0.01, z0), m, m, W - 2 * m, H - 2 * m, { sw: 0.5 });
}

// ---------- folder: back panel, photos standing in it, front panel with a tab and a label ----------
// { x0, x1, y0, y1, h, photos: [{ dx0, dx1, h }] } (y0 back, y1 front)
export function folder(o) {
  const { x0, x1, y0, y1, h } = o;
  // back panel with its tab on the left
  box(x0, x1, y0, y0 + 2, 0, h + 4, M.mid);
  // the floor of the folder (a dark gap, seen between the panels)
  // photos standing inside, back to front
  const n = o.photos.length;
  o.photos.forEach((p, i) => {
    const yy = y0 + 3.4 + (i + 1) * (y1 - y0 - 6.4) / (n + 1);
    photoStand({ x0: x0 + p.dx0, x1: x0 + p.dx1, y: yy, d: 1.6, z0: 1, z1: p.h, margin: 2.2 });
  });
  // front panel, lower than the photos, with a tab on its top edge
  const fz = h * 0.74, W = x1 - x0, tw = W * 0.36;
  box(x0, x1, y1 - 2, y1, 0, fz, M.light);
  box(x0 + 1.5, x0 + 1.5 + tw, y1 - 2, y1, fz, fz + 4.5, M.light);
  const F = fLeft(x0, y1 + 0.01, 0);
  // fine detail: paper edges along the bottom of the front panel and a ribbed spine on the +x side
  hatch(onRight(x1), y1 - 1.6, y1 - 0.4, 1.5, fz - 1.5, 0.6, 'w', I.RIBR, 0.3);
  let ln = '';
  for (let w = 1.8; w < fz * 0.24; w += 1.6) ln += line(F, [[2, w], [W - 2, w]]);
  strokeP(ln, I.RIB, 0.4, ' stroke-opacity="0.8"');
  // label plate with a picture glyph and two lines, and a line on the tab
  both(rect(F, W * 0.14, fz * 0.32, W * 0.86, fz * 0.78), I.TH.PAPER, I.OUT, 0.5);
  const lh = fz * 0.36;
  picture(F, W * 0.19, fz * 0.39, lh * 1.1, lh, { sw: 0.4 });
  strokeP(line(F, [[W * 0.19 + lh * 1.4, fz * 0.64], [W * 0.8, fz * 0.64]]) + line(F, [[W * 0.19 + lh * 1.4, fz * 0.5], [W * 0.68, fz * 0.5]]), I.TH.TXT1, 0.8);
  strokeP(line(F, [[4, fz + 2.2], [tw - 2, fz + 2.2]]), I.TH.TXT2, 0.8);
}

// ---------- config file card lying flat: { x0, x1, y0, y1 } ----------
export function configCard(o) {
  const { x0, x1, y0, y1 } = o;
  const th = 2.6, f = 7;
  // a sheet with the back-right corner folded: a rounded slab cut at that corner
  const ring = [[x0 + 2, y0], [x1 - f, y0], [x1, y0 + f], [x1, y1 - 2], [x1 - 2, y1], [x0 + 2, y1], [x0, y1 - 2], [x0, y0 + 2]];
  prismZ(ring, 0, th, M.light, { creases: () => false });
  const T = onTop(th);
  both(D([T(x1 - f, y0), T(x1 - f, y0 + f), T(x1, y0 + f)]), I.MT, I.OUT, 0.5);
  const F = fTop(x0, y1, th);
  const W = x1 - x0, H = y1 - y0;
  // header: braces glyph and the file name as a bar
  braces(F, 5.5, H - 5, 5, I.TH.TXT1, 0.9);
  strokeP(line(F, [[11, H - 5], [W - f - 4, H - 5]]), I.TH.TXT1, 1.1);
  strokeP(line(F, [[2.5, H - 9.6], [W - 2.5, H - 9.6]]), I.RIB, 0.5);
  // fields: key bar, value bar, with indent; fine repeated rows
  const rows = [[0, 7, 9], [4, 6, 12], [4, 8, 7], [4, 5, 10], [0, 9, 6], [4, 6, 13], [4, 7, 8], [0, 3, 0]];
  let keys = '', vals = '', gut = '';
  rows.forEach(([ind, k, v], i) => {
    const w = H - 13.4 - i * 3.3; if (w < 2.6) return;
    gut += line(F, [[2.6, w], [3.6, w]]);
    keys += line(F, [[6 + ind, w], [6 + ind + k, w]]);
    if (v) vals += line(F, [[6 + ind + k + 1.8, w], [Math.min(W - 3, 6 + ind + k + 1.8 + v), w]]);
  });
  strokeP(gut, I.TH.TXT2, 0.6);
  strokeP(keys, I.TH.TXT1, 0.9);
  strokeP(vals, I.TH.TXT2, 0.9);
}

// ---------- size gauge: a standing board facing +y with bars that drop and a down arrow ----------
// { x0, x1, y0, y1, h }
export function gauge(o) {
  const { x0, x1, y0, y1, h } = o;
  // two feet and the board
  box(x0 + 2, x0 + 8, y0 - 4, y1 + 4, 0, 3, M.mid);
  box(x1 - 8, x1 - 2, y0 - 4, y1 + 4, 0, 3, M.mid);
  box(x0, x1, y0, y1, 3, h, M.light);
  const W = x1 - x0, F = fLeft(x0, y1 + 0.01, 3), Hh = h - 3;
  both(rect(F, 2.4, 2.6, W - 2.4, Hh - 2.6), I.VD, I.OUT, 0.55);
  // grid lines (fine repeated detail)
  let g = '';
  for (let w = 6; w < Hh - 4; w += 3) g += line(F, [[4, w], [W - 4, w]]);
  strokeP(g, I.INK3, 0.35, ' stroke-opacity="0.8"');
  // bars, tall to short
  const bars = [0.78, 0.66, 0.5, 0.36, 0.24, 0.16], bw = (W - 14) / bars.length;
  let b = '';
  bars.forEach((t, i) => { const u = 5 + i * bw + bw / 2; b += line(F, [[u, 5], [u, 5 + t * (Hh - 12)]]); });
  strokeP(b, I.INK2, Math.min(2.6, bw * 0.62), ' stroke-linecap="butt"');
  arrowDown(F, W - 5.4, Hh - 6, Hh - 15, I.INK1, 1.1);
  // ruler ticks on the top edge
  hatch(onTop(h), x0 + 2, x1 - 2, y0 + 0.6, y0 + 1.6, 2, 'w', I.RIB, 0.35);
}

// ---------- conveyor belt along y: { x0, x1, y0, y1, z } drawn between ya and yb ----------
export function belt(o, ya, yb) {
  const { x0, x1, z } = o;
  // legs (small boxes) under the frame, back to front
  for (const ly of o.legs || []) if (ly >= ya && ly <= yb) {
    box(x0 + 1, x0 + 4, ly - 1.5, ly + 1.5, 0, z - 4, M.mid, { sw: 0.7 });
    box(x1 - 4, x1 - 1, ly - 1.5, ly + 1.5, 0, z - 4, M.mid, { sw: 0.7 });
  }
  box(x0, x1, ya, yb, z - 4, z, M.mid);
  const T = onTop(z);
  // belt surface: dark band with slats (fine repeated detail)
  both(D(quad(T, x0 + 2.2, ya, x1 - 2.2, yb)), I.VD, I.OUT, 0.5);
  let s = '';
  for (let y = Math.ceil(ya / 3) * 3; y <= yb; y += 3) s += line(T, [[x0 + 2.4, y], [x1 - 2.4, y]]);
  strokeP(s, I.INK3, 0.4);
  // rollers on the +x rail
  const R = onRight(x1);
  let r = '';
  for (let y = Math.ceil(ya / 6) * 6 + 3; y < yb - 1; y += 6) r += `M${P(x1, y, z - 2).map(fm).join(' ')}h0.01`;
  el(`<path d="${r}" stroke="${I.OUT}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.7"/>`);
  strokeP(line(R, [[ya, z - 0.8], [yb, z - 0.8]]), I.RIBR, 0.4, ` stroke-opacity="${I.TH.RIBRA}"`);
}

// ---------- the Lumen machine: a press box the belt runs through, with a >_ panel on its +x face ----------
// { x0, x1, y0, y1, h, bx0, bx1 (belt x range), bz (belt top) }
export function machine(o) {
  const { x0, x1, y0, y1, h, bx0, bx1, bz } = o;
  box(x0 - 3, x1 + 3, y0 - 3, y1 + 3, 0, 5, M.mid);
  hatch(fRight(x1 + 3, y1 + 3, 0), 3, y1 - y0 + 3, 1.4, 3.6, 1.6, 'w', I.RIBR, 0.4, ` stroke-opacity="${I.TH.RIBRA}"`);
  box(x0, x1, y0, y1, 5, h, M.light);
  // +x face: nameplate, LED row, the >_ panel, a progress bar, vents
  const W = y1 - y0, R = fRight(x1 + 0.01, y1, 5), Hh = h - 5;
  both(rect(R, 4, Hh * 0.3, W - 4, Hh - 5), I.VD, I.OUT, 0.55);
  prompt(R, 7.4, Hh * 0.62, Hh * 0.2, I.INK1, 2.2);
  let ln = '';
  [[12, 0], [8, 0], [11, 0]].forEach(([l], i) => { ln += line(R, [[W - 6 - l, Hh - 9 - i * 3], [W - 6, Hh - 9 - i * 3]]); });
  strokeP(ln, I.INK2, 0.9);
  // progress bar: outline, filled part, segment ticks
  const pw0 = 7.4, pw1 = W - 7.4, pz = Hh * 0.3 + 4;
  both(rect(R, pw0, pz - 1.6, pw1, pz + 1.6), 'none', I.INK3, 0.45);
  both(rect(R, pw0 + 0.6, pz - 1, pw0 + (pw1 - pw0) * 0.68, pz + 1), I.INK1, 'none', 0);
  // vents under the panel
  hatch(R, 4, W - 4, 2.4, Hh * 0.3 - 3, 1.8, 'u', I.RIBR, 0.5, ` stroke-opacity="${I.TH.RIBRA}"`);
  // +y face: the exit with a strip curtain, ribbed columns on both sides
  const F = fLeft(x0, y1 + 0.01, 5), bw0 = bx0 - x0 - 1.5, bw1 = bx1 - x0 + 1.5, eh = bz - 5 + 9;
  both(rect(F, bw0, 0, bw1, eh), I.VD, I.OUT, 0.55);
  hatch(F, bw0 + 1.4, bw1 - 1.4, eh * 0.28, eh - 0.8, 1.5, 'w', I.INK3, 0.5);
  strokeP(line(F, [[bw0, eh + 2], [bw1, eh + 2]]), I.OUT, 0.5, ' stroke-opacity="0.6"');
  hatch(F, 2.4, bw0 - 2.6, 3, Hh - 4, 1.6, 'w', I.RIB, 0.45);
  hatch(F, bw1 + 2.6, x1 - x0 - 2.4, 3, Hh - 12, 1.6, 'w', I.RIB, 0.45);
  for (let i = 0; i < 2; i++) both(circ(F, x1 - x0 - 4.6 - i * 3.4, Hh - 6.2, 1.05, 6), i ? I.INK3 : I.INK1, I.OUT, 0.35);
  // top: the press, a housing, a piston and a ribbed head
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  hatch(onTop(h), x0 + 3, x1 - 3, y0 + 3, y0 + 7, 1.6, 'w', I.RIB, 0.45);
  prismZ(circle(cx, cy + 2, 13, 14), h, h + 5, M.mid);
  prismZ(circle(cx, cy + 2, 5, 10), h + 5, h + 13, M.light, {
    beforeTop: () => strokeP(I.frontArc(cx, cy + 2, 5, h + 8) + I.frontArc(cx, cy + 2, 5, h + 10), I.RIB, 0.45),
  });
  prismZ(circle(cx, cy + 2, 10, 14), h + 13, h + 19, M.mid, {
    beforeTop: () => {
      let rb = '';
      for (let a = -40; a <= 130; a += 12) { const t = a * Math.PI / 180; rb += D([[cx + 10 * Math.cos(t), cy + 2 + 10 * Math.sin(t), h + 14.2], [cx + 10 * Math.cos(t), cy + 2 + 10 * Math.sin(t), h + 17.8]], false); }
      strokeP(rb, I.RIBR, 0.45, ` stroke-opacity="${I.TH.RIBRA}"`);
    }
  });
  both(D(circle(cx, cy + 2, 5.5, 10).map(([x, y]) => [x, y, h + 19])), I.MT, I.OUT, 0.5);
  both(D(circle(cx, cy + 2, 1.8, 6).map(([x, y]) => [x, y, h + 19])), I.VD, I.OUT, 0.45);
}

// ---------- open tray with a stack of small images: { x0, x1, y0, y1, n } ----------
export function tray(o) {
  const { x0, x1, y0, y1 } = o;
  const h = 6, t = 1.6;
  box(x0, x1, y0, y1, 0, 1.2, M.mid);
  box(x0, x1, y0, y0 + t, 1.2, h, M.mid);             // back wall
  box(x0, x0 + t, y0 + t, y1, 1.2, h, M.mid);         // left wall
  // stack of small photos inside
  for (let i = 0; i < (o.n || 3); i++) {
    const z = 1.2 + i * 2.2, dx = [0, 0.8, -0.4][i % 3];
    photoFlat({ x0: x0 + 3.2 + dx, x1: x1 - 3.2 + dx, y0: y0 + 3.2, y1: y1 - 3.2, z, th: 1.8, tick: i === (o.n || 3) - 1 });
  }
  box(x0 + t, x1, y1 - t, y1, 1.2, h, M.mid);          // front wall
  box(x1 - t, x1, y0 + t, y1 - t, 1.2, h, M.mid);      // right wall
  hatch(fLeft(x0, y1 + 0.01, 0), 2, x1 - x0 - 2, 1.6, h - 1, 1.8, 'w', I.RIBR, 0.4, ` stroke-opacity="${I.TH.RIBRA}"`);
}

// ---------- a terminal for the laptop screen: rows of [indent, [len, ink]...], a >_ prompt row and a cursor ----------
export function terminal(rows, opt = {}) {
  return (Sc, b) => {
    const { sx0, sx1, sw0, top } = b;
    // tab strip
    both(D(quad(Sc, sx0 + 9, top, sx0 + 22, top + 4.2)), I.INK3, 'none', 0, ' fill-opacity="0.45"');
    const rowH = opt.rowH || 3.3;
    rows.forEach((r, i) => {
      const w = top - 3.6 - i * rowH; if (w < sw0 + 1.8) return;
      let u = sx0 + 3 + r[0];
      if (r[1] === 'v') { tick(Sc, u + 1.2, w, 1.2, I.INK1, 0.8); u += 4; r = [r[0], ...r.slice(2)]; }
      if (r[1] === '>') {
        prompt(Sc, u, w - 1, 2, I.INK1, 0.8); u += 5;
        r = [r[0], ...r.slice(2)];
      }
      for (let k = 1; k < r.length; k++) {
        const [len, col] = r[k];
        const e = Math.min(u + len, sx1 - 3);
        if (e > u) strokeP(line(Sc, [[u, w], [e, w]]), col, 1.1);
        u = e + 1.5;
      }
    });
    if (opt.cursor) {
      const w = top - 3.6 - opt.cursor[0] * rowH;
      both(D(quad(Sc, sx0 + 3 + opt.cursor[1], w - 1.1, sx0 + 4.4 + opt.cursor[1], w + 1.1)), I.INK1, 'none', 0);
    }
  };
}

// ---------- package box (the binary): tape on top, corrugation ribs, a >_ label: { x0, x1, y0, y1, h } ----------
export function packageBox(o) {
  const { x0, x1, y0, y1, h } = o;
  box(x0, x1, y0, y1, 0, h, M.light);
  const T = onTop(h), xm = (x0 + x1) / 2;
  // tape along the flap seam, with a fine weave
  both(D(quad(T, xm - 4, y0, xm + 4, y1)), I.MG, I.OUT, 0.5);
  hatch(T, xm - 3, xm + 3, y0 + 1.5, y1 - 1.5, 1.4, 'u', I.RIB, 0.35);
  strokeP(line(T, [[x0 + 2.5, (y0 + y1) / 2], [xm - 6, (y0 + y1) / 2]]) + line(T, [[xm + 6, (y0 + y1) / 2], [x1 - 2.5, (y0 + y1) / 2]]), I.RIB, 0.5);
  // tape runs down the +y face
  const F = fLeft(x0, y1 + 0.01, 0), W = x1 - x0;
  both(rect(F, W / 2 - 4, h - 7, W / 2 + 4, h), I.MG, I.OUT, 0.5);
  // label with the >_ glyph and two lines
  both(rect(F, W * 0.14, h * 0.18, W * 0.86, h * 0.62), I.TH.PAPER, I.OUT, 0.55);
  prompt(F, W * 0.2, h * 0.27, h * 0.24, I.TH.TXT1, 1.5);
  strokeP(line(F, [[W * 0.52, h * 0.5], [W * 0.8, h * 0.5]]) + line(F, [[W * 0.52, h * 0.4], [W * 0.72, h * 0.4]]) + line(F, [[W * 0.52, h * 0.3], [W * 0.76, h * 0.3]]), I.TH.TXT2, 0.8);
  // corrugation ribs on the +x face, and a this-way-up arrow pair
  const R = fRight(x1 + 0.01, y1, 0), D2 = y1 - y0;
  hatch(R, 2, D2 - 2, 2, h - 2, 1.5, 'w', I.RIBR, 0.4, ` stroke-opacity="${I.TH.RIBRA}"`);
}

// ---------- round tick badge standing upright, facing +y: { x, y, r, d } ----------
export function tickBadge(o) {
  const { x, y, r, d = 3, z0 = 0 } = o;
  const shape = [];
  for (let i = 0; i < 20; i++) { const t = i / 20 * Math.PI * 2; shape.push([r * Math.cos(t), z0 + r + r * Math.sin(t)]); }
  const F = (u, w) => [x + u, y, w];
  I.extrude(shape, F, [0, -d, 0], [1, 0, 0], [0, 0, 1], { mat: M.mid, face: I.VD, creaseAng: 9 });
  strokeP(D(shape.map(([u, w]) => { const k = (r - 1.6) / r; return F(u * k, z0 + r + (w - z0 - r) * k); })), I.INK3, 0.5);
  tick(F, 0, z0 + r - 0.4, r * 0.45, I.INK1, Math.max(1.2, r * 0.22));
}

// ---------- a prism lying along x (screws, bars): cross-section an n-gon of radius r round (y, z) ----------
export function prismX(x0, x1, cy, cz, r, mat, n = 10, opt = {}) {
  const ring = [];
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n * Math.PI * 2; ring.push([cy + r * Math.cos(t), cz + r * Math.sin(t)]); }
  const c = [(x0 + x1) / 2, cy, cz];
  const faces = [];
  for (let i = 0; i < n; i++) { const [ya, za] = ring[i], [yb, zb] = ring[(i + 1) % n]; faces.push([[x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb]]); }
  faces.push(ring.map(([y, z]) => [x0, y, z]), ring.map(([y, z]) => [x1, y, z]));
  I.poly3(faces.map(f => orient(f, c)), mat, opt);
  return ring;
}
// flip a face so that its Newell normal points away from c
export function orient(f, c) {
  const n = I.newell(f), m = f.reduce((s, p) => s.map((v, k) => v + p[k] / f.length), [0, 0, 0]);
  return n[0] * (m[0] - c[0]) + n[1] * (m[1] - c[1]) + n[2] * (m[2] - c[2]) >= 0 ? f : f.slice().reverse();
}

// ---------- bench vise squeezing a photo (compress): { x0, x1, y0, y1 } is the base, mj the moving jaw, jz the jaw height ----------
export function vise(o) {
  const { x0, x1, y0, y1, mj } = o;
  const ym = (y0 + y1) / 2, jz = o.jz || 34, jw = o.jw || 14, sz = o.sz || jz * 0.5, sr = o.sr || 3.2;
  box(x0, x1, y0, y1, 0, 6, M.mid);                                          // base
  for (const [bx, by] of [[x0 + 4, y0 + 4], [x0 + 4, y1 - 4], [x1 - 4, y0 + 4], [x1 - 4, y1 - 4]]) both(D(circle(bx, by, 1.6, 6).map(([x, y]) => [x, y, 6])), I.VD, I.OUT, 0.45);
  hatch(fRight(x1 + 0.01, y1, 0), 2, y1 - y0 - 2, 1.4, 4.6, 1.6, 'w', I.RIBR, 0.4, ` stroke-opacity="${I.TH.RIBRA}"`);
  hatch(fLeft(x0, y1 + 0.01, 0), 2, x1 - x0 - 2, 1.4, 4.6, 1.6, 'w', I.RIB, 0.4);
  const fj = x0 + jw;                                                        // fixed jaw x0..fj
  box(x0, fj, y0 + 2, y1 - 2, 6, jz, M.mid);
  box(fj, fj + 2.4, y0 + 3, y1 - 3, 12, jz, M.light);                        // grip plate
  hatch(fLeft(x0, y1 - 2 + 0.01, 6), 2.4, jw - 2.4, 3, jz - 12, 1.5, 'w', I.RIB, 0.45);
  arrowRight(onTop(jz), x0 + 3, fj - 3, ym, I.TH.TXT1, 1.3);
  // the photo, squeezed upright between the jaws, flush with their front
  const px0 = fj + 2.4, px1 = mj, ph = jz + (o.over || 10);
  box(px0, px1, y1 - 5.4, y1 - 3, 6, ph, M.light);
  picture(fLeft(px0, y1 - 3 + 0.01, 6), 2.4, 2.6, px1 - px0 - 4.8, ph - 6 - 5.2, { sw: 0.5 });
  // moving jaw
  box(mj, mj + 2.4, y0 + 3, y1 - 3, 12, jz, M.light);
  box(mj + 2.4, mj + 2.4 + jw, y0 + 2, y1 - 2, 6, jz, M.mid);
  hatch(fLeft(mj + 2.4, y1 - 2 + 0.01, 6), 2.4, jw - 2.4, 3, jz - 12, 1.5, 'w', I.RIB, 0.45);
  arrowRight(onTop(jz), mj + jw, mj + 5, ym, I.TH.TXT1, 1.3);
  // screw out of the moving jaw, threads, a boss and a T-handle
  const s0 = mj + 2.4 + jw, s1 = x1 + (o.sl || 10);
  prismX(s0, s1, ym, sz, sr, M.light, 10);
  const arc = [-0.6, 0, 0.6, 1.2, 1.8, 2.2].map(t => [ym + (sr + 0.05) * Math.cos(t), sz + (sr + 0.05) * Math.sin(t)]);
  let th = '';
  for (let x = s0 + 2; x < s1 - 1; x += 1.6) th += line((y, z) => [x, y, z], arc);
  strokeP(th, I.RIB, 0.4);
  const hb = sr * 1.45, hr = sr * 0.45, hl = (y1 - y0) / 2;
  prismX(s1 - 1, s1 + 6, ym, sz, hb, M.mid, 10);                            // boss
  box(s1 + 1.2, s1 + 3.8, ym - hl, ym - hb, sz - hr, sz + hr, M.light, { sw: 0.7 });
  box(s1 + 1.2, s1 + 3.8, ym + hb, ym + hl, sz - hr, sz + hr, M.light, { sw: 0.7 });
  for (const yy of [ym - hl - 1.6, ym + hl + 1.6]) prismX(s1 + 0.2, s1 + 4.8, yy, sz, hr * 2, M.mid, 8);
}
// a flat arrow on a face mapper from (u0, w) to (u1, w)
export function arrowRight(F, u0, u1, w, col = I.INK1, sw = 1.2) {
  const a = Math.sign(u1 - u0) * 2.4;
  strokeP(line(F, [[u0, w], [u1, w]]) + line(F, [[u1 - a, w - 2.4], [u1, w], [u1 - a, w + 2.4]]), col, sw);
}

// ---------- a format plate: a standing rounded tag facing +y with a monospace label: { x0, x1, y, d, h, label } ----------
export function formatPlate(o) {
  const { x0, x1, y, d = 4, h, label } = o;
  box(x0 - 2, x1 + 2, y - d - 3, y + 3, 0, 3, M.mid);                        // foot
  hatch(fLeft(x0 - 2, y + 3.01, 0), 2, x1 - x0 + 2, 0.8, 2.2, 1.6, 'w', I.RIBR, 0.35);
  const W = x1 - x0, r = 3, shape = [];
  for (const [cu, cw, a0] of [[W - r, r, -90], [W - r, h - r, 0], [r, h - r, 90], [r, r, 180]]) for (let i = 0; i <= 3; i++) { const t = (a0 + 30 * i) * Math.PI / 180; shape.push([cu + r * Math.cos(t), cw + r * Math.sin(t)]); }
  const F = (u, w) => [x0 + u, y, 3 + w];
  I.extrude(shape, F, [0, -d, 0], [1, 0, 0], [0, 0, 1], { mat: M.light, face: I.VD, creaseAng: 9 });
  strokeP(D(shape.map(([u, w]) => F(2 + (u / W) * (W - 4), 2 + (w / h) * (h - 4)))), I.INK3, 0.5);
  const size = o.size || 9, tw = label.length * size * 0.6;
  I.textOn('left', F((W - tw) / 2, h * 0.5 - size * 0.36), label, size, I.INK1, ' font-weight="700" letter-spacing="0"');
  // fine detail: a row of ticks under the label
  hatch((u, w) => F(u, w), 5, W - 5, 2.6, 4.2, 1.4, 'w', I.INK3, 0.4);
}

// ---------- a stack of converted files lying flat: { x0, x1, y0, y1, n } ----------
export function fileStack(o) {
  const { x0, x1, y0, y1, n = 4 } = o;
  for (let i = 0; i < n; i++) {
    const dx = [0, 1.6, -0.8, 1][i % 4], dy = [0, -1.2, 0.8, -0.6][i % 4], z = i * 2.4;
    const a0 = x0 + dx, a1 = x1 + dx, b0 = y0 + dy, b1 = y1 + dy, f = 6;
    const ring = [[a0 + 1.5, b0], [a1 - f, b0], [a1, b0 + f], [a1, b1 - 1.5], [a1 - 1.5, b1], [a0 + 1.5, b1], [a0, b1 - 1.5], [a0, b0 + 1.5]];
    prismZ(ring, z, z + 2.4, M.light);
    const T = onTop(z + 2.4);
    both(D([T(a1 - f, b0), T(a1 - f, b0 + f), T(a1, b0 + f)]), I.MT, I.OUT, 0.45);
    // page edges on the +y and +x sides (fine repeated detail)
    strokeP(line(onLeft(b1), [[a0 + 2, z + 1.2], [a1 - 2, z + 1.2]]) + line(onRight(a1), [[b0 + f + 1, z + 1.2], [b1 - 2, z + 1.2]]), I.RIB, 0.35);
    if (i === n - 1) {
      const F = fTop(a0, b1, z + 2.4), W = a1 - a0, H = b1 - b0;
      picture(F, 3, H - 3 - (H - 6) * 0.55, (W - 6) * 0.62, (H - 6) * 0.55, { sw: 0.45 });
      let s = '';
      for (let k = 0; k < 3; k++) s += line(F, [[3, 4 + k * 3], [W - 4 - k * 4, 4 + k * 3]]);
      strokeP(s, I.TH.TXT2, 0.8);
      arrowRight(F, (W - 6) * 0.62 + 5, W - 3, H - 3 - (H - 6) * 0.28, I.TH.TXT1, 0.9);
    }
  }
}

// ---------- a ruler lying flat along x: { x0, x1, y0, y1 } ----------
export function ruler(o) {
  const { x0, x1, y0, y1 } = o;
  box(x0, x1, y0, y1, 0, 2, M.light);
  const T = onTop(2);
  let s = '', S = '';
  for (let x = x0 + 2, k = 0; x <= x1 - 1.5; x += 2, k++) (k % 5 === 0 ? (S += line(T, [[x, y1 - 0.4], [x, y1 - (y1 - y0) * 0.62]])) : (s += line(T, [[x, y1 - 0.4], [x, y1 - (y1 - y0) * 0.34]])));
  strokeP(s, I.RIB, 0.4);
  strokeP(S, I.RIBR, 0.5);
}

// ---------- quality slider: a flat control plate with a track, a scale and a knob: { x0, x1, y0, y1, t } ----------
export function slider(o) {
  const { x0, x1, y0, y1, t = 0.75 } = o;
  prismZ(rring((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 3, 0, 3), 0, 3, M.mid);
  const T = onTop(3), ym = (y0 + y1) / 2, kx = x0 + 6 + (x1 - x0 - 12) * t;
  both(D(quad(T, x0 + 5, ym - 1.4, x1 - 5, ym + 1.4)), I.VD, I.OUT, 0.5);
  strokeP(line(T, [[x0 + 6, ym], [kx, ym]]), I.INK1, 1.1);
  hatch(T, x0 + 6, x1 - 6, y1 - 6, y1 - 3.4, 2.2, 'w', I.RIBR, 0.4);
  prismZ(rring(kx, ym, 3, 4.4, 1.4, 0, 2), 3, 8, M.light);
  strokeP(line(onTop(8), [[kx - 1, ym - 2.4], [kx - 1, ym + 2.4]]) + line(onTop(8), [[kx + 1, ym - 2.4], [kx + 1, ym + 2.4]]), I.RIB, 0.45);
}

// ---------- card-catalog cabinet: drawers on the +y face, one pulled out with index cards: { x0, x1, y0, y1, h, cols, rows, open: [col, row] } ----------
export function cabinet(o) {
  const { x0, x1, y0, y1, h, cols = 3, rows = 4 } = o;
  box(x0 - 2, x1 + 2, y0 - 2, y1 + 2, 0, 4, M.mid);                          // plinth
  box(x0, x1, y0, y1, 4, h, M.mid);
  box(x0 - 1.5, x1 + 1.5, y0 - 1.5, y1 + 1.5, h, h + 3, M.mid);              // top
  const F = fLeft(x0, y1 + 0.01, 4), W = x1 - x0, Hh = h - 4, g = 2.2;
  const dw = (W - g * (cols + 1)) / cols, dh = (Hh - g * (rows + 1)) / rows;
  const cell = (c, r) => [g + c * (dw + g), g + r * (dh + g)];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    if (o.open && o.open[0] === c && o.open[1] === r) { const [u, w] = cell(c, r); both(rect(F, u, w, u + dw, w + dh), I.VD, I.OUT, 0.5); continue; }
    drawerFront(F, ...cell(c, r), dw, dh);
  }
  // side panel: a ribbed inset (fine repeated detail)
  const R = fRight(x1 + 0.01, y1, 4), D2 = y1 - y0;
  strokeP(rect(R, 3, 3, D2 - 3, Hh - 3), I.OUT, 0.5, ' stroke-opacity="0.5"');
  hatch(R, 6, D2 - 6, 6, Hh - 6, 2.2, 'w', I.RIBR, 0.45, ` stroke-opacity="${I.TH.RIBRA}"`);
  if (o.open) {
    const [c, r] = o.open, [u, w] = cell(c, r), ox = x0 + u, oz = 4 + w, L_ = o.pull || 16;
    // the drawer body sticking out, its open top, index cards standing inside, then its front
    box(ox, ox + dw, y1, y1 + L_, oz, oz + dh - 2.2, M.light);
    const T = onTop(oz + dh - 2.2);
    both(D(quad(T, ox + 1.2, y1 + 0.6, ox + dw - 1.2, y1 + L_ - 1.2)), I.VD, I.OUT, 0.45);
    for (let k = 0, yy = y1 + 2.2; yy < y1 + L_ - 2; yy += 2.4, k++) {
      const up = k % 3 === 1 ? 4.2 : 2.6;
      box(ox + 2, ox + dw - 2, yy, yy + 0.5, oz + 1, oz + dh - 2.2 + up, M.light, { sw: 0.45 });
      if (k % 3 === 1) box(ox + 3 + (k % 2) * 4, ox + 9 + (k % 2) * 4, yy, yy + 0.5, oz + dh - 2.2 + up, oz + dh - 2.2 + up + 2, M.pale, { sw: 0.4 });
    }
    drawerFront(fLeft(ox, y1 + L_ + 0.01, oz), 0, 0, dw, dh - 2.2, true);
  }
}
function drawerFront(F, u, w, dw, dh, solid = false) {
  if (solid) both(rect(F, u, w, u + dw, w + dh), I.MT, I.OUT, 0.5);
  else strokeP(rect(F, u, w, u + dw, w + dh), I.OUT, 0.5);
  // label holder with a line, and a pull
  both(rect(F, u + dw * 0.3, w + dh * 0.56, u + dw * 0.7, w + dh * 0.84), I.TH.PAPER, I.OUT, 0.4);
  strokeP(line(F, [[u + dw * 0.36, w + dh * 0.7], [u + dw * 0.64, w + dh * 0.7]]), I.TH.TXT2, 0.6);
  both(rect(F, u + dw * 0.38, w + dh * 0.22, u + dw * 0.62, w + dh * 0.36), I.VD, I.OUT, 0.4);
}

// ---------- exit-code panel over the kit tower's display: a seven-segment 0 and five code rows, the first lit ----------
export function exitPanel(TWR) {
  const { x, y } = TWR, c = 10.5, H = TWR.H;
  const F = fLeft(x - c, y + c + 0.02, 0), W = 2 * c;
  both(rect(F, 2.4, 12, W - 2.4, H - 6), I.VD, I.OUT, 0.55);
  // seven-segment 0
  const u0 = W / 2 - 3.6, u1 = W / 2 + 3.6, w0 = H - 25, w1 = H - 10, wm = (w0 + w1) / 2;
  strokeP(line(F, [[u0 + 0.8, w1], [u1 - 0.8, w1]]) + line(F, [[u1, w1 - 0.8], [u1, wm + 0.6]]) + line(F, [[u1, wm - 0.6], [u1, w0 + 0.8]]) +
    line(F, [[u1 - 0.8, w0], [u0 + 0.8, w0]]) + line(F, [[u0, w0 + 0.8], [u0, wm - 0.6]]) + line(F, [[u0, wm + 0.6], [u0, w1 - 0.8]]), I.INK1, 1.5);
  strokeP(line(F, [[u0 + 1, wm], [u1 - 1, wm]]), I.INK3, 1.2);
  // five code rows: a light and a bar each
  for (let i = 0; i < 5; i++) {
    const w = H - 30 - i * 4.6;
    both(circ(F, 6, w, 1.3, 6), i === 0 ? I.INK1 : I.INK3, I.OUT, 0.35);
    strokeP(line(F, [[9.4, w], [W - 4.4 - (i % 2) * 3, w]]), i === 0 ? I.INK2 : I.INK3, 0.9);
  }
}

// ---------- a flag on a pole (flags): { x, y, h } ----------
export function flag(o) {
  const { x, y, h } = o;
  prismZ(circle(x, y, 6, 12), 0, 2.4, M.mid);
  prismZ(circle(x, y, 1.2, 8), 2.4, h, M.light);
  const fw = o.w || 24, fh = o.fh || 15, z0 = h - fh - 1;
  const shape = [[0, 0], [fw, 0], [fw - 5, fh / 2], [fw, fh], [0, fh]];
  const F = (u, w) => [x + 1.2 + u, y, z0 + w];
  I.extrude(shape, F, [0, -2, 0], [1, 0, 0], [0, 0, 1], { mat: M.light, face: I.MT, creaseAng: 0.4 });
  strokeP(line(F, [[3.5, fh / 2], [6.5, fh / 2]]) + line(F, [[8.5, fh / 2], [11.5, fh / 2]]), I.TH.TXT1, 1.3);
  hatch(F, 2.6, fw - 7, 2, 4, 1.4, 'w', I.RIB, 0.35);
  hatch(F, 2.6, fw - 7, fh - 4, fh - 2, 1.4, 'w', I.RIB, 0.35);
  prismZ(circle(x, y, 1.8, 8), h, h + 2, M.mid);
}

// ---------- comment bubble on a face: a rounded box with a tail, filled, with two lines ----------
export function bubble(F, u, w, bw, bh, fill = I.INK1, ink = I.VD) {
  const r = Math.min(1.2, bh / 3), pts = [];
  for (const [cu, cw, a0] of [[u + bw - r, w + r, -90], [u + bw - r, w + bh - r, 0], [u + r, w + bh - r, 90], [u + r, w + r, 180]]) for (let i = 0; i <= 2; i++) { const t = (a0 + 45 * i) * Math.PI / 180; pts.push([cu + r * Math.cos(t), cw + r * Math.sin(t)]); }
  // tail under the bottom-left corner
  const k = pts.length - 1;
  pts.splice(k, 0, [u + bh * 0.9, w], [u + bh * 0.35, w - bh * 0.45], [u + bh * 0.45, w]);
  both(D(pts.map(p => F(...p))), fill, I.OUT, 0.4);
  strokeP(line(F, [[u + 1.4, w + bh * 0.65], [u + bw - 1.6, w + bh * 0.65]]) + line(F, [[u + 1.4, w + bh * 0.33], [u + bw * 0.6, w + bh * 0.33]]), ink, 0.55);
}

// ---------- monitor on a stand with the Console editor: { x0, x1, y, z0, z1 } (screen faces +y at y) ----------
export function monitor(o) {
  const { x0, x1, y, z0, z1 } = o, xm = (x0 + x1) / 2, d = 4;
  prismZ(rring(xm, y - 10, 19, 10, 4, 0, 3), 0, 3, M.mid);                 // base plate
  hatch(onTop(3), xm - 12, xm + 12, y - 16, y - 13, 1.6, 'w', I.RIB, 0.4);
  box(xm - 4, xm + 4, y - d - 6, y - d - 1, 3, z0 + 8, M.mid);              // neck
  box(x0, x1, y - d, y, z0, z1, M.light);                                   // panel
  // back ribs on the +x edge and vents on top (fine detail)
  hatch(onTop(z1), x0 + 4, x1 - 4, y - d + 0.8, y - 0.8, 2, 'w', I.RIB, 0.35);
  const F = fLeft(x0, y + 0.01, z0), W = x1 - x0, H = z1 - z0, m = 2.6;
  const s0 = m, s1 = W - m, t0 = m + 2.4, t1 = H - m;
  both(rect(F, s0, t0, s1, t1), I.VD, I.OUT, 0.55);
  strokeP(line(F, [[W / 2 - 3, 1.2], [W / 2 + 3, 1.2]]), I.RIB, 0.6);      // chin
  // top bar with three dots and a tab
  strokeP(line(F, [[s0, t1 - 4], [s1, t1 - 4]]), I.INK3, 0.5);
  for (let i = 0; i < 3; i++) both(circ(F, s0 + 2.4 + i * 2.4, t1 - 2, 0.7, 6), i ? I.INK3 : I.INK1, 'none', 0);
  both(rect(F, s0 + 10, t1 - 4, s0 + 24, t1), I.INK3, 'none', 0, ' fill-opacity="0.45"');
  // sidebar with a file tree
  const sb = s0 + 14;
  strokeP(line(F, [[sb, t0], [sb, t1 - 4]]), I.INK3, 0.5);
  let tree = '';
  [7, 5, 6, 4, 7, 5, 6, 3, 5, 6, 4].forEach((l, i) => { const w = t1 - 7 - i * 3; if (w > t0 + 2) tree += line(F, [[s0 + 2 + (i % 3 ? 2 : 0), w], [s0 + 2 + (i % 3 ? 2 : 0) + l, w]]); });
  strokeP(tree, I.INK3, 0.9);
  strokeP(line(F, [[s0 + 3.5, t1 - 7 - 2 * 3], [s0 + 10, t1 - 7 - 2 * 3]]), I.INK1, 0.9);
  // editor: a heading, paragraphs, an active line
  const ed = sb + 3, pv = s0 + (s1 - s0) * 0.64;
  strokeP(line(F, [[pv - 1.5, t0], [pv - 1.5, t1 - 4]]), I.INK3, 0.5);
  strokeP(line(F, [[ed, t1 - 8], [ed + 14, t1 - 8]]), I.INK1, 1.8);
  const rows = [[22, 1], [19, 1], [24, 2], [0, 0], [16, 1], [23, 2], [20, 1], [11, 2], [0, 0], [21, 1], [18, 2], [14, 1]];
  let a = '', b = '';
  rows.forEach(([l, k], i) => { const w = t1 - 13 - i * 3; if (w < t0 + 2 || !l) return; const e = Math.min(ed + l, pv - 4); (k === 1 ? (a += line(F, [[ed, w], [e, w]])) : (b += line(F, [[ed, w], [e, w]]))); });
  strokeP(a, I.INK2, 1); strokeP(b, I.INK3, 1);
  fillP(D(quad(F, ed - 1, t1 - 13 - 4 * 3 - 1.5, pv - 3, t1 - 13 - 4 * 3 + 1.5)), I.INK2, ' fill-opacity="0.14"');
  both(D(quad(F, ed + 17, t1 - 13 - 4 * 3 - 1.1, ed + 18.2, t1 - 13 - 4 * 3 + 1.1)), I.INK1, 'none', 0);
  // preview: a picture and lines
  picture(F, pv + 2, t1 - 8 - (H * 0.26), s1 - pv - 4, H * 0.26, { sw: 0.4, hill: I.INK3 });
  let pl = '';
  for (let i = 0; i < 5; i++) { const w = t1 - 11 - H * 0.26 - i * 3; if (w > t0 + 2) pl += line(F, [[pv + 2, w], [s1 - 2 - (i % 2) * 5, w]]); }
  strokeP(pl, I.INK3, 0.9);
  // comment pins on the page
  for (const [u, w, bw] of o.pins || []) bubble(F, u, w, bw, 5.2);
  sheen(F, s0, s1, t0, t1);
}
function sheen(F, s0, s1, t0, t1) { I.sheen(F, s0, s1, t0, t1); }

// ---------- speech bubble standing on the slab, facing +y: { x, y, w, h, d } ----------
export function speech(o) {
  const { x, y, w, h, d = 4, z0 = 4 } = o;
  const r = 4, pts = [];
  for (const [cu, cw, a0] of [[w - r, r, -90], [w - r, h - r, 0], [r, h - r, 90], [r, r, 180]]) for (let i = 0; i <= 3; i++) { const t = (a0 + 30 * i) * Math.PI / 180; pts.push([cu + r * Math.cos(t), cw + r * Math.sin(t)]); }
  pts.splice(pts.length - 1, 0, [9, 0], [3, -z0], [4.5, 0]);
  const F = (u, v) => [x + u, y, z0 + v];
  I.extrude(pts, F, [0, -d, 0], [1, 0, 0], [0, 0, 1], { mat: M.light, face: I.MT, creaseAng: 0.9 });
  for (let i = 0; i < 3; i++) both(circ(F, w / 2 - 6 + i * 6, h / 2, 1.5, 8), I.TH.TXT1, 'none', 0);
  hatch(F, 4, w - 4, 2.2, 3.6, 1.4, 'w', I.RIB, 0.35);
}

// ---------- open slatted crate for media, three passes: { x0, x1, y0, y1, h, items } ----------
export function crate(o) {
  const { x0, x1, y0, y1, h } = o, t = 2;
  box(x0, x1, y0, y1, 0, 2, M.mid);                                           // floor
  box(x0, x1, y0, y0 + t, 2, h, M.mid);                                       // back wall
  box(x0, x0 + t, y0 + t, y1, 2, h, M.mid);                                   // left wall
  both(D(quad(onTop(2), x0 + t, y0 + t, x1, y1)), I.VD, I.OUT, 0.45);
  // media inside: standing photos and a video frame with a play glyph
  (o.items || []).forEach(it => {
    box(it.x0, it.x1, it.y - 1.4, it.y, 2, it.h, M.light);
    const F = fLeft(it.x0, it.y + 0.01, 2), W = it.x1 - it.x0, H = it.h - 2;
    if (it.play) {
      both(rect(F, 1.8, 1.8, W - 1.8, H - 1.8), I.VD, I.OUT, 0.45);
      const c = [W / 2, H / 2], s = Math.min(W, H) * 0.2;
      both(D([F(c[0] - s * 0.7, c[1] - s), F(c[0] + s, c[1]), F(c[0] - s * 0.7, c[1] + s)]), I.INK1, 'none', 0);
    } else picture(F, 1.8, 1.8, W - 3.6, H - 3.6, { sw: 0.45 });
  });
  // front and right walls, slatted (gaps as dark lines)
  box(x0 + t, x1, y1 - t, y1, 2, h * 0.62, M.light);
  box(x1 - t, x1, y0 + t, y1 - t, 2, h * 0.62, M.light);
  const FF = fLeft(x0 + t, y1 + 0.01, 2), RR = fRight(x1 + 0.01, y1 - t, 2), hh = h * 0.62 - 2;
  hatch(FF, 0.6, x1 - x0 - t - 0.6, hh * 0.34, hh * 0.67, hh * 0.33, 'u', I.OUT, 0.5, ' stroke-opacity="0.6"');
  hatch(RR, 0.6, y1 - y0 - 2 * t - 0.6, hh * 0.34, hh * 0.67, hh * 0.33, 'u', I.OUT, 0.5, ' stroke-opacity="0.6"');
  hatch(FF, 3, x1 - x0 - t - 3, 1.2, hh - 1.2, 1.4, 'w', I.RIB, 0.3, ' stroke-opacity="0.8"');
  hatch(RR, 3, y1 - y0 - 2 * t - 3, 1.2, hh - 1.2, 1.4, 'w', I.RIBR, 0.3, ` stroke-opacity="${I.TH.RIBRA}"`);
  // corner posts
  box(x1 - 3, x1, y1 - 3, y1, 0, h * 0.62 + 1.2, M.mid, { sw: 0.7 });
}

// ---------- MCP: a socket block with two slots and a plug in front of it with its prongs toward the slots ----------
// { x0, x1, y0, y1, h } socket; plug body sits at y1 + gap .. y1 + gap + pl
export function socketPlug(o) {
  const { x0, x1, y0, y1, h } = o, xm = (x0 + x1) / 2;
  box(x0, x1, y0, y1, 0, h, M.mid);
  const F = fLeft(x0, y1 + 0.01, 0), W = x1 - x0;
  both(rect(F, 3, 3, W - 3, h - 3), I.VD, I.OUT, 0.5);
  for (const du of [-4, 4]) both(rect(F, W / 2 + du - 1, h * 0.36, W / 2 + du + 1, h * 0.66), I.MG, I.OUT, 0.4);
  both(circ(F, W - 6, h - 6, 1, 6), I.INK1, I.OUT, 0.35);
  hatch(fRight(x1 + 0.01, y1, 0), 2, y1 - y0 - 2, 2, h - 2, 1.5, 'w', I.RIBR, 0.4, ` stroke-opacity="${I.TH.RIBRA}"`);
  hatch(onTop(h), x0 + 3, x1 - 3, y0 + 2, y0 + 5, 1.5, 'w', I.RIB, 0.4);
  // plug: prongs, then body with grip ribs
  const g = o.gap || 7, pb = y1 + g, pl = o.pl || 16, pz0 = h * 0.3, pz1 = h * 0.62;
  for (const du of [-4, 4]) box(xm + du - 0.8, xm + du + 0.8, y1 + 1.6, pb, h * 0.47, h * 0.55, M.pale, { sw: 0.5 });
  box(xm - 7.5, xm + 7.5, pb, pb + pl, pz0 - 1, pz1 + 1, M.light);
  hatch(fLeft(xm - 7.5, pb + pl + 0.01, 0), 2.2, 12.8, pz0, pz1, 1.4, 'w', I.RIB, 0.45);
  hatch(fRight(xm + 7.51, pb + pl, 0), 2, pl - 6, pz0, pz1, 1.4, 'w', I.RIBR, 0.4, ` stroke-opacity="${I.TH.RIBRA}"`);
  prismZ(rring(xm, pb + pl + 2, 4, 2, 1.5, 0, 2), pz0, pz1, M.mid);             // strain relief
  return { cx: xm, cy: pb + pl + 4, cz: (pz0 + pz1) / 2 };
}

// ---------- a glyph disc on top of a kit database: 'user' (head and shoulders) or 'page' ----------
export function dbGlyph(DB, kind) {
  const T = onTop(DB.h), { x, y, r } = DB;
  both(D(circle(x, y, r - 4, 12).map(p => T(...p))), I.TH.PAPER, I.OUT, 0.5);
  const F = fTop(x - 6, y + 6, DB.h);
  if (kind === 'user') {
    both(circ(F, 6, 8, 2.6, 8), I.TH.TXT1, 'none', 0);
    const arc = []; for (let a = 0; a <= 180; a += 20) { const t = a * Math.PI / 180; arc.push([6 + 5 * Math.cos(t), 1.6 + 3.6 * Math.sin(t)]); }
    both(D(arc.map(p => F(...p))), I.TH.TXT1, 'none', 0);
  } else {
    strokeP(rect(F, 2.4, 1.6, 9.6, 10.4), I.TH.TXT1, 0.6);
    strokeP(line(F, [[3.8, 8.4], [8.2, 8.4]]) + line(F, [[3.8, 6], [8.2, 6]]) + line(F, [[3.8, 3.6], [6.6, 3.6]]), I.TH.TXT1, 0.6);
  }
}

// ---------- a page lying flat (a Markdown doc) with a heading, lines and a comment pin: { x0, x1, y0, y1 } ----------
export function pageCard(o) {
  const { x0, x1, y0, y1 } = o, th = 2.6, f = 7;
  const ring = [[x0 + 2, y0], [x1 - f, y0], [x1, y0 + f], [x1, y1 - 2], [x1 - 2, y1], [x0 + 2, y1], [x0, y1 - 2], [x0, y0 + 2]];
  prismZ(ring, 0, th, M.light);
  const T = onTop(th);
  both(D([T(x1 - f, y0), T(x1 - f, y0 + f), T(x1, y0 + f)]), I.MT, I.OUT, 0.5);
  const F = fTop(x0, y1, th), W = x1 - x0, H = y1 - y0;
  strokeP(line(F, [[4, H - 5], [W * 0.5, H - 5]]), I.TH.TXT1, 1.8);
  let s = '';
  for (let i = 0; i < 7; i++) { const w = H - 10 - i * 3.2; if (w > 3) s += line(F, [[4, w], [W - 4 - (i % 3) * 5, w]]); }
  strokeP(s, I.TH.TXT2, 0.9);
  bubble(F, W - 16, H - 19, 11, 6.4, I.VD, I.INK1);
}
