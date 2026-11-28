import { resolve } from "node:path"

import { browserTarget } from "@vite-hub/internal/package-exports"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"

import { overlayAliases, registrySourceStyles, standaloneStyles, standaloneUI } from "./overlay.aliases.ts"

const root = import.meta.dirname

// The overlay that the page tools loader imports, at `/_vitehub/comments/assets/overlay.js`. Nitro serves the
// directory as public assets. `overlay.js` holds Vue, the comment parts of `@vite-hub/ui`, and their styles. The
// Realtime client of presence, with Yjs, is a hashed chunk next to it that only sites with presence load.
export default defineConfig({
  // Nitro serves the overlay below the app base, such as `/portal/_vitehub/comments/assets/`. A relative base makes
  // Vite resolve the chunks it preloads against `import.meta.url` of the overlay, not against the site root.
  base: "./",
  configFile: false,
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  // Some parts are registry items: Vue SFCs whose CSS imports are in `styles.css`.
  plugins: [standaloneUI(), standaloneStyles(), registrySourceStyles(), vue()],
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
    target: browserTarget,
  },
})
