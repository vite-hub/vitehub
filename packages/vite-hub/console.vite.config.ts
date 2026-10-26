import ui from "@vite-hub/ui/vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { consoleAppConfig } from "./src/console/app.config";
import { consoleContributedSectionIcons } from "./src/console/contributions";

const clientRoot = resolve(import.meta.dirname, "src/console/runtime/client");
const katexStyleImport = /^@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/m;

export default defineConfig({
  // Resolve lazy chunks from the served bundle URL, including application mounts.
  base: "./",
  resolve: {
    alias: {
      "vite-hub/agent/vue": resolve(import.meta.dirname, "../agent/src/vue.ts"),
      "vite-hub/source/client": resolve(import.meta.dirname, "../source/src/client.ts"),
      "vue-router": resolve(import.meta.dirname, "node_modules/vue-router"),
    },
    dedupe: ["vue", "vue-router"],
  },
  plugins: [
    {
      // KaTeX is loaded after the first render. Keep its embedded fonts out of the blocking stylesheet.
      name: "vitehub-console-deferred-katex-styles",
      enforce: "pre",
      transform(code, id) {
        if (/[\\/]ui[\\/]dist[\\/]styles\.css$/.test(id)) return code.replace(katexStyleImport, "");
        // Browsers that run the Console support WOFF2, so omit the larger WOFF and TrueType copies.
        if (/[\\/]katex[\\/]dist[\\/]katex\.min\.css$/.test(id)) {
          return code.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
        }
      },
    },
    vue(),
    ...ui({
      comark: false,
      nuxtUI: {
        // runtime/client/appearance.ts owns the color scheme. Nuxt UI color mode would also write
        // the root class and read the origin-wide `vueuse-color-scheme` key of the host app.
        colorMode: false,
        dts: false,
        icon: {
          clientBundle: {
            // Contributed sections declare their icons in owner packages, which the scan does not read.
            icons: [...consoleContributedSectionIcons],
            scan: {
              globInclude: ["src/console/**/*.{js,ts,vue}"],
            },
          },
        },
        ui: consoleAppConfig,
      },
    }),
  ],
  build: {
    // Keep font assets portable in pnpm patches and self-contained Console bundles.
    assetsInlineLimit: filePath => /\.(?:woff2?|ttf|otf)$/.test(filePath) ? true : undefined,
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, ".vitehub/console"),
    rolldownOptions: {
      // The `console` page tool is a second entry: a small script that the page tools loader imports on the app's pages.
      input: { main: resolve(clientRoot, "main.js"), "page-tool": resolve(import.meta.dirname, "src/console/page/tool.ts") },
      // Keep the default export of the page tool. An app build drops entry exports by default.
      preserveEntrySignatures: "exports-only",
      output: {
        // The Console page links only the entry stylesheet. Deferred chunks load their own styles.
        assetFileNames: asset => asset.names.includes("main.css")
          ? "console-[hash][extname]"
          : "assets/[name]-[hash][extname]",
        chunkFileNames: "chunks/[name]-[hash].js",
        // VueUse holds the color mode writer that Nuxt UI's search keeps behind `colorMode: false`.
        // A separate chunk keeps it out of the entry, so the entry only carries the Console appearance module.
        codeSplitting: { groups: [{ name: "vueuse", test: /[\\/]@vueuse[\\/]core[\\/]/ }] },
        entryFileNames: chunk => chunk.name === "page-tool" ? "page-tool-[hash].js" : "console-[hash].js",
      },
    },
  },
});
