import { resolve } from "node:path"

import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

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
  plugins: [vitehub({
    preset: "node",
    blob: false,
    database: false,
    devtools: false,
    env: false,
    workflow: false,
    workspace: false,
  })],
  ssr: {
    external: ["vite-hub/agent"],
  },
})
