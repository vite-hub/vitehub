import { resolve } from "node:path"

import { hubKv } from "@vite-hub/kv/vite"
import { defineConfig } from "vite"

export default defineConfig({
  root: import.meta.dirname,
  appType: "custom",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
      output: { entryFileNames: "server.js" },
    },
    ssr: true,
  },
  plugins: [
    hubKv({ driver: "fs-lite", base: ".data/kv" }),
  ],
})
