import { resolve } from "node:path"

import { browserTarget } from "@vite-hub/internal/package-exports"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"

import { overlayAliases, registrySourceStyles, standaloneStyles, standaloneUI } from "./overlay.aliases.ts"

const root = import.meta.dirname

export const hostedEntry = "hosted-comments.js"
export const hostedFrame = "hosted-comments/frame.js"

export default defineConfig({
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
    emptyOutDir: true,
    minify: true,
    outDir: resolve(root, "dist/hosted"),
    rolldownOptions: {
      input: { host: resolve(root, "src/embed/host.ts"), frame: resolve(root, "src/embed/frame.ts") },
      output: {
        chunkFileNames: "hosted-comments/[name]-[hash].js",
        entryFileNames: chunk => chunk.name === "host" ? hostedEntry : hostedFrame,
      },
    },
    target: browserTarget,
  },
})
