import ui from "@vite-hub/ui/vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { consoleAppConfig } from "./src/console/app.config";
import { consoleContributedSectionIcons } from "./src/console/contributions";

const clientRoot = resolve(import.meta.dirname, "src/console/runtime/client");
const katexStyleImport = /^@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/m;

export default defineConfig({
  base: "/_vitehub/assets/",
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
      // The Console loads KaTeX styles after the first render, so keep their embedded fonts out of the blocking stylesheet.
      name: "vitehub-console-deferred-katex-styles",
      enforce: "pre",
      transform(code, id) {
        if (/[\\/]ui[\\/]dist[\\/]styles\.css$/.test(id)) return code.replace(katexStyleImport, "");
        // Every browser that runs the Console module supports WOFF2, so drop the larger WOFF and TrueType copies.
        if (/[\\/]katex[\\/]dist[\\/]katex\.min\.css$/.test(id)) {
          return code.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
        }
      },
    },
    vue(),
    ...ui({
      comark: false,
      nuxtUI: {
        dts: false,
        icon: {
          clientBundle: {
            // Agent tool icons load from the full Lucide set on demand. See client/icons.ts.
            icons: consoleContributedSectionIcons,
            sizeLimitKb: 1024,
            scan: {
              globInclude: ["src/console/**/*.{js,ts,vue}", "../ui/src/**/*.ts"],
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
      input: resolve(clientRoot, "main.js"),
      output: {
        // The Console page links only the entry stylesheet. Deferred chunks load their own styles.
        assetFileNames: asset => asset.names.includes("main.css")
          ? "console-[hash][extname]"
          : "assets/[name]-[hash][extname]",
        chunkFileNames: "chunks/[name]-[hash].js",
        entryFileNames: "console-[hash].js",
      },
    },
  },
});
