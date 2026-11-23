// Rects measured in Chromium from Maxi's approved layout prototype (Drop b3ndbfk16b7k v4: `parts/v4.css` and
// `parts/v4-sections.html`), at 1280x760. Each rect is { x, y, w, h } in CSS pixels from the top left of the section.
// The prototype draws its output tabs 38px high; Maxi asked for 32px so they line up with the editor head, so the
// checks use `head` for both rows.

export const viewport = { height: 760, width: 1280 }

export const sizes = {
  /** The top bar. */
  bar: 44,
  /** The editor head row and the output tab bar. */
  head: 32,
  /** The status line under the editor. */
  status: 24,
  /** The files, with their 1px line. */
  files: 200,
  /** The guide column of `guide-side`, with its 1px line. */
  guideColumn: 360,
}

export const sections = {
  /** Section 1, `v-playground-examples-menu`: the code, and the output at the side. */
  side: {
    code: { x: 0, y: 44, w: 640, h: 716 },
    separator: { x: 640, y: 44, w: 1, h: 716 },
    output: { x: 641, y: 44, w: 639, h: 716 },
    editor: { x: 200, y: 44, w: 440, h: 716 },
    status: { x: 200, y: 736, w: 440, h: 24 },
  },
  /** Section 2, `v-learn-guide-over-code`: the guide over the code at `--top: 46%`, the code column at 54%. */
  "guide-top": {
    column: { x: 0, y: 44, w: 691.19, h: 716 },
    guide: { x: 0, y: 44, w: 691.19, h: 329.36 },
    guideSeparator: { x: 0, y: 373.36, w: 691.19, h: 1 },
    code: { x: 0, y: 374.36, w: 691.19, h: 385.64 },
    separator: { x: 691.19, y: 44, w: 1, h: 716 },
    output: { x: 692.19, y: 44, w: 587.81, h: 716 },
    editor: { x: 200, y: 374.36, w: 491.19, h: 385.64 },
    status: { x: 200, y: 736, w: 491.19, h: 24 },
  },
  /** Section 3, `v-learn-guide-column`: a 360px guide column, the output at 40% over the code. */
  "guide-side": {
    guide: { x: 0, y: 44, w: 360, h: 716 },
    output: { x: 360, y: 44, w: 920, h: 286.39 },
    code: { x: 360, y: 330.39, w: 920, h: 429.61 },
    editor: { x: 560, y: 330.39, w: 720, h: 429.61 },
    status: { x: 560, y: 736, w: 720, h: 24 },
  },
}
