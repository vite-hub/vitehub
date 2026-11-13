import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports";

// One build input for each component module. The package exports only the entries below, but separate files let an
// app's bundler drop every component that it does not import, with the code of their dependencies.
const parts = Object.fromEntries(["components", "composables", "headless", "playground", "workspace"].flatMap((dir) =>
  readdirSync(new URL(`src/${dir}/`, import.meta.url))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => [`parts/${dir}/${file.slice(0, -3)}`, `src/${dir}/${file}`]),
));

// The Node build of vega-canvas loads the optional `canvas` package with a top-level await, which Nitro's es2019 target rejects.
// Without `canvas`, both builds return null in Node, so the browser build is bundled for every host.
const vegaCanvasBrowser = fileURLToPath(new URL("vega-canvas.browser.js", import.meta.resolve("vega-canvas")));

export default defineConfig({
  pack: {
    ...packDefaults,
    alias: { "vega-canvas": vegaCanvasBrowser },
    copy: [{ from: "styles.css", to: "dist" }, { from: "theme.css", to: "dist" }, { from: "theme-focus-ring.css", to: "dist" }],
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
        return { ...normalized, "./styles.css": "./dist/styles.css", "./theme.css": "./dist/theme.css" };
      },
      inlinedDependencies: false,
    },
  },
});
