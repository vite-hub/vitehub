import { resolve } from "node:path"

import { defineConfig } from "vite"

import { overlayAliases, standaloneUI } from "./overlay.aliases.ts"

const root = import.meta.dirname

// The overlay that the page tools loader imports, at `/api/_vitehub/comments/assets/overlay.js`. Nitro serves the
// directory as public assets. `overlay.js` holds Vue, the comment parts of `@vite-hub/ui`, and their styles. The
// Realtime client of presence, with Yjs, is a hashed chunk next to it that only sites with presence load.
export default defineConfig({
  configFile: false,
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [standaloneUI()],
  resolve: { alias: overlayAliases, dedupe: ["vue"] },
  build: {
    // Only this build writes here, so old chunks go.
    emptyOutDir: true,
    minify: true,
    outDir: resolve(root, "dist/overlay"),
    rolldownOptions: {
      input: { overlay: resolve(root, "src/overlay/index.ts") },
      // The loader imports the default export.
      preserveEntrySignatures: "exports-only",
      output: { chunkFileNames: "[name]-[hash].js", entryFileNames: "[name].js" },
    },
    target: "es2022",
  },
})
