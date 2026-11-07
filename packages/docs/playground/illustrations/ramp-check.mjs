// Zinc copy of the skill's ramp-check.mjs. Palette check for the zinc themes of iso.mjs: every hex in the card must be
// a theme colour or a blend of up to three of them (what shade() and mix() produce). Anything else is a stray.
// The theme comes from --theme, or from the file name (-dark.svg / -light.svg).
//
//   node illustrations/ramp-check.mjs card-dark.svg [--theme dark]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEMES, themeColors } from "./iso.mjs";
const args = process.argv.slice(2);
const ti = args.indexOf("--theme");
const theme = ti >= 0 ? args.splice(ti, 2)[1] : (/-dark\.svg$/.test(args[0] || "") ? "dark" : "light");
const file = args[0];
if (!file) { console.error("usage: node ramp-check.mjs card.svg [--theme light|dark]"); process.exit(1); }
const norm = h => { h = h.toLowerCase(); return h.length === 4 ? "#" + [...h.slice(1)].map(c => c + c).join("") : h; };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const pal = themeColors(theme).map(norm);
const out = norm(THEMES[theme].OUT);
const ramp = pal.filter(h => h !== out || h === norm(THEMES[theme].VD)).map(rgb);   // the outline never takes part in face blends
const allowed = new Set(pal.concat(["#ffffff", "#000000"]));
// a zinc theme has no other hue: also fail any colour whose channels differ by more than zinc does (blue lead <= 12)
const hueOk = h => { const [r_, g, b] = rgb(h); return Math.abs(r_ - g) <= 2 && b - r_ >= 0 && b - r_ <= 12; };

const svg = fs.readFileSync(file, 'utf8');
const used = {};
for (const m of svg.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) { const h = norm(m[0]); used[h] = (used[h] || 0) + 1; }

// exact distance from point p to segment ab and to triangle abc (closest-point method, Ericson 5.1.5)
const sub = (u, v) => u.map((x, i) => x - v[i]), dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const len = u => Math.hypot(...u), add = (u, v, t) => u.map((x, i) => x + v[i] * t);
function distSeg(p, a, b) { const ab = sub(b, a), L = dot(ab, ab); const t = L ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L)) : 0; return len(sub(p, add(a, ab, t))); }
function distTri(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const crs = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  if (len(crs) < 1e-6) return Math.min(distSeg(p, a, b), distSeg(p, a, c), distSeg(p, b, c));
  const d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return len(bp);
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) return len(sub(p, add(a, ab, d1 / (d1 - d3))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return len(cp);
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) return len(sub(p, add(a, ac, d2 / (d2 - d6))));
  const va = d3 * d6 - d5 * d4; if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return len(sub(p, add(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)))));
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return len(sub(p, add(add(a, ab, v), ac, w)));
}
const blends = [], strays = [];
for (const [h, n] of Object.entries(used)) {
  if (allowed.has(h)) continue;
  const c = rgb(h);
  let best = 1e9;
  for (let a = 0; a < ramp.length && best > 2.5; a++)
    for (let b = a; b < ramp.length && best > 2.5; b++)
      for (let d = b; d < ramp.length && best > 2.5; d++) best = Math.min(best, distTri(c, ramp[a], ramp[b], ramp[d]));
  (best <= 2.5 && hueOk(h) ? blends : strays).push(`${h} x${n}${best <= 2.5 ? '' : ` (off by ${best.toFixed(1)})`}`);
}
console.log(`[${theme}] ${Object.keys(used).length} colours: ${blends.length} ramp blends, ${strays.length} strays`);
if (strays.length) console.log('STRAY', strays.join(', '));
console.log(strays.length ? `FAIL ${file}` : `PASS ${file}`);
process.exit(strays.length ? 1 : 0);
