// Lumen hero: a folder of large photos rides a belt through the Lumen press and comes out as small images in a tray.
//   node illustrations/hero.gen.mjs out.svg "Title" --theme light|dark
import * as I from './iso.mjs';
import * as L from './props.mjs';

const args = process.argv.slice(2);
const ti = args.indexOf('--theme');
const theme = ti >= 0 ? args.splice(ti, 2)[1] : 'light';
I.setTheme(theme);
I.init(theme === 'dark' ? 'lhd-' : 'lhl-');
I.floorDefs();
const { M, box, circle, rectFoot, castShadow, spill, pool } = I;

// ---------------- layout (plan units; the platform spans -122..122) ----------------
const BELT = { x0: -6, x1: 22, z: 13, legs: [-82, -52, 34, 74] };          // belt along y, back right to front left
const MACH = { x0: -22, x1: 34, y0: -24, y1: 20, h: 44, bx0: -6, bx1: 22, bz: 13 };   // the hero, at the centre
const FOLD = { x0: -10, x1: 28, y0: -116, y1: -98, h: 30,                  // input folder of large photos, back right
  photos: [{ dx0: 3, dx1: 33, h: 44 }, { dx0: 6, dx1: 36, h: 38 }, { dx0: 1, dx1: 29, h: 34 }] };
const BIG = { x0: -10, x1: 26, y0: -72, y1: -44, z: BELT.z };              // a large photo on its way in
const OUT1 = { x0: 1, x1: 15, y0: 30, y1: 42, z: BELT.z, tick: true };     // small photos on their way out
const OUT2 = { x0: 2, x1: 14, y0: 52, y1: 62, z: BELT.z, tick: true };
const TRAY = { x0: -6, x1: 22, y0: 90, y1: 110, n: 3 };                    // tray of small photos, front left
const LP = { x0: -108, x1: -58, y0: 16, y1: 56, L: 36 };                   // laptop running lumen, left
const TWR = { x: -96, y: -74 };                                           // CI status tower, back left edge
const CFG = { x0: 42, x1: 86, y0: 62, y1: 100 };                          // lumen.config.ts, front right
const GAU = { x0: 72, x1: 108, y0: 16, y1: 22, h: 36 };                    // size gauge, right
const CLOUD = { x: 64, y: -46, d: 9, s: 1.1 };                             // CDN badge, right corner

const plugY = 46;
const cable = [[LP.x1 + 6.5, plugY, 1.6], [LP.x1 + 10, plugY, 1.1], [-38, 44, 1.1], [-24, 36, 1.1], [-15, 29, 1.1],
  [-14, 25.5, 2.6], [-14, 23.6, 5.6], [-14, 22.4, 8.2]];

// ---------------- floor ----------------
I.platform();
castShadow(rectFoot(MACH.x0 - 3, MACH.x1 + 3, MACH.y0 - 3, MACH.y1 + 3), 60 * 0.45, 0.62, 0.26);
castShadow(rectFoot(BELT.x0, BELT.x1, -90, 86), 13, 0.62, 0.2);
castShadow(rectFoot(FOLD.x0, FOLD.x1, FOLD.y0, FOLD.y1), 40 * 0.5, 0.62, 0.24);
castShadow(rectFoot(TWR.x - 15, TWR.x + 15, TWR.y - 15, TWR.y + 15), 88 * 0.35, 0.62, 0.26);
castShadow(rectFoot(LP.x0, LP.x1, LP.y0 - 8, LP.y1), 24, 0.62, 0.22);
castShadow(rectFoot(GAU.x0, GAU.x1, GAU.y0 - 4, GAU.y1 + 4), GAU.h * 0.6, 0.62, 0.24);
castShadow(rectFoot(CLOUD.x + 2, CLOUD.x + 36 * CLOUD.s, CLOUD.y - CLOUD.d, CLOUD.y), 24 * CLOUD.s, 0.62, 0.24);
castShadow(rectFoot(TRAY.x0, TRAY.x1, TRAY.y0, TRAY.y1), 8, 0.62, 0.22);
castShadow(rectFoot(CFG.x0, CFG.x1, CFG.y0, CFG.y1), 5, 0.7, 0.2);
spill((LP.x0 + LP.x1) / 2, LP.y1 + 6, 40, 24, 0.5);                       // laptop screen spill
spill(MACH.x1 + 18, (MACH.y0 + MACH.y1) / 2, 18, 30, 0.5);                // >_ panel spill
spill(TWR.x, TWR.y + 30, 26, 14, 0.46);                                   // tower lights
pool(CLOUD.x + 18 * CLOUD.s, CLOUD.y - CLOUD.d / 2, 28, 11, 0.32);
pool((GAU.x0 + GAU.x1) / 2, (GAU.y0 + GAU.y1) / 2, 24, 10, 0.32);
pool((TRAY.x0 + TRAY.x1) / 2, (TRAY.y0 + TRAY.y1) / 2, 22, 16, 0.3);
pool((FOLD.x0 + FOLD.x1) / 2, (FOLD.y0 + FOLD.y1) / 2, 26, 14, 0.3);
I.cableShadow(cable);
I.flushFloor();

// ---------------- objects, back to front ----------------
I.tower(TWR);
L.folder(FOLD);
L.belt(BELT, -92, MACH.y0);
L.photoFlat({ ...BIG, crop: false });
box(LP.x1, LP.x1 + 6, plugY - 1.8, plugY + 1.8, 0.5, 2.9, M.pale, { sw: 0.6 });   // laptop plug
I.laptop({
  ...LP, hatchPad: true,
  screen: L.terminal([
    [0, '>', [6, I.INK1], [9, I.INK2], [5, I.INK3]],
    [2, [4, I.INK3], [14, I.INK2]],
    [2, [4, I.INK3], [11, I.INK2]],
    [2, [4, I.INK3], [16, I.INK2]],
    [0, [8, I.INK1], [4, I.INK2]],
    [0, '>', [3, I.INK2]],
  ], { cursor: [5, 9.5] }),
});
I.cloudBadge(CLOUD);
L.machine(MACH);
box(-17, -11, MACH.y1, MACH.y1 + 2.6, 6.4, 11.4, M.pale, { sw: 0.7 });          // port on the machine
I.cable(cable);
L.belt(BELT, MACH.y1 + 3, 86);
L.photoFlat(OUT1);
L.photoFlat(OUT2);
L.gauge(GAU);
L.tray(TRAY);
L.configCard(CFG);

I.writeSVG(args[0] || 'hero.svg', args[1] || 'Lumen',
  'A folder of large photos rides a conveyor belt into the Lumen machine, a press with a terminal prompt on its side, and comes out as small images in a tray. Around it: a laptop running lumen in a terminal, the config file, a CI status tower, a size gauge with falling bars, and a CDN cloud.');
