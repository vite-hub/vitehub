import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;
const source = resolve(root, "src/comments-overlay");
const ui = resolve(root, "../ui");
const virtualIcons = "virtual:comments-overlay-icons";
const katexStyleImport = /^@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/m;

// The Phosphor icons that the comment parts and the Prompt Input ask for by class name.
const icons = [
  "arrow-clockwise",
  "arrow-counter-clockwise",
  "arrow-up",
  "chat-circle",
  "check",
  "file-light",
  "list-bullets",
  "note-pencil",
  "pencil-simple-light",
  "plus",
  "stop-fill",
  "trash-light",
  "x-light",
];

// The icons are drawn from elements, never from markup, so a flat list of shapes is all that they need.
function shapes(name: string, body: string): Array<[string, Record<string, string>]> {
  const found: Array<[string, Record<string, string>]> = [];
  for (const [, tag, attributes] of body.matchAll(/<(\w+)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)) {
    if (tag === "g" || tag === "svg") throw new TypeError(`The Phosphor icon "${name}" nests elements, which the overlay does not draw.`);
    found.push([tag!, Object.fromEntries([...attributes!.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]))]);
  }
  if (!found.length || body.replaceAll(/<\w+(?:\s+[\w:-]+="[^"]*")*\s*\/?>/g, "").trim()) throw new TypeError(`The Phosphor icon "${name}" has a body that the overlay cannot draw: ${body}`);
  return found;
}

export function overlayPlugin(): Plugin {
  return {
    name: "vitehub-comments-overlay",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === virtualIcons) return `\0${virtualIcons}`;
      // The full Markdown part brings the Comark parser, Shiki, and KaTeX. Comments are short notes.
      if (importer && importer.startsWith(resolve(ui, "src")) && /(^|\/)markdown\.ts$/.test(id)) return resolve(source, "markdown-lite.ts");
      return undefined;
    },
    load(id) {
      if (id !== `\0${virtualIcons}`) return undefined;
      const require = createRequire(import.meta.url);
      const set = JSON.parse(readFileSync(require.resolve("@iconify-json/ph/icons.json"), "utf8")) as { icons: Record<string, { body: string }> };
      const bodies = Object.fromEntries(icons.map((name) => {
        const icon = set.icons[name];
        if (!icon) throw new TypeError(`The Phosphor icon "${name}" does not exist.`);
        return [`i-ph-${name}`, shapes(name, icon.body)];
      }));
      return `export const icons = ${JSON.stringify(bodies)};`;
    },
    transform(code, id) {
      // The stylesheet of the UI imports KaTeX for formulas, which comments do not render.
      if (/[\\/]ui[\\/]styles\.css$/.test(id)) return code.replace(katexStyleImport, "");
      return undefined;
    },
  };
}

export default defineConfig({
  base: "./",
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [overlayPlugin()],
  resolve: {
    alias: [
      { find: "@vite-hub/ui/styles.css", replacement: resolve(ui, "styles.css") },
      { find: /^@vite-hub\/ui\/comments$/, replacement: resolve(ui, "src/comments.ts") },
    ],
    dedupe: ["vue"],
  },
  build: {
    cssCodeSplit: false,
    emptyOutDir: true,
    minify: true,
    outDir: resolve(root, ".vitehub/comments-overlay"),
    rolldownOptions: {
      // The loader imports `mount` from overlay.js at run time, so the entry keeps its exports.
      preserveEntrySignatures: "strict",
      input: { loader: resolve(source, "loader.ts"), overlay: resolve(source, "overlay.ts") },
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
        // The hash is in the file names, so a page names the exact bundle it loads.
        entryFileNames: "[name].[hash].js",
      },
    },
    target: "es2022",
  },
});
