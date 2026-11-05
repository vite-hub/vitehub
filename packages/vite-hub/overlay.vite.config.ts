import { resolve } from "node:path";
import { defineConfig } from "vite";

import { standaloneUI } from "../ui/src/standalone/vite.ts";

const root = import.meta.dirname;
const source = resolve(root, "src/comments-overlay");
const ui = resolve(root, "../ui");

export default defineConfig({
  base: "./",
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  // The overlay has no Nuxt UI. `standaloneUI()` of `@vite-hub/ui` gives the parts their stand-ins, a Markdown without a
  // parser, and the icons they use. The comments overlay of `@vite-hub/comments` builds with the same plugin.
  plugins: [standaloneUI()],
  resolve: {
    alias: [
      { find: "@vite-hub/ui/styles.css", replacement: resolve(ui, "styles.css") },
      { find: /^@vite-hub\/ui\/comments$/, replacement: resolve(ui, "src/comments.ts") },
      { find: /^@vite-hub\/ui\/standalone\/(.+)$/, replacement: `${resolve(ui, "src/standalone")}/$1` },
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
