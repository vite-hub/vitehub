// Edit this site: the docs site edited in the ViteHub Console. A monitor with the Content editor and comment pins,
// two databases (users and content), a crate of media, a speech bubble, a page, and a plug and socket for MCP.
//   node illustrations/edit-this-site.gen.mjs out.svg "Title" --theme light|dark
import * as I from './iso.mjs';
import * as L from './props.mjs';

const args = process.argv.slice(2);
const ti = args.indexOf('--theme');
const theme = ti >= 0 ? args.splice(ti, 2)[1] : 'light';
I.setTheme(theme);
I.init(theme === 'dark' ? 'esd-' : 'esl-');
I.floorDefs();
const { M, box, rectFoot, circle, castShadow, spill, pool } = I;

// ---------------- layout ----------------
const MON = { x0: -52, x1: 50, y: -18, z0: 12, z1: 76, pins: [[54, 36, 13], [28, 18, 12]] };   // the Console (hero), centre
const DBU = { x: -100, y: -28, r: 17 };                                    // users database, back left
const DBC = { x: -84, y: 14, r: 17 };                                      // content database, left (in front of it)
const CRATE = { x0: 14, x1: 70, y0: -114, y1: -76, h: 34,                  // media in object storage, back right
  items: [{ x0: 18, x1: 42, y: -100, h: 40 }, { x0: 36, x1: 62, y: -93, h: 35, play: true }, { x0: 20, x1: 46, y: -86, h: 30 }] };
const SPEECH = { x: 72, y: -30, w: 36, h: 26, d: 6 };                      // a comment, right
const SOCK = { x0: -100, x1: -72, y0: 52, y1: 66, h: 18, gap: 14, pl: 14 };  // MCP socket and plug, front left
const PAGE = { x0: 18, x1: 76, y0: 50, y1: 102 };                          // a page with a comment pin, front

// cable from the plug round to the monitor's base
const plugEnd = { x: (SOCK.x0 + SOCK.x1) / 2, y: SOCK.y1 + SOCK.gap + SOCK.pl + 4 };
const cable = [[plugEnd.x, plugEnd.y - 1, 7.5], [plugEnd.x, plugEnd.y + 2, 3.5], [plugEnd.x + 3, plugEnd.y + 6, 1.1], [-62, 104, 1.1], [-36, 88, 1.1],
  [-20, 56, 1.1], [-8, 22, 1.1], [-2, 4, 1.1], [-1, -4, 1.4], [-1, -6.4, 2.6]];

// ---------------- floor ----------------
I.platform();
castShadow(rectFoot(MON.x0, MON.x1, MON.y - 26, MON.y), MON.z1 * 0.4, 0.62, 0.26);
castShadow(circle(DBU.x, DBU.y, DBU.r, 8), 42 * 0.5, 0.62, 0.24);
castShadow(circle(DBC.x, DBC.y, DBC.r, 8), 42 * 0.5, 0.62, 0.24);
castShadow(rectFoot(CRATE.x0, CRATE.x1, CRATE.y0, CRATE.y1), CRATE.h * 0.7, 0.62, 0.24);
castShadow(rectFoot(SPEECH.x, SPEECH.x + SPEECH.w, SPEECH.y - SPEECH.d, SPEECH.y), 26 * 0.7, 0.62, 0.22);
castShadow(rectFoot(SOCK.x0, SOCK.x1, SOCK.y0, plugEnd.y), SOCK.h * 0.8, 0.62, 0.22);
castShadow(rectFoot(PAGE.x0, PAGE.x1, PAGE.y0, PAGE.y1), 5, 0.7, 0.2);
spill(0, MON.y + 24, 56, 30, 0.52);                                       // screen spill
pool(SPEECH.x + SPEECH.w / 2, SPEECH.y - 2, 22, 9, 0.3);
pool((SOCK.x0 + SOCK.x1) / 2, (SOCK.y0 + plugEnd.y) / 2, 20, 22, 0.3);
pool((CRATE.x0 + CRATE.x1) / 2, (CRATE.y0 + CRATE.y1) / 2, 32, 22, 0.28);
I.cableShadow(cable);
I.flushFloor();

// ---------------- objects, back to front ----------------
I.database(DBU); L.dbGlyph(DBU, 'user');
L.crate(CRATE);
I.database(DBC); L.dbGlyph(DBC, 'page');
L.monitor(MON);
L.socketPlug(SOCK);
I.cable(cable);
box(-5, 3, -14, -6.6, 1.6, 4.4, M.pale, { sw: 0.6 });                      // port on the monitor base
L.speech(SPEECH);
L.pageCard(PAGE);

I.writeSVG(args[0] || 'edit-this-site.svg', args[1] || 'Edit this site',
  'A monitor shows the ViteHub Console editing a docs page, with comment pins on the text. Around it: two databases for users and content, an open crate of media files, a standing comment bubble, a page with a comment pin, and a plug and socket for the MCP connection, cabled to the monitor.');
