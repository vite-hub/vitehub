// One icon per file type, as in the Seti theme of VS Code: a short glyph in the color of the type, and the Vue logo.
// The file tree draws them from a sprite sheet in its shadow DOM, and the editor head draws the same shapes inline.
import { h, type VNode } from "vue";

/**
 * The colors of the file types: the brand colors of the languages, as in the Seti theme of VS Code, for light and dark
 * pages. They are data, like brand logos, so they live here and not in the theme. A `--vh-ws-file-<type>` token on the
 * page replaces one.
 */
const colors = {
  astro: ["#7c3aed", "#a78bfa"],
  js: ["#a16207", "#eab308"],
  json: ["#a16207", "#eab308"],
  md: ["#0284c7", "#38bdf8"],
  svelte: ["#ea580c", "#fb923c"],
  ts: ["#3178c6", "#60a5fa"],
  tsx: ["#0891b2", "#22d3ee"],
  vue: ["#41b883", "#41b883"],
  "vue-dark": ["#35495e", "#a3b8cc"],
} satisfies Record<string, readonly [light: string, dark: string]>;

function color(type: keyof typeof colors): string {
  const [light, dark] = colors[type];
  return `var(--vh-ws-file-${type}, light-dark(${light}, ${dark}))`;
}

/** The glyph and its color, by file extension. */
const glyphs: Record<string, readonly [glyph: string, color: keyof typeof colors]> = {
  astro: ["A", "astro"],
  cjs: ["JS", "js"],
  js: ["JS", "js"],
  json: ["{}", "json"],
  jsonc: ["{}", "json"],
  jsonl: ["{}", "json"],
  jsx: ["JS", "js"],
  md: ["M", "md"],
  mdx: ["M", "md"],
  mjs: ["JS", "js"],
  mts: ["TS", "ts"],
  svelte: ["S", "svelte"],
  ts: ["TS", "ts"],
  tsx: ["TS", "tsx"],
};

const vueLogo = `<svg x="1" y="1" width="14" height="14" viewBox="0 0 24 24"><path d="M2 4h4.2L12 14l5.8-10H22L12 21z" style="fill: ${color("vue")}"/><path d="M6.2 4h3.4L12 8.2 14.4 4h3.4L12 14z" style="fill: ${color("vue-dark")}"/></svg>`;

function glyph(text: string, color: string): string {
  return `<text x="8" y="8.5" dominant-baseline="central" text-anchor="middle" style="fill: ${color}; font: 600 9px/1 var(--vh-ws-font-mono); letter-spacing: -0.03em">${text}</text>`;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The inner SVG of the icon of `path`, in a 16x16 box. */
function iconBody(path: string): string {
  const type = extension(path);
  if (type === "vue") return vueLogo;
  const entry = glyphs[type];
  return entry ? glyph(entry[0], color(entry[1])) : glyph("·", "var(--vh-muted)");
}

const symbolIds = { other: "vh-ws-file-other", vue: "vh-ws-file-vue", ...Object.fromEntries(Object.keys(glyphs).map(type => [type, `vh-ws-file-${type}`])) };

/** The symbols that `fileTreeIcons` names, for the `spriteSheet` of a Pierre tree. */
const spriteSheet = `<svg xmlns="http://www.w3.org/2000/svg" style="display: none">${
  Object.entries(symbolIds).map(([type, id]) => `<symbol id="${id}" viewBox="0 0 16 16">${iconBody(type === "other" ? "" : `file.${type}`)}</symbol>`).join("")
}</svg>`;

/** The `icons` option of a Pierre tree that draws these icons. A file of another type gets a muted dot. */
export const fileTreeIcons = {
  byFileExtension: Object.fromEntries(Object.keys(glyphs).concat("vue").map(type => [type, symbolIds[type as keyof typeof symbolIds]])),
  remap: { "file-tree-icon-file": symbolIds.other },
  set: "minimal",
  spriteSheet,
} as const;

/** The icon of `path` as an inline SVG, the same one that `WorkspaceFileTree` draws. */
export function fileIcon(path: string, className = "vh-ws-file-icon"): VNode {
  return h("svg", { "aria-hidden": "true", class: className, "data-file-type": extension(path) || undefined, innerHTML: iconBody(path), viewBox: "0 0 16 16", xmlns: "http://www.w3.org/2000/svg" });
}
