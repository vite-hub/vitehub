import ui from "@vite-hub/ui/vite";
import vue from "@vitejs/plugin-vue";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { consoleAppConfig } from "./src/console/app.config";
import { consoleContributedSectionIcons } from "./src/console/contributions";

const clientRoot = resolve(import.meta.dirname, "src/console/runtime/client");
const consoleClientOutDir = resolve(import.meta.dirname, "../console-client/dist/client");

const katexStyleImport = /^@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/m;

export default defineConfig({
  // Resolve lazy chunks from the served bundle URL, including application mounts.
  base: "./",
  resolve: {
    alias: {
      "vite-hub/agent/vue": resolve(import.meta.dirname, "../agent/src/vue.ts"),
      "vite-hub/source/client": resolve(import.meta.dirname, "../source/src/client.ts"),
      "shiki/wasm": resolve(clientRoot, "shiki-wasm.ts"),
      "vue-router": resolve(import.meta.dirname, "node_modules/vue-router"),
    },
    dedupe: ["vue", "vue-router"],
  },
  plugins: [
    {
      // `vite-hub` reads the hashed entry names from `manifest.json` when it serves the Console page. This build writes
      // `script` and `style`; page-tool.vite.config.ts reads the file and adds `pageTool`. Writing them here keeps the
      // file in step with this build when the task cache replays the page tool build.
      name: "vitehub-console-client-manifest",
      writeBundle(_options, bundle) {
        const files = Object.values(bundle)
        const script = files.find(file => file.type === "chunk" && file.isEntry)?.fileName
        const style = files.find(file => file.type === "asset" && file.names.includes("main.css"))?.fileName
        if (!script || !style) throw new TypeError("The Console build wrote no entry script or stylesheet.")
        writeFileSync(resolve(consoleClientOutDir, "../manifest.json"), `${JSON.stringify({ script, style }, null, 2)}\n`)
      },
    },
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
        // Generate the theme classes of the Nuxt UI components that the Console and `@vite-hub/ui` use, not all 125.
        experimental: { componentDetection: true },
        scanPackages: ["@vite-hub/ui"],
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
    // The Console app ships in its own package, @vite-hub/console-client. An app installs it only to serve the Console.
    outDir: consoleClientOutDir,
    rolldownOptions: {
      // The `console` page tool is built after this, by page-tool.vite.config.ts, so it shares no chunks with the app.
      input: { main: resolve(clientRoot, "main.js") },
      output: {
        // The Console page links only the entry stylesheet. Deferred chunks load their own styles.
        assetFileNames: asset => asset.names.includes("main.css")
          ? "console-[hash][extname]"
          : "assets/[name]-[hash][extname]",
        chunkFileNames: "chunks/[name]-[hash].js",
        // VueUse holds the color mode writer that Nuxt UI's search keeps behind `colorMode: false`.
        // A separate chunk keeps it out of the entry, so the entry only carries the Console appearance module.
        codeSplitting: { groups: [{ name: "vueuse", test: /[\\/]@vueuse[\\/]core[\\/]/ }] },
        entryFileNames: "console-[hash].js",
      },
    },
  },
});
