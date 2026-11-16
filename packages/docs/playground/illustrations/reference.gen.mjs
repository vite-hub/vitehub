// Reference: every command, flag, config field and exit code. A card-catalog cabinet with one drawer of index cards
// pulled out, an exit-code tower, a stack of books, a flag, a terminal card and the config sheet.
//   node illustrations/reference.gen.mjs out.svg "Title" --theme light|dark
import * as I from './iso.mjs';
import * as L from './props.mjs';

const args = process.argv.slice(2);
const ti = args.indexOf('--theme');
const theme = ti >= 0 ? args.splice(ti, 2)[1] : 'light';
I.setTheme(theme);
I.init(theme === 'dark' ? 'rfd-' : 'rfl-');
I.floorDefs();
const { rectFoot, castShadow, circle, spill, pool } = I;

// ---------------- layout ----------------
const CAB = { x0: -40, x1: 32, y0: -24, y1: 18, h: 56, cols: 3, rows: 4, open: [1, 1], pull: 18 };   // the cabinet (hero), centre
const TWR = { x: 34, y: -90 };                                             // exit-code tower, back right
const BOOKS = { x: -86, y: 26, s: 1.45 };                                  // the manual, left
const FLAG = { x: 82, y: -24, h: 44 };                                     // flags, right
const CARD = { x0: -50, x1: 6, y0: 64, y1: 100 };                          // commands on a terminal card, front left
const CFG = { x0: 40, x1: 88, y0: 34, y1: 76 };                            // config fields, front right

// ---------------- floor ----------------
I.platform();
castShadow(rectFoot(CAB.x0 - 2, CAB.x1 + 2, CAB.y0 - 2, CAB.y1 + 2), 60 * 0.5, 0.62, 0.26);
castShadow(rectFoot(TWR.x - 15, TWR.x + 15, TWR.y - 15, TWR.y + 15), 88 * 0.35, 0.62, 0.26);
castShadow(rectFoot(BOOKS.x - 25, BOOKS.x + 24, BOOKS.y - 17, BOOKS.y + 17), 19, 0.62, 0.24);
castShadow(circle(FLAG.x, FLAG.y, 6, 8), FLAG.h * 0.5, 0.62, 0.22);
castShadow(rectFoot(FLAG.x, FLAG.x + 26, FLAG.y - 2, FLAG.y), 18, 0.62, 0.16);
castShadow(rectFoot(CARD.x0, CARD.x1, CARD.y0, CARD.y1), 8, 0.7, 0.2);
castShadow(rectFoot(CFG.x0, CFG.x1, CFG.y0, CFG.y1), 5, 0.7, 0.2);
spill((CAB.x0 + CAB.x1) / 2, CAB.y1 + 22, 46, 22, 0.42);                  // light from the open drawer
spill(TWR.x, TWR.y + 30, 26, 14, 0.46);                                   // tower lights
spill((CARD.x0 + CARD.x1) / 2, (CARD.y0 + CARD.y1) / 2, 40, 30, 0.5);
pool(BOOKS.x, BOOKS.y, 34, 24, 0.3);
pool(FLAG.x, FLAG.y, 12, 10, 0.34);
I.flushFloor();

// ---------------- objects, back to front ----------------
I.tower(TWR);
L.exitPanel(TWR);
I.books(BOOKS);
L.cabinet(CAB);
I.card(CARD);
L.flag(FLAG);
L.configCard(CFG);

I.writeSVG(args[0] || 'reference.svg', args[1] || 'Reference',
  'A card-catalog cabinet with one drawer pulled out to show its index cards, for the flags. Around it: a status tower whose display shows exit code 0, a stack of manuals, a flag, a terminal card with a prompt for the commands, and the config sheet.');
