// Guides: resize, compress, convert. A vise squeezes a photo; a cropped photo with a ruler; WEBP and AVIF plates;
// a stack of converted files; a quality slider.
//   node illustrations/guides.gen.mjs out.svg "Title" --theme light|dark
import * as I from './iso.mjs';
import * as L from './props.mjs';

const args = process.argv.slice(2);
const ti = args.indexOf('--theme');
const theme = ti >= 0 ? args.splice(ti, 2)[1] : 'light';
I.setTheme(theme);
I.init(theme === 'dark' ? 'gdd-' : 'gdl-');
I.floorDefs();
const { rectFoot, castShadow, spill, pool } = I;

// ---------------- layout ----------------
const VISE = { x0: -58, x1: 40, y0: -22, y1: 22, mj: 12, jz: 46, jw: 18, sz: 22, sr: 4.2, sl: 12, over: 12 };   // the vise (hero), centre
const WEBP = { x0: -84, x1: -30, y: -98, d: 5, h: 32, label: 'WEBP', size: 12 };     // format plates, back and right
const AVIF = { x0: 28, x1: 82, y: -70, d: 5, h: 32, label: 'AVIF', size: 12 };
const CROP = { x0: -116, x1: -80, y0: 6, y1: 42, z: 0, th: 2.4 };          // a photo with crop marks, left
const RULER = { x0: -116, x1: -80, y0: 48, y1: 55 };                     // and a ruler along its front edge
const FILES = { x0: 52, x1: 100, y0: 30, y1: 76, n: 4 };                   // converted files, front right
const SLIDE = { x0: -32, x1: 24, y0: 66, y1: 98, t: 0.75 };                // the quality slider, front

// ---------------- floor ----------------
I.platform();
castShadow(rectFoot(VISE.x0, VISE.x1 + 18, VISE.y0, VISE.y1), 58 * 0.5, 0.62, 0.26);
castShadow(rectFoot(WEBP.x0 - 2, WEBP.x1 + 2, WEBP.y - 8, WEBP.y + 3), 35 * 0.6, 0.62, 0.24);
castShadow(rectFoot(AVIF.x0 - 2, AVIF.x1 + 2, AVIF.y - 8, AVIF.y + 3), 35 * 0.6, 0.62, 0.24);
castShadow(rectFoot(CROP.x0, CROP.x1, CROP.y0, CROP.y1), 4, 0.7, 0.2);
castShadow(rectFoot(RULER.x0, RULER.x1, RULER.y0, RULER.y1), 3, 0.7, 0.2);
castShadow(rectFoot(FILES.x0, FILES.x1, FILES.y0, FILES.y1), 10, 0.62, 0.22);
castShadow(rectFoot(SLIDE.x0, SLIDE.x1, SLIDE.y0, SLIDE.y1), 7, 0.7, 0.2);
spill(-12, VISE.y1 + 16, 44, 22, 0.5);                                     // in front of the squeezed photo
spill((WEBP.x0 + WEBP.x1) / 2, WEBP.y + 12, 34, 12, 0.46);                // in front of the plates
spill((AVIF.x0 + AVIF.x1) / 2, AVIF.y + 12, 34, 12, 0.46);
pool((FILES.x0 + FILES.x1) / 2, (FILES.y0 + FILES.y1) / 2, 30, 26, 0.3);
pool((SLIDE.x0 + SLIDE.x1) / 2, (SLIDE.y0 + SLIDE.y1) / 2, 30, 18, 0.28);
I.flushFloor();

// ---------------- objects, back to front ----------------
L.formatPlate(WEBP);
L.photoFlat({ ...CROP, crop: true, margin: 2.4 });
L.ruler(RULER);
L.vise(VISE);
L.formatPlate(AVIF);
L.fileStack(FILES);
L.slider(SLIDE);

I.writeSVG(args[0] || 'guides.svg', args[1] || 'Guides',
  'A bench vise squeezes a photo between its jaws. Around it: a photo with crop marks and a ruler, two format plates labelled WEBP and AVIF, a stack of converted image files, and a quality slider.');
