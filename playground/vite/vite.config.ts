import { resolve } from "node:path"

import { defineConfig } from "vite"

import { hubQueue } from "@vitehub/queue/vite"

export default defineConfig({
  appType: "custom",
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/worker.ts"),
    },
  },
  plugins: [hubQueue()],
  queue: {},
})
