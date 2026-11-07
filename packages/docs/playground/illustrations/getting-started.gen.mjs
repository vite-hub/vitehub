// Getting started: install the binary and compress a first folder.
//   node illustrations/getting-started.gen.mjs out.svg "Title" --theme light|dark
import * as I from './iso.mjs';
import * as L from './props.mjs';

const args = process.argv.slice(2);
const ti = args.indexOf('--theme');
const theme = ti >= 0 ? args.splice(ti, 2)[1] : 'light';
I.setTheme(theme);
I.init(theme === 'dark' ? 'gsd-' : 'gsl-');
I.floorDefs();
const { M, box, rectFoot, castShadow, spill, pool } = I;

// ---------------- layout ----------------
const LP = { x0: -40, x1: 44, y0: -14, y1: 48, L: 54 };                   // laptop with the install command (hero)
const PKG = { x0: -110, x1: -66, y0: -6, y1: 38, h: 38 };                  // the binary, in a package box, left
const FOLD = { x0: -102, x1: -52, y0: -116, y1: -96, h: 36,                // a first folder of photos, back
  photos: [{ dx0: 3, dx1: 43, h: 54 }, { dx0: 7, dx1: 47, h: 47 }, { dx0: 2, dx1: 40, h: 41 }] };
const PH = { x0: 50, x1: 100, y: -50, d: 3, z0: 3, z1: 46 };               // the compressed photo, standing, right
const BADGE = { x: 98, y: -40, r: 10.5, d: 3.6 };                          // its tick
const CFG = { x0: 58, x1: 104, y0: 0, y1: 40 };                            // lumen.config.ts, right front
const TRAY = { x0: 10, x1: 50, y0: 70, y1: 102, n: 3 };                   // the first folder, compressed, front
const CARD = { x0: -104, x1: -50, y0: 58, y1: 96 };                       // the install command on a terminal card, front left

// ---------------- floor ----------------
I.platform();
castShadow(rectFoot(LP.x0, LP.x1, LP.y0 - 8, LP.y1), 26, 0.62, 0.22);
castShadow(rectFoot(PKG.x0, PKG.x1, PKG.y0, PKG.y1), PKG.h, 0.62, 0.24);
castShadow(rectFoot(FOLD.x0, FOLD.x1, FOLD.y0, FOLD.y1), 40 * 0.5, 0.62, 0.24);
castShadow(rectFoot(PH.x0 - 3, PH.x1 + 3, PH.y - 7, PH.y + 3), PH.z1 * 0.6, 0.62, 0.24);
castShadow(rectFoot(BADGE.x - BADGE.r, BADGE.x + BADGE.r, BADGE.y - BADGE.d, BADGE.y), 18, 0.62, 0.2);
castShadow(rectFoot(CFG.x0, CFG.x1, CFG.y0, CFG.y1), 5, 0.7, 0.2);
spill((LP.x0 + LP.x1) / 2, LP.y1 + 8, 52, 30, 0.5);
pool((PH.x0 + PH.x1) / 2, PH.y - 2, 30, 12, 0.3);
pool(BADGE.x, BADGE.y - 1, 14, 8, 0.32);
pool((PKG.x0 + PKG.x1) / 2, (PKG.y0 + PKG.y1) / 2, 28, 26, 0.3);
pool((FOLD.x0 + FOLD.x1) / 2, (FOLD.y0 + FOLD.y1) / 2, 26, 14, 0.3);
castShadow(rectFoot(TRAY.x0, TRAY.x1, TRAY.y0, TRAY.y1), 8, 0.62, 0.22);
pool((TRAY.x0 + TRAY.x1) / 2, (TRAY.y0 + TRAY.y1) / 2, 28, 22, 0.3);
castShadow(rectFoot(CARD.x0, CARD.x1, CARD.y0, CARD.y1), 8, 0.7, 0.2);
spill((CARD.x0 + CARD.x1) / 2, (CARD.y0 + CARD.y1) / 2, 40, 32, 0.5);
I.flushFloor();

// ---------------- objects, back to front ----------------
L.folder(FOLD);
box(PH.x0 - 3, PH.x1 + 3, PH.y - 7, PH.y + 3, 0, 3, M.mid);                // the photo's foot
I.hatch(L.fLeft(PH.x0 - 3, PH.y + 3.01, 0), 2, PH.x1 - PH.x0 + 4, 0.8, 2.2, 1.6, 'w', I.RIBR, 0.35);
L.photoStand({ ...PH, mat: M.light, margin: 2.6 });
L.tickBadge(BADGE);
L.packageBox(PKG);
I.laptop({
  ...LP, hatchPad: true,
  screen: L.terminal([
    [0, '>', [4, I.INK1], [3, I.INK2], [2, I.INK2], [9, I.INK1]],
    [2, [16, I.INK3]],
    [2, [12, I.INK3]],
    [0, '>', [5, I.INK1], [8, I.INK2], [8, I.INK2]],
    [2, [10, I.INK3], [7, I.INK2]],
    [2, [13, I.INK3], [5, I.INK2]],
    [2, [9, I.INK3], [8, I.INK2]],
    [0, 'v', [11, I.INK1], [6, I.INK2]],
    [0, '>'],
  ], { cursor: [8, 5] }),
});
L.configCard(CFG);
I.card(CARD);
L.tray(TRAY);

I.writeSVG(args[0] || 'getting-started.svg', args[1] || 'Getting started',
  'A laptop runs the Lumen install and compress commands in a terminal. Around it: the Lumen binary in a package box, a terminal card with the install prompt, a folder of photos, the config file, a tray of compressed photos, and one finished photo with a tick badge.');
