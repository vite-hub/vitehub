import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { registrySourceStyles } from "./registry/source-styles.ts";
import { defineConfig } from "vite-plus";
import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports";

// One build input for each component module. The package exports only the entries below, but separate files let an
// app's bundler drop every component that it does not import, with the code of their dependencies.
const parts = Object.fromEntries(["components", "composables", "headless", "playground", "workspace", "workspace/runners"].flatMap((dir) =>
  readdirSync(new URL(`src/${dir}/`, import.meta.url))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => [`parts/${dir}/${file.slice(0, -3)}`, `src/${dir}/${file}`]),
));

// The Node build of vega-canvas loads the optional `canvas` package with a top-level `await import("canvas")`. This
// package has one dist for the browser and the server, so that await would reach browser bundles too.
// Without `canvas`, both builds return null in Node, so the browser build is bundled for every host.
const vegaCanvasBrowser = fileURLToPath(new URL("vega-canvas.browser.js", import.meta.resolve("vega-canvas")));

// `styles.css` imports the stylesheet of each registry item. npm apps load one file, so the build inlines them.
function inlineRegistryStyles(css: string): string {
  return css.replace(/^@import "\.\/(registry\/[\w-]+\/[\w-]+\.css)";\n/gm, (_, path: string) => readFileSync(new URL(path, import.meta.url), "utf8"));
}

export default defineConfig({
  pack: {
    ...packDefaults,
    alias: { "vega-canvas": vegaCanvasBrowser },
    dts: { vue: true },
    plugins: [
      registrySourceStyles(),
      vue({ isProduction: true }),
      {
        // The stylesheet that a registry item imports is in `styles.css` for npm apps, so the JavaScript imports no CSS.
        name: "vitehub-ui-styles",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "styles.css", source: inlineRegistryStyles(readFileSync(new URL("styles.css", import.meta.url), "utf8")) });
        },
      },
    ],
    copy: [{ from: "theme.css", to: "dist" }, { from: "theme-focus-ring.css", to: "dist" }, { from: "comment-marks.css", to: "dist" }, { from: "comment-send.css", to: "dist" }],
    deps: {
      alwaysBundle: [/@pierre\//, "@vite-hub/icons", "@vite-hub/runtime", "@vite-hub/blob/client", /^comark-(?!chat(?:\/|$))/, "vega-canvas"],
      // Keep vega-loader's Node/browser exports selectable by the consuming host.
      neverBundle: [
        "vega-loader",
        "#app",
        "@comark/vue",
        /^@comark\/vue\//,
        "@nuxt/kit",
        "@nuxt/ui",
        /^@nuxt\/ui\//,
        "ai",
        "nuxt",
        "vue",
        "reka-ui",
        "vite",
        "@vite-hub/web-container",
        /^@vite-hub\/web-container\//,
        /^@codemirror\//,
        "@lezer/highlight",
        /^@xterm\//,
        // MarkdownEditor's Tiptap must be the app's own, the one Nuxt UI's editor menus use.
        /^@tiptap\//,
      ],
      onlyBundle: false,
    },
    entry: {
      ...parts,
      index: "src/index.ts",
      headless: "src/headless.ts",
      // Apps import the theme from nuxt.config, so it must load without the components of the root.
      theme: "src/theme.ts",
      // Share links and zips, with no UI. They run in Node too, so a build or a server can write links.
      playground: "src/playground.ts",
      // Outside the root barrel, so pages that only render Markdown never load Tiptap.
      "markdown-editor": "src/markdown-editor.ts",
      // The motion layer has no Vue, so plain TypeScript surfaces such as the page pill load it alone.
      motion: "src/motion.ts",
      // The same layer, where `installMotion` runs only the effects it is given, so a surface bundles only those.
      "motion/core": "src/motion-core.ts",
      // Outside the root barrel, so chat pages never load CodeMirror or xterm.
      workspace: "src/workspace.ts",
      nuxt: "src/nuxt.ts",
      "runtime/nuxt-plugin": "src/runtime/nuxt-plugin.ts",
      vite: "src/vite.ts",
    },
    exports: {
      customExports(exports) {
        const publicExports = Object.fromEntries(
          Object.entries(exports)
            .filter(([key]) => key !== "./runtime/nuxt-plugin" && !key.startsWith("./parts/"))
            .map(([key, value]) => {
              if (typeof value !== "string" || !value.endsWith(".js")) return [key, value];
              return [key, { types: value.replace(/\.js$/, ".d.ts"), import: value }];
            }),
        );
        const normalized = normalizePackageExports(publicExports);
        for (const key of Object.keys(normalized)) {
          if (key !== "." && key !== "./headless" && key !== "./nuxt" && key !== "./vite") {
            const entry = normalized[key];
            if (entry && typeof entry === "object") delete entry.require;
          }
        }
        return { ...normalized, "./comment-marks.css": "./dist/comment-marks.css", "./styles.css": "./dist/styles.css", "./theme.css": "./dist/theme.css" };
      },
      inlinedDependencies: false,
    },
  },
});
